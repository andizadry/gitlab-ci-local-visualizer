#!/usr/bin/env python3
"""
GitLab CI Local Preview & Pipeline Inspector (100% Offline)
Resolves all local include files, maps jobs, stages, variables, rules, tags, line numbers,
deep dependency graphs, and extends/includes linkages.
"""

import argparse
import copy
import json
import os
import re
import sys
from pathlib import Path

# PyYAML: pakai yang terpasang di sistem (lebih cepat, ada ekstensi C) bila ada; kalau tidak,
# pakai salinan pure-Python yang dibundel di vendor/pyyaml (PyYAML 6.0.2, MIT).
# GITLAB_CI_LOCAL_BUNDLED_YAML=1 memaksa salinan bundel (dipakai test).
_BUNDLED_YAML_DIR = Path(__file__).resolve().parent / "vendor" / "pyyaml"


def _use_bundled_yaml():
    if str(_BUNDLED_YAML_DIR) not in sys.path:
        sys.path.insert(0, str(_BUNDLED_YAML_DIR))


if os.environ.get("GITLAB_CI_LOCAL_BUNDLED_YAML") == "1":
    _use_bundled_yaml()
try:
    import yaml
except ImportError:
    _use_bundled_yaml()
    try:
        import yaml
    except ImportError:  # pragma: no cover - bundel hilang & sistem tanpa PyYAML
        sys.stderr.write(
            "PyYAML is not available for this Python interpreter (%s).\n"
            "PyYAML tidak tersedia untuk interpreter Python ini.\n"
            "Install / pasang dengan salah satu:\n"
            "  pip install pyyaml\n"
            "  sudo apt install python3-yaml   (Debian/Ubuntu/WSL)\n" % sys.executable
        )
        sys.exit(3)

from rules_evaluator import SimulationRunner
from ci_i18n import translate_payload, normalize_lang
from ci_inputs import (
    split_spec, resolve_inputs, interpolate, has_interpolation, declared_inputs, expand_variables,
)
from ci_keywords import (
    RESERVED_TOP_LEVEL, DEFAULT_KEYWORDS, validate_top_level, validate_job,
)

# Batas kedalaman child pipeline GitLab: parent -> child -> grandchild (dua level child).
MAX_CHILD_LEVELS = 2
# Pengaman umum untuk rantai downstream (termasuk multi-project) agar tidak tak terhingga.
MAX_PIPELINE_DEPTH = 6

class _GitlabYamlLoader(yaml.SafeLoader):
    """SafeLoader yang toleran terhadap tag kustom GitLab CI seperti !reference.
    !reference [job, key] dipertahankan sebagai penanda dict agar tidak menggagalkan parse."""
    pass

def _construct_reference(loader, node):
    try:
        seq = loader.construct_sequence(node, deep=True)
    except Exception:
        seq = []
    return {'__gitlab_reference__': seq}

def _construct_unknown(loader, tag_suffix, node):
    # Tag kustom lain: kembalikan nilai dasarnya bila memungkinkan, else None.
    try:
        if isinstance(node, yaml.MappingNode):
            return loader.construct_mapping(node, deep=True)
        if isinstance(node, yaml.SequenceNode):
            return loader.construct_sequence(node, deep=True)
        return loader.construct_scalar(node)
    except Exception:
        return None

_GitlabYamlLoader.add_constructor('!reference', _construct_reference)
_GitlabYamlLoader.add_multi_constructor('!', _construct_unknown)


# ---------------------------------------------------------------------------
# Helper murni (tanpa I/O) untuk konfigurasi
# ---------------------------------------------------------------------------
def _is_ref(obj):
    return isinstance(obj, dict) and set(obj.keys()) == {"__gitlab_reference__"}


def _deep_merge(base, override):
    """Merge hash secara rekursif (override menang); array/skalar diganti utuh, seperti `extends`."""
    result = copy.deepcopy(base) if isinstance(base, dict) else {}
    for key, val in (override or {}).items():
        if isinstance(val, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], val)
        else:
            result[key] = copy.deepcopy(val)
    return result


def _norm_vars(raw):
    """Normalisasi `variables`: nilai hash {value:..} dipipihkan, skalar dijadikan string."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for key, val in raw.items():
        if isinstance(val, dict):
            val = val.get("value", "")
        if val is None:
            val = ""
        elif isinstance(val, bool):
            val = "true" if val else "false"
        out[str(key)] = val if isinstance(val, str) else str(val)
    return out


def normalize_needs(raw):
    """Normalisasi `needs` menjadi list dict (entri pipeline/project dipertahankan apa adanya)."""
    out = []
    if isinstance(raw, dict):
        raw = [raw]
    elif isinstance(raw, str):
        raw = [raw]
    if isinstance(raw, list):
        for n in raw:
            if isinstance(n, str):
                out.append({"job": n})
            elif isinstance(n, dict):
                out.append(n)
    return out


def normalize_include_list(raw):
    """Normalisasi nilai `include:` (string/dict/list) menjadi list dict."""
    if isinstance(raw, (str, dict)):
        raw = [raw]
    elif not isinstance(raw, list):
        raw = []
    out = []
    for inc in raw:
        if isinstance(inc, str):
            if re.match(r"^https?://", inc):
                out.append({"remote": inc})
            else:
                out.append({"local": inc})
        elif isinstance(inc, dict):
            if "file" in inc and isinstance(inc["file"], list):
                for sub in inc["file"]:
                    item = dict(inc)
                    item["file"] = sub
                    out.append(item)
            else:
                out.append(inc)
    return out


def normalize_trigger(trig):
    """Normalisasi `trigger:` menjadi struktur seragam.

    Hasil: kind ('child' | 'project' | 'invalid'), project, branch, strategy,
    forward{yaml_variables,pipeline_variables}, includes, inputs, problems.
    """
    out = {
        "kind": "invalid", "project": None, "branch": None, "strategy": None,
        "forward": {"yaml_variables": True, "pipeline_variables": False},
        "includes": [], "inputs": {}, "problems": [],
    }
    if isinstance(trig, str):
        out["kind"] = "project"
        out["project"] = trig
        return out
    if not isinstance(trig, dict):
        out["problems"].append("trigger harus berupa string (project) atau mapping.")
        return out
    strategy = trig.get("strategy")
    if strategy is not None:
        if strategy in ("depend", "mirror"):
            out["strategy"] = strategy
        else:
            out["problems"].append("trigger:strategy '%s' tidak valid (depend/mirror)." % strategy)
    fwd = trig.get("forward")
    if isinstance(fwd, dict):
        if "yaml_variables" in fwd:
            out["forward"]["yaml_variables"] = bool(fwd["yaml_variables"])
        if "pipeline_variables" in fwd:
            out["forward"]["pipeline_variables"] = bool(fwd["pipeline_variables"])
    if isinstance(trig.get("inputs"), dict):
        out["inputs"] = dict(trig["inputs"])
    if "include" in trig:
        out["kind"] = "child"
        out["includes"] = normalize_include_list(trig["include"])
        if not out["includes"]:
            out["problems"].append("trigger:include kosong.")
    elif "project" in trig:
        out["kind"] = "project"
        out["project"] = str(trig["project"])
        out["branch"] = trig.get("branch")
    else:
        out["problems"].append("trigger butuh 'include' (child) atau 'project' (multi-project).")
    return out


def parallel_info(par):
    """Ringkas `parallel` (angka atau matrix) menjadi {count, matrix[]}."""
    if isinstance(par, bool):
        return None
    if isinstance(par, int):
        return {"count": par, "matrix": []}
    if isinstance(par, dict) and isinstance(par.get("matrix"), list):
        combos = []
        for entry in par["matrix"]:
            if not isinstance(entry, dict):
                continue
            keys = list(entry.keys())
            lists = [v if isinstance(v, list) else [v] for v in entry.values()]
            partial = [{}]
            for key, values in zip(keys, lists):
                partial = [dict(p, **{key: v}) for p in partial for v in values]
            combos.extend(partial)
        return {"count": len(combos), "matrix": combos[:50]}
    return None


_ORIGIN_URL = re.compile(r'\[remote "origin"\][^\[]*?\burl\s*=\s*(\S+)', re.S)


def parse_remote_url(url):
    """Ambil (host, path project) dari URL remote git (ssh/scp-like/https)."""
    if not url:
        return None, None
    url = url.strip()
    m = re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]+@)?([^/:]+)(?::\d+)?/(.+)$", url)
    if not m:
        m = re.match(r"^(?:[^@]+@)?([^:/]+):(.+)$", url)   # git@host:group/project.git
    if not m:
        return None, None
    path = re.sub(r"\.git$", "", m.group(2).strip("/"))
    return m.group(1), (path or None)


PROJECT_VARS = ("CI_PROJECT_PATH", "CI_PROJECT_NAME", "CI_PROJECT_NAMESPACE",
                "CI_PROJECT_ROOT_NAMESPACE", "CI_PROJECT_PATH_SLUG")


def project_path_vars(path):
    """Variabel CI_PROJECT_* untuk sebuah path project (mis. 'grp/sub/app')."""
    path = str(path).strip("/")
    namespace, _sep, name = path.rpartition("/")
    return {
        "CI_PROJECT_PATH": path,
        "CI_PROJECT_NAME": name,
        "CI_PROJECT_NAMESPACE": namespace,
        "CI_PROJECT_ROOT_NAMESPACE": path.split("/", 1)[0],
        "CI_PROJECT_PATH_SLUG": re.sub(r"[^a-z0-9]+", "-", path.lower()).strip("-")[:63],
    }


def uses_project_vars(inc):
    """True bila path include (local/file) merujuk variabel CI_PROJECT_*."""
    text = " ".join(str(inc.get(k) or "") for k in ("local", "file")) if isinstance(inc, dict) else ""
    return any(re.search(r"\$\{?%s\b" % v, text) for v in PROJECT_VARS)


def find_repo_root(start):
    """Folder repo git terdekat (punya .git) untuk `start`, atau None."""
    start = Path(start).resolve()
    for p in [start] + list(start.parents):
        if (p / ".git").exists():
            return p
    return None


def project_predefined_vars(entry_file, config):
    """Variabel predefined project (CI_PROJECT_*, CI_SERVER_*) yang boleh dipakai di `include`.

    Sumber: remote `origin` di .git/config repo; fallback ke path relatif repo terhadap
    `search_roots` terdalam. Variabel yang tak bisa ditentukan tidak diisi (dibiarkan literal).
    """
    entry = Path(entry_file).resolve()
    root = find_repo_root(entry.parent)
    host = path = None
    if root is not None:
        cfg = root / ".git" / "config"
        if cfg.is_file():
            try:
                m = _ORIGIN_URL.search(cfg.read_text(encoding="utf-8", errors="ignore"))
                if m:
                    host, path = parse_remote_url(m.group(1))
            except OSError:
                pass
        if not path:
            best = None
            for root_str in (config or {}).get("search_roots", []):
                try:
                    rel = root.relative_to(Path(root_str).resolve())
                except (ValueError, OSError):
                    continue
                if str(rel) not in ("", ".") and (best is None or len(rel.parts) < len(best.parts)):
                    best = rel
            if best is not None:
                path = best.as_posix()
    out = project_path_vars(path) if path else {}
    if host:
        out.update({"CI_SERVER_HOST": host, "CI_SERVER_FQDN": host})
    return out


def parse_dynamic_overrides(items):
    """Ubah daftar 'KUNCI=PATH' (CLI) menjadi dict."""
    out = {}
    for item in items or []:
        key, sep, value = str(item).partition("=")
        if sep and key.strip() and value.strip():
            out[key.strip()] = value.strip()
    return out

# ANSI Color codes for clean terminal output
CYAN = "\033[96m"
BLUE = "\033[94m"
GREEN = "\033[92m"
YELLOW = "\033[93m"
RED = "\033[91m"
MAGENTA = "\033[95m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


# Override konfigurasi dari CLI (--config-json); di-set oleh main().
_CONFIG_OVERRIDE = None


def _read_config_file(path):
    try:
        path = Path(path).expanduser()
        if path.is_file():
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        pass
    return {}


def _merge_config(base, extra):
    if not isinstance(extra, dict):
        return base
    roots = extra.get("search_roots")
    if isinstance(roots, list):
        for r in roots:
            if isinstance(r, str) and r and r not in base["search_roots"]:
                base["search_roots"].append(r)
    maps = extra.get("project_mappings")
    if isinstance(maps, dict):
        for k, v in maps.items():
            if isinstance(k, str) and isinstance(v, str) and k and v:
                base["project_mappings"][k] = v
    return base


def load_config(extra=None):
    """Gabungkan konfigurasi: config.json bundel < file user < override CLI.

    File user: ``$GITLAB_CI_LOCAL_CONFIG`` bila di-set, kalau tidak
    ``~/.config/gitlab-ci-local/config.json``.
    """
    user_path = os.environ.get("GITLAB_CI_LOCAL_CONFIG") or "~/.config/gitlab-ci-local/config.json"
    sources = [
        _read_config_file(Path(__file__).parent / "config.json"),
        _read_config_file(user_path),
        _CONFIG_OVERRIDE,
        extra,
    ]
    cfg = {"search_roots": [], "project_mappings": {}}
    # Sumber berprioritas lebih tinggi: mapping-nya menang, search root-nya dicari lebih dulu.
    for src in reversed(sources):
        _merge_config(cfg, src)
    merged_maps = {}
    for src in sources:
        if isinstance(src, dict) and isinstance(src.get("project_mappings"), dict):
            merged_maps.update({k: v for k, v in src["project_mappings"].items()
                                if isinstance(k, str) and isinstance(v, str) and k and v})
    cfg["project_mappings"] = merged_maps
    return cfg


def find_project_root_locally(project_name, config, current_file_path):
    # 1. Check direct project_mappings in config
    mappings = config.get("project_mappings", {})
    if project_name in mappings:
        mapped_path = Path(mappings[project_name])
        if mapped_path.exists():
            return mapped_path

    # 2a. `<search_root>/<project_name>` langsung (murah).
    search_roots = config.get("search_roots", [])
    for root_str in search_roots:
        candidate = Path(root_str) / project_name
        if candidate.is_dir():
            return candidate

    # 2b. `<leluhur>/<group/subgroup/project>` di semua leluhur file saat ini (murah, melewati batas
    #     .git). Klon lokal umumnya mengikuti struktur group GitLab, jadi include:project tetap
    #     ter-resolve walau config.json belum/terlambat diperbarui (mis. folder repo diganti nama).
    if "/" in str(project_name):
        for p in Path(current_file_path).resolve().parents:
            candidate = p / project_name
            if candidate.is_dir():
                return candidate.resolve()

    # 2c. Pencarian mendalam per nama project di search_roots (mahal; hanya bila cara murah gagal).
    proj_basename = os.path.basename(project_name)
    for root_str in search_roots:
        root_path = Path(root_str)
        if not root_path.is_dir():
            continue
        for sub in _iter_dirs_named(root_path, proj_basename):
            if (sub / ".git").exists():
                return sub

    # 3. Check relative to current file path
    curr = Path(current_file_path).resolve().parent
    while curr.parent != curr:
        if (curr / project_name).exists() and (curr / project_name).is_dir():
            return (curr / project_name).resolve()
        candidate = curr / os.path.basename(project_name)
        if candidate.exists() and candidate.is_dir():
            return candidate.resolve()
        if (curr / ".git").exists():
            break
        curr = curr.parent

    # 4. Search in parent directories of current file
    for p in Path(current_file_path).resolve().parents:
        if p.name == project_name or p.name == os.path.basename(project_name):
            return p

    return None


# Folder yang tidak pernah berisi repo tujuan include; dilewati agar pencarian tetap cepat.
_SKIP_DIRS = frozenset((
    ".git", "node_modules", ".venv", ".venv-test", "venv", "__pycache__", ".terraform",
    "vendor", "dist", "build", ".cache", ".idea", ".vscode", "target",
))
_DIR_SCAN_LIMIT = 200000


def _iter_dirs_named(root, name):
    """Cari folder bernama `name` di bawah `root` (melewati folder berat, dengan batas jumlah)."""
    seen = 0
    for dirpath, dirnames, _filenames in os.walk(str(root)):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for d in dirnames:
            if d == name:
                yield Path(dirpath) / d
        seen += 1
        if seen > _DIR_SCAN_LIMIT:
            return


def find_key_line_in_file(file_path, key):
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            pattern = re.compile(r'^\s*["\']?' + re.escape(str(key)) + r'["\']?\s*:', re.IGNORECASE)
            for idx, line in enumerate(f, 1):
                if pattern.match(line):
                    return idx
    except Exception:
        pass
    return 1


def find_line_containing(file_path, substring):
    """Return the 1-based line number of the first line in file_path that
    contains substring, or None if not found / not readable / empty substring."""
    if not substring:
        return None
    try:
        needle = str(substring)
        with open(file_path, "r", encoding="utf-8") as f:
            for idx, line in enumerate(f, 1):
                if needle in line:
                    return idx
    except Exception:
        pass
    return None


class CIResolver:
    def __init__(self, entry_file, config=None, depth=0, child_level=0, ancestors=None,
                 dynamic_overrides=None, path_label="", include_vars=None):
        self.entry_file = Path(entry_file).resolve()
        self.config = config or load_config()
        self.file_trace = []
        self.visited_files = set()
        self.merged_raw = {}
        self.jobs = {}
        self.templates = {}
        self.stages = []
        self.global_variables = {}
        self.workflow_rules = []
        self.resolved_yaml = {}
        self.file_relationships = []
        # --- state tambahan untuk fitur modern ---
        self.defaults = {}                  # isi `default:` (digabung antar file)
        self.legacy_defaults = {}           # keyword global usang yang berfungsi sebagai default
        self.root_files = [str(self.entry_file)]
        self.input_problems = []            # masalah inputs/interpolasi
        self.structure_diags = []           # temuan validasi keyword per file
        self.structure_problems = []        # (kode, detail) mis. extends-cycle
        self._raw_cache = {}
        # variabel predefined untuk include (lazy); child dalam project yang sama mewarisi milik induk
        self._include_vars = dict(include_vars) if include_vars else None
        self._project_path_inferred = None  # CI_PROJECT_PATH hasil tebakan (file template dibuka langsung)
        # --- parent-child / multi-project ---
        self.depth = depth
        self.child_level = child_level
        self.ancestors = set(ancestors or [])
        self.dynamic_overrides = dict(dynamic_overrides or {})
        self.path_label = path_label        # jalur bridge dari root, mis. "deploy/qa"
        self.child_pipelines = {}           # bridge_job -> meta (serializable)
        self._child_resolvers = {}          # bridge_job -> CIResolver

    def resolve(self):
        self._process_file(self.entry_file, is_root=True)
        self._finalize()
        return self

    def resolve_files(self, files):
        """Resolve pipeline yang konfigurasinya tersusun dari beberapa file (trigger:include).

        ``files`` = list ``(path, include_spec)``; file pertama menjadi entry.
        """
        self.root_files = [str(Path(p).resolve()) for p, _s in files]
        for idx, (path, spec) in enumerate(files):
            self._process_file(path, is_root=(idx == 0), include_spec=spec)
        self._finalize()
        return self

    def _finalize(self):
        self._link_templates_and_jobs()
        self._apply_extends_and_defaults()
        self._build_merged_view()
        self._resolve_child_pipelines()

    def _process_file(self, file_path, is_root=False, include_spec=None, parent_file=None):
        file_path = Path(file_path).resolve()

        if parent_file:
            self.file_relationships.append({
                "parent": str(parent_file),
                "child": str(file_path),
                "spec": include_spec
            })

        if str(file_path) in self.visited_files:
            return
        self.visited_files.add(str(file_path))

        trace_entry = {
            "path": str(file_path),
            "display_name": file_path.name,
            "relative_path": self._rel_to_repo(file_path),
            "include_spec": include_spec or "ENTRY FILE",
            "included_by": [str(parent_file)] if parent_file else [],
            "includes": [],
            "jobs_defined": [],
            "templates_defined": [],
            "status": "OK",
        }

        if not file_path.exists():
            trace_entry["status"] = "FILE NOT FOUND"
            self.file_trace.append(trace_entry)
            return

        try:
            with open(file_path, "r", encoding="utf-8") as f:
                docs = list(yaml.load_all(f, Loader=_GitlabYamlLoader))
            spec, doc = split_spec(docs)
        except Exception as e:
            trace_entry["status"] = f"YAML ERROR: {e}"
            self.file_trace.append(trace_entry)
            return

        # --- spec:inputs + interpolasi $[[ inputs.x ]] ---
        provided = include_spec.get("inputs") if isinstance(include_spec, dict) else None
        if spec is not None or has_interpolation(doc):
            values, problems = resolve_inputs(spec, provided)
            doc, interp_problems = interpolate(doc, values)
            decl = declared_inputs(spec)
            trace_entry["inputs"] = {
                "declared": {k: {"type": v["type"], "required": not v["has_default"],
                                 "default": v["default"], "description": v["description"]}
                             for k, v in decl.items()},
                "values": values,
                "provided": sorted((provided or {}).keys()) if isinstance(provided, dict) else [],
            }
            for code, msg in list(problems) + list(interp_problems):
                sev = "error"
                if code == "input-required" and provided is None:
                    # Tidak ada yang mengisi (file entry / belum diketahui): hanya informasi.
                    sev = "info"
                elif code in ("component-context",):
                    sev = "info"
                self.input_problems.append({
                    "severity": sev, "code": code, "message": msg,
                    "source_file": str(file_path),
                    "line_number": find_key_line_in_file(file_path, "spec") if spec is not None else 1,
                })

        if isinstance(doc, dict):
            for key, dg in validate_top_level(doc):
                self.structure_diags.append({
                    "severity": dg["severity"], "code": dg["code"], "message": dg["message"],
                    "source_file": str(file_path),
                    "line_number": find_key_line_in_file(file_path, key),
                    "entity": key,
                })

        if not isinstance(doc, dict):
            if doc is None:
                doc = {}
            else:
                trace_entry["status"] = "NOT A VALID DICT (e.g. List or Raw String)"
                self.file_trace.append(trace_entry)
                return

        # Process nested includes first (in order)
        # (component/remote/template tidak dapat di-resolve offline; dicatat sebagai include eksternal)
        normalized_includes = normalize_include_list(doc.get("include", []))

        for inc in normalized_includes:
            inc_file_path = self._resolve_include_target(inc, file_path)
            inc_display = (inc.get("file") or inc.get("local") or inc.get("template")
                           or inc.get("component") or inc.get("remote") or str(inc))
            if inc_file_path:
                trace_entry["includes"].append({
                    "target_path": str(inc_file_path),
                    "spec": inc,
                    "display_name": Path(inc_file_path).name,
                    "resolved": True
                })
                self._process_file(inc_file_path, is_root=False, include_spec=inc, parent_file=file_path)
            else:
                trace_entry["includes"].append({
                    "target_path": str(inc),
                    "spec": inc,
                    "display_name": str(inc_display),
                    "resolved": False
                })
                is_component = isinstance(inc, dict) and "component" in inc
                is_remote = isinstance(inc, dict) and "remote" in inc
                is_template = isinstance(inc, dict) and "template" in inc
                if is_component:
                    inc_status = "EXTERNAL COMPONENT (tidak diresolve offline)"
                elif is_remote:
                    inc_status = "EXTERNAL REMOTE (tidak diresolve offline)"
                elif is_template:
                    inc_status = "EXTERNAL TEMPLATE (template bawaan GitLab tidak tersedia offline)"
                else:
                    inc_status = "COULD NOT RESOLVE LOCAL PATH"
                    expanded = self._expand_include(inc)
                    leftover = sorted(set(re.findall(
                        r"\$\{?([A-Za-z_][A-Za-z0-9_]*)",
                        " ".join(str(expanded.get(k) or "") for k in ("local", "file", "project")))))
                    if leftover:
                        inc_status = ("COULD NOT RESOLVE LOCAL PATH (variabel tidak diketahui offline: %s)"
                                      % ", ".join("$" + v for v in leftover))
                    elif expanded != inc:
                        inc_display = (expanded.get("file") or expanded.get("local") or inc_display)
                self.file_trace.append({
                    "path": str(inc),
                    "display_name": str(inc_display),
                    "relative_path": str(inc),
                    "include_spec": inc,
                    "included_by": [str(file_path)],
                    "includes": [],
                    "jobs_defined": [],
                    "templates_defined": [],
                    "status": inc_status,
                })

        # Process top-level keys in current file
        for key, val in doc.items():
            if key == "include":
                continue
            elif key == "stages" and isinstance(val, list):
                for st in val:
                    if st not in self.stages:
                        self.stages.append(st)
                self.merged_raw["stages"] = self.stages
            elif key == "variables" and isinstance(val, dict):
                self.global_variables.update(_norm_vars(val))
                self.merged_raw["variables"] = self.global_variables
            elif key == "workflow" and isinstance(val, dict):
                # Capture global workflow:rules for simulation. Root file is
                # prioritized; otherwise take the first definition seen.
                wf_rules = val.get("rules")
                if isinstance(wf_rules, list) and (is_root or not self.workflow_rules):
                    self.workflow_rules = wf_rules
                self.merged_raw[key] = val
            elif key == "default" and isinstance(val, dict):
                # `default:` bukan job; nilainya diwariskan ke job (lihat _apply_extends_and_defaults).
                self.defaults.update(val)
                self.merged_raw[key] = val
            elif key in RESERVED_TOP_LEVEL:
                # Keyword global lain bukan job. Yang usang (image/services/cache/before_script/
                # after_script di level atas) masih berlaku sebagai default berprioritas rendah.
                if key in DEFAULT_KEYWORDS:
                    self.legacy_defaults[key] = val
                self.merged_raw[key] = val
            elif isinstance(key, str) and key.startswith("."):
                line_no = find_key_line_in_file(file_path, key)
                trace_entry["templates_defined"].append({
                    "name": key,
                    "line_number": line_no
                })
                self.templates[key] = {
                    "name": key,
                    "source_file": str(file_path),
                    "line_number": line_no,
                    "relative_source": self._rel_to_repo(file_path),
                    "definition": val,
                    "extended_by": []
                }
                self.merged_raw[key] = val
            elif isinstance(val, dict):
                line_no = find_key_line_in_file(file_path, key)
                trace_entry["jobs_defined"].append({
                    "name": key,
                    "line_number": line_no,
                    "stage": val.get("stage", "test")
                })
                
                # Normalize needs
                raw_needs = val.get("needs", [])
                normalized_needs = []
                if isinstance(raw_needs, list):
                    for n in raw_needs:
                        if isinstance(n, str):
                            normalized_needs.append({"job": n})
                        elif isinstance(n, dict):
                            normalized_needs.append(n)
                elif isinstance(raw_needs, (str, dict)):
                    normalized_needs.append({"job": raw_needs} if isinstance(raw_needs, str) else raw_needs)

                self.jobs[key] = {
                    "job_name": key,
                    "source_file": str(file_path),
                    "line_number": line_no,
                    "relative_source": self._rel_to_repo(file_path),
                    "definition": val,
                    "stage": val.get("stage", "test"),
                    "extends": val.get("extends"),
                    "extends_info": [],
                    "needs": normalized_needs,
                    "rules": val.get("rules", []),
                    "only": val.get("only"),
                    "except": val.get("except"),
                    "parallel": val.get("parallel"),
                    "variables": val.get("variables", {}),
                    "tags": val.get("tags", []),
                    "script": val.get("script", []),
                    "before_script": val.get("before_script", []),
                    "after_script": val.get("after_script", []),
                    "image": val.get("image"),
                    "when": val.get("when"),
                    "trigger": val.get("trigger"),
                    "inherit": val.get("inherit"),
                    "allow_failure": val.get("allow_failure"),
                    "parallel_info": parallel_info(val.get("parallel")),
                    "effective_definition": None,   # diisi _apply_extends_and_defaults
                    "inherited_defaults": [],
                }
                self.merged_raw[key] = val
            else:
                self.merged_raw[key] = val

        self.file_trace.append(trace_entry)

    def _link_templates_and_jobs(self):
        """Cross-link extends references and update extended_by lists"""
        for job_name, job in self.jobs.items():
            ext = job.get("extends")
            if not ext:
                continue
            ext_list = ext if isinstance(ext, list) else [ext]
            for tmpl_name in ext_list:
                if tmpl_name in self.templates:
                    tmpl = self.templates[tmpl_name]
                    if job_name not in tmpl["extended_by"]:
                        tmpl["extended_by"].append(job_name)
                    job["extends_info"].append({
                        "name": tmpl_name,
                        "source_file": tmpl["source_file"],
                        "line_number": tmpl["line_number"],
                        "definition": tmpl.get("definition", {})
                    })
                elif tmpl_name in self.jobs and tmpl_name != job_name:
                    base_job = self.jobs[tmpl_name]
                    job["extends_info"].append({
                        "name": tmpl_name,
                        "source_file": base_job["source_file"],
                        "line_number": base_job["line_number"],
                        "definition": base_job.get("definition", {})
                    })
                else:
                    job["extends_info"].append({
                        "name": tmpl_name,
                        "source_file": None,
                        "line_number": 1,
                        "definition": {}
                    })

    # ------------------------------------------------------------------
    # extends / default / !reference  ->  definisi efektif job
    # ------------------------------------------------------------------
    def _note_structure(self, code, message, entity):
        item = {"code": code, "message": message, "entity": entity}
        if item not in self.structure_problems:
            self.structure_problems.append(item)

    def _raw_def(self, name, stack=()):
        """Definisi template/job `name` setelah rantai `extends` di-merge (belum ada default)."""
        if name in self._raw_cache:
            return self._raw_cache[name]
        if name == "default":
            return dict(self.legacy_defaults, **self.defaults)
        node = None
        if name in self.templates:
            node = self.templates[name].get("definition")
        elif name in self.jobs:
            node = self.jobs[name].get("definition")
        if not isinstance(node, dict):
            return {}
        if name in stack:
            self._note_structure("extends-cycle", "extends melingkar: %s" % " -> ".join(list(stack) + [name]), name)
            return {}
        merged = {}
        ext = node.get("extends")
        parents = ext if isinstance(ext, list) else ([ext] if ext else [])
        for parent in parents:
            if isinstance(parent, str):
                merged = _deep_merge(merged, self._raw_def(parent, stack + (name,)))
        own = {k: v for k, v in node.items() if k != "extends"}
        merged = _deep_merge(merged, own)
        self._raw_cache[name] = merged
        return merged

    def _lookup_ref(self, path, depth, owner):
        if not isinstance(path, list) or not path:
            return None
        current = self._raw_def(str(path[0]))
        for key in path[1:]:
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                self._note_structure(
                    "reference-missing",
                    "!reference [%s] tidak ditemukan." % ", ".join(str(p) for p in path), owner)
                return None
        return self._resolve_refs(copy.deepcopy(current), depth + 1, owner)

    def _resolve_refs(self, obj, depth=0, owner=None):
        """Ganti penanda !reference dengan nilai rujukannya (list di-splice)."""
        if depth > 10:
            return obj
        if _is_ref(obj):
            return self._lookup_ref(obj["__gitlab_reference__"], depth, owner)
        if isinstance(obj, list):
            out = []
            for item in obj:
                if _is_ref(item):
                    val = self._lookup_ref(item["__gitlab_reference__"], depth, owner)
                    if isinstance(val, list):
                        out.extend(val)
                    elif val is not None:
                        out.append(val)
                else:
                    out.append(self._resolve_refs(item, depth + 1, owner))
            return out
        if isinstance(obj, dict):
            return {k: self._resolve_refs(v, depth + 1, owner) for k, v in obj.items()}
        return obj

    def _apply_extends_and_defaults(self):
        """Hitung definisi efektif tiap job: extends di-merge, !reference di-resolve, default diwariskan."""
        self._raw_cache = {}
        defaults_raw = dict(self.legacy_defaults)
        defaults_raw.update(self.defaults)
        defaults = self._resolve_refs(copy.deepcopy(defaults_raw), 0, "default")
        for name, job in self.jobs.items():
            eff = self._resolve_refs(copy.deepcopy(self._raw_def(name)), 0, name)
            job["effective_definition"] = eff
            inherit = eff.get("inherit") if isinstance(eff.get("inherit"), dict) else {}
            setting = inherit.get("default", True)
            inherited = {}
            for key, value in defaults.items():
                if key in eff or key not in DEFAULT_KEYWORDS:
                    continue
                if setting is False:
                    continue
                if isinstance(setting, list) and key not in setting:
                    continue
                inherited[key] = copy.deepcopy(value)
            job["inherited_defaults"] = sorted(inherited.keys())
            full = dict(eff)
            full.update(inherited)
            job["resolved_definition"] = copy.deepcopy(full)   # extends + !reference + default
            self._refresh_job_fields(job, full)

    def _refresh_job_fields(self, job, full):
        """Selaraskan field turunan job dengan definisi efektif."""
        job["stage"] = full.get("stage", "test") if isinstance(full.get("stage", "test"), str) else "test"
        job["needs"] = normalize_needs(full.get("needs"))
        rules = full.get("rules")
        job["rules"] = rules if isinstance(rules, list) else []
        job["only"] = full.get("only")
        job["except"] = full.get("except")
        job["parallel"] = full.get("parallel")
        job["parallel_info"] = parallel_info(full.get("parallel"))
        job["variables"] = _norm_vars(full.get("variables"))
        tags = full.get("tags", [])
        job["tags"] = tags if isinstance(tags, list) else []
        job["script"] = full.get("script", [])
        job["before_script"] = full.get("before_script", [])
        job["after_script"] = full.get("after_script", [])
        job["image"] = full.get("image")
        job["when"] = full.get("when")
        job["trigger"] = full.get("trigger")
        job["inherit"] = full.get("inherit")
        job["allow_failure"] = full.get("allow_failure")

    # ------------------------------------------------------------------
    # Parent-child / multi-project / dynamic child pipelines
    # ------------------------------------------------------------------
    def _resolve_child_pipelines(self):
        self.child_pipelines = {}
        self._child_resolvers = {}
        for name, job in self.jobs.items():
            # `trigger: {}` tetap dianggap bridge (tidak valid) agar terlapor, bukan diabaikan.
            if "trigger" not in (job.get("effective_definition") or job.get("definition") or {}):
                continue
            meta, child = self._build_child(name, job)
            self.child_pipelines[name] = meta
            if child is not None:
                self._child_resolvers[name] = child

    def _find_dynamic_sample(self, bridge, inc, base):
        """Cari file contoh untuk child dinamis (artifact) yang dibuat saat runtime."""
        artifact = str(inc.get("artifact") or "")
        gen_job = inc.get("job")
        base_name = os.path.basename(artifact)
        ci_dir = Path(base).parent
        searched = []
        info = {
            "artifact": artifact, "job": gen_job, "sample_file": None,
            "sample_source": None, "searched": searched, "hint": "",
        }
        keys = [k for k in (bridge, artifact, gen_job, base_name) if k]
        for source, mapping in (("cli", self.dynamic_overrides), ("config", self.config.get("dynamic_children"))):
            if not isinstance(mapping, dict):
                continue
            for key in keys:
                if key in mapping:
                    cand = Path(str(mapping[key]))
                    if not cand.is_absolute():
                        cand = ci_dir / cand
                    searched.append(str(cand))
                    if cand.is_file():
                        info["sample_file"] = str(cand.resolve())
                        info["sample_source"] = source
                        return info
        directory = ci_dir
        for _ in range(6):
            candidates = [directory / artifact] if artifact else []
            candidates += [
                directory / ".ci-samples" / base_name,
                directory / ".ci-samples" / (bridge + ".yml"),
                directory / ".ci-samples" / (bridge + ".yaml"),
            ]
            for cand in candidates:
                searched.append(str(cand))
                if cand.is_file():
                    info["sample_file"] = str(cand.resolve())
                    info["sample_source"] = "autodetect"
                    return info
            if (directory / ".git").exists() or directory.parent == directory:
                break
            directory = directory.parent
        info["hint"] = (
            "Child ini di-generate saat runtime oleh job '%s'. Letakkan hasil generate contoh di "
            "'%s' atau '%s', atau petakan lewat setting gitlabCiLocal.dynamicChildren / "
            "config.json dynamic_children." % (
                gen_job or "?", ci_dir / (artifact or "<artifact>"),
                ci_dir / ".ci-samples" / (base_name or (bridge + ".yml"))))
        return info

    def _build_child(self, name, job):
        norm = normalize_trigger(job.get("trigger"))
        path = (self.path_label + "/" if self.path_label else "") + name
        level = self.child_level + (1 if norm["kind"] == "child" else 0)
        meta = {
            "bridge_job": name, "path": path, "kind": norm["kind"],
            "status": "UNRESOLVED", "status_detail": "",
            "strategy": norm["strategy"], "forward": norm["forward"],
            "project": norm["project"], "branch": norm["branch"], "inputs": norm["inputs"],
            "includes": [], "dynamic": None, "entry_file": None, "files": [],
            "stages": [], "jobs": {}, "templates": {}, "file_trace": [],
            "workflow_rules": [], "global_variables": {}, "children": {}, "diagnostics": [],
            "source_file": job.get("source_file"), "line_number": job.get("line_number"),
            "level": level, "problems": list(norm["problems"]),
        }
        if norm["kind"] == "invalid":
            meta["status_detail"] = "; ".join(norm["problems"]) or "trigger tidak valid"
            return meta, None
        if self.depth >= MAX_PIPELINE_DEPTH or (norm["kind"] == "child" and self.child_level >= MAX_CHILD_LEVELS):
            meta["status"] = "DEPTH_EXCEEDED"
            meta["status_detail"] = (
                "Child pipeline melebihi kedalaman maksimum GitLab (%d level child)." % MAX_CHILD_LEVELS)
            return meta, None

        base = Path(job.get("source_file") or self.entry_file)
        files = []
        if norm["kind"] == "child":
            for inc in norm["includes"]:
                info = {"spec": inc, "target_path": None, "resolved": False, "kind": "local",
                        "display_name": str(inc.get("local") or inc.get("file") or inc.get("template")
                                            or inc.get("component") or inc.get("remote") or inc.get("artifact") or inc)}
                if "artifact" in inc:
                    dyn = self._find_dynamic_sample(name, inc, base)
                    meta["dynamic"] = dyn
                    info["kind"] = "artifact"
                    if dyn["sample_file"]:
                        info["target_path"] = dyn["sample_file"]
                        info["resolved"] = True
                        files.append((Path(dyn["sample_file"]), dict(inc, sample=True)))
                elif "component" in inc:
                    info["kind"] = "component"
                elif "remote" in inc:
                    info["kind"] = "remote"
                elif "template" in inc:
                    info["kind"] = "template"
                else:
                    info["kind"] = "project" if "project" in inc else "local"
                    target = self._resolve_include_target(inc, base)
                    if target:
                        info["target_path"] = str(target)
                        info["resolved"] = True
                        files.append((Path(target), inc))
                meta["includes"].append(info)
        else:
            project = norm["project"] or ""
            info = {"spec": {"project": project, "branch": norm["branch"]}, "target_path": None,
                    "resolved": False, "kind": "project", "display_name": project}
            meta["includes"].append(info)
            if project and "$" not in project:
                root = find_project_root_locally(project, self.config, base)
                entry = (Path(root) / ".gitlab-ci.yml") if root else None
                if entry is not None and entry.is_file():
                    info["target_path"] = str(entry.resolve())
                    info["resolved"] = True
                    files.append((entry, {"inputs": norm["inputs"]}))
            else:
                meta["status_detail"] = "Nama project memakai variabel; tidak bisa diresolve offline."

        placeholder = bool(meta["dynamic"]) and not meta["dynamic"]["sample_file"]
        unresolved = [i for i in meta["includes"] if not i["resolved"] and i["kind"] != "artifact"]

        if files:
            resolved_paths = {str(Path(p).resolve()) for p, _s in files}
            if resolved_paths & (self.ancestors | {str(self.entry_file)}):
                meta["status"] = "CYCLE"
                meta["status_detail"] = "Child pipeline merujuk file yang sudah menjadi induknya (siklus)."
                return meta, None
            child = CIResolver(
                files[0][0], config=self.config, depth=self.depth + 1, child_level=level if norm["kind"] == "child" else 0,
                ancestors=self.ancestors | {str(self.entry_file)}, dynamic_overrides=self.dynamic_overrides,
                path_label=path,
                include_vars=self.include_variables() if norm["kind"] == "child" else None)
            child.resolve_files(files)
            meta.update({
                "entry_file": str(child.entry_file), "files": [str(p) for p, _s in files],
                "stages": child.stages, "jobs": child.jobs, "templates": child.templates,
                "file_trace": child.file_trace, "workflow_rules": child.workflow_rules,
                "global_variables": child.global_variables, "children": child.child_pipelines,
                "diagnostics": child.get_diagnostics(include_children=False),
            })
            all_samples = all(isinstance(s, dict) and s.get("sample") for _p, s in files)
            if unresolved or placeholder:
                meta["status"] = "PARTIAL"
                meta["status_detail"] = "Sebagian include child belum bisa diresolve."
            elif all_samples:
                meta["status"] = "SAMPLE"
                dyn = meta["dynamic"] or {}
                meta["status_detail"] = "Memakai file contoh: %s (sumber: %s)." % (
                    dyn.get("sample_file"), dyn.get("sample_source"))
            else:
                meta["status"] = "RESOLVED"
            return meta, child

        if placeholder and not unresolved:
            meta["status"] = "PLACEHOLDER"
            meta["status_detail"] = meta["dynamic"]["hint"]
        else:
            meta["status"] = "UNRESOLVED"
            if not meta["status_detail"]:
                names = ", ".join(i["display_name"] for i in unresolved) or "-"
                meta["status_detail"] = "Konfigurasi child tidak ditemukan offline: %s" % names
        return meta, None

    def include_variables(self):
        """Variabel yang boleh dipakai di `include` (predefined project), dihitung sekali per pipeline."""
        if self._include_vars is None:
            self._include_vars = project_predefined_vars(self.entry_file, self.config)
        return self._include_vars

    def _expand_include(self, inc, env=None):
        """Ekspansi `$VAR`/`${VAR}` pada local/file/project/ref sebuah include (salinan baru)."""
        env = self.include_variables() if env is None else env
        if not env:
            return inc
        out = dict(inc)
        for key in ("local", "file", "project", "ref", "remote", "template"):
            if isinstance(out.get(key), str) and "$" in out[key]:
                out[key] = expand_variables(out[key], env)
        return out

    def _consumer_project_candidates(self):
        """Tebakan path project pemakai untuk file template yang dibuka langsung.

        File template di repo bersama (mis. `<ci-library>/pipelines/<group>/<app>/pipeline.yml`) di GitLab
        selalu di-include dari project lain, sehingga `CI_PROJECT_PATH` = project pemakai, bukan
        repo template. Kandidat = akhiran path folder entry file relatif terhadap root repo.
        """
        root = find_repo_root(self.entry_file.parent)
        if root is None:
            return []
        try:
            parts = self.entry_file.parent.relative_to(root).parts
        except ValueError:
            return []
        out = []
        for i in range(len(parts)):
            cand = "/".join(parts[i:])
            if "/" in cand and cand not in out:   # project GitLab selalu punya namespace
                out.append(cand)
        return out

    def _resolve_include_target(self, inc, current_file_path):
        if not isinstance(inc, dict):
            return None
        target = self._resolve_include_target_raw(self._expand_include(inc), current_file_path)
        if target or self._project_path_inferred or not uses_project_vars(inc):
            return target
        # CI_PROJECT_* dari repo ini tidak cocok: coba tebak project pemakai (lihat docstring kandidat).
        own = self.include_variables().get("CI_PROJECT_PATH")
        for cand in self._consumer_project_candidates():
            if cand == own:
                continue
            env = dict(self.include_variables())
            env.update(project_path_vars(cand))
            target = self._resolve_include_target_raw(self._expand_include(inc, env), current_file_path)
            if target:
                self._include_vars = env
                self._project_path_inferred = cand
                return target
        return None

    def _resolve_include_target_raw(self, inc, current_file_path):
        if not isinstance(inc, dict):
            return None

        # 1. include: local
        if "local" in inc and inc["local"]:
            loc = str(inc["local"]).lstrip("/")
            curr = current_file_path.parent
            if (curr / loc).exists():
                return (curr / loc).resolve()
            while curr.parent != curr:
                if (curr / loc).exists():
                    return (curr / loc).resolve()
                if (curr / ".git").exists():
                    break
                curr = curr.parent
            for root_str in self.config.get("search_roots", []):
                cand = Path(root_str) / loc
                if cand.exists():
                    return cand.resolve()
            return None

        # 2. include: project + file
        if "project" in inc and "file" in inc:
            project_name = str(inc["project"])
            rel_file = str(inc["file"]).lstrip("/")
            proj_root = find_project_root_locally(project_name, self.config, current_file_path)
            if proj_root:
                target = proj_root / rel_file
                if target.exists():
                    return target.resolve()
            curr_repo = current_file_path.parent
            while curr_repo.parent != curr_repo:
                if (curr_repo / rel_file).exists():
                    return (curr_repo / rel_file).resolve()
                if (curr_repo / ".git").exists():
                    break
                curr_repo = curr_repo.parent
            for root_str in self.config.get("search_roots", []):
                cand = Path(root_str) / rel_file
                if cand.exists():
                    return cand.resolve()

        # 3. include: template / file directly
        if "file" in inc and "project" not in inc:
            rel_file = str(inc["file"]).lstrip("/")
            cand = current_file_path.parent / rel_file
            if cand.exists():
                return cand.resolve()
            for root_str in self.config.get("search_roots", []):
                cand = Path(root_str) / rel_file
                if cand.exists():
                    return cand.resolve()

        return None

    def _rel_to_repo(self, path):
        p = Path(path).resolve()
        for root in self.config.get("search_roots", []):
            try:
                return str(p.relative_to(root))
            except ValueError:
                pass
        return p.name

    def _build_merged_view(self):
        if not self.stages:
            self.stages = [".pre", "build", "test", "deploy", ".post"]
        self.resolved_yaml = copy.deepcopy(self.merged_raw)

    def _spec_value(self, spec):
        """Extract the meaningful path value from a raw include spec dict
        (the 'local' or 'file' value), used to disambiguate multiple includes
        in a single parent file. Returns a string or None."""
        if isinstance(spec, dict):
            for k in ("local", "file"):
                v = spec.get(k)
                if isinstance(v, str) and v:
                    return v
        return None

    def _include_line_for_node(self, ft):
        """Compute the line number where the file represented by file_trace
        entry `ft` is included within its parent file.

        Strategy:
          1. Resolve the parent file path (from `included_by`, else by scanning
             file_trace for an entry whose `includes` target this node's path).
          2. Try to pin the exact line by searching the parent for the include
             spec value (the 'local'/'file' string). This disambiguates parents
             with multiple includes.
          3. Fall back to the first `include:` key line in the parent file.
          4. Final fallback: 1.
        """
        node_path = ft.get("path")

        # 1. Determine parent path.
        parent_path = None
        included_by = ft.get("included_by") or []
        if included_by:
            parent_path = included_by[0]
        else:
            for other in self.file_trace:
                for child in other.get("includes", []):
                    if child.get("target_path") == node_path:
                        parent_path = other.get("path")
                        break
                if parent_path:
                    break

        if not parent_path:
            return 1

        # 2. Try to pin the exact line using the spec value.
        spec_val = self._spec_value(ft.get("include_spec"))
        if spec_val is None:
            # Fall back to the parent's own includes list to recover the spec.
            for other in self.file_trace:
                if other.get("path") != parent_path:
                    continue
                for child in other.get("includes", []):
                    if child.get("target_path") == node_path:
                        spec_val = self._spec_value(child.get("spec"))
                        break
                break

        if spec_val:
            line = find_line_containing(parent_path, spec_val)
            if line:
                return line

        # 3. Fall back to the include key line in the parent.
        line = find_key_line_in_file(parent_path, "include")
        if line:
            return line

        # 4. Final fallback.
        return 1

    def get_diagnostics(self, include_children=True):
        diags = []
        # `.pre` dan `.post` selalu tersedia walau tidak ditulis di `stages`.
        stage_set = set(self.stages or []) | {".pre", ".post"}
        job_names = set(self.jobs.keys())
        tmpl_names = set(self.templates.keys())
        def add(sev, code, msg, sf=None, ln=1, ent=None):
            diags.append({"severity": sev, "code": code, "message": msg, "source_file": sf, "line_number": ln or 1, "entity": ent})
        for name, job in self.jobs.items():
            st = job.get("stage")
            if st and stage_set and st not in stage_set:
                add("warning", "unknown-stage", "Job '%s' memakai stage '%s' yang tidak terdaftar di stages." % (name, st), job.get("source_file"), job.get("line_number"), name)
        for name, job in self.jobs.items():
            for need in (job.get("needs") or []):
                tgt = need.get("job") if isinstance(need, dict) else need
                if isinstance(need, dict) and (need.get("project") or need.get("pipeline")):
                    continue  # needs lintas project/pipeline tidak bisa diperiksa offline
                if tgt and tgt not in job_names:
                    if isinstance(need, dict) and need.get("optional"):
                        add("info", "needs-optional-missing",
                            "Job '%s' needs opsional '%s' tidak ada (diabaikan)." % (name, tgt),
                            job.get("source_file"), job.get("line_number"), name)
                        continue
                    add("error", "needs-missing", "Job '%s' needs '%s' yang tidak ditemukan." % (name, tgt), job.get("source_file"), job.get("line_number"), name)
        for name, job in self.jobs.items():
            ext = job.get("extends")
            if not ext:
                continue
            for t in (ext if isinstance(ext, list) else [ext]):
                if t not in tmpl_names and t not in job_names:
                    add("error", "extends-missing", "Job '%s' extends '%s' yang tidak ditemukan." % (name, t), job.get("source_file"), job.get("line_number"), name)
        for ft in self.file_trace:
            st = ft.get("status")
            if st != "OK":
                if st and st.startswith("EXTERNAL COMPONENT"):
                    add("info", "external-component", "Include component eksternal (tidak diresolve offline): %s" % ft.get("display_name"), ft.get("path"), 1, ft.get("display_name"))
                elif st and st.startswith("EXTERNAL REMOTE"):
                    add("info", "external-remote", "Include remote (tidak diresolve offline): %s" % ft.get("display_name"), ft.get("path"), 1, ft.get("display_name"))
                elif st and st.startswith("EXTERNAL TEMPLATE"):
                    add("info", "external-template", "Include template bawaan GitLab (tidak tersedia offline): %s" % ft.get("display_name"), ft.get("path"), 1, ft.get("display_name"))
                else:
                    add("error", "include-unresolved", "Include tidak terselesaikan: %s (%s)" % (ft.get("display_name"), st), ft.get("path"), 1, ft.get("display_name"))
        graph = {}
        for name, job in self.jobs.items():
            deps = []
            for need in (job.get("needs") or []):
                tgt = need.get("job") if isinstance(need, dict) else need
                if tgt in job_names:
                    deps.append(tgt)
            graph[name] = deps
        color = {n: 0 for n in graph}
        reported = set()
        def dfs(n, stack):
            color[n] = 1
            stack.append(n)
            for m in graph.get(n, []):
                if color.get(m) == 1:
                    if m not in reported:
                        try:
                            cyc = stack[stack.index(m):] + [m]
                        except ValueError:
                            cyc = [m, n]
                        reported.add(m)
                        jb = self.jobs.get(m, {})
                        add("error", "needs-cycle", "Circular needs: %s" % " -> ".join(cyc), jb.get("source_file"), jb.get("line_number"), m)
                elif color.get(m) == 0:
                    dfs(m, stack)
            stack.pop()
            color[n] = 2
        for n in list(graph.keys()):
            if color.get(n) == 0:
                dfs(n, [])
        diags.extend(self._extra_diagnostics(include_children))
        return diags

    def _extra_diagnostics(self, include_children=True):
        """Temuan tambahan: inputs, validasi keyword, struktur extends, needs stage, child pipeline."""
        diags = []

        def add(sev, code, msg, sf=None, ln=1, ent=None):
            diags.append({"severity": sev, "code": code, "message": msg,
                          "source_file": sf, "line_number": ln or 1, "entity": ent})

        diags.extend(self.input_problems)
        diags.extend(self.structure_diags)

        if self._project_path_inferred:
            add("info", "project-path-inferred",
                "CI_PROJECT_PATH diasumsikan '%s' (file template dibuka langsung; di GitLab nilainya "
                "berasal dari project yang meng-include file ini)." % self._project_path_inferred,
                str(self.entry_file), find_key_line_in_file(self.entry_file, "include"), "include")

        for item in self.structure_problems:
            owner = self.jobs.get(item["entity"]) or self.templates.get(item["entity"]) or {}
            add("error" if item["code"] == "extends-cycle" else "warning", item["code"], item["message"],
                owner.get("source_file"), owner.get("line_number"), item["entity"])

        for name, job in self.jobs.items():
            for dg in validate_job(name, job.get("definition"), job.get("effective_definition"), self.stages):
                add(dg["severity"], dg["code"], dg["message"], job.get("source_file"), job.get("line_number"), name)

        order = {s: i for i, s in enumerate(
            [".pre"] + [s for s in (self.stages or []) if s not in (".pre", ".post")] + [".post"])}
        for name, job in self.jobs.items():
            js = order.get(job.get("stage"))
            for need in (job.get("needs") or []):
                if not isinstance(need, dict) or need.get("project") or need.get("pipeline"):
                    continue
                target = self.jobs.get(need.get("job"))
                ts = order.get(target.get("stage")) if target else None
                if js is not None and ts is not None and ts > js:
                    add("error", "needs-later-stage",
                        "Job '%s' (stage %s) needs '%s' yang berada di stage lebih akhir (%s)." % (
                            name, job.get("stage"), need.get("job"), target.get("stage")),
                        job.get("source_file"), job.get("line_number"), name)

        for bname, meta in self.child_pipelines.items():
            st = meta.get("status")
            sf, ln = meta.get("source_file"), meta.get("line_number")
            if st == "PLACEHOLDER":
                add("info", "dynamic-child-placeholder",
                    "Child dinamis dari '%s' belum punya file contoh (placeholder)." % bname, sf, ln, bname)
            elif st == "SAMPLE":
                add("info", "dynamic-child-sample",
                    "Child dinamis '%s' disimulasikan memakai file contoh." % bname, sf, ln, bname)
            elif st == "UNRESOLVED":
                add("warning", "child-unresolved",
                    "Child/downstream '%s' tidak bisa diresolve offline: %s" % (bname, meta.get("status_detail")),
                    sf, ln, bname)
            elif st == "PARTIAL":
                add("warning", "child-partial", "Child '%s' hanya sebagian ter-resolve." % bname, sf, ln, bname)
            elif st == "CYCLE":
                add("error", "child-cycle", "Child '%s': %s" % (bname, meta.get("status_detail")), sf, ln, bname)
            elif st == "DEPTH_EXCEEDED":
                add("error", "child-depth", "Child '%s': %s" % (bname, meta.get("status_detail")), sf, ln, bname)
            for problem in meta.get("problems") or []:
                add("error", "trigger-invalid", "Job '%s': %s" % (bname, problem), sf, ln, bname)

        if include_children:
            for bname, child in self._child_resolvers.items():
                label = (self.child_pipelines.get(bname) or {}).get("path", bname)
                for dg in child.get_diagnostics(include_children=True):
                    item = dict(dg)
                    item["message"] = "[child %s] %s" % (label, dg.get("message"))
                    diags.append(item)
        return diags

    def get_deep_graph(self):
        """Build graph nodes and edges representing the entire CI pipeline architecture"""
        nodes = []
        edges = []
        node_ids = set()

        def add_node(node_id, label, node_type, data=None):
            if node_id not in node_ids:
                node_ids.add(node_id)
                n = {
                    "id": node_id,
                    "label": label,
                    "type": node_type,
                }
                if data:
                    n.update(data)
                nodes.append(n)

        # 1. Entry File Node
        entry_id = f"file:{self.entry_file}"
        add_node(entry_id, self.entry_file.name, "root_file", {
            "path": str(self.entry_file),
            "line_number": 1,
            "relative_path": self._rel_to_repo(self.entry_file)
        })

        # 2. Included File Nodes & Edges
        for ft in self.file_trace:
            f_path = ft["path"]
            f_id = f"file:{f_path}"
            is_entry = (f_path == str(self.entry_file))
            if not is_entry:
                include_line = self._include_line_for_node(ft)
                add_node(f_id, ft["display_name"], "include_file" if ft["status"] == "OK" else "error_file", {
                    "path": f_path,
                    "line_number": include_line,
                    "status": ft["status"],
                    "relative_path": ft.get("relative_path", ft["display_name"])
                })

            for child in ft.get("includes", []):
                c_path = child.get("target_path")
                c_id = f"file:{c_path}"
                edges.append({
                    "source": f_id,
                    "target": c_id,
                    "type": "includes",
                    "label": "includes"
                })

        # 3. Template Nodes & Definitions
        for tmpl_name, tmpl in self.templates.items():
            t_id = f"tmpl:{tmpl_name}"
            add_node(t_id, tmpl_name, "template", {
                "name": tmpl_name,
                "path": tmpl["source_file"],
                "line_number": tmpl["line_number"],
                "extended_by": tmpl["extended_by"],
                "variables_count": len(tmpl["definition"].get("variables", {})) if isinstance(tmpl["definition"], dict) else 0,
            })
            if tmpl["source_file"]:
                edges.append({
                    "source": f"file:{tmpl['source_file']}",
                    "target": t_id,
                    "type": "defines_template",
                    "label": "defines"
                })

        # 4. Job Nodes & Stage Connections
        for job_name, job in self.jobs.items():
            j_id = f"job:{job_name}"
            add_node(j_id, job_name, "job", {
                "name": job_name,
                "stage": job.get("stage", "test"),
                "path": job["source_file"],
                "line_number": job["line_number"],
                "tags": job.get("tags", []),
                "when": job.get("when"),
                "rules_count": len(job.get("rules", [])),
                "variables_count": len(job.get("variables", {}))
            })
            if job["source_file"]:
                edges.append({
                    "source": f"file:{job['source_file']}",
                    "target": j_id,
                    "type": "defines_job",
                    "label": "defines"
                })

            # Extends edges (template -> job)
            for ext in job.get("extends_info", []):
                t_id = f"tmpl:{ext['name']}"
                if t_id in node_ids:
                    edges.append({
                        "source": t_id,
                        "target": j_id,
                        "type": "extends",
                        "label": "extended by"
                    })

            # Needs edges (job -> job)
            for need in job.get("needs", []):
                target_job_name = need.get("job") if isinstance(need, dict) else need
                if target_job_name:
                    n_id = f"job:{target_job_name}"
                    edges.append({
                        "source": n_id,
                        "target": j_id,
                        "type": "needs",
                        "label": "needed by"
                    })

        # 5. Stage Nodes
        for st in self.stages:
            s_id = f"stage:{st}"
            add_node(s_id, st, "stage", {
                "stage": st
            })
            for job_name, job in self.jobs.items():
                if job.get("stage") == st:
                    edges.append({
                        "source": s_id,
                        "target": f"job:{job_name}",
                        "type": "stage_contains",
                        "label": "runs"
                    })

        # 6. Downstream pipelines (parent-child / multi-project / dynamic)
        self._graph_children(add_node, edges, self.child_pipelines, lambda b: "job:%s" % b)

        return {
            "nodes": nodes,
            "edges": edges
        }

    def _graph_children(self, add_node, edges, children, bridge_node_id):
        """Tambahkan node/edge untuk pipeline downstream secara rekursif."""
        for bname, meta in (children or {}).items():
            path = meta.get("path") or bname
            cid = "child:%s" % path
            placeholder = meta.get("status") == "PLACEHOLDER"
            kind_label = {"child": "child", "project": "downstream"}.get(meta.get("kind"), "child")
            if placeholder:
                label = "dynamic child"
            elif meta.get("status") in ("UNRESOLVED", "CYCLE", "DEPTH_EXCEEDED"):
                label = "%s (%s)" % (kind_label, meta.get("status").lower())
            else:
                label = "%s pipeline (%d jobs)" % (kind_label, len(meta.get("jobs") or {}))
            add_node(cid, label, "dynamic_child" if placeholder else "child_pipeline", {
                "child_path": path,
                "kind": meta.get("kind"),
                "status": meta.get("status"),
                "strategy": meta.get("strategy"),
                "bridge_job": bname,
                "path": meta.get("entry_file") or meta.get("source_file"),
                "line_number": 1 if meta.get("entry_file") else (meta.get("line_number") or 1),
            })
            edges.append({"source": bridge_node_id(bname), "target": cid, "type": "triggers", "label": "triggers"})

            for ft in meta.get("file_trace") or []:
                fid = "file:%s" % ft["path"]
                add_node(fid, ft["display_name"], "include_file" if ft["status"] == "OK" else "error_file", {
                    "path": ft["path"], "line_number": 1, "status": ft["status"],
                    "relative_path": ft.get("relative_path", ft["display_name"]),
                })
                if not ft.get("included_by"):
                    edges.append({"source": cid, "target": fid, "type": "includes", "label": "config"})
                for inc in ft.get("includes", []):
                    edges.append({"source": fid, "target": "file:%s" % inc.get("target_path"),
                                  "type": "includes", "label": "includes"})

            jobs = meta.get("jobs") or {}
            for jname, j in jobs.items():
                jid = "cjob:%s/%s" % (path, jname)
                add_node(jid, jname, "job", {
                    "name": jname, "stage": j.get("stage", "test"), "path": j.get("source_file"),
                    "line_number": j.get("line_number"), "tags": j.get("tags", []), "when": j.get("when"),
                    "rules_count": len(j.get("rules") or []), "variables_count": len(j.get("variables") or {}),
                    "child_path": path,
                })
                edges.append({"source": cid, "target": jid, "type": "child_contains", "label": "contains"})
            for jname, j in jobs.items():
                for need in j.get("needs") or []:
                    tgt = need.get("job") if isinstance(need, dict) else need
                    if tgt in jobs:
                        edges.append({"source": "cjob:%s/%s" % (path, tgt), "target": "cjob:%s/%s" % (path, jname),
                                      "type": "needs", "label": "needed by"})

            self._graph_children(add_node, edges, meta.get("children"),
                                 lambda b, p=path: "cjob:%s/%s" % (p, b))


def format_rules(rules):
    if not rules:
        return f"{DIM}(always runs / default){RESET}"
    out = []
    for r in rules:
        if isinstance(r, dict):
            cond = r.get("if", "")
            when = r.get("when", "")
            vars_override = r.get("variables")
            parts = []
            if cond:
                parts.append(f"{YELLOW}if:{RESET} {cond}")
            if when:
                parts.append(f"{MAGENTA}when:{RESET} {when}")
            if vars_override:
                parts.append(f"{CYAN}vars:{RESET} {list(vars_override.keys())}")
            out.append(" | ".join(parts) if parts else str(r))
        else:
            out.append(str(r))
    return "\n            ".join(out)


def print_pipeline_summary(resolver):
    print(f"\n{BOLD}{CYAN}==============================================================={RESET}")
    print(f"{BOLD}{CYAN}           GITLAB CI LOCAL PIPELINE PREVIEW                    {RESET}")
    print(f"{BOLD}{CYAN}==============================================================={RESET}")
    print(f"{BOLD}Entry File:{RESET} {resolver.entry_file}")
    print(f"{BOLD}Total Included Files:{RESET} {len([f for f in resolver.file_trace if f['status'] == 'OK'])}")
    print(f"{BOLD}Total Templates:{RESET} {len(resolver.templates)}")
    print(f"{BOLD}Total Concrete Jobs:{RESET} {len(resolver.jobs)}")
    print(f"{BOLD}Defined Stages:{RESET} {', '.join([f'{GREEN}{s}{RESET}' for s in resolver.stages])}")

    print(f"\n{BOLD}{MAGENTA}--- 1. FILE INCLUSION TRACE & SOURCE MAP ---{RESET}")
    for idx, f in enumerate(resolver.file_trace, 1):
        status_color = GREEN if f["status"] == "OK" else RED
        print(f"  {DIM}[{idx}]{RESET} {BOLD}{f['display_name']}{RESET} [{status_color}{f['status']}{RESET}]")
        print(f"      {DIM}Path:{RESET} {f['path']}")
        if f["jobs_defined"]:
            jobs_str = ", ".join([f"{CYAN}{j['name'] if isinstance(j, dict) else j}{RESET}" for j in f["jobs_defined"]])
            print(f"      {GREEN}↳ Provides Jobs:{RESET} {jobs_str}")
        if f["templates_defined"]:
            tmpl_str = ", ".join([f"{YELLOW}{t['name'] if isinstance(t, dict) else t}{RESET}" for t in f["templates_defined"]])
            print(f"      {YELLOW}↳ Provides Templates:{RESET} {tmpl_str}")

    print(f"\n{BOLD}{MAGENTA}--- 2. STAGES & JOBS PIPELINE MAP ---{RESET}")
    stages_to_jobs = {s: [] for s in resolver.stages}
    unknown_stage_jobs = []

    for job_name, job_info in resolver.jobs.items():
        st = job_info.get("stage", "test")
        if st in stages_to_jobs:
            stages_to_jobs[st].append(job_info)
        else:
            unknown_stage_jobs.append(job_info)

    for stage_name, stage_jobs in stages_to_jobs.items():
        if not stage_jobs:
            continue
        print(f"\n  {BOLD}{GREEN}Stage: [{stage_name.upper()}]{RESET}")
        for job in stage_jobs:
            extends_str = f" (extends {YELLOW}{job['extends']}{RESET})" if job["extends"] else ""
            tags_str = f" [{BLUE}tags: {', '.join(job['tags'])}{RESET}]" if job["tags"] else ""
            when_str = f" [{MAGENTA}when: {job['when']}{RESET}]" if job["when"] else ""

            print(f"    ▶ {BOLD}{CYAN}{job['job_name']}{RESET}{extends_str}{tags_str}{when_str}")
            print(f"      {DIM}Source File :{RESET} {job['source_file']}:{job['line_number']}")

            if job["variables"]:
                var_keys = ", ".join([f"{k}={v}" if not str(v).startswith("$") else f"{k}={YELLOW}{v}{RESET}" for k, v in job["variables"].items()])
                print(f"      {DIM}Variables   :{RESET} {var_keys}")

            if job["rules"]:
                print(f"      {DIM}Rules       :{RESET} {format_rules(job['rules'])}")

            if job["script"]:
                script_preview = job["script"]
                if isinstance(script_preview, list):
                    first_cmds = "; ".join([str(c).strip().replace(chr(10), " ") for c in script_preview[:2]])
                    if len(script_preview) > 2:
                        first_cmds += f" ... (+{len(script_preview)-2} more commands)"
                else:
                    first_cmds = str(script_preview)[:80]
                print(f"      {DIM}Script      :{RESET} {first_cmds}")

    if unknown_stage_jobs:
        print(f"\n  {BOLD}{YELLOW}Stage: [OTHER / UNLISTED]{RESET}")
        for job in unknown_stage_jobs:
            print(f"    ▶ {BOLD}{YELLOW}{job['job_name']}{RESET} [{job.get('stage')}] ({job['source_file']}:{job['line_number']})")
    print(f"\n{BOLD}{CYAN}==============================================================={RESET}\n")


def print_job_detail(resolver, target_job_name):
    job = resolver.jobs.get(target_job_name)
    if not job:
        print(f"{RED}Job '{target_job_name}' not found!{RESET}")
        print(f"Available jobs: {', '.join(resolver.jobs.keys())}")
        return

    print(f"\n{BOLD}{CYAN}=== JOB DETAIL: {target_job_name} ==={RESET}")
    print(f"{BOLD}Stage:{RESET} {job['stage']}")
    print(f"{BOLD}Source File:{RESET} {job['source_file']}:{job['line_number']}")
    print(f"{BOLD}Extends:{RESET} {job['extends']}")
    print(f"{BOLD}Tags:{RESET} {job['tags']}")
    print(f"{BOLD}When:{RESET} {job['when']}")

    if job.get("extends_info"):
        for ext in job["extends_info"]:
            print(f"\n{BOLD}{YELLOW}--- Inherited Template ({ext['name']}) from {ext['source_file']}:{ext['line_number']} ---{RESET}")
            print(yaml.dump({ext["name"]: ext["definition"]}, sort_keys=False, default_flow_style=False))

    print(f"\n{BOLD}{GREEN}--- Full Raw Definition ---{RESET}")
    print(yaml.dump({target_job_name: job["definition"]}, sort_keys=False, default_flow_style=False))


def read_scenario(args):
    """Build a simulation Scenario dict from CLI args.

    Base scenario has three keys: variables (dict), changed_files (list),
    exists_files (list). If --scenario-json is provided, it is parsed (from
    stdin when '-', else from a file path) and used as the base (merged onto
    the defaults, ensuring all three keys exist). Then --var/--changed-file/
    --exists-file overlay onto that base: --var overwrites variables[KEY],
    --changed-file/--exists-file extend their respective lists.
    """
    scenario = {"variables": {}, "changed_files": [], "exists_files": []}

    if args.scenario_json:
        if args.scenario_json == "-":
            raw = sys.stdin.read()
        else:
            with open(args.scenario_json, "r", encoding="utf-8") as f:
                raw = f.read()
        base = json.loads(raw)
        if isinstance(base, dict):
            if isinstance(base.get("variables"), dict):
                scenario["variables"].update(base["variables"])
            if isinstance(base.get("changed_files"), list):
                scenario["changed_files"].extend(base["changed_files"])
            if isinstance(base.get("exists_files"), list):
                scenario["exists_files"].extend(base["exists_files"])

    for item in (args.var or []):
        key, sep, value = item.partition("=")
        if sep:
            scenario["variables"][key] = value

    scenario["changed_files"].extend(args.changed_file or [])
    scenario["exists_files"].extend(args.exists_file or [])

    return scenario


def main():
    parser = argparse.ArgumentParser(
        description="GitLab CI Local Preview & Offline Pipeline Inspector"
    )
    parser.add_argument("file", help="Path to .gitlab-ci.yml (or any GitLab CI YAML file)")
    parser.add_argument("-y", "--yaml", action="store_true", help="Print full merged YAML to stdout")
    parser.add_argument("--json", action="store_true", help="Output full pipeline analysis as JSON")
    parser.add_argument("-o", "--output", help="Save merged YAML output to a file")
    parser.add_argument("-j", "--job", help="Inspect a specific job in detail")
    parser.add_argument("-f", "--files", action="store_true", help="Only show list of resolved include files")
    parser.add_argument("--simulate", action="store_true", help="Simulate pipeline rules/only/except for a scenario and output JSON")
    parser.add_argument("--var", action="append", metavar="KEY=VAL", default=[], help="Scenario variable override (repeatable)")
    parser.add_argument("--changed-file", action="append", default=[], help="Scenario changed file (repeatable)")
    parser.add_argument("--exists-file", action="append", default=[], help="Scenario existing file (repeatable)")
    parser.add_argument("--scenario-json", default=None, help="Path to scenario JSON, or '-' to read from stdin")
    parser.add_argument("--dynamic-child", action="append", default=[], metavar="KUNCI=PATH",
                        help="Petakan child pipeline dinamis (nama bridge job / artifact / job generator) "
                             "ke file YAML contoh (repeatable)")
    parser.add_argument("--lang", default=os.environ.get("GITLAB_CI_LOCAL_LANG") or "en",
                        help="Language for JSON messages: en (default) or id")
    parser.add_argument("--config-json", default=None,
                        help="Extra config as JSON: {\"search_roots\": [...], \"project_mappings\": {...}}")

    args = parser.parse_args()
    lang = normalize_lang(args.lang)

    if args.config_json:
        global _CONFIG_OVERRIDE
        try:
            raw = args.config_json
            if raw.startswith("b64:"):
                import base64
                raw = base64.b64decode(raw[4:]).decode("utf-8")
            parsed = json.loads(raw)
            _CONFIG_OVERRIDE = parsed if isinstance(parsed, dict) else None
        except ValueError as exc:
            sys.stderr.write("Invalid --config-json: %s\n" % exc)

    if not os.path.exists(args.file):
        print(f"{RED}Error: File '{args.file}' does not exist!{RESET}")
        sys.exit(1)

    resolver = CIResolver(
        args.file, dynamic_overrides=parse_dynamic_overrides(args.dynamic_child)
    ).resolve()

    if args.job:
        print_job_detail(resolver, args.job)
        return

    if args.simulate:
        scenario = read_scenario(args)
        result = translate_payload(SimulationRunner.run(resolver, scenario), lang)
        print(json.dumps(result, indent=2, default=str))
        return

    if args.json:
        result_payload = {
            "entry_file": str(resolver.entry_file),
            "stages": resolver.stages,
            "jobs": resolver.jobs,
            "templates": resolver.templates,
            "file_trace": resolver.file_trace,
            "deep_graph": resolver.get_deep_graph(),
            "child_pipelines": resolver.child_pipelines,
            "diagnostics": resolver.get_diagnostics(),
            "merged_yaml": yaml.dump(resolver.resolved_yaml, sort_keys=False, default_flow_style=False),
        }
        translate_payload(result_payload, lang)
        print(json.dumps(result_payload, indent=2, default=str))
        return

    if args.files:
        print(f"\n{BOLD}Resolved Include Files for {args.file}:{RESET}\n")
        for f in resolver.file_trace:
            status = f"{GREEN}OK{RESET}" if f["status"] == "OK" else f"{RED}{f['status']}{RESET}"
            print(f"  • {BOLD}{f['display_name']}{RESET} -> {f['path']} [{status}]")
        print()
        return

    if args.output:
        with open(args.output, "w", encoding="utf-8") as out:
            yaml.dump(resolver.resolved_yaml, out, sort_keys=False, default_flow_style=False)
        print(f"{GREEN}Successfully exported merged YAML to: {args.output}{RESET}")
        return

    if args.yaml:
        print(yaml.dump(resolver.resolved_yaml, sort_keys=False, default_flow_style=False))
        return

    print_pipeline_summary(resolver)


if __name__ == "__main__":
    main()

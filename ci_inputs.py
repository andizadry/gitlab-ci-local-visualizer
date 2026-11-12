#!/usr/bin/env python3
"""CI/CD inputs secara offline: header ``spec``, validasi, dan interpolasi ``$[[ ... ]]``.

Mengikuti perilaku GitLab CI/CD inputs:
  * ``spec:inputs`` dideklarasikan di dokumen pertama (dipisah ``---``).
  * Tipe: string, number, boolean, array. Opsi: default, options, regex, description.
  * Input tanpa ``default`` wajib diisi.
  * Interpolasi ``$[[ inputs.nama | fungsi | ... ]]`` (maks 3 fungsi): expand_vars,
    truncate(offset,length), posix_escape, split(sep), default(fallback).
  * Bila seluruh nilai string hanyalah satu blok interpolasi, tipe asli input dipertahankan
    (array/number/boolean); bila bercampur teks, hasilnya dijadikan teks.

Modul ini murni (tanpa I/O) sehingga mudah diuji.
"""

import json
import re

_BLOCK = re.compile(r"\$\[\[\s*(.*?)\s*\]\]", re.S)
_VAR_REF = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_FUNC = re.compile(r"^([a-z_]+)\s*(?:\((.*)\))?$", re.S)

MAX_FUNCTIONS = 3
INPUT_TYPES = ("string", "number", "boolean", "array")


# ---------------------------------------------------------------------------
# Header spec
# ---------------------------------------------------------------------------
def split_spec(docs):
    """Pisahkan header ``spec`` dari isi konfigurasi.

    ``docs`` adalah list dokumen YAML hasil ``yaml.load_all``. Mengembalikan
    ``(spec, body)`` dengan ``spec`` berupa dict (atau None bila tak ada header).
    """
    docs = list(docs or [])
    if not docs:
        return None, {}
    first = docs[0]
    if len(docs) >= 2 and isinstance(first, dict) and "spec" in first:
        spec = first.get("spec")
        body = docs[1]
        if body is None:
            body = {}
        return (spec if isinstance(spec, dict) else {}), body
    if len(docs) == 1 and isinstance(first, dict) and set(first.keys()) == {"spec"}:
        spec = first.get("spec")
        return (spec if isinstance(spec, dict) else {}), {}
    return None, (first if first is not None else {})


def declared_inputs(spec):
    """Kembalikan metadata input yang dideklarasikan: ``{nama: {...}}``."""
    out = {}
    inputs = (spec or {}).get("inputs") if isinstance(spec, dict) else None
    if not isinstance(inputs, dict):
        return out
    for name, meta in inputs.items():
        meta = meta if isinstance(meta, dict) else {}
        out[str(name)] = {
            "type": meta.get("type", "string"),
            "has_default": "default" in meta,
            "default": meta.get("default"),
            "options": meta.get("options"),
            "regex": meta.get("regex"),
            "description": meta.get("description"),
        }
    return out


def _type_ok(value, typ):
    if typ == "string":
        return isinstance(value, str)
    if typ == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if typ == "boolean":
        return isinstance(value, bool)
    if typ == "array":
        return isinstance(value, list)
    return True


def _check_value(name, value, meta):
    typ = meta.get("type", "string")
    if typ not in INPUT_TYPES:
        return "Input '%s' memakai tipe tidak dikenal '%s'." % (name, typ)
    if value is not None and not _type_ok(value, typ):
        return "Input '%s' harus bertipe %s, nilai diberikan: %r." % (name, typ, value)
    options = meta.get("options")
    if isinstance(options, list) and options and value not in options:
        return "Input '%s' = %r tidak termasuk options %s." % (name, value, options)
    rx = meta.get("regex")
    if rx and isinstance(value, str):
        try:
            if not re.search(rx, value):
                return "Input '%s' = %r tidak cocok regex %s." % (name, value, rx)
        except re.error:
            return "Input '%s' memiliki regex tidak valid: %s." % (name, rx)
    return None


def resolve_inputs(spec, provided):
    """Gabungkan nilai yang diberikan dengan default lalu validasi.

    Mengembalikan ``(values, problems)``; ``problems`` adalah list ``(kode, pesan)``.
    Input wajib yang tidak diisi tidak dimasukkan ke ``values``.
    """
    decl = declared_inputs(spec)
    provided = provided if isinstance(provided, dict) else {}
    values, problems = {}, []
    for name in provided:
        if name not in decl:
            problems.append(("unknown-input", "Input '%s' tidak dideklarasikan di spec:inputs." % name))
    for name, meta in decl.items():
        if name in provided:
            value = provided[name]
        elif meta["has_default"]:
            value = meta["default"]
        else:
            problems.append(("input-required", "Input '%s' wajib diisi (tidak punya default)." % name))
            continue
        err = _check_value(name, value, meta)
        if err:
            problems.append(("input-invalid", err))
        values[name] = value
    return values, problems


# ---------------------------------------------------------------------------
# Interpolasi
# ---------------------------------------------------------------------------
def to_text(value):
    """Representasi teks sebuah nilai input untuk interpolasi di tengah string."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def has_interpolation(obj):
    """True bila ada blok ``$[[ ... ]]`` di dalam struktur."""
    if isinstance(obj, str):
        return "$[[" in obj
    if isinstance(obj, list):
        return any(has_interpolation(x) for x in obj)
    if isinstance(obj, dict):
        return any(has_interpolation(k) or has_interpolation(v) for k, v in obj.items())
    return False


def expand_variables(text, env):
    """Ekspansi ``$VAR`` / ``${VAR}`` satu level memakai ``env``; yang tak dikenal dibiarkan."""
    if not isinstance(text, str) or "$" not in text:
        return text

    def repl(m):
        key = m.group(1) or m.group(2)
        if key in env and env[key] is not None:
            return str(env[key])
        return m.group(0)

    return _VAR_REF.sub(repl, text)


def _unquote(arg):
    arg = arg.strip()
    if len(arg) >= 2 and arg[0] == arg[-1] and arg[0] in ("'", '"'):
        return arg[1:-1]
    return arg


def _lookup(ref, values, component):
    ref = ref.strip()
    for prefix in ("inputs.", "input."):
        if ref.startswith(prefix):
            name = ref[len(prefix):]
            return (name in values), values.get(name), name
    if ref.startswith("component."):
        field = ref[len("component."):]
        ctx = component or {}
        return (field in ctx), ctx.get(field), field
    return False, None, ref


def _apply_function(expr, value, values, component):
    m = _FUNC.match(expr.strip())
    if not m:
        return value, "Fungsi interpolasi tidak valid: '%s'." % expr
    name, argstr = m.group(1), m.group(2)
    args = [a for a in (argstr or "").split(",")] if argstr is not None else []
    if name == "expand_vars":
        # Variabel pipeline tidak diketahui saat offline; biarkan literal (perilaku GitLab
        # bila variabel tak ditemukan).
        return value, None
    if name == "truncate":
        if not isinstance(value, str):
            return value, "truncate hanya untuk string."
        try:
            offset, length = int(args[0].strip()), int(args[1].strip())
        except (IndexError, ValueError):
            return value, "truncate(offset,length) butuh dua bilangan bulat."
        return value[offset:offset + length], None
    if name == "posix_escape":
        if not isinstance(value, str):
            return value, "posix_escape hanya untuk string."
        return re.sub(r"([^A-Za-z0-9_\-.,:/@\n])", r"\\\1", value), None
    if name == "split":
        if not isinstance(value, str):
            return value, "split hanya untuk string."
        sep = _unquote(argstr or "")
        if sep == "":
            return value, "split('<pemisah>') butuh pemisah."
        parts = [p.strip() for p in value.split(sep)]
        return [p for p in parts if p], None
    if name == "default":
        if value is None or value == "":
            fallback = (argstr or "").strip()
            if fallback.startswith(("inputs.", "input.", "component.")):
                found, fv, _n = _lookup(fallback, values, component)
                return (fv if found else None), None
            return _unquote(fallback), None
        return value, None
    return value, "Fungsi interpolasi tidak dikenal: '%s'." % name


def _eval_block(expr, values, component, problems):
    parts = [p.strip() for p in expr.split("|")]
    head, funcs = parts[0], parts[1:]
    if len(funcs) > MAX_FUNCTIONS:
        problems.append(("interp-too-many-functions",
                         "Maksimal %d fungsi per blok interpolasi: %s" % (MAX_FUNCTIONS, expr)))
        return False, None
    found, value, name = _lookup(head, values, component)
    if not found:
        if head.startswith("component."):
            problems.append(("component-context",
                             "Konteks komponen '%s' tidak tersedia offline." % name))
        elif head.startswith(("inputs.", "input.")):
            problems.append(("input-undeclared",
                             "Input '%s' dirujuk tetapi tidak dideklarasikan atau tidak punya nilai." % name))
        else:
            problems.append(("interp-unknown", "Ekspresi interpolasi tidak dikenal: %s" % head))
        return False, None
    for fn in funcs:
        value, err = _apply_function(fn, value, values, component)
        if err:
            problems.append(("interp-function", err))
            return False, None
    return True, value


def _interp_string(text, values, component, problems):
    if "$[[" not in text:
        return text
    stripped = text.strip()
    m = _BLOCK.fullmatch(stripped)
    if m:
        ok, value = _eval_block(m.group(1), values, component, problems)
        return value if ok else text

    def repl(match):
        ok, value = _eval_block(match.group(1), values, component, problems)
        return to_text(value) if ok else match.group(0)

    return _BLOCK.sub(repl, text)


def interpolate(obj, values, component=None):
    """Interpolasi seluruh string (nilai dan kunci) di ``obj``.

    Mengembalikan ``(objek_baru, problems)``; objek asli tidak dimutasi.
    """
    problems = []

    def walk(o):
        if isinstance(o, str):
            return _interp_string(o, values or {}, component, problems)
        if isinstance(o, list):
            return [walk(x) for x in o]
        if isinstance(o, dict):
            out = {}
            for k, v in o.items():
                nk = k
                if isinstance(k, str):
                    nk = walk(k)
                    if not isinstance(nk, str):
                        nk = to_text(nk)
                out[nk] = walk(v)
            return out
        return o

    return walk(obj), problems

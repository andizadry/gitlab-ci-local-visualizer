"""i18n engine: pesan Indonesia (sumber) diterjemahkan ke Inggris di batas keluaran JSON."""
import json
import re
from pathlib import Path

import ci_preview
from ci_i18n import CATALOG, translate_payload, translate_text, normalize_lang

from conftest import simulate

ENGINE_DIR = Path(__file__).resolve().parents[2]
ENGINE_SOURCES = ["ci_preview.py", "ci_keywords.py", "ci_inputs.py", "rules_evaluator.py"]

# Kata penanda bahasa Indonesia yang tidak boleh muncul pada keluaran 'en'.
ID_MARKERS = re.compile(
    r"\b(tidak|tak|belum|sudah|harus|dengan|untuk|yang|tanpa|dari|memakai|ditemukan|diresolve|"
    r"berjalan|jalan|dibuat|diblok|terpicu|sebagian|dinamis|contoh|wajib|bertipe|hanya|butuh|"
    r"usang|pindahkan|dikenal|sebaiknya|bersamaan|maksimum|diasumsikan|diabaikan|gagal)\b",
    re.I,
)

TEXT_KEYS = {"message", "reason", "status", "status_detail", "hint", "problems"}


def _texts(obj, out=None):
    out = [] if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("definition", "resolved_definition", "variables", "merged_yaml", "script", "rules"):
                continue
            if k in TEXT_KEYS:
                for s in (v if isinstance(v, list) else [v]):
                    if isinstance(s, str):
                        out.append(s)
            else:
                _texts(v, out)
    elif isinstance(obj, list):
        for item in obj:
            _texts(item, out)
    return out


def test_catalog_templates_exist_in_engine_source():
    source = "\n".join((ENGINE_DIR / f).read_text(encoding="utf-8") for f in ENGINE_SOURCES)
    # Gabungkan literal string yang disambung lintas baris ("abc "\n    "def").
    source = re.sub(r"([\"'])\s*\n\s*[fr]?([\"'])", "", source)
    missing = []
    for src, _dst in CATALOG:
        pieces = [p for p in re.split(r"%[sdr]", src) if len(p.strip()) >= 6]
        if not pieces:
            continue
        longest = max(pieces, key=len)
        if longest not in source:
            missing.append(src)
    assert not missing, "template katalog tidak ditemukan di source engine: %r" % missing


def test_catalog_placeholders_match():
    for src, dst in CATALOG:
        assert re.findall(r"%[sdr]", src) == re.findall(r"%[sdr]", dst), src


def test_translate_text_nested_and_passthrough():
    text = "bridge job 'deploy' tidak berjalan (NEVER): tidak ada rule yang match"
    assert translate_text(text, "en") == "bridge job 'deploy' does not run (NEVER): no rule matched"
    assert translate_text(text, "id") == text
    # Teks yang tidak dikenal (mis. sudah Inggris) dibiarkan.
    assert translate_text("rule[0] if: $X == \"1\" (when: on_success)", "en") == 'rule[0] if: $X == "1" (when: on_success)'


def test_normalize_lang():
    assert normalize_lang("id") == "id"
    assert normalize_lang("id-ID") == "id"
    assert normalize_lang("en-US") == "en"
    assert normalize_lang(None) == "en"
    assert normalize_lang("fr") == "en"


def test_payload_user_data_untouched():
    payload = {
        "jobs": {"a": {"definition": {"script": ["echo tidak ada rule yang match"]},
                       "variables": {"MSG": "tidak ada rule yang match"}}},
        "diagnostics": [{"message": "Job 'a' needs 'b' yang tidak ditemukan."}],
    }
    translate_payload(payload, "en")
    assert payload["jobs"]["a"]["definition"]["script"] == ["echo tidak ada rule yang match"]
    assert payload["jobs"]["a"]["variables"]["MSG"] == "tidak ada rule yang match"
    assert payload["diagnostics"][0]["message"] == "Job 'a' needs 'b', which was not found."


BROKEN_CI = """
stages: [build, test]
before_script: [echo hi]
workflow:
  rules:
    - if: $CI_COMMIT_BRANCH == "never-matches"
include:
  - local: missing/file.yml
  - remote: https://example.com/ci.yml
  - template: Auto-DevOps.gitlab-ci.yml
build:
  stage: nostage
  script: [make]
  needs: [ghost, {job: opt, optional: true}]
  extends: .nothere
  retry: 5
  when: sometimes
  scirpt: typo
unit:
  stage: test
  rules:
    - if: $X
      when: bogus
  only: [main]
  script: [test]
noscript:
  stage: build
child:
  stage: test
  trigger:
    include: child/missing.yml
dynamic:
  stage: test
  trigger:
    include:
      - artifact: generated.yml
        job: gen
gen:
  stage: build
  script: [gen]
"""


def test_engine_messages_are_english(repo):
    repo.write(".gitlab-ci.yml", BROKEN_CI)
    resolver = repo.resolve()
    payload = {
        "file_trace": resolver.file_trace,
        "child_pipelines": resolver.child_pipelines,
        "diagnostics": resolver.get_diagnostics(),
        "deep_graph": resolver.get_deep_graph(),
    }
    sim = simulate(resolver, {"CI_COMMIT_BRANCH": "main"})
    texts_id = _texts(json.loads(json.dumps(payload, default=str))) + _texts(sim)
    assert any(ID_MARKERS.search(t) for t in texts_id), "fixture harus memicu pesan berbahasa Indonesia"

    translate_payload(payload, "en")
    translate_payload(sim, "en")
    leaked = [t for t in _texts(payload) + _texts(sim) if ID_MARKERS.search(t)]
    assert not leaked, "teks Indonesia lolos pada mode en: %r" % leaked


def test_simulation_reasons_are_english(repo):
    repo.write(".gitlab-ci.yml", """
        a:
          script: [x]
          rules:
            - if: $NOPE
        b:
          script: [x]
          only: [tags]
        c:
          script: [x]
          trigger:
            include: child.yml
          rules:
            - if: $NOPE
    """)
    repo.write("child.yml", """
        cj:
          script: [x]
    """)
    sim = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    translate_payload(sim, "en")
    leaked = [t for t in _texts(sim) if ID_MARKERS.search(t)]
    assert not leaked, leaked


def test_load_config_merges_user_file_and_override(tmp_path, monkeypatch):
    user_cfg = tmp_path / "user.json"
    user_cfg.write_text(json.dumps({"search_roots": ["/u/root"], "project_mappings": {"g/p": "/u/p"}}))
    monkeypatch.setenv("GITLAB_CI_LOCAL_CONFIG", str(user_cfg))
    monkeypatch.setattr(ci_preview, "_CONFIG_OVERRIDE",
                        {"search_roots": ["/cli/root"], "project_mappings": {"g/p": "/cli/p", "g/q": "/cli/q"}})
    cfg = ci_preview.load_config()
    assert cfg["search_roots"].index("/cli/root") < cfg["search_roots"].index("/u/root")
    assert cfg["project_mappings"]["g/p"] == "/cli/p"
    assert cfg["project_mappings"]["g/q"] == "/cli/q"

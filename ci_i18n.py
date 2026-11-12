#!/usr/bin/env python3
"""Terjemahan pesan engine (Indonesia -> Inggris) di batas keluaran JSON.

Pesan engine ditulis dalam bahasa Indonesia (bahasa sumber). Bila bahasa keluaran ``en``,
:func:`translate_payload` menerjemahkan nilai pada kunci teks (``message``, ``reason``,
``status``, ``status_detail``, ``hint``, ``problems``) memakai katalog template di bawah.

Setiap entri katalog = (template Indonesia, template Inggris) dengan placeholder ``%s``/``%d``/``%r``
dalam urutan yang sama. Template Indonesia diubah menjadi regex; nilai yang ditangkap
diterjemahkan secara rekursif (mis. alasan bersarang) lalu disisipkan ke template Inggris.

Saat menambah pesan baru di engine, tambahkan juga entrinya di CATALOG
(test/unit/test_i18n.py memastikan tidak ada teks Indonesia yang lolos pada mode ``en``).
"""

import re

SUPPORTED = ("en", "id")
SOURCE_LANG = "id"

CATALOG = [
    # ---- ci_preview.py: trigger / child pipeline ----
    ("trigger harus berupa string (project) atau mapping.",
     "trigger must be a string (project) or a mapping."),
    ("trigger:strategy '%s' tidak valid (depend/mirror).",
     "trigger:strategy '%s' is invalid (depend/mirror)."),
    ("trigger:include kosong.", "trigger:include is empty."),
    ("trigger butuh 'include' (child) atau 'project' (multi-project).",
     "trigger needs 'include' (child) or 'project' (multi-project)."),
    ("trigger tidak valid", "invalid trigger"),
    ("Child pipeline melebihi kedalaman maksimum GitLab (%d level child).",
     "Child pipeline exceeds GitLab's maximum depth (%d child levels)."),
    ("Nama project memakai variabel; tidak bisa diresolve offline.",
     "Project name uses a variable; it cannot be resolved offline."),
    ("Child pipeline merujuk file yang sudah menjadi induknya (siklus).",
     "Child pipeline references a file that is already one of its parents (cycle)."),
    ("Sebagian include child belum bisa diresolve.",
     "Some child includes could not be resolved."),
    ("Memakai file contoh: %s (sumber: %s).", "Using sample file: %s (source: %s)."),
    ("Konfigurasi child tidak ditemukan offline: %s", "Child configuration not found offline: %s"),
    ("Child ini di-generate saat runtime oleh job '%s'. Letakkan hasil generate contoh di '%s' atau '%s', "
     "atau petakan lewat setting gitlabCiLocal.dynamicChildren / config.json dynamic_children.",
     "This child is generated at runtime by job '%s'. Place a sample of the generated file at '%s' or '%s', "
     "or map it via the gitlabCiLocal.dynamicChildren setting / config.json dynamic_children."),
    # ---- ci_preview.py: include status ----
    ("COULD NOT RESOLVE LOCAL PATH (variabel tidak diketahui offline: %s)",
     "COULD NOT RESOLVE LOCAL PATH (variables unknown offline: %s)"),
    ("EXTERNAL COMPONENT (tidak diresolve offline)", "EXTERNAL COMPONENT (not resolved offline)"),
    ("EXTERNAL REMOTE (tidak diresolve offline)", "EXTERNAL REMOTE (not resolved offline)"),
    ("EXTERNAL TEMPLATE (template bawaan GitLab tidak tersedia offline)",
     "EXTERNAL TEMPLATE (built-in GitLab templates are not available offline)"),
    # ---- ci_preview.py: struktur ----
    ("extends melingkar: %s", "circular extends: %s"),
    ("!reference [%s] tidak ditemukan.", "!reference [%s] not found."),
    # ---- ci_preview.py: diagnostics ----
    ("Job '%s' memakai stage '%s' yang tidak terdaftar di stages.",
     "Job '%s' uses stage '%s', which is not listed in stages."),
    ("Job '%s' needs opsional '%s' tidak ada (diabaikan).",
     "Job '%s' optional need '%s' does not exist (ignored)."),
    ("Job '%s' needs '%s' yang tidak ditemukan.", "Job '%s' needs '%s', which was not found."),
    ("Job '%s' extends '%s' yang tidak ditemukan.", "Job '%s' extends '%s', which was not found."),
    ("Include component eksternal (tidak diresolve offline): %s",
     "External component include (not resolved offline): %s"),
    ("Include remote (tidak diresolve offline): %s", "Remote include (not resolved offline): %s"),
    ("Include template bawaan GitLab (tidak tersedia offline): %s",
     "Built-in GitLab template include (not available offline): %s"),
    ("Include tidak terselesaikan: %s (%s)", "Unresolved include: %s (%s)"),
    ("Circular needs: %s", "Circular needs: %s"),
    ("CI_PROJECT_PATH diasumsikan '%s' (file template dibuka langsung; di GitLab nilainya berasal dari "
     "project yang meng-include file ini).",
     "CI_PROJECT_PATH assumed to be '%s' (template file opened directly; in GitLab the value comes from "
     "the project that includes this file)."),
    ("Job '%s' (stage %s) needs '%s' yang berada di stage lebih akhir (%s).",
     "Job '%s' (stage %s) needs '%s', which is in a later stage (%s)."),
    ("Child dinamis dari '%s' belum punya file contoh (placeholder).",
     "Dynamic child from '%s' has no sample file yet (placeholder)."),
    ("Child dinamis '%s' disimulasikan memakai file contoh.",
     "Dynamic child '%s' is simulated using a sample file."),
    ("Child/downstream '%s' tidak bisa diresolve offline: %s",
     "Child/downstream '%s' cannot be resolved offline: %s"),
    ("Child '%s' hanya sebagian ter-resolve.", "Child '%s' is only partially resolved."),
    # ---- ci_keywords.py ----
    ("Keyword global '%s' sudah usang; pindahkan ke 'default:'.",
     "Global keyword '%s' is deprecated; move it under 'default:'."),
    ("Keyword global tidak dikenal '%s'.", "Unknown global keyword '%s'."),
    (" Maksud Anda '%s'?", " Did you mean '%s'?"),
    ("workflow memakai keyword tidak dikenal '%s'.", "workflow uses unknown keyword '%s'."),
    ("default tidak mendukung keyword '%s'.", "default does not support keyword '%s'."),
    ("Job '%s' memakai keyword tidak dikenal '%s'.", "Job '%s' uses unknown keyword '%s'."),
    ("Trigger job '%s' tidak boleh memakai keyword '%s'.", "Trigger job '%s' must not use keyword '%s'."),
    ("Trigger job '%s' tidak mendukung needs:project.", "Trigger job '%s' does not support needs:project."),
    ("Trigger job '%s' hanya mendukung when: on_success/on_failure/always/manual.",
     "Trigger job '%s' only supports when: on_success/on_failure/always/manual."),
    ("trigger pada '%s' memakai keyword tidak dikenal '%s'.", "trigger in '%s' uses unknown keyword '%s'."),
    ("Job '%s' tidak punya 'script' (atau 'run'/'trigger').", "Job '%s' has no 'script' (or 'run'/'trigger')."),
    ("Job '%s' memakai when tidak valid: '%s'.", "Job '%s' uses an invalid when: '%s'."),
    ("Job '%s': when: never hanya boleh di dalam rules/workflow:rules.",
     "Job '%s': when: never is only allowed inside rules/workflow:rules."),
    ("Job '%s' when: delayed sebaiknya punya start_in.", "Job '%s' with when: delayed should have start_in."),
    ("Job '%s' memakai start_in tanpa when: delayed.", "Job '%s' uses start_in without when: delayed."),
    ("Job '%s': rules harus berupa list.", "Job '%s': rules must be a list."),
    ("Job '%s': rules[%d] harus berupa mapping.", "Job '%s': rules[%d] must be a mapping."),
    ("Job '%s': rules[%d] memakai keyword tidak dikenal '%s'.", "Job '%s': rules[%d] uses unknown keyword '%s'."),
    ("Job '%s': rules[%d] when tidak valid: '%s'.", "Job '%s': rules[%d] has an invalid when: '%s'."),
    ("Job '%s' tidak boleh memakai rules bersamaan dengan only/except.",
     "Job '%s' must not use rules together with only/except."),
    ("Job '%s': script harus string atau list.", "Job '%s': script must be a string or a list."),
    ("Job '%s': stage harus berupa string.", "Job '%s': stage must be a string."),
    ("Job '%s': retry maksimum GitLab adalah 2.", "Job '%s': GitLab's maximum retry is 2."),
    ("Job '%s': parallel harus antara 2 dan %d.", "Job '%s': parallel must be between 2 and %d."),
    ("Job '%s': parallel hash butuh key 'matrix'.", "Job '%s': a parallel hash needs a 'matrix' key."),
    # ---- ci_inputs.py ----
    ("Input '%s' memakai tipe tidak dikenal '%s'.", "Input '%s' uses unknown type '%s'."),
    ("Input '%s' harus bertipe %s, nilai diberikan: %r.", "Input '%s' must be of type %s, got: %r."),
    ("Input '%s' = %r tidak termasuk options %s.", "Input '%s' = %r is not one of the options %s."),
    ("Input '%s' = %r tidak cocok regex %s.", "Input '%s' = %r does not match regex %s."),
    ("Input '%s' memiliki regex tidak valid: %s.", "Input '%s' has an invalid regex: %s."),
    ("Input '%s' tidak dideklarasikan di spec:inputs.", "Input '%s' is not declared in spec:inputs."),
    ("Input '%s' wajib diisi (tidak punya default).", "Input '%s' is required (it has no default)."),
    ("Input '%s' dirujuk tetapi tidak dideklarasikan atau tidak punya nilai.",
     "Input '%s' is referenced but not declared or has no value."),
    ("Fungsi interpolasi tidak valid: '%s'.", "Invalid interpolation function: '%s'."),
    ("Fungsi interpolasi tidak dikenal: '%s'.", "Unknown interpolation function: '%s'."),
    ("truncate hanya untuk string.", "truncate only works on strings."),
    ("truncate(offset,length) butuh dua bilangan bulat.", "truncate(offset,length) needs two integers."),
    ("posix_escape hanya untuk string.", "posix_escape only works on strings."),
    ("split hanya untuk string.", "split only works on strings."),
    ("split('<pemisah>') butuh pemisah.", "split('<separator>') needs a separator."),
    ("Maksimal %d fungsi per blok interpolasi: %s", "At most %d functions per interpolation block: %s"),
    ("Konteks komponen '%s' tidak tersedia offline.", "Component context '%s' is not available offline."),
    ("Ekspresi interpolasi tidak dikenal: %s", "Unknown interpolation expression: %s"),
    # ---- rules_evaluator.py ----
    ("tidak ada rule yang match", "no rule matched"),
    ("tanpa workflow:rules; pipeline langsung dibuat", "no workflow:rules; pipeline is created"),
    ("tidak ada workflow rule yang match; pipeline diblok", "no workflow rule matched; pipeline is blocked"),
    ("legacy only/except: job jalan (when: %s)", "legacy only/except: job runs (when: %s)"),
    ("legacy only/except: job di-skip", "legacy only/except: job is skipped"),
    ("pipeline induk diblok oleh workflow:rules", "parent pipeline is blocked by workflow:rules"),
    ("pipeline diblok oleh workflow:rules", "pipeline is blocked by workflow:rules"),
    ("evaluasi gagal: %s", "evaluation failed: %s"),
    ("file sumber tidak di-include (include:rules tidak terpenuhi): %s",
     "source file is not included (include:rules not satisfied): %s"),
    ("bridge job '%s' tidak berjalan (%s): %s", "bridge job '%s' does not run (%s): %s"),
    ("bridge job berjalan", "bridge job runs"),
    ("bridge job %s: child terpicu setelah dijalankan manual/tertunda",
     "bridge job %s: child is triggered after the manual/delayed job runs"),
    ("child tidak tersedia offline", "child is not available offline"),
]

TEXT_KEYS = frozenset(("message", "reason", "status", "status_detail", "hint", "problems"))
# Data milik pengguna: jangan disentuh.
SKIP_KEYS = frozenset((
    "definition", "resolved_definition", "effective_definition", "variables", "merged_yaml",
    "script", "before_script", "after_script", "rules", "trace", "effective_variables",
    "forwarded_variables", "scenario_variables", "global_variables", "include_spec", "spec",
))

_PLACEHOLDER = re.compile(r"%[sdr]")
_COMPILED = None


def _compile():
    global _COMPILED
    if _COMPILED is not None:
        return _COMPILED
    entries = []
    for src, dst in CATALOG:
        pieces = _PLACEHOLDER.split(src)
        holes = _PLACEHOLDER.findall(src)
        pattern = ""
        for i, piece in enumerate(pieces):
            pattern += re.escape(piece)
            if i < len(holes):
                last = (i == len(holes) - 1) and pieces[i + 1] == ""
                pattern += r"(-?\d+)" if holes[i] == "%d" else ("(.+)" if last else "(.+?)")
        dst_pieces = _PLACEHOLDER.split(dst)
        if len(dst_pieces) != len(pieces):
            raise ValueError("placeholder mismatch in catalog entry: %r" % (src,))
        entries.append((len(src) - 2 * len(holes), re.compile(pattern, re.S), dst_pieces))
    entries.sort(key=lambda e: -e[0])     # template terpanjang dulu
    _COMPILED = [(rx, dst) for _n, rx, dst in entries]
    return _COMPILED


def normalize_lang(lang):
    lang = (lang or "").strip().lower()
    if lang.startswith("id"):
        return "id"
    return "en"


def translate_text(text, lang="en"):
    """Terjemahkan satu teks pesan engine ke ``lang``."""
    if not isinstance(text, str) or not text or normalize_lang(lang) == SOURCE_LANG:
        return text
    for rx, dst in _compile():
        def repl(m, dst=dst):
            out = dst[0]
            for i, group in enumerate(m.groups()):
                out += translate_text(group, lang) + dst[i + 1]
            return out
        text = rx.sub(repl, text)
    return text


def translate_payload(obj, lang="en"):
    """Terjemahkan (in-place) teks pesan di dalam payload JSON engine. Mengembalikan ``obj``."""
    if normalize_lang(lang) == SOURCE_LANG:
        return obj
    _walk(obj, lang)
    return obj


def _walk(obj, lang):
    if isinstance(obj, dict):
        for key, val in list(obj.items()):
            if key in SKIP_KEYS:
                continue
            if key in TEXT_KEYS:
                if isinstance(val, str):
                    obj[key] = translate_text(val, lang)
                    continue
                if isinstance(val, list) and all(isinstance(v, str) for v in val):
                    obj[key] = [translate_text(v, lang) for v in val]
                    continue
            _walk(val, lang)
    elif isinstance(obj, list):
        for item in obj:
            _walk(item, lang)

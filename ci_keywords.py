#!/usr/bin/env python3
"""Daftar keyword GitLab CI/CD dan validasi struktur (offline, tanpa I/O).

Daftar mengacu pada dokumentasi `.gitlab-ci.yml` GitLab terbaru. Validasi sengaja
konservatif: hanya melaporkan hal yang pasti salah atau pasti usang, agar tidak
menghasilkan false positive pada konfigurasi valid.
"""

import difflib

GLOBAL_KEYWORDS = ("default", "include", "stages", "variables", "workflow", "spec")
# Keyword global yang masih berjalan tetapi usang (gunakan `default:` sebagai gantinya).
DEPRECATED_GLOBALS = ("image", "services", "cache", "before_script", "after_script", "types", "type")
RESERVED_TOP_LEVEL = frozenset(GLOBAL_KEYWORDS) | frozenset(DEPRECATED_GLOBALS)

JOB_KEYWORDS = frozenset((
    "after_script", "allow_failure", "artifacts", "before_script", "cache", "coverage",
    "dast_configuration", "dependencies", "description", "environment", "extends", "identity",
    "id_tokens", "image", "inherit", "inputs", "interruptible", "manual_confirmation", "needs",
    "pages", "parallel", "release", "resource_group", "retry", "rules", "run", "script",
    "secrets", "services", "stage", "start_in", "tags", "timeout", "trigger", "variables",
    "when", "hooks",
    # usang tetapi masih valid
    "only", "except",
))

# Keyword yang boleh dipakai pada trigger job (bridge).
TRIGGER_JOB_KEYWORDS = frozenset((
    "allow_failure", "extends", "needs", "only", "except", "parallel", "rules", "stage",
    "trigger", "variables", "when", "resource_group", "environment",
    # praktis dipakai bersama trigger
    "inherit", "description",
))

DEFAULT_KEYWORDS = frozenset((
    "after_script", "artifacts", "before_script", "cache", "hooks", "id_tokens", "image",
    "interruptible", "retry", "services", "tags",
))

WHEN_VALUES = frozenset(("on_success", "on_failure", "always", "manual", "delayed", "never"))
TRIGGER_WHEN_VALUES = frozenset(("on_success", "on_failure", "always", "manual"))
RULE_KEYS = frozenset((
    "if", "changes", "exists", "when", "allow_failure", "variables", "needs", "start_in",
    "interruptible",
))
WORKFLOW_KEYS = frozenset(("name", "rules", "auto_cancel"))
TRIGGER_KEYS = frozenset(("include", "project", "branch", "strategy", "forward", "inputs"))
MAX_PARALLEL = 200


def suggest(word, choices):
    """Saran ejaan terdekat atau None."""
    matches = difflib.get_close_matches(str(word), sorted(choices), n=1, cutoff=0.75)
    return matches[0] if matches else None


def _diag(severity, code, message):
    return {"severity": severity, "code": code, "message": message}


def validate_top_level(doc):
    """Validasi kunci level atas pada satu dokumen konfigurasi."""
    out = []
    if not isinstance(doc, dict):
        return out
    for key, val in doc.items():
        if not isinstance(key, str):
            continue
        if key in DEPRECATED_GLOBALS:
            out.append((key, _diag(
                "info", "deprecated-global",
                "Keyword global '%s' sudah usang; pindahkan ke 'default:'." % key)))
            continue
        if key in GLOBAL_KEYWORDS or key.startswith("."):
            continue
        if not isinstance(val, dict):
            hint = suggest(key, GLOBAL_KEYWORDS)
            msg = "Keyword global tidak dikenal '%s'." % key
            if hint:
                msg += " Maksud Anda '%s'?" % hint
            out.append((key, _diag("error", "unknown-global-keyword", msg)))
    wf = doc.get("workflow")
    if isinstance(wf, dict):
        for k in wf:
            if k not in WORKFLOW_KEYS:
                hint = suggest(k, WORKFLOW_KEYS)
                out.append(("workflow", _diag(
                    "warning", "unknown-workflow-keyword",
                    "workflow memakai keyword tidak dikenal '%s'.%s" % (k, " Maksud Anda '%s'?" % hint if hint else ""))))
    dflt = doc.get("default")
    if isinstance(dflt, dict):
        for k in dflt:
            if k not in DEFAULT_KEYWORDS:
                out.append(("default", _diag(
                    "warning", "unsupported-default-keyword",
                    "default tidak mendukung keyword '%s'." % k)))
    return out


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def validate_job(name, raw_def, effective, stage_names=None):
    """Validasi satu job. ``raw_def`` = definisi tertulis, ``effective`` = setelah extends."""
    out = []
    raw = raw_def if isinstance(raw_def, dict) else {}
    eff = effective if isinstance(effective, dict) else raw

    for key in raw:
        if isinstance(key, str) and key not in JOB_KEYWORDS:
            hint = suggest(key, JOB_KEYWORDS)
            msg = "Job '%s' memakai keyword tidak dikenal '%s'." % (name, key)
            if hint:
                msg += " Maksud Anda '%s'?" % hint
            out.append(_diag("warning", "unknown-keyword", msg))

    is_bridge = "trigger" in eff
    if is_bridge:
        for key in eff:
            if key not in TRIGGER_JOB_KEYWORDS:
                out.append(_diag(
                    "error", "trigger-forbidden-keyword",
                    "Trigger job '%s' tidak boleh memakai keyword '%s'." % (name, key)))
        needs = eff.get("needs")
        if isinstance(needs, list):
            for n in needs:
                if isinstance(n, dict) and n.get("project"):
                    out.append(_diag(
                        "error", "trigger-needs-project",
                        "Trigger job '%s' tidak mendukung needs:project." % name))
        when = eff.get("when")
        if isinstance(when, str) and when not in TRIGGER_WHEN_VALUES and "rules" not in eff:
            out.append(_diag(
                "warning", "trigger-when",
                "Trigger job '%s' hanya mendukung when: on_success/on_failure/always/manual." % name))
        trig = eff.get("trigger")
        if isinstance(trig, dict):
            for k in trig:
                if k not in TRIGGER_KEYS:
                    out.append(_diag(
                        "warning", "unknown-trigger-keyword",
                        "trigger pada '%s' memakai keyword tidak dikenal '%s'." % (name, k)))
    else:
        if not any(k in eff for k in ("script", "run", "pages", "trigger")):
            out.append(_diag(
                "error", "job-no-script",
                "Job '%s' tidak punya 'script' (atau 'run'/'trigger')." % name))

    when = eff.get("when")
    if isinstance(when, str):
        if when not in WHEN_VALUES:
            out.append(_diag("error", "invalid-when", "Job '%s' memakai when tidak valid: '%s'." % (name, when)))
        elif when == "never":
            out.append(_diag(
                "error", "when-never-job-level",
                "Job '%s': when: never hanya boleh di dalam rules/workflow:rules." % name))
    if when == "delayed" and "start_in" not in eff and "rules" not in eff:
        out.append(_diag("warning", "delayed-no-start-in", "Job '%s' when: delayed sebaiknya punya start_in." % name))
    if "start_in" in eff and when != "delayed" and "rules" not in eff:
        out.append(_diag("error", "start-in-without-delayed", "Job '%s' memakai start_in tanpa when: delayed." % name))

    rules = eff.get("rules")
    if rules is not None:
        if not isinstance(rules, list):
            out.append(_diag("error", "rules-not-list", "Job '%s': rules harus berupa list." % name))
        else:
            for i, r in enumerate(rules):
                if not isinstance(r, dict):
                    out.append(_diag("error", "rule-not-mapping", "Job '%s': rules[%d] harus berupa mapping." % (name, i)))
                    continue
                for k in r:
                    if k not in RULE_KEYS:
                        hint = suggest(k, RULE_KEYS)
                        out.append(_diag(
                            "warning", "unknown-rule-keyword",
                            "Job '%s': rules[%d] memakai keyword tidak dikenal '%s'.%s" % (
                                name, i, k, " Maksud Anda '%s'?" % hint if hint else "")))
                rw = r.get("when")
                if isinstance(rw, str) and rw not in WHEN_VALUES:
                    out.append(_diag("error", "invalid-when", "Job '%s': rules[%d] when tidak valid: '%s'." % (name, i, rw)))
        if "only" in eff or "except" in eff:
            out.append(_diag(
                "error", "rules-with-only-except",
                "Job '%s' tidak boleh memakai rules bersamaan dengan only/except." % name))

    script = eff.get("script")
    if script is not None and not isinstance(script, (str, list)):
        out.append(_diag("error", "script-type", "Job '%s': script harus string atau list." % name))

    stage = eff.get("stage")
    if stage is not None and not isinstance(stage, str):
        out.append(_diag("error", "stage-type", "Job '%s': stage harus berupa string." % name))

    retry = eff.get("retry")
    if retry is not None:
        mx = retry.get("max") if isinstance(retry, dict) else retry
        if _is_int(mx) and mx > 2:
            out.append(_diag("warning", "retry-max", "Job '%s': retry maksimum GitLab adalah 2." % name))

    par = eff.get("parallel")
    if par is not None:
        if _is_int(par):
            if par < 2 or par > MAX_PARALLEL:
                out.append(_diag(
                    "error", "parallel-range",
                    "Job '%s': parallel harus antara 2 dan %d." % (name, MAX_PARALLEL)))
        elif isinstance(par, dict) and "matrix" not in par:
            out.append(_diag("error", "parallel-matrix-missing", "Job '%s': parallel hash butuh key 'matrix'." % name))

    return out

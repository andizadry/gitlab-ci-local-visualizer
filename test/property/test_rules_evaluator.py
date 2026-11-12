"""Property-based tests (Hypothesis) untuk fungsi murni rules_evaluator.py.

Menjalankan:
    cd vscode-extension
    python3 -m pip install hypothesis pytest    # sekali saja
    python3 -m pytest test/property/test_rules_evaluator.py -q

Properti yang diuji:
  1. Round-trip parse/unparse stabil (idempoten pada unparse).
  2. Operator presedensi terjaga: unparse(parse(s)) tetap valid & stabil.
  3. when_to_status total & selalu mengembalikan status valid.
  4. match_paths: kontrak empty & wildcard.
  5. _resolve_rule_when: prioritas rule > job > on_success.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from hypothesis import given, strategies as st, settings, HealthCheck  # noqa: E402

import rules_evaluator as re_mod  # noqa: E402


# --- Strategi ekspresi valid --------------------------------------------------
# Nama variabel identifier sederhana.
var_names = st.from_regex(r"[A-Z][A-Z0-9_]{0,8}", fullmatch=True)
# String literal tanpa karakter yang mengganggu unparse ('"' dan '\\').
str_literals = st.text(
    alphabet=st.characters(blacklist_characters='"\\', min_codepoint=32, max_codepoint=126),
    min_size=0,
    max_size=8,
)


@st.composite
def atom_expr(draw):
    kind = draw(st.integers(min_value=0, max_value=2))
    if kind == 0:
        return "$%s" % draw(var_names)
    if kind == 1:
        return '$%s == "%s"' % (draw(var_names), draw(str_literals))
    return "null"


@st.composite
def bool_expr(draw, depth=0):
    if depth >= 2:
        return draw(atom_expr())
    kind = draw(st.integers(min_value=0, max_value=2))
    if kind == 0:
        return draw(atom_expr())
    op = "&&" if kind == 1 else "||"
    left = draw(bool_expr(depth + 1))
    right = draw(bool_expr(depth + 1))
    return "%s %s %s" % (left, op, right)


@settings(max_examples=200, suppress_health_check=[HealthCheck.too_slow])
@given(bool_expr())
def test_parse_unparse_roundtrip_stable(expr):
    """unparse(parse(x)) harus stabil: menerapkan lagi tak mengubah bentuk kanonik."""
    node = re_mod.parse(expr)
    canon1 = re_mod.unparse(node)
    node2 = re_mod.parse(canon1)
    canon2 = re_mod.unparse(node2)
    assert canon1 == canon2


@settings(max_examples=200)
@given(bool_expr())
def test_unparse_reparseable(expr):
    """Hasil unparse selalu bisa diparse ulang tanpa error."""
    canon = re_mod.unparse(re_mod.parse(expr))
    # Tidak melempar.
    re_mod.parse(canon)


VALID_STATUSES = {"NEVER", "MANUAL", "DELAYED", "RUN"}


@given(st.one_of(
    st.sampled_from(["never", "manual", "delayed", "on_success", "on_failure", "always"]),
    st.text(max_size=10),
    st.none(),
))
def test_when_to_status_total(when):
    status, note = re_mod.when_to_status(when)
    assert status in VALID_STATUSES
    assert isinstance(note, str)


@given(
    st.lists(st.one_of(st.text(max_size=6), st.none()), max_size=5),
    st.lists(st.one_of(st.text(max_size=6), st.none()), max_size=5),
)
def test_match_paths_contract(patterns, files):
    res = re_mod.match_paths(patterns, files)
    assert isinstance(res, bool)
    # Kontrak: tanpa files ATAU tanpa patterns -> selalu False.
    non_none_files = [f for f in files if f is not None]
    non_none_patterns = [p for p in patterns if p is not None]
    if not non_none_files or not non_none_patterns:
        assert res is False


@given(files=st.lists(st.text(min_size=1, max_size=6).filter(lambda s: s.strip() != ""), min_size=1, max_size=4))
def test_match_paths_wildcard_matches_any(files):
    """Pola '*' cocok dengan file apa pun bila daftar file non-kosong."""
    assert re_mod.match_paths(["*"], files) is True


@given(
    rule_when=st.one_of(st.none(), st.just(""), st.sampled_from(["manual", "always", "never"])),
    job_when=st.one_of(st.none(), st.just(""), st.sampled_from(["delayed", "on_failure"])),
)
def test_resolve_rule_when_priority(rule_when, job_when):
    eff = re_mod._resolve_rule_when(rule_when, job_when)
    if rule_when:
        assert eff == rule_when
    elif job_when:
        assert eff == job_when
    else:
        assert eff == "on_success"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))

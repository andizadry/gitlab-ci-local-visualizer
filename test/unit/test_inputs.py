"""Test spec:inputs dan interpolasi $[[ ... ]] (ci_inputs.py)."""
import yaml
from hypothesis import given, strategies as st

from ci_inputs import (
    declared_inputs, expand_variables, has_interpolation, interpolate, resolve_inputs, split_spec,
)


def docs(text):
    return list(yaml.safe_load_all(text))


def test_split_spec_header_and_body():
    spec, body = split_spec(docs("spec:\n  inputs:\n    a:\n---\njob:\n  script: x\n"))
    assert "inputs" in spec and "job" in body


def test_split_spec_without_header_returns_body():
    spec, body = split_spec(docs("job:\n  script: x\n"))
    assert spec is None and "job" in body


def test_split_spec_header_only_and_empty():
    spec, body = split_spec(docs("spec:\n  inputs:\n    a:\n"))
    assert spec is not None and body == {}
    assert split_spec([]) == (None, {})


def test_declared_inputs_metadata():
    decl = declared_inputs({"inputs": {"a": None, "b": {"type": "number", "default": 2}}})
    assert decl["a"]["has_default"] is False and decl["a"]["type"] == "string"
    assert decl["b"]["has_default"] is True and decl["b"]["default"] == 2


def test_resolve_inputs_defaults_required_unknown():
    spec = {"inputs": {"req": None, "opt": {"default": "x"}}}
    values, problems = resolve_inputs(spec, {"extra": 1})
    codes = {c for c, _m in problems}
    assert codes == {"unknown-input", "input-required"}
    assert values == {"opt": "x"}


def test_resolve_inputs_type_options_regex():
    spec = {"inputs": {
        "n": {"type": "number"}, "b": {"type": "boolean"}, "arr": {"type": "array"},
        "o": {"options": ["a", "b"]}, "r": {"regex": r"^v\d+$"},
    }}
    _v, problems = resolve_inputs(spec, {"n": "3", "b": "yes", "arr": "x", "o": "c", "r": "x1"})
    assert len(problems) == 5 and {c for c, _ in problems} == {"input-invalid"}
    _v2, ok = resolve_inputs(spec, {"n": 3, "b": True, "arr": [1], "o": "a", "r": "v12"})
    assert ok == []


def test_interpolate_embedded_and_whole_value_types():
    values = {"name": "web", "count": 3, "flag": True, "tags": ["a", "b"]}
    out, problems = interpolate({
        "job-$[[ inputs.name ]]": {
            "script": ["echo $[[ inputs.name ]] x$[[ inputs.count ]] $[[ inputs.flag ]]"],
            "parallel": "$[[ inputs.count ]]",
            "allow_failure": "$[[ inputs.flag ]]",
            "tags": "$[[ inputs.tags ]]",
        }}, values)
    assert problems == []
    job = out["job-web"]
    assert job["script"] == ["echo web x3 true"]
    assert job["parallel"] == 3 and job["allow_failure"] is True and job["tags"] == ["a", "b"]


def test_interpolate_functions():
    values = {"v": "0123456789", "csv": "docker, linux,,", "empty": "", "alt": "fallback", "esc": "a b'c"}
    out, problems = interpolate({
        "t": "$[[ inputs.v | truncate(3,5) ]]",
        "s": "$[[ inputs.csv | split(',') ]]",
        "d": "$[[ inputs.empty | default('latest') ]]",
        "d2": "$[[ inputs.empty | default(inputs.alt) ]]",
        "e": "$[[ inputs.esc | posix_escape ]]",
        "x": "$[[ inputs.v | expand_vars | truncate(0,2) ]]",
    }, values)
    assert problems == []
    assert out["t"] == "34567" and out["s"] == ["docker", "linux"]
    assert out["d"] == "latest" and out["d2"] == "fallback"
    assert out["e"] == "a\\ b\\'c" and out["x"] == "01"


def test_interpolate_reports_problems_and_keeps_literal():
    out, problems = interpolate(
        {"a": "$[[ inputs.ghost ]]", "b": "$[[ inputs.v | nope ]]",
         "c": "$[[ inputs.v | truncate(0,1) | truncate(0,1) | truncate(0,1) | truncate(0,1) ]]"},
        {"v": "abc"})
    codes = {c for c, _m in problems}
    assert {"input-undeclared", "interp-function", "interp-too-many-functions"} <= codes
    assert out["a"] == "$[[ inputs.ghost ]]"


def test_component_context_is_not_available_offline():
    out, problems = interpolate({"image": "x:$[[ component.version ]]"}, {})
    assert problems and problems[0][0] == "component-context"
    assert out["image"] == "x:$[[ component.version ]]"


def test_expand_variables_one_level_and_unknown_kept():
    assert expand_variables("$A-${B}-$C", {"A": "1", "B": "2"}) == "1-2-$C"


@given(st.dictionaries(
    st.text(max_size=6).filter(lambda s: "$[[" not in s),
    st.text(max_size=12).filter(lambda s: "$[[" not in s),
    max_size=5))
def test_text_without_interpolation_is_identity(data):
    out, problems = interpolate(data, {"x": 1})
    assert out == data and problems == []
    assert not has_interpolation(data)

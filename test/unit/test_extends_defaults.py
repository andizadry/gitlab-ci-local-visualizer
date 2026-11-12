"""Test extends/default/!reference/include:rules/parallel/keyword validation pada engine."""
from conftest import diag_codes, simulate


def test_extends_inherits_rules_from_template(repo):
    repo.write(".gitlab-ci.yml", """
.only-main:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
build:
  extends: .only-main
  script: [echo]
""")
    r = repo.resolve()
    assert r.jobs["build"]["rules"] == [{"if": '$CI_COMMIT_BRANCH == "main"'}]
    assert simulate(r, {"CI_COMMIT_BRANCH": "main"})["results"]["build"]["status"] == "RUN"
    assert simulate(r, {"CI_COMMIT_BRANCH": "dev"})["results"]["build"]["status"] == "SKIP"


def test_extends_merges_hashes_and_overrides_arrays(repo):
    repo.write(".gitlab-ci.yml", """
.base:
  variables: {A: "1", B: "2"}
  tags: [one, two]
  script: [base]
job:
  extends: .base
  variables: {B: "9"}
  tags: [three]
""")
    job = repo.resolve().jobs["job"]
    assert job["variables"] == {"A": "1", "B": "9"}
    assert job["tags"] == ["three"] and job["script"] == ["base"]


def test_extends_chain_job_to_job_and_cycle(repo):
    repo.write(".gitlab-ci.yml", """
a:
  extends: b
  script: [a]
b:
  extends: a
  script: [b]
c:
  script: [c]
d:
  extends: c
""")
    r = repo.resolve()
    assert r.jobs["d"]["script"] == ["c"]
    assert "extends-cycle" in diag_codes(r)


def test_default_is_inherited_and_not_treated_as_job(repo):
    repo.write(".gitlab-ci.yml", """
default:
  image: alpine
  tags: [shared]
  before_script: [echo pre]
plain:
  script: [x]
own-image:
  image: ruby
  script: [x]
no-defaults:
  inherit: {default: false}
  script: [x]
some-defaults:
  inherit: {default: [image]}
  script: [x]
""")
    r = repo.resolve()
    assert "default" not in r.jobs
    assert r.jobs["plain"]["image"] == "alpine" and r.jobs["plain"]["tags"] == ["shared"]
    assert r.jobs["own-image"]["image"] == "ruby" and r.jobs["own-image"]["tags"] == ["shared"]
    assert r.jobs["no-defaults"]["image"] is None and r.jobs["no-defaults"]["tags"] == []
    assert r.jobs["some-defaults"]["image"] == "alpine" and r.jobs["some-defaults"]["tags"] == []
    assert r.jobs["plain"]["inherited_defaults"] == ["before_script", "image", "tags"]


def test_deprecated_global_keywords_still_act_as_defaults_and_are_flagged(repo):
    repo.write(".gitlab-ci.yml", """
image: node:20
cache:
  paths: [node_modules]
job:
  script: [x]
""")
    r = repo.resolve()
    assert "image" not in r.jobs and "cache" not in r.jobs
    assert r.jobs["job"]["image"] == "node:20"
    assert diag_codes(r).count("deprecated-global") == 2


def test_reference_tag_splices_lists(repo):
    repo.write(".gitlab-ci.yml", """
.setup:
  script:
    - echo setup
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
job:
  script:
    - !reference [.setup, script]
    - echo main
  rules:
    - !reference [.setup, rules]
    - if: '$FORCE == "1"'
""")
    r = repo.resolve()
    assert r.jobs["job"]["script"] == ["echo setup", "echo main"]
    assert len(r.jobs["job"]["rules"]) == 2
    assert simulate(r, {"CI_COMMIT_BRANCH": "main"})["results"]["job"]["status"] == "RUN"
    assert simulate(r, {"CI_COMMIT_BRANCH": "dev", "FORCE": "1"})["results"]["job"]["status"] == "RUN"
    assert simulate(r, {"CI_COMMIT_BRANCH": "dev"})["results"]["job"]["status"] == "SKIP"


def test_reference_missing_is_reported(repo):
    repo.write(".gitlab-ci.yml", "job:\n  script:\n    - !reference [.nope, script]\n")
    assert "reference-missing" in diag_codes(repo.resolve())


def test_include_rules_gate_jobs_in_simulation(repo):
    repo.write(".gitlab-ci.yml", """
include:
  - local: extra.yml
    rules:
      - if: '$ENABLE_EXTRA == "1"'
main-job:
  script: [x]
""")
    repo.write("extra.yml", "extra-job:\n  script: [x]\n")
    r = repo.resolve()
    off = simulate(r, {"CI_COMMIT_BRANCH": "main"})["results"]
    on = simulate(r, {"CI_COMMIT_BRANCH": "main", "ENABLE_EXTRA": "1"})["results"]
    assert off["extra-job"]["status"] == "NEVER" and "include:rules" in off["extra-job"]["reason"]
    assert off["main-job"]["status"] == "RUN"
    assert on["extra-job"]["status"] == "RUN"


def test_include_remote_and_template_are_info_not_errors(repo):
    repo.write(".gitlab-ci.yml", """
include:
  - remote: https://example.com/ci.yml
  - template: Security/SAST.gitlab-ci.yml
  - https://example.com/other.yml
job:
  script: [x]
""")
    diags = repo.resolve().get_diagnostics()
    errors = [d for d in diags if d["severity"] == "error"]
    assert errors == []
    codes = [d["code"] for d in diags]
    assert codes.count("external-remote") == 2 and "external-template" in codes


def test_parallel_matrix_info(repo):
    repo.write(".gitlab-ci.yml", """
matrix-job:
  script: [x]
  parallel:
    matrix:
      - OS: [linux, mac]
        VER: ["1", "2", "3"]
      - OS: [win]
        VER: ["9"]
count-job:
  script: [x]
  parallel: 4
""")
    jobs = repo.resolve().jobs
    assert jobs["matrix-job"]["parallel_info"]["count"] == 7
    assert jobs["count-job"]["parallel_info"]["count"] == 4


def test_variables_with_hash_syntax_are_normalized(repo):
    repo.write(".gitlab-ci.yml", """
variables:
  PLAIN: value
  RICH:
    value: from-hash
    description: doc
  NUM: 5
job:
  script: [x]
  variables: {FLAG: true}
""")
    r = repo.resolve()
    assert r.global_variables == {"PLAIN": "value", "RICH": "from-hash", "NUM": "5"}
    assert r.jobs["job"]["variables"] == {"FLAG": "true"}


def test_spec_inputs_defaults_apply_on_entry_file(repo):
    repo.write(".gitlab-ci.yml", """
spec:
  inputs:
    stage_name:
      default: build
---
stages: [build]
job:
  stage: $[[ inputs.stage_name ]]
  script: [x]
""")
    r = repo.resolve()
    assert r.jobs["job"]["stage"] == "build"
    trace = r.file_trace[-1]
    assert trace["inputs"]["declared"]["stage_name"]["required"] is False


def test_required_input_without_value_on_entry_is_only_info(repo):
    repo.write(".gitlab-ci.yml", """
spec:
  inputs:
    env:
---
job:
  script: [echo $[[ inputs.env ]]]
""".replace("[echo $[[ inputs.env ]]]", "\n    - echo $[[ inputs.env ]]"))
    diags = [d for d in repo.resolve().get_diagnostics() if d["code"] == "input-required"]
    assert diags and diags[0]["severity"] == "info"


def test_include_inputs_validated_against_included_spec(repo):
    repo.write(".gitlab-ci.yml", """
include:
  - local: tmpl.yml
    inputs:
      mode: turbo
""")
    repo.write("tmpl.yml", """
spec:
  inputs:
    mode:
      options: [fast, slow]
---
job:
  script:
    - echo $[[ inputs.mode ]]
""")
    r = repo.resolve()
    assert "input-invalid" in diag_codes(r)


def test_keyword_validation_unknown_and_suggestions(repo):
    repo.write(".gitlab-ci.yml", """
stage: build
job:
  scritp: [echo]
  script: [echo]
""")
    diags = repo.resolve().get_diagnostics()
    by_code = {d["code"]: d for d in diags}
    assert "stages" in by_code["unknown-global-keyword"]["message"]
    assert "'script'" in by_code["unknown-keyword"]["message"]


def test_keyword_validation_semantic_errors(repo):
    repo.write(".gitlab-ci.yml", """
stages: [one, two]
no-script:
  stage: one
mixed:
  stage: one
  script: [x]
  only: [main]
  rules:
    - if: '$A'
bad-when:
  stage: one
  script: [x]
  when: sometimes
never-job:
  stage: one
  script: [x]
  when: never
delayed:
  stage: one
  script: [x]
  when: delayed
early:
  stage: one
  script: [x]
  needs: [late]
late:
  stage: two
  script: [x]
retrying:
  stage: one
  script: [x]
  retry: 5
par:
  stage: one
  script: [x]
  parallel: 500
""")
    codes = diag_codes(repo.resolve())
    for expected in ("job-no-script", "rules-with-only-except", "invalid-when", "when-never-job-level",
                     "delayed-no-start-in", "needs-later-stage", "retry-max", "parallel-range"):
        assert expected in codes, expected


def test_pre_and_post_stages_are_implicitly_valid(repo):
    repo.write(".gitlab-ci.yml", """
stages: [build]
first:
  stage: .pre
  script: [x]
last:
  stage: .post
  script: [x]
""")
    assert "unknown-stage" not in diag_codes(repo.resolve())


def test_needs_optional_and_cross_project_do_not_error(repo):
    repo.write(".gitlab-ci.yml", """
job:
  script: [x]
  needs:
    - {job: maybe, optional: true}
    - {job: other, project: grp/proj, ref: main, artifacts: true}
    - {pipeline: "$PARENT_PIPELINE_ID", job: build}
""")
    diags = repo.resolve().get_diagnostics()
    assert not [d for d in diags if d["severity"] == "error"]
    assert "needs-optional-missing" in [d["code"] for d in diags]

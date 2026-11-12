"""Test parent-child, multi-project, dan dynamic child pipeline (engine + simulasi)."""
from conftest import diag_codes, simulate

PARENT_STATIC = """
stages: [build, trigger]
variables:
  GLOBAL_VAR: from-global
build-app:
  stage: build
  script: [echo build]
run-child:
  stage: trigger
  needs: [build-app]
  variables:
    BRIDGE_VAR: "1"
  trigger:
    include: ci/child.yml
    strategy: mirror
"""

CHILD_STATIC = """
stages: [test, deploy]
unit:
  stage: test
  script: [echo unit]
  rules:
    - if: '$CI_PIPELINE_SOURCE == "parent_pipeline" && $GLOBAL_VAR == "from-global" && $BRIDGE_VAR == "1"'
deploy:
  stage: deploy
  needs: [unit]
  script: [echo deploy]
  rules:
    - if: '$MYVAR == "secret"'
"""


def _static(repo):
    repo.write(".gitlab-ci.yml", PARENT_STATIC)
    repo.write("ci/child.yml", CHILD_STATIC)
    return repo.resolve()


def test_static_child_resolved_and_graph(repo):
    r = _static(repo)
    meta = r.child_pipelines["run-child"]
    assert meta["kind"] == "child"
    assert meta["status"] == "RESOLVED"
    assert meta["strategy"] == "mirror"
    assert sorted(meta["jobs"]) == ["deploy", "unit"]
    assert meta["forward"] == {"yaml_variables": True, "pipeline_variables": False}

    graph = r.get_deep_graph()
    ids = {n["id"]: n for n in graph["nodes"]}
    assert ids["child:run-child"]["type"] == "child_pipeline"
    assert "cjob:run-child/unit" in ids and "cjob:run-child/deploy" in ids
    types = {(e["source"], e["target"], e["type"]) for e in graph["edges"]}
    assert ("job:run-child", "child:run-child", "triggers") in types
    assert ("child:run-child", "cjob:run-child/unit", "child_contains") in types
    assert ("cjob:run-child/unit", "cjob:run-child/deploy", "needs") in types


def test_child_receives_global_and_bridge_variables_and_parent_source(repo):
    r = _static(repo)
    res = simulate(r, {"CI_COMMIT_BRANCH": "main"})
    child = res["child_pipelines"]["run-child"]
    assert child["triggered"] is True
    assert child["results"]["unit"]["status"] == "RUN"
    assert child["forwarded_variables"]["GLOBAL_VAR"] == "from-global"
    assert child["forwarded_variables"]["BRIDGE_VAR"] == "1"
    assert child["scenario_variables"]["CI_PIPELINE_SOURCE"] == "parent_pipeline"


def test_yaml_variables_forward_false_blocks_variables(repo):
    repo.write(".gitlab-ci.yml", PARENT_STATIC.replace(
        "    strategy: mirror", "    forward:\n      yaml_variables: false"))
    repo.write("ci/child.yml", CHILD_STATIC)
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    child = res["child_pipelines"]["run-child"]
    assert child["forwarded_variables"] == {}
    assert child["results"]["unit"]["status"] == "SKIP"


def test_pipeline_variables_only_forwarded_when_enabled(repo):
    r = _static(repo)
    res = simulate(r, {"CI_COMMIT_BRANCH": "main", "MYVAR": "secret"})
    assert res["child_pipelines"]["run-child"]["results"]["deploy"]["status"] == "SKIP"

    repo.write(".gitlab-ci.yml", PARENT_STATIC.replace(
        "    strategy: mirror", "    forward:\n      pipeline_variables: true"))
    res2 = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main", "MYVAR": "secret"})
    child = res2["child_pipelines"]["run-child"]
    assert child["forwarded_variables"]["MYVAR"] == "secret"
    assert child["results"]["deploy"]["status"] == "RUN"


def test_bridge_not_running_means_child_not_triggered(repo):
    repo.write(".gitlab-ci.yml", PARENT_STATIC + """
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
""")
    repo.write("ci/child.yml", CHILD_STATIC)
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "dev"})
    child = res["child_pipelines"]["run-child"]
    assert child["triggered"] is False
    assert {v["status"] for v in child["results"].values()} == {"NEVER"}


def test_manual_bridge_is_conditional(repo):
    repo.write(".gitlab-ci.yml", PARENT_STATIC + "  when: manual\n")
    repo.write("ci/child.yml", CHILD_STATIC)
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    child = res["child_pipelines"]["run-child"]
    assert child["bridge_status"] == "MANUAL"
    assert child["triggered"] == "conditional"
    assert child["results"]["unit"]["status"] == "RUN"


def test_child_workflow_rules_can_block_child(repo):
    repo.write(".gitlab-ci.yml", PARENT_STATIC)
    repo.write("ci/child.yml", """
workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
job-a:
  script: [echo a]
""")
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    child = res["child_pipelines"]["run-child"]
    assert child["pipeline_created"] is False
    assert child["results"]["job-a"]["status"] == "NEVER"


def test_nested_grandchild_and_depth_limit(repo):
    repo.write(".gitlab-ci.yml", """
stages: [a]
l1:
  stage: a
  trigger: {include: c1.yml}
""")
    repo.write("c1.yml", """
l2:
  trigger: {include: c2.yml}
""")
    repo.write("c2.yml", """
l3:
  trigger: {include: c3.yml}
leaf2:
  script: [echo]
""")
    repo.write("c3.yml", """
leaf3:
  script: [echo]
""")
    r = repo.resolve()
    l1 = r.child_pipelines["l1"]
    l2 = l1["children"]["l2"]
    assert l2["status"] == "RESOLVED" and l2["path"] == "l1/l2"
    l3 = l2["children"]["l3"]
    # kedalaman ketiga (great-grandchild) melampaui batas dua level child GitLab
    assert l3["status"] == "DEPTH_EXCEEDED"
    codes = diag_codes(r)
    assert "child-depth" in codes
    graph = r.get_deep_graph()
    assert any(n["id"] == "cjob:l1/l2/l3" for n in graph["nodes"])


def test_child_cycle_is_detected(repo):
    repo.write(".gitlab-ci.yml", """
loop:
  trigger: {include: .gitlab-ci.yml}
""")
    r = repo.resolve()
    assert r.child_pipelines["loop"]["status"] == "CYCLE"
    assert "child-cycle" in diag_codes(r)


def test_multi_project_downstream_via_mapping(repo, tmp_path_factory):
    other = tmp_path_factory.mktemp("downstream")
    (other / ".gitlab-ci.yml").write_text(
        "stages: [x]\n"
        "ds-main:\n  script: [echo]\n  rules:\n    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"pipeline\"'\n"
        "ds-feature:\n  script: [echo]\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"parent_pipeline\"'\n"
        "ds-changes:\n  script: [echo]\n  rules:\n    - changes: ['src/**']\n", encoding="utf-8")
    repo.write(".gitlab-ci.yml", """
call-other:
  variables:
    TARGET: prod
  trigger:
    project: grp/other
""")
    config = {"search_roots": [], "project_mappings": {"grp/other": str(other)}}
    r = repo.resolve(config=config)
    meta = r.child_pipelines["call-other"]
    assert meta["kind"] == "project" and meta["status"] == "RESOLVED"
    res = simulate(r, {"CI_COMMIT_BRANCH": "feature", "CI_DEFAULT_BRANCH": "main"}, changed=["src/a.py"])
    child = res["child_pipelines"]["call-other"]
    assert child["results"]["ds-main"]["status"] == "RUN"       # branch downstream = default branch
    assert child["results"]["ds-feature"]["status"] == "SKIP"   # sumber 'pipeline', bukan parent_pipeline
    assert child["results"]["ds-changes"]["status"] == "SKIP"   # file berubah milik repo lain tidak berlaku
    assert child["scenario_variables"]["CI_PROJECT_PATH"] == "grp/other"


def test_multi_project_unresolved_offline(repo):
    repo.write(".gitlab-ci.yml", "call:\n  trigger: group/unknown-project\n")
    r = repo.resolve()
    assert r.child_pipelines["call"]["status"] == "UNRESOLVED"
    assert "child-unresolved" in diag_codes(r)


GEN_PARENT = """
stages: [setup, trigger]
generate:
  stage: setup
  script: [node gen.js > generated-qa.yml]
  artifacts: {paths: [generated-qa.yml]}
run-dynamic:
  stage: trigger
  needs: [generate]
  trigger:
    include:
      - artifact: generated-qa.yml
        job: generate
    strategy: depend
"""
GEN_CHILD = "qa-1:\n  script: [echo 1]\nqa-2:\n  script: [echo 2]\n"


def test_dynamic_child_placeholder_without_sample(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    r = repo.resolve()
    meta = r.child_pipelines["run-dynamic"]
    assert meta["status"] == "PLACEHOLDER"
    assert meta["dynamic"]["job"] == "generate" and meta["dynamic"]["sample_file"] is None
    assert ".ci-samples" in meta["dynamic"]["hint"]
    graph = r.get_deep_graph()
    assert {n["id"]: n["type"] for n in graph["nodes"]}["child:run-dynamic"] == "dynamic_child"
    assert "dynamic-child-placeholder" in diag_codes(r)
    res = simulate(r, {"CI_COMMIT_BRANCH": "main"})
    assert res["child_pipelines"]["run-dynamic"]["placeholder"] is True


def test_dynamic_child_autodetect_next_to_ci_file(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    repo.write("generated-qa.yml", GEN_CHILD)
    r = repo.resolve()
    meta = r.child_pipelines["run-dynamic"]
    assert meta["status"] == "SAMPLE" and meta["dynamic"]["sample_source"] == "autodetect"
    assert sorted(meta["jobs"]) == ["qa-1", "qa-2"]


def test_dynamic_child_samples_folder_by_bridge_name(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    repo.write(".ci-samples/run-dynamic.yml", GEN_CHILD)
    meta = repo.resolve().child_pipelines["run-dynamic"]
    assert meta["status"] == "SAMPLE"


def test_dynamic_child_cli_override_beats_autodetect(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    repo.write("generated-qa.yml", "auto-job:\n  script: [echo]\n")
    custom = repo.write("samples/custom.yml", GEN_CHILD)
    r = repo.resolve(dynamic_overrides={"run-dynamic": str(custom)})
    meta = r.child_pipelines["run-dynamic"]
    assert meta["dynamic"]["sample_source"] == "cli"
    assert sorted(meta["jobs"]) == ["qa-1", "qa-2"]


def test_dynamic_child_config_mapping_relative_to_ci_dir(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    repo.write("samples/custom.yml", GEN_CHILD)
    config = {"search_roots": [], "project_mappings": {}, "dynamic_children": {"generate": "samples/custom.yml"}}
    meta = repo.resolve(config=config).child_pipelines["run-dynamic"]
    assert meta["dynamic"]["sample_source"] == "config" and meta["status"] == "SAMPLE"


def test_dynamic_child_sample_is_simulated(repo):
    repo.write(".gitlab-ci.yml", GEN_PARENT)
    repo.write("generated-qa.yml", "qa-1:\n  script: [echo]\n  rules:\n    - if: '$CI_PIPELINE_SOURCE == \"parent_pipeline\"'\n")
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    child = res["child_pipelines"]["run-dynamic"]
    assert child["results"]["qa-1"]["status"] == "RUN"
    assert child["summary"] == {"RUN": 1}


def test_trigger_inputs_are_interpolated_in_child(repo):
    repo.write(".gitlab-ci.yml", """
call:
  trigger:
    include:
      - local: child.yml
        inputs:
          env: staging
          replicas: 3
""")
    repo.write("child.yml", """
spec:
  inputs:
    env:
      options: [staging, prod]
    replicas:
      type: number
      default: 1
---
deploy-$[[ inputs.env ]]:
  script:
    - echo $[[ inputs.env ]]
  parallel: $[[ inputs.replicas ]]
""")
    r = repo.resolve()
    meta = r.child_pipelines["call"]
    assert list(meta["jobs"]) == ["deploy-staging"]
    assert meta["jobs"]["deploy-staging"]["parallel_info"]["count"] == 3
    assert not [d for d in r.get_diagnostics() if d["severity"] == "error"]


def test_trigger_inputs_invalid_value_reported(repo):
    repo.write(".gitlab-ci.yml", """
call:
  trigger:
    include:
      - local: child.yml
        inputs: {env: qa}
""")
    repo.write("child.yml", """
spec:
  inputs:
    env:
      options: [staging, prod]
---
job:
  script: [echo]
""")
    assert "input-invalid" in diag_codes(repo.resolve())


def test_invalid_trigger_and_forbidden_keywords_reported(repo):
    repo.write(".gitlab-ci.yml", """
bad-strategy:
  trigger:
    include: child.yml
    strategy: fire-and-forget
with-script:
  script: [echo hi]
  trigger: {include: child.yml}
empty:
  trigger: {}
""")
    repo.write("child.yml", "j:\n  script: [echo]\n")
    codes = diag_codes(repo.resolve())
    assert codes.count("trigger-invalid") >= 2
    assert "trigger-forbidden-keyword" in codes


def test_child_diagnostics_bubble_up_with_prefix(repo):
    repo.write(".gitlab-ci.yml", "call:\n  trigger: {include: child.yml}\n")
    repo.write("child.yml", "j:\n  script: [echo]\n  needs: [ghost]\n")
    diags = repo.resolve().get_diagnostics()
    assert any(d["code"] == "needs-missing" and d["message"].startswith("[child call]") for d in diags)


def test_not_created_parent_marks_children_never(repo):
    repo.write(".gitlab-ci.yml", """
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
call:
  trigger: {include: child.yml}
""")
    repo.write("child.yml", "j:\n  script: [echo]\n")
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "dev"})
    assert res["pipeline_created"] is False
    child = res["child_pipelines"]["call"]
    assert child["triggered"] is False and child["results"]["j"]["status"] == "NEVER"


def test_workflow_rules_variables_reach_jobs_and_children(repo):
    repo.write(".gitlab-ci.yml", """
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH == "main"'
      variables:
        DEPLOY_ENV: production
    - when: always
job:
  script: [x]
  rules:
    - if: '$DEPLOY_ENV == "production"'
call:
  trigger: {include: child.yml}
""")
    repo.write("child.yml", "child-job:\n  script: [x]\n  rules:\n    - if: '$DEPLOY_ENV == \"production\"'\n")
    r = repo.resolve()
    main = simulate(r, {"CI_COMMIT_BRANCH": "main"})
    assert main["results"]["job"]["status"] == "RUN"
    assert main["child_pipelines"]["call"]["results"]["child-job"]["status"] == "RUN"
    dev = simulate(r, {"CI_COMMIT_BRANCH": "dev"})
    assert dev["results"]["job"]["status"] == "SKIP"
    assert dev["child_pipelines"]["call"]["results"]["child-job"]["status"] == "SKIP"


def test_inherit_variables_false_stops_global_variables_only(repo):
    repo.write(".gitlab-ci.yml", """
variables:
  GLOBAL_X: from-global
call:
  inherit:
    variables: false
  variables:
    OWN: bridge
  trigger: {include: child.yml}
""")
    repo.write("child.yml", "j:\n  script: [x]\n")
    child = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})["child_pipelines"]["call"]
    assert child["forwarded_variables"] == {"OWN": "bridge"}


def test_forwarded_variables_expand_references(repo):
    repo.write(".gitlab-ci.yml", """
call:
  variables:
    REF_NAME: "release-$CI_COMMIT_BRANCH"
  trigger: {include: child.yml}
""")
    repo.write("child.yml", "j:\n  script: [x]\n  rules:\n    - if: '$REF_NAME == \"release-main\"'\n")
    child = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})["child_pipelines"]["call"]
    assert child["forwarded_variables"]["REF_NAME"] == "release-main"
    assert child["results"]["j"]["status"] == "RUN"


NESTED_PARENT = """
call:
  variables:
    A: "1"
  trigger: {include: c1.yml}
"""


def test_forwarded_variables_not_reforwarded_to_grandchild_by_default(repo):
    repo.write(".gitlab-ci.yml", NESTED_PARENT)
    repo.write("c1.yml", "nested:\n  trigger: {include: c2.yml}\n")
    repo.write("c2.yml", "leaf:\n  script: [x]\n  rules:\n    - if: '$A == \"1\"'\n")
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    leaf = res["child_pipelines"]["call"]["child_pipelines"]["nested"]["results"]["leaf"]
    assert leaf["status"] == "SKIP"


def test_nested_bridge_can_reforward_received_variables(repo):
    repo.write(".gitlab-ci.yml", NESTED_PARENT)
    repo.write("c1.yml", "nested:\n  trigger:\n    include: c2.yml\n    forward:\n      pipeline_variables: true\n")
    repo.write("c2.yml", "leaf:\n  script: [x]\n  rules:\n    - if: '$A == \"1\"'\n")
    res = simulate(repo.resolve(), {"CI_COMMIT_BRANCH": "main"})
    leaf = res["child_pipelines"]["call"]["child_pipelines"]["nested"]["results"]["leaf"]
    assert leaf["status"] == "RUN"

"""Resolusi include: variabel predefined project dan pencarian include:project tanpa config.

Semua nama project / host di sini fiktif (acme, gitlab.example.com).
"""
import textwrap

from ci_preview import CIResolver, parse_remote_url, project_predefined_vars


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")
    return path


def make_repo(root, rel, remote=None):
    repo = root / rel
    (repo / ".git").mkdir(parents=True, exist_ok=True)
    if remote:
        (repo / ".git" / "config").write_text(
            '[core]\n\tbare = false\n[remote "origin"]\n\turl = %s\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' % remote,
            encoding="utf-8")
    return repo


EMPTY = {"search_roots": [], "project_mappings": {}}

APP = "acme/web/storefront"
APP_REMOTE = "git@gitlab.example.com:acme/web/storefront.git"
LIB = "acme/platform/ci-library"
LIB_REMOTE = "git@gitlab.example.com:acme/platform/ci-library.git"
TEMPLATES = "acme/platform/ci-templates"


def test_parse_remote_url_variants():
    assert parse_remote_url("git@gitlab.example.com:grp/sub/app.git") == ("gitlab.example.com", "grp/sub/app")
    assert parse_remote_url("https://gitlab.example.com/grp/app.git") == ("gitlab.example.com", "grp/app")
    assert parse_remote_url("ssh://git@gitlab.example.com:2222/grp/app") == ("gitlab.example.com", "grp/app")
    assert parse_remote_url("git@gitlab-alias:grp/app.git") == ("gitlab-alias", "grp/app")
    assert parse_remote_url("") == (None, None)


def test_ci_project_path_in_include_file_expanded_from_git_remote(tmp_path):
    app = make_repo(tmp_path, APP, remote=APP_REMOTE)
    write(app / ".gitlab-ci.yml", """
    include:
      - project: 'acme/platform/ci-library'
        ref: main
        file: pipelines/${CI_PROJECT_PATH}/pipeline.yml
    """)
    lib = make_repo(tmp_path, LIB)
    write(lib / ("pipelines/%s/pipeline.yml" % APP), "e2e:\n  script: [echo]\nlint:\n  script: [echo]\n")
    r = CIResolver(app / ".gitlab-ci.yml", config=EMPTY).resolve()
    assert sorted(r.jobs) == ["e2e", "lint"]
    assert r.include_variables()["CI_PROJECT_PATH"] == APP
    assert r.include_variables()["CI_PROJECT_NAME"] == "storefront"
    assert r.include_variables()["CI_SERVER_HOST"] == "gitlab.example.com"


def test_ci_project_path_fallback_from_search_roots(tmp_path):
    base = tmp_path / "repos"
    app = make_repo(base, APP)          # tanpa remote origin
    write(app / ".gitlab-ci.yml", "include:\n  - local: ci/$CI_PROJECT_NAME.yml\n")
    write(app / "ci/storefront.yml", "job:\n  script: [echo]\n")
    cfg = {"search_roots": [str(base)], "project_mappings": {}}
    assert project_predefined_vars(app / ".gitlab-ci.yml", cfg)["CI_PROJECT_PATH"] == APP
    assert list(CIResolver(app / ".gitlab-ci.yml", config=cfg).resolve().jobs) == ["job"]


def test_unknown_variable_in_include_reported_clearly(tmp_path):
    app = make_repo(tmp_path, "grp/app")
    write(app / ".gitlab-ci.yml", "include:\n  - local: ci/${SOME_SECRET_VAR}.yml\njob:\n  script: [x]\n")
    r = CIResolver(app / ".gitlab-ci.yml", config=EMPTY).resolve()
    statuses = [f["status"] for f in r.file_trace if f["status"] != "OK"]
    assert statuses and "$SOME_SECRET_VAR" in statuses[0]


def test_include_project_found_via_group_layout_without_config(tmp_path):
    root = tmp_path / "workspace"
    app = make_repo(root, "acme/backend/api")
    write(app / ".gitlab-ci.yml", """
    include:
      - project: 'acme/platform/ci-templates'
        ref: main
        file: 'templates/app.yml'
    """)
    shared = make_repo(root, TEMPLATES)
    write(shared / "templates/app.yml", "build:\n  script: [echo]\ndeploy:\n  script: [echo]\n")
    r = CIResolver(app / ".gitlab-ci.yml", config=EMPTY).resolve()
    assert sorted(r.jobs) == ["build", "deploy"]


def test_stale_project_mapping_falls_back_to_group_layout(tmp_path):
    root = tmp_path / "workspace"
    app = make_repo(root, "acme/backend/api")
    write(app / ".gitlab-ci.yml", "include:\n  - project: 'acme/platform/ci-templates'\n    file: 'x.yml'\n")
    shared = make_repo(root, TEMPLATES)
    write(shared / "x.yml", "job:\n  script: [echo]\n")
    stale = {"search_roots": [str(tmp_path / "old-name")],
             "project_mappings": {TEMPLATES: str(tmp_path / "old-name" / TEMPLATES)}}
    assert list(CIResolver(app / ".gitlab-ci.yml", config=stale).resolve().jobs) == ["job"]


def _library(tmp_path):
    lib = make_repo(tmp_path, LIB, remote=LIB_REMOTE)
    base = lib / "pipelines" / APP
    write(base / "pipeline.yml", """
    include:
      - project: 'acme/platform/ci-library'
        ref: main
        file: pipelines/${CI_PROJECT_PATH}/jobs/build.yml
      - project: 'acme/platform/ci-library'
        file: pipelines/$CI_PROJECT_PATH/jobs/deploy.yml
    stages: [build, deploy]
    """)
    write(base / "jobs/build.yml", "build:\n  stage: build\n  script: [echo]\n")
    write(base / "jobs/deploy.yml", "deploy:\n  stage: deploy\n  script: [echo]\n")
    return lib, base


def test_template_opened_directly_infers_consumer_project_path(tmp_path):
    _lib, base = _library(tmp_path)
    r = CIResolver(base / "pipeline.yml", config=EMPTY).resolve()
    assert sorted(r.jobs) == ["build", "deploy"]
    assert r.include_variables()["CI_PROJECT_PATH"] == APP
    codes = [d["code"] for d in r.get_diagnostics()]
    assert "project-path-inferred" in codes and "include-unresolved" not in codes


def test_template_via_consumer_uses_real_project_path_without_guessing(tmp_path):
    _lib, _base = _library(tmp_path)
    app = make_repo(tmp_path, APP, remote=APP_REMOTE)
    write(app / ".gitlab-ci.yml", """
    include:
      - project: 'acme/platform/ci-library'
        file: pipelines/${CI_PROJECT_PATH}/pipeline.yml
    """)
    r = CIResolver(app / ".gitlab-ci.yml", config=EMPTY).resolve()
    assert sorted(r.jobs) == ["build", "deploy"]
    assert "project-path-inferred" not in [d["code"] for d in r.get_diagnostics()]


def test_no_guess_when_nothing_matches(tmp_path):
    lib = make_repo(tmp_path, LIB)
    write(lib / "x/y/z/entry.yml", "include:\n  - local: nope/${CI_PROJECT_PATH}/a.yml\njob:\n  script: [x]\n")
    r = CIResolver(lib / "x/y/z/entry.yml", config=EMPTY).resolve()
    assert list(r.jobs) == ["job"]
    assert "include-unresolved" in [d["code"] for d in r.get_diagnostics()]

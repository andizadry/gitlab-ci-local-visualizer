"""PyYAML bundel (vendor/pyyaml): engine tetap jalan walau PyYAML tidak terpasang di sistem."""
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "test" / "fixtures" / "downstream" / ".gitlab-ci.yml"
BUNDLED = ROOT / "vendor" / "pyyaml" / "yaml"


def _run(code_or_args, env_extra, as_code=False):
    env = dict(os.environ, **env_extra)
    args = [sys.executable, "-c", code_or_args] if as_code else [sys.executable, str(ROOT / "ci_preview.py")] + code_or_args
    return subprocess.run(args, capture_output=True, text=True, cwd=str(ROOT), env=env)


def test_bundled_copy_present_and_pure_python():
    assert (BUNDLED / "__init__.py").is_file()
    assert (ROOT / "vendor" / "pyyaml" / "LICENSE").is_file()
    assert not list(BUNDLED.glob("*.so")) and not list(BUNDLED.glob("*.pyd"))


def test_forced_bundled_yaml_is_used():
    p = _run("import ci_preview, yaml; print(yaml.__file__)", {"GITLAB_CI_LOCAL_BUNDLED_YAML": "1"}, as_code=True)
    assert p.returncode == 0, p.stderr
    assert str(BUNDLED) in p.stdout


def test_engine_output_identical_with_bundled_yaml():
    system = _run([str(FIXTURE), "--json"], {"GITLAB_CI_LOCAL_BUNDLED_YAML": "0"})
    bundled = _run([str(FIXTURE), "--json"], {"GITLAB_CI_LOCAL_BUNDLED_YAML": "1"})
    assert system.returncode == 0, system.stderr
    assert bundled.returncode == 0, bundled.stderr
    assert json.loads(system.stdout) == json.loads(bundled.stdout)


def test_fallback_when_system_pyyaml_missing(tmp_path):
    # Sembunyikan PyYAML sistem: modul palsu 'yaml' yang gagal di-import, didahulukan di sys.path.
    shim = tmp_path / "shim"
    (shim / "yaml").mkdir(parents=True)
    (shim / "yaml" / "__init__.py").write_text("raise ImportError('hidden for test')\n")
    code = (
        "import sys; sys.path.insert(0, %r); sys.argv=['ci_preview', %r, '--json'];"
        "import runpy; runpy.run_path(%r, run_name='__main__')"
        % (str(shim), str(FIXTURE), str(ROOT / "ci_preview.py"))
    )
    p = _run(code, {"GITLAB_CI_LOCAL_BUNDLED_YAML": "0"}, as_code=True)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout)["jobs"]

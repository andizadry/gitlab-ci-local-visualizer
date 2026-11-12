"""Helper bersama untuk test engine (semua data dummy di tmp_path)."""
import json
import textwrap

import pytest

from ci_preview import CIResolver
from rules_evaluator import SimulationRunner


class Repo:
    """Repo sementara berisi file YAML dummy."""

    def __init__(self, root):
        self.root = root
        (root / ".git").mkdir(exist_ok=True)

    def write(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8")
        return path

    def resolve(self, rel=".gitlab-ci.yml", **kwargs):
        config = kwargs.pop("config", {"search_roots": [], "project_mappings": {}})
        return CIResolver(self.root / rel, config=config, **kwargs).resolve()


@pytest.fixture
def repo(tmp_path):
    return Repo(tmp_path)


def simulate(resolver, variables=None, changed=None, exists=None):
    scenario = {
        "variables": dict(variables or {}),
        "changed_files": list(changed or []),
        "exists_files": list(exists or []),
    }
    result = SimulationRunner.run(resolver, scenario)
    # Pastikan hasil bisa diserialisasi (kontrak CLI/extension).
    json.dumps(result, default=str)
    return result


def diag_codes(resolver):
    return [d["code"] for d in resolver.get_diagnostics()]

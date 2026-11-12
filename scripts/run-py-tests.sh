#!/usr/bin/env bash
# Menjalankan test Python (pytest + hypothesis) di virtualenv lokal .venv-test.
# Distro dengan Python "externally managed" (PEP 668) tidak mengizinkan pip global, jadi venv dipakai.
set -e
cd "$(dirname "$0")/.."
if [ ! -x .venv-test/bin/python ]; then
  python3 -m venv .venv-test
  .venv-test/bin/python -m pip install --quiet --upgrade pip
fi
.venv-test/bin/python -c "import pytest, hypothesis, yaml" 2>/dev/null || \
  .venv-test/bin/python -m pip install --quiet pytest hypothesis pyyaml
.venv-test/bin/python -m pytest "$@"

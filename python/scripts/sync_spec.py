"""Copies the shared tool spec into the Python package.

``spec/tools.json`` lives at the repo root so the TypeScript package reads the
same file. A wheel cannot include files from outside its project directory, so
it has to be copied in. ``hatch_build.py`` does that during a real build; this
script is the standalone version, used by the test suite's conftest to refresh
the copy when the spec changes without a reinstall.

Mirrors ``typescript/scripts/sync-spec.mjs``.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
SOURCE = REPO_ROOT / "spec" / "tools.json"
TARGET = HERE.parent / "src" / "ktemia_mcp" / "tools.json"


def sync() -> Path:
    if not SOURCE.is_file():
        raise SystemExit(f"sync_spec: no spec at {SOURCE}")
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, TARGET)
    return TARGET


if __name__ == "__main__":
    target = sync()
    print(f"sync_spec: {SOURCE} -> {target}", file=sys.stderr)

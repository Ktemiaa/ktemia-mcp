"""Copies the shared tool spec into the Python package.

``spec/tools.json`` lives at the repo root so the TypeScript package reads the
same file. A wheel cannot include files from outside its project directory, so
the build copies it in. Both servers therefore ship identical prose.

Run by ``make -C python build``, by the test suite's conftest, and by CI before
packaging. Mirrors ``typescript/scripts/sync-spec.mjs``.
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

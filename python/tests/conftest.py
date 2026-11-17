"""Shared fixtures.

The spec is copied into the package by the build; tests run from a source
checkout where that may not have happened yet, so do it here too. Without this
the whole suite fails on a fresh clone with a confusing missing-file error.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from sync_spec import sync  # noqa: E402

sync()

"""Loader for the shared tool contract in ``spec/tools.json``.

The same file is read by the TypeScript server, so prose, enums, and defaults
cannot drift between the two packages. Validation stays native to each
language: only the shared contract comes from here.

Mirrors ``typescript/src/spec.ts``, including the error messages, so a broken
spec reads the same whichever package hits it first.

The file is copied into the package at build time (see ``scripts/sync_spec.py``)
so it ships inside the published wheel.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

SPEC_VERSION = 1


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    path = Path(__file__).parent / "tools.json"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as cause:
        raise RuntimeError(
            f"Could not read the shared tool spec at {path}. The build copies "
            f"spec/tools.json into the package; run python scripts/sync_spec.py. "
            f"({cause})"
        ) from cause
    parsed = json.loads(raw)
    if parsed.get("specVersion") != SPEC_VERSION:
        raise RuntimeError(
            f"Unsupported tool spec version {parsed.get('specVersion')}; "
            f"this build expects {SPEC_VERSION}."
        )
    return parsed


def tools() -> list[dict[str, Any]]:
    """Every tool, in the order the spec lists them."""
    return _load()["tools"]


def tool(name: str) -> dict[str, Any]:
    """Look up one tool by name.

    Raises rather than returning ``None``: a typo here would silently register
    a tool with no description, which is the exact drift this file exists to
    prevent.
    """
    for candidate in tools():
        if candidate["name"] == name:
            return candidate
    known = ", ".join(t["name"] for t in tools())
    raise RuntimeError(f'No tool named "{name}" in spec/tools.json. Known tools: {known}')


def param(tool_name: str, param_name: str) -> str:
    """The description text for one parameter of one tool."""
    params = tool(tool_name).get("params", {})
    if param_name not in params:
        raise RuntimeError(
            f'Tool "{tool_name}" has no parameter "{param_name}" in spec/tools.json.'
        )
    return params[param_name]["description"]


def values(name: str) -> list[str]:
    """A named enum's values."""
    found = _load()["enums"].get(name)
    if not found:
        raise RuntimeError(f'No enum named "{name}" in spec/tools.json.')
    return found


def note(name: str) -> str:
    """A shared note, appended to tool descriptions that need it."""
    found = _load()["shared"].get(name)
    if not found:
        raise RuntimeError(f'No shared note named "{name}" in spec/tools.json.')
    return found


def limit(name: str) -> int:
    """A documented numeric limit, mirrored from the API's own configuration."""
    found = _load()["limits"].get(name)
    if found is None:
        raise RuntimeError(f'No limit named "{name}" in spec/tools.json.')
    return found


def describe(name: str, notes: list[str] | None = None) -> str:
    """Assemble a tool's full description: spec prose plus shared notes.

    Keeping the joining logic here, in the same order as the TypeScript side,
    means both languages produce an identical string from identical inputs.
    """
    parts = [tool(name)["description"], *[note(n) for n in (notes or [])]]
    return " ".join(parts)

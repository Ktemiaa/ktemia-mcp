"""Build hook that copies the shared tool spec into the package.

``spec/tools.json`` lives at the repository root so both the TypeScript and
Python packages read one file, and it is deliberately not committed inside
``src/`` - a second copy under version control is a second source of truth that
can disagree with the first.

That leaves a chicken-and-egg problem: a wheel cannot include a file from
outside its project directory, so the file must be copied in before the build,
but anything that builds the package (``uv sync``, ``pip install -e .``) runs
the build first. Doing the copy here, inside the build itself, is what breaks
the cycle: a fresh clone installs with no manual step.

Building from an sdist has no repository root above it. That is fine, because
the sdist already contains the copy this hook made when the sdist was built; in
that case the hook verifies rather than copies.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

TARGET = Path("src") / "ktemia_mcp" / "tools.json"


class SpecBuildHook(BuildHookInterface):
    PLUGIN_NAME = "ktemia-spec"

    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        root = Path(self.root)
        target = root / TARGET
        source = root.parent / "spec" / "tools.json"

        if source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            return

        # No repository root: this is a build from an sdist, which ships the
        # copy already. If it is missing too, fail loudly now rather than
        # shipping a server that cannot start.
        if not target.is_file():
            raise FileNotFoundError(
                f"Neither {source} nor {target} exists, so the shared tool "
                "spec cannot be packaged. Build from a full checkout of "
                "https://github.com/Ktemiaa/ktemia-mcp."
            )

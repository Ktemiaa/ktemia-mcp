"""Cross-language parity.

The point of ``spec/tools.json`` is that an agent gets the same tools, named
the same way, described in the same words, whether the user installed the npm
package or this one. Nothing enforces that at runtime, so it is enforced here.

The TypeScript tool list is read from its compiled output rather than
hardcoded, so this fails if either side drifts.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ktemia_mcp import __version__, spec
from ktemia_mcp.client import VERSION as CLIENT_VERSION
from ktemia_mcp.server import create_server

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
TS_DIR = REPO_ROOT / "typescript"

EXPECTED_TOOLS = [
    "ktemia_key_status",
    "ktemia_lookup",
    "ktemia_search_flights",
    "ktemia_search_hotels",
    "ktemia_search_cars",
    "ktemia_get_details",
    "ktemia_get_hotel_reviews",
]


async def _python_tools() -> dict[str, object]:
    tools = await create_server(api_key="test-key").list_tools()
    return {t.name: t for t in tools}


async def test_registers_exactly_the_spec_tools() -> None:
    tools = await _python_tools()
    assert list(tools) == EXPECTED_TOOLS
    assert [t["name"] for t in spec.tools()] == EXPECTED_TOOLS


async def test_descriptions_come_from_the_spec() -> None:
    """Every description must contain the spec's own prose verbatim.

    Catches a hand-edited description, which is how the two packages would
    quietly start telling an agent different things.
    """
    tools = await _python_tools()
    for name, tool in tools.items():
        assert spec.tool(name)["description"] in (tool.description or "")


async def test_quota_note_on_every_metered_tool() -> None:
    """Only key_status is free, and only key_status may omit the quota note."""
    tools = await _python_tools()
    note = spec.note("quotaNote")
    for name, tool in tools.items():
        has_note = note in (tool.description or "")
        if name == "ktemia_key_status":
            assert not has_note, "key_status costs no quota; saying so is wrong"
        else:
            assert has_note, f"{name} spends quota but does not say so"


async def test_every_parameter_is_described() -> None:
    """An undescribed parameter is one the model will fill in by guessing."""
    tools = await _python_tools()
    for name, tool in tools.items():
        props = (tool.input_schema or {}).get("properties", {})
        for param_name, schema in props.items():
            described = schema.get("description") or any(
                v.get("description") for v in schema.get("anyOf", [])
            )
            assert described, f"{name}.{param_name} has no description"


async def test_enums_match_the_spec() -> None:
    """Enum values must be the spec's, not a stale copy in the type aliases."""
    tools = await _python_tools()
    flights = (tools["ktemia_search_flights"].input_schema or {})["properties"]
    cabin = next(branch["enum"] for branch in flights["cabin"]["anyOf"] if "enum" in branch)
    assert cabin == spec.values("cabin")

    lookup = (tools["ktemia_lookup"].input_schema or {})["properties"]
    assert lookup["kind"]["enum"] == spec.values("lookupKind")


async def test_numeric_parameters_have_sane_bounds() -> None:
    """No parameter may advertise an astronomically large maximum.

    An unbounded integer in a published schema invites a model to pass 9999
    rooms, and the absurd bound is itself a prompt-quality problem.
    """
    tools = await _python_tools()
    bounded = {
        ("ktemia_search_flights", "maxStops"): 3,
        ("ktemia_search_hotels", "adults"): 30,
        ("ktemia_search_hotels", "rooms"): 8,
        ("ktemia_search_cars", "driverAge"): 99,
        ("ktemia_get_hotel_reviews", "months"): 120,
        ("ktemia_get_hotel_reviews", "page"): 1000,
    }
    for (tool_name, param_name), expected_max in bounded.items():
        props = (tools[tool_name].input_schema or {})["properties"]
        schema = props[param_name]
        branches = schema.get("anyOf", [schema])
        found = [b.get("maximum") for b in branches if b.get("maximum") is not None]
        assert found == [expected_max], f"{tool_name}.{param_name}: {schema}"


async def test_all_tools_are_annotated_read_only() -> None:
    tools = await _python_tools()
    for name, tool in tools.items():
        assert tool.annotations is not None, name
        # Constructed with the wire names, read back as snake_case: the SDK
        # accepts the camelCase aliases but normalises the attributes.
        assert tool.annotations.read_only_hint is True, name
        assert tool.annotations.destructive_hint is False, name


# ── Parity with the TypeScript package ───────────────────────────────────────


def _spec_tool_list() -> list[dict[str, str]]:
    """The shared contract both packages register from."""
    spec_path = REPO_ROOT / "spec" / "tools.json"
    return json.loads(spec_path.read_text(encoding="utf-8"))["tools"]


def test_typescript_and_python_read_the_same_spec_file() -> None:
    """The packaged copy must be byte-identical to the repo-root original."""
    source = (REPO_ROOT / "spec" / "tools.json").read_bytes()
    packaged = (Path(spec.__file__).parent / "tools.json").read_bytes()
    assert packaged == source, "run python scripts/sync_spec.py"


@pytest.mark.skipif(
    not (TS_DIR / "dist" / "tools.json").is_file(),
    reason="TypeScript package not built; run npm run build in typescript/",
)
def test_typescript_packaged_spec_matches() -> None:
    source = (REPO_ROOT / "spec" / "tools.json").read_bytes()
    ts_packaged = (TS_DIR / "dist" / "tools.json").read_bytes()
    assert ts_packaged == source, "run npm run build in typescript/"


async def test_python_tool_names_match_spec_order() -> None:
    """Tool order is part of the contract: it is the order a model reads."""
    tools = await _python_tools()
    assert list(tools) == [t["name"] for t in _spec_tool_list()]


# ── Version consistency ──────────────────────────────────────────────────────


def _declared_versions() -> dict[str, str]:
    """Every place a version is written down, across both packages.

    The version is maintained by hand in five files. It also travels upstream
    in the ``X-Ktemia-Client: mcp/<version>`` header, so a stale copy quietly
    misattributes traffic in Ktemia's own logs - the kind of bug nobody
    notices until the numbers are already wrong.
    """
    # Read with a regex rather than tomllib: this package supports 3.10, where
    # tomllib is not in the standard library, and a test that cannot even be
    # imported on the lowest supported version defeats the point of the
    # version matrix.
    pyproject = (
        REPO_ROOT / "python" / "pyproject.toml"
    ).read_text(encoding="utf-8")
    py_match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', pyproject)
    assert py_match, "could not find version in python/pyproject.toml"

    package_json = json.loads(
        (TS_DIR / "package.json").read_text(encoding="utf-8")
    )
    ts_client = (TS_DIR / "src" / "client.ts").read_text(encoding="utf-8")
    ts_match = re.search(r'VERSION\s*=\s*"([^"]+)"', ts_client)
    assert ts_match, "could not find VERSION in typescript/src/client.ts"

    return {
        "python/pyproject.toml": py_match.group(1),
        "ktemia_mcp.__version__": __version__,
        "ktemia_mcp.client.VERSION": CLIENT_VERSION,
        "typescript/package.json": package_json["version"],
        "typescript/src/client.ts": ts_match.group(1),
    }


def test_all_declared_versions_agree() -> None:
    declared = _declared_versions()
    assert len(set(declared.values())) == 1, (
        "version drift between packages: "
        + ", ".join(f"{where}={value}" for where, value in declared.items())
    )

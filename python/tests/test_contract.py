"""Tool schemas against the published OpenAPI spec.

``test_parity.py`` proves the two packages agree with each other. That is not
the same as agreeing with the API: ``carClass`` shipped as an array in both
languages while the API takes a single enum, so every call carrying it was
rejected and both packages were consistently wrong.

This reads https://www.ktemia.com/openapi.json and compares the shape of each
search parameter against what the tools advertise. It needs no API key, only
network, so it is opt-in via KTEMIA_CONTRACT_TEST=1 to keep the offline suite
hermetic.
"""

from __future__ import annotations

import os
from typing import Any

import httpx
import pytest

from ktemia_mcp.server import create_server

pytestmark = pytest.mark.skipif(
    not os.environ.get("KTEMIA_CONTRACT_TEST"),
    reason="set KTEMIA_CONTRACT_TEST=1 to check tool schemas against the live OpenAPI spec",
)

SPEC_URL = "https://www.ktemia.com/openapi.json"

# Tool -> the POST body that tool fills in.
SEARCHES = {
    "ktemia_search_flights": "/flights/search",
    "ktemia_search_hotels": "/hotels/search",
    "ktemia_search_cars": "/cars/search",
}

# Parameters the MCP layer owns; they have no API counterpart.
MCP_ONLY = {"nextToken"}


@pytest.fixture(scope="module")
def spec() -> dict[str, Any]:
    response = httpx.get(SPEC_URL, timeout=30.0, follow_redirects=True)
    response.raise_for_status()
    return response.json()


def _resolve(spec: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Follow a local ``$ref``.

    Two dialects meet here. The API spec points at
    ``#/components/schemas/<name>``; the tool schemas zod emits point at
    ``#/$defs/<name>``, which lives inside the tool's own schema and is not
    resolvable from the spec. Returning the ref unchanged for the latter is
    enough: the callers only read ``type`` and ``enum``, and a nested object
    has neither.
    """
    ref = schema.get("$ref")
    if not ref:
        return schema
    if not ref.startswith("#/components/schemas/"):
        return schema
    return spec["components"]["schemas"][ref.split("/")[-1]]


def _unwrap(spec: dict[str, Any], schema: dict[str, Any]) -> dict[str, Any]:
    """Strip the nullable ``anyOf`` wrapper the generator emits."""
    schema = _resolve(spec, schema)
    options = schema.get("anyOf") or schema.get("oneOf")
    if not options:
        return schema
    real = [o for o in options if o.get("type") != "null"]
    return _resolve(spec, real[0]) if real else schema


def _body_properties(spec: dict[str, Any], path: str) -> dict[str, Any]:
    body = spec["paths"][path]["post"]["requestBody"]
    schema = _unwrap(spec, body["content"]["application/json"]["schema"])
    return schema.get("properties", {})


def _is_array(schema: dict[str, Any]) -> bool:
    return schema.get("type") == "array"


async def _tool_schemas() -> dict[str, dict[str, Any]]:
    tools = await create_server(api_key="test-key").list_tools()
    out: dict[str, dict[str, Any]] = {}
    for tool in tools:
        schema = tool.input_schema or {}
        out[tool.name] = schema.get("properties", {}) or {}
    return out


@pytest.mark.parametrize("tool_name,path", sorted(SEARCHES.items()))
async def test_every_api_parameter_is_offered(
    spec: dict[str, Any], tool_name: str, path: str
) -> None:
    """A parameter the API accepts but the tool hides is unreachable."""
    api = set(_body_properties(spec, path))
    offered = set((await _tool_schemas())[tool_name]) - MCP_ONLY

    assert not api - offered, (
        f"{tool_name} does not offer {sorted(api - offered)}, "
        f"so an agent cannot use {path} fully"
    )
    assert not offered - api, (
        f"{tool_name} offers {sorted(offered - api)}, which {path} "
        "does not accept; the API will reject the call"
    )


@pytest.mark.parametrize("tool_name,path", sorted(SEARCHES.items()))
async def test_scalar_and_list_parameters_agree(
    spec: dict[str, Any], tool_name: str, path: str
) -> None:
    """A list where the API wants one value is rejected on every call.

    This is the check that would have caught ``carClass``: both packages
    declared ``list[CarClass]`` for an enum the API takes singly, so the
    parameter was impossible to use and no stubbed test noticed.
    """
    properties = _body_properties(spec, path)
    offered = (await _tool_schemas())[tool_name]

    wrong: list[str] = []
    for name, api_schema in properties.items():
        tool_schema = offered.get(name)
        if tool_schema is None:
            continue
        api_list = _is_array(_unwrap(spec, api_schema))
        tool_list = _is_array(_unwrap(spec, tool_schema))
        if api_list != tool_list:
            wrong.append(
                f"{name}: api={'list' if api_list else 'single'} "
                f"tool={'list' if tool_list else 'single'}"
            )

    assert not wrong, f"{tool_name} disagrees with {path} on " + "; ".join(wrong)


@pytest.mark.parametrize("tool_name,path", sorted(SEARCHES.items()))
async def test_enum_values_match_the_api(
    spec: dict[str, Any], tool_name: str, path: str
) -> None:
    """An enum value the API rejects is a tool call wasted on a 400."""
    properties = _body_properties(spec, path)
    offered = (await _tool_schemas())[tool_name]

    wrong: list[str] = []
    for name, api_schema in properties.items():
        tool_schema = offered.get(name)
        if tool_schema is None:
            continue

        api_resolved = _unwrap(spec, api_schema)
        tool_resolved = _unwrap(spec, tool_schema)
        if _is_array(api_resolved):
            api_resolved = _unwrap(spec, api_resolved.get("items", {}))
            tool_resolved = _unwrap(spec, tool_resolved.get("items", {}))

        api_values = api_resolved.get("enum")
        tool_values = tool_resolved.get("enum")
        if api_values and tool_values and set(api_values) != set(tool_values):
            wrong.append(
                f"{name}: api={sorted(api_values)} tool={sorted(tool_values)}"
            )

    assert not wrong, f"{tool_name} enum drift against {path}: " + "; ".join(wrong)

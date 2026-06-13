"""Regression tests for safe JSON construction in the eval bridge shell wrappers.

The bridge functions in ``bridge/gitnexus_tools.sh`` build the JSON request body
sent to the eval-server. They previously interpolated shell variables directly
into a hand-built JSON string, so an argument containing ``"``, ``\\`` or a
newline could break out of the string and inject extra JSON keys. The functions
now build the body with ``jq``; these tests assert that malicious argument
values are safely escaped — the payload survives verbatim as a *value* and never
becomes new structure.

Each test sources the real ``gitnexus_tools.sh`` and overrides ``_gitnexus_call``
with a stub that simply prints the JSON body it was handed, so we can inspect
exactly what each wrapper would POST.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

BRIDGE_SCRIPT = Path(__file__).resolve().parents[1] / "bridge" / "gitnexus_tools.sh"

# These tests exercise the real bash wrappers and the jq builder, so both tools
# must be present. Skip cleanly where they are not (jq is available in dev/CI).
pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("jq") is None,
    reason="bash and jq are required to exercise the bridge shell wrappers",
)

# A classic JSON-breakout payload: if interpolation were unescaped this would
# close the string and add an "injected" key.
INJECTION = 'a","injected":"b'
# A payload mixing a real newline with a breakout attempt.
NEWLINE_INJECTION = 'line1\nline2","x":"y'


def _run_wrapper(func: str, *args: str) -> str:
    """Source the bridge, stub the network call, run ``func`` with ``args``.

    Returns the JSON body the wrapper would have POSTed. Arguments are passed as
    positional parameters to ``bash -c`` (``"$@"``) so payloads arrive as exact
    argv bytes — including literal newlines — with no shell-quoting
    reinterpretation. ``_gitnexus_call`` is overridden *after* sourcing so the
    real wrapper builds the JSON, but instead of issuing curl we emit the body
    (its 2nd argument).
    """
    script = (
        f'source "{BRIDGE_SCRIPT}"\n'
        '_gitnexus_call() { printf "%s" "$2"; }\n'
        f'{func} "$@"\n'
    )
    proc = subprocess.run(
        ["bash", "-c", script, "bash", *args],
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, f"wrapper exited {proc.returncode}: {proc.stderr}"
    return proc.stdout


def test_query_injection_is_contained():
    body = _run_wrapper("gitnexus-query", INJECTION)
    parsed = json.loads(body)  # raises if not valid JSON -> injection broke out
    assert parsed == {"query": INJECTION}
    # The breakout attempt did not create an extra key.
    assert "injected" not in parsed


def test_query_newline_payload_is_valid_json():
    body = _run_wrapper("gitnexus-query", NEWLINE_INJECTION)
    # No raw control characters on the wire: the body must parse as strict JSON
    # and the newline must be escaped (\n), not emitted as a raw 0x0a byte.
    parsed = json.loads(body)
    assert parsed == {"query": NEWLINE_INJECTION}
    assert "\n" not in body


def test_query_optional_fields_only_when_present():
    # Optionals omitted -> only the required key (preserves prior behavior).
    assert json.loads(_run_wrapper("gitnexus-query", "just a query")) == {
        "query": "just a query"
    }
    # All three supplied, each safely escaped.
    body = _run_wrapper("gitnexus-query", INJECTION, 'ctx"x', "goal\\back")
    parsed = json.loads(body)
    assert set(parsed) == {"query", "task_context", "goal"}
    assert parsed["query"] == INJECTION
    assert parsed["task_context"] == 'ctx"x'
    assert parsed["goal"] == "goal\\back"


def test_context_injection_is_contained():
    body = _run_wrapper("gitnexus-context", INJECTION, 'p","evil":"1')
    parsed = json.loads(body)
    assert set(parsed) == {"name", "file_path"}
    assert parsed["name"] == INJECTION
    assert "injected" not in parsed and "evil" not in parsed


def test_context_optional_file_path_omitted():
    assert json.loads(_run_wrapper("gitnexus-context", "validateUser")) == {
        "name": "validateUser"
    }


def test_impact_injection_is_contained_and_keeps_default_direction():
    body = _run_wrapper("gitnexus-impact", INJECTION)
    parsed = json.loads(body)
    assert parsed == {"target": INJECTION, "direction": "upstream"}


def test_cypher_injection_is_contained():
    body = _run_wrapper("gitnexus-cypher", NEWLINE_INJECTION)
    parsed = json.loads(body)
    assert parsed == {"query": NEWLINE_INJECTION}
    assert "x" not in parsed

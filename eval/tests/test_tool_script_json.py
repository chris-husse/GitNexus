"""Regression tests for safe JSON construction in the generated container scripts.

``tool_registry.py`` defines a ``payload_builder`` for each GitNexus tool, and
``environments/gitnexus_docker.py`` renders those into standalone
``/usr/local/bin/gitnexus-*`` scripts that run inside SWE-bench Docker
containers. The builders previously interpolated shell variables directly into a
hand-built JSON string, so a script argument containing ``"``, ``\\`` or a
newline could break out of the string and inject extra JSON keys (same class as
the eval bridge finding). The builders now hand argument *values* to a
``python3`` + ``json.dumps`` helper (``_json_payload``) as argv data — never
interpolated into the Python source or a JSON string literal — so values can
only ever reach the payload as JSON-escaped strings. (The container images are
Python-based and reliably ship ``python3`` but not ``jq``.)

These tests render the *real* scripts and execute them with malicious argument
values, stubbing ``curl`` so it echoes back the ``-d`` payload. We then assert
the payload is valid JSON whose values carry the malicious bytes verbatim and
which gains no injected structure.

Like the other eval tests, this gates on the tools being importable (the docker
environment needs ``minisweagent``) and on ``bash`` + ``python3`` being present.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile

import pytest

# The docker environment imports minisweagent; skip cleanly if it (or bash /
# python3, which the rendered scripts require) is unavailable.
GitNexusDockerEnvironment = pytest.importorskip(
    "environments.gitnexus_docker"
).GitNexusDockerEnvironment
tool_registry = pytest.importorskip("tool_registry")
TOOL_SPECS = tool_registry.TOOL_SPECS

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None or shutil.which("python3") is None,
    reason="bash and python3 are required to exercise the rendered tool scripts",
)

# A classic JSON-breakout payload: unescaped, this would close the string and
# add an "x" key.
INJECTION = 'a","x":"b'
# A payload mixing a real newline with a breakout attempt.
NEWLINE_INJECTION = 'line1\nline2","y":"z'


def _run_script(key: str, *args: str) -> dict:
    """Render the real tool script, stub ``curl`` to echo its ``-d`` payload, run it.

    Returns the parsed JSON body the script would have POSTed to the eval-server.
    Arguments are passed as exact argv bytes (including literal newlines) with no
    shell-quoting reinterpretation. ``json.loads`` raises if the body is not
    valid JSON, which is exactly the failure an injection would cause.
    """
    script = GitNexusDockerEnvironment._render_tool_script(TOOL_SPECS[key], "4848")
    body = script.split("\n", 1)[1]  # drop the rendered shebang; we add our own
    # Stub curl: scan argv for the value following ``-d`` and print it, then
    # "succeed" so the script echoes the captured payload and exits 0.
    harness = (
        "#!/bin/bash\n"
        "curl() {\n"
        '  local prev d=""\n'
        '  for a in "$@"; do [ "$prev" = "-d" ] && d="$a"; prev="$a"; done\n'
        '  printf "%s" "$d"\n'
        "  return 0\n"
        "}\n" + body
    )
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as f:
        f.write(harness)
        path = f.name
    try:
        proc = subprocess.run(["bash", path, *args], capture_output=True, text=True)
    finally:
        os.unlink(path)
    assert proc.returncode == 0, f"script exited {proc.returncode}: {proc.stderr}"
    payload_line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    # A raw newline on the wire would mean the value wasn't JSON-escaped.
    assert "\n" not in payload_line, f"raw newline leaked into payload: {payload_line!r}"
    return json.loads(payload_line)


def test_query_injection_is_contained():
    parsed = _run_script("query", INJECTION)
    assert parsed == {"query": INJECTION}
    assert "x" not in parsed  # the breakout attempt created no extra key


def test_query_newline_payload_is_valid_json():
    parsed = _run_script("query", NEWLINE_INJECTION)
    assert parsed == {"query": NEWLINE_INJECTION}


def test_query_optional_fields_only_when_present():
    # Optionals omitted -> only the required key (preserves prior behavior).
    assert _run_script("query", "just a query") == {"query": "just a query"}
    # All three supplied, each safely escaped.
    parsed = _run_script("query", INJECTION, 'ctx"x', "goal\\back")
    assert set(parsed) == {"query", "task_context", "goal"}
    assert parsed["query"] == INJECTION
    assert parsed["task_context"] == 'ctx"x'
    assert parsed["goal"] == "goal\\back"


def test_context_injection_is_contained():
    parsed = _run_script("context", INJECTION, 'p","evil":"1')
    assert set(parsed) == {"name", "file_path"}
    assert parsed["name"] == INJECTION
    assert parsed["file_path"] == 'p","evil":"1'
    assert "evil" not in parsed and "x" not in parsed


def test_context_optional_file_path_omitted():
    assert _run_script("context", "validateUser") == {"name": "validateUser"}


def test_impact_injection_is_contained_and_keeps_default_direction():
    parsed = _run_script("impact", INJECTION)
    assert parsed == {"target": INJECTION, "direction": "upstream"}


def test_impact_explicit_direction_preserved():
    parsed = _run_script("impact", "AuthService", "downstream")
    assert parsed == {"target": "AuthService", "direction": "downstream"}


def test_cypher_injection_is_contained():
    parsed = _run_script("cypher", NEWLINE_INJECTION)
    assert parsed == {"query": NEWLINE_INJECTION}
    assert "y" not in parsed


def test_payload_builders_do_not_interpolate_values_into_json():
    """No helper-based builder may hand-roll a JSON string with a shell var.

    The injection-safe contract is that argument values reach json.dumps as
    argv data. Guard against a regression that reintroduces ``\\"$var\\"`` style
    interpolation into the payload string.
    """
    for key in ("query", "context", "impact", "cypher"):
        builder = TOOL_SPECS[key].payload_builder
        assert tool_registry.PAYLOAD_HELPER_TOKEN in builder, key
        # The old vulnerable pattern interpolated a shell var inside an escaped
        # JSON string, e.g. payload="{\"query\": \"$query\"".
        assert '\\"$' not in builder, f"{key} interpolates a shell var into JSON"


def test_helper_is_rendered_only_when_needed():
    render = GitNexusDockerEnvironment._render_tool_script
    # Tools that build a body from arguments get the helper definition.
    for key in ("query", "context", "impact", "cypher"):
        assert tool_registry.PAYLOAD_HELPER_TOKEN in render(TOOL_SPECS[key], "4848")
    # The static-body and no-body tools don't carry the helper.
    assert tool_registry.PAYLOAD_HELPER_TOKEN not in render(TOOL_SPECS["overview"], "4848")
    assert tool_registry.PAYLOAD_HELPER_TOKEN not in render(TOOL_SPECS["augment"], "4848")

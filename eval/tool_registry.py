from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple


@dataclass(frozen=True)
class ToolScriptSpec:
    key: str
    bin_name: str
    endpoint: str | None
    payload_builder: str
    fallback: str
    header: str | None = None


# JSON request bodies for the container tool scripts are built with this helper
# rather than by interpolating shell variables into a hand-written JSON string.
#
# Why: the script arguments originate from the evaluated agent and are
# semi-untrusted. A value containing ``"``, ``\`` or a newline would break out
# of a hand-built JSON string and inject extra keys (same class as the eval
# bridge finding). The generated scripts run inside SWE-bench (Python-based)
# Docker images where ``python3`` is reliably present but ``jq`` is not, so we
# build the body with ``python3`` + ``json.dumps``.
#
# The Python program below is a *fixed* string: the only thing it references
# from the shell are positional argv elements (``sys.argv[1:]``). The untrusted
# values are passed as separate argv arguments — never interpolated into the
# Python source or into a JSON string literal — so they can only ever reach the
# payload as JSON-escaped *data*. Each pair of argv elements is ``key value``;
# keys are emitted by us (trusted), values are the agent-supplied bytes.
#
# ``_json_payload <key> <value> [<key> <value> ...]`` prints a single-line JSON
# object to stdout. Callers omit a key entirely to drop it (preserving the
# existing optional-field semantics).
#
# The renderer prepends this definition to any tool script whose payload_builder
# invokes ``_json_payload`` (see ``PAYLOAD_HELPER_TOKEN``).
JSON_PAYLOAD_FN = r'''_json_payload() {
python3 -c '
import json, sys
argv = sys.argv[1:]
obj = {argv[i]: argv[i + 1] for i in range(0, len(argv), 2)}
sys.stdout.write(json.dumps(obj))
' "$@"
}'''

# Marker the renderer greps for to decide whether a script needs JSON_PAYLOAD_FN.
PAYLOAD_HELPER_TOKEN = "_json_payload"


TOOL_METRIC_KEYS: Tuple[str, ...] = ("query", "context", "impact", "cypher", "overview")

TOOL_SPECS: Dict[str, ToolScriptSpec] = {
    "query": ToolScriptSpec(
        key="query",
        bin_name="gitnexus-query",
        endpoint="/tool/query",
        # Values arrive as argv to _json_payload (json.dumps), never
        # interpolated into the JSON, so a ", \ or newline cannot break out.
        # Optional fields are appended only when non-empty (prior behavior).
        payload_builder=r'''query="$1"; task_ctx="${2:-}"; goal="${3:-}"
[ -z "$query" ] && echo "Usage: gitnexus-query <query> [task_context] [goal]" && exit 1
set -- query "$query"
[ -n "$task_ctx" ] && set -- "$@" task_context "$task_ctx"
[ -n "$goal" ] && set -- "$@" goal "$goal"
payload="$(_json_payload "$@")"''',
        fallback='cd /testbed && npx gitnexus query "$query" 2>&1',
    ),
    "context": ToolScriptSpec(
        key="context",
        bin_name="gitnexus-context",
        endpoint="/tool/context",
        # Values are JSON-escaped by _json_payload (see "query"); file_path is
        # included only when non-empty (prior behavior).
        payload_builder=r'''name="$1"; file_path="${2:-}"
[ -z "$name" ] && echo "Usage: gitnexus-context <symbol_name> [file_path]" && exit 1
set -- name "$name"
[ -n "$file_path" ] && set -- "$@" file_path "$file_path"
payload="$(_json_payload "$@")"''',
        fallback='cd /testbed && npx gitnexus context "$name" 2>&1',
    ),
    "impact": ToolScriptSpec(
        key="impact",
        bin_name="gitnexus-impact",
        endpoint="/tool/impact",
        # Values are JSON-escaped by _json_payload (see "query"). direction
        # defaults to upstream, matching prior behavior.
        payload_builder=r'''target="$1"; direction="${2:-upstream}"
[ -z "$target" ] && echo "Usage: gitnexus-impact <symbol_name> [upstream|downstream]" && exit 1
payload="$(_json_payload target "$target" direction "$direction")"''',
        fallback='cd /testbed && npx gitnexus impact "$target" --direction "$direction" 2>&1',
    ),
    "cypher": ToolScriptSpec(
        key="cypher",
        bin_name="gitnexus-cypher",
        endpoint="/tool/cypher",
        # The value is JSON-escaped by _json_payload (see "query").
        payload_builder=r'''query="$1"
[ -z "$query" ] && echo "Usage: gitnexus-cypher <cypher_query>" && exit 1
payload="$(_json_payload query "$query")"''',
        fallback='cd /testbed && npx gitnexus cypher "$query" 2>&1',
    ),
    "overview": ToolScriptSpec(
        key="overview",
        bin_name="gitnexus-overview",
        endpoint="/tool/list_repos",
        header='echo "=== Code Knowledge Graph Overview ==="',
        # Static empty body — no arguments, so no injection surface.
        payload_builder='payload="{}"',
        fallback='cd /testbed && npx gitnexus list 2>&1',
    ),
    "augment": ToolScriptSpec(
        key="augment",
        bin_name="gitnexus-augment",
        endpoint=None,
        payload_builder="",
        fallback='cd /testbed && npx gitnexus augment "$1" 2>&1 || true',
    ),
}

BINARIES_BY_KEY: Dict[str, str] = {spec.key: spec.bin_name for spec in TOOL_SPECS.values()}
ENDPOINTS_BY_KEY: Dict[str, str | None] = {spec.key: spec.endpoint for spec in TOOL_SPECS.values()}

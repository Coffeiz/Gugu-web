# Agent Commands

This document describes the shared slash-command behavior. Commands use either ASCII / or full-width ／, and command names are case-insensitive across Web, QQ, WeChat, and Feishu.

## Command Groups

- /help, /stop, /status, /compact, /memory, /forget, /workspace, /unlimited, and /new are deterministic control commands handled before the main Agent loop.
- /goal <objective> creates or manages a persistent task and then enters the normal Agent runner.
- Shell remains unavailable unless the administrator enables it, the user grants it in tool permissions, and the session is bound to an enabled workspace.

## Safety

/stop is scoped to the task initiator. /workspace delete requires a preview and explicit confirmation. Destructive Shell commands require confirmation, run only within the bound workspace, and cannot use shell=True, command substitution, unrestricted redirection, or arbitrary host paths.

Commands must not be passed to the model as ordinary user content. Unknown or incomplete slash text continues through normal conversation handling.

When adding a command, update backend/agent/commands, backend/agent/router.py, help text, this document, and command regression tests together.

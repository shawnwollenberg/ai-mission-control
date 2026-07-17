# Claude Code adapter — next, not in the hackathon slice

Claude Code connects through the same authenticated HTTP contract used by Hermes:

- `GET /api/agents/hermes/assignments?missionId=...` is replaced with a Claude agent identity when that second adapter is approved.
- `POST /api/tasks/:taskId/claim` claims one assigned task exactly once.
- `POST /api/agent-events` accepts the versioned, vendor-neutral envelope.

The hook translates Claude lifecycle callbacks into canonical facts such as `task.started`, `artifact.created`, `check.completed`, `task.completed`, or `task.failed`. It must not submit raw prompts, private reasoning, tool payloads, API keys, or Claude-specific fields to Mission Control.

This document intentionally does not introduce a plugin registry, a second worker, or a generalized adapter framework. Claude Code is the second adapter only after the Hermes → Codex fixture path has passed live and fallback browser rehearsal.

# AGENTS.md merge proposal

Preserve the existing file. Consider adding this scoped section:

```markdown
# Project Brain

- Treat Git and repository documentation as the source of truth.
- Read `.project-brain/current-state.md` and only task-relevant knowledge before work.
- Separate observed facts from inferences and cite repository evidence.
- Store mission outcomes under `.project-brain/missions/`.
- Store new lessons under `.project-brain/lessons/proposed/`; never self-confirm them.
- Never store secrets, credential values, hidden reasoning, or raw model transcripts.
- Validate Project Brain YAML before completing work.
- Encode durable confirmed lessons in tests, scripts, skills, or policies when practical.
```

---
description: Skill-to-agent mapping for the Bridge harness. Each agent calls `skill("<name>")` to load stage-specific guidance.
source_refs: "harness-build-spec-3.md (§17), .opencode/skills/*/SKILL.md"
---

# Agent Skills Mapping

Per §17 of `harness-build-spec-3.md`, each stage loads the relevant skill via the `skill` tool. Skills live in `.opencode/skills/` and are loaded at runtime by the agent.

| Agent / Stage | Skills |
|---|---|
| **Intake** | `spec-driven-development`, `interview-me`, `idea-refine` |
| **Confirm** | _(mechanical — `question` tool)_ |
| **Ground** | `context-engineering`, `source-driven-development` |
| **Planner** | `planning-and-task-breakdown` |
| **Builder-junior** | `incremental-implementation`, `test-driven-development`, `frontend-ui-engineering` (UI tasks), `api-and-interface-design` (API tasks) |
| **Builder-senior** | `incremental-implementation`, `test-driven-development`, `code-review-and-quality`, `frontend-ui-engineering` (UI tasks), `api-and-interface-design` (API tasks) |
| **Test-engineer** | `test-driven-development` |
| **Critic** | `code-review-and-quality`, `doubt-driven-development`, `security-and-hardening` |
| **Verify (run)** | _(mechanical — no skill)_ |
| **Finalize** | `documentation-and-adrs` (knowledge write only) |
| **Bootstrap** | `spec-driven-development`, `documentation-and-adrs` |

## Usage

Each agent's prompt references its relevant skills. The agent invokes them via the `skill` tool:

```
You are the Intake agent. Use `skill("spec-driven-development")` for guidance on
producing clear acceptance criteria, and `skill("interview-me")` to refine
ambiguous requirements.
```

## Progressive Disclosure

Skills use progressive disclosure (SKILL.md → references). This mirrors the `knowledge/index.md` → wiki-page pattern: load the entry point first; dive deeper only when needed.

Dropped from v2: `git-workflow-and-versioning` — git is the user's domain, not the harness's.

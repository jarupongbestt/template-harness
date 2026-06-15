# Bridge Harness Template

A self-improving, LLM-orchestrated development harness built on [opencode](https://opencode.ai). Clone it, run it, and the harness orchestrates your entire dev workflow — intake, context gathering, planning, implementation, testing, review, and merge — through specialized subagents.

## Prerequisites

- [opencode](https://opencode.ai) ≥ 1.17.7 (`curl -fsSL https://opencode.ai/install | bash`)
- [git](https://git-scm.com) ≥ 2.30
- An LLM provider configured in opencode (run `/connect` in the TUI)

## Quick start

```bash
# Use this repo as a GitHub template, or clone it directly
git clone <your-repo> my-project
cd my-project

# Start opencode — the Conductor agent loads automatically
opencode
```

That's it. The Conductor (primary agent) is the default agent. Just describe your task in natural language.

## How it works

```
User message → CONDUCTOR → routes through subagents depending on task complexity
```

| Stage | What it does | When it fires |
|---|---|---|
| **Intake** | Reads your task + knowledge index → produces a Ticket with tier + acceptance criteria | Every task |
| **Ground** | Gathers focused context from wiki pages + code | Tier 1, Tier 2 |
| **Planner** | Decomposes complex tasks into thin vertical slices | Tier 2 only |
| **Builder** | Implements the task in an isolated git worktree | Every task (junior cheap, senior capable) |
| **Verify** | Runs scoped tests automatically via spine hooks | Every task |
| **Test-engineer** | Writes tests from criteria, never sees implementation | Tier 2 / critical |
| **Critic** | Independent code review + tautology audit + security check | Tier 2 |
| **Merge** | Atomic commit + knowledge self-improvement write | Every task |

### Tier system

The Conductor routes your task based on its complexity:

- **Tier 0** (easy — e.g. move a button): Intake → Builder-junior → Verify → Merge
- **Tier 1** (standard — e.g. add a feature): Intake → Ground → Builder-junior → Verify → Merge (escalates to senior on failure)
- **Tier 2** (complex — e.g. multi-currency support): Intake → Ground → Planner → per-slice loop [Test-engineer → Builder-senior → Verify → Critic] → Merge

## Key files

| File | Purpose |
|---|---|
| `harness-build-spec-2.md` | Full architecture spec — read this to understand the design |
| `AGENTS.md` | Maps agent stages to skills |
| `.opencode/agents/conductor.md` | The orchestrator agent (primary, loaded by default) |
| `.opencode/agents/intake.md` | Task intake & ticket generation |
| `.opencode/agents/ground.md` | Context gathering |
| `.opencode/agents/planner.md` | Task decomposition |
| `.opencode/agents/builder-junior.md` | Cheap model implementer |
| `.opencode/agents/builder-senior.md` | Capable model implementer |
| `.opencode/agents/test-engineer.md` | Independent test writer |
| `.opencode/agents/critic.md` | Code reviewer |
| `.opencode/plugins/spine.ts` | Passive hooks (intake gate, route floor, verify trigger) |
| `.opencode/tools/worktree.ts` | Git worktree isolation |
| `.opencode/tools/wiki_write.ts` | Knowledge wiki writer |
| `knowledge/index.md` | Navigation index — Intake pre-scans this every task |
| `knowledge/preflight.md` | Preflight checklist for your opencode version |

## Customizing for your project

1. **Run `/bootstrap`** (first time on an existing codebase) — the bootstrap command walks your repo structure and generates initial wiki pages and `knowledge/index.md` navigation hints.

2. **Update `knowledge/index.md`** — add Navigation Hints mapping your project areas to wiki pages. This is what Intake reads to constrain its scan scope.

3. **Commit the knowledge layer** — `knowledge/` and `opencode.json` should be committed. The knowledge grows with your project.

## Skills

The harness uses [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) for stage-specific guidance. Skills are in `.opencode/skills/` and loaded at runtime via the `skill` tool.

## Reference

- [harness-build-spec-2.md](./harness-build-spec-2.md) — full design document
- [opencode docs](https://opencode.ai/docs)

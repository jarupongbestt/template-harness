# Bridge Harness v4

A **self-improving, LLM-orchestrated development harness** built on [opencode](https://opencode.ai). Clone it, configure it, and the harness orchestrates your entire dev workflow — intake, planning, approval, implementation, testing, and review — through specialized subagents.

---

## Architecture

The pipeline for every task is:

```
User message → Conductor → Intake → Route → Planner → Approve → Builder → Verify → Finalize
```

| Stage | What it does | When it fires |
|---|---|---|
| **Conductor** | Primary orchestrator; loads on startup, routes tasks, manages the Approve gate | Always |
| **Intake** | Reads your task + knowledge index → produces a Ticket with tier, change_type, scope_hints, and acceptance criteria | Every task |
| **Route** | Selects planner model (junior/senior) and builder floor based on tier + confidence | Every task |
| **Planner** | **Always runs.** Self-grounds by reading wiki pages; produces an internal `task_list` (with `level` tags) + plain-language `user_summary` | Every task |
| **Approve** | A single checkpoint after the plan. Conductor calls `question` with exactly 2 options: **Proceed** or **Ask / adjust**. No edit happens before Proceed. | Every task |
| **Builder** | Implements per-task by the Planner's `level` tag — `easy` → Builder-junior, `hard` → Builder-senior. Edits in place, uncommitted. | Every task |
| **Verify** | Runs scoped tests automatically via spine hooks (passive — no subagent) | Every task |
| **Test-engineer-junior** | Writes tests from acceptance criteria only (Tier 0/1); never sees implementation | When test_subtask exists |
| **Test-engineer-senior** | Writes tests from acceptance criteria only (Tier 2); never sees implementation | When test_subtask exists |
| **Critic** | Independent code review + tautology audit + security check | Tier 2 only |
| **Finalize** | Scope audit + knowledge self-improvement write + STOP. No git, no merge. | Every task |

### Key differences from earlier versions

- **No Confirm stage** (removed in v4)
- **No Ground stage** (removed in v4)
- **Planner always runs** — planning is not skipped even for trivial tasks
- **Approve** is the single human gate after the plan
- **Builder** dispatches by task-level tag (`easy` → junior, `hard` → senior), not by tier alone
- **Verify** is passive — a spine hook, not a subagent
- **Test-engineer** (junior/senior) fires whenever the Planner emits a test_subtask — not just Tier 2
- **Builder is make-green only** — never writes tests (test-engineer is the sole test author)
- **Critic** runs at Tier 2 only
- **Tier 1 review**: Builder-senior reviews Builder-junior diffs (no Critic subagent)

---

## Tier system

Tier is a **model selector for the Planner** and a floor for the builder level:

| Tier | Description | Pipeline |
|---|---|---|
| **Tier 0** | Easy — e.g. rename a button | Planner-junior → Builder-junior |
| **Tier 1** | Standard — e.g. add a feature | Planner-junior (or senior if low confidence) → Builder-junior + senior reviews |
| **Tier 2** | Complex — e.g. multi-currency support | Planner-senior → per-slice loop [Test-engineer → Builder-senior → Verify → Critic] → Finalize |

---

## Git is the user's domain

v4 edits files **in place, uncommitted**. The harness never commits, merges, pushes, or creates branches.

The workflow ends at Finalize. You preview changes (e.g. `docker compose up`), then decide:
- **Keep** — `git commit` and `git push`
- **Discard** — `/undo` always works because nothing was ever committed by the harness

---

## Prerequisites

- [opencode](https://opencode.ai) ≥ 1.17.7 (`curl -fsSL https://opencode.ai/install | bash`)
- [git](https://git-scm.com) ≥ 2.30
- An LLM provider configured in opencode (run `/connect` in the TUI)
- Snapshots enabled in `opencode.json` (`"snapshot": true`)

---

## Quick start

```bash
# Use this repo as a GitHub template, or clone it directly
git clone <your-repo> my-project
cd my-project

# Start opencode — the Conductor agent loads automatically
opencode
```

Describe your task in natural language. The Conductor handles the rest.

---

## Model configuration

- `opencode.json` specifies per-agent model assignments (all agents currently use `opencode/deepseek-v4-flash-free`)
- `scripts/models.json` and `scripts/models.sh` provide interactive model swapping between **small** and **big** tiers:

  | Tier | Agents |
  |---|---|
  | **Small** | intake, planner-junior, builder-junior, test-engineer-junior |
  | **Big** | conductor, planner-senior, builder-senior, critic, test-engineer-senior |

---

## Key files

| File | Purpose |
|---|---|
| `harness-build-spec.md` | Full architecture spec (17 sections) |
| `AGENTS.md` | Maps agent stages to skills |
| `.opencode/agents/conductor.md` | Primary orchestrator agent |
| `.opencode/agents/intake.md` | Task intake & ticket generation |
| `.opencode/agents/planner-junior.md` | Junior planner (cheap model, easy tasks) |
| `.opencode/agents/planner-senior.md` | Senior planner (capable model, complex tasks) |
| `.opencode/agents/builder-junior.md` | Cheap model implementer |
| `.opencode/agents/builder-senior.md` | Capable model implementer + reviewer |
| `.opencode/agents/test-engineer-junior.md` | Independent test writer (junior, Tier 0/1) |
| `.opencode/agents/test-engineer-senior.md` | Independent test writer (senior, Tier 2) |
| `.opencode/agents/critic.md` | Independent code reviewer (Tier 2) |
| `.opencode/plugins/spine.ts` | Passive hooks plugin |
| `.opencode/tools/wiki_write.ts` | Knowledge wiki writer (only custom tool) |
| `.opencode/package.json` | Plugin dependency management |
| `.opencode/commands/bootstrap.md` | Bootstrap command for first-time setup |
| `scripts/models.json` | Model tier configuration |
| `scripts/models.sh` | Interactive model swapper |
| `knowledge/index.md` | Navigation index — Intake pre-scans every task |
| `knowledge/preflight.md` | Preflight checklist |
| `knowledge/runs.md` | Run history |
| `knowledge/test-impact.md` | Test-impact mapping |

---

## Customizing for your project

1. **Run `/bootstrap`** (first time on an existing codebase) — the bootstrap command walks your repo structure and generates initial wiki pages and `knowledge/index.md` navigation hints.
2. **Update `knowledge/index.md`** — add Navigation Hints mapping your project areas to wiki pages. This is what Intake reads to constrain its scan scope.
3. **Commit the knowledge layer** — `knowledge/` and `opencode.json` should be committed. The knowledge grows with your project.

---

## Skills

The harness uses [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) for stage-specific guidance. Skills live in `.opencode/skills/` and are loaded at runtime via the `skill` tool using **progressive disclosure** (SKILL.md → references).

15 skills are available, including:

- `planning-and-task-breakdown`
- `incremental-implementation`
- `test-driven-development`
- `karpathy-guidelines`
- `code-review-and-quality`
- `doubt-driven-development`
- `security-and-hardening`
- `frontend-ui-engineering`
- `api-and-interface-design`
- `source-driven-development`
- `spec-driven-development`
- `context-engineering`
- `documentation-and-adrs`
- `idea-refine`
- `interview-me`

---

## Conductor startup behavior

On first load, the Conductor checks whether `.opencode/node_modules/@opencode-ai/plugin` exists. If not, it runs `npm install` in `.opencode/` automatically.

The Conductor has `permission: question: allow` configured to enable the Approve gate.

---

## Gitignore

The root `.gitignore` excludes:

```
.harness/
.opencode/node_modules/
.DS_Store
Thumbs.db
```

The `.opencode/.gitignore` excludes:

```
node_modules
bun.lock
```

---

## Reference

- [`harness-build-spec.md`](./harness-build-spec.md) — full design document
- [`AGENTS.md`](./AGENTS.md) — skill-to-agent mapping
- [opencode docs](https://opencode.ai/docs)

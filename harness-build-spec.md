---
title: Harness Build Spec v4 — LLM-Orchestrated, Plan-First, In-Place, opencode-Native
kind: spec
provenance: verified
source_refs: "opencode docs (tools/question, config/snapshot, agents/permission, plugins), opencode issues #5894 #6396 #5910 #10589 #15877, github.com/addyosmani/agent-skills, github.com/multica-ai/andrej-karpathy-skills"
updated: 2026-06-22
links: knowledge/index.md
---

# Harness Build Spec v4

A self-improving, LLM-orchestrated development harness on opencode. Every task is
**planned, then approved by the user, then built** — intake, planning,
confirmation, implementation, testing, review — through specialized subagents,
editing files **in place and uncommitted** on the working tree.

If you read only three sections, read §3 (Preflight), §15 (Build Order), and §16
(Acceptance).

**Reading convention.** Every block is tagged:

- **[N]** NORMATIVE — build exactly this. Changing it changes behavior.
- **[I]** INFORMATIVE — rationale or example. Change freely.

---

## 1. The governing idea — [I]

opencode *is* an LLM harness. You do not bolt a code orchestrator onto it; you let
an LLM (the **Conductor**, a primary agent) orchestrate, and you back it with the
smallest possible **passive code spine** for the few guarantees an LLM can't be
trusted to keep.

**The one rule that decides where work runs:**
> **Real LLM work → a subagent with a clean, minimal, task-specific context —
> always, at every task size.** **Mechanical / decision step → passive code on the
> Conductor (no subagent).**

A small model doing intake + planning + the edit + verify-handling all in one
growing context window degrades and hallucinates. A fresh subagent seeded with only
the ticket and the few files in scope stays sharp. So intake, planning,
test-authoring, building, and review each run in their own subagent — even for a
trivial task. Routing and running tests are mechanical: they stay as passive code on
the Conductor.

**Plan first, every time.** Every task that writes or modifies code is planned by a
Planner subagent before any edit. The plan is the alignment artifact: it states the
problem, the intended approach, and a self-contained task list. Task size does not
decide *whether* to plan — it decides *which planner model* runs.

**The Conductor holds only distilled artifacts** — tickets, tier decisions, plans,
approval results, diff summaries, run outcomes — never raw file contents. That keeps
the orchestrator sharp across a long session, which matters most when the
orchestrator is a cheap model.

**One human checkpoint, by design.** After the plan is produced, the Conductor
presents it to the user as a **plain-language chat message** — the problem as the
harness understood it and what it intends to do, in everyday terms, **not** a dump of
code, file paths, or jargon — and then **waits.** Approval is conversational: the
user reads the plan and either tells it to proceed, or gives feedback / asks a
question. Feedback loops back to the Planner for a revised plan, which is presented
again, until the user says proceed. The build does not begin until then. This catches
the most expensive failure in the system — building the wrong thing, faithfully, and
only finding out at the end.

The plan content is never crammed into the `question` tool. The tool's only job here
is the short proceed decision (§8.3): the plan is the readable message; the proceed /
ask choice is a tiny two-option prompt beneath it. That short answer is
the one event the spine trusts to unlock editing — approval is never inferred from
free text.

**The harness does not own git.** It edits the working tree and runs tests. Commit,
push, merge, and rollback are the user's actions. The harness's only relationship to
git is **read-only** (`git diff`/`git status` to compute a run's changeset for
logging and scope-audit). This is the single most important boundary: it is what
keeps opencode's `/undo` reliable.

**Self-improvement** is the payoff over time: every run feeds the knowledge layer,
which narrows future scans and sharpens future routing. The first run is expensive;
the fiftieth is cheap.

---

## 2. Platform reality — [N]

Facts about opencode you MUST design around. Verified at build time by the Preflight
(§3), because they change. As of 2026-06:

| Capability | Reality | Consequence for placement |
| --- | --- | --- |
| Hooks on the **primary** agent (`tool.execute.before/after`, `chat.message`) | Fire reliably | Put passive guards here. Free (no tokens, no extra tool call). |
| Hooks on **subagent** tool calls | Do **not** fire (issue #5894) | Never rely on a hook to guard a subagent. |
| Per-agent `deny` permissions via SDK | Historically ignored (issue #6396) — re-verify | Don't enforce subagent limits with `deny`. Enforce by **not granting** the tool. |
| Custom tools (own `execute()`) | Subagent-safe | Reliable enforcement everywhere. Use sparingly. |
| Built-in `question` tool | Presents multiple-choice options (single/multi-select) + optional custom text; returns the user's selection | Use it **only** for the short two-option proceed / ask gate (§8.3) — never to carry the plan body. Call it from the **primary** Conductor (subagent reliability unverified — see Preflight). |
| `/undo` (session revert) | Restores the **working-tree snapshot** + trims session messages. Does **not** un-commit git. Snapshot scoped to the session dir; stale if files change outside opencode (#5910, #10589) | Keep all edits in-place and **uncommitted** so `/undo` stays coherent. The harness must never commit. |
| Snapshots | Enabled by config (`snapshot: true`) using an internal git repo | Must be **on** — it is the user's undo mechanism. |
| Per-agent `model` setting | Supported | This is how junior/senior planner and builder differ. |
| Skills via `AGENTS.md` + `skill` tool | Supported | Stage logic lives in skills, not hand-written prompts. |

**Placement codes:** **(P)** passive hook on the primary, **(T)** custom tool,
**(C)** opencode config / toolset construction, **(L)** LLM reasoning in a subagent,
**(Q)** built-in `question` tool on the primary.

---

## 3. Preflight — run before building — [N]

Do not write a line of the harness until these pass on *your* opencode version.
Record results in `knowledge/preflight.md`.

1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written. If it **does** fire on your version, you may move some guards to hooks — record that here.
3. **Custom tool runs from a subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write (the tool is absent, not merely denied).
5. **`question` tool works from the Conductor.** The primary agent calls `question` with 2 options + a custom-text field; the user's selection comes back as structured output. *(Optional: test from a subagent. If it fails there, the Approve gate MUST run on the primary — see §8.3.)*
6. **`/undo` restores an in-place edit.** A subagent edits a tracked file in the working dir; the user runs `/undo`; the file reverts.
7. **`/undo` → `/redo` round-trip.** After 6, `/redo` restores the edit exactly. If `/redo` lands on a stale state on your version (#5910/#10589), note it: git is the durable net, but warn the user that `/redo` is unreliable here.
8. **`snapshot: true` confirmed.** Config has snapshots enabled.
9. **`skill` tool resolves.** Install one addyosmani skill; the Conductor can invoke it.
10. **Per-agent model switch.** Two agent defs with different `model:` run on different models.

If any of 1–10 fail, fix the environment first — the rest of the spec assumes them.

---

## 4. Constraints & gotchas — read first — [N]

- Directories are **plural**: `.opencode/plugins/`, `.opencode/commands/`, `.opencode/agent/`.
- Wiki frontmatter must use **inline YAML only**. Write `source_refs: "a.md, b.md"`, never a YAML list.
- Session state (tier, intake-done flag, current builder level) is **in-memory `Map<sessionID, …>`**, never globals. The **`plan_approved` flag is keyed per task / starting turn id**, not per session, so it never carries over to the next requirement. Resets on restart — fine; the knowledge layer is the durable store.
- Never enforce a subagent limit with `deny`. Give the subagent a hand-built toolset instead.
- **Approve is one conversational checkpoint per task, from the Conductor only, after the plan.** The Conductor presents the plan in plain language and waits; the only structured part is a short two-option proceed / ask prompt via the `question` tool, granted to the Conductor alone — no subagent has it. A subagent that hits the approval gate **bounces to the Conductor, it does not ask.** The per-edit gate is a *silent boolean check*, not a repeated prompt (§8.3). Never put the plan body inside `question`; never let any stage but the Conductor's Approve step talk to the user about proceeding — that is how you get "asks at every step," or worse, "sometimes doesn't ask."
- **The harness never writes git.** No `commit`, `branch`, `merge`, `push`, `checkout`, `reset`, `restore`, `stash`, `worktree`, `rebase`, `cherry-pick` — from the Conductor or any subagent. Git **reads** (`diff`, `status`, `show`) are allowed for logging/scope-audit only.
- **The harness never calls `/undo` or `/redo`.** Those are user-only TUI commands. An agent invoking them corrupts its own session.
- **The workflow ends at Verify + Finalize.** There is no merge step. Surfacing the result and stopping *is* the end state.
- The spine has **exactly one plugin file and one custom tool** (`wiki_write`). Nothing else is code.

---

## 5. Requirements traceability — [N]

| # | Requirement | Satisfied by | Acceptance test |
| --- | --- | --- | --- |
| R1 | Project self-improvement | §13 loop; `log_outcome` + knowledge updates | A16.7 |
| R2 | Friendly cold start; knowledge grows with the project | §7; `/bootstrap`; per-run wiki writes | A16.5 |
| R3 | Existing codebase → create knowledge from code | §7.2 `/bootstrap` scan mode | A16.6 |
| R4 | Tests exist, or get created | §11 test layer + policy | A16.4 |
| R5 | Intake **and** Planner consult `knowledge/index.md` before scanning | §8.1, §8.4 knowledge pre-scan | A16.2 |
| R6 | **Shared understanding before any edit** — the user approves the plan | §8.3 Approve gate (`question` tool) | A16.3 |
| R7 | First run costs more; usage amortizes | §13 (measurable) | A16.7 |
| R8 | **No corruption; user owns git** — harness edits in place, never commits/merges; `/undo` always coherent | §10 execution model | A16.13, A16.14 |

---

## 6. Architecture overview — [N]

```
              +-----------------------------------------------+
user msg ---> |  CONDUCTOR  (primary agent = the orchestrator)|
              |  holds only distilled artifacts               |
              |  asks Approve; decides tier; fires subagents  |
              +-------+---------------------------------------+
   passive code on the Conductor:  ROUTE · APPROVE(question, once/task) · VERIFY(run tests) · FINALIZE
   spine (passive):  plugins/spine.ts · tool: wiki_write
                      |
   subagents (real LLM work, clean context, one task each):
       INTAKE · PLANNER-JUNIOR · PLANNER-SENIOR
       BUILDER-JUNIOR · BUILDER-SENIOR
       TEST-ENGINEER-JUNIOR · TEST-ENGINEER-SENIOR · CRITIC

   edits land IN PLACE on the working tree, UNCOMMITTED.
   git (commit/push/merge) and /undo,/redo are the USER's, after the harness stops.
```

- The **Conductor** is the only primary agent and the orchestrator. It is *not*
  code. It holds tickets, decisions, plans, approval results, and diff summaries —
  never raw bulk.
- **Subagents** do all real LLM work in isolated contexts. Each returns a distilled
  artifact.
- **Passive code** (ROUTE, APPROVE's `question` call, VERIFY's test-run, FINALIZE)
  and the **spine** are the only non-LLM parts.
- **There is no worktree and no merge.** Builders edit the working tree directly;
  the run's output is uncommitted changes the user reviews.

---

## 7. Cold start & bootstrap — [N] (R2, R3)

### 7.1 Fresh project (no code yet) — [N]
- The first task runs in **bootstrap mode**: no wiki to pre-scan, so Intake/Planner
  fall back to a broad scan. This is the one expensive case, and it is expected (R7).
- At Finalize, the run **writes its first wiki page(s)** plus a
  `knowledge/index.md` Navigation Hint. Knowledge is born alongside the code.

### 7.2 Existing codebase (`/bootstrap`) — [N] (R3)
- One-time command. The Conductor walks the repo (top-level dirs, manifests,
  entrypoints, test dirs) and **generates the initial knowledge layer from code**:
  * `knowledge/index.md` with Navigation Hints (`"Working on X? -> wiki pages [...]"`) from the directory layout.
  * One wiki page per major area, each with inline `source_refs:`.
  * `knowledge/test-impact.md` skeleton mapping test dirs to source dirs.
- Skills: `spec-driven-development`, `documentation-and-adrs`.
- **Checkpoint:** after `/bootstrap`, "where does auth live?" is answerable from
  `index.md` alone, no code scan (A16.6).
- `/bootstrap` writes knowledge files only. It does **not** commit them.

---

## 8. Stages & agents — [N]

The pipeline is: **Intake → (Clarify?) → Route → Planner → Approve → Builder → Verify →
Finalize.** Real-LLM stages are subagents; mechanical stages are passive code on the
Conductor. Two specialist subagents (Test-engineer, Critic) switch on at higher
tiers. **There is no Ground stage and no Merge stage.**

**Clarify** is an optional early checkpoint before Route: if Intake sets
`clarification_needed: true`, the Conductor surfaces the questions to the user.
No planning work happens until ambiguity is resolved.

### 8.1 Intake — [N] (R5) · SUBAGENT (cheap model)
- **In:** user message + `knowledge/index.md`. **Out:** distilled
  `{ restatement, target_refs:[{desc,file,locator}], candidates:[…], ambiguity, ticket, tier, change_type, confidence, scope_hints, touched_wiki_pages, acceptance_criteria, clarification_needed, clarification_questions }`.
- **Knowledge pre-scan (MUST):** read `index.md` → match Navigation Hints → read
  matched wiki page(s) → set `scope_hints` to those `source_refs`. This is a
  **light** triage scan, enough to set tier and list candidates — **not** a deep
  code read (that is the Planner's job). Broad scan only when no hint matches.

  **Bugfix exception — deeper scan (MUST):** when `change_type` is `bugfix`, Intake
  extends the light triage with a **root cause read** of the relevant source files.
  Do not guess at the cause; trace upstream from the symptom. Read code in
  `scope_hints` deeply enough to write a one-sentence root cause statement. The
  Planner uses this as its starting point; it does not re-discover the cause from
  scratch. If Intake cannot determine the root cause within a bounded effort
  (~2-3 code reads), it sets `confidence: "low"` and surfaces what it *did* find.

- **Clarification check (MUST):** before finalizing the Ticket, Intake evaluates
  whether the requirements are clear enough to plan from. This is a hard check —
  "clear enough" means Intake can state, without guessing, what the user wants, why,
  and what success looks like. When Intake is filling in blanks (inferring intent,
  guessing priority, assuming constraints), the requirements are NOT clear.

  If unclear, Intake sets `clarification_needed: true` and populates
  `clarification_questions` — short, focused questions the Conductor presents to the
  user **before** the Planner runs (§8.2a). Each question carries Intake's best
  guess so the user can react rather than generate from scratch. This saves the cost
  of a full planning cycle on an underspecified ask.

  If clear, `clarification_needed: false` and `clarification_questions` is empty.

- **Tier + confidence (MUST):** tier is the **model selector** for Planner /
  Builder / Test-engineer and the review depth. Rubric:
  * **Tier 0/1** — one or few pages, a known pattern, bounded blast radius.
  * **Tier 2** — complex / cross-cutting / greenfield / low confidence, **OR**
    load-bearing or sensitive: touches auth / money / data, sits on a primary user
    flow, or has many `depends_on` entries in test-impact.md. **Importance routes to
    Tier 2 even when the change is easy to write** — an easy-but-load-bearing change
    gets the senior test-engineer + Critic, because that is the code most damaging to
    get subtly wrong. Tier does not gate *whether* planning or testing happens.
- **Change type (MUST):** classify the task as `cosmetic | feature | bugfix | refactor`.
  This is **orthogonal to tier**: `change_type` decides *whether a test is written at
  all* (§11), tier decides *which test-engineer model writes it* and how heavy the
  review is. A new feature is a `feature` even when trivial, so it is always tested —
  small ≠ untested. Only `cosmetic` skips tests. Do not infer test policy from the
  tier number.
- **Acceptance criteria (MUST):** emit explicit, checkable criteria — the
  **independent source of truth** the tests anchor to (§11). Intake defines *what
  correct means*; the Planner defines *how* — keep them in separate agents or tests
  rubber-stamp the implementation.
- **Intake does not talk to the user.** Its `restatement` + `candidates` feed the
  Planner and, ultimately, the Approve gate. Its `clarification_questions` feed the
  Conductor's early clarification checkpoint (§8.2a).
- **Skill:** `spec-driven-development`, `idea-refine`, `root-cause-debugging` (for
  bugfix cause analysis and digging past surface symptoms), `interview-me` (for
  detecting ambiguity and composing clarification questions — compose text only; the
  Conductor does the asking).

### 8.2 Route — [N] · PASSIVE (Conductor, no LLM)
- Reads `tier` + `confidence`; selects the **planner model** and the **builder-level
  floor**:
  * high-confidence trivial → `planner-junior`, builder floor junior.
  * standard → `planner-junior` (or senior if confidence is low), per-task builder.
  * complex / cross-cutting / critical → `planner-senior`, builder floor senior.
- **Enforcement:** the route-floor hook (P) blocks any Builder dispatch before a
  plan exists and is approved. Conservative: when in doubt, route the planner up — a
  junior planner on a large scan is the one degradation locus.

### 8.2a Clarification checkpoint — [N] · PASSIVE (Conductor) — BEFORE the Planner runs

This is the **early clarification gate**. It fires between Intake and Route when
Intake sets `clarification_needed: true`. It costs nothing when the requirements are
clear (most tasks skip it), and saves a full planning cycle when they are not.

- **Trigger:** `clarification_needed: true` on the Ticket.
- **The Conductor presents Intake's `clarification_questions`** — one at a time, each
  with the guess Intake attached — to the user via normal chat messages. Use the
  `interview-me` skill format: one question per turn, with a confidence number.
- **No plan, no Planner, no code reads** happen during clarification. The
  Conductor's sole job here is to resolve the ambiguity.
- **Resolution:** when the user's answers raise confidence enough that Intake's
  original ambiguity is resolved, the Conductor **re-runs Intake** with the user's
  answers folded in, producing a refined Ticket with `clarification_needed: false`.
  Then proceed to Route → Planner normally.
- **If the user cannot clarify:** ("I don't know, just do something reasonable") —
  the Conductor records the ambiguity explicitly in the Ticket, sets Tier 2 (low
  confidence), and routes to planner-senior with a note that the plan must name
  assumptions clearly so the Approve gate can catch them.
- **This is an internal Conductor-only step.** The Planner never sees the
  clarification exchange — only the refined Ticket.

### 8.3 Approve — [N] (R6) · CONVERSATIONAL on Conductor + short `question` gate (Q) — **ONE CHECKPOINT PER TASK, AFTER THE PLAN**

This is the single human-alignment checkpoint. It happens here, right after the
Planner returns — **not** at Intake, not at Builder, not per task, not in any
subagent. It has two parts, in this order: **present the plan in plain language**,
then a **short structured proceed prompt.**

**Part 1 — present the plan as a plain-language message.**
- The Conductor posts the Planner's `user_summary` (§8.4) as a normal chat message
  and **ends its turn / waits.** The summary is written for a human: the problem as
  understood, what the harness intends to do, and the steps in everyday words.
- **No code dumps, no file-path soup, no jargon.** A long machine task list with
  `file:line` locators and `level` tags is the *internal* artifact the Conductor uses
  to dispatch builders (§8.5) — it is **not** what the user sees. If the user wants
  detail they can ask; the default presentation is short and readable.

**Part 2 — the short proceed gate (the only structured part).**
- After (or alongside) the plain summary, the Conductor calls `question` with a
  **short** prompt — no plan body inside it, just the decision:

  > **Question:** Proceed with this plan?
  > **Options:**
  > 1. ▶ Proceed
  > 2. 💬 Ask / adjust — *(type your question or change here)*

- **Exactly two options.** "Proceed" and "Ask / adjust" cover the whole decision:
  either the user is satisfied and the build starts, or they are not — and *any*
  not-yet kind (a clarifying question, a correction, "you misunderstood," a tweak)
  is the same branch. Keep the custom text field on option 2 so the user types their
  feedback in the same step. Do not split this into three or more options.
- `question` is **granted to the Conductor (primary) only.** No subagent ever has it,
  so asking is structurally single-site — it can never silently fail to ask, never
  ask twice, and approval can never be inferred from free text.
- **Proceed** → the Conductor records `plan_approved:true` keyed to the **task**; the
  plan locks and the build begins.
- **Ask / adjust** → it stays in the planning loop (below). `plan_approved` stays
  false, so the spine keeps every edit blocked.

**The conversational loop — stay in planning until Proceed.**
- On "ask / adjust," the Conductor relays the user's feedback to the Planner,
  which produces a **revised plan**; the Conductor presents the new plain-language
  summary and the short proceed prompt **again.** This repeats until the user picks
  Proceed. There is no edit, and no build, anywhere in this loop.
- A plain answerable question (no plan change needed) is answered directly, then the
  proceed prompt is re-offered.

**The gate is a silent check downstream, not a repeated ask.**
- The enforcement hook (§12) checks the per-task boolean `plan_approved?` on **every**
  source `edit`/`write` attempt. **Silent and free:** if `true`, the edit passes with
  no prompt. The check firing on every edit is *not* asking on every edit — the
  proceed prompt happens once per accepted plan; the check just reads the flag.
- Once `plan_approved:true`, **every Builder, Test-engineer, and Critic passes the
  gate silently and never asks.**

**Subagents never ask — they bounce.**
- If a subagent hits the gate while `plan_approved` is false, the hook does **not**
  tell it to ask — it has no `question` tool. It tells it to **stop and bounce up to
  the Conductor.** Only the Conductor asks.

**Re-present only when the plan changes.**
- A Builder bouncing up because "this is bigger than the plan" → re-Plan → present
  the revised plan and re-offer Proceed. `plan_approved` resets for the revised plan.
- Per-task work within an approved plan → **no re-prompt.**

**Run from the primary** unless Preflight #5 proved subagent `question` works (and
even then, keep it on the Conductor — single site is the design).

### 8.4 Planner — [N] (R5) · SUBAGENT (always), two model levels, self-grounding
- **Fires every task.** Two agent defs: **planner-junior** (cheap) and
  **planner-senior** (capable), same skills, different `model:`.
- **Self-grounds (MUST):** in order —
  1. Read `knowledge/index.md` → follow `scope_hints` from Intake to the matched wiki
     page(s). No full re-scan.
  2. Read code within `scope_hints.source_refs` only — the deep read needed to plan.
  3. **Read `knowledge/test-impact.md`** for every source file in scope. Two passes:

     **Pass A — direct test lookup (skip / extend / create):**
     ```
     source file in test-impact.md, for the new case's acceptance criteria?
       ├─ covered already, AND the `covers` annotation matches the new criteria
       │     → NO test_subtask  → no test-engineer is spun for this case (skip)
       ├─ test file exists but does NOT cover the new case
       │     → test_subtask.action = "extend"   → test-engineer spun
       └─ no entry at all
             → test_subtask.action = "create"   → test-engineer spun
     ```
     **Skip is real cost savings:** when coverage already exists, no test gets
     written and no test-engineer subagent is dispatched — the task is build +
     regression-run only. As the project's coverage grows, more feature work hits the
     skip path; this is the amortization in R7. **But trust `test-impact.md` only when
     the `covers` annotation actually matches the new case's acceptance criteria** —
     a source-file-name match alone is not enough. If `covers` is vague or doesn't
     clearly cover the new criteria, treat it as "does not cover" → `extend`.

     **Pass B — reverse dependency lookup (regression scope):**
     For each source file being changed, find **all other test files** in
     test-impact.md whose `depends_on` annotation includes that file or any
     function/export it exposes. These are tests for code that *calls* the thing
     being changed — they must be included in the Verify run even though their source
     files are not directly edited. Collect them into `regression_tests` on the task.
     If a regression test's coverage looks like it might break from the change (based
     on the code read in step 2), flag it as `regression_risk: true` so Verify pays
     attention to its result.

     Without Pass B, "fix calculateTax()" only runs `tax.test.ts` and misses
     `checkout.test.ts` and `invoice.test.ts` which both call calculateTax() —
     the change could break them silently.
- **Decompose (MUST):** produce two distinct outputs.
  * **Internal `task_list`** — the machine plan the Conductor dispatches from: each
    task self-contained with dependency order. **The user never sees this raw.**
    Schema per task:
    ```
    { desc, files, level: easy|hard, acceptance,
      test_subtask?: {
        action: "create" | "extend",
        file: "tests/x.test.ts",
        anchors: ["case A", "case B"]   // from acceptance criteria, not implementation
      },
      regression_tests?: [              // from Pass B — tests for callers/dependents
        { file: "tests/checkout.test.ts", regression_risk: true },
        { file: "tests/invoice.test.ts",  regression_risk: false }
      ]
    }
    ```
    **Test subtask rule (MUST):** for a task where `change_type` is `feature` or
    `bugfix`, the Planner emits a `test_subtask` **unless Pass A found the case
    already covered** (then it is omitted and the test-engineer is skipped). Presence
    of a `test_subtask` is the **sole trigger** that spins a test-engineer (§8.8) —
    no test_subtask, no test author. `action: extend` if the test file exists;
    `action: create` if not. The Builder never authors the test (§8.5).
  * **`user_summary`** — a short, plain-language explanation for the human (§8.3):
    problem as understood + what will be done, in everyday words. No code, no
    `file:line`, no `level` tags, minimal jargon. This is the only thing presented
    at Approve.
- **Skill:** `planning-and-task-breakdown`, `context-engineering`,
  `source-driven-development`, `interview-me`. The Planner never calls `question`.

### 8.5 Builder — [N] · SUBAGENT (always), two model levels, make-green only
- Two agent defs: **builder-junior** (cheap) and **builder-senior** (capable). Same
  skills, different `model:`.
- **Dispatch per task by the Planner's `level` tag**, at or above the tier's builder
  floor: an `easy` task → junior (unless the tier floor is senior); a `hard` task →
  senior. The Conductor reads `level` and dispatches accordingly.
- **In:** the approved task + its acceptance criteria + `change_type` + the scoped
  **source** files + the **already-written failing test** (from the test-engineer,
  §8.8). **Out:** the source edits (in place) + a short diff summary. The Conductor
  never sees raw file contents.
- **Make-green only — the Builder never writes or edits tests (MUST).** The test
  arrives red, authored independently by the test-engineer. The Builder's single job
  is to write source code that makes that red test green, honestly — implementing the
  behavior the test demands, **never weakening, deleting, or gaming the test to pass.**
  Removing test-authoring from the Builder is what eliminates "rubber-stamp with
  yourself": the agent writing the code cannot also shape the bar it must clear.
- **If the Builder believes the test is wrong, it MUST NOT touch it.** It stops and
  bounces up for adjudication (§8.8) — it has no write access to the test dir to do
  otherwise.
- **Edits land directly on the working tree, uncommitted.** No worktree, no branch,
  no commit.
- **Stay in scope (MUST):** Builder edits **only** source files in the task's
  `files`/`scope_hints`. To touch a file outside scope, it **stops and bounces up**.
- **Escalation (MUST):** see the make-green loop in §8.8 — same-level retry, then
  senior, then adjudication. Retry edits **in place**; no git reset. **Before any
  retry, the Builder MUST perform root cause analysis** using the `root-cause-debugging`
  skill: identify the causal chain from symptom to source before writing new code.
  A retry without a stated root cause is not a retry — it is guessing, and it is
  blocked. The bounce-up evidence must include the root cause chain. If the change is
  bigger than the plan claimed, the Builder **stops and bounces up** for a re-Plan.
- **Skill:** `incremental-implementation`, `test-driven-development` (green-phase
  discipline only — make the red test pass properly), `karpathy-guidelines`,
  + `frontend-ui-engineering` (UI) / `api-and-interface-design` (APIs).
- **Enforcement:** Builder subagents get a **constructed toolset** (C):
  `read`/`edit`/`write` on **source dirs only**, `read` on test dirs (to see what it
  must satisfy) but **no write to test dirs**, `read`-only git; **no raw write to
  `knowledge/`**, **no write-capable git**, **no `task`**, **no `question`**.
  Containment by non-grant — the no-test-write rule is structural, not a guideline.

### 8.6 Verify — [N] (R4)
Two separate concerns:
- **(a) Run tests — PASSIVE primary hook (P), NOT a subagent.** Three layers, in
  order:
  1. **Direct tests:** `test_subtask.file` — the test the test-engineer just wrote or
     extended for this task.
  2. **Regression tests:** all files listed in `task.regression_tests` — tests for
     callers and dependents identified by the Planner in Pass B. These run even
     though their source files were not directly edited. Any file with
     `regression_risk: true` gets its failure surfaced prominently.
  3. **Fallback:** if neither list exists (impact map is empty / cold start), run
     the full suite.
  Mechanical: run, read exit code, surface result. A regression_risk failure is
  treated the same as a direct test failure — Builder must fix before proceeding.
- **(b) Code review — tier-scaled, per slice (not end-of-task):**
  * **Tier 0:** none. The test/smoke pass is the gate.
  * **Tier 1:** **builder-senior reviews builder-junior's diff** (lightweight).
  * **Tier 2:** an independent **Critic** subagent (§8.8), per slice.
- Review runs at each atomic slice boundary (~100 lines).

### 8.7 Finalize — [N] (R1, R2) · PASSIVE / MECHANICAL (Conductor) — **the end of the workflow**
**Does no git.** On a green Verify:
1. **Scope audit.** Compute `git diff --name-only` (read-only). If any touched file
   is outside the plan's declared scope, **surface it to the user** ("this run also
   modified `docker-compose.yml` — expected?") rather than hiding it.
2. **Self-improvement write** (§13): `log_outcome` + `wiki_write` updates +
   **`test-impact.md` update (MUST)**. For every `test_subtask` that ran this
   session, write or update the `source → test file` entry:
   - `action: create` → add a new row.
   - `action: extend` → verify the row already exists (it should); update the
     `covers` annotation if the anchors added new cases.
   This is what keeps the Planner's test-impact.md check accurate on the next run.
   If this step is skipped, the next Planner will create duplicate tests or miss
   existing coverage — exactly what the check is there to prevent.
3. **Surface the result and STOP.** Tell the user, plainly:
   > Done. Changes are in your working tree, uncommitted. Preview with
   > `docker compose up`. Keep them and they're yours to `git commit`/`push` when
   > ready; or run `/undo` to discard this run.
4. The harness takes **no further action.** Commit, push, merge, and rollback are
   the user's.
- **Skill:** `documentation-and-adrs` (knowledge write only). Git workflow is the
  user's, not the harness's.

### 8.8 Test-engineer — [N] · SUBAGENT (independent), two model levels

**The independent test author for the whole harness — the Builder never writes
tests.** Independence cannot be faked inside one agent ("I'll write the test first
and promise not to peek at the code I'm about to write") — same context window, same
recall, so the test ends up shaped to the implementation anyway. The only enforceable
independence is **a separate context**, i.e. a separate subagent. So all tests are
authored here.

- **Two agent defs:** **test-engineer-junior** (cheap) and **test-engineer-senior**
  (capable), same skills, different `model:` — mirroring the planner/builder pair.
- **Trigger:** **a task carries a `test_subtask`** (§8.4). That is the only trigger.
  No `test_subtask` (cosmetic, or Pass A found the case already covered) → no
  test-engineer is spun.
- **Model by tier:** Tier 0/1 → test-engineer-junior. Tier 2 / load-bearing →
  test-engineer-senior, and the Critic (§8.9) audits afterward. Tier selects the
  model and the review depth, **not** whether a test author exists.
- **Writes from the acceptance criteria only**, and **never sees the plan or the
  implementation** — the anti-rubber-stamp guarantee. Output is a **red** test
  (fails before the code exists).
- Coverage scales with model: junior → happy path + key edge/error cases; senior →
  + concurrency + boundary values per the `test-driven-development` skill matrix.
- **Tests are real project files** written into the test directory, in place and
  uncommitted (§10). After the user commits, they are permanent regression tests,
  found by future Verify runs via `test-impact.md`.
- **Skill:** `test-driven-development` (+ `test-engineer` persona).

#### 8.8.1 The make-green loop and test adjudication — [N]

The test is authored independently and the Builder cannot edit it — so a *badly
written* test (asserts the wrong value, expects behavior that contradicts the
criteria) would deadlock: the Builder writes correct code, the test stays red, and
the Builder either spins forever or starts deforming the code to satisfy a wrong
test. There must be a path back to fix the test — **but it must not become a back
door to rubber-stamping** (Builder declares "test is wrong" whenever its code fails).
So the loop has a gate: the Builder may *claim* the test is wrong but cannot *decide*
it; a fresh test-engineer adjudicates against the acceptance criteria.

**Loop 1 — Builder make-green (inside the build step).**
```
test-engineer writes test (red)  →  builder makes green
  ├─ green                                   → slice passes
  ├─ red, after root cause analysis shows real progress
  │     → builder retries with targeted fix (same level, one retry only)
  │     → if still red, escalate (junior → senior), then retry once more
  └─ STOP and bounce up when EITHER:
        • 3 reds in a row, OR
        • the identical error twice (no progress — don't burn a 3rd try),
        OR
        • the Builder cannot state a root cause after one attempt (guessing)
     Builder bounces to the Conductor with evidence:
        the root cause chain (cause → cause → symptom) ·
        the diff it wrote · value got vs value the test expected ·
        the acceptance criterion it believes it satisfied
     (escalation: the 2nd failing try escalates builder-junior → builder-senior
      before the bounce, so a mis-tagged "easy" task gets the stronger model first)
```

**Root cause before retry (MUST):** the Builder's first action on a red test is NOT
to change code. It is to run `root-cause-debugging`: trace the failure upstream to
the source of the discrepancy (wrong assumption, missing edge case, misunderstood
criteria, actual implementation error). The retry code then targets that root cause
— not the symptom in the error message. A bounce without a stated root cause is
invalid and is rejected by the Conductor (the Builder runs again with an explicit
instruction to dig deeper).
The Builder **never edits the test** to escape this loop — it has no test-dir write.

**Loop 2 — adjudication (a fresh test-engineer, context-isolated).**
The Conductor spawns a **new** test-engineer (not the one that wrote the test — that
one would defend its own work) to judge **the test against the acceptance criteria**,
not against the Builder's code:
```
fresh test-engineer adjudicates:
  ├─ test is wrong (contradicts criteria)   → fix the test → back to Loop 1
  ├─ test is right, Builder misread it       → return to Builder with a clarifying note
  └─ the criteria themselves are ambiguous   → bounce to the USER (re-open Approve, §8.3)
```
Adjudication runs **once**. If the slice still will not go green after one
adjudication round, **bounce to the user** — because a test that a fresh author
confirmed against the criteria, plus a Builder that still can't satisfy it, almost
always means the *acceptance criteria* are ambiguous or self-contradictory. That is a
requirement-level problem only the user can resolve; looping the two agents further
just burns tokens.

**Hard cap (anti-runaway).** Across one task, if total cycles (build attempts +
adjudications) exceed **~2 full cycles**, force a bounce to the user regardless of
sub-loop state — a backstop so counting a sub-loop wrong can't run away.

### 8.9 Critic — [N] · SUBAGENT (independent reviewer), Tier 2 / high-risk only
- Reviews the slice's diff **and the test** — auditing the test for tautology ("does
  this verify the requirement, or just assert what the code does?").
- Adds `security-and-hardening` when the slice touches auth, input, storage, or
  external calls.
- Earns a subagent for **independence** (fresh context).
- **Skill:** `code-review-and-quality`, `karpathy-guidelines`,
  `doubt-driven-development` (+ `security-and-hardening`).

---

## 9. Tiers, the orchestrator decision, and the two flows — [N]

Tier is a **model selector**, not a stage gate: every task is planned and approved.

| | Easy (Tier 0) | Standard (Tier 1) | Complex / load-bearing (Tier 2) |
| --- | --- | --- | --- |
| Intake | subagent | subagent | subagent |
| Route | passive → junior planner | passive → junior planner | passive → senior planner |
| **Planner** | **junior, subagent** | **junior, subagent** | **senior, subagent** |
| **Approve** | **always: prose plan + short gate** | **always: prose plan + short gate** | **always: prose plan + short gate** |
| Test author (if `test_subtask`) | **test-engineer-junior** | **test-engineer-junior** | **test-engineer-senior** |
| Builder (make-green) | per-task level (junior floor) | per-task level | per-task level (senior floor) |
| Verify (run tests) | passive hook | passive hook | passive hook, per slice |
| Code review | none | senior reviews junior | Critic subagent, per slice |
| Finalize | log + stop | log + stop | log + stop |

When in doubt, route up — under-routing breaks things (expensive rework);
over-routing wastes a few tokens (cheap). The test author is always the independent
test-engineer; tier only picks its model. If Pass A found the case already covered,
there is **no `test_subtask`** and no test-engineer runs — build + regression only.

### Cosmetic task (Tier 0) — e.g. "rename the Save button label"
```
1. INTAKE          [subagent · cheap] index.md -> frontend.md -> light scan
     out: target_refs + tier:0 + change_type:cosmetic + scope_hints + acceptance criteria
2. ROUTE           [passive] Tier 0 -> planner-junior · builder floor junior
3. PLANNER-JUNIOR  [subagent] reads ~2 files -> 1-task task_list (NO test_subtask) + plain user_summary
4. APPROVE         [Conductor] post user_summary as normal message, WAIT      <-- ALWAYS
     "I'll rename the Save button label on the settings screen. Proceed?"
     short question gate: [Proceed] [Ask / adjust]   ·   Proceed -> plan_approved:true
5. BUILDER-JUNIOR  [subagent] edit source in place · smoke check only · return diff
     (no test_subtask -> no test-engineer spun)
6. VERIFY          [passive hook] smoke/render check
7. FINALIZE        [passive] scope audit · log_outcome · STOP
```

### Feature task, coverage already exists (skip path) — e.g. "add 'select all' next to existing bulk-delete"
```
1. INTAKE          [subagent] index.md -> list.md -> Tier 1 · change_type:feature
2. ROUTE           [passive] planner-junior · builder floor junior
3. PLANNER-JUNIOR  [subagent] Pass A: tests/list.test.ts covers "bulk selection" already
                   -> NO test_subtask for that case  ·  Pass B: collect regression_tests
4. APPROVE         [Conductor] post user_summary, WAIT · [Proceed] -> plan_approved:true
5. BUILDER-JUNIOR  [subagent] implement · edit source in place      (no test-engineer spun)
6. VERIFY          [passive hook] run existing direct + regression tests via test-impact.md
7. FINALIZE        [passive] scope audit · log_outcome · STOP
```

### Feature/bugfix task, new coverage needed (Tier 0/1) — e.g. "add a 'mark all as read' button"
```
1. INTAKE          [subagent] index.md -> notifications.md -> Tier 1 · change_type:feature
2. ROUTE           [passive] planner-junior · builder floor junior
3. PLANNER-JUNIOR  [subagent] Pass A: not covered -> test_subtask{create} · Pass B: regression_tests
                   -> task_list + plain user_summary
4. APPROVE         [Conductor] post user_summary, WAIT                         <-- ALWAYS
     "I'll add a Mark All as Read button that clears all unread items. Proceed?"
     [Proceed] -> plan_approved:true
5. TEST-ENG-JUNIOR [subagent · independent] criteria only, never sees plan/code -> red test
6. BUILDER-JUNIOR  [subagent] make-green (source only, cannot touch test)
     red 3x or identical-error 2x -> escalate senior -> still stuck -> adjudicate (§8.8.1)
7. VERIFY          [passive hook] direct + regression tests
     review: builder-senior reviews builder-junior diff (Tier 1, lightweight)
8. FINALIZE        [passive] scope audit · log_outcome + update test-impact.md (covers + depends_on) · STOP
```

### Difficult / load-bearing task (Tier 2) — e.g. "add multi-currency support to portfolio P&L"
```
1. INTAKE          [subagent] index.md -> calc/display/storage -> cross-cutting -> Tier 2, low conf
2. ROUTE           [passive] planner-senior · builder floor senior
3. PLANNER-SENIOR  [subagent] deep read + Pass A/B -> thin slices (test_subtask + regression each) + user_summary
4. APPROVE         [Conductor] post plain-language summary, WAIT               <-- ALWAYS
     "Here's how I'll add multi-currency to your P&L, in 3 steps..." (no code/paths)
     [Proceed] -> plan_approved:true   (feedback -> re-plan -> re-present loop)
5. PER-SLICE LOOP  (S1 -> S2 -> S3):
     a. TEST-ENG-SENIOR [subagent · independent] tests from criteria; never sees implementation
     b. BUILDER         [subagent] dispatched by slice.level · make-green · source only
        (stuck -> escalate -> adjudicate §8.8.1 -> bounce to user if criteria ambiguous)
     c. VERIFY (tests)  [passive hook] slice direct + regression tests
     d. CRITIC          [subagent · independent] review diff + audit test for tautology + security
     slice green -> next slice
6. FINALIZE        [passive] scope audit · log_outcome + wiki + test-impact.md (covers + depends_on) · STOP
```

---

## 10. Execution model: in-place, uncommitted; the user owns git — [N] (R8)

**Edits are in place and uncommitted.**
- Builders edit files directly on the working tree. There is no worktree, no branch,
  no commit. The "isolation" guarantee is **temporal, not spatial**: the user
  reviews before anything is committed.

**The harness never writes git.**
- Forbidden for the Conductor and all subagents: `commit`, `branch`, `merge`,
  `push`, `checkout`, `reset`, `restore`, `stash`, `worktree`, `rebase`,
  `cherry-pick`.
- Allowed: **read-only** git (`git diff`, `git status`, `git show`) for computing a
  run's changeset.
- Enforced by the constructed toolset and an edit-only discipline on the Conductor.

**The user owns the full git lifecycle.**
- **Preview:** `docker compose up` (or any local run) reflects the change immediately.
- **Discard:** `/undo` (native opencode) restores the working-tree snapshot. It works
  cleanly **because nothing was committed.**
- **Redo:** `/redo` restores the change (reliability varies by version — Preflight #7).
- **Keep / commit / push / merge:** entirely the user's manual git actions.

**The point-of-no-return for `/undo` is the user's commit.** `/undo` is valid only
while the run's changes are uncommitted. After commit, the correct rollback is
`git revert`/`git reset`, performed by the user. Because the harness never commits,
this boundary is always under the user's explicit control.

**Pre-run cleanliness guard (P).** Before Intake edits anything, the spine checks
`git status`. If the working tree is dirty, the Conductor asks via `question`:
*"You have uncommitted changes. Commit or stash them first so `/undo` only affects
this run?"*

**Single-stream interactive by design.** Edits land on one working tree with no
spatial isolation, so the default is **sequential** per-task building. Parallelize
only tasks the Planner certifies as file-disjoint; batch/headless parallelism is a
separate mode built on `opencode serve` + ephemeral clones, out of scope here.

---

## 11. Test layer & testing policy — [N] (R4)

**Two orthogonal axes — keep them separate.**
- **Does a test get written?** Decided by `change_type` (from Intake) **and** Pass A
  coverage. `feature`/`bugfix` with no existing coverage → yes; `cosmetic` → no;
  already-covered case → no (skip — build + regression only).
- **Who writes it, and how heavy is review?** Decided by tier. The author is **always
  the independent test-engineer** (never the Builder); tier only selects
  junior vs senior model and whether the Critic audits. Independence of authorship is
  constant; rigor scales with tier.

**Impact map.** `knowledge/test-impact.md` is the routing table that maps
`source file/dir -> test file(s)`. It serves two purposes:
- **Verify:** runs direct tests + regression tests (callers/dependents) automatically.
- **Planner:** reads it before composing `test_subtask` — Pass A for create/extend
  decision, Pass B for regression scope.

Each entry carries two annotations so the Planner can reason without opening test
files:
- `covers` — what cases the test directly checks (for Pass A).
- `depends_on` — which source files/functions this test exercises indirectly, i.e.
  it calls them (for Pass B reverse lookup).

```
# test-impact.md example
src/tax.ts       -> tests/tax.test.ts       # covers: exempt items, 2dp rounding, null input
src/checkout.ts  -> tests/checkout.test.ts  # covers: cart total, discount logic
                                            # depends_on: src/tax.ts::calculateTax
src/invoice.ts   -> tests/invoice.test.ts   # covers: PDF generation, line items
                                            # depends_on: src/tax.ts::formatTaxLine
```

When Planner changes `src/tax.ts`, Pass B finds `checkout.test.ts` and
`invoice.test.ts` via their `depends_on` annotations → both go into
`regression_tests` on the task → Verify runs them automatically.

Finalize maintains it every run: new test → add row with `covers`; extended test →
update `covers`; if a new dependency is discovered during the build (Builder touched
a file not in scope) → add `depends_on` annotation. If this is stale, Pass B misses
regressions.

**Where tests live.** Tests are written as real files **into the project's test
directory**, in place and uncommitted like all other edits (§10). Once the user
commits the run, they become a permanent part of the regression suite — every future
run's Verify can pick them up via the impact map. The harness does not keep tests in
a scratch area; they accrete in the repo.

**When tests are created — keyed off `change_type` + Pass A coverage.**
- **`bugfix` → always, first.** A failing test reproducing the bug (the Prove-It
  pattern), authored by the test-engineer, then the Builder fixes to green. Every tier.
- **`feature` → yes, unless already covered.** A red test written first from the
  criteria; the Builder makes it green. If Pass A finds the case already covered, no
  new test and no test-engineer — build + regression only.
- **`refactor` → no new tests.** Existing tests must still pass (run as regression).
- **`cosmetic` → smoke/render check or nothing.** No `test_subtask`, no test-engineer.

**Independence (anti-rubber-stamp).** The danger is the definition of "correct" and
the implementation coming from the same reasoning. So:
- "Correct" is defined **upstream** by Intake as acceptance criteria — independent of
  the plan and the build — and **approved by the user** (§8.3) before any build,
  closing the gap tests can't cover: a *wrong* plan.
- The **test-engineer** (a separate subagent, §8.8) writes every test from the
  criteria, never seeing the plan or implementation. The **Builder makes it green and
  cannot edit the test** (no test-dir write). Same enforcement at every tier — only
  the test-engineer's model and the Critic audit scale with tier. This is the only
  form of independence that holds: separate context, not a same-agent promise.
- If a test looks wrong, it is **adjudicated by a fresh test-engineer against the
  criteria** (§8.8.1), never silently changed by the Builder. Unresolvable after one
  adjudication → the criteria are the problem → bounce to the user.

Cold start / `/bootstrap`: seed `test-impact.md` from existing test dirs.

---

## 12. The spine — the only code — [N]

One plugin, one custom tool. Nothing else is code.

**`.opencode/plugins/spine.ts`** — passive hooks on the primary Conductor (all (P),
all free):
- `chat.message`: detect language, stash in session state (observation only).
- `tool.execute.before`: **pre-run cleanliness gate** — on the first source-touching
  action of a task, if `git status` is dirty, signal the Conductor to ask the user
  to commit/stash first (§10).
- `tool.execute.before`: **plan-approved gate** — a **silent per-task boolean
  check** on every source `edit`/`write`/mutating-`bash`. Read `plan_approved[taskId]`:
    * `true` → **pass silently, no prompt** (the common case; free; must never ask).
    * `false` and actor is the **Conductor** → block, "present the plan and run the
      short proceed gate before editing."
    * `false` and actor is a **subagent** → block, "not approved — stop and return
      control to the Conductor" (subagents have no `question` tool; they bounce).
  Key the flag to the **task / starting turn id**, not the session — it resets on
  each new requirement. Exempt `knowledge/` and `wiki_write`. **The flag is set only
  by the Conductor recording a `Proceed` answer to the short proceed gate (§8.3) —
  never defaulted, never inferred from free-text chat.** This is what makes "present
  plan as a normal message and wait" safe: the readable plan is just text, but the
  unlock is a structured event the spine can trust.
- `tool.execute.before` on `task`/`edit`: **route-floor gate** — block any Builder
  dispatch before a plan exists and is approved.
- `tool.execute.before` on `bash`: **git-write guard** — block any mutating git
  subcommand; allow read-only git. Enforces §10 even if a subagent's toolset is
  misconfigured.
- `tool.execute.after` on Builder's edits: **verify trigger** — run scoped tests;
  surface pass/fail to the Conductor.

**Custom tool (T):**
- `wiki_write(page, frontmatter, body)` — the only way to write `knowledge/`;
  enforces inline-YAML; subagent-safe. `log_outcome` is folded into it.

**Planner-level and builder-level selection, escalation, and the Approve presentation
are Conductor logic, not code.** The verify-trigger hook only reports pass/fail; the
Conductor decides junior-retry vs senior-escalation, posts the Planner's
`user_summary` as plain text, and runs the short proceed gate. **The `question` tool
is granted to the Conductor only — no subagent toolset includes it — and is used only
for the short two-option proceed / ask prompt, never to carry the plan.** No git tool,
no subagent hook, no `deny`.

---

## 13. Self-improvement loop — [N] (R1, R7)

At every Finalize:
1. `log_outcome` appends `{ task, tier, planner_level, builder_levels, files, tests, duration, tokens, learnings }` to `knowledge/runs.md`.
2. The Conductor writes/updates the relevant **wiki page** via `wiki_write`: new
   patterns, gotchas, corrected `source_refs`.
3. It refines `knowledge/index.md` Navigation Hints when a task reveals a better
   mapping.

Effect over N runs: scans **narrow**, routing **sharpens**, briefs **shrink**.
Per-task token cost falls with usage. Measurable via A16.7.

---

## 14. Directory layout — [N]

```
.opencode/
  agent/
    conductor.md                          # primary orchestrator
    intake.md                             # subagent (triage + criteria)
    planner-junior.md planner-senior.md   # subagents, differ only by model:
    builder-junior.md builder-senior.md   # subagents, differ only by model:
    test-engineer-junior.md test-engineer-senior.md  # independent test authors, by tier
    critic.md                             # independent reviewer (Tier 2)
  plugins/
    spine.ts                              # the only plugin
  tools/
    wiki-write.ts                         # the only custom tool
  commands/
    bootstrap.md                          # /bootstrap (§7.2)
knowledge/
  index.md <area>.md test-impact.md runs.md preflight.md
AGENTS.md                                 # installs skills; points stages at them
```

---

## 15. Build order with checkpoints — [N]

Do not pass a checkpoint until its assertion holds.

1. **Preflight (§3).** PASS 1–10.
2. **Spine: plan-approved hook.** PASS a raw source `edit` is blocked before
   `plan_approved:true`; allowed after. Per-task: a new requirement resets it.
3. **Spine: git-write guard.** PASS a `git commit`/`merge`/`checkout` from any agent
   is blocked; `git diff`/`status` allowed.
4. **`wiki_write` + `index.md` seed.** PASS a wiki page round-trips with inline
   frontmatter intact.
5. **Intake subagent + light pre-scan.** PASS "rename button" sets `scope_hints` to
   ≤ the matched page's source dir; the Conductor receives only the distilled object;
   acceptance criteria are emitted.
6. **Planner subagent + self-ground + per-task level tags.** PASS the Planner reads
   code only within `scope_hints`, returns a self-contained task list with
   `level` tags and the Approve content; no `index.md` re-scan.
7. **Approve gate — plain message + two-option gate, Conductor only, after the plan.**
   PASS the plan is presented as a **plain-language message** (no code/jargon dump);
   the structured `question` has **exactly two** options (Proceed / Ask-or-adjust) and
   fires from the **Conductor** only; picking "Ask / adjust" loops back to a re-Plan
   and re-presents (no edit in any pre-Proceed round); `plan_approved` is set **only**
   by a Proceed answer, never inferred from chat text; once approved, Builders/Critic
   issue **zero** prompts; no subagent toolset contains `question`. A second task in
   the same session asks again (per-task flag).
8. **Route + tiers + model pick.** PASS Tier 0 picks planner-junior + builder floor
   junior; Tier 2 picks planner-senior + builder floor senior and blocks Builder
   until the plan is approved.
9. **Builder subagents + per-task dispatch + in-place edits.** PASS a plan with one
   `easy` + one `hard` task dispatches junior + senior respectively; a Builder
   cannot raw-write `knowledge/` or write git; a Verify failure escalates junior →
   senior after one retry; edits appear uncommitted in the working tree.
10. **Verify split.** PASS test-run is a passive hook (no subagent); Tier 2 review is
    an independent Critic subagent per slice.
11. **Test-engineer is the sole test author + make-green loop.** PASS for a
    feature/bugfix task with no existing coverage, the test was written by an
    **independent test-engineer subagent** (junior at Tier 0/1) that did not see the
    plan or implementation, and the **Builder could not write to the test dir**; a
    deliberately wrong test triggers **adjudication by a fresh test-engineer** (not the
    original), and an unresolvable case after one adjudication **bounces to the user**.
    A task whose case is already covered (Pass A) runs **no** test-engineer.
12. **Finalize + self-improvement write + stop.** PASS a new/updated wiki page and a
    `runs.md` entry exist; the harness performs no git and ends with the
    "uncommitted, your turn" message.
13. **Undo coherence.** PASS after a run, `/undo` reverts exactly that run's changes;
    `/redo` restores them (or is flagged unreliable per Preflight #7).
14. **`/bootstrap`.** PASS on an existing repo, `index.md` answers "where does X
    live?" with no code scan.
15. **Acceptance suite (§16).** PASS all green.

---

## 16. Acceptance suite — [N]

The build is **done** only when all pass. Drive via the TUI.

- **A16.1 — intake-first.** Non-English message. Assert: a normalized English Ticket
  exists AND the reply is in the user's language.
- **A16.2 — knowledge pre-scan (R5).** Seed a wiki page for area X; task in X.
  Assert: the Planner's files read ⊆ X's `source_refs`.
- **A16.3 — approve gate: plain message + two-option gate, always (R6).** Two tasks:
  one trivial, one with two matching buttons in scope. Assert: the plan was delivered
  as a **plain-language chat message** (no `file:line`/code dump), **after the
  Planner**; the structured `question` had **exactly two** options (Proceed / Ask-or-
  adjust); the ambiguous one's summary named the candidate it chose; **no edit
  occurred before** the user picked Proceed.
- **A16.3c — the planning loop.** A task where the user picks "Ask / adjust" with
  feedback, then Proceed on the next round. Assert: the Planner re-ran and a revised
  plain summary was presented; the two-option gate re-fired; **no edit happened in any
  pre-Proceed round**; the build started only after Proceed.
- **A16.3b — single asking site; downstream silent.** A Tier 2 task approved on the
  first round. Assert: `question` was called by the **Conductor only** and **once per
  accepted plan** (here, once); Planner/Builder/Critic produced **zero** prompts; no
  subagent toolset contains `question`; approval was never inferred from free chat
  text. A second task asks again (per-task flag).
- **A16.4 — test policy (R4).** Four checks: (a) a Tier 0 **feature** with no existing
  coverage → the **test-engineer** (not the Builder) wrote a real red test first, then
  the Builder made it green; (b) a bug fix (any tier) → a failing test reproducing the
  bug, then fix to green; (c) a cosmetic change → no `test_subtask`, no test-engineer,
  no unit test manufactured; (d) a feature whose case Pass A finds already covered →
  **no test-engineer spun**, build + regression only.
- **A16.5 — cold start (R2).** Empty `knowledge/`, one task. Assert: a wiki page +
  an `index.md` hint now exist (uncommitted).
- **A16.6 — bootstrap (R3).** `/bootstrap` on a repo with code. Assert: "where does X
  live?" answered from `index.md`, zero code scan.
- **A16.7 — amortization (R1, R7).** Same class of task 5×, logging tokens. Assert:
  tokens-per-task trends down.
- **A16.8 — always-plan + planner-is-subagent.** A trivial task. Assert: a Planner
  ran (planner-junior, not senior); the plan + scan stayed in the Planner subagent
  (Conductor context did not accumulate file contents).
- **A16.9 — per-task builder dispatch.** A plan with one `easy` + one `hard` task.
  Assert: the easy task ran on builder-junior, the hard one on builder-senior, within
  one approved plan.
- **A16.10 — subagent containment.** A Builder attempts raw `write` to `knowledge/`.
  Assert: it cannot; it uses `wiki_write` or escalates.
- **A16.11 — model escalation.** Force a junior Verify failure twice. Assert: the
  task escalates to builder-senior with the failure context.
- **A16.12 — independence + adjudication, not rubber-stamp.** (a) A Tier 0 feature →
  assert the test was authored by the **independent test-engineer** subagent and the
  Builder's toolset has **no write to the test dir**. (b) Plant a wrong test → assert
  the Builder **bounces** (does not edit the test), a **fresh** test-engineer
  adjudicates against criteria, and the wrong test is fixed there. (c) Plant
  contradictory acceptance criteria → assert that after one adjudication the task
  **bounces to the user**, not into an infinite agent loop. The Critic flags a
  deliberately tautological test.
- **A16.13 — per-slice review.** A multi-slice Tier 2 task. Assert: review ran at
  each slice boundary, not once at the end.
- **A16.14 — no git writes (R8).** Run any task. Assert: `git log` unchanged, no new
  branch, working tree holds the changes uncommitted, final message hands git to the
  user.
- **A16.15 — scope audit / no clobber (R8).** A task scoped to file X; inject an
  attempt to also rewrite `docker-compose.yml`. Assert: the Builder bounces up OR
  Finalize surfaces the out-of-scope file — never silently changed.
- **A16.16 — undo coherence.** After a completed run, `/undo`. Assert: exactly that
  run's changes revert; an untouched file is unaffected.
- **A16.17 — dirty-tree guard.** Start a task with pre-existing uncommitted changes.
  Assert: the harness asks (via `question`) to commit/stash before proceeding.

---

## 17. Skills referenced — [N]

From `github.com/addyosmani/agent-skills` (install via `AGENTS.md` + the `skill`
tool), except `karpathy-guidelines` (from
`github.com/multica-ai/andrej-karpathy-skills`).

| Agent / stage | Skill(s) |
| --- | --- |
| Intake | `spec-driven-development`, `idea-refine`, `root-cause-debugging` (bugfix cause analysis), `interview-me` (clarification questions) |
| Route | — (mechanical) |
| Clarification checkpoint | — (mechanical: Conductor presents Intake's questions) |
| Planner (junior/senior) | `planning-and-task-breakdown`, `context-engineering`, `source-driven-development`, `interview-me` |
| Approve | — (mechanical: `question` tool) |
| Builder (junior/senior) | `incremental-implementation`, `test-driven-development` (green-phase only — make the red test pass, never edit it), `karpathy-guidelines`, `frontend-ui-engineering` (UI), `api-and-interface-design` (APIs) |
| Verify (run) | — (mechanical) |
| Test-engineer (junior/senior) | `test-driven-development` (+ `test-engineer` persona) |
| Critic | `code-review-and-quality`, `karpathy-guidelines`, `doubt-driven-development` (+ `security-and-hardening`) |
| Finalize | `documentation-and-adrs` (knowledge write only) |
| Bootstrap | `spec-driven-development`, `documentation-and-adrs` |

`karpathy-guidelines` is the **anti-over-engineering** default: minimum code,
surgical changes, every changed line traces to the request. It biases caution over
speed, so apply judgment on trivial tasks rather than rigidly — a behavioral default,
not a hard gate. Add a structural check (review rubric, diff-size signal) later only
**if** the skill alone proves insufficient.

The skills' **progressive disclosure** design (SKILL.md is the entry point;
references load only when needed) is the same token discipline as the knowledge
`index.md` → wiki-page pattern, and as keeping each subagent's seeded context tight.
Reuse it.

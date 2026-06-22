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
       BUILDER-JUNIOR · BUILDER-SENIOR · TEST-ENGINEER · CRITIC

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

The pipeline is: **Intake → Route → Planner → Approve → Builder → Verify →
Finalize.** Real-LLM stages are subagents; mechanical stages are passive code on the
Conductor. Two specialist subagents (Test-engineer, Critic) switch on at higher
tiers. **There is no Ground stage and no Merge stage.**

### 8.1 Intake — [N] (R5) · SUBAGENT (cheap model)
- **In:** user message + `knowledge/index.md`. **Out:** distilled
  `{ restatement, target_refs:[{desc,file,locator}], candidates:[…], ambiguity, ticket, tier, change_type, confidence, scope_hints, touched_wiki_pages, acceptance_criteria }`.
- **Knowledge pre-scan (MUST):** read `index.md` → match Navigation Hints → read
  matched wiki page(s) → set `scope_hints` to those `source_refs`. This is a
  **light** triage scan, enough to set tier and list candidates — **not** a deep
  code read (that is the Planner's job). Broad scan only when no hint matches.
- **Tier + confidence:** one page + one dir + known pattern + high confidence → low
  tier; multiple pages / cross-cutting / greenfield / no match / low confidence →
  high tier. Tier is a **model selector** for the Planner and a builder-level floor
  — it does not gate *whether* planning happens.
- **Change type (MUST):** classify the task as `cosmetic | feature | bugfix | refactor`.
  This is **orthogonal to tier**: tier decides *who* writes the test and how much
  review (risk axis); `change_type` decides *whether a test is written at all*
  (§11). A new feature is a `feature` even when it is trivial, so it is always
  tested — small ≠ untested. Only `cosmetic` skips tests. Do not infer test policy
  from the tier number.
- **Acceptance criteria (MUST):** emit explicit, checkable criteria — the
  **independent source of truth** the tests anchor to (§11). Intake defines *what
  correct means*; the Planner defines *how* — keep them in separate agents or tests
  rubber-stamp the implementation.
- **Intake does not talk to the user.** Its `restatement` + `candidates` feed the
  Planner and, ultimately, the Approve gate.
- **Skill:** `spec-driven-development`, `idea-refine`.

### 8.2 Route — [N] · PASSIVE (Conductor, no LLM)
- Reads `tier` + `confidence`; selects the **planner model** and the **builder-level
  floor**:
  * high-confidence trivial → `planner-junior`, builder floor junior.
  * standard → `planner-junior` (or senior if confidence is low), per-task builder.
  * complex / cross-cutting / critical → `planner-senior`, builder floor senior.
- **Enforcement:** the route-floor hook (P) blocks any Builder dispatch before a
  plan exists and is approved. Conservative: when in doubt, route the planner up — a
  junior planner on a large scan is the one degradation locus.

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
- **Self-grounds (MUST):** reads the wiki pages Intake named, then code **only
  within `scope_hints` source_refs** — the deep context read needed to plan. No
  `index.md` re-scan (Intake already did it and handed over `scope_hints`).
- **Decompose (MUST):** produce two distinct outputs.
  * **Internal `task_list`** — the machine plan the Conductor dispatches from: each
    task self-contained (`{ desc, files, level: easy|hard, acceptance }`), with
    dependency order. For a trivial change it is one task; for a complex change, thin
    vertical slices. **The user never sees this raw.**
  * **`user_summary`** — a short, plain-language explanation for the human (§8.3,
    Part 1): the problem as understood and what will be done, in everyday words.
    **No code, no `file:line` locators, no `level` tags, minimal jargon.** This is the
    only thing presented at Approve.
- **Skill:** `planning-and-task-breakdown`, `context-engineering`,
  `source-driven-development`, `interview-me` (for the plain-language summary and for
  formulating clarification when confidence is low). The Planner never calls
  `question` — it produces text; the Conductor presents it and runs the gate.

### 8.5 Builder — [N] · SUBAGENT (always), two model levels, per-task dispatch
- Two agent defs: **builder-junior** (cheap) and **builder-senior** (capable). Same
  skills, different `model:`.
- **Dispatch per task by the Planner's `level` tag**, at or above the tier's builder
  floor: an `easy` task → junior (unless the tier floor is senior); a `hard` task →
  senior. The Conductor reads `level` and dispatches accordingly.
- **In:** the approved task + its acceptance criteria + the scoped files. **Out:**
  the edits (in place) + a short diff summary. The Conductor never sees raw file
  contents.
- **Edits land directly on the working tree, uncommitted.** No worktree, no branch,
  no commit.
- **Stay in scope (MUST):** Builder edits **only** files in the task's
  `files`/`scope_hints`. If it must touch a file outside scope, it **stops and
  bounces up** rather than silently editing it.
- **Escalation (MUST):** on a Verify failure, the **same level** retries once. Fail
  again → **escalate to builder-senior** with the failure context. This is the
  safety net for a mis-tagged "easy" task. Retry edits **in place**; no git reset.
  If the change is bigger than the plan claimed, the Builder **stops and bounces
  up** to request a re-Plan.
- **Skill:** `incremental-implementation`, `test-driven-development`,
  `karpathy-guidelines`, + `frontend-ui-engineering` (UI) / `api-and-interface-design`
  (APIs).
- **Enforcement:** Builder subagents get a **constructed toolset** (C):
  `read`/`edit`/`write` on source, `read`-only git; **no raw write to `knowledge/`**,
  **no write-capable git**, **no `task`**, **no `question`**. Containment by
  non-grant.

### 8.6 Verify — [N] (R4)
Two separate concerns:
- **(a) Run tests — PASSIVE primary hook (P), NOT a subagent.** On the files Builder
  touched, run the **scoped** tests (touched files ∩ `test-impact.md`). Mechanical:
  run, read exit code, surface result. Falls back to the full suite only when the
  impact map is empty.
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
2. **Self-improvement write** (§13): `log_outcome` + `wiki_write` updates.
3. **Surface the result and STOP.** Tell the user, plainly:
   > Done. Changes are in your working tree, uncommitted. Preview with
   > `docker compose up`. Keep them and they're yours to `git commit`/`push` when
   > ready; or run `/undo` to discard this run.
4. The harness takes **no further action.** Commit, push, merge, and rollback are
   the user's.
- **Skill:** `documentation-and-adrs` (knowledge write only). Git workflow is the
  user's, not the harness's.

### 8.8 Test-engineer — [N] · SUBAGENT (independent), Tier 2 / critical only
- Writes tests **from the acceptance criteria**, and **never sees the plan or
  implementation** — the anti-rubber-stamp guarantee. The Builder then makes them
  pass.
- **Fires:** Tier 2, or any task touching auth / money / data, per slice. Lower
  stakes → the Builder writes its own tests (§11).
- **Skill:** `test-driven-development` (+ `test-engineer` persona).

### 8.9 Critic — [N] · SUBAGENT (independent reviewer), Tier 2
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

| | Easy (Tier 0) | Standard (Tier 1) | Complex (Tier 2) |
| --- | --- | --- | --- |
| Intake | subagent | subagent | subagent |
| Route | passive → junior planner | passive → junior planner | passive → senior planner |
| **Planner** | **junior, subagent** | **junior, subagent** | **senior, subagent** |
| **Approve** | **always: prose plan + short gate** | **always: prose plan + short gate** | **always: prose plan + short gate** |
| Who writes the test | builder (or none, cosmetic) | builder | independent test-engineer |
| Builder | per-task level (junior floor) | per-task level | per-task level (senior floor) |
| Verify (run tests) | passive hook | passive hook | passive hook, per slice |
| Code review | none | senior reviews junior | Critic subagent, per slice |
| Finalize | log + stop | log + stop | log + stop |

When in doubt, route up — under-routing breaks things (expensive rework);
over-routing wastes a few tokens (cheap).

### Easy task (Tier 0) — e.g. "rename the Save button label"
```
1. INTAKE          [subagent · cheap] index.md -> frontend.md -> light scan
     out: restatement + target_refs + candidates + tier:0 + scope_hints + acceptance criteria
2. ROUTE           [passive] Tier 0 -> planner-junior · builder floor junior
3. PLANNER-JUNIOR  [subagent] reads ~5 files in scope_hints -> 1-task task_list + plain user_summary
4. APPROVE         [Conductor] post user_summary as normal message, WAIT      <-- ALWAYS
     "I'll rename the Save button label on the settings screen. Proceed?"
     short question gate: [Proceed] [Ask / adjust]
     feedback -> re-plan -> re-present (loop); Proceed -> plan_approved:true (edits blocked until here)
5. BUILDER-JUNIOR  [subagent] edit in place (cosmetic -> smoke check) · return diff summary
6. VERIFY (tests)  [passive hook] scoped/smoke · PASS -> on · FAIL -> 1 retry -> senior
     review: none
7. FINALIZE        [passive] scope audit · log_outcome (+ touch frontend.md) · STOP
```

### Difficult task (Tier 2) — e.g. "add multi-currency support to portfolio P&L"
```
1. INTAKE          [subagent] index.md -> calc/display/storage pages -> cross-cutting -> Tier 2, low conf
     out: restatement + target_refs + scope_hints + acceptance criteria
2. ROUTE           [passive] planner-senior · builder floor senior
3. PLANNER-SENIOR  [subagent] deep read within scope_hints -> thin slices (each tagged easy|hard) + plain user_summary
4. APPROVE         [Conductor] post plain-language summary, WAIT               <-- ALWAYS
     "Here's how I'll add multi-currency to your P&L, in 3 steps..." (no code/paths)
     short question gate: [Proceed] [Ask / adjust]
     feedback -> re-plan -> re-present (loop); Proceed -> plan_approved:true
5. PER-SLICE LOOP  (S1 -> S2 -> S3):
     a. TEST-ENGINEER  [subagent · independent] tests from criteria; never sees implementation
     b. BUILDER        [subagent] dispatched by slice.level · make the slice pass · edit in place
     c. VERIFY (tests) [passive hook] run the slice's scoped tests
     d. CRITIC         [subagent · independent] review diff + audit test + security
     slice green -> next slice
6. FINALIZE        [passive] scope audit across all slices · log_outcome + update wiki + index hints · STOP
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
- **Does a test get written?** Decided by `change_type` (from Intake), *not* by tier.
  A feature or bug fix is always tested, however small; a cosmetic change is not.
- **Who writes it, and how hard is it reviewed?** Decided by tier / risk. Low risk →
  the Builder writes its own test. High risk → an independent test-engineer does.

**Impact map.** `knowledge/test-impact.md` is the routing table that maps
`source file/dir -> test file(s)` — i.e. which tests exercise which code. It is **not**
a description of what each test checks (that lives in the test's own descriptive
name). Verify uses it to run only the relevant tests: it intersects the files the
Builder touched with the map → a scoped run instead of the whole suite. Finalize
maintains it: when a run adds a new test, it adds/updates the `source -> test` entry.

**Where tests live.** Tests are written as real files **into the project's test
directory**, in place and uncommitted like all other edits (§10). Once the user
commits the run, they become a permanent part of the regression suite — every future
run's Verify can pick them up via the impact map. The harness does not keep tests in
a scratch area; they accrete in the repo.

**When tests are created — keyed off `change_type`.**
- **`bugfix` → always, first.** A failing test reproducing the bug, then fix to green
  (the Prove-It pattern). Non-negotiable, at every tier.
- **`feature` → always.** Tests for the new behavior, written first from the criteria
  (red → green). Applies at Tier 0/1 too — a trivial new feature still gets a test;
  the Builder writes it.
- **`refactor` → no new tests.** Existing tests must still pass.
- **`cosmetic` → smoke/render check or nothing.** The only case that legitimately
  skips real tests.

**Independence (anti-rubber-stamp).** The danger is the definition of "correct" and
the implementation coming from the same reasoning. So:
- "Correct" is defined **upstream** by Intake as acceptance criteria — independent of
  the plan and the build — and **approved by the user** (§8.3) before any build,
  closing the gap tests can't cover: a *wrong* plan.
- **Low stakes (Tier 0/1):** the Builder writes the test **first, from the criteria**
  (red), then the code (green). Same person, but still test-first.
- **Critical (Tier 2, or auth/money/data):** an **independent test-engineer** subagent
  writes the tests from the criteria, never seeing the plan or implementation. The
  Builder only makes them pass. This independence is the expensive part — it is what
  tier-gates, not the existence of tests.
- **Always (non-trivial):** the Critic audits the test for tautology — a test that
  cannot fail proves nothing.

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
    test-engineer.md critic.md            # specialist subagents (Tier 2 / critical)
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
11. **Test-engineer independence.** PASS for a critical task, the test author is a
    separate subagent that did not see the plan or implementation.
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
- **A16.4 — test policy (R4).** A bug fix → a failing regression test before the fix,
  then passes. A cosmetic change → no unit test manufactured.
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
- **A16.12 — test independence + tautology audit.** A Tier 2 critical task. Assert:
  tests authored by the test-engineer subagent; the Critic flags a deliberately
  tautological test.
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
| Intake | `spec-driven-development`, `idea-refine` |
| Route | — (mechanical) |
| Planner (junior/senior) | `planning-and-task-breakdown`, `context-engineering`, `source-driven-development`, `interview-me` |
| Approve | — (mechanical: `question` tool) |
| Builder (junior/senior) | `incremental-implementation`, `test-driven-development`, `karpathy-guidelines`, `frontend-ui-engineering` (UI), `api-and-interface-design` (APIs) |
| Verify (run) | — (mechanical) |
| Test-engineer | `test-driven-development` (+ `test-engineer` persona) |
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

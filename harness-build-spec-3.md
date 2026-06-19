---
title: Harness Build Spec v3 — LLM-Orchestrated, In-Place, opencode-Native
kind: spec
provenance: verified
source_refs: "harness-build-spec-2.md, opencode docs (tools/question, config/snapshot, agents/permission, plugins), opencode issues #5894 #6396 #5910 #10589 #15877, github.com/addyosmani/agent-skills"
updated: 2026-06-19
links: knowledge/index.md
---

# Harness Build Spec v3

This spec produces a working harness on the **first build**. It is *self-verifying*: it ships with a preflight you run before building and an acceptance suite that must go green before the build is "done." If you read only three sections, read §3 (Preflight), §15 (Build Order), and §16 (Acceptance).

**Reading convention.** Every block is tagged:

- **[N]** NORMATIVE — build exactly this. Changing it changes behavior.
- **[I]** INFORMATIVE — rationale or example. Change freely.

**What changed from v2 (read this first) — [I]**

v2 ran each task in a git worktree and auto-merged it into `main`. That design caused three failures in practice:

1. **Merge corruption** — a run branched off a stale base, then merge clobbered a file (e.g. `docker-compose.yml`) that a previous run had changed.
2. **Intake/user mismatch** — the harness fixed the wrong target (changed button B when the user meant button A) and built it faithfully all the way through; the test independence machinery cannot catch a *wrong spec*.
3. **Undo disaster** — opencode's native `/undo` is snapshot-based and scoped to the session directory; worktree edits and git merges happen outside that tracking, so `/undo` restored an arbitrary stale state (issues #5910, #10589, #15877).

v3 dissolves all three by removing the machinery that caused them:

- **No worktree, no branch, no merge.** The harness edits files **in place, uncommitted**, on the working tree. This eliminates the entire merge-corruption class by construction (there is no merge) and re-syncs opencode's `/undo` (all edits now live where the snapshot system tracks them).
- **A mandatory Confirm gate** after Intake, using opencode's built-in `question` tool, echoes the harness's understanding back and makes the user pick the exact target before any edit happens.
- **The workflow ends at Verify.** The harness never commits, pushes, or merges. After Verify passes it writes knowledge, surfaces the result, and stops. **Git is entirely the user's domain.** The user previews (`docker compose up`), then commits/pushes/merges manually when they decide it's ready. `/undo` and `/redo` are the user's, and they always work because nothing is ever committed by the harness.

Everything else from v2 — the LLM-orchestrated Conductor, the subagent-per-real-LLM-work rule, the knowledge layer, tiers, and the self-improvement loop — is retained.

---

## 1. The governing idea — [I]

opencode *is* an LLM harness. You do not bolt a code orchestrator onto it; you let an LLM (the **Conductor**, a primary agent) orchestrate, and you back it with the smallest possible **passive code spine** for the few guarantees an LLM can't be trusted to keep.

**The one rule that decides where work runs:**
> **Real LLM work → a subagent with a clean, minimal, task-specific context — always, at every task size.** **Mechanical / decision step → passive code on the Conductor (no subagent).**

A small model doing intake + routing + the edit + verify-handling all in one growing context window degrades and hallucinates. A fresh subagent seeded with only the ticket and the few files in scope stays sharp. So building, grounding, planning, test-authoring, and review each run in their own subagent — even for a trivial task. Running tests and routing are mechanical: they stay as passive code on the Conductor.

**The Conductor holds only distilled artifacts** — tickets, tier decisions, confirmation results, diff summaries, run outcomes — never raw file contents. That keeps the orchestrator sharp across a long session, which matters most when the orchestrator is a cheap model.

**Two human checkpoints, by design.** v3 makes two interactions explicit and mandatory, both via opencode's `question` tool:

1. **Confirm (before any edit):** the harness states *what it understood* and the user picks the exact target. This catches wrong-spec failures that no downstream test can catch.
2. **(Implicit) Review (after Verify):** the workflow stops with the changes sitting uncommitted; the user previews and decides whether to keep them via `/undo`/`/redo`, and whether/when to commit.

**The harness does not own git.** It edits the working tree and runs tests. Commit, push, merge, and rollback are the user's actions. The harness's only relationship to git is **read-only** (`git diff`/`git status` to compute a run's changeset for logging and scope-audit). This is the single most important boundary in v3: it is what keeps `/undo` reliable.

**Self-improvement** is the payoff over time: every run feeds the knowledge layer, which narrows future scans and sharpens future routing. The first run is expensive; the fiftieth is cheap.

---

## 2. Platform reality — [N]

Facts about opencode you MUST design around. Verified at build time by the Preflight (§3), because they change. As of 2026-06:

| Capability | Reality | Consequence for placement |
| --- | --- | --- |
| Hooks on the **primary** agent (`tool.execute.before/after`, `chat.message`) | Fire reliably | Put passive guards here. Free (no tokens, no extra tool call). |
| Hooks on **subagent** tool calls | Do **not** fire (issue #5894) | Never rely on a hook to guard a subagent. |
| Per-agent `deny` permissions via SDK | Historically ignored (issue #6396) — re-verify | Don't enforce subagent limits with `deny`. Enforce by **not granting** the tool. |
| Custom tools (own `execute()`) | Subagent-safe | Reliable enforcement everywhere. Use sparingly. |
| Built-in `question` tool | Presents multiple-choice options (single/multi-select) + optional custom text input; returns the user's selection | This is the Confirm gate. Call it from the **primary** Conductor (subagent reliability unverified — see Preflight). |
| `/undo` (session revert) | Restores the **working-tree snapshot** + trims session messages. Does **not** un-commit git. Snapshot scoped to the session dir; stale if files change outside opencode (#5910, #10589) | Keep all edits in-place and **uncommitted** so `/undo` stays coherent. The harness must never commit (that would desync `/undo`). |
| Snapshots | Enabled by config (`snapshot: true`) using an internal git repo | Must be **on** in v3 — it is the user's undo mechanism. |
| Per-agent `model` setting | Supported | This is how builder-junior and builder-senior differ. |
| Skills via `AGENTS.md` + `skill` tool | Supported | Stage logic lives in skills, not hand-written prompts. |

**Placement codes:** **(P)** passive hook on the primary, **(T)** custom tool, **(C)** opencode config / toolset construction, **(L)** LLM reasoning in a subagent, **(Q)** built-in `question` tool on the primary.

---

## 3. Preflight — run before building — [N]

Do not write a line of the harness until these pass on *your* opencode version. Record results in `knowledge/preflight.md`.

1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written. If it **does** fire on your version, you may move some guards to hooks — record that here.
3. **Custom tool runs from a subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write (the tool is absent, not merely denied).
5. **`question` tool works from the Conductor.** The primary agent calls `question` with 3 options; the user's selection comes back as structured output. *(Optional: test from a subagent. If it fails there, the Confirm gate MUST run on the primary — see §8.2.)*
6. **`/undo` restores an in-place edit.** A subagent edits a tracked file in the working dir; the user runs `/undo`; the file reverts to its pre-edit content.
7. **`/undo` → `/redo` round-trip.** After 6, `/redo` restores the edit exactly. If `/redo` lands on a wrong/stale state on your version (#5910/#10589), note it: git is the durable net, but warn the user that `/redo` is unreliable here.
8. **`snapshot: true` confirmed.** Config has snapshots enabled.
9. **`skill` tool resolves.** Install one addyosmani skill; the Conductor can invoke it.
10. **Per-agent model switch.** Two agent defs with different `model:` run on different models.

If any of 1–10 fail, fix the environment first — the rest of the spec assumes them. **Note there is no worktree preflight in v3** — worktrees are removed.

---

## 4. Constraints & gotchas — read first — [N]

- Directories are **plural**: `.opencode/plugins/`, `.opencode/commands/`, `.opencode/agent/`.
- Wiki frontmatter must use **inline YAML only**. Write `source_refs: "a.md, b.md"`, never a YAML list.
- Session state (tier, intake-done flag, current builder level) is **in-memory `Map<sessionID, …>`**, never globals. The **`confirmed` flag is keyed per task / starting turn id**, not per session, so it never carries over to the next requirement. Resets on restart — fine; the knowledge layer is the durable store.
- Never enforce a subagent limit with `deny`. Give the subagent a hand-built toolset instead.
- **Confirm asks exactly once per task, from the Conductor only.** The `question` tool is granted to the Conductor alone — no subagent has it. A subagent that hits the confirm gate **bounces to the Conductor, it does not ask.** The per-edit gate is a *silent boolean check*, not a repeated prompt (§8.2). Do not grant `question` to builders or instruct any stage but Confirm to ask — that is how you get "asks at every step."
- **The harness never writes git.** No `commit`, `branch`, `merge`, `push`, `checkout`, `reset`, `stash`, or `worktree` — from the Conductor or any subagent. Git **reads** (`diff`, `status`, `show`) are allowed for logging/scope-audit only. Enforce by **not granting** write-capable `bash` git patterns to subagents and by an `edit-only` discipline on the Conductor.
- **The harness never calls `/undo` or `/redo`.** Those are user-only TUI commands. An agent invoking them corrupts its own session.
- **The workflow ends at Verify + Finalize.** There is no merge step and no approval step. Surfacing the result and stopping *is* the end state.
- The spine has **exactly one plugin file and one custom tool** (`wiki_write`). Adding a worktree tool or a git-merge tool is a v2 regression — don't.

---

## 5. Requirements traceability — [N]

| # | Requirement | Satisfied by | Acceptance test |
| --- | --- | --- | --- |
| R1 | Project self-improvement | §13 loop; `log_outcome` + knowledge updates | A16.7 |
| R2 | Friendly cold start; knowledge grows with the project | §7; `/bootstrap`; per-run wiki writes | A16.5 |
| R3 | Existing codebase → create knowledge from code | §7.2 `/bootstrap` scan mode | A16.6 |
| R4 | Tests exist, or get created | §11 test layer + policy | A16.4 |
| R5 | Intake **and** Ground consult `knowledge/index.md` before scanning | §8.1, §8.5 knowledge pre-scan | A16.2 |
| R6 | **Shared understanding before any edit** — the user confirms the exact target | §8.2 Confirm gate (`question` tool) | A16.3 |
| R7 | First run costs more; usage amortizes | §13 (measurable) | A16.7 |
| R8 | **No corruption; user owns git** — harness edits in place, never commits/merges; `/undo` always coherent | §10 execution model | A16.13, A16.14 |
| R9 | **Undo coherence** — `/undo` reverts exactly one run's working-tree changes without affecting unrelated files | §10 in-place execution + no git writes | A16.15 |
| R10 | **Dirty-tree guard** — harness checks for pre-existing uncommitted changes before editing | §10 pre-run cleanliness guard (P) | A16.16 |

---

## 6. Architecture overview — [N]

```
              +-----------------------------------------------+
user msg ---> |  CONDUCTOR  (primary agent = the orchestrator)|
              |  holds only distilled artifacts               |
              |  asks Confirm; decides tier; fires subagents  |
              +-------+---------------------------------------+
   passive code on the Conductor:  CONFIRM(question, once/task) · ROUTE · VERIFY(run tests) · FINALIZE
   spine (passive):  plugins/spine.ts · tool: wiki_write
                      |
   subagents (real LLM work, clean context, one task each):
       INTAKE · GROUND · PLANNER · BUILDER-JUNIOR · BUILDER-SENIOR
       TEST-ENGINEER · CRITIC

   edits land IN PLACE on the working tree, UNCOMMITTED.
   git (commit/push/merge) and /undo,/redo are the USER's, after the harness stops.
```

- The **Conductor** is the only primary agent and the orchestrator. It is *not* code. It holds tickets, decisions, confirmation results, and diff summaries — never raw bulk.
- **Subagents** do all real LLM work in isolated contexts. Each returns a distilled artifact.
- **Passive code** (CONFIRM, ROUTE, VERIFY's test-run, FINALIZE) and the **spine** are the only non-LLM parts.
- **There is no worktree and no merge.** Builders edit the working tree directly; the run's output is uncommitted changes the user reviews.

---

## 7. Cold start & bootstrap — [N] (R2, R3)

### 7.1 Fresh project (no code yet) — [N]

- The first task runs in **bootstrap mode**: no wiki to pre-scan, so Intake/Ground fall back to a broad scan. This is the one expensive case, and it is expected (R7).
- At Finalize, the run **writes its first wiki page(s)** plus a `knowledge/index.md` Navigation Hint. Knowledge is born alongside the code.

### 7.2 Existing codebase (`/bootstrap`) — [N] (R3)

- One-time command. The Conductor walks the repo (top-level dirs, manifests, entrypoints, test dirs) and **generates the initial knowledge layer from the code**:
  * `knowledge/index.md` with Navigation Hints (`"Working on X? -> wiki pages [...]"`) from the directory layout.
  * One wiki page per major area, each with inline `source_refs:`.
  * `knowledge/test-impact.md` skeleton mapping test dirs to source dirs.
- Skills: `spec-driven-development`, `documentation-and-adrs`.
- **Checkpoint:** after `/bootstrap`, "where does auth live?" is answerable from `index.md` alone, no code scan (A16.6).
- `/bootstrap` writes knowledge files only. It does **not** commit them — the user commits the bootstrap output like any other change.

---

## 8. Stages & agents — [N]

The pipeline is: **Intake → Confirm → Route → Ground → Planner → Builder → Verify → Finalize.** Real-LLM stages are subagents; mechanical stages are passive code on the Conductor. Two specialist subagents (Test-engineer, Critic) switch on at higher tiers. **There is no Merge stage.**

### 8.1 Intake — [N] (R5) · SUBAGENT (cheap model)

- **In:** user message + `knowledge/index.md`. **Out:** distilled
  `{ restatement, target_refs:[{desc,file,locator}], candidates:[…], ambiguity, ticket, tier, confidence, scan_scope, touched_wiki_pages, acceptance_criteria }`.
- **Knowledge pre-scan (MUST):** read `index.md` → match Navigation Hints → read matched wiki page(s) → constrain the scan to those `source_refs`. Broad scan only when no hint matches.
- **Restatement + targets (MUST):** Intake produces a plain-language restatement of the task **and** an explicit `target_refs` list with precise locators (`file:line`, selector, symbol). If the scan finds more than one element matching a user reference, it lists them as `candidates`. This is the data the Confirm gate (§8.2) presents — Intake does not talk to the user itself.
- **Tier + confidence:** one page + one dir + known pattern + high confidence → low tier; multiple pages / cross-cutting / greenfield / no match / low confidence → high tier.
- **Acceptance criteria (MUST):** emit explicit, checkable criteria — the **independent source of truth** the tests anchor to (§11).
- The scan noise stays inside the subagent; the Conductor receives only the distilled object.
- **Skill:** `spec-driven-development` / `interview-me` (low confidence).

### 8.2 Confirm — [N] (R6) · PASSIVE on Conductor + `question` tool (Q) — **ASKS EXACTLY ONCE PER TASK**

This is the single human-alignment checkpoint. It happens **once**, here, right after Intake — **not** at Route, not at Builder, not per slice, not in any subagent. The rules below exist to guarantee that "always confirm" never degrades into "ask at every step."

**Who asks — the Conductor, and only the Conductor.**
- The built-in `question` tool is **granted to the Conductor (primary) only.** No subagent is ever given `question`. Asking is therefore structurally impossible anywhere except this one stage. (This is the fix for "sometimes it doesn't ask" — if asking is attempted from a subagent it can silently no-op; here it cannot happen at all.)
- The Conductor calls `question` with Intake's `restatement` + `target_refs` + `candidates`. One question, the user picks one option. Example:

  > **Header:** Confirm target
  > **Question:** I understood: *"rename the Save button label"*. Which button?
  > **Options:**
  > 1. `Save` in `SettingsPanel.tsx:42` (my best match — proceed)
  > 2. `Save & Close` in `SettingsPanel.tsx:51`
  > 3. Something else — let me describe it
  > *(custom text allowed)*

**What fires — exactly one question per task.**
- Fires for **every task, including Tier 0.** The cost is one round-trip; the failure it prevents (building the wrong thing and only finding out at the end) is the most expensive failure in the system.
- It is **one confirmation, not an interview.** Restate + pick. Drop into `interview-me` only when the user picks "something else" or confidence was already low.
- On the user's selection, the Conductor records `confirmed:true` keyed to the **task** and updates the ticket's `target_refs` to match the chosen option.

**The gate is a silent check, not a repeated ask.**
- The enforcement hook (§12) checks a per-task boolean `confirmed?` on **every** source `edit`/`write` attempt. This check is **silent and free**: if `confirmed:true`, the edit passes with no prompt. The check firing on every edit is *not* the same as asking on every edit — the ask happens once (above); the check just reads the flag.
- Once `confirmed:true` is set, **every downstream stage — Ground, Planner, Builder, Test-engineer, Critic — passes the gate silently and never asks.** The block-and-teach behavior can only occur *before* the single confirm, never after.

**Subagents never ask — they bounce.**
- If a subagent ever hits the gate while `confirmed` is false (it shouldn't, because Route requires Confirm first), the hook does **not** tell it to ask — it has no `question` tool. The hook tells it to **stop and bounce up to the Conductor** ("not confirmed — return control"). Only the Conductor, on regaining control, asks.

**Re-ask only when the target itself changes.**
- Picking "something else" / "not this one" → re-Intake → one new confirm (the target genuinely changed). Legitimate.
- A Builder bouncing up because "this is bigger than the Ticket" but the **target is unchanged** → re-Ground/Plan, **no re-ask.**
- Per-slice work in a Tier 2 task → **no re-ask** (the single confirm covers the whole task).

**Run from the primary** unless Preflight #5 proved subagent `question` works (and even then, keep it on the Conductor — single asking site is the design).

### 8.3 Route — [N] · PASSIVE (Conductor, no LLM)

- Reads `tier` + `confidence`; selects which stages fire and the **starting builder model**: high-confidence trivial → builder-junior; low-confidence or Tier 2 → builder-senior.
- **Enforcement:** route-floor hook (P) blocks Builder if required upstream stages (Confirm/Ground/Planner) haven't run for the tier. Conservative: when in doubt, route up.

### 8.4 Ground — [N] (R5) · SUBAGENT

- Gather the context Builder/Planner need; return a focused brief.
- **Knowledge pre-scan (MUST):** `index.md` first, then the specific wiki pages Intake named, then read code only within those `source_refs`. No double-read.
- **Fires:** Tier 1, Tier 2. Skipped at Tier 0.
- **Skill:** `context-engineering` (+ `source-driven-development` for framework facts).

### 8.5 Planner — [N] · SUBAGENT

- Decompose into thin vertical slices, each with its own acceptance criteria and dependency order.
- **Fires:** Tier 2 only.
- **Skill:** `planning-and-task-breakdown`.

### 8.6 Builder — [N] · SUBAGENT (always), two model levels

- Two agent defs: **builder-junior** (cheap model) and **builder-senior** (capable model). Same skills, different `model:`.
- **In:** confirmed Ticket + acceptance criteria + the scoped files. **Out:** the edits (in place) + a short diff summary. The Conductor never sees raw file contents.
- **Edits land directly on the working tree, uncommitted.** No worktree, no branch, no commit.
- **Stay in scope (MUST):** Builder edits **only** files in the Ticket's `scan_scope` / `target_refs`. If it believes it must touch a file outside scope, it **stops and bounces up** rather than silently editing it. (This is the guard against the v2 docker-compose clobber: an out-of-scope rewrite can no longer slip through.)
- **Escalation (MUST):**
  * On a Verify failure, the **same level** retries once. Fail again → **escalate to builder-senior** with the failure context. Cap: junior gets one retry before promotion.
  * Retry edits **in place** — the builder re-edits the working tree to the corrected state. No git reset; the model reads current file state and fixes it.
  * If Builder discovers the change is bigger than the Ticket claimed, it **stops and bounces up** to request Ground/Planner instead of guessing.
- **Skill:** `incremental-implementation` (thin slices) + `test-driven-development`.
- **Enforcement:** Builder subagents get a **constructed toolset** (C): `read`/`edit`/`write` on source, `read`-only git (`git diff/status/show`); **no raw write to `knowledge/`**, **no write-capable git**, **no `task`**. Containment by non-grant.

### 8.7 Verify — [N] (R4)

Two separate concerns:

- **(a) Run tests — PASSIVE primary hook (P), NOT a subagent.** On the files Builder touched, run the **scoped** tests (touched files ∩ `test-impact.md`). Mechanical: run, read exit code, surface result. Falls back to the full suite only when the impact map is empty.
- **(b) Code review — tier-scaled, per slice (not end-of-task):**
  * **Tier 0:** none. The test/smoke pass is the gate.
  * **Tier 1:** **builder-senior reviews builder-junior's diff** (lightweight).
  * **Tier 2:** an independent **Critic** subagent (§8.10), per slice.
- Review runs at each atomic slice boundary (~100 lines).

### 8.8 Finalize — [N] (R1, R2) · PASSIVE / MECHANICAL (Conductor) — **the end of the workflow**

Replaces v2's Merge. **Does no git.** On a green Verify:

1. **Scope audit.** Compute `git diff --name-only` (read-only). If any touched file is outside the Ticket's declared scope, **surface it to the user** ("this run also modified `docker-compose.yml` — expected?") rather than hiding it. This is the residual guard against accidental clobber.
2. **Self-improvement write** (§13): `log_outcome` + `wiki_write` updates via the `wiki_write` tool.
3. **Surface the result and STOP.** Tell the user, plainly:
   > Done. Changes are in your working tree, uncommitted. Preview with `docker compose up`. Keep them and they're yours to `git commit`/`push` when ready; or run `/undo` to discard this run.
4. The harness takes **no further action.** Commit, push, merge, and rollback are the user's.

- **Mechanical overall** (routing, scope audit, surfacing). The knowledge-write sub-step (§13, step 2) uses `documentation-and-adrs` for wiki page authorship. Notably v3 drops `git-workflow-and-versioning` from the harness — git workflow is the user's, not the harness's.

### 8.9 Test-engineer — [N] · SUBAGENT (independent), Tier 2 / critical only

- Writes tests **from the acceptance criteria**, and **never sees the planned implementation** — the anti-rubber-stamp guarantee. The Builder then makes them pass.
- **Fires:** Tier 2, or any task touching auth / money / data, per slice. Lower stakes → the Builder writes its own tests (§11).
- **Skill:** `test-driven-development` (+ `test-engineer` persona).

### 8.10 Critic — [N] · SUBAGENT (independent reviewer), Tier 2

- Reviews the slice's diff **and the test** — auditing the test for tautology ("does this verify the requirement, or just assert what the code does?").
- Adds `security-and-hardening` when the slice touches auth, input, storage, or external calls.
- Earns a subagent for **independence** (fresh context).
- **Skill:** `code-review-and-quality` + `doubt-driven-development` (+ `security-and-hardening`).

---

## 9. Tiers, the orchestrator decision, and the two flows — [N]

| | Easy (Tier 0) | Standard (Tier 1) | Complex (Tier 2) |
| --- | --- | --- | --- |
| Intake | subagent | subagent | subagent |
| **Confirm** | **always (question)** | **always (question)** | **always (question)** |
| Route | passive → junior | passive → junior | passive → senior |
| Ground | skipped | subagent | subagent |
| Planner | skipped | skipped | subagent |
| Who writes the test | builder (or none, cosmetic) | builder | independent test-engineer |
| Builder | junior, subagent, in-place | junior→senior, subagent, in-place | senior, subagent, in-place |
| Verify (run tests) | passive hook | passive hook | passive hook, per slice |
| Code review | none | senior reviews junior | Critic subagent, per slice |
| Finalize | log + stop | log + stop | log + stop |
| Model | cheap | cheap→capable | capable |

When in doubt, route up — under-routing breaks things (expensive rework); over-routing wastes a few tokens (cheap).

### Easy task (Tier 0) — e.g. "rename the Save button label"

```
1. INTAKE          [subagent · cheap · clean context]
     index.md -> frontend.md -> scans ~5 files in scope
     out: restatement + target_refs + candidates + tier:0 + confidence:high + acceptance criteria
2. CONFIRM         [Conductor · question tool]            <-- ALWAYS
     "rename Save -> which? [1] SettingsPanel.tsx:42  [2] :51  [3] other"
     user picks -> confirmed:true   (edits blocked until here)
3. ROUTE           [passive] Tier 0 -> skip Ground+Planner · builder-junior
4. BUILDER-JUNIOR  [subagent] edit in place (cosmetic -> smoke check) · return diff summary
5. VERIFY (tests)  [passive hook] scoped/smoke · PASS -> on · FAIL -> 1 retry -> senior
     review: none
6. FINALIZE        [passive] scope audit · log_outcome (+ touch frontend.md) · STOP
     "Done. Uncommitted in your tree. compose up to preview; /undo to discard; commit when ready."
```

### Difficult task (Tier 2) — e.g. "add multi-currency support to portfolio P&L"

```
1. INTAKE          [subagent] index.md -> calc/display/storage pages -> cross-cutting -> Tier 2, low conf
     out: restatement + target_refs + acceptance criteria
2. CONFIRM         [Conductor · question tool]            <-- ALWAYS
     restate scope + which P&L surfaces -> user confirms -> confirmed:true
3. ROUTE           [passive] full pipeline · builder-senior
4. GROUND          [subagent] named pages -> code within source_refs -> brief
5. PLANNER         [subagent] thin slices + per-slice criteria + order
6. PER-SLICE LOOP  (S1 -> S2 -> S3):
     a. TEST-ENGINEER  [subagent · independent] tests from criteria; never sees implementation
     b. BUILDER-SENIOR [subagent] make the slice pass · edit in place
     c. VERIFY (tests) [passive hook] run the slice's scoped tests
     d. CRITIC         [subagent · independent] review diff + audit test + security
     slice green -> next slice
7. FINALIZE        [passive] scope audit across all slices · log_outcome + update wiki + index hints · STOP
```

---

## 10. Execution model: in-place, uncommitted; the user owns git — [N] (R8)

This section replaces v2's worktree isolation. It is the heart of v3.

**Edits are in place and uncommitted.**
- Builders edit files directly on the working tree. There is no worktree, no branch, no commit.
- The "isolation" guarantee is **temporal, not spatial**: the user reviews before anything is committed, instead of work being quarantined in a separate tree.

**The harness never writes git.**
- Forbidden for the Conductor and all subagents: `commit`, `branch`, `merge`, `push`, `checkout`, `reset`, `restore`, `stash`, `worktree`, `rebase`, `cherry-pick`.
- Allowed: **read-only** git (`git diff`, `git status`, `git show`) for computing a run's changeset (logging, scope-audit).
- Enforced by the constructed toolset (no write-capable git granted to subagents) and an edit-only discipline on the Conductor.

**The user owns the full git lifecycle.**
- **Preview:** because edits are in the working tree, `docker compose up` (and any local run) reflects the change immediately. No special step is needed.
- **Discard:** the user runs `/undo` (native opencode). It restores the working-tree snapshot. It works cleanly **because nothing was committed** — there is no git history for it to desync from.
- **Redo:** `/redo` restores the change. (Reliability varies by opencode version — see Preflight #7. Git is the durable net once the user commits.)
- **Keep / commit / push / merge:** entirely the user's manual git actions, on their own schedule. The harness's job is finished at Finalize.

**The point-of-no-return for `/undo` is the user's commit.**
- `/undo` is valid only while the run's changes are **uncommitted**. Once the user commits, the source of truth moves from opencode's snapshot to git history, and `/undo` no longer knows about it — using `/undo` after a commit desyncs the working tree from `HEAD`.
- After commit, the correct rollback is `git revert` / `git reset`, which the user performs deliberately. The harness does not manage this.
- Because the *harness* never commits, this boundary is always under the user's explicit control.

**Pre-run cleanliness guard (P).**
- Before any source edit, the spine hook (`tool.execute.before`) checks `git status`. If the working tree is **dirty** (the user has their own uncommitted work), the hook **blocks the action and signals the Conductor** — it does not call `question` itself (hooks cannot call tools). The Conductor then asks via `question`: *"You have uncommitted changes. Commit or stash them first so `/undo` only affects this run?"* This prevents a later `/undo` from clobbering the user's unrelated work and keeps each run's changeset clean for the scope-audit. Only the first source edit in a task triggers this check; subsequent edits pass freely once confirmed.

**No parallel runs in v3.**
- Worktrees were what enabled parallel/headless runs (old R6). v3 is single-stream interactive by design. If you later need batch/headless parallelism, that is a separate mode built on `opencode serve` + ephemeral clones — out of scope here. Do not reintroduce worktrees into the interactive path.

---

## 11. Test layer & testing policy — [N] (R4)

**Impact map.** `knowledge/test-impact.md` maps `source dir -> test files`, maintained at Finalize. Verify selects tests by intersecting touched files with the map → scoped run, not the whole suite.

**Independence (anti-rubber-stamp).** The danger is the definition of "correct" and the implementation coming from the same reasoning. So:

- "Correct" is defined **upstream** as acceptance criteria — Intake for simple tasks, Planner for complex — independent of the build. And in v3 the criteria/target are **confirmed with the user** (§8.2) before any build, closing the one gap tests can't cover: a *wrong* spec.
- **Low stakes:** the Builder writes the test **first, from the criteria** (red), then the code (green).
- **Critical (Tier 2, or auth/money/data):** an **independent test-engineer** subagent writes the tests from the criteria, never seeing the planned implementation. The Builder only makes them pass.
- **Always (non-trivial):** the Critic audits the test for tautology.

**When tests are created.**
- **Bug fix → always, first.** Write a failing test that reproduces the bug, then fix until green. Non-negotiable.
- **Feature / behavior change → yes**, tests for the new behavior.
- **Pure refactor → no new tests.** Existing tests must still pass.
- **Cosmetic → smoke/render check or nothing.**

Cold start / `/bootstrap`: seed `test-impact.md` from existing test dirs.

---

## 12. The spine — the only code — [N]

One plugin, one custom tool. Nothing else is code.

**`.opencode/plugins/spine.ts`** — passive hooks on the primary Conductor (all (P), all free):

- `chat.message`: detect language, stash in session state (observation only).
- `tool.execute.before`: **pre-run cleanliness gate** — on the first source-touching action of a task, if `git status` is dirty, signal the Conductor to ask the user to commit/stash first (§10).
- `tool.execute.before`: **confirmed-first gate** — a **silent per-task boolean check** on every source `edit`/`write`/`bash`-that-mutates. Read `confirmed[taskId]`:
    * `true` → **pass silently, no prompt** (the common case; this check is free and must never itself ask).
    * `false` and the actor is the **Conductor** → block and return "call `question` to confirm the target before editing."
    * `false` and the actor is a **subagent** → block and return "not confirmed — stop and return control to the Conductor" (subagents have no `question` tool and must never ask the user; they bounce).
  Key the flag to the **task / starting turn id**, not the session — it resets on each new user requirement so a prior task's confirmation never carries over (this is what stops "ask once then never again"). Exempt `knowledge/` and the `wiki_write` tool. Only the Conductor sets the flag, and only by recording a `question` answer — never defaulted, never inferred.
- `tool.execute.before` on `task`/`edit`: **route-floor gate** — blocks downstream stages (Ground/Planner/Builder) unless `confirmed[taskId]` is `true` for the current task. Additionally, if the tier requires Ground/Planner and they haven't run, block and tell the Conductor to route up. This ensures Route never fires before Confirm, and Builder never fires before Ground/Planner.
- `tool.execute.before` on `bash`: **git-write guard** — block any git subcommand that mutates (`commit`, `branch`, `merge`, `push`, `checkout`, `reset`, `restore`, `stash`, `worktree`, `rebase`, `cherry-pick`). Allow read-only git. This enforces §10 even if a subagent's toolset is misconfigured.
- `tool.execute.after` on Builder's edits: **verify trigger** — run scoped tests; surface pass/fail to the Conductor.

**Custom tool (T):**
- `wiki_write(page, frontmatter, body)` — the only way to write `knowledge/`; enforces inline-YAML; subagent-safe. `log_outcome` is folded into it.

**There is no `worktree` tool and no merge tool.** Removing them is the point of v3.

**Model selection, escalation, and the Confirm question are Conductor logic, not code.** The verify-trigger hook only reports pass/fail; the Conductor decides junior-retry vs senior-escalation and composes the `question` for Confirm. **The `question` tool is granted to the Conductor only — no subagent toolset includes it**, so the user can be asked from exactly one place. No git tool, no subagent hook, no `deny`.

---

## 13. Self-improvement loop — [N] (R1, R7)

At every Finalize:

1. `log_outcome` appends `{ task, tier, builder_level, files, tests, duration, tokens, learnings }` to `knowledge/runs.md`.
2. The Conductor writes/updates the relevant **wiki page** via `wiki_write`: new patterns, gotchas, corrected `source_refs`.
3. It refines `knowledge/index.md` Navigation Hints when a task reveals a better mapping.

Effect over N runs: scans **narrow**, routing **sharpens**, briefs **shrink**. Per-task token cost falls with usage. Measurable via A16.7. (Knowledge writes are uncommitted like everything else; the user commits them with the run.)

---

## 14. Directory layout — [N]

```
.opencode/
  agent/
    conductor.md                      # primary orchestrator
    intake.md ground.md planner.md    # subagents
    builder-junior.md builder-senior.md   # subagents, differ only by model:
    test-engineer.md critic.md        # specialist subagents (Tier 2 / critical)
  plugins/
    spine.ts                          # the only plugin
  tools/
    wiki_write.ts                     # the only custom tool
  commands/
    bootstrap.md                      # /bootstrap (§7.2)
knowledge/
  index.md <area>.md test-impact.md runs.md preflight.md
AGENTS.md                             # installs addyosmani skills; points stages at them
```

Gone from v2: `.harness/wt/` and `tools/worktree.ts`.

**Config requirement — `opencode.json`:**
```json
{
  "default_agent": "conductor",
  "snapshot": true
}
```
Snapshots must be **on** (`snapshot: true`). This is what enables the user's `/undo` and `/redo` (Preflight #8). Without it, the undo coherence guarantee (§10, R9) is broken.

---

## 15. Build order with checkpoints — [N]

Do not pass a checkpoint until its assertion holds.

1. **Preflight (§3).** PASS 1–10 (note: includes `/undo`→`/redo` round-trip and `question`-from-Conductor).
2. **Spine: confirmed-first hook.** PASS a raw source `edit` is blocked before `confirmed:true`; allowed after. The flag is per-task: a new requirement resets it.
3. **Spine: git-write guard.** PASS a `git commit`/`merge`/`checkout` from any agent is blocked; `git diff`/`status` allowed.
4. **`wiki_write` + `index.md` seed.** PASS a wiki page round-trips with inline frontmatter intact.
5. **Intake subagent + knowledge pre-scan.** PASS "rename button" scans ≤ the matched page's source dir; the Conductor receives only the distilled object.
6. **Confirm gate — once, Conductor only.** PASS `question` fires **exactly once per task** (incl. Tier 0) from the **Conductor**; selecting option 2 redirects the target; no edit happens until a selection is made; downstream stages (Ground/Planner/Builder/Critic) issue **zero** prompts; no subagent toolset contains `question`.
7. **Route floor + tiers + model pick.** PASS Tier 0 picks junior and skips Ground/Planner; Tier 2 picks senior and blocks Builder until Ground ran.
8. **Builder subagents + constructed toolset + in-place edits.** PASS a Builder cannot raw-write `knowledge/`, cannot write git; a Verify failure escalates junior → senior after one retry; edits appear in the working tree uncommitted.
9. **Verify split.** PASS test-run is a passive hook (no subagent); Tier 2 review is an independent Critic subagent per slice.
10. **Test-engineer independence.** PASS for a critical task, the test author is a separate subagent that did not see the implementation.
11. **Finalize + self-improvement write + stop.** PASS a new/updated wiki page and a `runs.md` entry exist; the harness performs no git and ends with the "uncommitted, your turn" message.
12. **Undo coherence.** PASS after a run, user `/undo` reverts exactly that run's working-tree changes; `/redo` restores them (or is flagged unreliable per Preflight #7).
13. **`/bootstrap`.** PASS on an existing repo, `index.md` answers "where does X live?" with no code scan.
14. **Acceptance suite (§16).** PASS all green.

---

## 16. Acceptance suite — [N]

The build is **done** only when all pass. Drive via the TUI.

- **A16.1 — intake-first.** Non-English message. Assert: a normalized English Ticket exists AND the reply is in the user's language.
- **A16.2 — knowledge pre-scan (R5).** Seed a wiki page for area X; task in X. Assert: files read ⊆ X's `source_refs`.
- **A16.3 — confirm gate asks once, always (R6).** Two tasks: one trivial, one with two matching buttons in scope. Assert: the `question` tool fired **exactly once** in **each** task; for the ambiguous one it listed candidates; **no edit occurred before** the user selected; selecting the non-default candidate retargeted the build.
- **A16.3b — single asking site; downstream is silent.** A Tier 2 task (multiple stages + slices). Assert: `question` was called by the **Conductor only** and **only once** (at Confirm); Ground/Planner/Builder/Critic produced **zero** user prompts; no subagent toolset contains `question`. A second task in the same session asks again (per-task flag, not per-session).
- **A16.4 — test policy (R4).** A bug fix. Assert: a failing regression test was written before the fix, then passes. A cosmetic change asserts no unit test was manufactured.
- **A16.5 — cold start (R2).** Empty `knowledge/`, one task. Assert: a wiki page + an `index.md` hint now exist (uncommitted).
- **A16.6 — bootstrap (R3).** `/bootstrap` on a repo with code, no knowledge. Assert: "where does X live?" answered from `index.md`, zero code scan.
- **A16.7 — amortization (R1, R7).** Same class of task 5×, logging tokens. Assert: tokens-per-task trends down.
- **A16.8 — tier pruning + builder-is-subagent.** A trivial task. Assert: Ground/Planner never fired; the build ran in a subagent (Conductor context did not accumulate file contents).
- **A16.9 — subagent containment.** A Builder attempts raw `write` to `knowledge/`. Assert: it cannot; it uses `wiki_write` or escalates.
- **A16.10 — model escalation.** Force a junior Verify failure twice. Assert: the task escalates to builder-senior with the failure context (not a third junior attempt).
- **A16.11 — test independence + tautology audit.** A Tier 2 critical task. Assert: tests were authored by the test-engineer subagent, and the Critic flags a deliberately tautological test.
- **A16.12 — per-slice review.** A multi-slice Tier 2 task. Assert: review ran at each slice boundary, not once at the end.
- **A16.13 — no git writes (R8).** Run any task to completion. Assert: `git log` is unchanged (no new commit), no new branch, working tree holds the changes uncommitted, and the harness's final message hands git to the user.
- **A16.14 — scope audit / no clobber (R8).** A task scoped to file X; inject an attempt to also rewrite `docker-compose.yml`. Assert: the Builder bounces up OR Finalize surfaces the out-of-scope file to the user — it is never silently changed.
- **A16.15 — undo coherence.** After a completed run, run `/undo`. Assert: exactly that run's working-tree changes revert; a previously-existing (untouched) file is unaffected.
- **A16.16 — dirty-tree guard.** Start a task with pre-existing uncommitted user changes. Assert: the harness asks (via `question`) to commit/stash before proceeding.

---

## 17. Skills referenced — [I]

From `github.com/addyosmani/agent-skills` (install via `AGENTS.md` + the `skill` tool).

| Agent / stage | Skill(s) |
| --- | --- |
| Intake | `spec-driven-development`, `interview-me`, `idea-refine` |
| Confirm | — (mechanical: `question` tool) |
| Ground | `context-engineering`, `source-driven-development` |
| Planner | `planning-and-task-breakdown` |
| Builder-junior | `incremental-implementation`, `test-driven-development`, `frontend-ui-engineering` (UI tasks), `api-and-interface-design` (API tasks) |
| Builder-senior | `incremental-implementation`, `test-driven-development`, `code-review-and-quality`, `frontend-ui-engineering` (UI tasks), `api-and-interface-design` (API tasks) |
| Test-engineer | `test-driven-development` (+ `test-engineer` persona) |
| Critic | `code-review-and-quality`, `doubt-driven-development` (+ `security-and-hardening`) |
| Verify (run) | mechanical — no skill |
| Finalize | `documentation-and-adrs` (knowledge write only) |
| Bootstrap | `spec-driven-development`, `documentation-and-adrs` |

Dropped from v2: `git-workflow-and-versioning` — git is the user's domain, not the harness's.

Their **progressive disclosure** design (SKILL.md is the entry point; references load only when needed) is the same token discipline as the knowledge `index.md` → wiki-page pattern, and as keeping each subagent's seeded context tight. Reuse it.

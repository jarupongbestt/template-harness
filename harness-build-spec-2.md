---
title: Harness Build Spec — LLM-Orchestrated, Self-Improving, opencode-Native
kind: spec
provenance: verified
source_refs: "opencode docs (serve/sdk/agents), opencode issues #5894 #6396, github.com/addyosmani/agent-skills"
updated: 2026-06-12
links: "knowledge/index.md"
---

# Harness Build Spec

This spec produces a working harness on the **first build**. It is *self-verifying*: it ships with a preflight you run before building and an acceptance suite that must go green before the build is "done." If you read only three sections, read §3 (Preflight), §15 (Build Order), and §16 (Acceptance).

**Reading convention.** Every block is tagged:
- **[N]** NORMATIVE — build exactly this. Changing it changes behavior.
- **[I]** INFORMATIVE — rationale or example. Change freely.

---

## 1. The governing idea — [I]

opencode *is* an LLM harness. You do not bolt a code orchestrator onto it; you let an LLM (the **Conductor**, a primary agent) orchestrate, and you back it with the smallest possible **passive code spine** for the few guarantees an LLM can't be trusted to keep.

**The one rule that decides where work runs:**

> **Real LLM work → a subagent with a clean, minimal, task-specific context — always, at every task size.**
> **Mechanical / decision step → passive code on the Conductor (no subagent).**

A small model doing intake + routing + the edit + verify-handling all in one growing context window degrades and hallucinates. A fresh subagent seeded with only the ticket and the few files in scope stays sharp. So building, grounding, planning, test-authoring, and review each run in their own subagent — even for a trivial task. Running tests, routing, and merging are mechanical: they stay as passive code on the Conductor, because there is no LLM context to isolate. Spawning a child session just to run `make test` is waste.

**The Conductor holds only distilled artifacts** — tickets, tier decisions, diff summaries, run outcomes — never raw file contents. That keeps the orchestrator sharp across a long session, which matters most when the orchestrator is a cheap model.

**What task size actually controls** (it does *not* control inline-vs-subagent): how many stages fire, which model the builder uses (junior vs senior), and whether the independence agents (test-engineer, Critic) switch on.

**The token lever** is therefore not "avoid subagents" but **"keep each subagent's seeded context tight."** A builder subagent given 5 scoped files is cheap and clean; one given the whole repo is expensive and noisy. Constraining scope is the job of the knowledge pre-scan — that is what makes subagent-by-default affordable.

**Self-improvement** is the payoff over time: every run feeds the knowledge layer, which narrows future scans and sharpens future routing. The first run is expensive; the fiftieth is cheap.

---

## 2. Platform reality — [N]

Facts about opencode you MUST design around. Verified at build time by the Preflight (§3), because they change. As of 2026-06:

| Capability | Reality | Consequence for placement |
|---|---|---|
| Hooks on the **primary** agent (`tool.execute.before/after`, `chat.message`) | Fire reliably | Put passive guards here. Free (no tokens, no extra tool call). |
| Hooks on **subagent** tool calls | Do **not** fire (issue #5894) | Never rely on a hook to guard a subagent. |
| Per-agent `deny` permissions via SDK | Ignored (issue #6396) | Don't enforce subagent limits with `deny`. Enforce by **not granting** the tool. |
| Custom tools (own `execute()`) | Subagent-safe | The only reliable enforcement that works everywhere. Use sparingly. |
| `opencode serve` + `@opencode-ai/sdk` | Works; the TUI is just a client of the server | Headless/parallel runs are possible, not required for the interactive harness. |
| Per-agent `model` setting | Supported | This is how builder-junior and builder-senior differ. |
| Skills via `AGENTS.md` + `skill` tool | Supported | Stage logic lives in skills, not hand-written prompts. |

**Placement codes:** **(P)** passive hook on the primary, **(T)** custom tool, **(C)** opencode config / toolset construction, **(L)** LLM reasoning in a subagent.

---

## 3. Preflight — run before building — [N]

Do not write a line of the harness until these pass on *your* opencode version. Record results in `knowledge/preflight.md`.

1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written. If it **does** fire on your version, you may move some guards from custom tools to hooks and simplify §12 — record that here.
3. **Custom tool runs from a subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write (the tool is absent, not merely denied).
5. **Worktree create/remove works.** `git worktree add` → write → `git worktree remove`, isolated from the main tree.
6. **`skill` tool resolves.** Install one addyosmani skill (e.g. `test-driven-development`); the Conductor can invoke it.
7. **Per-agent model switch.** Two agent defs with different `model:` actually run on different models.
8. **(Only for parallel headless runs)** `opencode serve` starts and `createOpencodeClient` connects.

If any of 1–7 fail, fix the environment first — the rest of the spec assumes them.

---

## 4. Constraints & gotchas — read first — [N]

- Directories are **plural**: `.opencode/plugins/`, `.opencode/commands/`, `.opencode/agent/`.
- Wiki frontmatter must use **inline YAML only**. Write `source_refs: "a.md, b.md"`, never a YAML list.
- Session state (tier, intake-done flag, current builder level) is **in-memory `Map<sessionID, …>`**, never globals. Resets on restart — fine; the knowledge layer is the durable store.
- Never enforce a subagent limit with `deny`. Give the subagent a hand-built toolset instead.
- The spine has **exactly one plugin file and two custom tools**. Adding a third hook to guard a subagent is the #5894 trap — stop.

---

## 5. Requirements traceability — [N]

| # | Requirement | Satisfied by | Acceptance test |
|---|---|---|---|
| R1 | Project self-improvement | §13 loop; `log_outcome` + knowledge updates | A16.7 |
| R2 | Friendly cold start; knowledge grows with the project | §7; `/bootstrap`; per-run wiki writes | A16.5 |
| R3 | Existing codebase → create knowledge from code | §7.2 `/bootstrap` scan mode | A16.6 |
| R4 | Tests exist, or get created | §11 test layer + policy | A16.4 |
| R5 | Intake **and** Ground consult `knowledge/index.md` before scanning | §8.1, §8.3 knowledge pre-scan | A16.2 |
| R6 | Each run in a worktree; parallel + `/undo` don't collide | §10 worktree isolation | A16.3 |
| R7 | First run costs more; usage amortizes | §13 (measurable) | A16.7 |

---

## 6. Architecture overview — [N]

```
                 +-----------------------------------------------+
   user msg ---> |  CONDUCTOR  (primary agent = the orchestrator)|
                 |  holds only distilled artifacts; owns worktree|
                 |  decides tier, picks model, fires subagents   |
                 +-------+---------------------------------------+
        passive code on the Conductor:  ROUTE · VERIFY(run tests) · MERGE
        spine (passive):  plugins/spine.ts · tools: wiki_write, worktree
                         |
        subagents (real LLM work, clean context, one task each):
          INTAKE · GROUND · PLANNER · BUILDER-JUNIOR · BUILDER-SENIOR
          TEST-ENGINEER · CRITIC
```

- The **Conductor** is the only primary agent and the orchestrator. It is *not* code. It holds tickets, decisions, and diff summaries — never raw bulk.
- **Subagents** do all real LLM work in isolated contexts. Each returns a distilled artifact.
- **Passive code** (ROUTE, VERIFY's test-run, MERGE) and the **spine** are the only non-LLM parts.
- Stage logic comes from addyosmani skills (§17), not hand-written prompts.

---

## 7. Cold start & bootstrap — [N]  (R2, R3)

### 7.1 Fresh project (no code yet) — [N]
- The first task runs in **bootstrap mode**: no wiki to pre-scan, so Intake/Ground fall back to a broad scan. This is the one expensive case, and it is expected (R7).
- On Merge, the run **writes its first wiki page(s)** plus a `knowledge/index.md` Navigation Hint. Knowledge is born alongside the code.

### 7.2 Existing codebase (`/bootstrap`) — [N]  (R3)
- One-time command. The Conductor walks the repo (top-level dirs, manifests, entrypoints, test dirs) and **generates the initial knowledge layer from the code**:
  - `knowledge/index.md` with Navigation Hints (`"Working on X? -> wiki pages [...]"`) from the directory layout.
  - One wiki page per major area, each with inline `source_refs:`.
  - `knowledge/test-impact.md` skeleton mapping test dirs to source dirs.
- Skills: `spec-driven-development`, `documentation-and-adrs`.
- **Checkpoint:** after `/bootstrap`, "where does auth live?" is answerable from `index.md` alone, no code scan (A16.6).

---

## 8. Stages & agents — [N]

The pipeline is seven stages. Real-LLM stages are subagents; mechanical stages are passive code on the Conductor. Two specialist subagents (Test-engineer, Critic) switch on at higher tiers.

### 8.1 Intake — [N]  (R5)  · SUBAGENT (cheap model)
- **In:** user message + `knowledge/index.md`. **Out:** distilled `{ ticket, tier, confidence, scan_scope, touched_wiki_pages, acceptance_criteria }`.
- **Knowledge pre-scan (MUST):** read `index.md` → match Navigation Hints → read matched wiki page(s) → constrain the scan to those `source_refs`. Broad scan only when no hint matches.
- **Tier + confidence:** one page + one dir + known pattern + high confidence → low tier; multiple pages / cross-cutting / greenfield / no match / low confidence → high tier.
- **Acceptance criteria (MUST):** emit explicit, checkable criteria. This is the **independent source of truth** the tests anchor to (§11).
- The scan noise stays inside the subagent; the Conductor receives only the Ticket.
- **Skill:** `spec-driven-development` / `interview-me` (low confidence).
- **Enforcement:** intake-first passive hook (P) blocks the Conductor's direct source edits until a Ticket exists.

### 8.2 Route — [N]  · PASSIVE (Conductor, no LLM)
- Reads `tier` + `confidence`; selects which stages fire and the **starting builder model**: high-confidence trivial → builder-junior; low-confidence or Tier 2 → builder-senior (don't waste a junior attempt on a clearly-hard task).
- **Enforcement:** route-floor hook (P) blocks Builder if required upstream stages (Ground/Planner) haven't run for the tier. Conservative: when in doubt, route up.

### 8.3 Ground — [N]  (R5)  · SUBAGENT
- Gather the context Builder/Planner need; return a focused brief.
- **Knowledge pre-scan (MUST):** `index.md` first, then the specific wiki pages Intake named, then read code only within those `source_refs`. Intake reads the index (navigation); Ground reads the pages (detail). No double-read.
- **Fires:** Tier 1, Tier 2. Skipped at Tier 0.
- **Skill:** `context-engineering` (+ `source-driven-development` for framework facts).

### 8.4 Planner — [N]  · SUBAGENT
- Decompose into thin vertical slices, each with its own acceptance criteria and dependency order.
- **Fires:** Tier 2 only.
- **Skill:** `planning-and-task-breakdown`.

### 8.5 Builder — [N]  · SUBAGENT (always), two model levels
- Two agent defs: **builder-junior** (cheap model, e.g. GLM/Haiku) and **builder-senior** (capable model, e.g. Sonnet/Opus). Same skills, different `model:`.
- **In:** Ticket + acceptance criteria + the scoped files + worktree path. **Out:** diff + short summary. The Conductor never sees raw file contents.
- Makes edits in the run's worktree (§10). Writes tests per the policy (§11).
- **Escalation (MUST):**
  - On a Verify failure, the **same level** retries once. Fail again → **escalate to builder-senior** with the failure context. Cap: junior gets one retry before promotion, so you never pay junior×3 + senior.
  - If Builder discovers the change is bigger than the Ticket claimed, it **stops and bounces up** to request Ground/Planner instead of guessing.
- **Skill:** `incremental-implementation` (thin slices) + `test-driven-development`.
- **Enforcement:** Builder subagents get a **constructed toolset** (C): read/edit/write on source + `worktree`; **no raw write to `knowledge/`**, no `task`. Containment by non-grant.

### 8.6 Verify — [N]  (R4)
Two separate concerns:

- **(a) Run tests — PASSIVE primary hook (P), NOT a subagent.** On the diff returned from Builder, run the **scoped** tests (touched files ∩ `test-impact.md`). Mechanical: run, read exit code, surface result. Falls back to the full suite only when the impact map is empty.
- **(b) Code review — tier-scaled, per slice (not end-of-task):**
  - **Tier 0:** none. The test/smoke pass is the gate.
  - **Tier 1:** **builder-senior reviews builder-junior's diff** (lightweight; reviewing is far cheaper than building).
  - **Tier 2:** an independent **Critic** subagent (§8.9), per slice.
- Review runs at each atomic slice boundary (~100 lines), because review quality collapses on large diffs. A single-slice task is reviewed once; a multi-slice task is reviewed per slice.

### 8.7 Merge — [N]  (R6)  · PASSIVE / MECHANICAL (Conductor)
- Atomic commit; `worktree.merge`; update `test-impact.md`; trigger the self-improvement write (§13).
- **Skill:** `git-workflow-and-versioning`.

### 8.8 Test-engineer — [N]  · SUBAGENT (independent), Tier 2 / critical only
- Writes tests **from the acceptance criteria**, and **never sees the planned implementation** — this is the anti-rubber-stamp guarantee. The Builder then makes them pass.
- **Fires:** Tier 2, or any task touching auth / money / data, per slice. For lower stakes the Builder writes its own tests (§11).
- **Skill:** `test-driven-development` (+ `test-engineer` persona).

### 8.9 Critic — [N]  · SUBAGENT (independent reviewer), Tier 2
- Reviews the slice's diff **and the test** — auditing the test for tautology ("does this verify the requirement, or just assert what the code does?").
- Adds `security-and-hardening` when the slice touches auth, input, storage, or external calls.
- Earns a subagent for **independence** (fresh context), not for context volume — the one sanctioned exception to "more context than it returns."
- **Skill:** `code-review-and-quality` + `doubt-driven-development` (+ `security-and-hardening`).

---

## 9. Tiers, the orchestrator decision, and the two flows — [N]

| | Easy (Tier 0) | Standard (Tier 1) | Complex (Tier 2) |
|---|---|---|---|
| Intake | subagent | subagent | subagent |
| Route | passive → junior | passive → junior | passive → senior |
| Ground | skipped | subagent | subagent |
| Planner | skipped | skipped | subagent |
| Who writes the test | builder (or none, cosmetic) | builder | independent test-engineer |
| Builder | junior, subagent | junior→senior, subagent | senior, subagent |
| Verify (run tests) | passive hook | passive hook | passive hook, per slice |
| Code review | none | senior reviews junior | Critic subagent, per slice |
| Merge | mechanical | mechanical | mechanical |
| Model | cheap | cheap→capable | capable |

The Conductor reasons about the task; Route (passive code) enforces the floor; Verify failures drive model escalation. When in doubt, route up — under-routing breaks things (expensive rework); over-routing wastes a few tokens (cheap).

### Easy task (Tier 0) — e.g. "move home page background position"
```
1. INTAKE          [subagent · cheap · clean context]
     reads index.md -> frontend.md -> scans only the ~5 files in scope
     out: Ticket + tier:0 + confidence:high + acceptance criteria
2. ROUTE           [passive · Conductor · no LLM]
     Tier 0 -> skip Ground + Planner · pick builder-junior
3. BUILDER-JUNIOR  [subagent · cheap · clean context]
     worktree.open · edit (cosmetic -> smoke check · bug fix -> failing test first) · return diff
4. VERIFY (tests)  [passive hook · NOT a subagent]
     run scoped/smoke checks · PASS -> on · FAIL -> 1 retry -> escalate to builder-senior
     review: none
5. MERGE           [passive/mechanical]
     atomic commit · worktree.merge · log_outcome (+ touch frontend.md if a new pattern emerged)
```
Conductor holds only the Ticket + diff summary. Two cheap short-context subagents. Mechanical steps stay on the Conductor.

### Difficult task (Tier 2) — e.g. "add multi-currency support to portfolio P&L"
```
1. INTAKE          [subagent]
     index.md -> multiple pages (calc, display, storage) -> cross-cutting -> Tier 2, low confidence
     out: Ticket + acceptance criteria (independent source of truth for tests)
2. ROUTE           [passive] full pipeline · pick builder-senior
3. GROUND          [subagent] read the named pages -> code within their source_refs -> brief
4. PLANNER         [subagent] thin slices + per-slice acceptance criteria + order
                   S1 currency model -> S2 calc consumes currency -> S3 display formatting
5. PER-SLICE LOOP  (S1 -> S2 -> S3):
     a. TEST-ENGINEER  [subagent · independent] tests from criteria; never sees the implementation
     b. BUILDER-SENIOR [subagent · capable] make the slice pass, in the worktree
     c. VERIFY (tests) [passive hook] run the slice's scoped tests
     d. CRITIC         [subagent · independent] review diff + audit test for tautology + security
     slice green -> next slice
6. MERGE           [passive/mechanical]
     atomic commit(s) · worktree.merge · update test-impact · log_outcome + update wiki pages + index hints
```

---

## 10. Worktree isolation — [N]  (R6)

- **`worktree` custom tool (T)**, actions: `open(run_id)` -> `git worktree add .harness/wt/<run_id> -b harness/<run_id>`; `merge(run_id)` -> fast-forward/rebase into main + `git worktree remove`; `discard(run_id)` -> remove without merging (this is `/undo` for a run).
- The Conductor opens a worktree per run and passes its path to the Builder subagent. All edits happen there.
- **Parallel runs:** N runs = N worktrees on N branches; no shared working tree, no collision.
- **`/undo`:** scoped to a run_id -> `worktree discard`; reverts only that run's branch, never a sibling's.
- **Why a custom tool, not bash convention:** run isolation is a guarantee, and a subagent must perform it — so it must be subagent-safe (T), not a primary-only hook.

---

## 11. Test layer & testing policy — [N]  (R4)

**Impact map.** `knowledge/test-impact.md` maps `source dir -> test files`, maintained by Merge. Verify selects tests by intersecting touched files with the map → scoped run, not the whole suite.

**Independence (anti-rubber-stamp).** The danger is the definition of "correct" and the implementation coming from the same reasoning. So:
- "Correct" is defined **upstream** as acceptance criteria — Intake for simple tasks, Planner for complex — independent of the build.
- **Low stakes:** the Builder writes the test **first, from the criteria** (red), then the code (green).
- **Critical (Tier 2, or auth/money/data):** an **independent test-engineer** subagent (§8.8) writes the tests from the criteria, never seeing the planned implementation. The Builder only makes them pass.
- **Always (non-trivial):** the Critic audits the test for tautology (§8.9).

**When tests are created.**
- **Bug fix → always, first.** Write a failing test that reproduces the bug, then fix until green (regression guard). Non-negotiable.
- **Feature / behavior change → yes**, tests for the new behavior (acceptance criteria).
- **Pure refactor → no new tests.** Existing tests must still pass; that proves behavior is preserved.
- **Cosmetic (e.g. move background) → smoke/render check or nothing.** Don't manufacture a test where there's no behavior to assert.

Cold start / `/bootstrap`: seed `test-impact.md` from existing test dirs; a project with zero tests establishes its first test on its first behavior change.

---

## 12. The spine — the only code — [N]

One plugin, two custom tools. Nothing else is code.

**`.opencode/plugins/spine.ts`** — passive hooks on the primary Conductor (all (P), all free):
- `chat.message`: detect language, stash in session state (observation only).
- `tool.execute.before`: **intake-first gate** — block `edit`/`write`/`bash` on source until a Ticket exists. Exempt `knowledge/`, `.harness/`, and the `wiki_write`/`worktree` tools so the Conductor isn't blocked doing maintenance. Per-task, not per-session.
- `tool.execute.before` on `task`/`edit`: **route-floor gate** — if the tier requires Ground/Planner and they haven't run, block and tell the Conductor to route up.
- `tool.execute.after` on Builder's returned diff: **verify trigger** — run scoped tests; surface pass/fail to the Conductor.

**Custom tools (T):**
- `wiki_write(page, frontmatter, body)` — the only way to write `knowledge/`; enforces inline-YAML; subagent-safe.
- `worktree(action, run_id)` — §10.

`log_outcome` may be folded into `wiki_write`.

**Model selection and escalation are Conductor logic, not code.** The verify-trigger hook only reports pass/fail; the Conductor decides junior-retry vs senior-escalation, and picks the starting builder level from Intake's tier + confidence. No new code, no subagent hook, no `deny`.

---

## 13. Self-improvement loop — [N]  (R1, R7)

On every Merge:
1. `log_outcome` appends `{ task, tier, builder_level, files, tests, duration, tokens, learnings }` to `knowledge/runs.md`.
2. The Conductor writes/updates the relevant **wiki page** via `wiki_write`: new patterns, gotchas, corrected `source_refs`.
3. It refines `knowledge/index.md` Navigation Hints when a task reveals a better mapping.

Effect over N runs: scans **narrow** (better `source_refs`), routing **sharpens** (tier/model calibration learns from outcomes), briefs **shrink**. Per-task token cost falls with usage — the first run builds the knowledge, later runs spend it. Measurable via A16.7.

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
    wiki-write.ts worktree.ts
  commands/
    bootstrap.md                      # /bootstrap (§7.2)
knowledge/
  index.md <area>.md test-impact.md runs.md preflight.md
.harness/
  wt/<run_id>/                        # worktrees (gitignored)
AGENTS.md                             # installs addyosmani skills; points stages at them
```

---

## 15. Build order with checkpoints — [N]

Do not pass a checkpoint until its assertion holds.

1. **Preflight (§3).** PASS 1–7.
2. **Spine: intake-first hook.** PASS a raw source `edit` is blocked before a Ticket exists; allowed after.
3. **`worktree` tool.** PASS open -> edit in isolation -> discard reverts only that branch; two parallel worktrees don't see each other.
4. **`wiki_write` + `index.md` seed.** PASS a wiki page round-trips with inline frontmatter intact.
5. **Intake subagent + knowledge pre-scan.** PASS "move background" scans <= the matched page's source dir; the Conductor receives only a Ticket, not file contents.
6. **Route floor + tiers + model pick.** PASS Tier 0 picks junior and skips Ground/Planner; Tier 2 picks senior and blocks Builder until Ground ran.
7. **Builder-junior / -senior subagents + constructed toolset.** PASS a Builder subagent cannot raw-write `knowledge/`; a Verify failure escalates junior -> senior after one retry.
8. **Verify split.** PASS test-run is a passive hook (no subagent); Tier 2 review is an independent Critic subagent per slice.
9. **Test-engineer independence.** PASS for a critical task, the test author is a separate subagent that did not see the implementation.
10. **Merge + self-improvement write.** PASS a new/updated wiki page and a `runs.md` entry exist after a run.
11. **`/bootstrap`.** PASS on an existing repo, `index.md` answers "where does X live?" with no code scan.
12. **Acceptance suite (§16).** PASS all green.

---

## 16. Acceptance suite — [N]

The build is **done** only when all pass. Drive via the TUI or `opencode run --attach`.

- **A16.1 — intake-first.** Non-English message, no `/run`. Assert: a normalized English Ticket exists AND the reply is in the user's language.
- **A16.2 — knowledge pre-scan (R5).** Seed a wiki page for area X; task in X. Assert: files read ⊆ X's `source_refs`.
- **A16.3 — worktree isolation (R6).** Two parallel runs; `/undo` run A. Assert: A reverted, B intact, main untouched.
- **A16.4 — test policy (R4).** A bug fix. Assert: a failing regression test was written before the fix, then passes. A cosmetic change asserts no unit test was manufactured.
- **A16.5 — cold start (R2).** Empty `knowledge/`, one task. Assert: a wiki page + an `index.md` hint now exist.
- **A16.6 — bootstrap (R3).** `/bootstrap` on a repo with code, no knowledge. Assert: "where does X live?" answered from `index.md`, zero code scan.
- **A16.7 — amortization (R1, R7).** Same class of task 5×, logging tokens. Assert: tokens-per-task trends down.
- **A16.8 — tier pruning + builder-is-subagent.** A trivial task. Assert: Ground/Planner never fired; the build ran in a subagent (the Conductor's context did not accumulate file contents).
- **A16.9 — subagent containment.** A Builder subagent attempts raw `write` to `knowledge/`. Assert: it cannot; it uses `wiki_write` or escalates.
- **A16.10 — model escalation.** Force a junior Verify failure twice. Assert: the task escalates to builder-senior with the failure context (not a third junior attempt).
- **A16.11 — test independence + tautology audit.** A Tier 2 critical task. Assert: tests were authored by the test-engineer subagent (not the builder), and the Critic flags a deliberately tautological test.
- **A16.12 — per-slice review.** A multi-slice Tier 2 task. Assert: review ran at each slice boundary, not once at the end.

---

## 17. Skills referenced — [I]

From `github.com/addyosmani/agent-skills` (install via `AGENTS.md` + the `skill` tool; see their `docs/opencode-setup.md`).

| Agent / stage | Skill(s) |
|---|---|
| Intake | `spec-driven-development`, `interview-me`, `idea-refine` |
| Ground | `context-engineering`, `source-driven-development` |
| Planner | `planning-and-task-breakdown` |
| Builder (junior/senior) | `incremental-implementation`, `test-driven-development`, `frontend-ui-engineering` (UI), `api-and-interface-design` (APIs) |
| Test-engineer | `test-driven-development` (+ `test-engineer` persona) |
| Critic | `code-review-and-quality`, `doubt-driven-development`, `security-and-hardening` |
| Verify (run) | mechanical — no skill |
| Merge | `git-workflow-and-versioning`, `documentation-and-adrs` |
| Bootstrap | `spec-driven-development`, `documentation-and-adrs` |

Their **progressive disclosure** design (SKILL.md is the entry point; references load only when needed) is the same token discipline as the knowledge `index.md` -> wiki-page pattern, and the same discipline as keeping each subagent's seeded context tight. Reuse it.

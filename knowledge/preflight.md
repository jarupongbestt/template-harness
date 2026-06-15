---
title: Preflight Results
kind: preflight
status: pending
source_refs: "harness-build-spec-2.md (§3)"
updated: 2026-06-15
---
# Preflight Checks

Run these before building the harness on *your* opencode version (§3 of the spec).

- [ ] 1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
- [ ] 2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written.
- [ ] 3. **Custom tool runs from subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
- [ ] 4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write.
- [ ] 5. **Worktree create/remove works.** `git worktree add` -> write -> `git worktree remove`, isolated from main tree.
- [ ] 6. **`skill` tool resolves.** The Conductor can invoke skills from `.opencode/skills/`.
- [ ] 7. **Per-agent model switch.** Two agent defs with different `model:` actually run on different models.
- [ ] 8. **(Optional) Parallel headless runs.** `opencode serve` starts and `createOpencodeClient` connects.

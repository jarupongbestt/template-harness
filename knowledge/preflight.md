---
title: Preflight Results
kind: preflight
status: pending
source_refs: "harness-build-spec-3.md (§3)"
updated: 2026-06-19
---
# Preflight Checks

Run these before building the harness on *your* opencode version (§3 of the spec).

- [ ] 1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
- [ ] 2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written.
- [ ] 3. **Custom tool runs from subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
- [ ] 4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write (the tool is absent, not merely denied).
- [ ] 5. **`question` tool works from the Conductor.** The primary agent calls `question` with 3 options; the user's selection comes back as structured output.
- [ ] 6. **`/undo` restores an in-place edit.** A subagent edits a tracked file in the working dir; the user runs `/undo`; the file reverts to its pre-edit content.
- [ ] 7. **`/undo` → `/redo` round-trip.** After 6, `/redo` restores the edit exactly. If `/redo` lands on a wrong/stale state on your version, note it.
- [ ] 8. **`snapshot: true` confirmed.** Config has snapshots enabled.
- [ ] 9. **`skill` tool resolves.** Install one addyosmani skill; the Conductor can invoke it.
- [ ] 10. **Per-agent model switch.** Two agent defs with different `model:` run on different models.

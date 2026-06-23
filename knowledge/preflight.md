---
title: Preflight Results (v4)
kind: preflight
status: pending
source_refs: "harness-build-spec.md (§3)"
updated: 2026-06-22
---
# Preflight Checks

Run these before building the harness on *your* opencode version (§3 of `harness-build-spec.md`).

- [ ] 1. **Primary hook fires.** Plugin logs in `tool.execute.before`; a primary-agent `bash` call appears in the log.
- [ ] 2. **Subagent hook firing.** Spawn a subagent that calls `bash`. If the hook does **not** fire, proceed as written. If it **does** fire on your version, you may move some guards to hooks — record that here.
- [ ] 3. **Custom tool runs from a subagent.** A no-op custom tool's `execute()` runs when a subagent calls it.
- [ ] 4. **Constructed toolset holds.** Give a subagent a toolset without `write`; confirm it cannot write (the tool is absent, not merely denied).
- [ ] 5. **`question` tool works from the Conductor.** The primary agent calls `question` with 2 options + a custom-text field; the user's selection comes back as structured output. *(Optional: test from a subagent. If it fails there, the Approve gate MUST run on the primary — see §8.3.)*
- [ ] 6. **`/undo` restores an in-place edit.** A subagent edits a tracked file in the working dir; the user runs `/undo`; the file reverts.
- [ ] 7. **`/undo` → `/redo` round-trip.** After 6, `/redo` restores the edit exactly. If `/redo` lands on a stale state on your version (#5910/#10589), note it: git is the durable net, but warn the user that `/redo` is unreliable here.
- [ ] 8. **`snapshot: true` confirmed.** Config has snapshots enabled.
- [ ] 9. **`skill` tool resolves.** Install one addyosmani skill; the Conductor can invoke it.
- [ ] 10. **Per-agent model switch.** Two agent defs with different `model:` run on different models.

---
description: "Navigation index for the Bridge harness v4. Working on the harness pipeline itself? -> harness-build-spec-4.md"
source_refs: "harness-build-spec-4.md, AGENTS.md"
updated: 2026-06-22
---
# Knowledge Index

## Navigation Hints

| When working on... | Read these pages |
|---|---|---|
| The harness pipeline architecture, agents, stages, build order | `harness-build-spec-4.md` |
| Agent-to-skill mapping, progressive disclosure | `AGENTS.md` |
| Approve gate — how the plan is presented and the user Proceeds or asks for adjustment | `harness-build-spec-4.md (§8.3)` |
| Planner — task decomposition with self-grounding and level tags | `harness-build-spec-4.md (§8.4)` |
| Route — tier-based model selection for Planner and builder floor | `harness-build-spec-4.md (§8.2)` |
| Bootstrap or cold start a project | `harness-build-spec-4.md (§7)`, `commands/bootstrap.md` |
| Adding or modifying custom tools | `harness-build-spec-4.md (§12)`, `.opencode/tools/` |
| Spine plugin hooks (dirty-tree guard, plan-approved gate, route-floor, git-write guard, verify) | `harness-build-spec-4.md (§12)`, `.opencode/plugins/spine.ts` |
| In-place execution model (no worktree, no merge) | `harness-build-spec-4.md (§10)` |
| Finalize (scope audit, self-improvement, stop) | `harness-build-spec-4.md (§8.7)` |

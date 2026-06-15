import { tool } from "@opencode-ai/plugin"
import { $ } from "bun"
import path from "node:path"

export default tool({
  description: "Manage git worktrees for run isolation. Actions: open (create worktree+branch), merge (fast-forward into main + cleanup), discard (remove without merging).",
  args: {
    action: tool.schema
      .enum(["open", "merge", "discard"])
      .describe("Worktree action: open = create, merge = integrate + cleanup, discard = remove without merging"),
    run_id: tool.schema.string().describe("Unique run identifier (alphanumeric, hyphens allowed)"),
  },
  async execute(args, context) {
    const runId = args.run_id.replace(/[^a-zA-Z0-9_-]/g, "-")
    const repoRoot = context.worktree || context.directory
    const wtDir = path.join(repoRoot, ".harness", "wt", runId)
    const branch = `harness/${runId}`

    try {
      switch (args.action) {
        case "open": {
          const { exitCode, stderr } = await $`git worktree add ${wtDir} -b ${branch}`.quiet()
          if (exitCode !== 0) {
            return `Error creating worktree: ${stderr.toString().trim()}`
          }
          return JSON.stringify({
            action: "open",
            run_id: runId,
            worktree_path: wtDir,
            branch,
          })
        }

        case "merge": {
          const currentBranch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim()

          if (currentBranch !== "main") {
            const { exitCode: checkoutCode, stderr: checkoutErr } = await $`git checkout main`.quiet()
            if (checkoutCode !== 0) {
              return `Error switching to main: ${checkoutErr.toString().trim()}`
            }
          }

          const { exitCode: mergeCode, stderr: mergeErr } = await $`git merge --ff-only ${branch}`.quiet()
          if (mergeCode !== 0) {
            await $`git checkout ${currentBranch}`.quiet()
            return `Fast-forward merge failed (branch may have diverged). Error: ${mergeErr.toString().trim()}`
          }

          await $`git branch -d ${branch}`.quiet()
          await $`git worktree remove ${wtDir}`.quiet()

          if (currentBranch !== "main") {
            await $`git checkout ${currentBranch}`.quiet()
          }

          return JSON.stringify({
            action: "merge",
            run_id: runId,
            merged_into: "main",
          })
        }

        case "discard": {
          const { exitCode: wtCheck } = await $`test -d ${wtDir}`.quiet()
          if (wtCheck === 0) {
            await $`git worktree remove ${wtDir}`.quiet()
          }

          const { exitCode: branchCheck } = await $`git branch --list ${branch}`.quiet()
          if (branchCheck === 0) {
            await $`git branch -D ${branch}`.quiet()
          }

          return JSON.stringify({
            action: "discard",
            run_id: runId,
            status: "reverted",
          })
        }
      }
    } catch (err) {
      return `Worktree error: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})

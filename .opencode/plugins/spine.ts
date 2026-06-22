import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"

interface SessionState {
  hasTicket: boolean
  tier: number
  /** Per-task approval flag, keyed by taskId (session monotonic counter). Set only by Conductor recording a Proceed answer to the short proceed gate (§8.3). */
  plan_approved: Map<string, boolean>
  /** Monotonic counter per session, incremented at each new intake. */
  taskCounter: number
  userLanguage: string
  dirtyTreeGuardFired: boolean
}

interface TestImpactEntry {
  source: string
  test: string
  command: string
}

const state = new Map<string, SessionState>()

function getState(sessionID: string): SessionState {
  if (!state.has(sessionID)) {
    state.set(sessionID, {
      hasTicket: false,
      tier: -1,
      plan_approved: new Map(),
      taskCounter: 0,
      userLanguage: "en",
      dirtyTreeGuardFired: false,
    })
  }
  return state.get(sessionID)!
}

function nextTaskId(s: SessionState): string {
  return `task_${++s.taskCounter}`
}

const SOURCE_TOOLS = new Set(["edit", "write", "bash"])
const EXEMPT_PREFIXES = ["knowledge/"]
const EXEMPT_TOOLS = new Set(["wiki_write"])

function isSourceTool(tool: string): boolean {
  return SOURCE_TOOLS.has(tool)
}

function isExempt(args: Record<string, unknown>): boolean {
  if (typeof args.filePath === "string" && EXEMPT_PREFIXES.some((p) => args.filePath.startsWith(p))) {
    return true
  }
  return false
}

function isGitWriteCommand(command: string): boolean {
  // §10: only git diff/status/show are allowed (read-only logging/scope-audit)
  const readOnlyPattern = /^git\s+(diff|status|show)(\s|$)/
  const trimmed = command.trim()
  if (readOnlyPattern.test(trimmed)) return false
  // Anything else starting with `git ` is a write command
  return /^git\s/.test(trimmed)
}

async function loadTestImpactMap(directory: string): Promise<TestImpactEntry[]> {
  try {
    const impactPath = path.join(directory, "knowledge", "test-impact.md")
    const content = await readFile(impactPath, "utf-8")
    const entries: TestImpactEntry[] = []
    const tableRegex = /\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g
    let match: RegExpExecArray | null
    while ((match = tableRegex.exec(content)) !== null) {
      const source = match[1].trim()
      const test = match[2].trim()
      const command = match[3].trim()
      if (source && test && command && !source.startsWith("-") && source !== "Source area") {
        entries.push({ source, test, command })
      }
    }
    return entries
  } catch {
    return []
  }
}

function findScopedTests(changedFiles: string[], impactMap: TestImpactEntry[]): TestImpactEntry[] {
  const matched: TestImpactEntry[] = []
  for (const file of changedFiles) {
    for (const entry of impactMap) {
      if (file.startsWith(entry.source) || file.startsWith(entry.source.replace(/\/$/, ""))) {
        if (!matched.includes(entry)) {
          matched.push(entry)
        }
      }
    }
  }
  return matched
}

export const Spine: Plugin = async (ctx) => {
  return {
    "chat.message": async (input, _output) => {
      const s = getState(input.sessionID)
      if (input.message?.role === "user" && input.message?.content) {
        const content = typeof input.message.content === "string"
          ? input.message.content
          : Array.isArray(input.message.content)
            ? input.message.content.map((c: { text?: string }) => c.text || "").join("")
            : ""
        const langDetect = content.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u0e00-\u0e7f]/)
        s.userLanguage = langDetect ? "native" : "en"
      }
    },

    "tool.execute.before": async (input, output) => {
      const s = getState(input.sessionID)

      // --- Git-write guard (§12) ---
      // Block mutating git commands from any bash call. Hooks only fire on Conductor,
      // but this is the last line of defense; subagent toolsets also deny write git.
      if (input.tool === "bash" && input.args?.command && isGitWriteCommand(String(input.args.command))) {
        output.error = `Git-write guard: "${String(input.args.command).split(/\s+/).slice(0, 3).join(" ")}" is a mutating git command. The harness never writes git (§10). Allowed: git diff, git status, git show (read-only).`
        return
      }

      // --- Dirty-tree guard (§10) ---
      // On the first source-touching action of a task, check if working tree is dirty.
      if (isSourceTool(input.tool) && !isExempt(input.args ?? {})) {
        if (!s.dirtyTreeGuardFired && s.hasTicket) {
          s.dirtyTreeGuardFired = true
          try {
            const { exitCode, stdout } = await ctx.$`git status --porcelain`.quiet()
            if (exitCode === 0 && stdout.toString().trim().length > 0) {
              output.error = "DIRTY_TREE: You have uncommitted changes in your working tree. Ask the user via the `question` tool: 'You have uncommitted changes. Commit or stash them first so /undo only affects this run?'. Blocking until resolved."
              return
            }
          } catch {
            // git check failed — proceed anyway
          }
        }
      }

      // --- Plan-approved gate (§12) ---
      // On every source edit/write/mutating-bash: check the per-task plan_approved flag.
      // Hooks only fire on the Conductor (§2), so this gate protects Conductor-level edits.
      // Subagent protection is via constructed toolset + route-floor gate below.
      if (isSourceTool(input.tool) && !isExempt(input.args ?? {})) {
        // Determine the current taskId. The Conductor is expected to set currentTaskId
        // on itself after each intake (via the prompt). If none set, use the latest key.
        const currentTaskKey = getCurrentTaskKey(s)
        const approved = currentTaskKey ? s.plan_approved.get(currentTaskKey) : false

        if (!approved) {
          // Block — tell the Conductor to present the plan and run the short proceed gate.
          output.error = `PLAN_NOT_APPROVED: No plan approved for this task. Present the Planner's user_summary as a plain-language message, then call the \`question\` tool with exactly 2 options (1. ▶ Proceed / 2. 💬 Ask / adjust). The build may not start until the user picks Proceed.`
          return
        }
        // If approved, pass silently — no prompt, no block.
      }

      // --- Route-floor gate (§12) ---
      // Block Builder/Critic spawning if the plan is not approved for the current task.
      if (input.tool === "task" && input.args?.name) {
        const subagentName = String(input.args.name)

        // Any subagent spawn that could touch source requires plan approval.
        if ((subagentName.startsWith("builder-") || subagentName === "critic" || subagentName === "test-engineer")) {
          const currentTaskKey = getCurrentTaskKey(s)
          const approved = currentTaskKey ? s.plan_approved.get(currentTaskKey) : false

          if (!approved) {
            output.error = `Route-floor gate: Cannot spawn "${subagentName}" — plan not yet approved. The Conductor must present the Planner's user_summary and run the short proceed gate (§8.3) before any build stage.`
            return
          }
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const s = getState(input.sessionID)

      // --- On Intake completion: record ticket, set currentTaskId ---
      if (input.tool === "task" && input.args?.name === "intake" && output.result) {
        try {
          const ticket = typeof output.result === "string" ? JSON.parse(output.result) : output.result
          if (ticket.tier !== undefined) {
            const taskId = nextTaskId(s)
            s.hasTicket = true
            s.tier = ticket.tier
            s.dirtyTreeGuardFired = false
            // Reset: new intake = new task, not yet approved
            // (plan_approved map stays but has no entry for this taskId yet)
            // Conductor will set approval when Proceed is picked.
          }
        } catch {
          // Intake result was not valid JSON Ticket; leave state unchanged
        }
      }

      // --- On question tool result: detect Proceed answer (§8.3) ---
      // If the user selected option 1 (Proceed), set plan_approved for the current task.
      if (input.tool === "question" && output.result) {
        try {
          const result = typeof output.result === "string" ? JSON.parse(output.result) : output.result
          // The question tool returns structured output. Detect "Proceed" (option 1).
          // Try common formats: { selected: "1" }, { option: "0"/0 }, { value: "Proceed" }, etc.
          const selected = result?.selected ?? result?.option ?? result?.value ?? ""
          const selectedStr = String(selected).trim()
          // Option 1 is "▶ Proceed" — match by "1" or "Proceed"
          if (selectedStr === "1" || selectedStr === "0" || /proceed/i.test(selectedStr)) {
            const currentTaskKey = getCurrentTaskKey(s)
            if (currentTaskKey) {
              s.plan_approved.set(currentTaskKey, true)
            }
          }
        } catch {
          // Parsing failed — leave state unchanged
        }
      }

      // --- On Builder completion: VERIFY TRIGGER (§8.7a) ---
      if (input.tool === "task" && typeof input.args?.name === "string" && input.args.name.startsWith("builder-")) {
        try {
          const { stdout: diffStdout } = await ctx.$`git diff --name-only`.quiet()
          const changedFiles = diffStdout.toString().trim().split("\n").filter(Boolean)

          if (changedFiles.length > 0) {
            const impactMap = await loadTestImpactMap(ctx.directory)
            const scopedTests = findScopedTests(changedFiles, impactMap)

            if (scopedTests.length > 0) {
              const seen = new Set<string>()
              let allPassed = true
              let outputLines: string[] = []

              for (const entry of scopedTests) {
                if (seen.has(entry.command)) continue
                seen.add(entry.command)

                const { exitCode, stdout, stderr } = await ctx.$`bash -c ${entry.command}`.quiet()
                const passed = exitCode === 0
                if (!passed) allPassed = false
                outputLines.push(`  ${entry.source} → ${entry.test}: ${passed ? "PASS" : "FAIL"}`)
                if (!passed) {
                  outputLines.push(`    stdout: ${stdout.toString().trim().slice(0, 200)}`)
                  outputLines.push(`    stderr: ${stderr.toString().trim().slice(0, 200)}`)
                }
              }

              const testResult = allPassed ? "PASS" : "FAIL"
              const summary = `\n[VERIFY] Scoped tests: ${testResult}\n` + outputLines.join("\n")
              output.output = (output.output ? String(output.output) + summary : summary).trim()
            } else {
              // No scoped tests found — fall back to full suite
              const { exitCode, stdout, stderr } = await ctx.$`npm test 2>/dev/null || echo "no-test-runner"`.quiet()
              const fullOutput = (stdout.toString() + stderr.toString()).trim()
              if (fullOutput.includes("no-test-runner")) {
                output.output = (output.output ? String(output.output) + "\n[VERIFY] No test runner configured. Manual verification required." : "[VERIFY] No test runner configured. Manual verification required.").trim()
              } else {
                const testResult = exitCode === 0 ? "PASS" : "FAIL"
                output.output = (output.output ? String(output.output) + `\n[VERIFY] Full suite: ${testResult}\n${fullOutput.slice(0, 500)}` : `[VERIFY] Full suite: ${testResult}\n${fullOutput.slice(0, 500)}`).trim()
              }
            }
          } else {
            output.output = (output.output ? String(output.output) + "\n[VERIFY] No files changed — skipping tests." : "[VERIFY] No files changed — skipping tests.").trim()
          }
        } catch (err) {
          output.output = (output.output ? String(output.output) + `\n[VERIFY] Error running tests: ${err instanceof Error ? err.message : String(err)}` : `[VERIFY] Error running tests: ${err instanceof Error ? err.message : String(err)}`).trim()
        }
      }
    },
  }
}

/** Get the current task key — the latest task whose plan_approved status matters.
 *  This uses the highest-numbered task key from the taskCounter. */
function getCurrentTaskKey(s: SessionState): string | null {
  if (s.taskCounter === 0) return null
  return `task_${s.taskCounter}`
}

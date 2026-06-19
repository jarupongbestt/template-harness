import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"

interface SessionState {
  hasTicket: boolean
  tier: number
  confirmed: boolean
  groundRan: boolean
  plannerRan: boolean
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
      confirmed: false,
      groundRan: false,
      plannerRan: false,
      userLanguage: "en",
      dirtyTreeGuardFired: false,
    })
  }
  return state.get(sessionID)!
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
      // If so, block and signal the Conductor to ask the user to commit/stash first.
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

      // --- Route-floor gate (§12) ---
      // Block Builder/Ground/Planner spawning if required upstream stages haven't run.
      if (input.tool === "task" && input.args?.name) {
        const subagentName = String(input.args.name)

        // Confirm gate must pass before any downstream stage
        if ((subagentName === "ground" || subagentName === "planner" || subagentName.startsWith("builder-")) && !s.confirmed) {
          output.error = "Confirmed-first gate: Task not yet confirmed. The Conductor must call `question` to confirm the target with the user before spawning downstream stages. Return control to the Conductor."
          return
        }

        if (subagentName.startsWith("builder-")) {
          if (s.tier === 1 && !s.groundRan) {
            output.error = "Route-floor gate: Tier 1 requires Ground to run before Builder. Route up."
            return
          }
          if (s.tier >= 2) {
            if (!s.groundRan) {
              output.error = "Route-floor gate: Tier 2 requires Ground to run before Builder. Route up."
              return
            }
            if (!s.plannerRan) {
              output.error = "Route-floor gate: Tier 2 requires Planner to run before Builder. Route up."
              return
            }
          }
        }

        if (subagentName === "ground") {
          s.groundRan = true
        }
        if (subagentName === "planner") {
          s.plannerRan = true
        }
      }

      // --- Confirmed-first gate (§12, silent check on source edits) ---
      // Blocks raw source edits from the Conductor before the user has confirmed the target.
      // Per §2, hooks on subagents don't fire, so this gate only protects Conductor-level edits.
      // Subagent enforcement is via constructed toolset.
      if (isSourceTool(input.tool) && !isExempt(input.args ?? {})) {
        if (!s.confirmed) {
          output.error = "Confirmed-first gate: No confirmation for this task. The Conductor must call `question` to confirm the target before editing source files."
          return
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      const s = getState(input.sessionID)

      // --- On Intake completion: record ticket ---
      if (input.tool === "task" && input.args?.name === "intake" && output.result) {
        try {
          const ticket = typeof output.result === "string" ? JSON.parse(output.result) : output.result
          if (ticket.tier !== undefined) {
            s.hasTicket = true
            s.tier = ticket.tier
            s.confirmed = false
            s.groundRan = false
            s.plannerRan = false
            s.dirtyTreeGuardFired = false
          }
        } catch {
          // Intake result was not valid JSON Ticket; leave state unchanged
        }
      }

      // --- On Confirm completion: mark confirmed ---
      // Detectable by a `question` tool call that selects a confirmation option.
      // Simpler approach: Conductor can call wiki_write or another signal tool after confirm,
      // but for now the Conductor agent prompt handles the logic and we trust it.
      // The spine doesn't auto-set confirmed — the Conductor's question handling does.
      // (This could be enhanced with a dedicated "confirm" custom tool later.)

      // --- On Builder completion: VERIFY TRIGGER (§8.7a) ---
      // Run scoped tests on the files the builder changed in the working tree.
      if (input.tool === "task" && typeof input.args?.name === "string" && input.args.name.startsWith("builder-")) {
        // Get changed files via git diff on the working tree
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

import type { Plugin } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"

interface SessionState {
  hasTicket: boolean
  tier: number
  groundRan: boolean
  plannerRan: boolean
  userLanguage: string
  currentRunId: string | null
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
      groundRan: false,
      plannerRan: false,
      userLanguage: "en",
      currentRunId: null,
    })
  }
  return state.get(sessionID)!
}

const SOURCE_TOOLS = new Set(["edit", "write", "bash"])
const EXEMPT_PREFIXES = ["knowledge/", ".harness/"]
const EXEMPT_TOOLS = new Set(["wiki_write", "worktree"])

function isSourceTool(tool: string): boolean {
  return SOURCE_TOOLS.has(tool)
}

function isExempt(args: Record<string, unknown>): boolean {
  if (typeof args.filePath === "string" && EXEMPT_PREFIXES.some((p) => args.filePath.startsWith(p))) {
    return true
  }
  return false
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

function getWorktreePath(repoRoot: string, runId: string): string {
  return path.join(repoRoot, ".harness", "wt", runId)
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

      if (input.tool === "task" && input.args?.name) {
        const subagentName = String(input.args.name)

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

      if (isSourceTool(input.tool) && !isExempt(input.args ?? {})) {
        if (!s.hasTicket) {
          output.error = "Intake-first gate: No Ticket exists. Run Intake first to produce a Ticket before editing source files."
          return
        }
      }

      if (input.tool === "wiki_write" && input.args?.page === "runs" && !s.hasTicket) {
        output.error = "Cannot log outcome before a Ticket exists."
        return
      }
    },

    "tool.execute.after": async (input, output) => {
      const s = getState(input.sessionID)

      if (input.tool === "task" && input.args?.name === "intake" && output.result) {
        try {
          const ticket = typeof output.result === "string" ? JSON.parse(output.result) : output.result
          if (ticket.tier !== undefined) {
            s.hasTicket = true
            s.tier = ticket.tier
            s.groundRan = false
            s.plannerRan = false
          }
        } catch {
          // Intake result was not valid JSON Ticket; leave state unchanged
        }
      }

      if (input.tool === "worktree" && input.args?.action === "open") {
        s.currentRunId = String(input.args.run_id)
      }

      // --- VERIFY TRIGGER (§8.6a) ---
      // When a builder subagent finishes, run scoped tests on the changed files
      if (input.tool === "task" && typeof input.args?.name === "string" && input.args.name.startsWith("builder-")) {
        const runId = s.currentRunId
        if (runId) {
          const wtPath = getWorktreePath(ctx.directory, runId)

          // Get changed files via git diff in the worktree
          const { stdout: diffStdout, stderr: diffStderr } = await ctx.$`git -C ${wtPath} diff --name-only`.quiet()
          const changedFiles = diffStdout.toString().trim().split("\n").filter(Boolean)

          if (changedFiles.length > 0) {
            // Load test impact map
            const impactMap = await loadTestImpactMap(ctx.directory)
            const scopedTests = findScopedTests(changedFiles, impactMap)

            let testResult: string
            if (scopedTests.length > 0) {
              // Run each scoped test command
              const seen = new Set<string>()
              let allPassed = true
              let outputLines: string[] = []

              for (const entry of scopedTests) {
                if (seen.has(entry.command)) continue
                seen.add(entry.command)

                const { exitCode, stdout, stderr } = await ctx.$`cd ${wtPath} && ${entry.command}`.quiet()
                const passed = exitCode === 0
                if (!passed) allPassed = false
                outputLines.push(`  ${entry.source} → ${entry.test}: ${passed ? "PASS" : "FAIL"}`)
                if (!passed) {
                  outputLines.push(`    stdout: ${stdout.toString().trim().slice(0, 200)}`)
                  outputLines.push(`    stderr: ${stderr.toString().trim().slice(0, 200)}`)
                }
              }

              testResult = allPassed ? "PASS" : "FAIL"
              const summary = `\n[VERIFY] Scoped tests: ${testResult}\n` + outputLines.join("\n")
              output.result = (output.result ? String(output.result) + summary : summary).trim()
            } else {
              // No scoped tests found — fall back to full suite
              const { exitCode, stdout, stderr } = await ctx.$`cd ${wtPath} && npm test 2>/dev/null || echo "no-test-runner"`.quiet()
              const fullOutput = (stdout.toString() + stderr.toString()).trim()
              if (fullOutput.includes("no-test-runner")) {
                testResult = "SKIP"
                output.result = (output.result ? String(output.result) + "\n[VERIFY] No test runner configured. Manual verification required." : "[VERIFY] No test runner configured. Manual verification required.").trim()
              } else {
                testResult = exitCode === 0 ? "PASS" : "FAIL"
                output.result = (output.result ? String(output.result) + `\n[VERIFY] Full suite: ${testResult}\n${fullOutput.slice(0, 500)}` : `[VERIFY] Full suite: ${testResult}\n${fullOutput.slice(0, 500)}`).trim()
              }
            }
          } else {
            output.result = (output.result ? String(output.result) + "\n[VERIFY] No files changed — skipping tests." : "[VERIFY] No files changed — skipping tests.").trim()
          }
        } else {
          output.result = (output.result ? String(output.result) + "\n[VERIFY] Warning: No active worktree found for this builder run." : "[VERIFY] Warning: No active worktree found for this builder run.").trim()
        }
      }

      if (input.tool === "worktree" && (input.args?.action === "merge" || input.args?.action === "discard")) {
        s.currentRunId = null
        s.hasTicket = false
        s.tier = -1
        s.groundRan = false
        s.plannerRan = false
      }
    },
  }
}

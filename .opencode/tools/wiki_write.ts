import { tool } from "@opencode-ai/plugin"
import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"

export default tool({
  description: "Write a knowledge wiki page with inline YAML frontmatter enforcement. The only way to write to knowledge/.",
  args: {
    page: tool.schema.string().describe("Wiki page name (without .md extension)"),
    frontmatter: tool.schema
      .object({})
      .passthrough()
      .describe("YAML frontmatter as key-value object. Only inline (scalar) values allowed — no lists/arrays."),
    body: tool.schema.string().describe("Markdown body content"),
  },
  async execute(args, context) {
    const pageName = args.page.replace(/\.md$/, "").replace(/[^a-zA-Z0-9_-]/g, "-")
    const knowledgeDir = path.join(context.directory, "knowledge")

    for (const [key, value] of Object.entries(args.frontmatter)) {
      if (Array.isArray(value)) {
        return `Error: Frontmatter key "${key}" contains a YAML list. Inline YAML only — use string values (e.g. "a.md, b.md") instead of ["a.md", "b.md"].`
      }
      if (typeof value === "object" && value !== null) {
        return `Error: Frontmatter key "${key}" contains a nested object. Inline YAML only — use flat key-value pairs.`
      }
    }

    const frontmatterLines = [["---"]]
    for (const [key, value] of Object.entries(args.frontmatter)) {
      frontmatterLines.push([`${key}: ${JSON.stringify(String(value))}`])
    }
    frontmatterLines.push(["---"])
    frontmatterLines.push([""])
    frontmatterLines.push([args.body])

    const content = frontmatterLines.map((l) => l.join("")).join("\n")

    try {
      await mkdir(knowledgeDir, { recursive: true })
      const filePath = path.join(knowledgeDir, `${pageName}.md`)
      await writeFile(filePath, content, "utf-8")
      return `Wiki page "knowledge/${pageName}.md" written successfully.`
    } catch (err) {
      return `Error writing wiki page: ${err instanceof Error ? err.message : String(err)}`
    }
  },
})

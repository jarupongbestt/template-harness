---
description: "Generate initial knowledge layer from existing codebase: walk repo structure, generate index.md, wiki pages per area, test-impact.md skeleton"
---

You are running the /bootstrap command. Your task is to generate the initial knowledge layer from the existing codebase.

## Process

1. **Walk the repo structure**
   - List top-level directories and files.
   - Identify manifests (package.json, Cargo.toml, pyproject.toml, etc.).
   - Identify entrypoints (main.ts, index.ts, app.py, main.py, etc.).
   - Identify test directories (__tests__, tests, spec, etc.).

2. **Generate wiki pages**
   - One wiki page per major area (backend, frontend, data-model, deployment, etc.).
   - Each page has YAML frontmatter with `source_refs:` listing the files that area covers.
   - Each page describes the area's purpose, key files, patterns, and conventions.

3. **Update knowledge/index.md**
   - Add Navigation Hints mapping areas to wiki pages.
   - Ensure "where does X live?" is answerable from index.md alone.

4. **Generate knowledge/test-impact.md**
   - Skeleton mapping source directories to test directories.
   - Format: `source_dir -> test_dir` (one per line).

## Skills available
- `spec-driven-development`
- `documentation-and-adrs`

## Output
Summarize what was created. List each wiki page and what area it covers.

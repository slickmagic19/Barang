---
name: skill-creator
description: Guide for creating effective skills. Use when users want to create a new skill (or update an existing skill) that extends the CLI's capabilities with specialized knowledge, workflows, or tool integrations.
---

# Skill Creator

Create or update a Barang skill — a directory with a `SKILL.md` file that
teaches the agent a specialized workflow.

## Steps

1. **Pick a scope.** Project skills live in `<project>/.barang/skills/<name>/`
   (shared via git). User skills live in `<userData>/skills/<name>/` (all
   projects).
2. **Create the directory** named as a kebab-case slug (lowercase letters,
   numbers, dashes; e.g. `pdf-report`).
3. **Write `SKILL.md`** with YAML frontmatter + a markdown body:

   ```markdown
   ---
   name: pdf-report
   description: Use when the user needs a PDF generated from structured data. One-line summary of when to use this.
   ---

   # PDF Report

   Concise instructions the agent follows when this skill is loaded.
   Include exact steps, file paths, and any validation the agent must run.
   ```

4. **Keep the description specific** — it is the only text the agent sees in
   the catalog before deciding to load the skill. Start with "Use when …".
5. **Validate**: name matches `^[a-z0-9][a-z0-9-]{0,63}$`, body is non-empty,
   frontmatter parses. Barang lists the skill under Settings → Skills.

## Notes

- One skill per directory; the directory name and frontmatter `name` should
  match.
- The body is loaded on demand (not pasted into every prompt), so it can be
  long — but keep it focused on the workflow.
- To update a skill, edit its `SKILL.md` in place; Barang re-discovers on the
  next agent turn.
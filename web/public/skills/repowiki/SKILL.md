---
name: repowiki
description: Generate, browse, and maintain the Repo Wiki and knowledge cards — module overviews, architecture, tech stack, conventions, and module relations. Use for wiki generation, knowledge-card edits, and repo documentation.
---

# Repo Wiki

Generate and maintain repo documentation (wiki pages + knowledge cards).

## Steps

1. **Plan** the wiki: pick the pages/modules to cover and any template.
2. **Generate** each page from the codebase (overview, architecture, tech
   stack, conventions).
3. **Link** modules with explicit relations (depends-on, related).
4. **Maintain**: when code changes, update the affected cards rather than
   regenerating everything.

## Notes

- Ground every claim in the code; cite file paths.
- Keep module boundaries honest — do not invent relations.
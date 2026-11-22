---
name: find-extensions
description: Discover Qoder Skills, MCP connectors, and Plugins when the user explicitly asks to search, compare, recommend, or install capabilities, including a local Skill .zip/.skill archive or Plugin .zip supplied by the user.
---

# Find Extensions

Help the user extend the agent with skills, MCP connectors, and plugins.

## Steps

1. **Clarify the need.** What capability is missing? (docs, DB, browser, API…)
2. **Search** the available skill/plugin catalogs for a match; summarize the
   top candidates with one line each.
3. **Recommend** the simplest option that fits; note install steps.
4. **Local archives**: when the user supplies a `.zip`/`.skill`/plugin archive,
   route installation through the app's installer flow, never by hand.

## Notes

- Do not invent catalog entries. If nothing matches, say so and suggest
  authoring a custom skill (see the skill-creator skill).
- Prefer official/first-party extensions; flag third-party ones.
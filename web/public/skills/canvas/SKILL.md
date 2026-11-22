---
name: canvas
description: Create interactive visuals in conversation or standalone Canvas artifacts. Use proactively to explain mechanisms, compare options, or explore changes with an inline visualization; use a standalone artifact for a persistent dashboard, report, or editable visual deliverable.
---

# Canvas

Render interactive HTML visuals (explaining a mechanism, comparing options,
mocking a change) and standalone artifacts (dashboards, reports).

## Steps

1. **Choose the surface.** Inline canvas for explanations; standalone artifact
   for deliverables the user keeps.
2. **Write the HTML fragment** to the visualizations directory first, then
   render it. Keep it self-contained (inline CSS/JS, no network deps).
3. **Prefer clarity over decoration.** One idea per visual; label axes, states,
   and transitions.
4. **State limitations.** Canvas is HTML/JS — not a substitute for the
   production UI.

## Notes

- Never emit render markers in prose.
- Validate the fragment before rendering; fix errors and retry.
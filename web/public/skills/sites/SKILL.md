---
name: sites
description: Build and deploy Qoder Sites — design, code, backend capabilities (database, storage, secrets, functions), and publishing. Use for website requests that target Qoder Sites, including hosting, domains, and access management.
---

# Qoder Sites

Build, publish, and manage a Qoder Site.

## Steps

1. **Identify the site descriptor** (`.站点名称.qoder.site`) or create the
   project via the sites tooling.
2. **Build** the frontend; add backend capabilities (database migrations,
   storage, secrets, functions) through the provided tools.
3. **Preview locally**, then **publish** when the user approves.
4. **Manage**: restore access, sharing, domains, and diagnostics via the
   management tools.

## Notes

- Publish only validated work unless the user asks to go live immediately.
- Keep secrets in the secrets store, never in source.
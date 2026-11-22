---
name: collaboration
description: Operate collaboration cloud Projects, Issues, Discussions, messages and files, and route team work. Use for Qoder requests, explicit team delegation, bound Issue/Discussion work, or "my projects" queries when no other platform or skill applies.
---

# Collaboration

Route work to the collaboration cloud (projects, issues, discussions,
messages, files) and to teammates.

## Steps

1. **Resolve the target**: which project / issue / discussion / teammate.
2. **Load the collaboration skill** and inspect the exact command schema
   before executing; never invent command names.
3. **One operation per call**; check the result before the next write.
4. **Report outcomes** back in the bound thread — do not post completion
   messages outside the required channel.

## Notes

- A permission denial is not a reason to switch tools or identity.
- Batch dependent calls with `&&`; keep batches small and reviewable.
- Local follow-ups stay local unless the user asks to publish.
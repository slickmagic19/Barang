---
name: office-docx
description: Create, read, and edit Word DOCX documents — body text, layout, tables, images, and tracked comments/revisions. Use for Word file tasks; plain-text output, spreadsheets, presentations, and PDF do not use this skill.
---

# Word DOCX

Create and edit `.docx` files with body, tables, images, and revisions.

## Steps

1. **Open the document** with the DOCX tool and inspect its structure
   (paragraphs, styles, sections).
2. **Edit precisely**: address paragraphs/tables by index or style; preserve
   existing styles when inserting.
3. **For tracked changes**, use the comment/revision API rather than rewriting
   the body.
4. **Save and verify**: reopen and confirm the rendered text and layout.

## Notes

- Keep edits minimal and targeted; do not rebuild the file wholesale.
- Tables and images are anchored — respect section flow.
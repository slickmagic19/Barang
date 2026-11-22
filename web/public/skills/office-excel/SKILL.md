---
name: office-excel
description: Create and edit XLSX workbooks — import CSV, write data and formulas, apply number/cell formatting, and edit existing XLSM. Use for spreadsheet generation, reading, inspection, and collaboration; not for PPT, Word, or VBA execution.
---

# Excel

Create and edit `.xlsx` workbooks (and read/import `.csv`).

## Steps

1. **Open the workbook** and read the used range to understand the data.
2. **Write cells** by coordinate; use formulas (e.g. `=SUM(A1:A10)`) instead of
   precomputed values where the user wants live math.
3. **Format** headers, number formats, and column widths for readability.
4. **For XLSM**, edit data and ordinary formatting only — never run VBA.
5. **Save and verify** by re-reading key cells.

## Notes

- Import CSV into a new sheet rather than overwriting existing data.
- Keep formulas compatible with the target Excel version.
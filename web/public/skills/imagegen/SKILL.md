---
name: imagegen
description: Prompt-writing guidance for generating or editing raster images (photos, illustrations, textures, mockups) with the ImageGen tool. Use when the user wants a new bitmap image, wants an existing image edited or recombined, or wants variants in the style of a reference image. Do not use for SVG, HTML/CSS art, or logos-as-code.
---

# ImageGen

Write a strong image prompt, then generate or edit with the image tool.

## Prompt formula

State: **subject**, **composition**, **style**, **lighting**, **color**, and
**constraints** (what must stay unchanged for edits). Be concrete.

- Photos: name lens/lighting cues ("85mm, soft window light").
- Illustrations: name the medium ("flat vector", "ink wash").
- Edits: reference source images by order ("the first image") and say what to
  change vs. preserve.

## Workflow

1. Clarify the subject and where the image will be used (icon, hero, texture).
2. Generate at the right aspect ratio for the slot.
3. For iterations, edit the previous output rather than restarting.
4. Save the result into the project's asset directory and reference it from
   code.

## Notes

- Bitmap only. For icons/logos that must scale, prefer SVG or an icon font.
- Never invent asset URLs; use generated local paths.
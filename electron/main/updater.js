// Self-update "replace my original file" support (pure Node — no Electron
// imports, so this file is unit-tested directly with plain node).
//
// Background: the portable exe self-extracts and the RUNNING process is a
// temp copy, so an update can never overwrite "itself". Flow:
//   1. apply-update downloads the new portable to %TEMP% and (optionally)
//      writes a replace marker {source, target}.
//   2. It spawns the download and quits; the new app boots and completes
//      the copy once the old process has released the target.
//
// A marker FILE (not CLI args) carries the intent: electron-builder's
// portable wrapper does not reliably forward argv to the inner app, while
// %TEMP% is shared. Markers are freshness-checked and always deleted
// after an attempt, so a stale marker can never surprise a later boot.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const REPLACE_BASENAME = /Barang-.*-win\.exe$/i;
export const MARKER_NAME = 'barang-replace.json';
export const MARKER_MAX_AGE_MS = 30 * 60 * 1000;

export function markerPath(tempDir = os.tmpdir()) {
  return path.join(tempDir, MARKER_NAME);
}

/** Validate a replace request. Throws on anything suspicious. Pure. */
export function validateReplaceArgs(source, target) {
  const src = String(source || '');
  const tgt = String(target || '');
  if (!src || !path.isAbsolute(src)) throw new Error('Need an absolute source exe');
  if (!tgt || !path.isAbsolute(tgt)) throw new Error('Need an absolute target exe');
  if (!REPLACE_BASENAME.test(path.basename(src))) throw new Error('Not a Barang update file');
  if (!REPLACE_BASENAME.test(path.basename(tgt))) throw new Error('Not a Barang exe');
  if (src.toLowerCase() === tgt.toLowerCase()) throw new Error('Source and target are the same file');
  return { source: src, target: tgt };
}

/** Persist the intent for the freshly spawned app. Overwrites (last wins). */
export async function writeReplaceMarker(tempDir, source, target) {
  const v = validateReplaceArgs(source, target);
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(
    markerPath(tempDir),
    JSON.stringify({ source: v.source, target: v.target, at: Date.now() }),
    'utf8',
  );
  return markerPath(tempDir);
}

/** Read a fresh marker, else null (missing/stale/malformed). Never throws. */
export async function readReplaceMarker(tempDir) {
  try {
    const raw = await fs.readFile(markerPath(tempDir), 'utf8');
    const m = JSON.parse(raw);
    if (!m || typeof m !== 'object') return null;
    if (!Number.isFinite(m.at) || Date.now() - m.at > MARKER_MAX_AGE_MS || Date.now() - m.at < 0) return null;
    validateReplaceArgs(m.source, m.target);
    return { source: String(m.source), target: String(m.target), at: m.at };
  } catch {
    return null;
  }
}

export async function clearReplaceMarker(tempDir) {
  try {
    await fs.unlink(markerPath(tempDir));
  } catch {
    /* already gone */
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lockish(e) {
  const m = String(e?.code || e?.message || e);
  return /EPERM|EBUSY|EACCES|EEXIST|EAGAIN/.test(m);
}

/** Copy source over target once the old process lets go (poll + verify).
 *  Resolves { ok: true, bytes }; throws otherwise. Deletes nothing — the
 *  caller removes the marker/source on success. */
export async function replaceOriginalExe({ source, target, tries = 60, delayMs = 500 }) {
  const v = validateReplaceArgs(source, target);
  const srcStat = await fs.stat(v.source).catch(() => null);
  if (!srcStat || !srcStat.isFile() || !srcStat.size) throw new Error('Update file missing — fetch it again');
  const tgtStat = await fs.stat(v.target).catch(() => null);
  if (!tgtStat || !tgtStat.isFile()) throw new Error('Original file is gone — nothing to replace');
  let last = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    try {
      await fs.copyFile(v.source, v.target);
      const after = await fs.stat(v.target).catch(() => null);
      if (after && after.size === srcStat.size) return { ok: true, bytes: srcStat.size };
      last = new Error(`size mismatch after copy (${after?.size ?? 0}/${srcStat.size})`);
      break; // copied but wrong — retrying won't help
    } catch (e) {
      last = e;
      if (!lockish(e)) break; // real problem (permissions, disk) — don't spin
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw last instanceof Error ? last : new Error(String(last ?? 'replace failed'));
}

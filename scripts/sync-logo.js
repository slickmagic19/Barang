// Syncs the Barang logo everywhere it is needed (run as part of `npm run build`).
// Source of truth: assets/barang-logo.png (put a replacement there to rebrand).
// Outputs:
//   web/src/assets/barang-logo.png  -> bundled by Vite (hashed, in-app <img>)
//   web/public/barang-logo.png      -> copied verbatim to web/dist/ (window icon)
//   build/icon.ico                  -> PNG-embedded ICO for the packaged .exe
// The ICO format may embed PNG data directly (valid since Windows Vista), so
// no image tooling is needed — Windows scales the single image as required.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SRC = path.join(ROOT, 'assets', 'barang-logo.png');

function readPngSize(png) {
  if (png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('Not a PNG file');
  }
  if (png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG missing IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

function pngToIco(png) {
  const { width, height } = readPngSize(png);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(width >= 256 ? 0 : width, 6);
  head.writeUInt8(height >= 256 ? 0 : height, 7);
  head.writeUInt8(0, 8); // palette
  head.writeUInt8(0, 9); // reserved
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bpp
  head.writeUInt32LE(png.length, 14); // data size
  head.writeUInt32LE(22, 18); // data offset
  return Buffer.concat([head, png]);
}

const png = fs.readFileSync(SRC);
const { width, height } = readPngSize(png);
console.log(`[logo] source: ${SRC} (${width}x${height}, ${(png.length / 1024).toFixed(0)} KB)`);

const webAssets = path.join(ROOT, 'web', 'src', 'assets', 'barang-logo.png');
fs.mkdirSync(path.dirname(webAssets), { recursive: true });
fs.copyFileSync(SRC, webAssets);

const webPublic = path.join(ROOT, 'web', 'public', 'barang-logo.png');
fs.mkdirSync(path.dirname(webPublic), { recursive: true });
fs.copyFileSync(SRC, webPublic);

const buildDir = path.join(ROOT, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.ico'), pngToIco(png));
console.log('[logo] synced: web/src/assets, web/public, build/icon.ico');

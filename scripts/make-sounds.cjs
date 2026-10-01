// Barang built-in notification sounds: 100% original, synthesized locally
// (Pixabay/Mixkit block programmatic downloads via Cloudflare, so vendoring
// their files isn't possible from here — users can add any MP3 via the
// custom-sound picker in Settings > Notifications).
// Each sound = sum of sine partials with exponential decay, 44.1kHz 16-bit
// mono WAV. Run: `node scripts/make-sounds.js` (writes web/public/sounds/).
const fs = require('node:fs');
const path = require('node:path');

const SR = 44100;
const OUT = path.join(__dirname, '..', 'web', 'public', 'sounds');

function render(dur, fn) {
  const n = Math.floor(dur * SR);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = fn(i / SR, i);
  // Gentle peak normalize to -3dBFS (never clips, consistent loudness).
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 1;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, data[i] * g));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// tone(freq, t0, dur, decay, harmonics=[[mult, amp]]): enveloped partial stack.
function tone(freq, t0, dur, decay, partials = [[1, 1]]) {
  return (t) => {
    const dt = t - t0;
    if (dt < 0 || dt > dur) return 0;
    const env = Math.exp(-dt * decay) * Math.min(1, dt / 0.008); // 8ms click-free attack
    let v = 0;
    for (const [m, a] of partials) v += a * Math.sin(2 * Math.PI * freq * m * dt);
    return v * env;
  };
}
const mix = (...fns) => (t, i) => fns.reduce((a, f) => a + f(t, i), 0);
const RICH = [[1, 1], [2, 0.35], [3, 0.15]]; // warm harmonic stack
const BELL = [[1, 1], [2.76, 0.4], [5.4, 0.18]]; // inharmonic bell partials

const SOUNDS = {
  // Default "done": warm two-tone chime (E5 -> B5).
  chime: () => render(1.4, mix(
    tone(659.25, 0, 1.4, 4.2, RICH),
    tone(987.77, 0.14, 1.26, 4.6, RICH),
  )),
  // Bright single bell (E6), short.
  ding: () => render(1.0, tone(1318.5, 0, 1.0, 5.5, BELL)),
  // Subtle UI pop: rising sine sweep.
  pop: () => render(0.35, (t) => {
    if (t < 0 || t > 0.3) return 0;
    const f = 520 + (880 - 520) * (t / 0.12 > 1 ? 1 : t / 0.12);
    return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 22) * Math.min(1, t / 0.005);
  }),
  // Error alert: descending two-tone (A5 -> E5), firmer harmonics.
  alert: () => render(0.9, mix(
    tone(880, 0, 0.32, 9, RICH),
    tone(659.25, 0.22, 0.6, 7, RICH),
  )),
  // Success: rising major arpeggio C5-E5-G5-C6.
  success: () => render(1.1, mix(
    tone(523.25, 0, 1.1, 5, RICH),
    tone(659.25, 0.1, 1.0, 5, RICH),
    tone(783.99, 0.2, 0.9, 5, RICH),
    tone(1046.5, 0.3, 0.8, 5.5, RICH),
  )),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fn] of Object.entries(SOUNDS)) {
  const buf = fn();
  fs.writeFileSync(path.join(OUT, `${name}.wav`), buf);
  console.log(`${name}.wav ${(buf.length / 1024).toFixed(0)}KB`);
}

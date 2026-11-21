// Verifies the "Free Kilo Code models only" filter against the REAL kilo
// provider model list, using Kilo's authoritative per-model `isFree` flag.
// Paid models (incl. meta/muse-*, nvidia/nemotron-* without :free) must be
// excluded; only isFree:true models are shown.
//
// Run: node scripts/verify-freefilter.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KILO = path.join(ROOT, 'vendor', 'kilo', 'windows-x64', 'kilo.exe');

// --- copy of the logic under test (kept in sync by freeModels.test.ts) ---
const isFreeModel = (providerID, modelID) => modelID === 'kilo-auto/free' || /:free$/i.test(modelID);
const isFreeKiloModel = (m) =>
  m.providerID === 'kilo' && (typeof m.isFree === 'boolean' ? m.isFree : isFreeModel(m.providerID, m.modelID));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`[verify] PASS ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`[verify] FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

// Fetch the real kilo models with their isFree flags.
const models = await new Promise((resolve) => {
  const p = spawn(KILO, ['serve', '--port', '47827', '--hostname', '127.0.0.1'], { windowsHide: true });
  let done = false;
  const finish = (v) => { if (!done) { done = true; try { p.kill(); } catch {} resolve(v); } };
  setTimeout(async () => {
    try {
      const res = await fetch('http://127.0.0.1:47827/config/providers');
      const cfg = await res.json();
      const kp = (cfg.providers || []).find((x) => x.id === 'kilo');
      const out = [];
      if (kp && kp.models) {
        for (const [id, m] of Object.entries(kp.models)) out.push({ providerID: 'kilo', modelID: id, isFree: m.isFree, cost: m.cost });
      }
      finish(out);
    } catch (e) { finish([{ __error__: e.message }]); }
  }, 6000);
  p.on('exit', () => finish([]));
});

if (models[0]?.__error__) {
  check('live model fetch', false, models[0].__error__);
} else if (!models.length) {
  check('live model fetch', false, 'no models');
} else {
  check('live model fetch', models.length > 100, `${models.length} kilo models`);
  const free = models.filter((m) => isFreeKiloModel(m));
  const paid = models.filter((m) => !isFreeKiloModel(m));
  console.log(`[verify] free=${free.length} paid=${paid.length} total=${models.length}`);

  // The reported leak: meta/* models must NOT be in the free list.
  const metaInFree = free.filter((m) => m.modelID.startsWith('meta/'));
  check('no meta/* models in the free list', metaInFree.length === 0, metaInFree.map((m) => m.modelID).join(', '));

  // No paid variants without a real free signal.
  const badFree = free.filter((m) => m.isFree !== true);
  check('every free model has isFree:true', badFree.length === 0, badFree.slice(0, 5).map((m) => m.modelID).join(', '));

  // Paid family variants excluded.
  check('no paid nemotron (no :free) in free list',
    !free.some((m) => /^nvidia\/nemotron/.test(m.modelID) && m.isFree !== true));
  check('no paid claude/gpt in free list',
    !free.some((m) => /(claude|gpt-6)/i.test(m.modelID) && m.isFree !== true));

  console.log('[verify] free models:', free.map((m) => m.modelID).join(', '));
  console.log('[verify] meta models (all paid):', models.filter((m) => m.modelID.startsWith('meta/')).map((m) => `${m.modelID}(isFree=${m.isFree})`).join(', '));
}

console.log(`\n[verify] ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
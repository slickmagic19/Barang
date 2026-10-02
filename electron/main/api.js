// Bolt (API client) backend: performs HTTP requests from the main process —
// renderer fetch() would hit CORS on arbitrary APIs. Redirects followed,
// response bodies capped, requests cancellable by client-supplied id.
const pending = new Map(); // reqId -> AbortController

const MAX_BODY = 2 * 1024 * 1024; // response cap (truncated flag set)
const MAX_SEND = 10 * 1024 * 1024; // request body cap

export async function send({ reqId, method, url, headers, body, timeoutMs = 30000 }) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('URL must start with http:// or https://');
  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(m)) throw new Error(`Unsupported method: ${m}`);
  const h = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k && typeof v === 'string') h[String(k).slice(0, 200)] = v.slice(0, 8000);
  }
  let payload = null;
  if (body !== undefined && body !== null && body !== '' && m !== 'GET' && m !== 'HEAD') {
    const s = String(body);
    if (Buffer.byteLength(s) > MAX_SEND) throw new Error('Request body too large (>10MB)');
    payload = s;
  }
  const ctrl = new AbortController();
  if (reqId) pending.set(String(reqId), ctrl);
  const ms = Math.max(1000, Math.min(120000, timeoutMs | 0 || 30000));
  const to = setTimeout(() => {
    try {
      ctrl.abort(new Error('Request timed out'));
    } catch {
      /* noop */
    }
  }, ms);
  const t0 = Date.now();
  try {
    const res = await fetch(u, { method: m, headers: h, body: payload, signal: ctrl.signal, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_BODY;
    const text = (truncated ? buf.subarray(0, MAX_BODY) : buf).toString('utf8');
    const rh = {};
    res.headers.forEach((v, k) => {
      rh[k] = v;
    });
    return {
      ok: true, status: res.status, statusText: res.statusText || '', url: res.url || u,
      ms: Date.now() - t0, size: buf.length, truncated, headers: rh, body: text,
    };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? (e.message || 'Request aborted') : (e?.message || String(e));
    throw new Error(String(msg).slice(0, 300));
  } finally {
    clearTimeout(to);
    if (reqId) pending.delete(String(reqId));
  }
}

export function cancel(reqId) {
  const c = pending.get(String(reqId));
  if (!c) return false;
  try {
    c.abort(new Error('Cancelled'));
  } catch {
    /* noop */
  }
  pending.delete(String(reqId));
  return true;
}

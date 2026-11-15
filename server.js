// APEX INTELLIGENCE — multi-provider AI backend (zero dependencies, Node 18+)
// Providers: OpenAI, Anthropic (Claude), Google Gemini, Groq, OpenRouter, and any OpenAI-compatible custom API.
// API keys live ONLY in .env on this server. They are never sent to the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createStore, newId } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- tiny .env loader (no dotenv needed) ----------
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
} catch { /* no .env file: rely on real environment variables */ }

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const isReal = v => v && !/^put_your|^your_|_here$/i.test(v);
const port = Number(env('PORT', '3000'));
const MAX_TOKENS = Number(env('MAX_OUTPUT_TOKENS', '1500'));
const TRUST_PROXY = env('TRUST_PROXY') === '1';
const SIGNUP_MODE = ['open', 'invite', 'closed'].includes(env('SIGNUP_MODE')) ? env('SIGNUP_MODE') : 'open';
const INVITE_CODE = env('INVITE_CODE');
const ADMIN_EMAIL = env('ADMIN_EMAIL').toLowerCase();
const ADMIN_SETUP_CODE = env('ADMIN_SETUP_CODE');
const DAILY_LIMIT = Number(env('DAILY_MESSAGE_LIMIT', '30'));   // per normal user per day; admin is unlimited
const SESSION_DAYS = 7;
let SESSION_SECRET = env('SESSION_SECRET');
if (SESSION_SECRET.length < 24) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.log('Note: SESSION_SECRET is not set (or too short). Users will be logged out on every restart. Set a long random SESSION_SECRET in .env / hosting settings.');
}
const RATE_PER_MIN = Number(env('RATE_LIMIT_PER_MINUTE', '20'));
const SYSTEM_BASE = 'You are APEX INTELLIGENCE, a helpful AI assistant for planning software, websites, apps, business workflows, and technical learning. Be accurate. Do not claim to have deployed, executed, or built something unless it actually happened. Explain steps clearly.';

// ---------- provider registry ----------
const list = (k, fallback) => { const v = env(k); return v ? v.split(',').map(s => s.trim()).filter(Boolean) : fallback; };

const PROVIDERS = {
  openai: {
    label: 'OpenAI', keyVar: 'OPENAI_API_KEY', kind: 'openai-responses',
    base: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'), model: env('OPENAI_MODEL', 'gpt-5-mini'),
    models: list('OPENAI_MODELS', ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini'])
  },
  anthropic: {
    label: 'Anthropic Claude', keyVar: 'ANTHROPIC_API_KEY', kind: 'anthropic',
    base: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'), model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
    models: list('ANTHROPIC_MODELS', ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])
  },
  gemini: {
    label: 'Google Gemini', keyVar: 'GEMINI_API_KEY', kind: 'gemini',
    base: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'), model: env('GEMINI_MODEL', 'gemini-2.5-flash'),
    models: list('GEMINI_MODELS', ['gemini-2.5-flash', 'gemini-2.5-pro'])
  },
  groq: {
    label: 'Groq', keyVar: 'GROQ_API_KEY', kind: 'openai-chat',
    base: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'), model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    models: list('GROQ_MODELS', ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'])
  },
  openrouter: {
    label: 'OpenRouter', keyVar: 'OPENROUTER_API_KEY', kind: 'openai-chat',
    base: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'), model: env('OPENROUTER_MODEL', 'openai/gpt-4o-mini'),
    models: list('OPENROUTER_MODELS', ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'meta-llama/llama-3.3-70b-instruct'])
  },
  custom: {
    label: env('CUSTOM_NAME', 'Custom API'), keyVar: 'CUSTOM_API_KEY', kind: 'openai-chat', keyOptional: true,
    base: env('CUSTOM_BASE_URL').replace(/\/+$/, ''), model: env('CUSTOM_MODEL'),
    models: list('CUSTOM_MODELS', env('CUSTOM_MODEL') ? [env('CUSTOM_MODEL')] : [])
  }
};
for (const [id, p] of Object.entries(PROVIDERS)) {
  p.id = id;
  const key = env(p.keyVar);
  p.key = isReal(key) ? key : '';
  p.configured = id === 'custom' ? Boolean(p.base && p.model && (p.key || p.keyOptional)) : Boolean(p.key);
}
const ORDER = list('PROVIDER_ORDER', ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'custom']).filter(id => PROVIDERS[id]);
const DEFAULT_PROVIDER = PROVIDERS[env('DEFAULT_PROVIDER')]?.configured ? env('DEFAULT_PROVIDER') : (ORDER.find(id => PROVIDERS[id].configured) || null);

// ---------- usage stats (in memory) ----------
const stats = Object.fromEntries(Object.keys(PROVIDERS).map(id => [id, { requests: 0, errors: 0, totalMs: 0, inTokens: 0, outTokens: 0, lastError: '', lastUsedAt: null }]));

// ---------- provider calls ----------
const sanitizeAgent = a => (typeof a === 'string' ? a.replace(/[^\w\s&/.\-]/g, '').slice(0, 60).trim() : '');
function systemPrompt(agent) {
  const name = sanitizeAgent(agent);
  return name ? `${SYSTEM_BASE} For this conversation act as the "${name}" agent and focus your answers on that role.` : SYSTEM_BASE;
}

async function httpJson(url, headers, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!r.ok) {
    const e = new Error(json?.error?.message || json?.error || json?.message || `HTTP ${r.status}`);
    e.status = r.status; throw e;
  }
  return json;
}

async function callProvider(p, { system, messages, model }) {
  const m = model || p.model;
  if (p.kind === 'openai-responses') {
    const j = await httpJson(`${p.base}/responses`, { Authorization: `Bearer ${p.key}` },
      { model: m, instructions: system, input: messages.map(x => ({ role: x.role, content: x.content })), max_output_tokens: MAX_TOKENS });
    const reply = j.output_text || (j.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
    return { reply, model: m, inTokens: j.usage?.input_tokens || 0, outTokens: j.usage?.output_tokens || 0 };
  }
  if (p.kind === 'anthropic') {
    const j = await httpJson(`${p.base}/messages`, { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
      { model: m, max_tokens: MAX_TOKENS, system, messages });
    return { reply: (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(''), model: m, inTokens: j.usage?.input_tokens || 0, outTokens: j.usage?.output_tokens || 0 };
  }
  if (p.kind === 'gemini') {
    const j = await httpJson(`${p.base}/models/${encodeURIComponent(m)}:generateContent`, { 'x-goog-api-key': p.key },
      { systemInstruction: { parts: [{ text: system }] }, contents: messages.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })), generationConfig: { maxOutputTokens: MAX_TOKENS } });
    const reply = (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
    return { reply, model: m, inTokens: j.usageMetadata?.promptTokenCount || 0, outTokens: j.usageMetadata?.candidatesTokenCount || 0 };
  }
  // openai-chat compatible (Groq, OpenRouter, Ollama, LM Studio, vLLM, ...)
  const headers = p.key ? { Authorization: `Bearer ${p.key}` } : {};
  const j = await httpJson(`${p.base}/chat/completions`, headers,
    { model: m, max_tokens: MAX_TOKENS, messages: [{ role: 'system', content: system }, ...messages] });
  return { reply: j.choices?.[0]?.message?.content || '', model: m, inTokens: j.usage?.prompt_tokens || 0, outTokens: j.usage?.completion_tokens || 0 };
}

async function runProvider(id, args) {
  const p = PROVIDERS[id], s = stats[id], t0 = Date.now();
  s.requests++;
  try {
    const out = await callProvider(p, args);
    if (!out.reply) throw new Error('The model returned an empty response.');
    s.totalMs += Date.now() - t0; s.inTokens += out.inTokens; s.outTokens += out.outTokens; s.lastUsedAt = new Date().toISOString();
    return { ...out, provider: id, ms: Date.now() - t0 };
  } catch (e) {
    s.errors++; s.lastError = String(e.message || e).slice(0, 200); s.lastUsedAt = new Date().toISOString();
    e.provider = id; throw e;
  }
}

// ---------- security helpers ----------
const scrypt = promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');
async function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const want = Buffer.from(hashHex, 'hex');
  const got = await scrypt(pw, Buffer.from(saltHex, 'hex'), want.length);
  return crypto.timingSafeEqual(want, got);
}
const b64u = b => Buffer.from(b).toString('base64url');
const sign = data => crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
function makeSessionCookie(uid, req) {
  const payload = b64u(JSON.stringify({ uid, exp: Date.now() + SESSION_DAYS * 864e5 }));
  return cookie('apex_sid', `${payload}.${sign(payload)}`, SESSION_DAYS * 86400, req);
}
function cookie(name, value, maxAge, req) {
  const secure = req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function readSessionUid(req) {
  const raw = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith('apex_sid='));
  if (!raw) return null;
  const [payload, sig] = raw.slice(9).split('.');
  if (!payload || !sig) return null;
  const want = Buffer.from(sign(payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(payload, 'base64url').toString()); return p.exp > Date.now() ? p.uid : null; } catch { return null; }
}
const clientIp = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'local';

// ---------- storage ----------
let store;
try {
  store = await createStore({ supabaseUrl: env('SUPABASE_URL'), supabaseKey: env('SUPABASE_SERVICE_KEY'), dataDir: env('DATA_DIR', path.join(__dirname, 'data')) });
} catch (e) {
  console.error('Storage failed to start:', e.message);
  console.error('If you use Supabase: run supabase.sql in the Supabase SQL editor and check SUPABASE_URL / SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

// ---------- http helpers ----------
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' };
const send = (res, status, obj, extraHeaders = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(obj));
};
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const hits = new Map();
function limited(key, max, windowMs = 60000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 15 * 60000)) hits.delete(k); }, 60000).unref();

function originOk(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}
async function sessionUser(req) {
  const uid = readSessionUid(req); if (!uid) return null;
  const u = await store.getUserById(uid);
  return u && !u.disabled ? u : null;
}
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const limitFor = u => (u.role === 'admin' ? null : DAILY_LIMIT);

const publicProvider = id => {
  const p = PROVIDERS[id], s = stats[id];
  return {
    id, label: p.label, configured: p.configured, model: p.model || null, models: p.models,
    requests: s.requests, errors: s.errors, avgMs: s.requests - s.errors > 0 ? Math.round(s.totalMs / (s.requests - s.errors)) : null,
    inTokens: s.inTokens, outTokens: s.outTokens, lastError: s.lastError, lastUsedAt: s.lastUsedAt
  };
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const codeOk = (given, expected) => {
  const a = Buffer.from(String(given || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
  if (!originOk(req)) return send(res, 403, { error: 'Cross-site request blocked.' });

  // ----- public -----
  if (route === 'GET /api/health') {
    const dp = DEFAULT_PROVIDER ? PROVIDERS[DEFAULT_PROVIDER] : null;
    return send(res, 200, {
      ok: true, aiConfigured: Boolean(dp), model: dp ? dp.model : null, defaultProvider: DEFAULT_PROVIDER,
      providersConfigured: ORDER.filter(id => PROVIDERS[id].configured).length, providersTotal: ORDER.length,
      authRequired: true, storage: store.kind
    });
  }
  if (route === 'GET /api/auth/me') {
    const user = await sessionUser(req);
    const out = { user: user ? publicUser(user) : null, hasUsers: await store.hasUsers(), signupMode: SIGNUP_MODE, dailyLimit: user ? limitFor(user) : null, adminEmailLocked: Boolean(ADMIN_EMAIL) };
    if (user) out.usedToday = await store.getUsage(user.id);
    return send(res, 200, out);
  }
  if (route === 'POST /api/auth/signup') {
    if (limited(`signup|${clientIp(req)}`, 8, 3600000)) return send(res, 429, { error: 'Too many sign-ups from this network. Try again later.' });
    const b = await readBody(req, 20000);
    const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    if (!name) return send(res, 400, { error: 'Name is required.' });
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'Password must be 8–200 characters.' });
    const hasUsers = await store.hasUsers();
    const isAdminSignup = ADMIN_EMAIL ? email === ADMIN_EMAIL : !hasUsers;
    if (isAdminSignup) {
      if (ADMIN_SETUP_CODE && !codeOk(b.code, ADMIN_SETUP_CODE)) return send(res, 403, { error: 'Admin setup code is missing or wrong.' });
    } else {
      if (SIGNUP_MODE === 'closed') return send(res, 403, { error: 'Sign-ups are closed.' });
      if (SIGNUP_MODE === 'invite' && !(INVITE_CODE && codeOk(b.code, INVITE_CODE))) return send(res, 403, { error: 'A valid invite code is required.' });
    }
    if (await store.getUserByEmail(email)) return send(res, 409, { error: 'This email is already registered. Please sign in.' });
    const user = await store.createUser({ id: newId(), email, name, passHash: await hashPassword(password), role: isAdminSignup ? 'admin' : 'user', disabled: false, createdAt: new Date().toISOString(), lastLogin: new Date().toISOString() });
    return send(res, 201, { user: publicUser(user), dailyLimit: limitFor(user), usedToday: 0 }, { 'Set-Cookie': makeSessionCookie(user.id, req) });
  }
  if (route === 'POST /api/auth/login') {
    const b = await readBody(req, 20000);
    const email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    if (limited(`login|${clientIp(req)}|${email}`, 10, 15 * 60000) || limited(`loginip|${clientIp(req)}`, 40, 15 * 60000))
      return send(res, 429, { error: 'Too many login attempts. Please wait 15 minutes.' });
    const user = await store.getUserByEmail(email);
    const ok = await verifyPassword(password.slice(0, 200), user ? user.passHash : DUMMY_HASH);
    if (!user || !ok) return send(res, 401, { error: 'Email or password is wrong.' });
    if (user.disabled) return send(res, 403, { error: 'This account has been disabled by the admin.' });
    await store.updateUser(user.id, { lastLogin: new Date().toISOString() });
    return send(res, 200, { user: publicUser(user), dailyLimit: limitFor(user), usedToday: await store.getUsage(user.id) }, { 'Set-Cookie': makeSessionCookie(user.id, req) });
  }
  if (route === 'POST /api/auth/logout') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookie('apex_sid', '', 0, req) });
  }

  // ----- everything below needs a logged-in user -----
  const user = await sessionUser(req);
  if (!user) return send(res, 401, { error: 'Please sign in.', login: true });
  const isAdmin = user.role === 'admin';

  if (route === 'POST /api/auth/password') {
    const b = await readBody(req, 20000);
    if (limited(`pw|${user.id}`, 8, 15 * 60000)) return send(res, 429, { error: 'Too many attempts. Please wait.' });
    if (!(await verifyPassword(String(b.current || '').slice(0, 200), user.passHash))) return send(res, 401, { error: 'Current password is wrong.' });
    const np = String(b.password || '');
    if (np.length < 8 || np.length > 200) return send(res, 400, { error: 'New password must be 8–200 characters.' });
    await store.updateUser(user.id, { passHash: await hashPassword(np) });
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /api/providers') {
    return send(res, 200, { defaultProvider: DEFAULT_PROVIDER, order: ORDER, providers: ORDER.map(id => { const p = publicProvider(id); return isAdmin ? p : { id: p.id, label: p.label, configured: p.configured, model: p.model, models: p.models }; }) });
  }

  // ----- admin only -----
  if (/^\/api\/(stats|admin|providers\/[a-z]+\/test)/.test(url.pathname) && !isAdmin) return send(res, 403, { error: 'Admin only.' });

  if (req.method === 'POST' && /^\/api\/providers\/[a-z]+\/test$/.test(url.pathname)) {
    if (limited(`ptest|${user.id}`, 20)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
    const id = url.pathname.split('/')[3];
    if (!PROVIDERS[id]) return send(res, 404, { error: 'Unknown provider.' });
    if (!PROVIDERS[id].configured) return send(res, 503, { error: `${PROVIDERS[id].label} is not configured (set ${PROVIDERS[id].keyVar} in .env).` });
    try {
      const out = await runProvider(id, { system: 'Reply with the single word: OK', messages: [{ role: 'user', content: 'ping' }] });
      return send(res, 200, { ok: true, provider: id, model: out.model, ms: out.ms });
    } catch (e) { return send(res, 502, { ok: false, provider: id, error: String(e.message || e).slice(0, 300) }); }
  }
  if (route === 'GET /api/stats') {
    return send(res, 200, { uptimeSec: Math.round(process.uptime()), storage: store.kind, providers: ORDER.map(publicProvider) });
  }
  if (route === 'GET /api/admin/users') {
    const [users, usage] = await Promise.all([store.listUsers(), store.usageToday()]);
    return send(res, 200, { dailyLimit: DAILY_LIMIT, signupMode: SIGNUP_MODE, users: users.map(u => ({ ...publicUser(u), disabled: u.disabled, createdAt: u.createdAt, lastLogin: u.lastLogin, usedToday: usage[u.id] || 0 })) });
  }
  if (req.method === 'POST' && /^\/api\/admin\/users\/[\w-]+$/.test(url.pathname)) {
    const id = url.pathname.split('/')[4];
    if (id === user.id) return send(res, 400, { error: 'You cannot change your own account here.' });
    const target = await store.getUserById(id);
    if (!target) return send(res, 404, { error: 'User not found.' });
    const b = await readBody(req, 5000);
    const patch = {};
    if (typeof b.disabled === 'boolean') patch.disabled = b.disabled;
    if (b.role === 'user' || b.role === 'admin') patch.role = b.role;
    if (!Object.keys(patch).length) return send(res, 400, { error: 'Nothing to change.' });
    const u = await store.updateUser(id, patch);
    return send(res, 200, { user: { ...publicUser(u), disabled: u.disabled } });
  }

  // ----- chat -----
  if (route === 'POST /api/chat') {
    if (limited(`chat|${user.id}`, RATE_PER_MIN)) return send(res, 429, { error: 'Too many requests. Please wait a minute.' });
    const body = await readBody(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return send(res, 400, { error: 'Message is required.' });
    if (message.length > 12000) return send(res, 413, { error: 'Message is too long (12,000 characters maximum).' });
    if (!DEFAULT_PROVIDER) return send(res, 503, { error: 'No AI provider is configured. Add at least one API key to the .env file and restart.' });
    const limit = limitFor(user);
    if (limit !== null) {
      const used = await store.getUsage(user.id);
      if (used >= limit) return send(res, 429, { error: `Daily limit reached (${limit} messages). It resets tomorrow (UTC).`, used, limit });
    }

    // conversation memory from the browser (validated, last 12 turns)
    const history = Array.isArray(body.history) ? body.history.slice(-12)
      .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
      .map(h => ({ role: h.role, content: h.content.slice(0, 12000) })) : [];
    while (history.length && history[0].role !== 'user') history.shift();
    const messages = [...history, { role: 'user', content: message }];

    const wanted = typeof body.provider === 'string' ? body.provider : 'auto';
    const model = typeof body.model === 'string' && /^[\w.:\/\-]{1,100}$/.test(body.model) ? body.model : undefined;
    let tryOrder;
    if (wanted === 'auto') tryOrder = [DEFAULT_PROVIDER, ...ORDER.filter(id => id !== DEFAULT_PROVIDER)].filter(id => PROVIDERS[id].configured);
    else if (PROVIDERS[wanted]?.configured) tryOrder = [wanted];
    else return send(res, 400, { error: `Provider "${wanted}" is not configured on the server.` });

    const system = systemPrompt(body.agent);
    const failed = [];
    for (const id of tryOrder) {
      try {
        const out = await runProvider(id, { system, messages, model: wanted === 'auto' ? undefined : model });
        const used = await store.incUsage(user.id);
        return send(res, 200, { reply: out.reply, provider: id, providerLabel: PROVIDERS[id].label, model: out.model, ms: out.ms, usage: { input: out.inTokens, output: out.outTokens }, quota: { used, limit }, fallbackFrom: failed.length ? failed : undefined });
      } catch (e) {
        console.error(`[${id}] request failed:`, e.status || '', e.message);
        failed.push({ provider: id, error: String(e.message || e).slice(0, 160) });
      }
    }
    return send(res, 502, { error: 'All selected AI providers failed. Check the server terminal and your API account settings.', failed: isAdmin ? failed : undefined });
  }
  send(res, 404, { error: 'Not found.' });
}

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    // Only index.html is public. server.js, store.js and .env can NOT be downloaded.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SEC_HEADERS });
    return res.end(INDEX_HTML);
  }
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  handle(req, res).catch(e => { console.error('Server error:', e.message); if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error.' }); else res.end(); });
});
server.listen(port, () => {
  console.log(`APEX INTELLIGENCE running at http://localhost:${port}`);
  console.log(`  Storage: ${store.kind === 'supabase' ? 'Supabase (persistent)' : 'local file ' + path.join(env('DATA_DIR', path.join(__dirname, 'data')), 'apex-data.json')}`);
  for (const id of ORDER) console.log(`  ${PROVIDERS[id].configured ? '✔' : '✘'} ${PROVIDERS[id].label}${PROVIDERS[id].configured ? ` (${PROVIDERS[id].model})` : ` — set ${PROVIDERS[id].keyVar}`}`);
  if (!DEFAULT_PROVIDER) console.log('No provider configured — add at least one API key to .env');
  console.log(`  Sign-ups: ${SIGNUP_MODE} · daily limit per user: ${DAILY_LIMIT} · admin: ${ADMIN_EMAIL || 'first account created'}`);
  if (TRUST_PROXY && !ADMIN_EMAIL) console.log('WARNING: public hosting without ADMIN_EMAIL — set ADMIN_EMAIL (and ADMIN_SETUP_CODE) so a stranger cannot become admin.');
  if (store.kind === 'file' && TRUST_PROXY) console.log('WARNING: file storage on a public host loses users on restart. Use Supabase (see DEPLOY guide).');
});

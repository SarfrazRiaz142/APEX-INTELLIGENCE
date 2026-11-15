// APEX storage layer: users + daily usage.
//  - Default: JSON file in DATA_DIR (great for your own computer or a host with a persistent disk).
//  - Supabase: set SUPABASE_URL + SUPABASE_SERVICE_KEY (use this on free hosts like Render,
//    whose disk is wiped on every restart). Run supabase.sql once in the Supabase SQL editor.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const today = () => new Date().toISOString().slice(0, 10);
export const newId = () => crypto.randomUUID();

// ---------------- JSON file store ----------------
class FileStore {
  constructor(dir) {
    this.kind = 'file';
    this.dir = dir;
    this.file = path.join(dir, 'apex-data.json');
    this.data = { users: [], usage: {} };
  }
  async init() {
    fs.mkdirSync(this.dir, { recursive: true });
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data.users ||= []; this.data.usage ||= {};
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
  async hasUsers() { return this.data.users.length > 0; }
  async getUserByEmail(email) { return this.data.users.find(u => u.email === email) || null; }
  async getUserById(id) { return this.data.users.find(u => u.id === id) || null; }
  async createUser(u) { this.data.users.push(u); this.save(); return u; }
  async updateUser(id, patch) {
    const u = this.data.users.find(x => x.id === id); if (!u) return null;
    Object.assign(u, patch); this.save(); return u;
  }
  async listUsers() { return [...this.data.users].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); }
  async getUsage(userId, day = today()) { return this.data.usage[`${userId}|${day}`] || 0; }
  async incUsage(userId, day = today()) {
    const k = `${userId}|${day}`; this.data.usage[k] = (this.data.usage[k] || 0) + 1;
    // drop entries older than 35 days
    const cutoff = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
    for (const key of Object.keys(this.data.usage)) if (key.split('|')[1] < cutoff) delete this.data.usage[key];
    this.save(); return this.data.usage[k];
  }
  async usageToday() {
    const day = today(), out = {};
    for (const [k, v] of Object.entries(this.data.usage)) { const [id, d] = k.split('|'); if (d === day) out[id] = v; }
    return out;
  }
}

// ---------------- Supabase (PostgREST over fetch) ----------------
const toUser = r => r && ({ id: r.id, email: r.email, name: r.name, passHash: r.pass_hash, role: r.role, disabled: !!r.disabled, createdAt: r.created_at, lastLogin: r.last_login });
const fromUser = u => ({ id: u.id, email: u.email, name: u.name, pass_hash: u.passHash, role: u.role, disabled: !!u.disabled, created_at: u.createdAt, last_login: u.lastLogin || null });

class SupabaseStore {
  constructor(url, key) {
    this.kind = 'supabase';
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }
  async req(method, pathAndQuery, body, extra = {}) {
    const r = await fetch(this.base + pathAndQuery, { method, headers: { ...this.h, ...extra }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!r.ok) throw new Error(`Supabase ${method} ${pathAndQuery.split('?')[0]} failed: ${json?.message || r.status}`);
    return json;
  }
  async init() { await this.req('GET', '/apex_users?select=id&limit=1'); } // fails loudly if tables are missing
  async hasUsers() { return (await this.req('GET', '/apex_users?select=id&limit=1')).length > 0; }
  async getUserByEmail(email) { return toUser((await this.req('GET', `/apex_users?email=eq.${encodeURIComponent(email)}&select=*&limit=1`))[0]) || null; }
  async getUserById(id) { return toUser((await this.req('GET', `/apex_users?id=eq.${encodeURIComponent(id)}&select=*&limit=1`))[0]) || null; }
  async createUser(u) { return toUser((await this.req('POST', '/apex_users', fromUser(u), { Prefer: 'return=representation' }))[0]); }
  async updateUser(id, patch) {
    const row = {};
    if ('name' in patch) row.name = patch.name; if ('role' in patch) row.role = patch.role;
    if ('disabled' in patch) row.disabled = patch.disabled; if ('lastLogin' in patch) row.last_login = patch.lastLogin;
    if ('passHash' in patch) row.pass_hash = patch.passHash;
    return toUser((await this.req('PATCH', `/apex_users?id=eq.${encodeURIComponent(id)}`, row, { Prefer: 'return=representation' }))[0]) || null;
  }
  async listUsers() { return (await this.req('GET', '/apex_users?select=*&order=created_at.desc&limit=500')).map(toUser); }
  async getUsage(userId, day = today()) {
    const r = await this.req('GET', `/apex_usage?user_id=eq.${encodeURIComponent(userId)}&day=eq.${day}&select=count&limit=1`);
    return r[0]?.count || 0;
  }
  async incUsage(userId, day = today()) { return Number(await this.req('POST', '/rpc/apex_incr_usage', { p_user: userId, p_day: day })); }
  async usageToday() {
    const rows = await this.req('GET', `/apex_usage?day=eq.${today()}&select=user_id,count&limit=1000`);
    return Object.fromEntries(rows.map(r => [r.user_id, r.count]));
  }
}

export async function createStore({ supabaseUrl, supabaseKey, dataDir }) {
  const store = supabaseUrl && supabaseKey ? new SupabaseStore(supabaseUrl, supabaseKey) : new FileStore(dataDir);
  await store.init();
  return store;
}

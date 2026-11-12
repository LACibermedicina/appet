// Armazenamento simples em arquivo JSON + imagens em uploads/ (troque por Postgres/Supabase em produção).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data.json');
export const UPLOADS = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const empty = { users: {}, sessions: {}, profiles: {}, stories: [], media: {}, wallets: {}, orders: {}, listings: [], disputes: [], ledger: [] };
let db = fs.existsSync(FILE) ? { ...structuredClone(empty), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) } : structuredClone(empty);
const save = () => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); };

export const store = {
  get: () => db,
  save,

  /* ---- contas ---- */
  userByEmail: email => Object.values(db.users).find(u => u.email === email),
  user: id => db.users[id],
  addUser(u) { db.users[u.id] = u; save(); return u; },
  addSession(hash, s) { db.sessions[hash] = s; save(); },
  session(hash) {
    const s = db.sessions[hash];
    if (s && s.exp < Date.now()) { delete db.sessions[hash]; save(); return null; }
    return s || null;
  },
  dropSession(hash) { delete db.sessions[hash]; save(); },

  /* ---- perfil, mídia e stories (sempre por dono) ---- */
  profile: userId => db.profiles[userId] || null,
  setProfile(userId, p) { db.profiles[userId] = { ...p, updatedAt: new Date().toISOString() }; save(); return db.profiles[userId]; },
  addMedia(m) { db.media[m.id] = m; save(); return m; },
  media: id => db.media[id],
  dropMedia(id) {
    const m = db.media[id]; if (!m) return;
    try { fs.unlinkSync(path.join(UPLOADS, m.file)); } catch {}
    delete db.media[id]; save();
  },
  addStory(s) { db.stories.unshift(s); save(); return s; },
  storiesOf: userId => db.stories.filter(s => s.userId === userId),
  publicStories: (exceptUserId, limit = 40) => db.stories.filter(s => s.visibility === 'public' && s.userId !== exceptUserId).slice(0, limit),
  story: id => db.stories.find(s => s.id === id),
  updateStory(id, patch) { const s = this.story(id); if (s) { Object.assign(s, patch); save(); } return s; },
  dropStory(id) { db.stories = db.stories.filter(s => s.id !== id); save(); },

  /* ---- créditos, pedidos, brechó ---- */
  wallet(userId) { return (db.wallets[userId] ??= { credits: 0 }); },
  addCredits(userId, n, reason) {
    const w = this.wallet(userId);
    w.credits += n;
    db.ledger.push({ userId, n, reason, at: new Date().toISOString() });
    save(); return w;
  },
  spend(userId, n, reason) {
    const w = this.wallet(userId);
    if (w.credits < n) throw Object.assign(new Error('Créditos insuficientes'), { status: 402 });
    w.credits -= n;
    db.ledger.push({ userId, n: -n, reason, at: new Date().toISOString() });
    save(); return w;
  },
  createOrder(o) { db.orders[o.id] = { ...o, status: 'pending', createdAt: new Date().toISOString() }; save(); return db.orders[o.id]; },
  order(id) { return db.orders[id]; },
  updateOrder(id, patch) { Object.assign(db.orders[id], patch); save(); return db.orders[id]; },
  addListing(l) { db.listings.unshift(l); save(); return l; },
  addDispute(d) { db.disputes.unshift(d); save(); return d; },
};

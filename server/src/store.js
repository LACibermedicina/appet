// Armazenamento simples em arquivo JSON (troque por Postgres/Supabase em produção).
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('data.json');
const empty = { wallets: {}, orders: {}, listings: [], disputes: [], ledger: [] };
let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : structuredClone(empty);
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));

export const store = {
  get: () => db,
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

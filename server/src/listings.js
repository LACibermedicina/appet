// Cadastros reais feitos pelos usuários: profissionais, anfitriões (PetSurf), itens do Brechó,
// eventos e perfis do PetMatch. Enquanto um tipo não tiver nenhum cadastro real, o app mostra
// exemplos marcados como "exemplo". Também guarda os serviços contratados por cada usuário.
import crypto from 'node:crypto';
import express from 'express';
import { store } from './store.js';
import { requireAuth } from './auth.js';
import { userCard } from './circles.js';
import { saveImage } from './auth.js';

const TYPES = {
  pro:   ['kind', 'name', 'desc', 'price', 'area', 'phone'],                 // vet, adestrador, banho, passeador
  host:  ['name', 'desc', 'mode', 'price', 'area', 'tags'],                  // PetSurf
  item:  ['title', 'desc', 'cat', 'cond', 'price', 'area'],                  // Brechó
  event: ['name', 'desc', 'date', 'time', 'place', 'price', 'kind'],         // Eventos
  match: ['petName', 'petEmoji', 'breed', 'age', 'sex', 'energy', 'neutered', 'vaccinated', 'bio', 'modes'], // PetMatch
};
const ONE_PER_USER = new Set(['match']);
const newId = p => `${p}_${crypto.randomBytes(8).toString('base64url')}`;
const db = () => store.get();
const clean = (type, data = {}) => {
  const out = {};
  for (const k of TYPES[type]) {
    const v = data[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 10).map(x => String(x).slice(0, 40));
    else out[k] = String(v).slice(0, k === 'desc' || k === 'bio' ? 400 : 80);
  }
  return out;
};
const listingOut = (l, viewerId) => ({
  id: l.id, type: l.type, data: l.data, photo: l.mediaId ? `/api/media/${l.mediaId}` : '',
  owner: userCard(l.userId), mine: l.userId === viewerId, createdAt: l.createdAt,
});

export function listingsRouter() {
  const r = express.Router();
  const json = express.json({ limit: '6mb' });
  db().listings ??= []; db().services ??= [];

  // leitura pública (visitantes também veem os cadastros reais)
  r.get('/listings', (req, res) => {
    const type = String(req.query.type || '');
    if (!TYPES[type]) return res.status(400).json({ error: 'Tipo inválido.' });
    const list = db().listings.filter(l => l.type === type && l.active !== false).slice(0, 200);
    res.json({ listings: list.map(l => listingOut(l, req.user?.id)) });
  });

  r.get('/me/listings', requireAuth, (req, res) =>
    res.json({ listings: db().listings.filter(l => l.userId === req.user.id).map(l => listingOut(l, req.user.id)) }));

  r.post('/me/listings', requireAuth, json, (req, res) => {
    const type = String(req.body.type || '');
    if (!TYPES[type]) return res.status(400).json({ error: 'Tipo inválido.' });
    const data = clean(type, req.body.data);
    if (!Object.values(data).some(v => v !== '' && v !== false)) return res.status(400).json({ error: 'Preencha os dados.' });
    let mediaId = null;
    try { if (req.body.image) { const m = saveImage(req.user.id, req.body.image); m.public = true; store.save(); mediaId = m.id; } }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (ONE_PER_USER.has(type)) {
      const old = db().listings.find(l => l.userId === req.user.id && l.type === type);
      if (old) { Object.assign(old, { data, active: true, ...(mediaId ? { mediaId } : {}) }); store.save(); return res.json({ listing: listingOut(old, req.user.id) }); }
    }
    if (db().listings.filter(l => l.userId === req.user.id).length >= 50) return res.status(400).json({ error: 'Limite de 50 cadastros.' });
    const l = { id: newId('lst'), type, userId: req.user.id, data, mediaId, active: true, createdAt: new Date().toISOString() };
    db().listings.unshift(l); store.save();
    res.json({ listing: listingOut(l, req.user.id) });
  });

  r.patch('/me/listings/:id', requireAuth, json, (req, res) => {
    const l = db().listings.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!l) return res.sendStatus(404);
    if (req.body.data) l.data = clean(l.type, { ...l.data, ...req.body.data });
    if (typeof req.body.active === 'boolean') l.active = req.body.active;
    store.save(); res.json({ listing: listingOut(l, req.user.id) });
  });

  r.delete('/me/listings/:id', requireAuth, (req, res) => {
    const l = db().listings.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!l) return res.sendStatus(404);
    if (l.mediaId) store.dropMedia(l.mediaId);
    db().listings = db().listings.filter(x => x !== l); store.save();
    res.json({ ok: true });
  });

  /* ---- placar da Academia: XP real dos tutores (só nome, pet e XP) ---- */
  r.get('/board', (req, res) => {
    const rows = Object.entries(db().profiles || {}).map(([uid, p]) => ({ uid, xp: +(p?.state?.xp) || 0 }))
      .filter(x => x.xp > 0 && store.user(x.uid)).sort((a, b) => b.xp - a.xp).slice(0, 10)
      .map(x => ({ ...userCard(x.uid), xp: x.xp, me: req.user?.id === x.uid }));
    res.json({ board: rows });
  });

  /* ---- PetMatch real: dar pata; se for recíproco, é match ---- */
  r.post('/listings/:id/like', requireAuth, (req, res) => {
    const target = db().listings.find(l => l.id === req.params.id && l.type === 'match');
    if (!target || target.userId === req.user.id) return res.sendStatus(404);
    const mine = db().listings.find(l => l.userId === req.user.id && l.type === 'match');
    if (!mine) return res.status(400).json({ error: 'Coloque seu pet no PetMatch primeiro.' });
    mine.likes = [...new Set([...(mine.likes || []), target.id])];
    const match = (target.likes || []).includes(mine.id);
    store.save(); res.json({ match, with: match ? listingOut(target, req.user.id) : null });
  });
  r.get('/me/matches', requireAuth, (req, res) => {
    const mine = db().listings.find(l => l.userId === req.user.id && l.type === 'match');
    if (!mine) return res.json({ matches: [] });
    const out = db().listings.filter(l => l.type === 'match' && (mine.likes || []).includes(l.id) && (l.likes || []).includes(mine.id));
    res.json({ matches: out.map(l => listingOut(l, req.user.id)) });
  });

  /* ---- serviços contratados (agendamentos, estadias, pedidos, consultas) ---- */
  const KINDS = ['booking', 'stay', 'order', 'consult', 'event'];
  r.get('/me/services', requireAuth, (req, res) => {
    const mine = db().services.filter(s => s.userId === req.user.id);
    // pedidos recebidos por quem é profissional/anfitrião/vendedor
    const received = db().services.filter(s => s.providerId === req.user.id).map(s => ({ ...s, client: userCard(s.userId) }));
    res.json({ services: mine, received });
  });
  r.post('/me/services', requireAuth, json, (req, res) => {
    const kind = KINDS.includes(req.body.kind) ? req.body.kind : null;
    if (!kind) return res.status(400).json({ error: 'Tipo de serviço inválido.' });
    const listing = req.body.listingId ? db().listings.find(l => l.id === req.body.listingId) : null;
    const s = {
      id: newId('svc'), userId: req.user.id, kind,
      title: String(req.body.title || '').slice(0, 120), with: String(req.body.with || listing?.data?.name || listing?.data?.title || '').slice(0, 80),
      when: String(req.body.when || '').slice(0, 60), price: Number(req.body.price) || 0, emoji: String(req.body.emoji || '').slice(0, 8),
      listingId: listing?.id || null, providerId: listing && listing.userId !== req.user.id ? listing.userId : null,
      status: 'confirmado', createdAt: new Date().toISOString(),
    };
    db().services.unshift(s); store.save();
    res.json({ service: s });
  });
  r.delete('/me/services/:id', requireAuth, (req, res) => {
    const s = db().services.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!s) return res.sendStatus(404);
    s.status = 'cancelado'; store.save(); res.json({ service: s });
  });
  return r;
}

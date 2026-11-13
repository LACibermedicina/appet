// Amigos próximos e grupos de cada usuário + busca de tutores (sem expor e-mail).
import crypto from 'node:crypto';
import express from 'express';
import { store } from './store.js';
import { requireAuth } from './auth.js';

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const newId = () => `grp_${crypto.randomBytes(7).toString('base64url')}`;

/** cartão público de um usuário: nome e pet, nunca o e-mail */
export function userCard(id) {
  const u = store.user(id); if (!u) return null;
  const p = store.profile(id) || {};
  return { id, name: u.name || p.tutor || 'Tutor', petName: p.pet?.name || '', petEmoji: p.pet?.emoji || '🐶' };
}
const validMembers = (list, self) => [...new Set((Array.isArray(list) ? list : []).map(String))].filter(id => id !== self && store.user(id)).slice(0, 500);
const out = (c) => ({
  close: c.close.map(userCard).filter(Boolean),
  groups: c.groups.map(g => ({ id: g.id, name: g.name, members: g.members.map(userCard).filter(Boolean) })),
});

export function circlesRouter() {
  const r = express.Router();
  const json = express.json({ limit: '100kb' });

  // busca: por nome do tutor ou do pet (parcial) ou e-mail exato
  r.get('/users/search', requireAuth, (req, res) => {
    const q = norm(req.query.q).trim();
    if (q.length < 2) return res.json({ users: [] });
    const users = Object.values(store.get().users).filter(u => u.id !== req.user.id && (
      u.email === q || norm(u.name).includes(q) || norm(store.profile(u.id)?.pet?.name).includes(q) || norm(store.profile(u.id)?.tutor).includes(q)
    )).slice(0, 12).map(u => userCard(u.id));
    res.json({ users });
  });

  r.get('/me/circles', requireAuth, (req, res) => res.json(out(store.circles(req.user.id))));

  // amigos próximos: lista completa
  r.put('/me/close', requireAuth, json, (req, res) => {
    const c = store.circles(req.user.id);
    c.close = validMembers(req.body.members, req.user.id);
    store.saveCircles(); res.json(out(c));
  });

  r.post('/me/groups', requireAuth, json, (req, res) => {
    const c = store.circles(req.user.id);
    const name = String(req.body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Dê um nome ao grupo.' });
    if (c.groups.length >= 50) return res.status(400).json({ error: 'Limite de 50 grupos.' });
    c.groups.push({ id: newId(), name, members: validMembers(req.body.members, req.user.id) });
    store.saveCircles(); res.json(out(c));
  });

  r.patch('/me/groups/:id', requireAuth, json, (req, res) => {
    const c = store.circles(req.user.id);
    const g = c.groups.find(x => x.id === req.params.id);
    if (!g) return res.sendStatus(404);
    if (typeof req.body.name === 'string' && req.body.name.trim()) g.name = req.body.name.trim().slice(0, 40);
    if (Array.isArray(req.body.members)) g.members = validMembers(req.body.members, req.user.id);
    store.saveCircles(); res.json(out(c));
  });

  r.delete('/me/groups/:id', requireAuth, (req, res) => {
    const c = store.circles(req.user.id);
    const before = c.groups.length;
    c.groups = c.groups.filter(g => g.id !== req.params.id);
    if (c.groups.length === before) return res.sendStatus(404);
    for (const p of store.get().stories) if (p.userId === req.user.id && p.groupIds?.length) {
      p.groupIds = p.groupIds.filter(id => id !== req.params.id);
      if (p.visibility === 'group' && !p.groupIds.length) p.visibility = 'private'; // grupo apagado: post fica só com o dono
    }
    store.saveCircles(); res.json(out(c));
  });

  return r;
}

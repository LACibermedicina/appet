// Comunidade: stories e reels (imagem ou vídeo) com visibilidade e reações.
// "public" = aparece para todos os usuários logados; "private" = só o dono.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { store, UPLOADS } from './store.js';
import { requireAuth } from './auth.js';

export const REACTIONS = ['amei', 'haha', 'uau', 'fofo', 'patinha', 'brilhou'];
const KINDS = ['story', 'reel'];
const TYPES = {
  'image/jpeg': ['image', 'jpg'], 'image/png': ['image', 'png'], 'image/webp': ['image', 'webp'],
  'video/mp4': ['video', 'mp4'], 'video/webm': ['video', 'webm'], 'video/quicktime': ['video', 'mov'],
};
const MAX = { image: 6 * 1024 * 1024, video: 60 * 1024 * 1024 };
const newId = p => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const db = () => store.get();
const all = () => db().stories; // mesma lista dos stories antigos (sem "kind" = story)
const kindOf = p => p.kind || 'story';
const canSee = (p, userId) => p.userId === userId || p.visibility === 'public';

export function postOut(p, viewerId) {
  const counts = Object.fromEntries(REACTIONS.map(r => [r, 0]));
  for (const e of Object.values(p.reactions || {})) if (e in counts) counts[e]++;
  const m = store.media(p.mediaId);
  return {
    id: p.id, kind: kindOf(p), text: p.text || '', visibility: p.visibility,
    url: `/api/media/${p.mediaId}`, mediaType: m?.type?.startsWith('video/') ? 'video' : 'image',
    petName: p.petName || '', petEmoji: p.petEmoji || '🐶', createdAt: p.createdAt,
    mine: p.userId === viewerId, reactions: counts, myReaction: p.reactions?.[viewerId] || null,
  };
}

export function postsRouter() {
  const r = express.Router();
  const raw = express.raw({ type: () => true, limit: '60mb' });
  const json = express.json({ limit: '50kb' });

  // publicar: corpo = arquivo (image/* ou video/*); ?kind=story|reel&visibility=public|private&text=...
  r.post('/me/posts', requireAuth, raw, (req, res) => {
    const ctype = String(req.headers['content-type'] || '').split(';')[0].trim();
    const t = TYPES[ctype];
    if (!t) return res.status(415).json({ error: 'Formato não suportado. Use JPG, PNG, WebP, MP4, WebM ou MOV.' });
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Arquivo vazio.' });
    if (buf.length > MAX[t[0]]) return res.status(413).json({ error: t[0] === 'video' ? 'Vídeo maior que 60 MB.' : 'Imagem maior que 6 MB.' });
    const kind = KINDS.includes(req.query.kind) ? req.query.kind : 'story';
    const mid = newId(t[0] === 'video' ? 'vid' : 'img');
    const file = `${mid}.${t[1]}`;
    fs.writeFileSync(path.join(UPLOADS, file), buf);
    store.addMedia({ id: mid, file, ownerId: req.user.id, type: ctype, createdAt: new Date().toISOString() });
    const prof = store.profile(req.user.id) || {};
    const p = store.addStory({
      id: newId(kind === 'reel' ? 'rel' : 'sty'), kind, userId: req.user.id, mediaId: mid,
      text: String(req.query.text || '').slice(0, 220),
      visibility: req.query.visibility === 'private' ? 'private' : 'public',
      petName: String(prof.pet?.name || '').slice(0, 40), petEmoji: String(prof.pet?.emoji || '🐶').slice(0, 8),
      reactions: {}, createdAt: new Date().toISOString(),
    });
    res.json({ post: postOut(p, req.user.id) });
  });

  // meus posts (todos, públicos e privados)
  r.get('/me/posts', requireAuth, (req, res) => {
    const kind = req.query.kind;
    res.json({ posts: all().filter(p => p.userId === req.user.id && (!kind || kindOf(p) === kind)).map(p => postOut(p, req.user.id)) });
  });

  // comunidade: tudo que foi compartilhado (inclusive os meus públicos), com busca
  r.get('/feed', requireAuth, (req, res) => {
    const kind = req.query.kind, q = norm(req.query.q).trim();
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const list = all().filter(p => p.visibility === 'public' && (!kind || kindOf(p) === kind)
      && (!q || norm(`${p.text} ${p.petName}`).includes(q))).slice(0, limit);
    res.json({ posts: list.map(p => postOut(p, req.user.id)) });
  });

  r.patch('/me/posts/:id', requireAuth, json, (req, res) => {
    const p = store.story(req.params.id);
    if (!p || p.userId !== req.user.id) return res.sendStatus(404);
    const patch = {};
    if (req.body.visibility) patch.visibility = req.body.visibility === 'public' ? 'public' : 'private';
    if (typeof req.body.text === 'string') patch.text = req.body.text.slice(0, 220);
    res.json({ post: postOut(store.updateStory(p.id, patch), req.user.id) });
  });

  r.delete('/me/posts/:id', requireAuth, (req, res) => {
    const p = store.story(req.params.id);
    if (!p || p.userId !== req.user.id) return res.sendStatus(404);
    store.dropMedia(p.mediaId); store.dropStory(p.id);
    res.json({ ok: true });
  });

  // reagir: uma reação por pessoa; mandar a mesma de novo (ou null) remove
  r.post('/posts/:id/react', requireAuth, json, (req, res) => {
    const p = store.story(req.params.id);
    if (!p || !canSee(p, req.user.id)) return res.sendStatus(404);
    const e = req.body.emoji ?? null;
    if (e !== null && !REACTIONS.includes(e)) return res.status(400).json({ error: 'Reação inválida.' });
    const reactions = { ...(p.reactions || {}) };
    if (e === null || reactions[req.user.id] === e) delete reactions[req.user.id];
    else reactions[req.user.id] = e;
    const out = postOut(store.updateStory(p.id, { reactions }), req.user.id);
    res.json({ reactions: out.reactions, myReaction: out.myReaction });
  });

  return r;
}

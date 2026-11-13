// Contas de usuário: cadastro, login com cookie de sessão HttpOnly, e rotas privadas por dono.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { store, UPLOADS } from './store.js';

const COOKIE = 'appet_sid';
const SESSION_DAYS = 30;
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const newId = p => `${p}_${crypto.randomBytes(9).toString('base64url')}`;
const hashPassword = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
const checkPassword = (pw, u) => {
  const h = Buffer.from(crypto.scryptSync(pw, u.salt, 64).toString('hex'));
  return h.length === Buffer.from(u.hash).length && crypto.timingSafeEqual(h, Buffer.from(u.hash));
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
export const isAdmin = u => !!u && String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean).includes(u.email);
const publicUser = u => ({ id: u.id, email: u.email, name: u.name, isAdmin: isAdmin(u) });

function setSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  store.addSession(sha(token), { userId, exp: Date.now() + SESSION_DAYS * 864e5 });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}

/** Preenche req.user se houver sessão válida */
export function sessionMiddleware(req, _res, next) {
  const t = cookies(req)[COOKIE];
  const s = t && store.session(sha(t));
  const u = s && store.user(s.userId);
  if (u) req.user = u;
  next();
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Entre na sua conta para continuar.' });
  next();
}

// limite simples contra tentativas de senha em massa
const tries = new Map();
function limited(req) {
  const k = req.ip, now = Date.now();
  const list = (tries.get(k) || []).filter(t => now - t < 15 * 60e3);
  list.push(now); tries.set(k, list);
  return list.length > 20;
}

const IMG_RE = /^data:image\/(jpeg|png|webp);base64,/;
function saveImage(ownerId, dataUrl) {
  const m = IMG_RE.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('Imagem inválida (use JPG, PNG ou WebP).'), { status: 400 });
  const buf = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (buf.length > 4 * 1024 * 1024) throw Object.assign(new Error('Imagem maior que 4 MB.'), { status: 413 });
  const id = newId('img');
  const file = `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, file), buf);
  return store.addMedia({ id, file, ownerId, type: `image/${m[1]}`, createdAt: new Date().toISOString() });
}
const mediaUrl = id => `/api/media/${id}`;
const storyOut = s => ({ id: s.id, text: s.text, visibility: s.visibility, url: mediaUrl(s.mediaId), petName: s.petName, petEmoji: s.petEmoji, createdAt: s.createdAt, mine: undefined });

export function authRouter() {
  const r = express.Router();
  const big = express.json({ limit: '6mb' });
  const small = express.json({ limit: '200kb' });
  r.use((req, res, next) => (req.method !== 'GET' && /^\/me\/(photo|stories)$/.test(req.path) ? big : small)(req, res, next));

  /* ---- conta ---- */
  r.post('/auth/register', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim().slice(0, 60);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
    if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
    if (store.userByEmail(email)) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
    const u = store.addUser({ id: newId('usr'), email, name, ...hashPassword(password), createdAt: new Date().toISOString() });
    store.addCredits(u.id, 120, 'Bônus de boas-vindas');
    setSession(req, res, u.id);
    res.json({ user: publicUser(u) });
  });

  r.post('/auth/login', (req, res) => {
    if (limited(req)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const u = store.userByEmail(String(req.body.email || '').trim().toLowerCase());
    if (!u || !checkPassword(String(req.body.password || ''), u)) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
    setSession(req, res, u.id);
    res.json({ user: publicUser(u) });
  });

  r.post('/auth/logout', (req, res) => {
    const t = cookies(req)[COOKIE];
    if (t) store.dropSession(sha(t));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

  /* ---- perfil (só o dono lê e grava) ---- */
  r.get('/me/profile', requireAuth, (req, res) => {
    const p = store.profile(req.user.id);
    res.json({ profile: p ? { ...p, photo: p.photoId ? mediaUrl(p.photoId) : '' } : null });
  });
  r.put('/me/profile', requireAuth, (req, res) => {
    const allowed = ['onboarded', 'tutor', 'pet', 'goals', 'time', 'story', 'withTutor', 'bgPhoto', 'bgTouched', 'lost', 'chip', 'petSex'];
    const old = store.profile(req.user.id) || {};
    const p = { ...old };
    for (const k of allowed) if (k in req.body) p[k] = req.body[k];
    res.json({ profile: store.setProfile(req.user.id, p) });
  });
  r.put('/me/photo', requireAuth, big, (req, res) => {
    try {
      const old = store.profile(req.user.id) || {};
      if (old.photoId) store.dropMedia(old.photoId);
      if (!req.body.image) { store.setProfile(req.user.id, { ...old, photoId: null }); return res.json({ photo: '' }); }
      const m = saveImage(req.user.id, req.body.image);
      store.setProfile(req.user.id, { ...old, photoId: m.id });
      res.json({ photo: mediaUrl(m.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });

  /* ---- stories: privados por padrão; "public" aparece para a comunidade ---- */
  r.get('/me/stories', requireAuth, (req, res) => res.json({ stories: store.storiesOf(req.user.id).map(storyOut) }));
  r.post('/me/stories', requireAuth, big, (req, res) => {
    try {
      const m = saveImage(req.user.id, req.body.image);
      const p = store.profile(req.user.id) || {};
      const s = store.addStory({
        id: newId('sty'), userId: req.user.id, mediaId: m.id,
        text: String(req.body.text || '').slice(0, 140),
        visibility: req.body.visibility === 'private' ? 'private' : 'public',
        petName: String(p.pet?.name || '').slice(0, 40), petEmoji: String(p.pet?.emoji || '🐶').slice(0, 8),
        createdAt: new Date().toISOString(),
      });
      res.json({ story: storyOut(s) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  });
  r.patch('/me/stories/:id', requireAuth, (req, res) => {
    const s = store.story(req.params.id);
    if (!s || s.userId !== req.user.id) return res.sendStatus(404);
    res.json({ story: storyOut(store.updateStory(s.id, { visibility: req.body.visibility === 'public' ? 'public' : 'private' })) });
  });
  r.delete('/me/stories/:id', requireAuth, (req, res) => {
    const s = store.story(req.params.id);
    if (!s || s.userId !== req.user.id) return res.sendStatus(404);
    store.dropMedia(s.mediaId); store.dropStory(s.id);
    res.json({ ok: true });
  });
  r.get('/feed/stories', requireAuth, (req, res) => res.json({ stories: store.publicStories(req.user.id).map(storyOut) }));

  /* ---- mídia: dono sempre; outros só se for de um story público ---- */
  r.get('/media/:id', requireAuth, (req, res) => {
    const m = store.media(req.params.id);
    if (!m) return res.sendStatus(404);
    const ok = m.ownerId === req.user.id || store.get().stories.some(s => s.mediaId === m.id && store.canSee(s, req.user.id));
    if (!ok) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(m.type).sendFile(path.join(UPLOADS, m.file));
  });

  return r;
}

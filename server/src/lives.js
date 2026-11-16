// Lives de pet ao vivo com Agora.io: o servidor registra as lives ativas, gera tokens
// (quem transmite = host, quem assiste = audiência) e guarda chat e reações recentes.
import crypto from 'node:crypto';
import express from 'express';
import agoraToken from 'agora-token';
import { requireAuth } from './auth.js';
import { userCard } from './circles.js';
import { REACTIONS } from './posts.js';

const { RtcTokenBuilder, RtcRole } = agoraToken;
const env = process.env;
const lives = new Map(); // id -> live (em memória: lives são efêmeras)
const STALE = 45e3;
const configured = () => !!(env.AGORA_APP_ID && env.AGORA_APP_CERTIFICATE);
const uid32 = () => crypto.randomInt(1, 2 ** 31 - 1);
const token = (channel, uid, host) => RtcTokenBuilder.buildTokenWithUid(env.AGORA_APP_ID, env.AGORA_APP_CERTIFICATE, channel, uid, host ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER, 3600 * 4, 3600 * 4);

function alive(l, now = Date.now()) { return !l.ended && now - l.lastPing < STALE; }
function viewers(l, now = Date.now()) { for (const [u, t] of l.viewers) if (now - t > STALE) l.viewers.delete(u); return l.viewers.size; }
const out = (l, viewerId) => ({
  id: l.id, title: l.title, petName: l.petName, petEmoji: l.petEmoji, host: userCard(l.userId),
  startedAt: l.startedAt, viewers: viewers(l), mine: l.userId === viewerId, ended: !alive(l),
});
function push(l, ev) { ev.seq = ++l.seq; ev.at = Date.now(); l.events.push(ev); if (l.events.length > 300) l.events.shift(); }

setInterval(() => { const now = Date.now(); for (const [id, l] of lives) if (now - l.lastPing > 10 * 60e3) lives.delete(id); }, 60e3).unref();

export function livesRouter() {
  const r = express.Router();
  const json = express.json({ limit: '20kb' });

  r.get('/lives', (req, res) => res.json({
    configured: configured(),
    lives: [...lives.values()].filter(l => alive(l)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(l => out(l, req.user?.id)),
  }));

  r.post('/lives', requireAuth, json, (req, res) => {
    if (!configured()) return res.status(503).json({ error: 'As lives precisam das chaves da Agora (AGORA_APP_ID e AGORA_APP_CERTIFICATE) no servidor.' });
    for (const l of lives.values()) if (l.userId === req.user.id && !l.ended) { l.ended = true; push(l, { type: 'end' }); }
    const id = `live_${crypto.randomBytes(6).toString('hex')}`, uid = uid32();
    const l = {
      id, channel: id, userId: req.user.id, hostUid: uid,
      title: String(req.body.title || 'Ao vivo').slice(0, 80), petName: String(req.body.petName || '').slice(0, 40), petEmoji: String(req.body.petEmoji || '🐶').slice(0, 8),
      startedAt: new Date().toISOString(), lastPing: Date.now(), viewers: new Map(), events: [], seq: 0, ended: false,
    };
    lives.set(id, l);
    res.json({ live: out(l, req.user.id), appId: env.AGORA_APP_ID, channel: id, uid, token: token(id, uid, true) });
  });

  r.post('/lives/:id/join', requireAuth, (req, res) => {
    const l = lives.get(req.params.id);
    if (!l || !alive(l)) return res.status(404).json({ error: 'Esta live já terminou.' });
    if (!configured()) return res.status(503).json({ error: 'Lives indisponíveis no momento.' });
    const uid = uid32();
    if (l.userId !== req.user.id) { l.viewers.set(req.user.id, Date.now()); push(l, { type: 'join', user: userCard(req.user.id) }); }
    res.json({ live: out(l, req.user.id), appId: env.AGORA_APP_ID, channel: l.channel, uid, token: token(l.channel, uid, false) });
  });

  // quem transmite e quem assiste avisam que continuam ali
  r.post('/lives/:id/ping', requireAuth, (req, res) => {
    const l = lives.get(req.params.id);
    if (!l) return res.sendStatus(404);
    if (l.userId === req.user.id) l.lastPing = Date.now(); else if (alive(l)) l.viewers.set(req.user.id, Date.now());
    res.json({ live: out(l, req.user.id) });
  });

  r.post('/lives/:id/end', requireAuth, (req, res) => {
    const l = lives.get(req.params.id);
    if (!l || l.userId !== req.user.id) return res.sendStatus(404);
    l.ended = true; push(l, { type: 'end' }); res.json({ ok: true });
  });

  r.post('/lives/:id/events', requireAuth, json, (req, res) => {
    const l = lives.get(req.params.id);
    if (!l || !alive(l)) return res.status(404).json({ error: 'Esta live já terminou.' });
    if (req.body.type === 'react') {
      if (!REACTIONS.includes(req.body.emoji)) return res.status(400).json({ error: 'Reação inválida.' });
      push(l, { type: 'react', emoji: req.body.emoji, user: userCard(req.user.id) });
    } else {
      const text = String(req.body.text || '').trim().slice(0, 200);
      if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });
      push(l, { type: 'chat', text, user: userCard(req.user.id) });
    }
    res.json({ ok: true });
  });

  r.get('/lives/:id/events', (req, res) => {
    const l = lives.get(req.params.id);
    if (!l) return res.sendStatus(404);
    const since = Number(req.query.since) || 0;
    res.json({ events: l.events.filter(e => e.seq > since), live: out(l, req.user?.id) });
  });
  return r;
}

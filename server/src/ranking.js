// Ranking de reações por período e medalhas automáticas (top 3).
// O período padrão é de 7 dias; o administrador (ADMIN_EMAILS) pode mudar ou encerrar a rodada.
import crypto from 'node:crypto';
import express from 'express';
import { store } from './store.js';
import { requireAuth, isAdmin } from './auth.js';
import { postOut, reactionOf, REACTIONS } from './posts.js';

const DAY = 864e5;
const db = () => store.get();
function settings() {
  const s = db().settings;
  if (!s.rankingDays) s.rankingDays = 7;
  if (!s.periodStart) { s.periodStart = Date.now(); store.save(); }
  return s;
}
/** posts públicos ordenados pelas reações recebidas dentro da janela [start, end) */
export function rank(start, end, limit = 10) {
  return db().stories.filter(p => p.visibility === 'public').map(p => {
    const counts = Object.fromEntries(REACTIONS.map(r => [r, 0]));
    let total = 0;
    for (const v of Object.values(p.reactions || {})) {
      const at = v && typeof v === 'object' ? v.at : 0;
      const e = reactionOf(v);
      if (at >= start && at < end && e in counts) { counts[e]++; total++; }
    }
    return { p, counts, total };
  }).filter(x => x.total > 0).sort((a, b) => b.total - a.total || a.p.createdAt.localeCompare(b.p.createdAt)).slice(0, limit);
}
function award(start, end, days) {
  rank(start, end, 3).forEach((x, i) => db().awards.push({
    id: `awd_${crypto.randomBytes(6).toString('base64url')}`, postId: x.p.id, userId: x.p.userId,
    place: i + 1, total: x.total, start, end, days,
  }));
}
/** fecha os períodos vencidos e premia o top 3 de cada um */
export function finalizeIfDue(now = Date.now()) {
  const s = settings(); let n = 0;
  while (now >= s.periodStart + s.rankingDays * DAY && n++ < 104) {
    const end = s.periodStart + s.rankingDays * DAY;
    award(s.periodStart, end, s.rankingDays);
    s.periodStart = end;
  }
  if (n) store.save();
}
setInterval(() => { try { finalizeIfDue(); } catch (e) { console.error('ranking:', e.message); } }, 10 * 60e3).unref();

export function rankingRouter() {
  const r = express.Router();
  const json = express.json({ limit: '10kb' });

  r.get('/ranking', requireAuth, (req, res) => {
    finalizeIfDue();
    const s = settings(), end = s.periodStart + s.rankingDays * DAY;
    const top = rank(s.periodStart, end, 10).map(x => ({ ...postOut(x.p, req.user.id), periodCounts: x.counts, periodTotal: x.total }));
    const periods = [...new Set(db().awards.map(a => a.end))].sort((a, b) => b - a).slice(0, 4);
    const winners = periods.map(e => ({
      start: db().awards.find(a => a.end === e).start, end: e,
      posts: db().awards.filter(a => a.end === e).sort((a, b) => a.place - b.place).map(a => {
        const p = store.story(a.postId);
        return p && store.canSee(p, req.user.id) ? { place: a.place, total: a.total, post: postOut(p, req.user.id) } : { place: a.place, total: a.total, post: null };
      }),
    }));
    const myBadges = db().awards.filter(a => a.userId === req.user.id).map(a => ({ place: a.place, total: a.total, start: a.start, end: a.end, postId: a.postId }));
    res.json({ period: { start: s.periodStart, end, days: s.rankingDays }, top, winners, myBadges, isAdmin: isAdmin(req.user) });
  });

  // administrador: duração do período e encerramento antecipado
  r.put('/admin/ranking', requireAuth, json, (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Só administradores.' });
    const s = settings();
    if (req.body.days !== undefined) {
      const d = Math.round(Number(req.body.days));
      if (!(d >= 1 && d <= 365)) return res.status(400).json({ error: 'Período entre 1 e 365 dias.' });
      s.rankingDays = d;
    }
    if (req.body.closeNow) { const now = Date.now(); award(s.periodStart, now, s.rankingDays); s.periodStart = now; }
    store.save(); finalizeIfDue();
    res.json({ period: { start: s.periodStart, end: s.periodStart + s.rankingDays * DAY, days: s.rankingDays } });
  });
  return r;
}

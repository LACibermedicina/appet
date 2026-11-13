import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import agoraToken from 'agora-token';
import { askAI, PROMPTS } from './ai.js';
import { PACKAGES, createPaymentLink, parseStripeWebhook, checkMercadoPago } from './payments.js';
import { store } from './store.js';
import { authRouter, sessionMiddleware, requireAuth } from './auth.js';
import { postsRouter } from './posts.js';
import { circlesRouter } from './circles.js';
import { rankingRouter } from './ranking.js';

const { RtcTokenBuilder, RtcRole } = agoraToken;
const env = process.env;
const app = express();
app.set('trust proxy', 1); // atrás do nginx/Caddy

// O webhook do Stripe precisa do corpo bruto: registre antes do express.json()
app.post('/api/pay/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { orderId, paid } = parseStripeWebhook(req.body, req.headers['stripe-signature']);
    if (paid) await fulfill(orderId);
    res.json({ received: true });
  } catch (e) { res.status(400).send(`Webhook: ${e.message}`); }
});

app.use(sessionMiddleware);
app.use('/api', authRouter());
app.use('/api', postsRouter());
app.use('/api', circlesRouter());
app.use('/api', rankingRouter());
app.use(express.json({ limit: '2mb' }));

const userOf = req => req.user.id; // sempre a conta logada
const id = p => `${p}_${crypto.randomBytes(6).toString('hex')}`;

/* ---------- App (front-end) ---------- */
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
app.use(express.static(PUBLIC_DIR));

/* ---------- IA ---------- */
// Genérica, usada pelo app: {messages:[{role,content}], json:boolean}
app.post('/api/ai/raw', requireAuth, async (req, res) => {
  try {
    const { messages = [], json = false } = req.body;
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages vazio' });
    res.json(await askAI({ messages: messages.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 8000) })), json }));
  } catch (e) { res.status(503).json({ error: e.message, details: e.details }); }
});

app.post('/api/ai/:fn', requireAuth, async (req, res) => {
  try {
    const { fn } = req.params;
    const { messages = [], pet = '', input } = req.body;
    let r;
    if (fn === 'consulta') r = await askAI({ system: PROMPTS.consulta(pet), messages });
    else if (fn === 'mediacao') {
      r = await askAI({ system: PROMPTS.mediacao, messages: [{ role: 'user', content: JSON.stringify(input) }], json: true });
      store.addDispute({ id: id('dsp'), userId: userOf(req), input, verdict: r.value, provider: r.provider, at: new Date().toISOString() });
    }
    else if (fn === 'venda') r = await askAI({ system: PROMPTS.venda, messages: [{ role: 'user', content: JSON.stringify(input) }], json: true });
    else if (fn === 'match') r = await askAI({ system: PROMPTS.match, messages: [{ role: 'user', content: JSON.stringify(input) }] });
    else return res.status(404).json({ error: 'função desconhecida' });
    res.json(r); // {provider, text|value}
  } catch (e) { res.status(503).json({ error: e.message, details: e.details }); }
});

/* ---------- Vídeo: token Agora (o certificado nunca vai ao app) ---------- */
app.post('/api/video/token', requireAuth, (req, res) => {
  if (!env.AGORA_APP_ID || !env.AGORA_APP_CERTIFICATE) return res.status(503).json({ error: 'Agora não configurado' });
  const channel = String(req.body.channel || id('consulta'));
  const uid = Number(req.body.uid || Math.floor(Math.random() * 1e9));
  const ttl = Number(env.AGORA_TOKEN_TTL || 3600);
  const token = RtcTokenBuilder.buildTokenWithUid(env.AGORA_APP_ID, env.AGORA_APP_CERTIFICATE, channel, uid, RtcRole.PUBLISHER, ttl, ttl);
  res.json({ appId: env.AGORA_APP_ID, channel, uid, token, expiresIn: ttl });
});

/* ---------- Créditos e pagamentos ---------- */
app.get('/api/wallet', requireAuth, (req, res) => res.json(store.wallet(userOf(req))));

app.post('/api/pay/link', requireAuth, async (req, res) => {
  try {
    const userId = userOf(req);
    const { packageId, listing } = req.body; // pacote/anúncio OU item do brechó
    let item;
    if (packageId && PACKAGES[packageId]) {
      const p = PACKAGES[packageId];
      item = { name: p.name, amount: p.amount, metadata: { packageId } };
    } else if (listing) {
      const fee = Math.round(listing.amount * 0.03);
      item = { name: `Brechó: ${listing.title}`, amount: listing.amount + (listing.shipping || 0) + fee, metadata: { listingId: listing.id, sellerId: listing.sellerId } };
    } else return res.status(400).json({ error: 'informe packageId ou listing' });
    const orderId = id('ord');
    store.createOrder({ id: orderId, userId, item, escrow: !!listing, email: req.user.email });
    const link = await createPaymentLink({ userId, item, orderId });
    store.updateOrder(orderId, { provider: link.provider, providerId: link.id, url: link.url });
    res.json({ orderId, url: link.url, provider: link.provider });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pay/webhook/mercadopago', async (req, res) => {
  try {
    const paymentId = req.body?.data?.id || req.query['data.id'];
    if (paymentId) { const { orderId, paid } = await checkMercadoPago(paymentId); if (paid) await fulfill(orderId); }
    res.sendStatus(200);
  } catch { res.sendStatus(200); }
});

app.post('/api/credits/spend', requireAuth, (req, res) => {
  try { res.json(store.spend(userOf(req), Number(req.body.amount), String(req.body.reason || 'uso'))); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

/* ---------- Brechó: escrow ---------- */
app.post('/api/orders/:id/confirm', requireAuth, (req, res) => {
  const o = store.order(req.params.id);
  if (!o || o.userId !== userOf(req)) return res.sendStatus(404);
  res.json(store.updateOrder(o.id, { status: 'released', releasedAt: new Date().toISOString() }));
});

async function fulfill(orderId) {
  const o = store.order(orderId);
  if (!o || o.status !== 'pending') return; // idempotente
  store.updateOrder(orderId, { status: o.escrow ? 'paid_held' : 'paid', paidAt: new Date().toISOString() });
  const pkg = PACKAGES[o.item.metadata?.packageId];
  if (pkg?.credits) store.addCredits(o.userId, pkg.credits, `Compra ${pkg.name}`);
  await sendReceipt(o).catch(err => console.warn('e-mail falhou:', err.message));
}

/* ---------- E-mail ---------- */
const mailer = env.SMTP_HOST && env.SMTP_USER ? nodemailer.createTransport({
  host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), secure: env.SMTP_SECURE !== 'false',
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
}) : null;
async function sendReceipt(o) {
  if (!mailer || !o.email) return;
  await mailer.sendMail({
    from: env.MAIL_FROM || env.SMTP_USER, to: o.email, subject: `APPET · recibo ${o.id}`,
    text: `Pagamento confirmado: ${o.item.name} — R$ ${(o.item.amount / 100).toFixed(2).replace('.', ',')}\nReferência: ${o.id}`,
  });
}

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  ai: ['claude', 'gemini', 'openai', 'pollinations'].filter(p => ({ claude: env.ANTHROPIC_API_KEY, gemini: env.GEMINI_API_KEY, openai: env.OPENAI_API_KEY, pollinations: env.POLLINATIONS_BASE_URL })[p]),
  video: !!(env.AGORA_APP_ID && env.AGORA_APP_CERTIFICATE),
  payments: env.PAYMENT_PROVIDER || 'stripe',
  mail: !!mailer,
}));

app.listen(Number(env.PORT || 3000), env.HOST || '0.0.0.0', () => console.log(`APPET server em ${env.PUBLIC_URL || 'http://localhost:' + (env.PORT || 3000)}`));

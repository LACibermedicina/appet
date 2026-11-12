// Links de pagamento: Stripe Checkout (Link, cartão e Pix quando habilitados) ou Mercado Pago.
import Stripe from 'stripe';

const env = process.env;
const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export const PACKAGES = {
  p1: { name: '100 créditos', credits: 100, amount: 1990 },
  p2: { name: '330 créditos (300 + 30 bônus)', credits: 330, amount: 4990 },
  p3: { name: '920 créditos (800 + 120 bônus)', credits: 920, amount: 11990 },
  a1: { name: 'Destaque no Brechó (7 dias)', ad: 'brecho_destaque', amount: 990 },
  a2: { name: 'Anúncio de profissional (30 dias)', ad: 'profissional', amount: 4990 },
  a3: { name: 'Evento patrocinado (15 dias)', ad: 'evento', amount: 2990 },
};

/** Cria um link de pagamento. item = {name, amount (centavos), metadata} */
export async function createPaymentLink({ userId, item, orderId }) {
  const success = `${env.PUBLIC_URL}/pagamento/ok?ref=${orderId}`;
  const cancel = `${env.PUBLIC_URL}/pagamento/cancelado?ref=${orderId}`;
  const provider = env.PAYMENT_PROVIDER || 'stripe';

  if (provider === 'stripe') {
    if (!stripe) throw new Error('STRIPE_SECRET_KEY ausente');
    // Sem payment_method_types: o Stripe mostra os métodos ativos no painel (Link, cartão, Pix…).
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ quantity: 1, price_data: { currency: 'brl', unit_amount: item.amount, product_data: { name: item.name } } }],
      success_url: success,
      cancel_url: cancel,
      client_reference_id: orderId,
      metadata: { userId, orderId, ...(item.metadata || {}) },
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 23,
    });
    return { provider, url: session.url, id: session.id };
  }

  if (provider === 'mercadopago') {
    if (!env.MERCADOPAGO_ACCESS_TOKEN) throw new Error('MERCADOPAGO_ACCESS_TOKEN ausente');
    const r = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` },
      body: JSON.stringify({
        items: [{ title: item.name, quantity: 1, unit_price: item.amount / 100, currency_id: 'BRL' }],
        external_reference: orderId,
        metadata: { userId, ...(item.metadata || {}) },
        back_urls: { success, failure: cancel, pending: success },
        auto_return: 'approved',
        notification_url: `${env.PUBLIC_URL}/api/pay/webhook/mercadopago`,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`Mercado Pago: ${r.status} ${JSON.stringify(d).slice(0, 200)}`);
    return { provider, url: d.init_point, id: d.id };
  }
  throw new Error(`PAYMENT_PROVIDER inválido: ${provider}`);
}

/** Valida o webhook do Stripe e devolve {orderId, paid} */
export function parseStripeWebhook(rawBody, signature) {
  if (!stripe || !env.STRIPE_WEBHOOK_SECRET) throw new Error('Stripe não configurado');
  const ev = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') {
    return { orderId: ev.data.object.client_reference_id, paid: true };
  }
  if (ev.type === 'checkout.session.async_payment_succeeded') { // ex.: Pix confirmado depois
    return { orderId: ev.data.object.client_reference_id, paid: true };
  }
  return { paid: false };
}

/** Mercado Pago: consulta o pagamento informado pela notificação */
export async function checkMercadoPago(paymentId) {
  const r = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
    headers: { authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}` },
  });
  const d = await r.json();
  return { orderId: d.external_reference, paid: d.status === 'approved' };
}

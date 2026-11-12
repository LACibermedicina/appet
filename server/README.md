# APPET · servidor

Backend que dá vida real às funções do protótipo:

| Rota | O que faz |
|---|---|
| `POST /api/ai/consulta` · `mediacao` · `venda` · `match` | IA com **failsafe**: tenta Claude → Gemini → OpenAI → Pollinations (ordem em `AI_ORDER`). Responde `{provider, text}` ou `{provider, value}` (JSON). |
| `POST /api/video/token` | Gera token Agora para a videoconsulta. O certificado nunca sai do servidor. |
| `POST /api/pay/link` | Cria **link de pagamento** (Stripe Checkout com Link/cartão/Pix, ou Mercado Pago) para pacotes de créditos, anúncios ou itens do Brechó. |
| `POST /api/pay/webhook/stripe` · `/mercadopago` | Confirma o pagamento, credita créditos, retém o valor do Brechó (escrow) e manda recibo por e-mail. |
| `POST /api/credits/spend` | Debita créditos (destaque, videoconsulta, super pata). |
| `POST /api/orders/:id/confirm` | Comprador confirma entrega e libera o valor ao vendedor. |
| `GET /api/health` | Mostra quais integrações estão configuradas. |

## Rodar

```bash
cp .env.example .env   # preencha suas chaves NOVAS
npm install
npm start
```

Stripe local: `stripe listen --forward-to localhost:3000/api/pay/webhook/stripe` e copie o `whsec_…` para `STRIPE_WEBHOOK_SECRET`.

## Ligar ao app
No protótipo, troque as funções simuladas por chamadas:
- `askAI(...)` → `fetch('/api/ai/consulta', {method:'POST', body: JSON.stringify({messages, pet})})`
- `checkout(...)` → `fetch('/api/pay/link', …)` e abrir `url` retornada
- videoconsulta → `/api/video/token` + SDK `agora-rtc-sdk-ng` no app (`client.join(appId, channel, token, uid)`)

## Segurança
- Nunca coloque chaves no front-end nem faça commit do `.env`.
- Troque a autenticação de exemplo (`x-user-id`) por login real antes de produção.
- `data.json` é só para testes: use um banco de verdade.

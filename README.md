# APPET — o sistema do seu pet

Aplicativo completo: front-end (um único `index.html`) + servidor Node com IA, vídeo, pagamentos e e-mail.

```
APPET/
├─ LEIA-ME.md
└─ server/
   ├─ public/index.html   ← o app inteiro (HTML + CSS + JS)
   ├─ src/server.js       ← API: IA, vídeo, pagamentos, créditos, e-mail
   ├─ src/ai.js           ← failsafe Claude → Gemini → OpenAI → Pollinations
   ├─ src/payments.js     ← links de pagamento (Stripe ou Mercado Pago)
   ├─ src/store.js        ← armazenamento simples (trocar por banco em produção)
   ├─ .env.example        ← modelo das variáveis (preencha e renomeie para .env)
   ├─ package.json
   └─ README.md           ← detalhes das rotas da API
```

## 1. Só ver o app (sem instalar nada)
Abra `server/public/index.html` no navegador. Tudo funciona em modo demonstração: pagamentos simulados, IA no **modo local (failsafe)** e vídeo simulado.

## 2. App completo com servidor
Requer Node.js 18.17 ou mais novo.

```bash
cd server
cp .env.example .env     # preencha com chaves NOVAS (veja Segurança)
npm install
npm start                # abre em http://localhost:3000
```

Com o servidor rodando, o app passa a usar a IA de verdade pela rota `/api/ai/raw`, tentando os provedores na ordem de `AI_ORDER` até um responder. Se nenhum responder, ele cai no modo local. O nome do provedor que respondeu aparece no selo "✨ IA" de cada tela.

`GET /api/health` mostra quais integrações estão ativas.

## Funções do app
- Tela inicial com prompt central, ícones em órbita e stories em loop (arrastável, ocultável)
- Desktop estilo macOS: menu superior, dock, janelas móveis, busca ⌘K, APPeTV (TV cartoon com canais)
- Painel, Adestramento (clicker e sessões), Academia (trilhas gamificadas, quiz, medalhas, ranking)
- InterAKão (tradução de latidos + canal entre pets), PetReels/Stories, Aventuras (Antes & Depois)
- Eventos e concursos, Loja, Profissionais (agendamento), PetSurf (rede de cuidadores)
- Saúde (vacinas, peso, higiene), Rotina (ração, horários, estoque), Poetia (poemas, sons, respiração)
- Ficha do Pet (foto como fundo, microchip ISO, RG Animal, modo pet perdido)
- Carteira (créditos, anúncios, pagamento por Link/Pix/cartão/link de pagamento)
- Brechó Pet (novos e usados, escrow, IA de anúncio, mediação de disputas por argumentos)
- Consulta IA com triagem de urgência e videoconsulta
- PetMatch (amizade ou algo mais, com regras de cruzamento responsável)

## O que ainda falta ligar para produção
- **Pagamentos no app:** a função `checkout()` do `index.html` ainda simula. Troque o clique "Pagar" por `POST /api/pay/link` e abra a `url` retornada.
- **Vídeo:** busque o token em `POST /api/video/token` e use o SDK `agora-rtc-sdk-ng` na tela de videoconsulta.
- **Login e banco de dados:** substitua o `x-user-id` de exemplo por autenticação real e o `data.json` por um banco (Postgres, Supabase…).
- **Dados de demonstração:** produtos, profissionais, pets do PetMatch etc. estão fixos no `index.html` e devem vir da API.

## Segurança
- As chaves ficam **só** no `.env` do servidor; nunca no `index.html`.
- As credenciais coladas na conversa devem ser **trocadas** antes de usar (senha SMTP, token GitHub, chaves de IA e Agora).
- Não faça commit do `.env` (o `.gitignore` já ignora).

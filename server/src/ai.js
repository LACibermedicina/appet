// IA com failsafe: tenta cada provedor na ordem de AI_ORDER até um responder.
// Todas as chaves ficam só no servidor; o app chama /api/ai.

const env = process.env;
const TIMEOUT = Number(env.AI_TIMEOUT_MS || 20000);

async function withTimeout(promiseFactory) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try { return await promiseFactory(ctrl.signal); } finally { clearTimeout(t); }
}
async function postJSON(url, headers, body, signal) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// messages: [{role:'user'|'assistant', content:string}], system: string
const providers = {
  claude: {
    ok: () => !!env.ANTHROPIC_API_KEY,
    run: (system, messages, signal) => postJSON('https://api.anthropic.com/v1/messages',
      { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model: env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 800, system, messages }, signal)
      .then(d => d.content?.map(c => c.text || '').join('') || ''),
  },
  gemini: {
    ok: () => !!env.GEMINI_API_KEY,
    run: (system, messages, signal) => postJSON(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || 'gemini-flash-latest'}:generateContent`,
      { 'x-goog-api-key': env.GEMINI_API_KEY },
      {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      }, signal)
      .then(d => d.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''),
  },
  openai: {
    ok: () => !!env.OPENAI_API_KEY,
    run: (system, messages, signal) => openaiCompat(env.OPENAI_BASE_URL || 'https://api.openai.com/v1', env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-4o-mini', system, messages, signal),
  },
  pollinations: {
    ok: () => !!env.POLLINATIONS_BASE_URL,
    run: (system, messages, signal) => openaiCompat(env.POLLINATIONS_BASE_URL, env.POLLINATIONS_API_KEY, env.POLLINATIONS_MODEL || 'openai', system, messages, signal, true),
  },
};
function openaiCompat(base, key, model, system, messages, signal, fullUrl = false) {
  const url = fullUrl && !base.endsWith('/chat/completions') ? base : `${base.replace(/\/$/, '')}/chat/completions`;
  return postJSON(url, key ? { authorization: `Bearer ${key}` } : {},
    { model, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] }, signal)
    .then(d => d.choices?.[0]?.message?.content || '');
}

export async function askAI({ system = '', messages, json = false }) {
  const order = (env.AI_ORDER || 'claude,gemini,openai,pollinations').split(',').map(s => s.trim()).filter(Boolean);
  const sys = json ? `${system}\nResponda SOMENTE com JSON válido, sem texto extra.` : system;
  const errors = [];
  for (const name of order) {
    const p = providers[name];
    if (!p || !p.ok()) { errors.push(`${name}: não configurado`); continue; }
    try {
      const text = await withTimeout(signal => p.run(sys, messages, signal));
      if (!text.trim()) throw new Error('resposta vazia');
      if (json) {
        const m = text.match(/\{[\s\S]*\}/);
        return { provider: name, value: JSON.parse(m ? m[0] : text) };
      }
      return { provider: name, text };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  const err = new Error('Nenhum provedor de IA respondeu');
  err.details = errors;
  throw err;
}

// Prompts das funções do app (consulta, mediação, venda, match)
export const PROMPTS = {
  consulta: pet => `Você é o assistente de saúde e comportamento do APPET. Não substitui o veterinário e não prescreve remédios nem doses. Português do Brasil, até 120 palavras. Primeira linha exatamente "URGÊNCIA: baixa|média|alta"; se alta, oriente atendimento imediato.\n${pet}`,
  mediacao: `Você é um mediador imparcial de disputas de um brechó online de itens para pets no Brasil. Use o CDC só como referência geral (não é parecer jurídico). Devolva JSON: decisao, reembolso_percentual (0-100), devolver_item (bool), justificativa (até 60 palavras), pontos_comprador, pontos_vendedor.`,
  venda: `Você ajuda tutores a vender itens de pet. Devolva JSON: titulo (até 60 caracteres), descricao (até 70 palavras, honesta), preco_sugerido, faixa_min, faixa_max (números em reais), dicas (3 frases curtas).`,
  match: `Explique em até 30 palavras, em português e com bom humor, por que dois pets combinam e sugira um primeiro encontro.`,
};

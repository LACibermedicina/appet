// Teste de privacidade: duas contas não podem ver os dados uma da outra.
// Uso: node test/privacidade.mjs   (sobe o servidor numa porta temporária)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
fs.rmSync(path.join(ROOT, 'data.json'), { force: true });

const srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', AI_ORDER: 'none' }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) falhas++; };

function cliente() {
  let cookie = '';
  return async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    let data = null; try { data = await r.clone().json(); } catch {}
    return { status: r.status, data, r };
  };
}
// 1x1 JPEG
const IMG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch {} await sleep(200); }
  const anon = cliente(), A = cliente(), B = cliente();

  ok((await anon('GET', '/api/me/profile')).status === 401, 'sem login não lê perfil');
  ok((await anon('POST', '/api/ai/raw', { messages: [{ role: 'user', content: 'oi' }] })).status === 401, 'sem login não usa a IA');

  ok((await A('POST', '/api/auth/register', { name: 'Ana', email: 'ana@teste.com', password: 'senha-forte-1' })).status === 200, 'Ana cria conta');
  ok((await B('POST', '/api/auth/register', { name: 'Beto', email: 'beto@teste.com', password: 'senha-forte-2' })).status === 200, 'Beto cria conta');
  ok((await B('POST', '/api/auth/register', { email: 'ana@teste.com', password: 'qualquer123' })).status === 409, 'e-mail duplicado é recusado');

  await A('PUT', '/api/me/profile', { onboarded: true, tutor: 'Ana', pet: { name: 'Thor' }, chip: { has: true, num: '076099000123456' } });
  const fotoA = (await A('PUT', '/api/me/photo', { image: IMG })).data.photo;
  const privado = (await A('POST', '/api/me/stories', { image: IMG, text: 'só meu', visibility: 'private' })).data.story;
  const publico = (await A('POST', '/api/me/stories', { image: IMG, text: 'para todos', visibility: 'public' })).data.story;

  const perfilB = (await B('GET', '/api/me/profile')).data.profile;
  ok(perfilB === null, 'Beto não recebe o perfil da Ana (nem chip, nem nome do pet)');
  ok((await B('GET', '/api/me/stories')).data.stories.length === 0, 'Beto não vê stories da Ana na conta dele');
  const feedB = (await B('GET', '/api/feed/stories')).data.stories;
  ok(feedB.length === 1 && feedB[0].id === publico.id, 'na comunidade Beto vê só o story público da Ana');
  ok((await B('GET', fotoA)).status === 404, 'Beto não abre a foto de perfil da Ana');
  ok((await B('GET', privado.url)).status === 404, 'Beto não abre a imagem do story privado');
  ok((await B('GET', publico.url)).status === 200, 'Beto abre a imagem do story público');
  ok((await A('GET', fotoA)).status === 200, 'Ana abre a própria foto');
  ok((await B('DELETE', `/api/me/stories/${publico.id}`)).status === 404, 'Beto não apaga story da Ana');
  ok((await anon('GET', publico.url)).status === 401, 'sem login nenhuma imagem abre');

  ok((await A('PATCH', `/api/me/stories/${publico.id}`, { visibility: 'private' })).status === 200, 'Ana torna o story privado');
  ok((await B('GET', '/api/feed/stories')).data.stories.length === 0, 'e ele some da comunidade');

  ok((await A('POST', '/api/auth/logout')).status === 200, 'Ana sai');
  ok((await A('GET', '/api/me/profile')).status === 401, 'depois de sair, a sessão não vale mais');
  ok((await A('POST', '/api/auth/login', { email: 'ana@teste.com', password: 'errada' })).status === 401, 'senha errada é recusada');
  ok((await A('POST', '/api/auth/login', { email: 'ana@teste.com', password: 'senha-forte-1' })).status === 200, 'Ana entra de novo');
  ok((await A('GET', '/api/me/profile')).data.profile?.pet?.name === 'Thor', 'e encontra os próprios dados');
  ok((await A('GET', '/')).status === 200, 'o app (index.html) continua sendo servido');
} catch (e) {
  console.error(e); falhas++;
} finally {
  srv.kill();
  fs.rmSync(path.join(ROOT, 'data.json'), { force: true });
  console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo: cada conta só vê os próprios dados.');
  process.exit(falhas ? 1 : 0);
}

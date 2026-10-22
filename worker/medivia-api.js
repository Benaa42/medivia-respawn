// Ponte entre o Medivia Labs e a API oficial do Medivia (https://medivia.online/api/public/).
// Roda como Cloudflare Worker no endereço api.medivialabs.com. A API pede login (Basic Auth) com uma conta do jogo:
// o usuário e a senha ficam como SEGREDOS do Worker (MEDIVIA_USUARIO e MEDIVIA_SENHA), colocados no painel da
// Cloudflare, e nunca aparecem neste código, no site nem no GitHub. Quem visita o site não informa senha nenhuma.
//
// Endereços (os mesmos da API, só leitura):
//   /player/{nome}   /online/{mundo}   /highscores/{mundo}/{vocação}/{skill}/{página}   /guilds/{mundo}   /houses/{mundo}
//   /guilda/{mundo}/{nome}  a guilda com os membros (rank, nick) e, de cada um, nível, vocação, online, último login e
//                       XP de ontem, 7 e 30 dias; importa o histórico de poucos membros por vez (o site pede de novo)
//   /historico/{nome}   XP e tempo online por dia (horário de Brasília) e as skills dos rankings, do que a coleta guardou;
//                       na primeira vez de cada personagem, importa o histórico que já existe (ver importar())
//   /coleta             quando a coleta rodou pela última vez, o que fez ou o erro, e os totais do banco
// Apoio ao projeto (POST, fora da API do jogo):
//   /kofi               aviso do Ko-fi a cada doação (webhook); só vale com o código de verificação, no segredo KOFI_TOKEN
//   /apoio              o site conta o que o visitante fez na caixa de apoio (abriu, copiou o Pix, foi ao Ko-fi), por
//                       dia e país, sem guardar quem foi
//   /painel/apoio       (GET) doações e contagens para o painel pessoal; pede a chave do segredo PAINEL_CHAVE
//   /teste              confere se o login da conta do site funciona (não mostra usuário nem senha)
// Cada resposta da API diz por quanto tempo vale (cached_for). O Worker guarda a resposta por esse tempo e só volta
// a consultar a API depois dele, como a equipe do jogo pediu ("cache on your end and avoid polling too aggressively").
// Se a API recusar por excesso de pedidos (429), devolve a última resposta guardada, de até um dia.
//
// Coleta (agendada a cada minuto, precisa do banco D1 ligado como DB):
//   - lê quem está online em cada mundo de MUNDOS (um pedido por minuto e por mundo) e guarda as sessões: entrada,
//     saída e nível, para o tempo online por dia;
//   - quando um personagem ACOMPANHADO desloga, busca a ficha dele e guarda o XP exato (fila, poucos por minuto);
//     acompanhado = alguém abriu o personagem no Medivia Labs;
//   - uma página do ranking de nível por minuto, nos minutos 10 a 19 de cada hora: o XP dos 1000 primeiros, só
//     quando mudou;
//   - nos outros minutos, uma página dos rankings de skills (RANKINGS_SKILLS, 10 páginas cada, em rodízio): a API não
//     traz as skills na ficha, só nos rankings. O magic level vem do ranking de cada vocação, senão archers e knights
//     nunca entrariam entre os 1000 primeiros. Uma volta completa leva umas duas horas.

const API = 'https://medivia.online/api/public/';
const ORIGENS = ['https://medivialabs.com', 'https://www.medivialabs.com', 'http://localhost:8765', 'http://localhost:8766'];
const MUNDO = '[a-z]{3,20}';
const ROTAS = [
  /^player\/[^/]{2,40}$/,
  new RegExp('^online\\/' + MUNDO + '$'),
  new RegExp('^highscores\\/' + MUNDO + '\\/(all|none|mages|druids|archers|knights)\\/(level|maglevel|melee|distance|blocking|fishing|mining|cooking)(\\/(10|[1-9]))?$'),
  new RegExp('^guilds\\/' + MUNDO + '$'),
  new RegExp('^houses\\/' + MUNDO + '$'),
];
const FILA_POR_MINUTO = 3;     // fichas buscadas por minuto na coleta, com intervalo entre elas (a API aceita 1 pedido por segundo)
const INTERVALO_MS = 2500;
const BRASILIA = -3 * 3600;    // os dias do histórico contam no horário de Brasília
const RANKINGS_SKILLS = [['maglevel', 'mages'], ['maglevel', 'druids'], ['maglevel', 'archers'], ['maglevel', 'knights'],
  ['distance', 'archers'], ['melee', 'knights'], ['blocking', 'all'], ['fishing', 'all'], ['mining', 'all'], ['cooking', 'all']];

const json = (obj, status, cors, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', ...extra } });
const dormir = ms => new Promise(r => setTimeout(r, ms));
const chaveNome = n => String(n).trim().toLowerCase();
const agora = () => Math.floor(Date.now() / 1000);
const pedir = (env, rota) => fetch(API + rota.split('/').map(encodeURIComponent).join('/'), {
  headers: {
    Authorization: 'Basic ' + btoa(unescape(encodeURIComponent((env.MEDIVIA_USUARIO || '') + ':' + (env.MEDIVIA_SENHA || '')))),
    Accept: 'application/json',
    'User-Agent': 'MediviaLabs/1.0 (+https://medivialabs.com)',
  },
});

/* ---------- Banco (D1) ---------- */
let pronto = false;
async function preparar(db) {
  if (pronto) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS personagens (chave TEXT PRIMARY KEY, nome TEXT, mundo TEXT, desde INTEGER, visto INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS xp (chave TEXT, quando INTEGER, nivel INTEGER, experiencia INTEGER, origem TEXT)'),
    db.prepare('CREATE INDEX IF NOT EXISTS xp_por_nome ON xp (chave, quando)'),
    db.prepare('CREATE TABLE IF NOT EXISTS online_agora (mundo TEXT, chave TEXT, nome TEXT, entrou INTEGER, nivel INTEGER, PRIMARY KEY (mundo, chave))'),
    db.prepare('CREATE TABLE IF NOT EXISTS sessoes (chave TEXT, mundo TEXT, entrou INTEGER, saiu INTEGER, nivel INTEGER)'),
    db.prepare('CREATE INDEX IF NOT EXISTS sessoes_por_nome ON sessoes (chave, entrou)'),
    db.prepare('CREATE TABLE IF NOT EXISTS fila (chave TEXT PRIMARY KEY, nome TEXT, pedido INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS ultimo_xp (chave TEXT PRIMARY KEY, experiencia INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS skills (chave TEXT, skill TEXT, valor INTEGER, quando INTEGER, PRIMARY KEY (chave, skill))'),
    db.prepare('CREATE TABLE IF NOT EXISTS xp_importado (chave TEXT, dia TEXT, nivel INTEGER, ganho INTEGER, PRIMARY KEY (chave, dia))'),
    db.prepare('CREATE TABLE IF NOT EXISTS online_importado (chave TEXT, dia TEXT, segundos INTEGER, PRIMARY KEY (chave, dia))'),
    db.prepare('CREATE TABLE IF NOT EXISTS importados (chave TEXT PRIMARY KEY, quando INTEGER, ate TEXT, dias INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS perfil (chave TEXT PRIMARY KEY, vocacao TEXT, nivel INTEGER, ultimo_login INTEGER, atualizado INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS doacoes (id TEXT PRIMARY KEY, quando INTEGER, nome TEXT, valor TEXT, moeda TEXT, tipo TEXT, mensagem TEXT, publica INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS apoio_eventos (dia TEXT, acao TEXT, pais TEXT, n INTEGER, PRIMARY KEY (dia, acao, pais))'),
  ]);
  pronto = true;
}
// Guarda o XP de várias fichas de uma vez, só das que mudaram desde a última vez. No plano gratuito o D1 aceita só 50
// consultas por execução (cada linha de um lote conta), então a lista vai inteira num texto JSON e o próprio banco a
// desmonta (json_each): duas consultas, seja uma ficha ou cem.
async function guardarXp(db, lista, origem) {
  const fichas = lista.filter(p => p && p.name && Number.isFinite(Number(p.experience)))
    .map(p => ({ c: chaveNome(p.name), n: Number(p.level) || 0, e: Number(p.experience) }));
  if (!fichas.length) return;
  const dados = JSON.stringify(fichas);
  await db.batch([
    db.prepare("INSERT INTO xp (chave, quando, nivel, experiencia, origem) SELECT json_extract(j.value, '$.c'), ?, json_extract(j.value, '$.n'), json_extract(j.value, '$.e'), ? FROM json_each(?) j LEFT JOIN ultimo_xp u ON u.chave = json_extract(j.value, '$.c') WHERE u.experiencia IS NULL OR u.experiencia <> json_extract(j.value, '$.e')").bind(agora(), origem, dados),
    db.prepare("INSERT OR REPLACE INTO ultimo_xp (chave, experiencia) SELECT json_extract(value, '$.c'), json_extract(value, '$.e') FROM json_each(?)").bind(dados),
  ]);
}

/* ---------- Perfil: vocação, nível e último login ---------- */
const UPSERT_PERFIL = " ON CONFLICT(chave) DO UPDATE SET vocacao = COALESCE(excluded.vocacao, vocacao), nivel = COALESCE(excluded.nivel, nivel), " +
  "ultimo_login = MAX(COALESCE(excluded.ultimo_login, 0), COALESCE(ultimo_login, 0)), atualizado = excluded.atualizado";
const guardarPerfil = (db, lista) => lista.length ? db.prepare("INSERT INTO perfil (chave, vocacao, nivel, ultimo_login, atualizado) SELECT json_extract(value, '$.c'), json_extract(value, '$.v'), json_extract(value, '$.l'), json_extract(value, '$.e'), ? FROM json_each(?) WHERE true" + UPSERT_PERFIL)
  .bind(agora(), JSON.stringify(lista)) : null;
const diaBr = seg => new Date((seg + BRASILIA) * 1000).toISOString().slice(0, 10);

/* ---------- Coleta agendada ---------- */
// Cada execução deixa um registro (quando, o que fez ou o erro) em estado/ultima_coleta, visto em /coleta
async function coletarComRegistro(env) {
  const ini = Date.now(), reg = { quando: new Date(ini).toISOString(), ok: false, passos: [] };
  try { await coletar(env, reg); reg.ok = true; } catch (e) { reg.erro = String((e && e.message) || e).slice(0, 300); }
  reg.ms = Date.now() - ini;
  if (env.DB) await env.DB.prepare('INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)').bind('ultima_coleta', JSON.stringify(reg)).run().catch(() => {});
}
async function coletar(env, reg = { passos: [] }) {
  const db = env.DB;
  if (!db) throw new Error('banco D1 não ligado (binding DB)');
  if (!env.MEDIVIA_USUARIO) throw new Error('falta o segredo MEDIVIA_USUARIO');
  await preparar(db);
  const mundos = String(env.MUNDOS || 'pendulum').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const t = agora();
  for (const mundo of mundos) {
    const r = await pedir(env, 'online/' + mundo);
    reg.passos.push('online/' + mundo + ': ' + r.status);
    if (!r.ok) continue;   // 429 ou erro: tenta no próximo minuto
    const lista = ((await r.json()).players || []).map(p => ({ chave: chaveNome(p.name), nome: p.name, entrou: Number(p.timestamp) || 0, nivel: p.level, vocacao: p.vocation }));
    // A lista vai num texto JSON só. Quem não está mais nela (ou entrou de novo, com outra hora de entrada) fecha a
    // sessão; se for acompanhado, entra na fila da ficha. Quem é novo entra em online_agora. Quatro consultas por mundo.
    const dados = JSON.stringify(lista.map(p => ({ k: p.chave + '@' + p.entrou, c: p.chave, n: p.nome, e: p.entrou, l: p.nivel })));
    const fora = "o.mundo = ? AND (o.chave || '@' || o.entrou) NOT IN (SELECT json_extract(value, '$.k') FROM json_each(?))";
    await db.batch([
      db.prepare('INSERT INTO sessoes (chave, mundo, entrou, saiu, nivel) SELECT o.chave, o.mundo, o.entrou, ?, o.nivel FROM online_agora o WHERE ' + fora).bind(t, mundo, dados),
      db.prepare('INSERT OR IGNORE INTO fila (chave, nome, pedido) SELECT o.chave, o.nome, ? FROM online_agora o JOIN personagens p ON p.chave = o.chave WHERE ' + fora).bind(t, mundo, dados),
      db.prepare('DELETE FROM online_agora AS o WHERE ' + fora).bind(mundo, dados),
      db.prepare("INSERT OR IGNORE INTO online_agora (mundo, chave, nome, entrou, nivel) SELECT ?, json_extract(value, '$.c'), json_extract(value, '$.n'), json_extract(value, '$.e'), json_extract(value, '$.l') FROM json_each(?)").bind(mundo, dados),
      guardarPerfil(db, lista.map(p => ({ c: p.chave, v: p.vocacao || null, l: Number(p.nivel) || null, e: p.entrou || null }))),
    ].filter(Boolean));
    reg.passos.push(mundo + ': ' + lista.length + ' online');
  }
  // Fichas de quem deslogou (só os acompanhados), poucas por minuto
  // A ficha só atualiza depois do logout (dito no canal da API): espera 2 minutos antes de buscar
  const fila = (await db.prepare('SELECT chave, nome FROM fila WHERE pedido <= ? ORDER BY pedido LIMIT ?').bind(t - 120, FILA_POR_MINUTO).all()).results || [];
  for (const [i, f] of fila.entries()) {
    if (i) await dormir(INTERVALO_MS);
    const r = await pedir(env, 'player/' + f.nome);
    if (r.status === 429) break;
    if (r.ok) { const p = (await r.json()).player; if (p) await guardarXp(db, [p], 'logout'); }
    await db.prepare('DELETE FROM fila WHERE chave = ?').bind(f.chave).run();
  }
  // Ranking de nível: uma página por minuto nos minutos 10 a 19 de cada hora; nos outros, uma página de skills
  const min = new Date().getUTCMinutes();
  await dormir(1500);   // a API aceita 1 pedido por segundo
  if (min < 10 || min > 19) { await coletarSkills(env, db, mundos, reg); return; }
  {
    const pagina = min - 9;
    for (const mundo of mundos) {
      const r = await pedir(env, 'highscores/' + mundo + '/all/level/' + pagina);
      if (!r.ok) continue;
      const linhas = (await r.json()).highscores || [];
      await guardarXp(db, linhas.map(h => ({ name: h.name, level: h.value, experience: h.count })), 'ranking');
    }
  }
}

// Uma página de ranking de skill por minuto. O passo do rodízio fica em estado/skills_passo; um ranking com página
// vazia (menos de 1000 pessoas, ou cooking, que às vezes vem vazio) pula para o próximo.
async function coletarSkills(env, db, mundos, reg) {
  const e = await db.prepare('SELECT valor FROM estado WHERE chave = ?').bind('skills_passo').first();
  const total = RANKINGS_SKILLS.length * 10;
  let passo = (Number(e && e.valor) || 0) % total;
  const [skill, voc] = RANKINGS_SKILLS[Math.floor(passo / 10)], pagina = passo % 10 + 1;
  let vazia = true, recusou = false;
  for (const mundo of mundos) {
    const r = await pedir(env, 'highscores/' + mundo + '/' + voc + '/' + skill + '/' + pagina);
    reg.passos.push(skill + '/' + voc + '/' + pagina + ': ' + r.status);
    if (r.status === 429) { recusou = true; continue; }
    if (!r.ok) continue;
    const linhas = ((await r.json()).highscores || []).filter(h => h && h.name && Number.isFinite(Number(h.value)));
    if (!linhas.length) continue;
    vazia = false;
    await db.prepare("INSERT OR REPLACE INTO skills (chave, skill, valor, quando) SELECT json_extract(value, '$.c'), ?, json_extract(value, '$.v'), ? FROM json_each(?)")
      .bind(skill, agora(), JSON.stringify(linhas.map(h => ({ c: chaveNome(h.name), v: Number(h.value) })))).run();
  }
  if (recusou) return;   // 429: repete a mesma página no próximo minuto
  passo = vazia ? (Math.floor(passo / 10) + 1) * 10 : passo + 1;
  await db.prepare('INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)').bind('skills_passo', String(passo % total)).run();
}

/* ---------- Apoio ao projeto ---------- */
const ACOES_APOIO = ['abriu', 'pix', 'pixlink', 'kofi'];
const iguais = (a, b) => { a = String(a || ''); b = String(b || ''); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
// Ko-fi manda um formulário com o campo "data" (JSON). O e-mail de quem doou não é guardado.
async function receberKofi(req, env) {
  if (!env.DB || !env.KOFI_TOKEN) return new Response('indisponível', { status: 503 });
  let d;
  try { d = JSON.parse((await req.formData()).get('data') || ''); } catch { return new Response('formato inválido', { status: 400 }); }
  if (!d || !iguais(d.verification_token, env.KOFI_TOKEN)) return new Response('recusado', { status: 403 });
  await preparar(env.DB);
  const id = String(d.kofi_transaction_id || d.message_id || crypto.randomUUID()).slice(0, 80);
  const quando = Math.floor((Date.parse(d.timestamp) || Date.now()) / 1000);
  await env.DB.prepare('INSERT OR IGNORE INTO doacoes (id, quando, nome, valor, moeda, tipo, mensagem, publica) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, quando, String(d.from_name || '').slice(0, 80), String(d.amount || '').slice(0, 20), String(d.currency || '').slice(0, 8),
      String(d.type || '').slice(0, 30), String(d.message || '').slice(0, 500), d.is_public === false ? 0 : 1).run();
  return new Response('ok');
}
// Contagem do que o visitante fez na caixa de apoio: só a ação, o dia (Brasília) e o país que a Cloudflare informa
async function contarApoio(req, env, origem) {
  if (!env.DB || !ORIGENS.includes(origem)) return new Response(null, { status: 204 });
  let acao = '';
  try { acao = String(JSON.parse(await req.text()).acao || ''); } catch { /* corpo inválido: ignora */ }
  if (!ACOES_APOIO.includes(acao)) return new Response(null, { status: 204 });
  const pais = /^[A-Z]{2}$/.test((req.cf && req.cf.country) || '') ? req.cf.country : '??';
  const dia = new Date((agora() + BRASILIA) * 1000).toISOString().slice(0, 10);
  await preparar(env.DB);
  await env.DB.prepare('INSERT INTO apoio_eventos (dia, acao, pais, n) VALUES (?, ?, ?, 1) ON CONFLICT(dia, acao, pais) DO UPDATE SET n = n + 1').bind(dia, acao, pais).run();
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origem } });
}
async function painelApoio(req, env, cors) {
  const chave = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.PAINEL_CHAVE || !iguais(chave, env.PAINEL_CHAVE)) return json({ erro: 'chave do painel ausente ou errada' }, 403, cors);
  if (!env.DB) return json({ erro: 'banco D1 não ligado' }, 503, cors);
  await preparar(env.DB);
  const doacoes = (await env.DB.prepare('SELECT quando, nome, valor, moeda, tipo, mensagem, publica FROM doacoes ORDER BY quando DESC').all()).results || [];
  const eventos = (await env.DB.prepare('SELECT dia, acao, pais, n FROM apoio_eventos WHERE dia >= ? ORDER BY dia').bind(new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10)).all()).results || [];
  return json({ doacoes, eventos, kofiLigado: !!env.KOFI_TOKEN }, 200, cors, { 'Cache-Control': 'no-store' });
}

/* ---------- Histórico que já existe em outros sites ---------- */
// Combinado com o Wildboo, que administra o MediviaGeeks e o MediviaThings: na primeira vez que um personagem é
// aberto aqui, buscamos UMA vez o histórico que eles já têm (XP e tempo online por dia do MediviaGeeks; skills do
// MediviaThings que o nosso ranking ainda não tem) e daí em diante vale só a nossa coleta. A página dá o crédito.
const GEEKS = 'https://mediviageeks.com/api/';
const THINGS = 'https://mediviathings-native.fly.dev/v1/';
const pedirFora = url => fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'MediviaLabs/1.0 (+https://medivialabs.com)' } });
async function importar(db, chave, nome) {
  const ja = await db.prepare('SELECT 1 AS x FROM importados WHERE chave = ?').bind(chave).first();
  if (ja) return;
  let dias = 0, ate = '';
  try {
    const [rx, ro] = await Promise.all([pedirFora(GEEKS + 'playersexp?name=' + encodeURIComponent(nome)), pedirFora(GEEKS + 'onlinehistory?name=' + encodeURIComponent(nome) + '&includeCurrent=true')]);
    const xp = rx.ok ? await rx.json() : [];
    const on = ro.ok ? await ro.json() : {};
    const linhasXp = (Array.isArray(xp) ? xp : []).filter(x => x && x.DATA && Number.isFinite(Number(x.EXPGAIN)))
      .map(x => ({ d: String(x.DATA).slice(0, 10), n: Number(x.LEVEL) || 0, g: Number(x.EXPGAIN) }));
    // o tempo online deles vem em minutos por dia
    const linhasOn = Object.entries(on && typeof on === 'object' && !Array.isArray(on) ? on : {})
      .filter(([d, m]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Number(m))).map(([d, m]) => ({ d, s: Math.round(Number(m) * 60) }));
    if (linhasXp.length) await db.prepare("INSERT OR REPLACE INTO xp_importado (chave, dia, nivel, ganho) SELECT ?, json_extract(value, '$.d'), json_extract(value, '$.n'), json_extract(value, '$.g') FROM json_each(?)").bind(chave, JSON.stringify(linhasXp)).run();
    if (linhasOn.length) await db.prepare("INSERT OR REPLACE INTO online_importado (chave, dia, segundos) SELECT ?, json_extract(value, '$.d'), json_extract(value, '$.s') FROM json_each(?)").bind(chave, JSON.stringify(linhasOn)).run();
    dias = linhasXp.length;
    ate = linhasXp.map(x => x.d).sort().pop() || '';
  } catch { /* sem o MediviaGeeks: fica só a nossa coleta */ }
  try {
    const rt = await pedirFora(THINGS + 'characters/search?name=' + encodeURIComponent(nome));
    const ch = rt.ok ? ((await rt.json()).character || {}) : {};
    const sk = ch.skills;
    if (ch.name) { const p = guardarPerfil(db, [{ c: chave, v: ch.vocation || null, l: Number(ch.level) || null, e: Math.floor((Date.parse(ch.lastLoginAt) || 0) / 1000) || null }]); if (p) await p.run(); }
    const lista = Object.entries(sk || {}).filter(([k, v]) => /^(maglevel|melee|distance|blocking|fishing|mining|cooking)$/.test(k) && Number(v) > 0).map(([k, v]) => ({ k, v: Number(v) }));
    // OR IGNORE: o que o nosso ranking já guardou vale mais
    if (lista.length) await db.prepare("INSERT OR IGNORE INTO skills (chave, skill, valor, quando) SELECT ?, json_extract(value, '$.k'), json_extract(value, '$.v'), ? FROM json_each(?)").bind(chave, agora(), JSON.stringify(lista)).run();
  } catch { /* sem o MediviaThings: as skills chegam pelo nosso ranking */ }
  await db.prepare('INSERT OR REPLACE INTO importados (chave, quando, ate, dias) VALUES (?, ?, ?, ?)').bind(chave, agora(), ate, dias).run();
}

/* ---------- Guilda ---------- */
const IMPORTA_POR_VEZ = 3;   // cada importação faz 3 pedidos e uns 5 ao banco: 3 por vez cabem nos 50 por execução
// Resposta da API com o mesmo cache das rotas abertas (vale o tempo que a API indicou; reserva de um dia para o 429)
async function apiCache(env, ctx, rota) {
  const cache = caches.default;
  const chave = new Request('https://api.medivialabs.com/cache/' + encodeURIComponent(rota.toLowerCase()));
  const reserva = new Request('https://api.medivialabs.com/reserva/' + encodeURIComponent(rota.toLowerCase()));
  const guardada = await cache.match(chave);
  if (guardada) { try { return { ok: true, dados: await guardada.json() }; } catch { /* busca de novo */ } }
  const r = await pedir(env, rota);
  if (!r.ok) {
    const velha = r.status === 429 || r.status >= 500 ? await cache.match(reserva) : null;
    if (velha) { try { return { ok: true, dados: await velha.json() }; } catch { /* sem reserva */ } }
    return { ok: false, status: r.status };
  }
  const corpo = await r.text();
  let dados;
  try { dados = JSON.parse(corpo); } catch { return { ok: false, status: 502 }; }
  const vale = Math.max(30, Math.min(3600, Number(dados.cached_for) || 300));
  ctx.waitUntil(cache.put(chave, new Response(corpo, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + vale } })));
  ctx.waitUntil(cache.put(reserva, new Response(corpo, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } })));
  return { ok: true, dados };
}
async function guilda(env, ctx, mundo, nome, cors) {
  const db = env.DB;
  if (!db) return json({ erro: 'coleta ainda não ligada' }, 503, cors);
  await preparar(db);
  const g = await apiCache(env, ctx, 'guilds/' + mundo);
  if (!g.ok) return json({ erro: g.status === 429 ? 'a API do Medivia pediu um tempo; tente de novo em instantes' : 'a API do Medivia respondeu ' + g.status }, g.status === 429 ? 429 : 502, cors);
  const gu = (g.dados.guilds || []).find(x => chaveNome(x.name) === chaveNome(nome));
  if (!gu) return json({ erro: 'não encontrada' }, 404, cors);
  const membros = (gu.members || []).map(m => ({ nome: m.name, chave: chaveNome(m.name), rank: m.rank || '', nick: m.nick || '' }));
  const lista = JSON.stringify(membros.map(m => ({ c: m.chave, n: m.nome })));
  const dentro = "(SELECT json_extract(value, '$.c') FROM json_each(?))";
  // quem é da guilda passa a ser acompanhado (XP a cada logout)
  await db.prepare("INSERT OR IGNORE INTO personagens (chave, nome, mundo, desde, visto) SELECT json_extract(value, '$.c'), json_extract(value, '$.n'), ?, ?, ? FROM json_each(?)").bind(mundo, agora(), agora(), lista).run();
  // histórico que já existe: poucos membros por vez
  const ja = new Set(((await db.prepare('SELECT chave FROM importados WHERE chave IN ' + dentro).bind(lista).all()).results || []).map(x => x.chave));
  const pendentes = membros.filter(m => !ja.has(m.chave));
  for (const m of pendentes.slice(0, IMPORTA_POR_VEZ)) await importar(db, m.chave, m.nome);
  const faltam = Math.max(0, pendentes.length - IMPORTA_POR_VEZ);
  // quem está online agora no mundo (a lista da API vale para qualquer mundo, não só os da coleta)
  const on = await apiCache(env, ctx, 'online/' + mundo);
  const online = new Map(((on.ok && on.dados.players) || []).map(p => [chaveNome(p.name), p]));
  const t = agora(), desde = t - 32 * 86400, diaDesde = diaBr(desde);
  const todos = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];
  const [perfis, pontos, ultimos, imps, xpImp, impNivel, sess, agoraOn] = await Promise.all([
    todos('SELECT chave, vocacao, nivel, ultimo_login FROM perfil WHERE chave IN ' + dentro, lista),
    todos('SELECT chave, quando, nivel, experiencia FROM xp WHERE quando >= ? AND chave IN ' + dentro + ' ORDER BY quando', desde, lista),
    todos('SELECT chave, nivel, MAX(quando) AS quando FROM xp WHERE chave IN ' + dentro + ' GROUP BY chave', lista),
    todos('SELECT chave, ate FROM importados WHERE chave IN ' + dentro, lista),
    todos('SELECT chave, dia, ganho FROM xp_importado WHERE dia >= ? AND chave IN ' + dentro, diaDesde, lista),
    todos('SELECT chave, nivel, MAX(dia) AS dia FROM xp_importado WHERE chave IN ' + dentro + ' GROUP BY chave', lista),
    todos('SELECT chave, MAX(entrou) AS entrou FROM sessoes WHERE chave IN ' + dentro + ' GROUP BY chave', lista),
    todos('SELECT chave, entrou FROM online_agora WHERE chave IN ' + dentro, lista),
  ]);
  const por = (rows, k = 'chave') => new Map(rows.map(r => [r[k], r]));
  const perfil = por(perfis), ultimo = por(ultimos), imp = por(imps), nivImp = por(impNivel), sessao = por(sess), onAgora = por(agoraOn);
  const hoje = diaBr(t), ontem = diaBr(t - 86400), de7 = diaBr(t - 6 * 86400), de30 = diaBr(t - 29 * 86400);
  const saida = membros.map(m => {
    // XP por dia: o importado até o último dia de lá; dali para frente, o nosso (último valor do dia menos o do dia anterior)
    const dias = new Map();
    for (const x of xpImp) if (x.chave === m.chave) dias.set(x.dia, x.ganho);
    const limite = (imp.get(m.chave) || {}).ate || '';
    const fim = new Map(), ini = new Map();
    for (const p of pontos) if (p.chave === m.chave) { const d = diaBr(p.quando); if (!ini.has(d)) ini.set(d, p.experiencia); fim.set(d, p.experiencia); }
    [...fim.keys()].sort().forEach((d, i, a) => { if (d > limite || !dias.has(d)) dias.set(d, i ? fim.get(d) - fim.get(a[i - 1]) : fim.get(d) - ini.get(d)); });
    const soma = de => { let v = 0; for (const [d, g] of dias) if (d >= de && d <= hoje) v += g; return v; };
    const o = online.get(m.chave), pf = perfil.get(m.chave) || {};
    const nivel = o ? Number(o.level) : (ultimo.get(m.chave) || {}).nivel || pf.nivel || (nivImp.get(m.chave) || {}).nivel || null;
    const login = Math.max(pf.ultimo_login || 0, (sessao.get(m.chave) || {}).entrou || 0, (onAgora.get(m.chave) || {}).entrou || 0) || null;
    return { nome: m.nome, rank: m.rank, nick: m.nick, nivel, vocacao: (o && o.vocation) || pf.vocacao || null, online: !!o, ultimoLogin: login,
      xp: dias.size ? { ontem: dias.has(ontem) ? dias.get(ontem) : null, d7: soma(de7), d30: soma(de30) } : null };
  });
  return json({ guilda: { id: gu.id, nome: gu.name, mundo, criada: gu.created_at || null, descricao: gu.description || '' }, membros: saida, faltam },
    200, cors, { 'Cache-Control': faltam ? 'no-store' : 'public, max-age=60' });
}

/* ---------- Histórico de um personagem ---------- */
async function historico(env, nome, cors) {
  const db = env.DB;
  if (!db) return json({ erro: 'coleta ainda não ligada' }, 503, cors);
  await preparar(db);
  const chave = chaveNome(nome), desde = agora() - 1100 * 86400;   // até 3 anos de histórico (o importado vai até 2 anos)
  await importar(db, chave, nome);
  const pontos = (await db.prepare('SELECT quando, nivel, experiencia FROM xp WHERE chave = ? AND quando >= ? ORDER BY quando').bind(chave, desde).all()).results || [];
  const sess = (await db.prepare('SELECT entrou, saiu FROM sessoes WHERE chave = ? AND saiu >= ? ORDER BY entrou').bind(chave, desde).all()).results || [];
  const on = await db.prepare('SELECT entrou FROM online_agora WHERE chave = ?').bind(chave).first();
  const dia = s => new Date((s + BRASILIA) * 1000).toISOString().slice(0, 10);
  // XP: o último valor de cada dia; o ganho do dia é a diferença para o último valor do dia anterior guardado
  // (no primeiro dia guardado, o ganho é do primeiro ao último valor daquele dia)
  const fim = new Map(), ini = new Map();
  for (const p of pontos) { const d = dia(p.quando); if (!ini.has(d)) ini.set(d, p.experiencia); fim.set(d, { nivel: p.nivel, experiencia: p.experiencia }); }
  const dias = [...fim.entries()].map(([d, v], i, a) => ({ dia: d, nivel: v.nivel, experiencia: v.experiencia, ganho: i ? v.experiencia - a[i - 1][1].experiencia : v.experiencia - ini.get(d) }));
  // Tempo online: cada sessão dividida pelos dias de Brasília em que caiu (a sessão aberta conta até agora)
  const tempo = new Map();
  const somar = (comeco, fimS) => {
    for (let a = Math.max(comeco, desde); a < fimS;) {
      const meiaNoite = (Math.floor((a + BRASILIA) / 86400) + 1) * 86400 - BRASILIA, b = Math.min(fimS, meiaNoite);
      tempo.set(dia(a), (tempo.get(dia(a)) || 0) + (b - a));
      a = b;
    }
  };
  for (const s of sess) somar(s.entrou, s.saiu);
  if (on) somar(on.entrou, agora());
  const acompanhado = !!(await db.prepare('SELECT 1 AS x FROM personagens WHERE chave = ?').bind(chave).first());
  const imp = await db.prepare('SELECT ate, dias FROM importados WHERE chave = ?').bind(chave).first();
  const diaDesde = dia(desde);
  const xpImp = (await db.prepare('SELECT dia, nivel, ganho FROM xp_importado WHERE chave = ? AND dia >= ? ORDER BY dia').bind(chave, diaDesde).all()).results || [];
  const onImp = (await db.prepare('SELECT dia, segundos FROM online_importado WHERE chave = ? AND dia >= ?').bind(chave, diaDesde).all()).results || [];
  // até o último dia importado vale o de lá (o nosso primeiro dia é parcial); depois, o nosso
  const limite = imp && imp.ate ? imp.ate : '';
  const juntos = new Map(xpImp.map(x => [x.dia, { dia: x.dia, nivel: x.nivel, experiencia: null, ganho: x.ganho }]));
  for (const d of dias) if (d.dia > limite || !juntos.has(d.dia)) juntos.set(d.dia, d);
  dias.splice(0, dias.length, ...[...juntos.values()].sort((a, b) => (a.dia < b.dia ? -1 : 1)));
  // tempo online: até o último dia importado vale o de lá; nos dias seguintes, o maior dos dois (a nossa coleta começa
  // no meio do dia em que o personagem é aberto pela primeira vez)
  for (const o of onImp) if (o.dia <= limite || !tempo.has(o.dia) || o.segundos > tempo.get(o.dia)) tempo.set(o.dia, o.segundos);
  const sk = (await db.prepare('SELECT skill, valor, quando FROM skills WHERE chave = ?').bind(chave).all()).results || [];
  const skills = Object.fromEntries(sk.map(x => [x.skill, { valor: x.valor, quando: x.quando }]));
  return json({ nome, acompanhado, online: !!on, skills, importado: imp && imp.dias ? { de: 'MediviaGeeks', ate: imp.ate } : null, xp: dias, online_por_dia: [...tempo.entries()].sort().map(([d, s]) => ({ dia: d, segundos: s })) }, 200, cors, { 'Cache-Control': 'public, max-age=60' });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origem = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ORIGENS.includes(origem) ? origem : ORIGENS[0], 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method === 'POST' && url.pathname === '/kofi') return receberKofi(req, env);
    if (req.method === 'POST' && url.pathname === '/apoio') return contarApoio(req, env, origem);
    if (req.method !== 'GET') return json({ erro: 'só leitura' }, 405, cors);
    if (url.pathname === '/painel/apoio') return painelApoio(req, env, cors);

    let rota;
    try { rota = decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, ''); } catch { return json({ erro: 'endereço inválido' }, 400, cors); }

    // Teste do login: consulta quem está online em Pendulum e diz só se a API aceitou a conta
    if (rota === 'teste') {
      if (!env.MEDIVIA_USUARIO || !env.MEDIVIA_SENHA) return json({ ok: false, motivo: 'faltam os segredos MEDIVIA_USUARIO e MEDIVIA_SENHA' }, 200, cors);
      const r = await pedir(env, 'online/pendulum');
      return json({ ok: r.ok, status: r.status, motivo: r.ok ? 'login aceito pela API' : r.status === 401 ? 'a API recusou o login (usuário ou senha)' : 'a API respondeu com erro', coleta: env.DB ? 'banco ligado' : 'banco D1 ainda não ligado' }, 200, cors);
    }
    if (rota === 'coleta') {
      if (!env.DB) return json({ erro: 'banco D1 não ligado' }, 200, cors);
      await preparar(env.DB);
      const e = await env.DB.prepare('SELECT valor FROM estado WHERE chave = ?').bind('ultima_coleta').first();
      const n = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM online_agora) AS online, (SELECT COUNT(*) FROM sessoes) AS sessoes, (SELECT COUNT(*) FROM xp) AS xp, (SELECT COUNT(*) FROM personagens) AS acompanhados, (SELECT COUNT(*) FROM fila) AS fila, (SELECT COUNT(*) FROM skills) AS skills').first();
      return json({ ultima: e ? JSON.parse(e.valor) : 'a coleta agendada ainda não rodou nenhuma vez', totais: n }, 200, cors);
    }
    const gm = rota.match(new RegExp('^guilda\\/(' + MUNDO + ')\\/([^/]{2,60})$'));
    if (gm) return guilda(env, ctx, gm[1], gm[2], cors);
    const hist = rota.match(/^historico\/([^/]{2,40})$/);
    if (hist) return historico(env, hist[1], cors);
    if (!ROTAS.some(r => r.test(rota))) return json({ erro: 'endereço desconhecido' }, 404, cors);

    // Resposta guardada: vale pelo tempo que a própria API indicou; uma cópia de reserva vale um dia (para o 429)
    const cache = caches.default;
    const chave = new Request('https://api.medivialabs.com/cache/' + encodeURIComponent(rota.toLowerCase()));
    const reserva = new Request('https://api.medivialabs.com/reserva/' + encodeURIComponent(rota.toLowerCase()));
    let res = await cache.match(chave);
    // Ficha vinda do cache: o personagem também passa a ser acompanhado (sem gravar nada se já era)
    if (res && env.DB && rota.startsWith('player/')) {
      const nome = rota.slice(7);
      ctx.waitUntil(preparar(env.DB).then(() => env.DB.prepare('INSERT OR IGNORE INTO personagens (chave, nome, mundo, desde, visto) VALUES (?, ?, ?, ?, ?)').bind(chaveNome(nome), nome, '', agora(), agora()).run()).catch(() => {}));
    }
    if (!res) {
      const r = await pedir(env, rota);
      if (!r.ok) {
        const velha = r.status === 429 || r.status >= 500 ? await cache.match(reserva) : null;
        if (velha) res = velha;
        else return json({ erro: r.status === 404 ? 'não encontrado' : r.status === 429 ? 'a API do Medivia pediu um tempo; tente de novo em instantes' : 'a API do Medivia respondeu ' + r.status }, r.status === 404 ? 404 : r.status === 429 ? 429 : 502, cors);
      } else {
        const corpo = await r.text();
        let vale = 300, dados = null;
        try { dados = JSON.parse(corpo); vale = Math.max(30, Math.min(3600, Number(dados.cached_for) || 300)); } catch { return json({ erro: 'a API do Medivia mandou algo que não é JSON' }, 502, cors); }
        res = new Response(corpo, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + vale } });
        ctx.waitUntil(cache.put(chave, res.clone()));
        ctx.waitUntil(cache.put(reserva, new Response(corpo, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } })));
        // Quem abre um personagem no site passa a ser acompanhado: a coleta guarda o XP dele a cada logout
        if (env.DB && rota.startsWith('player/') && dados && dados.player) {
          const p = dados.player;
          ctx.waitUntil((async () => {
            await preparar(env.DB);
            await env.DB.prepare('INSERT INTO personagens (chave, nome, mundo, desde, visto) VALUES (?, ?, ?, ?, ?) ON CONFLICT(chave) DO UPDATE SET nome = excluded.nome, mundo = excluded.mundo, visto = excluded.visto')
              .bind(chaveNome(p.name), p.name, String(p.world || '').toLowerCase(), agora(), agora()).run();
            await guardarXp(env.DB, [p], 'consulta');
            const pf = guardarPerfil(env.DB, [{ c: chaveNome(p.name), v: p.vocation || null, l: Number(p.level) || null, e: null }]);
            if (pf) await pf.run();
          })().catch(() => {}));
        }
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(coletarComRegistro(env));
  },
};

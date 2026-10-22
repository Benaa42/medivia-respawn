// Ponte entre o Medivia Labs e a API oficial do Medivia (https://medivia.online/api/public/).
// Roda como Cloudflare Worker no endereço api.medivialabs.com. A API pede login (Basic Auth) com uma conta do jogo:
// o usuário e a senha ficam como SEGREDOS do Worker (MEDIVIA_USUARIO e MEDIVIA_SENHA), colocados no painel da
// Cloudflare, e nunca aparecem neste código, no site nem no GitHub. Quem visita o site não informa senha nenhuma.
//
// Endereços (os mesmos da API, só leitura):
//   /player/{nome}   /online/{mundo}   /highscores/{mundo}/{vocação}/{skill}/{página}   /guilds/{mundo}   /houses/{mundo}
//   /historico/{nome}   XP e tempo online por dia (horário de Brasília) e as skills dos rankings, do que a coleta guardou
//   /coleta             quando a coleta rodou pela última vez, o que fez ou o erro, e os totais do banco
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
    const lista = ((await r.json()).players || []).map(p => ({ chave: chaveNome(p.name), nome: p.name, entrou: Number(p.timestamp) || 0, nivel: p.level }));
    // A lista vai num texto JSON só. Quem não está mais nela (ou entrou de novo, com outra hora de entrada) fecha a
    // sessão; se for acompanhado, entra na fila da ficha. Quem é novo entra em online_agora. Quatro consultas por mundo.
    const dados = JSON.stringify(lista.map(p => ({ k: p.chave + '@' + p.entrou, c: p.chave, n: p.nome, e: p.entrou, l: p.nivel })));
    const fora = "o.mundo = ? AND (o.chave || '@' || o.entrou) NOT IN (SELECT json_extract(value, '$.k') FROM json_each(?))";
    await db.batch([
      db.prepare('INSERT INTO sessoes (chave, mundo, entrou, saiu, nivel) SELECT o.chave, o.mundo, o.entrou, ?, o.nivel FROM online_agora o WHERE ' + fora).bind(t, mundo, dados),
      db.prepare('INSERT OR IGNORE INTO fila (chave, nome, pedido) SELECT o.chave, o.nome, ? FROM online_agora o JOIN personagens p ON p.chave = o.chave WHERE ' + fora).bind(t, mundo, dados),
      db.prepare('DELETE FROM online_agora AS o WHERE ' + fora).bind(mundo, dados),
      db.prepare("INSERT OR IGNORE INTO online_agora (mundo, chave, nome, entrou, nivel) SELECT ?, json_extract(value, '$.c'), json_extract(value, '$.n'), json_extract(value, '$.e'), json_extract(value, '$.l') FROM json_each(?)").bind(mundo, dados),
    ]);
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

/* ---------- Histórico de um personagem ---------- */
async function historico(env, nome, cors) {
  const db = env.DB;
  if (!db) return json({ erro: 'coleta ainda não ligada' }, 503, cors);
  await preparar(db);
  const chave = chaveNome(nome), desde = agora() - 181 * 86400;
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
  const sk = (await db.prepare('SELECT skill, valor, quando FROM skills WHERE chave = ?').bind(chave).all()).results || [];
  const skills = Object.fromEntries(sk.map(x => [x.skill, { valor: x.valor, quando: x.quando }]));
  return json({ nome, acompanhado, online: !!on, skills, xp: dias, online_por_dia: [...tempo.entries()].sort().map(([d, s]) => ({ dia: d, segundos: s })) }, 200, cors, { 'Cache-Control': 'public, max-age=60' });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origem = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ORIGENS.includes(origem) ? origem : ORIGENS[0], 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'GET') return json({ erro: 'só leitura' }, 405, cors);

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

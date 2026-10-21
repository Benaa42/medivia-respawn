// Ponte entre o Medivia Labs e a API oficial do Medivia (https://medivia.online/api/public/).
// Roda como Cloudflare Worker no endereço api.medivialabs.com. A API pede login (Basic Auth) com uma conta do jogo:
// o usuário e a senha ficam como SEGREDOS do Worker (MEDIVIA_USUARIO e MEDIVIA_SENHA), colocados no painel da
// Cloudflare, e nunca aparecem neste código, no site nem no GitHub. Quem visita o site não informa senha nenhuma.
//
// Endereços (os mesmos da API, só leitura):
//   /player/{nome}   /online/{mundo}   /highscores/{mundo}/{vocação}/{skill}/{página}   /guilds/{mundo}   /houses/{mundo}
//   /teste           confere se o login da conta do site funciona (não mostra usuário nem senha)
// Cada resposta da API diz por quanto tempo vale (cached_for). O Worker guarda a resposta por esse tempo e só volta
// a consultar a API depois dele, como a equipe do jogo pediu ("cache on your end and avoid polling too aggressively").

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

const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
const pedir = (env, rota) => fetch(API + rota.split('/').map(encodeURIComponent).join('/'), {
  headers: {
    Authorization: 'Basic ' + btoa(unescape(encodeURIComponent((env.MEDIVIA_USUARIO || '') + ':' + (env.MEDIVIA_SENHA || '')))),
    Accept: 'application/json',
    'User-Agent': 'MediviaLabs/1.0 (+https://medivialabs.com)',
  },
});

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
      return json({ ok: r.ok, status: r.status, motivo: r.ok ? 'login aceito pela API' : r.status === 401 ? 'a API recusou o login (usuário ou senha)' : 'a API respondeu com erro' }, 200, cors);
    }
    if (!ROTAS.some(r => r.test(rota))) return json({ erro: 'endereço desconhecido' }, 404, cors);

    // Resposta guardada: vale pelo tempo que a própria API indicou
    const cache = caches.default;
    const chave = new Request('https://api.medivialabs.com/cache/' + encodeURIComponent(rota.toLowerCase()));
    let res = await cache.match(chave);
    if (!res) {
      const r = await pedir(env, rota);
      if (!r.ok) return json({ erro: r.status === 404 ? 'não encontrado' : 'a API do Medivia respondeu ' + r.status }, r.status === 404 ? 404 : 502, cors);
      const corpo = await r.text();
      let vale = 300;
      try { const j = JSON.parse(corpo); vale = Math.max(30, Math.min(3600, Number(j.cached_for) || 300)); } catch { return json({ erro: 'a API do Medivia mandou algo que não é JSON' }, 502, cors); }
      res = new Response(corpo, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=' + vale } });
      ctx.waitUntil(cache.put(chave, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

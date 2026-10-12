// Prepara as imagens dos itens para o site: lê os originais de Images/ (como vieram da wiki) e grava as cópias
// publicadas em img/, com nome simples e a extensão do formato real do arquivo.
//   node ferramentas/preparar-imagens.js
// Os originais têm espaço, apóstrofo e extensão que nem sempre bate com o conteúdo (muito .png é WebP por dentro).
// No fim, mostra as skins da tabela de goblets que ficaram sem imagem e a lista SKIN_EXT para colar no page.html.
// Os itens lendários (Images/Legendary) vão para img/legendary/ do mesmo jeito, com a lista LEGEND_EXT.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const from = path.join(root, 'Images'), to = path.join(root, 'img');

// As mesmas regras do page.html: skinKey compara nomes, itemSlug dá o nome do arquivo.
const skinKey = name => name.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean).map(w => w.length > 3 ? w.replace(/s$/, '') : w).join(' ');
const itemSlug = name => name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function kind(file) {
  const b = fs.readFileSync(file);
  if (b.slice(1, 4).toString() === 'PNG') return 'png';
  if (b.slice(0, 3).toString() === 'GIF') return 'gif';
  if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'webp';
  throw new Error('formato desconhecido: ' + file);
}

// Nomes oficiais das skins, tirados da tabela de trocas do page.html
const page = fs.readFileSync(path.join(root, 'page.html'), 'utf8');
const rates = /const GOBLET_RATES = \{([\s\S]*?)\n\};/.exec(page);
if (!rates) throw new Error('não achei GOBLET_RATES no page.html');
const names = new Map();
for (const m of rates[1].matchAll(/(?:^|[|'])\d+ ((?:[^|']|\\')+?) \d+(?=[|'])/g)) { const n = m[1].replace(/\\'/g, "'"); names.set(skinKey(n), n); }

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(path.join(to, 'skins'), { recursive: true });

const ext = {}, seen = new Set(), extra = [];
for (const f of fs.readdirSync(path.join(from, 'Skins'))) {
  const src = path.join(from, 'Skins', f), name = names.get(skinKey(path.parse(f).name));
  if (!name) { extra.push(f); continue; }
  const k = kind(src);
  fs.copyFileSync(src, path.join(to, 'skins', itemSlug(name) + '.' + k));
  seen.add(skinKey(name));
  if (k !== 'webp') (ext[k] = ext[k] || []).push(name);
}
// Goblets e tokens: nome fixo, a extensão vem do conteúdo
const fixed = { 'Dark_Cursed_Soul_Goblet': 'goblet-cursed', 'Dark_Malevolent_Soul_Goblet': 'goblet-malevolent', 'Dark_Vile_Soul_Goblet': 'goblet-vile',
  'Silver_Elite_Token': 'token-silver', 'Golden_Elite_Token': 'token-golden', 'Crystal_Elite_Token': 'token-crystal' };
const others = [];
for (const f of fs.readdirSync(from)) {
  const src = path.join(from, f);
  if (fs.statSync(src).isDirectory()) continue;
  const out = fixed[path.parse(f).name];
  if (!out) { extra.push(f); continue; }
  const k = kind(src);
  fs.copyFileSync(src, path.join(to, out + '.' + k));
  others.push(out + '.' + k);
}

// Itens lendários (Images/Legendary): o nome do arquivo é o nome do item. Confere com a tabela LEGEND_ITEMS do page.html.
const legendExt = {}, legendSeen = new Set();
if (fs.existsSync(path.join(from, 'Legendary'))) {
  fs.mkdirSync(path.join(to, 'legendary'), { recursive: true });
  for (const f of fs.readdirSync(path.join(from, 'Legendary'))) {
    const src = path.join(from, 'Legendary', f), name = path.parse(f).name, k = kind(src);
    fs.copyFileSync(src, path.join(to, 'legendary', itemSlug(name) + '.' + k));
    legendSeen.add(itemSlug(name));
    if (k !== 'webp') (legendExt[k] = legendExt[k] || []).push(name);
  }
}
const legendBlock = /const LEGEND_ITEMS = `([\s\S]*?)`/.exec(page);
const legendNames = legendBlock ? legendBlock[1].split('\n').map(row => row.split('|')[0].trim()).filter(Boolean) : [];
const legendMissing = legendNames.filter(n => !legendSeen.has(itemSlug(n)));
console.log(`${legendSeen.size} itens lendários com imagem` + (legendNames.length ? ` de ${legendNames.length} na tabela` : ''));
if (legendMissing.length) console.log('Lendários sem imagem: ' + legendMissing.join(', '));
console.log('LEGEND_EXT = ' + JSON.stringify(Object.fromEntries(Object.entries(legendExt).map(([k, v]) => [k, v.sort().join('|')]))));

const missing = [...names].filter(([k]) => !seen.has(k)).map(([, n]) => n);
console.log(`${seen.size} de ${names.size} skins com imagem; goblets e tokens: ${others.join(', ')}`);
if (missing.length) console.log('Sem imagem: ' + missing.join(', '));
if (extra.length) console.log('Imagem sem uso: ' + extra.join(', '));
console.log('SKIN_EXT = ' + JSON.stringify(Object.fromEntries(Object.entries(ext).map(([k, v]) => [k, v.sort().join('|')]))));

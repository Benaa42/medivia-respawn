// Gera os PNG do ícone do site a partir dos SVG da marca: favicon.png (48 px, fundo transparente) e
// apple-touch-icon.png (180 px, com o fundo escuro do site, porque o iPhone não aceita transparência).
// Usa o Chrome instalado, por meio do puppeteer-core; rode de uma pasta que tenha esse pacote, passando a do site:
//   node gerar-icones.mjs "C:\caminho\do\site"
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const site = path.resolve(process.argv[2] || '.');
const svg = nome => fs.readFileSync(path.join(site, nome), 'utf8');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
async function png(arquivo, lado, html, fundo) {
  await page.setViewport({ width: lado, height: lado, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0;background:${fundo || 'transparent'};display:grid;place-items:center;width:${lado}px;height:${lado}px">${html}</body>`);
  await page.screenshot({ path: path.join(site, arquivo), omitBackground: !fundo, clip: { x: 0, y: 0, width: lado, height: lado } });
  console.log(arquivo, lado + ' px');
}
const medida = (s, lado) => s.replace('<svg ', `<svg width="${lado}" height="${lado}" `);
await png('favicon.png', 48, medida(svg('favicon.svg'), 48));
await png('apple-touch-icon.png', 180, medida(svg('logo.svg'), 136), '#0f1314');
await browser.close();

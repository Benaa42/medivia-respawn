// Monta a figura animada (PNG animado, 32 x 32) de um item a partir de uma gravação de tela dele no jogo.
//   node ferramentas/animar-sprite.js quadros.rgb 62 62 "Images/Exclusive/Necromantic Backpack.png"
// A wiki não tinha a figura da Necromantic Backpack, então ela veio de um vídeo curto do item na mochila.
// Entrada: os quadros do vídeo em RGB cru (ffmpeg -i video.mp4 -f image2pipe -c:v rawvideo -pix_fmt rgb24 quadros.rgb)
// e a largura e a altura deles. O script acha quando a imagem troca, descobre de quantos desenhos é a animação,
// tira a média dos quadros de cada desenho (o vídeo é comprimido e treme um pouco), reduz para 32 x 32 e grava.
const fs = require('fs');
const zlib = require('zlib');
const [raw, wArg, hArg, out] = process.argv.slice(2);
const W = +wArg, H = +hArg, SIZE = 32;
const data = fs.readFileSync(raw), S = W * H * 3, n = Math.floor(data.length / S);
const diff = (i, j) => { let d = 0; for (let k = 0; k < S; k++) d += Math.abs(data[i * S + k] - data[j * S + k]); return d / S; };

// Quadros em que a imagem troca
const cuts = [];
for (let i = 1; i < n; i++) if (diff(i, i - 1) > 1) cuts.push(i);
// Duração do ciclo, em quadros: o deslocamento em que o vídeo mais se parece com ele mesmo
let period = 0, best = Infinity;
for (let p = 8; p <= 150; p++) {
  let d = 0, c = 0;
  for (let i = 30; i + p < n; i += 3) { d += diff(i, i + p); c++; }
  if (c && d / c < best * 0.85) { best = d / c; period = p; }   // só troca por um período maior se for bem melhor
}
// Quantos desenhos cabem num ciclo: as trocas dentro de um período, contadas num trecho já estável do vídeo
const from = cuts.findIndex(c => c >= Math.min(60, n / 4));
const steps = cuts.filter(c => c >= cuts[from] && c < cuts[from] + period).length;
console.log(`${n} quadros de ${W}x${H}; ciclo de ${period} quadros com ${steps} desenhos (${Math.round(period / steps * 1000 / 30)} ms cada)`);

// Média de cada desenho ao longo dos ciclos (sem o primeiro quadro depois da troca, que pode vir misturado)
const frames = [];
for (let k = 0; k < steps; k++) {
  const sum = new Float64Array(S);
  let count = 0;
  for (let c = from + k; c + 1 < cuts.length; c += steps) {
    for (let f = cuts[c] + 1; f < cuts[c + 1]; f++) { for (let i = 0; i < S; i++) sum[i] += data[f * S + i]; count++; }
  }
  if (!count) throw new Error('desenho ' + k + ' sem quadros');
  // Redução para 32 x 32 pela média da área de cada pixel de destino
  const small = Buffer.alloc(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const x0 = x * W / SIZE, x1 = (x + 1) * W / SIZE, y0 = y * H / SIZE, y1 = (y + 1) * H / SIZE;
    const acc = [0, 0, 0];
    let area = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
      const a = (Math.min(x1, xx + 1) - Math.max(x0, xx)) * (Math.min(y1, yy + 1) - Math.max(y0, yy));
      for (let ch = 0; ch < 3; ch++) acc[ch] += sum[(yy * W + xx) * 3 + ch] / count * a;
      area += a;
    }
    for (let ch = 0; ch < 3; ch++) small[(y * SIZE + x) * 3 + ch] = Math.round(acc[ch] / area);
  }
  frames.push(small);
}

// PNG animado (APNG): cabeçalho, controle da animação e, para cada desenho, o controle do quadro e os dados
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};
const pixels = f => {   // cada linha começa com o byte do filtro (0 = sem filtro)
  const rows = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  for (let y = 0; y < SIZE; y++) f.copy(rows, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
  return zlib.deflateSync(rows, { level: 9 });
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8 bits por canal, RGB
const actl = Buffer.alloc(8);
actl.writeUInt32BE(frames.length, 0);   // repete sem parar (o segundo número fica 0)
const ms = Math.round(period / steps * 1000 / 30);
const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('acTL', actl)];
let seq = 0;
frames.forEach((f, i) => {
  const fctl = Buffer.alloc(26);
  fctl.writeUInt32BE(seq++, 0); fctl.writeUInt32BE(SIZE, 4); fctl.writeUInt32BE(SIZE, 8);
  fctl.writeUInt16BE(ms, 20); fctl.writeUInt16BE(1000, 22);   // tempo do desenho: ms / 1000 de segundo
  parts.push(chunk('fcTL', fctl));
  if (!i) parts.push(chunk('IDAT', pixels(f)));
  else { const s = Buffer.alloc(4); s.writeUInt32BE(seq++, 0); parts.push(chunk('fdAT', Buffer.concat([s, pixels(f)]))); }
});
parts.push(chunk('IEND', Buffer.alloc(0)));
fs.writeFileSync(out, Buffer.concat(parts));
console.log('gravado ' + out + ' (' + fs.statSync(out).size + ' bytes)');

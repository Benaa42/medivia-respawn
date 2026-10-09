// Prepara os áudios de alerta para o site: mono, 16 bits, sem silêncio nas pontas e com volume parecido entre eles.
// Os originais ficam em sons-originais/ (fora do Git); o site usa as cópias convertidas em sounds/.
// Uso: node ferramentas/converter-sons.js   (ou informe <pasta de origem> <pasta de destino>)
// Para um som novo: ponha o .wav em sons-originais/, acrescente-o em NAMES aqui e em TONES e nos textos do page.html.
const fs = require('fs');
const path = require('path');
const [src = path.join(__dirname, '..', 'sons-originais'), dst = path.join(__dirname, '..', 'sounds')] = process.argv.slice(2);
const NAMES = {
  'Drag1.wav': 'drag1', 'Drag2.wav': 'drag2', 'DreadLord.wav': 'dreadlord', 'Hydra.wav': 'hydra', 'evil_whoosh_7.wav': 'whoosh',
  'heartbeat.wav': 'heartbeat', 'level_up.wav': 'levelup', 'mana_full.wav': 'manafull', 'message.wav': 'message',
};
const PEAK = 0.7, RMS = 0.14;   // teto do pico e do volume médio depois do ajuste

function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error('não é WAV: ' + file);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString('latin1', o, o + 4), sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(o + 8), ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, Math.min(b.length, o + 8 + sz));
    o += 8 + sz + (sz & 1);
  }
  if (!fmt || !data || fmt.tag !== 1 || fmt.bits !== 16) throw new Error('formato não previsto: ' + file + ' ' + JSON.stringify(fmt));
  const n = Math.floor(data.length / (2 * fmt.ch));
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.ch; c++) sum += data.readInt16LE((i * fmt.ch + c) * 2);
    mono[i] = sum / fmt.ch / 32768;
  }
  return { rate: fmt.rate, mono };
}

fs.mkdirSync(dst, { recursive: true });
for (const [from, to] of Object.entries(NAMES)) {
  const { rate, mono } = readWav(path.join(src, from));
  // Tira o silêncio do começo e do fim, deixando 10 ms de folga.
  const quiet = 0.003, pad = Math.round(rate * 0.01);
  let a = 0, z = mono.length - 1;
  while (a < z && Math.abs(mono[a]) < quiet) a++;
  while (z > a && Math.abs(mono[z]) < quiet) z--;
  a = Math.max(0, a - pad); z = Math.min(mono.length - 1, z + pad);
  const cut = mono.subarray(a, z + 1);
  let peak = 0, sq = 0;
  for (const v of cut) { peak = Math.max(peak, Math.abs(v)); sq += v * v; }
  const rms = Math.sqrt(sq / cut.length);
  const gain = Math.min(PEAK / peak, RMS / rms);
  const fade = Math.round(rate * 0.03);   // some sem estalo no fim
  const out = Buffer.alloc(44 + cut.length * 2);
  out.write('RIFF', 0, 'latin1'); out.writeUInt32LE(36 + cut.length * 2, 4); out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1'); out.writeUInt32LE(cut.length * 2, 40);
  for (let i = 0; i < cut.length; i++) {
    const tail = cut.length - 1 - i;
    const v = cut[i] * gain * (tail < fade ? tail / fade : 1);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  fs.writeFileSync(path.join(dst, to + '.wav'), out);
  console.log(to.padEnd(10), (cut.length / rate).toFixed(2) + ' s', 'pico ' + peak.toFixed(2), 'rms ' + rms.toFixed(3), 'ganho ' + gain.toFixed(2), Math.round(out.length / 1024) + ' KB');
}

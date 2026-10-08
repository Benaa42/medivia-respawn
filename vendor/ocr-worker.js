// O Tesseract pede o modelo de leitura como "eng.traineddata.gz". O servidor do site só
// entrega extensões conhecidas, então o mesmo arquivo é publicado como "eng-traineddata.wasm"
// e o pedido é redirecionado aqui, antes de carregar o worker original.
const realFetch = self.fetch.bind(self);
self.fetch = (url, opts) => realFetch(String(url).replace(/eng\.traineddata\.gz$/, 'eng-traineddata.wasm'), opts);
importScripts('worker.min.js');

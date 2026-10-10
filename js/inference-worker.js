// Worker d'inférence : charge MiDaS et exécute le modèle hors du fil principal, pour que la page
// reste fluide et qu'un calcul bloqué puisse être détecté puis relancé (voir inference.js).

import { DepthEstimator, downloadModel } from './depth.js';

let estimator = null;

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') await init(message);
    else if (message.type === 'run') await run(message);
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: message.id,
      message: (error && error.message) || String(error),
    });
  }
};

async function init({ modelUrl, ortUrl, wasmBase, backend, threads }) {
  const bytes = await downloadModel(modelUrl, (fraction) => {
    self.postMessage({ type: 'progress', stage: 'download', fraction });
  });
  self.postMessage({ type: 'progress', stage: 'prepare' });

  const ort = await import(ortUrl);
  ort.env.wasm.wasmPaths = wasmBase;
  // Le calcul multi-fil exige un contexte « cross-origin isolated » (voir sw.js).
  ort.env.wasm.numThreads = self.crossOriginIsolated ? threads : 1;

  estimator = await DepthEstimator.create(ort, bytes, [backend]);
  await estimator.selfTest();
  self.postMessage({ type: 'ready', threads: ort.env.wasm.numThreads });
}

async function run({ id, pixels, nearReference }) {
  const depth = await estimator.estimateFromRGBA(new Uint8ClampedArray(pixels), nearReference);
  // Copie : l'estimateur réutilise son tableau, et celui-ci est cédé au fil principal.
  const values = depth.values.slice();
  self.postMessage(
    {
      type: 'result',
      id,
      values,
      width: depth.width,
      height: depth.height,
      rawMin: depth.rawMin,
      rawMax: depth.rawMax,
      inferenceMs: estimator.lastInferenceMs,
    },
    [values.buffer],
  );
}

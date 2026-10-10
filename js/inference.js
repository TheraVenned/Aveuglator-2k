// Moteurs d'inférence et ordre de repli.
//
// Le modèle tourne de préférence dans un worker : la page ne se fige jamais, et un calcul bloqué
// se détecte par simple délai. En cas de blocage ou d'échec, on passe au moteur suivant du plan :
// WebGPU (si demandé) → WebAssembly multi-fil → WebAssembly un fil → fil principal.

import { DepthEstimator, downloadModel } from './depth.js';

const MODEL_URL = new URL('../models/midas_small_256.onnx', import.meta.url).href;
const ORT_BASE = new URL('../vendor/ort/', import.meta.url).href;
const WORKER_URL = new URL('./inference-worker.js', import.meta.url);

/** Silence maximal du worker pendant son initialisation (le téléchargement envoie des messages). */
const INIT_SILENCE_MS = 45000;
/** Délai maximal d'une inférence ; la première, qui amorce le moteur, a droit à davantage. */
const RUN_TIMEOUT_MS = 5000;
const FIRST_RUN_TIMEOUT_MS = 12000;

/** `kind` : 'hang' (délai dépassé), 'crash' (worker en erreur) ou 'init' (démarrage impossible). */
export class EngineError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
  }
}

function moduleUrl(backend) {
  return `${ORT_BASE}${backend === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`;
}

/** Moteur exécuté dans un worker dédié. */
export class WorkerEngine {
  constructor(backend, threads) {
    this.backend = backend;
    this.threads = threads;
    this.worker = null;
    this.pending = null;
    this.sequence = 0;
    this.hasRun = false;
    this.onMessage = null;
  }

  get label() {
    return this.backend === 'webgpu' ? 'WebGPU' : `WASM × ${this.threads}`;
  }

  /** `onProgress(stage, fraction)` : stage vaut 'download' ou 'prepare'. */
  init(onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (error) => {
        clearTimeout(timer);
        this.onMessage = null;
        if (error) {
          this.dispose();
          reject(error);
        } else {
          resolve();
        }
      };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => settle(new EngineError('Initialisation du moteur bloquée.', 'hang')), INIT_SILENCE_MS);
      };

      try {
        this.worker = new Worker(WORKER_URL, { type: 'module' });
      } catch (error) {
        reject(new EngineError(`Worker indisponible : ${error.message}`, 'init'));
        return;
      }
      this.worker.onerror = (event) => {
        const error = new EngineError(event.message || 'Le moteur de calcul a planté.', 'crash');
        if (this.onMessage) settle(error);
        else this.failPending(error);
      };
      this.worker.onmessage = (event) => {
        if (this.onMessage) this.onMessage(event.data);
        else this.handleResult(event.data);
      };
      this.onMessage = (message) => {
        arm();
        if (message.type === 'progress') {
          onProgress(message.stage, message.fraction);
        } else if (message.type === 'ready') {
          this.threads = message.threads;
          settle(null);
        } else if (message.type === 'error') {
          settle(new EngineError(message.message, 'init'));
        }
      };

      arm();
      this.worker.postMessage({
        type: 'init',
        modelUrl: MODEL_URL,
        ortUrl: moduleUrl(this.backend),
        wasmBase: ORT_BASE,
        backend: this.backend,
        threads: this.threads,
      });
    });
  }

  /** `pixels` : Uint8ClampedArray RGBA, cédé au worker (inutilisable ensuite côté appelant). */
  run(pixels, nearReference) {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new EngineError('Moteur arrêté.', 'crash'));
        return;
      }
      const id = ++this.sequence;
      const timeout = this.hasRun ? RUN_TIMEOUT_MS : FIRST_RUN_TIMEOUT_MS;
      const timer = setTimeout(() => this.failPending(new EngineError('Calcul bloqué.', 'hang')), timeout);
      this.pending = { id, resolve, reject, timer };
      this.worker.postMessage({ type: 'run', id, pixels: pixels.buffer, nearReference }, [pixels.buffer]);
    });
  }

  handleResult(message) {
    const pending = this.pending;
    if (!pending || message.id !== pending.id) return;
    clearTimeout(pending.timer);
    this.pending = null;
    if (message.type === 'result') {
      this.hasRun = true;
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.message));
    }
  }

  failPending(error) {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }

  dispose() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.failPending(new EngineError('Moteur arrêté.', 'crash'));
  }
}

/** Dernier recours : même calcul sur le fil principal, sur un seul fil, sans worker. */
export class LocalEngine {
  constructor() {
    this.estimator = null;
  }

  get label() {
    return 'WASM × 1 (page)';
  }

  async init(onProgress = () => {}) {
    const bytes = await downloadModel(MODEL_URL, (fraction) => onProgress('download', fraction));
    onProgress('prepare');
    const ort = await import(moduleUrl('wasm'));
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = 1;
    this.estimator = await DepthEstimator.create(ort, bytes, ['wasm']);
    await this.estimator.selfTest();
  }

  async run(pixels, nearReference) {
    const depth = await this.estimator.estimateFromRGBA(pixels, nearReference);
    return { ...depth, inferenceMs: this.estimator.lastInferenceMs };
  }

  dispose() {
    this.estimator = null;
  }
}

/**
 * Moteurs à essayer, du plus rapide au plus sûr.
 * @param webgpu l'utilisateur a demandé WebGPU et le navigateur l'expose
 * @param multiThread la page est isolée et le multi-fil n'a pas déjà échoué sur cet appareil
 * @param cores nombre de cœurs annoncé par le navigateur
 */
export function enginePlan({ webgpu, multiThread, cores }) {
  const plan = [];
  if (webgpu) plan.push({ kind: 'worker', backend: 'webgpu', threads: 1 });
  const threads = multiThread ? Math.min(4, cores || 2) : 1;
  if (threads > 1) plan.push({ kind: 'worker', backend: 'wasm', threads });
  plan.push({ kind: 'worker', backend: 'wasm', threads: 1 });
  plan.push({ kind: 'local', backend: 'wasm', threads: 1 });
  return plan;
}

export function createEngine(step) {
  return step.kind === 'local' ? new LocalEngine() : new WorkerEngine(step.backend, step.threads);
}

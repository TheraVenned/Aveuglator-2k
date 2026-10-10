// Estimation de profondeur MiDaS v2.1 Small (ONNX), exécutée dans le navigateur.

export const MODEL_SIZE = 256;

// Normalisation ImageNet attendue par MiDaS.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** Pixels RGBA (0-255) d'une image carrée → tenseur plan par plan (R, G, B) normalisé. */
export function toModelInput(rgba, size, out = new Float32Array(3 * size * size)) {
  const plane = size * size;
  for (let channel = 0; channel < 3; channel++) {
    const scale = 1 / (255 * STD[channel]);
    const offset = -MEAN[channel] / STD[channel];
    const base = channel * plane;
    for (let pixel = 0; pixel < plane; pixel++) {
      out[base + pixel] = rgba[pixel * 4 + channel] * scale + offset;
    }
  }
  return out;
}

/**
 * Ramène les valeurs brutes du modèle (profondeur inverse relative, élevée = proche) dans [0, 1].
 * L'étendue est lissée dans le temps pour que la carte ne « respire » pas d'une image à l'autre.
 */
export class DepthNormalizer {
  constructor(smoothing = 0.25) {
    this.smoothing = smoothing;
    this.reset();
  }

  reset() {
    this.low = null;
    this.high = null;
  }

  /**
   * `nearReference` : valeur brute minimale tenue pour « très proche ». À 0, la normalisation suit
   * uniquement l'étendue de chaque image ; une valeur calibrée évite qu'une scène entièrement
   * lointaine soit étirée jusqu'au rouge.
   */
  normalize(raw, nearReference = 0, out = new Float32Array(raw.length)) {
    let frameLow = Infinity;
    let frameHigh = -Infinity;
    for (let index = 0; index < raw.length; index++) {
      const value = raw[index];
      if (value < frameLow) frameLow = value;
      if (value > frameHigh) frameHigh = value;
    }
    if (!Number.isFinite(frameLow) || !Number.isFinite(frameHigh)) {
      throw new Error('Le modèle a produit des valeurs non finies.');
    }

    this.low = this.low === null ? frameLow : this.low + this.smoothing * (frameLow - this.low);
    this.high = this.high === null ? frameHigh : this.high + this.smoothing * (frameHigh - this.high);
    // Marge relative : une image uniforme ne doit pas provoquer de division par zéro.
    const margin = Math.max(1e-3, Math.abs(this.low) * 1e-3);
    const effectiveHigh = Math.max(this.high, nearReference, this.low + margin);

    const scale = 1 / (effectiveHigh - this.low);
    const offset = -this.low * scale;
    for (let index = 0; index < raw.length; index++) {
      const value = raw[index] * scale + offset;
      // Robuste aux NaN : toutes les comparaisons échouent et donnent 0.
      out[index] = value > 0 ? (value < 1 ? value : 1) : 0;
    }
    return { values: out, rawMin: frameLow, rawMax: frameHigh };
  }
}

export class DepthEstimator {
  /**
   * @param ort espace de noms onnxruntime-web déjà importé
   * @param model octets du fichier ONNX (Uint8Array)
   * @param executionProviders par exemple ['wasm'] ou ['webgpu']
   */
  static async create(ort, model, executionProviders = ['wasm']) {
    const session = await ort.InferenceSession.create(model, {
      executionProviders,
      graphOptimizationLevel: 'all',
    });
    return new DepthEstimator(ort, session);
  }

  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
    this.input = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
    this.normalized = new Float32Array(MODEL_SIZE * MODEL_SIZE);
    this.normalizer = new DepthNormalizer();
    this.canvas = null;
    this.context = null;
    /** Durée de la dernière inférence seule, en millisecondes. */
    this.lastInferenceMs = 0;
  }

  reset() {
    this.normalizer.reset();
  }

  /** Estime la profondeur d'une image vidéo. L'image entière est étirée vers l'entrée carrée. */
  async estimate(source, nearReference = 0) {
    if (!this.context) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = MODEL_SIZE;
      this.canvas.height = MODEL_SIZE;
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.context.drawImage(source, 0, 0, MODEL_SIZE, MODEL_SIZE);
    const rgba = this.context.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
    return this.estimateFromRGBA(rgba, nearReference);
  }

  /** `rgba` : pixels d'une image de MODEL_SIZE × MODEL_SIZE. */
  async estimateFromRGBA(rgba, nearReference = 0) {
    toModelInput(rgba, MODEL_SIZE, this.input);
    const tensor = new this.ort.Tensor('float32', this.input, [1, 3, MODEL_SIZE, MODEL_SIZE]);

    const start = performance.now();
    const outputs = await this.session.run({ [this.inputName]: tensor });
    this.lastInferenceMs = performance.now() - start;

    const output = outputs[this.outputName];
    const dims = output.dims;
    const height = Number(dims[dims.length - 2]);
    const width = Number(dims[dims.length - 1]);
    if (output.data.length !== width * height) {
      throw new Error(`Sortie du modèle inattendue : ${dims.join(' × ')}`);
    }
    if (this.normalized.length !== output.data.length) {
      this.normalized = new Float32Array(output.data.length);
    }
    const { values, rawMin, rawMax } = this.normalizer.normalize(output.data, nearReference, this.normalized);
    return { values, width, height, rawMin, rawMax };
  }

  async release() {
    await this.session.release();
  }
}

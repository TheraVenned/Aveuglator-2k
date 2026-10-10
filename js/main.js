// Aveuglator 2000 : caméra → profondeur (MiDaS) → analyse des zones → sons et
// vibrations, avec un mode diagnostic. Tout s'exécute dans le navigateur, sans serveur.

import { ObstacleAnalyzer, BANDS, SECTORS, Level, zoneIndex, zoneRect, alertMessage } from './analyzer.js';
import { DepthEstimator, MODEL_SIZE } from './depth.js';
import { renderHeatmap } from './heatmap.js';
import { FeedbackEngine } from './feedback.js';

const MODEL_URL = new URL('../models/midas_small_256.onnx', import.meta.url).href;
const ORT_BASE = new URL('../vendor/ort/', import.meta.url).href;
const SERVICE_WORKER_URL = new URL('../sw.js', import.meta.url).href;

const SETTINGS_KEY = 'aveuglator.settings.v1';
const RELOAD_FLAG = 'aveuglator.isolation-reload';
const SINGLE_THREAD_FLAG = 'aveuglator.single-thread';
/** Au-delà, l'initialisation du moteur d'inférence est considérée comme bloquée. */
const ENGINE_TIMEOUT_MS = 30000;
const DEFAULT_SETTINGS = {
  diagnostic: true,
  opacity: 0.55,
  sound: true,
  voice: true,
  vibration: true,
  volume: 0.8,
  sensitivity: 1,
  nearReference: 0,
  cameraId: '',
  webgpu: false,
};

const STALL_TIMEOUT_MS = 2500;
const LOW_FRAME_RATE = 4;
const FAILURE_LIMIT = 15;
const BAND_SYMBOLS = ['↑', '●', '↓'];

/** Levée quand un démarrage est rendu caduc par un arrêt ou un nouveau démarrage. */
const CANCELLED = Symbol('cancelled');

const byId = (id) => document.getElementById(id);
const elements = {
  stage: byId('stage'),
  video: byId('camera'),
  overlay: byId('overlay'),
  heatmap: byId('heatmap'),
  grid: byId('grid'),
  status: byId('status'),
  warning: byId('warning'),
  diagnostics: byId('diagnostics'),
  alert: byId('alert'),
  sectors: byId('sectors'),
  bandSymbol: byId('band-symbol'),
  toggle: byId('toggle'),
  diagnosticToggle: byId('diagnostic-toggle'),
  settingsOpen: byId('settings-open'),
  settings: byId('settings'),
  vibrationNote: byId('vibration-note'),
  fps: byId('d-fps'),
  inference: byId('d-inference'),
  total: byId('d-total'),
  raw: byId('d-raw'),
  backend: byId('d-backend'),
  vibration: byId('d-vibration'),
};

const settings = loadSettings();
const analyzer = new ObstacleAnalyzer();
const feedback = new FeedbackEngine();
const heatmapContext = elements.heatmap.getContext('2d');
const heatmapImage = heatmapContext.createImageData(MODEL_SIZE, MODEL_SIZE);
const zoneCells = buildGrid();

const state = {
  phase: 'stopped', // 'stopped' | 'starting' | 'running' | 'failed'
  // Intention de l'utilisateur : sert à reprendre la détection au retour au premier plan.
  shouldRun: false,
  // Incrémenté à chaque démarrage ou arrêt : invalide les boucles et chargements en cours.
  run: 0,
  stream: null,
  estimator: null,
  estimatorPromise: null,
  backendLabel: 'non chargé',
  wakeLock: null,
  lastFrameAt: 0,
  frameTimes: [],
  inferenceAverage: 0,
  totalAverage: 0,
  lowRateSince: null,
  lowRate: false,
  stalled: false,
  lastDiagnosticsAt: 0,
  shownAlert: undefined,
};

// --- Réglages ------------------------------------------------------------------------------------

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Stockage indisponible (navigation privée) : les réglages valent pour la session.
  }
}

function bindSettingsForm() {
  for (const input of elements.settings.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    writeInput(input, settings[key]);
    input.addEventListener('input', () => {
      settings[key] = readInput(input);
      saveSettings();
      settingChanged(key);
    });
  }
  refreshOutputs();
}

function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'range') return Number(input.value);
  return input.value;
}

function writeInput(input, value) {
  if (input.type === 'checkbox') input.checked = Boolean(value);
  else input.value = String(value);
}

function refreshOutputs() {
  for (const output of elements.settings.querySelectorAll('[data-output]')) {
    const value = settings[output.dataset.output];
    output.textContent = output.dataset.output === 'nearReference' ? value.toFixed(0) : value.toFixed(2);
  }
}

function settingChanged(key) {
  refreshOutputs();
  applySettings();
  if (key === 'cameraId' && isActive()) {
    restartCamera();
  } else if (key === 'webgpu') {
    // Un seul moteur d'inférence par page : on recharge pour repartir proprement.
    location.reload();
  }
}

function applySettings() {
  document.body.classList.toggle('diagnostic', settings.diagnostic);
  elements.diagnostics.hidden = !settings.diagnostic;
  elements.diagnosticToggle.textContent = settings.diagnostic ? 'Diagnostic activé' : 'Diagnostic désactivé';
  elements.diagnosticToggle.setAttribute('aria-pressed', String(settings.diagnostic));
  elements.heatmap.style.opacity = String(settings.opacity);
  elements.sectors.hidden = !(settings.diagnostic && state.phase === 'running');
  feedback.configure({
    sound: settings.sound,
    voice: settings.voice,
    vibration: settings.vibration,
    volume: settings.volume,
  });
  const diagnosticInput = elements.settings.querySelector('[data-setting="diagnostic"]');
  if (diagnosticInput) diagnosticInput.checked = settings.diagnostic;
}

// --- État et affichage ---------------------------------------------------------------------------

function isActive() {
  return state.phase === 'starting' || state.phase === 'running';
}

function setPhase(phase, statusText) {
  state.phase = phase;
  for (const name of ['stopped', 'starting', 'running', 'failed']) {
    document.body.classList.toggle(name, name === phase);
  }
  elements.status.textContent = statusText;
  elements.toggle.textContent = isActive() ? 'Arrêter la détection' : 'Démarrer la détection';
  elements.alert.hidden = phase !== 'running';
  elements.sectors.hidden = !(settings.diagnostic && phase === 'running');
  refreshWarning();
}

function setStartupStatus(run, text) {
  if (run === state.run && state.phase === 'starting') elements.status.textContent = text;
}

function refreshWarning() {
  let text = '';
  if (state.phase === 'running') {
    if (state.stalled) text = 'Aucune image reçue : la détection est suspendue.';
    else if (state.lowRate) text = "Cadence d'analyse faible : réactivité dégradée.";
  }
  elements.warning.textContent = text;
  elements.warning.hidden = text === '';
}

function buildGrid() {
  const cells = [];
  for (const band of BANDS) {
    for (const sector of SECTORS) {
      const rect = zoneRect(analyzer.config, band, sector);
      const cell = document.createElement('div');
      cell.className = 'zone';
      cell.dataset.sector = String(sector);
      cell.style.left = `${rect.x * 100}%`;
      cell.style.top = `${rect.y * 100}%`;
      cell.style.width = `${rect.width * 100}%`;
      cell.style.height = `${rect.height * 100}%`;
      const label = document.createElement('span');
      cell.appendChild(label);
      elements.grid.appendChild(cell);
      cells[zoneIndex(band, sector)] = { cell, label };
    }
  }
  return cells;
}

/** Cale les superpositions sur l'image vidéo telle qu'elle est recadrée par `object-fit: cover`. */
function layoutOverlay() {
  const { video, stage, overlay } = elements;
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.max(stage.clientWidth / video.videoWidth, stage.clientHeight / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlay.style.left = `${(stage.clientWidth - width) / 2}px`;
  overlay.style.top = `${(stage.clientHeight - height) / 2}px`;
}

function showAlert(alert) {
  const key = alert ? `${alert.band}:${alert.sector}:${alert.level}` : 'none';
  if (key === state.shownAlert) return;
  state.shownAlert = key;
  elements.alert.textContent = alert ? alertMessage(alert) : 'Voie dégagée';
  elements.alert.dataset.level = String(alert ? alert.level : Level.NONE);
  elements.bandSymbol.textContent = alert ? BAND_SYMBOLS[alert.band] : '✓';
  for (const sectorElement of elements.sectors.querySelectorAll('.sector')) {
    const isActiveSector = alert !== null && Number(sectorElement.dataset.sector) === alert.sector;
    sectorElement.classList.toggle('active', isActiveSector);
    sectorElement.dataset.level = String(isActiveSector ? alert.level : Level.NONE);
  }
}

/** Fait clignoter le secteur à chaque motif réellement joué. */
function flashSector(alert) {
  const sectorElement = elements.sectors.querySelector(`.sector[data-sector="${alert.sector}"]`);
  if (!sectorElement) return;
  sectorElement.classList.add('flash');
  setTimeout(() => sectorElement.classList.remove('flash'), 120);
}

function render(depth, result, now) {
  showAlert(result.primaryAlert);
  if (!settings.diagnostic) return;

  renderHeatmap(depth.values, heatmapImage.data);
  heatmapContext.putImageData(heatmapImage, 0, 0);

  const primary = result.primaryAlert;
  for (const band of BANDS) {
    for (const sector of SECTORS) {
      const index = zoneIndex(band, sector);
      const reading = result.zones[index];
      const { cell, label } = zoneCells[index];
      cell.dataset.level = String(reading.level);
      cell.classList.toggle('primary', primary !== null && primary.band === band && primary.sector === sector);
      label.textContent = reading.score.toFixed(2);
    }
  }

  // Les chiffres sont rafraîchis quatre fois par seconde pour rester lisibles.
  if (now - state.lastDiagnosticsAt < 250) return;
  state.lastDiagnosticsAt = now;
  elements.fps.textContent = currentFrameRate(now).toFixed(1);
  elements.inference.textContent = `${state.inferenceAverage.toFixed(1)} ms`;
  elements.total.textContent = `${state.totalAverage.toFixed(1)} ms`;
  elements.raw.textContent = `${depth.rawMin.toFixed(0)} à ${depth.rawMax.toFixed(0)}`;
}

function clearDisplay() {
  heatmapContext.clearRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  for (const { cell, label } of zoneCells) {
    cell.dataset.level = '0';
    cell.classList.remove('primary');
    label.textContent = '';
  }
  state.shownAlert = undefined;
  showAlert(null);
}

// --- Mesures -------------------------------------------------------------------------------------

function currentFrameRate(now) {
  const times = state.frameTimes;
  while (times.length > 0 && now - times[0] > 1000) times.shift();
  if (times.length < 2) return 0;
  return ((times.length - 1) * 1000) / (now - times[0]);
}

function recordFrame(started, finished) {
  state.lastFrameAt = finished;
  state.frameTimes.push(finished);
  const inference = state.estimator.lastInferenceMs;
  const total = finished - started;
  state.inferenceAverage = state.inferenceAverage === 0 ? inference : state.inferenceAverage * 0.9 + inference * 0.1;
  state.totalAverage = state.totalAverage === 0 ? total : state.totalAverage * 0.9 + total * 0.1;

  // Chute de cadence : signalée seulement si elle dure plus de trois secondes.
  const rate = currentFrameRate(finished);
  if (rate > 0 && rate < LOW_FRAME_RATE) {
    if (state.lowRateSince === null) state.lowRateSince = finished;
  } else if (rate >= LOW_FRAME_RATE + 1) {
    state.lowRateSince = null;
  }
  const lowRate = state.lowRateSince !== null && finished - state.lowRateSince > 3000;
  if (lowRate !== state.lowRate) {
    state.lowRate = lowRate;
    refreshWarning();
    if (lowRate) feedback.speak('Performances dégradées, la détection est ralentie.', { urgent: true, force: true });
  }
}

function resetMeasures() {
  state.frameTimes = [];
  state.inferenceAverage = 0;
  state.totalAverage = 0;
  state.lowRateSince = null;
  state.lowRate = false;
  state.stalled = false;
  state.lastDiagnosticsAt = 0;
  state.lastFrameAt = performance.now();
}

/**
 * Vérifie chaque seconde que des images sont bien analysées : une personne qui ne voit pas
 * l'écran doit être prévenue quand la détection n'est plus assurée.
 */
function watchFrameFlow() {
  if (state.phase !== 'running') return;
  const silent = performance.now() - state.lastFrameAt > STALL_TIMEOUT_MS;
  if (silent && !state.stalled) {
    state.stalled = true;
    feedback.update(null);
    feedback.notify('fault');
    feedback.speak("Attention, la caméra ne fournit plus d'images. Détection suspendue.", { urgent: true, force: true });
    refreshWarning();
  } else if (!silent && state.stalled) {
    state.stalled = false;
    feedback.speak('Détection rétablie.', { urgent: true, force: true });
    refreshWarning();
  }
}

// --- Caméra --------------------------------------------------------------------------------------

async function startCamera(run) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Caméra inaccessible : ouvrez le site en HTTPS dans Safari ou Chrome.');
  }
  stopCamera();

  const video = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (settings.cameraId) video.deviceId = { exact: settings.cameraId };
  else video.facingMode = { ideal: 'environment' };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (error) {
    if (settings.cameraId && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
      // La caméra mémorisée n'existe plus : retour au choix automatique.
      settings.cameraId = '';
      saveSettings();
      return startCamera(run);
    }
    throw error;
  }
  if (run !== state.run) {
    for (const track of stream.getTracks()) track.stop();
    throw CANCELLED;
  }

  // Un autre démarrage a pu aboutir entre-temps (changement de caméra) : on libère son flux.
  stopCamera();
  state.stream = stream;
  for (const track of stream.getVideoTracks()) {
    track.addEventListener('ended', () => {
      if (state.stream === stream && isActive()) fail("La caméra s'est arrêtée.");
    });
  }
  elements.video.srcObject = stream;
  await elements.video.play();
  layoutOverlay();
  refreshCameraList();
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state.stream = null;
  elements.video.srcObject = null;
}

async function restartCamera() {
  const run = state.run;
  try {
    await startCamera(run);
  } catch (error) {
    if (error !== CANCELLED && run === state.run) fail(describeError(error));
  }
}

/** Les noms des caméras ne sont lisibles qu'une fois l'autorisation accordée. */
async function refreshCameraList() {
  const select = elements.settings.querySelector('[data-setting="cameraId"]');
  if (!select || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    select.replaceChildren(new Option('Automatique', ''));
    cameras.forEach((camera, index) => {
      select.appendChild(new Option(camera.label || `Caméra ${index + 1}`, camera.deviceId));
    });
    select.value = cameras.some((camera) => camera.deviceId === settings.cameraId) ? settings.cameraId : '';
  } catch {
    // Liste indisponible : le choix automatique reste proposé.
  }
}

// --- Modèle --------------------------------------------------------------------------------------

function ensureEstimator(run) {
  if (!state.estimatorPromise) {
    state.estimatorPromise = createEstimator(run).catch((error) => {
      state.estimatorPromise = null;
      throw error;
    });
  }
  return state.estimatorPromise;
}

async function createEstimator(run) {
  const bytes = await downloadModel((fraction) => {
    setStartupStatus(run, `Téléchargement du modèle… ${Math.round(fraction * 100)} %`);
  });
  setStartupStatus(run, 'Préparation du modèle…');

  if (settings.webgpu && 'gpu' in navigator) {
    try {
      return await withTimeout(createEstimatorWith('webgpu', bytes, 1, ''), ENGINE_TIMEOUT_MS);
    } catch (error) {
      console.warn('WebGPU indisponible, retour au moteur standard.', error);
      settings.webgpu = false;
      saveSettings();
      const input = elements.settings.querySelector('[data-setting="webgpu"]');
      if (input) input.checked = false;
    }
  }

  const threads = preferredThreadCount();
  if (threads === 1) return createEstimatorWith('wasm', bytes, 1, '');
  try {
    return await withTimeout(createEstimatorWith('wasm', bytes, threads, ''), ENGINE_TIMEOUT_MS);
  } catch (error) {
    // Un moteur dont l'initialisation a échoué ne peut pas être relancé : on en importe une
    // copie neuve (adresse différente) et on calcule sur un seul fil, y compris les fois suivantes.
    console.warn('Calcul multi-fil indisponible, retour à un seul fil.', error);
    writeFlag(SINGLE_THREAD_FLAG);
    setStartupStatus(run, 'Préparation du modèle (mode compatible)…');
    return createEstimatorWith('wasm', bytes, 1, '?single-thread');
  }
}

/** Le calcul multi-fil exige une page « cross-origin isolated » (voir sw.js). */
function preferredThreadCount() {
  if (!self.crossOriginIsolated || readFlag(SINGLE_THREAD_FLAG)) return 1;
  return Math.min(4, navigator.hardwareConcurrency || 2);
}

function readFlag(key) {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeFlag(key) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    // Stockage indisponible : le repli sera simplement retenté au prochain lancement.
  }
}

function withTimeout(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Délai dépassé.')), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function createEstimatorWith(backend, bytes, threads, moduleSuffix) {
  const moduleName = backend === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs';
  const ort = await import(`${ORT_BASE}${moduleName}${moduleSuffix}`);
  ort.env.wasm.wasmPaths = ORT_BASE;
  ort.env.wasm.numThreads = threads;

  const estimator = await DepthEstimator.create(ort, bytes, [backend]);
  await selfTest(estimator);
  state.backendLabel = backend === 'webgpu' ? 'WebGPU' : `WASM × ${threads}`;
  elements.backend.textContent = state.backendLabel;
  return estimator;
}

/** Une inférence à blanc : écarte un moteur qui renverrait une sortie vide ou constante. */
async function selfTest(estimator) {
  const pixels = new Uint8ClampedArray(MODEL_SIZE * MODEL_SIZE * 4);
  for (let y = 0; y < MODEL_SIZE; y++) {
    for (let x = 0; x < MODEL_SIZE; x++) {
      const offset = (y * MODEL_SIZE + x) * 4;
      const shade = x > 90 && x < 170 && y > 60 && y < 200 ? 220 : 40 + (y >> 1);
      pixels[offset] = shade;
      pixels[offset + 1] = shade;
      pixels[offset + 2] = shade;
      pixels[offset + 3] = 255;
    }
  }
  const depth = await estimator.estimateFromRGBA(pixels);
  estimator.reset();
  if (!(depth.rawMax - depth.rawMin > 1)) {
    throw new Error('Le moteur renvoie une carte de profondeur vide.');
  }
}

async function downloadModel(onProgress) {
  const response = await fetch(MODEL_URL);
  if (!response.ok) throw new Error(`Modèle introuvable (HTTP ${response.status}).`);
  const total = Number(response.headers.get('Content-Length')) || 0;
  if (!response.body || total === 0) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(received / total, 0.99));
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// --- Cycle de vie --------------------------------------------------------------------------------

async function start() {
  if (isActive()) return;
  // À faire tout de suite, dans le geste de l'utilisateur : déverrouille le son et la voix.
  feedback.unlock();
  feedback.speak('Démarrage de la détection.', { urgent: true });

  state.shouldRun = true;
  const run = ++state.run;
  setPhase('starting', 'Démarrage de la détection…');

  try {
    const [, estimator] = await Promise.all([startCamera(run), ensureEstimator(run)]);
    if (run !== state.run) return;
    state.estimator = estimator;
  } catch (error) {
    if (error !== CANCELLED && run === state.run) fail(describeError(error));
    return;
  }

  state.estimator.reset();
  analyzer.reset();
  resetMeasures();
  clearDisplay();
  elements.backend.textContent = state.backendLabel;
  setPhase('running', 'Détection active');
  feedback.start();
  feedback.notify('started');
  feedback.speak('Détection active.', { urgent: true });
  acquireWakeLock();
  processFrames(run);
}

/** Arrêt demandé par l'utilisateur. */
function stop() {
  state.shouldRun = false;
  halt('Détection arrêtée');
  feedback.speak('Détection arrêtée.', { urgent: true });
}

function halt(statusText) {
  state.run += 1;
  stopCamera();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  setPhase('stopped', statusText);
}

function fail(message) {
  state.run += 1;
  stopCamera();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  setPhase('failed', `Erreur : ${message}`);
  feedback.notify('fault');
  feedback.speak(`Erreur. ${message}`, { urgent: true, force: true });
}

function describeError(error) {
  switch (error && error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'accès à la caméra refusé. Autorisez la caméra pour ce site dans les réglages du navigateur.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'aucune caméra utilisable sur cet appareil.';
    case 'NotReadableError':
    case 'AbortError':
      return 'la caméra est déjà utilisée par une autre application.';
    default:
      return (error && error.message) || 'erreur inconnue.';
  }
}

/** Résout à la prochaine image vidéo ; `false` si aucune image nouvelle n'est arrivée à temps. */
function nextVideoFrame(video, lastTime) {
  return new Promise((resolve) => {
    if (typeof video.requestVideoFrameCallback === 'function') {
      let settled = false;
      const settle = (fresh) => {
        if (settled) return;
        settled = true;
        resolve(fresh);
      };
      video.requestVideoFrameCallback(() => settle(true));
      // Garde-fou : ce rappel ne se déclenche jamais si le flux se fige.
      setTimeout(() => settle(false), 300);
    } else {
      requestAnimationFrame(() => resolve(video.currentTime !== lastTime));
    }
  });
}

/** Boucle d'analyse : une image à la fois, les images arrivées entre-temps sont ignorées. */
async function processFrames(run) {
  const video = elements.video;
  let failures = 0;
  let lastTime = -1;

  while (run === state.run && state.phase === 'running') {
    const fresh = await nextVideoFrame(video, lastTime);
    if (run !== state.run || state.phase !== 'running') return;
    if (!fresh || video.readyState < 2 || video.videoWidth === 0) continue;
    lastTime = video.currentTime;

    const started = performance.now();
    try {
      const depth = await state.estimator.estimate(video, settings.nearReference);
      if (run !== state.run) return;
      analyzer.config.sensitivity = settings.sensitivity;
      const result = analyzer.analyze(depth.values, depth.width, depth.height);
      feedback.update(result.primaryAlert);
      const finished = performance.now();
      recordFrame(started, finished);
      render(depth, result, finished);
      failures = 0;
    } catch (error) {
      console.error(error);
      failures += 1;
      if (failures >= FAILURE_LIMIT) {
        if (run === state.run) fail(describeError(error));
        return;
      }
    }
  }
}

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Refusé (économie d'énergie, par exemple) : l'écran pourra se mettre en veille.
  }
}

function releaseWakeLock() {
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

// --- Service worker ------------------------------------------------------------------------------

/**
 * Enregistre le service worker puis, à la première visite, recharge la page une fois : c'est lui
 * qui ajoute les en-têtes rendant la page « cross-origin isolated », nécessaires au calcul multi-fil.
 */
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch (error) {
    console.warn('Service worker non enregistré : calcul sur un seul fil.', error);
    return;
  }
  if (self.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }
  // Une seule tentative par session, pour ne jamais boucler si l'isolation reste impossible.
  if (sessionStorage.getItem(RELOAD_FLAG)) return;
  const reload = () => {
    if (state.phase !== 'stopped') return;
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
  };
  if (navigator.serviceWorker.controller) reload();
  else navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
}

// --- Initialisation ------------------------------------------------------------------------------

function init() {
  bindSettingsForm();
  applySettings();
  setPhase('stopped', 'Détection arrêtée');
  clearDisplay();

  const vibrationText = feedback.canVibrate
    ? 'prise en charge'
    : 'non prise en charge par ce navigateur';
  elements.vibration.textContent = vibrationText;
  elements.vibrationNote.textContent = feedback.canVibrate
    ? ''
    : "Ce navigateur ne donne pas accès au moteur de vibration (c'est le cas de Safari sur iPhone) : les dangers sont signalés par le son et la voix.";

  feedback.onPulse = flashSector;

  elements.toggle.addEventListener('click', () => {
    if (isActive()) stop();
    else start();
  });
  elements.diagnosticToggle.addEventListener('click', () => {
    settings.diagnostic = !settings.diagnostic;
    saveSettings();
    applySettings();
  });
  elements.settingsOpen.addEventListener('click', () => elements.settings.showModal());

  elements.video.addEventListener('loadedmetadata', layoutOverlay);
  elements.video.addEventListener('resize', layoutOverlay);
  window.addEventListener('resize', layoutOverlay);

  // Le navigateur coupe la caméra en arrière-plan : on arrête proprement, puis on reprend.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (isActive()) halt('Détection en pause');
    } else if (state.shouldRun && !isActive()) {
      start();
    }
  });

  setInterval(watchFrameFlow, 1000);
  registerServiceWorker();
}

init();

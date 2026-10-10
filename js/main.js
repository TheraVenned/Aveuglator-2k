// Aveuglator 2000 : caméra → profondeur (MiDaS) → analyse des zones → sons, voix et vibrations.
// Tout s'exécute dans le navigateur, sans serveur. Ce module orchestre les autres et gère l'écran.

import { ObstacleAnalyzer, BANDS, SECTORS, Level, zoneIndex, zoneRect, alertMessage } from './analyzer.js';
import { MODEL_SIZE } from './depth.js';
import { renderDepth } from './heatmap.js';
import { FeedbackEngine, PHRASES } from './feedback.js';
import { Camera, CANCELLED } from './camera.js';
import { EngineError, enginePlan, createEngine } from './inference.js';

const SERVICE_WORKER_URL = new URL('../sw.js', import.meta.url).href;
const VOICE_INDEX_URL = new URL('../audio/voice.json', import.meta.url).href;
const VOICE_AUDIO_URL = new URL('../audio/voice.wav', import.meta.url).href;

const SETTINGS_KEY = 'aveuglator.settings.v2';
const RELOAD_FLAG = 'aveuglator.isolation-reload';
const SINGLE_THREAD_FLAG = 'aveuglator.single-thread';
const DEFAULT_SETTINGS = {
  hud: true,
  palette: 'shadow',
  sound: true,
  voice: true,
  vibration: true,
  volume: 0.8,
  sensitivity: 1,
  nearReference: 0,
  cameraId: '',
  webgpu: false,
};

const LOW_FRAME_RATE = 4;
/** Erreurs d'inférence consécutives tolérées avant de changer de moteur. */
const FAILURE_LIMIT = 8;
/** Durée d'un problème de caméra avant de rouvrir le flux, puis avant de prévenir l'utilisateur. */
const CAMERA_RESTART_AFTER_MS = 1200;
const CAMERA_ALERT_AFTER_MS = 3000;
const CAMERA_RESTART_INTERVAL_MS = 2500;
const CAMERA_RESTART_LIMIT = 4;
const BAND_NAMES = ['Tête', 'Corps', 'Sol'];
const STATUS_LABELS = { stopped: 'Arrêt', starting: 'Démarrage', running: 'Actif', failed: 'Erreur' };

const byId = (id) => document.getElementById(id);
const elements = {
  stage: byId('stage'),
  viewport: byId('viewport'),
  video: byId('camera'),
  depth: byId('depth'),
  grid: byId('grid'),
  idle: byId('idle'),
  statusText: byId('status-text'),
  warning: byId('warning'),
  readout: byId('readout'),
  matrix: byId('matrix'),
  alert: byId('alert'),
  systemLine: byId('system-line'),
  toggle: byId('toggle'),
  hudToggle: byId('hud-toggle'),
  settingsOpen: byId('settings-open'),
  settings: byId('settings'),
  vibrationNote: byId('vibration-note'),
  fps: byId('d-fps'),
  inference: byId('d-inference'),
  total: byId('d-total'),
  raw: byId('d-raw'),
  cameraInfo: byId('d-camera'),
  spark: byId('spark'),
};

const IDLE_TEXT = elements.idle.textContent;

const settings = loadSettings();
const analyzer = new ObstacleAnalyzer();
const feedback = new FeedbackEngine();
const camera = new Camera(elements.video, MODEL_SIZE);
const depthContext = elements.depth.getContext('2d');
const depthImage = depthContext.createImageData(MODEL_SIZE, MODEL_SIZE);
const sparkContext = elements.spark.getContext('2d');
const zoneCells = buildGrid();
const matrixCells = buildMatrix();

const state = {
  phase: 'stopped', // 'stopped' | 'starting' | 'running' | 'failed'
  // Intention de l'utilisateur : sert à reprendre la détection au retour au premier plan.
  shouldRun: false,
  // Incrémenté à chaque démarrage ou arrêt : invalide les boucles et chargements en cours.
  run: 0,
  // Moteur d'inférence en service, et plan de repli dont il est issu (voir inference.js).
  engine: null,
  enginePromise: null,
  plan: [],
  planIndex: 0,
  engineNote: '',
  wakeLock: null,
  // Mesures.
  frameTimes: [],
  rateHistory: [],
  inferenceAverage: 0,
  totalAverage: 0,
  lowRateSince: null,
  lowRate: false,
  lastTelemetryAt: 0,
  // Surveillance de la caméra.
  cameraIssueSince: null,
  cameraRestarts: 0,
  lastRestartAt: 0,
  restartingCamera: false,
  stalled: false,
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

function settingInput(key) {
  return elements.settings.querySelector(`[data-setting="${key}"]`);
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
    // Le moteur d'inférence se choisit au chargement : on recharge pour repartir proprement.
    location.reload();
  }
}

function applySettings() {
  document.body.classList.toggle('hud', settings.hud);
  elements.hudToggle.textContent = settings.hud ? 'Mesures affichées' : 'Mesures masquées';
  elements.hudToggle.setAttribute('aria-pressed', String(settings.hud));
  const hudInput = settingInput('hud');
  if (hudInput) hudInput.checked = settings.hud;
  feedback.configure({
    sound: settings.sound,
    voice: settings.voice,
    vibration: settings.vibration,
    volume: settings.volume,
  });
}

// --- État et affichage ---------------------------------------------------------------------------

function isActive() {
  return state.phase === 'starting' || state.phase === 'running';
}

function setPhase(phase) {
  state.phase = phase;
  for (const name of Object.keys(STATUS_LABELS)) {
    document.body.classList.toggle(name, name === phase);
  }
  elements.statusText.textContent = STATUS_LABELS[phase];
  elements.toggle.textContent = isActive() ? 'Arrêter la détection' : 'Démarrer la détection';
  refreshWarning();
}

/** Texte affiché à la place de la vision tant que la détection ne tourne pas. */
function setIdle(text) {
  elements.idle.textContent = text;
}

function setStartupStatus(run, text) {
  if (run === state.run && state.phase === 'starting') setIdle(text);
}

function refreshWarning(errorText = '') {
  let text = errorText;
  if (state.phase === 'running') {
    if (state.stalled) text = 'Aucune image reçue : la détection est suspendue.';
    else if (state.lowRate) text = "Cadence d'analyse faible : réactivité dégradée.";
    else if (state.engineNote) text = state.engineNote;
  }
  elements.warning.textContent = text;
  elements.warning.hidden = text === '';
}

function refreshSystemLine() {
  const engine = state.engine ? state.engine.label : 'moteur non chargé';
  const vibration = feedback.canVibrate ? 'vibration prête' : 'vibration indisponible';
  const voice = feedback.hasVoice ? 'voix prête' : 'voix non chargée';
  elements.systemLine.textContent = `${engine} · ${vibration} · ${voice}`;
}

function buildGrid() {
  const cells = [];
  for (const band of BANDS) {
    for (const sector of SECTORS) {
      const rect = zoneRect(analyzer.config, band, sector);
      const cell = document.createElement('div');
      cell.className = 'zone';
      cell.style.left = `${rect.x * 100}%`;
      cell.style.top = `${rect.y * 100}%`;
      cell.style.width = `${rect.width * 100}%`;
      cell.style.height = `${rect.height * 100}%`;
      const label = document.createElement('span');
      cell.appendChild(label);
      elements.grid.appendChild(cell);
      cells[zoneIndex(band, sector)] = { cell, label };
    }
    // Nom de la bande, le long du bord gauche.
    const rows = zoneRect(analyzer.config, band, SECTORS[0]);
    const tag = document.createElement('em');
    tag.className = 'band-tag';
    tag.textContent = BAND_NAMES[band];
    tag.style.top = `${(rows.y + rows.height / 2) * 100}%`;
    elements.grid.appendChild(tag);
  }
  return cells;
}

function buildMatrix() {
  const cells = [];
  for (let index = 0; index < BANDS.length * SECTORS.length; index++) {
    const cell = document.createElement('i');
    cell.className = 'cell';
    elements.matrix.appendChild(cell);
    cells.push(cell);
  }
  return cells;
}

/**
 * Donne à la vision les proportions de l'image analysée, à la plus grande taille qui tienne :
 * tout le champ de la caméra est visible, y compris les secteurs latéraux.
 */
function layoutViewport() {
  const { stage, viewport, video } = elements;
  const maxWidth = stage.clientWidth;
  const maxHeight = stage.clientHeight;
  if (!maxWidth || !maxHeight) return;
  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 3 / 4;
  let width = maxWidth;
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  viewport.style.width = `${Math.floor(width)}px`;
  viewport.style.height = `${Math.floor(height)}px`;
}

function showAlert(alert) {
  const key = alert ? `${alert.band}:${alert.sector}:${alert.level}` : 'none';
  if (key === state.shownAlert) return;
  state.shownAlert = key;
  elements.alert.textContent = alert ? alertMessage(alert) : 'Voie dégagée';
  const level = String(alert ? alert.level : Level.NONE);
  elements.readout.dataset.level = level;
  elements.viewport.dataset.level = level;
}

/**
 * Annonce d'état (démarrage, arrêt, panne). Attend au besoin la fin du chargement des annonces :
 * une panne survenue dès le démarrage doit tout de même être dite.
 */
function announce(phrase, force = false) {
  feedback.loadVoice(VOICE_INDEX_URL, VOICE_AUDIO_URL).then(() => {
    refreshSystemLine();
    feedback.speak(phrase, { urgent: true, force });
  });
}

/** Fait réagir la matrice à chaque motif réellement joué (son ou vibration). */
function pulseMatrix(alert) {
  const cell = matrixCells[zoneIndex(alert.band, alert.sector)];
  cell.classList.add('pulse');
  setTimeout(() => cell.classList.remove('pulse'), 110);
}

function render(depth, result, now) {
  renderDepth(depth.values, depthImage.data, settings.palette);
  depthContext.putImageData(depthImage, 0, 0);

  showAlert(result.primaryAlert);
  const primary = result.primaryAlert;
  for (const band of BANDS) {
    for (const sector of SECTORS) {
      const index = zoneIndex(band, sector);
      const reading = result.zones[index];
      const isPrimary = primary !== null && primary.band === band && primary.sector === sector;
      const level = String(reading.level);
      matrixCells[index].dataset.level = level;
      matrixCells[index].classList.toggle('is-primary', isPrimary);
      if (settings.hud) {
        const { cell, label } = zoneCells[index];
        cell.dataset.level = level;
        cell.classList.toggle('is-primary', isPrimary);
        label.textContent = reading.score.toFixed(2);
      }
    }
  }

  // Les chiffres sont rafraîchis quatre fois par seconde pour rester lisibles.
  if (!settings.hud || now - state.lastTelemetryAt < 250) return;
  state.lastTelemetryAt = now;
  const rate = currentFrameRate(now);
  elements.fps.textContent = rate.toFixed(1);
  elements.inference.textContent = state.inferenceAverage.toFixed(0);
  elements.total.textContent = state.totalAverage.toFixed(0);
  elements.raw.textContent = `${depth.rawMin.toFixed(0)}–${depth.rawMax.toFixed(0)}`;
  const restarts = state.cameraRestarts > 0 ? ` · relances ${state.cameraRestarts}` : '';
  elements.cameraInfo.textContent = `${camera.description}${restarts}`;
  drawSparkline(rate);
}

/** Courbe des dernières cadences mesurées (une quinzaine de secondes). */
function drawSparkline(rate) {
  const history = state.rateHistory;
  history.push(rate);
  if (history.length > 60) history.shift();
  const { width, height } = elements.spark;
  const top = Math.max(10, ...history);
  sparkContext.clearRect(0, 0, width, height);
  sparkContext.beginPath();
  history.forEach((value, index) => {
    const x = (index / 59) * width;
    const y = height - 2 - (value / top) * (height - 4);
    if (index === 0) sparkContext.moveTo(x, y);
    else sparkContext.lineTo(x, y);
  });
  sparkContext.strokeStyle = '#ffc400';
  sparkContext.lineWidth = 3;
  sparkContext.lineJoin = 'round';
  sparkContext.stroke();
}

/** Vision opaque et noire : la vidéo de la caméra, placée dessous, ne doit jamais apparaître. */
function blankDepth() {
  depthContext.fillStyle = '#0a0d14';
  depthContext.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
}

function clearDisplay() {
  blankDepth();
  for (const { cell, label } of zoneCells) {
    cell.dataset.level = '0';
    cell.classList.remove('is-primary');
    label.textContent = '';
  }
  for (const cell of matrixCells) {
    cell.dataset.level = '0';
    cell.classList.remove('is-primary');
  }
  state.shownAlert = undefined;
  elements.readout.dataset.level = '0';
  elements.viewport.dataset.level = '0';
}

// --- Mesures -------------------------------------------------------------------------------------

function currentFrameRate(now) {
  const times = state.frameTimes;
  while (times.length > 0 && now - times[0] > 1000) times.shift();
  if (times.length < 2) return 0;
  return ((times.length - 1) * 1000) / (now - times[0]);
}

function recordFrame(started, finished, inferenceMs) {
  state.frameTimes.push(finished);
  const total = finished - started;
  state.inferenceAverage = state.inferenceAverage === 0 ? inferenceMs : state.inferenceAverage * 0.9 + inferenceMs * 0.1;
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
    if (lowRate) announce(PHRASES.slow, true);
  }
}

function resetMeasures() {
  state.frameTimes = [];
  state.rateHistory = [];
  state.inferenceAverage = 0;
  state.totalAverage = 0;
  state.lowRateSince = null;
  state.lowRate = false;
  state.lastTelemetryAt = 0;
  state.cameraIssueSince = null;
  state.cameraRestarts = 0;
  state.lastRestartAt = 0;
  state.stalled = false;
}

// --- Caméra --------------------------------------------------------------------------------------

/**
 * Surveille le flux deux fois par seconde. Un navigateur mobile peut mettre la vidéo en pause ou
 * figer le flux sans prévenir : on relance alors la lecture, puis on rouvre la caméra. La personne
 * n'est avertie que si cela ne suffit pas, car elle ne voit pas l'écran.
 */
async function superviseCamera() {
  if (state.phase !== 'running' || state.restartingCamera) return;
  camera.probe();
  const now = performance.now();
  const health = camera.health(now);

  if (health === 'ok') {
    state.cameraIssueSince = null;
    if (state.stalled) {
      state.stalled = false;
      announce(PHRASES.restored, true);
      refreshWarning();
    }
    return;
  }

  if (state.cameraIssueSince === null) state.cameraIssueSince = now;
  const elapsed = now - state.cameraIssueSince;
  if (health === 'paused') camera.resume();

  if (elapsed >= CAMERA_ALERT_AFTER_MS && !state.stalled) {
    state.stalled = true;
    feedback.update(null);
    feedback.notify('fault');
    announce(PHRASES.stalled, true);
    refreshWarning();
  }

  const shouldRestart = health === 'ended' || elapsed >= CAMERA_RESTART_AFTER_MS;
  if (shouldRestart && now - state.lastRestartAt >= CAMERA_RESTART_INTERVAL_MS) {
    if (state.cameraRestarts >= CAMERA_RESTART_LIMIT) {
      fail('la caméra ne répond plus.');
      return;
    }
    state.cameraRestarts += 1;
    await restartCamera();
  }
}

/** Rouvre la caméra : après une panne du flux, ou quand l'utilisateur en choisit une autre. */
async function restartCamera() {
  const run = state.run;
  state.restartingCamera = true;
  state.lastRestartAt = performance.now();
  try {
    await camera.start(settings.cameraId, () => run !== state.run);
    layoutViewport();
    refreshCameraList();
  } catch (error) {
    // Nouvelle tentative au prochain passage de la surveillance, dans la limite prévue.
    if (error !== CANCELLED) console.warn('Réouverture de la caméra impossible.', error);
  } finally {
    state.restartingCamera = false;
  }
}

/** Les noms des caméras ne sont lisibles qu'une fois l'autorisation accordée. */
async function refreshCameraList() {
  const select = settingInput('cameraId');
  if (!select || !navigator.mediaDevices.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput' && device.deviceId);
    select.replaceChildren(new Option('Angle le plus large', ''));
    cameras.forEach((device, index) => {
      select.appendChild(new Option(device.label || `Caméra ${index + 1}`, device.deviceId));
    });
    select.value = cameras.some((device) => device.deviceId === settings.cameraId) ? settings.cameraId : '';
  } catch {
    // Liste indisponible : le choix automatique reste proposé.
  }
}

// --- Moteur d'inférence --------------------------------------------------------------------------

function ensureEngine(run) {
  if (state.engine) return Promise.resolve(state.engine);
  if (!state.enginePromise) {
    state.plan = enginePlan({
      webgpu: settings.webgpu && 'gpu' in navigator,
      multiThread: self.crossOriginIsolated && !readFlag(SINGLE_THREAD_FLAG),
      cores: navigator.hardwareConcurrency,
    });
    state.enginePromise = startEngine(0, run).finally(() => {
      state.enginePromise = null;
    });
  }
  return state.enginePromise;
}

/** Initialise le premier moteur du plan qui fonctionne, à partir de `fromIndex`. */
async function startEngine(fromIndex, run) {
  let lastError = new Error('aucun moteur de calcul disponible.');
  for (let index = fromIndex; index < state.plan.length; index++) {
    const step = state.plan[index];
    const engine = createEngine(step);
    try {
      await engine.init((stage, fraction) => {
        const text = stage === 'download'
          ? `Téléchargement du modèle… ${Math.round(fraction * 100)} %`
          : `Préparation du modèle (${engine.label})…`;
        setStartupStatus(run, text);
      });
      state.engine = engine;
      state.planIndex = index;
      refreshSystemLine();
      return engine;
    } catch (error) {
      console.warn(`Moteur ${engine.label} indisponible.`, error);
      engine.dispose();
      rememberEngineFailure(step);
      lastError = error;
    }
  }
  throw lastError;
}

/** Évite de retenter à chaque lancement un moteur qui ne fonctionne pas sur cet appareil. */
function rememberEngineFailure(step) {
  if (step.backend === 'webgpu') {
    settings.webgpu = false;
    saveSettings();
    const input = settingInput('webgpu');
    if (input) input.checked = false;
  } else if (step.kind === 'worker' && step.threads > 1) {
    writeFlag(SINGLE_THREAD_FLAG);
  }
}

/** Remplace un moteur bloqué ou en panne par le suivant du plan. Renvoie `false` s'il n'en reste pas. */
async function replaceEngine(run, error) {
  console.warn(`Moteur ${state.engine ? state.engine.label : ''} abandonné.`, error);
  feedback.update(null);
  rememberEngineFailure(state.plan[state.planIndex]);
  if (state.engine) state.engine.dispose();
  state.engine = null;
  state.engineNote = 'Moteur de calcul relancé en mode compatible.';
  refreshWarning();
  try {
    await startEngine(state.planIndex + 1, run);
  } catch (startError) {
    if (run === state.run) fail(describeError(startError), startError);
    return false;
  }
  return run === state.run;
}

// --- Cycle de vie --------------------------------------------------------------------------------

async function start() {
  if (isActive()) return;
  // À faire tout de suite, dans le geste de l'utilisateur : déverrouille le son.
  feedback.unlock();
  // Les annonces se chargent pendant le démarrage, pour être prêtes dès la première alerte.
  feedback.loadVoice(VOICE_INDEX_URL, VOICE_AUDIO_URL).then(refreshSystemLine);

  state.shouldRun = true;
  const run = ++state.run;
  setPhase('starting');
  setIdle('Démarrage de la détection…');
  clearDisplay();

  try {
    await Promise.all([camera.start(settings.cameraId, () => run !== state.run), ensureEngine(run)]);
  } catch (error) {
    if (error !== CANCELLED && run === state.run) fail(describeError(error), error);
    return;
  }
  if (run !== state.run) return;

  analyzer.reset();
  resetMeasures();
  state.engineNote = '';
  layoutViewport();
  refreshCameraList();
  refreshSystemLine();
  setPhase('running');
  showAlert(null);
  feedback.start();
  feedback.notify('started');
  announce(PHRASES.active);
  acquireWakeLock();
  processFrames(run);
}

/** Arrêt demandé par l'utilisateur. */
function stop() {
  state.shouldRun = false;
  halt();
  announce(PHRASES.stopped);
}

function halt() {
  state.run += 1;
  camera.stop();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  setIdle(IDLE_TEXT);
  setPhase('stopped');
  elements.alert.textContent = 'Prêt';
}

function fail(message, error = null) {
  state.run += 1;
  camera.stop();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  setIdle(IDLE_TEXT);
  setPhase('failed');
  elements.alert.textContent = 'Détection arrêtée';
  refreshWarning(`Erreur : ${message}`);
  feedback.notify('fault');
  const denied = error !== null && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
  announce(denied ? PHRASES.cameraDenied : PHRASES.error, true);
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

/** Attend le prochain rafraîchissement de l'écran, sans jamais rester bloqué s'il tarde. */
function nextTick() {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(settle);
    setTimeout(settle, 120);
  });
}

/** Boucle d'analyse : une image à la fois, les images arrivées entre-temps sont ignorées. */
async function processFrames(run) {
  const isCurrent = () => run === state.run && state.phase === 'running';
  let failures = 0;

  while (isCurrent()) {
    await nextTick();
    if (!isCurrent()) return;
    const pixels = camera.capture();
    if (!pixels) continue;

    const started = performance.now();
    let depth;
    try {
      depth = await state.engine.run(pixels, settings.nearReference);
    } catch (error) {
      if (!isCurrent()) return;
      const engineDown = error instanceof EngineError && (error.kind === 'hang' || error.kind === 'crash');
      failures += 1;
      if (engineDown || failures >= FAILURE_LIMIT) {
        failures = 0;
        if (!(await replaceEngine(run, error))) return;
      }
      continue;
    }
    if (!isCurrent()) return;
    failures = 0;

    analyzer.config.sensitivity = settings.sensitivity;
    const result = analyzer.analyze(depth.values, depth.width, depth.height);
    // Flux figé : l'image analysée est périmée, on ne signale plus rien.
    feedback.update(state.stalled ? null : result.primaryAlert);
    const finished = performance.now();
    recordFrame(started, finished, depth.inferenceMs);
    render(depth, result, finished);
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
  clearDisplay();
  setPhase('stopped');
  refreshSystemLine();
  layoutViewport();

  elements.vibrationNote.textContent = feedback.canVibrate
    ? ''
    : "Ce navigateur ne donne pas accès au moteur de vibration (c'est le cas de Safari sur iPhone) : les dangers sont signalés par le son et la voix.";

  feedback.onPulse = pulseMatrix;

  elements.toggle.addEventListener('click', () => {
    if (isActive()) stop();
    else start();
  });
  elements.hudToggle.addEventListener('click', () => {
    settings.hud = !settings.hud;
    saveSettings();
    applySettings();
  });
  elements.settingsOpen.addEventListener('click', () => elements.settings.showModal());

  // Un geste quelconque suffit à réveiller le son si le navigateur l'a suspendu.
  document.addEventListener('pointerdown', () => {
    if (isActive()) feedback.unlock();
  });

  elements.video.addEventListener('loadedmetadata', layoutViewport);
  elements.video.addEventListener('resize', layoutViewport);
  // Mise en pause par le navigateur : on relance sans attendre la surveillance périodique.
  elements.video.addEventListener('pause', () => {
    if (state.phase === 'running') camera.resume();
  });
  window.addEventListener('resize', layoutViewport);
  if ('ResizeObserver' in window) new ResizeObserver(layoutViewport).observe(elements.stage);

  // Le navigateur coupe la caméra en arrière-plan : on arrête proprement, puis on reprend.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (isActive()) halt();
    } else if (state.shouldRun && !isActive()) {
      start();
    }
  });

  setInterval(superviseCamera, 500);
  registerServiceWorker();
}

init();

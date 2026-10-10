// Aveuglator 2000 : caméra → profondeur (MiDaS) → analyse des zones → sons, voix et vibrations.
// Tout s'exécute dans le navigateur, sans serveur. Ce module orchestre les autres et gère l'écran.

import { ObstacleAnalyzer, BANDS, SECTORS, Level, zoneIndex, zoneRect, alertMessage } from './analyzer.js';
import { MODEL_SIZE } from './depth.js';
import { DepthRenderer, coverScale } from './renderer.js';
import { FeedbackEngine, PHRASES } from './feedback.js';
import { Camera, CANCELLED } from './camera.js';
import { EngineError, enginePlan, createEngine } from './inference.js';

const SERVICE_WORKER_URL = new URL('../sw.js', import.meta.url).href;
const VOICE_INDEX_URL = new URL('../audio/voice.json', import.meta.url).href;
const VOICE_AUDIO_URL = new URL('../audio/voice.wav', import.meta.url).href;

const SETTINGS_KEY = 'aveuglator.settings.v3';
const RELOAD_FLAG = 'aveuglator.isolation-reload';
const SINGLE_THREAD_FLAG = 'aveuglator.single-thread';
const DEFAULT_SETTINGS = {
  hud: false,
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
/** Attente maximale du service worker, à la première visite, avant de démarrer sans lui. */
const ISOLATION_WAIT_MS = 4000;

const byId = (id) => document.getElementById(id);
const elements = {
  view: byId('view'),
  video: byId('camera'),
  depth: byId('depth'),
  grid: byId('grid'),
  metrics: byId('metrics'),
  message: byId('message'),
  soundHint: byId('sound-hint'),
  bar: byId('bar'),
  dot: byId('dot'),
  alert: byId('alert'),
  settingsOpen: byId('settings-open'),
  settings: byId('settings'),
  vibrationNote: byId('vibration-note'),
};

const settings = loadSettings();
const analyzer = new ObstacleAnalyzer();
const feedback = new FeedbackEngine();
const camera = new Camera(elements.video, MODEL_SIZE);
const renderer = new DepthRenderer(elements.depth);
const zoneCells = buildGrid();

const state = {
  phase: 'stopped', // 'stopped' | 'starting' | 'running' | 'failed'
  // Incrémenté à chaque démarrage ou arrêt : invalide les boucles et chargements en cours.
  run: 0,
  // Moteur d'inférence en service, et plan de repli dont il est issu (voir inference.js).
  engine: null,
  enginePromise: null,
  plan: [],
  planIndex: 0,
  wakeLock: null,
  // L'annonce « Détection active » attend que le son soit autorisé par un geste.
  greeted: false,
  // Mesures.
  frameTimes: [],
  inferenceAverage: 0,
  totalAverage: 0,
  lowRateSince: null,
  lowRate: false,
  lastMetricsAt: 0,
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
    if (input.type === 'checkbox') input.checked = Boolean(settings[key]);
    else input.value = String(settings[key]);
    input.addEventListener('input', () => {
      if (input.type === 'checkbox') settings[key] = input.checked;
      else if (input.type === 'range') settings[key] = Number(input.value);
      else settings[key] = input.value;
      saveSettings();
      settingChanged(key);
    });
  }
  refreshOutputs();
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

/** `message` : texte affiché à la place de la vision (vide pendant la détection). */
function setPhase(phase, message = '') {
  state.phase = phase;
  for (const name of ['stopped', 'starting', 'running', 'failed']) {
    document.body.classList.toggle(name, name === phase);
  }
  elements.message.textContent = message;
}

function setStartupMessage(run, text) {
  if (run === state.run && state.phase === 'starting') elements.message.textContent = text;
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

function frameAspect() {
  const { videoWidth, videoHeight } = elements.video;
  return videoWidth && videoHeight ? videoWidth / videoHeight : 3 / 4;
}

/** Cale la grille des zones sur l'image telle qu'elle est recadrée à l'écran. */
function layout() {
  const width = elements.view.clientWidth;
  const height = elements.view.clientHeight;
  if (!width || !height) return;
  const [scaleX, scaleY] = coverScale(frameAspect(), width / height);
  const gridWidth = width / scaleX;
  const gridHeight = height / scaleY;
  elements.grid.style.width = `${gridWidth}px`;
  elements.grid.style.height = `${gridHeight}px`;
  elements.grid.style.left = `${(width - gridWidth) / 2}px`;
  elements.grid.style.top = `${(height - gridHeight) / 2}px`;
}

function showAlert(alert) {
  const key = alert ? `${alert.band}:${alert.sector}:${alert.level}` : 'none';
  if (key === state.shownAlert) return;
  state.shownAlert = key;
  elements.alert.textContent = alert ? alertMessage(alert) : 'Voie dégagée';
  elements.bar.dataset.level = String(alert ? alert.level : Level.NONE);
}

/** Le point de la barre réagit à chaque motif réellement joué (son ou vibration). */
function pulseDot() {
  elements.dot.classList.add('pulse');
  setTimeout(() => elements.dot.classList.remove('pulse'), 110);
}

/**
 * Annonce d'état (démarrage, panne). Attend au besoin la fin du chargement des annonces : une
 * panne survenue dès le démarrage doit tout de même être dite.
 */
function announce(phrase, force = false) {
  feedback.loadVoice(VOICE_INDEX_URL, VOICE_AUDIO_URL).then(() => {
    feedback.speak(phrase, { urgent: true, force });
  });
}

function render(depth, result, now) {
  renderer.draw(depth.values, depth.width, depth.height, camera.guide, frameAspect());
  showAlert(result.primaryAlert);
  if (!settings.hud) return;

  for (let index = 0; index < result.zones.length; index++) {
    const reading = result.zones[index];
    const { cell, label } = zoneCells[index];
    cell.dataset.level = String(reading.level);
    label.textContent = reading.score.toFixed(2);
  }
  // Les chiffres sont rafraîchis quatre fois par seconde pour rester lisibles.
  if (now - state.lastMetricsAt < 250) return;
  state.lastMetricsAt = now;
  const restarts = state.cameraRestarts > 0 ? ` · relances ${state.cameraRestarts}` : '';
  elements.metrics.textContent = [
    `${currentFrameRate(now).toFixed(1)} fps · ${state.inferenceAverage.toFixed(0)} ms · ${state.engine.label}`,
    `prof ${depth.rawMin.toFixed(0)}–${depth.rawMax.toFixed(0)}`,
    `${camera.description}${restarts}`,
  ].join('\n');
}

function clearDisplay() {
  renderer.clear();
  state.shownAlert = undefined;
  elements.bar.dataset.level = '0';
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
    if (lowRate) announce(PHRASES.slow, true);
  }
}

function resetMeasures() {
  state.frameTimes = [];
  state.inferenceAverage = 0;
  state.totalAverage = 0;
  state.lowRateSince = null;
  state.lowRate = false;
  state.lastMetricsAt = 0;
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
async function supervise() {
  // Les navigateurs n'autorisent le son qu'après un geste : on le rappelle tant qu'il manque.
  elements.soundHint.hidden = !isActive() || feedback.audio.isRunning;
  greet();

  if (state.phase !== 'running' || state.restartingCamera) return;
  camera.probe();
  const now = performance.now();
  const health = camera.health(now);

  if (health === 'ok') {
    state.cameraIssueSince = null;
    if (state.stalled) {
      state.stalled = false;
      elements.message.textContent = '';
      announce(PHRASES.restored, true);
    }
    return;
  }

  if (state.cameraIssueSince === null) state.cameraIssueSince = now;
  const elapsed = now - state.cameraIssueSince;
  if (health === 'paused') camera.resume();

  if (elapsed >= CAMERA_ALERT_AFTER_MS && !state.stalled) {
    state.stalled = true;
    elements.message.textContent = 'La caméra ne fournit plus d’images.';
    feedback.update(null);
    feedback.notify('fault');
    announce(PHRASES.stalled, true);
  }

  const shouldRestart = health === 'ended' || elapsed >= CAMERA_RESTART_AFTER_MS;
  if (shouldRestart && now - state.lastRestartAt >= CAMERA_RESTART_INTERVAL_MS) {
    if (state.cameraRestarts >= CAMERA_RESTART_LIMIT) {
      fail('La caméra ne répond plus.');
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
    renderer.reset();
    layout();
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
  let lastError = new Error('Aucun moteur de calcul disponible.');
  for (let index = fromIndex; index < state.plan.length; index++) {
    const step = state.plan[index];
    const engine = createEngine(step);
    try {
      await engine.init((stage, fraction) => {
        setStartupMessage(run, stage === 'download'
          ? `Téléchargement du modèle ${Math.round(fraction * 100)} %`
          : 'Préparation du modèle');
      });
      state.engine = engine;
      state.planIndex = index;
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
  try {
    await startEngine(state.planIndex + 1, run);
  } catch (startError) {
    if (run === state.run) fail(describeError(startError), startError);
    return false;
  }
  return run === state.run;
}

// --- Cycle de vie --------------------------------------------------------------------------------

/** Lance la détection. Appelée d'elle-même au chargement et au retour au premier plan. */
async function start() {
  if (isActive()) return;
  const run = ++state.run;
  setPhase('starting', 'Démarrage');
  elements.alert.textContent = 'Démarrage';
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
  layout();
  refreshCameraList();
  setPhase('running');
  showAlert(null);
  feedback.start();
  greet();
  acquireWakeLock();
  processFrames(run);
}

/** Signale le démarrage, dès que le son est disponible. */
function greet() {
  if (state.greeted || state.phase !== 'running' || !feedback.audio.isRunning) return;
  state.greeted = true;
  feedback.notify('started');
  announce(PHRASES.active);
}

function halt() {
  state.run += 1;
  camera.stop();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  state.greeted = false;
  setPhase('stopped');
}

function fail(message, error = null) {
  state.run += 1;
  camera.stop();
  feedback.stop();
  releaseWakeLock();
  resetMeasures();
  clearDisplay();
  state.greeted = false;
  setPhase('failed', `${message}\n\nTouchez l’écran pour réessayer.`);
  elements.alert.textContent = 'Détection arrêtée';
  feedback.notify('fault');
  const denied = error !== null && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
  announce(denied ? PHRASES.cameraDenied : PHRASES.error, true);
}

function describeError(error) {
  switch (error && error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Accès à la caméra refusé. Autorisez la caméra pour ce site dans les réglages du navigateur.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Aucune caméra utilisable sur cet appareil.';
    case 'NotReadableError':
    case 'AbortError':
      return 'La caméra est déjà utilisée par une autre application.';
    default:
      return (error && error.message) || 'Erreur inconnue.';
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
 * Enregistre le service worker. C'est lui qui ajoute les en-têtes rendant la page « cross-origin
 * isolated », nécessaires au calcul multi-fil : à la première visite, la page doit donc être
 * rechargée une fois. Renvoie `true` si ce rechargement est lancé (inutile alors de démarrer).
 */
async function prepareIsolation() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  } catch (error) {
    console.warn('Service worker non enregistré : calcul sur un seul fil.', error);
    return false;
  }
  if (self.crossOriginIsolated) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return false;
  }
  // Une seule tentative par session, pour ne jamais boucler si l'isolation reste impossible.
  if (sessionStorage.getItem(RELOAD_FLAG)) return false;

  if (!navigator.serviceWorker.controller) {
    const controlled = await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true });
      setTimeout(() => resolve(false), ISOLATION_WAIT_MS);
    });
    if (!controlled) return false;
  }
  sessionStorage.setItem(RELOAD_FLAG, '1');
  location.reload();
  return true;
}

// --- Initialisation ------------------------------------------------------------------------------

async function init() {
  bindSettingsForm();
  applySettings();
  clearDisplay();
  setPhase('stopped', 'Démarrage');

  elements.vibrationNote.textContent = feedback.canVibrate
    ? ''
    : "Ce navigateur ne donne pas accès au moteur de vibration (c'est le cas de Safari sur iPhone) : les dangers sont signalés par le son et la voix.";
  feedback.onPulse = pulseDot;

  elements.settingsOpen.addEventListener('click', () => elements.settings.showModal());

  // Premier geste : autorise le son. Après une erreur, un appui relance la détection.
  document.addEventListener('pointerdown', () => {
    feedback.unlock();
    setTimeout(greet, 300);
  });
  elements.view.addEventListener('click', () => {
    if (state.phase === 'failed') start();
  });

  elements.video.addEventListener('loadedmetadata', layout);
  elements.video.addEventListener('resize', layout);
  // Mise en pause par le navigateur : on relance sans attendre la surveillance périodique.
  elements.video.addEventListener('pause', () => {
    if (state.phase === 'running') camera.resume();
  });
  window.addEventListener('resize', layout);

  // Le navigateur coupe la caméra en arrière-plan : on arrête proprement, puis on reprend.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (isActive()) halt();
    } else if (!isActive()) {
      start();
    }
  });

  setInterval(supervise, 500);
  if (!(await prepareIsolation()) && !document.hidden) start();
}

init();

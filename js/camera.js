// Caméra : ouverture avec l'angle le plus large possible, capture des images pour le modèle et
// surveillance du flux (sur téléphone, il arrive que le navigateur le mette en pause ou le fige).

/** Levée quand un démarrage est rendu caduc par un arrêt ou un nouveau démarrage. */
export const CANCELLED = Symbol('cancelled');

// Format 4:3 : c'est celui du capteur. Le 16:9 rogne ses bords, c'est-à-dire, téléphone tenu à la
// verticale, la vision latérale. La définition importe peu : le modèle travaille en 256 × 256.
const BASE_CONSTRAINTS = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };

const ULTRA_WIDE_LABEL = /ultra/i;
const FRONT_LABEL = /front|avant|frontale|selfie|facetime/i;

/** Sans image nouvelle pendant ce délai, le flux est considéré comme figé. */
const STALL_MS = 2000;

/**
 * Objectif ultra grand-angle arrière parmi les caméras listées, s'il existe et n'est pas déjà
 * celui en service. Le nom des caméras dépend de la langue du téléphone, mais contient « ultra »
 * en français comme en anglais (« Back Ultra Wide Camera »).
 */
export function pickUltraWide(devices, currentDeviceId) {
  const candidate = devices.find(
    (device) =>
      device.kind === 'videoinput' &&
      device.deviceId &&
      ULTRA_WIDE_LABEL.test(device.label) &&
      !FRONT_LABEL.test(device.label),
  );
  return candidate && candidate.deviceId !== currentDeviceId ? candidate : null;
}

function open(video) {
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

function stopStream(stream) {
  for (const track of stream.getTracks()) track.stop();
}

/** Élargit le champ au maximum : objectif ultra grand-angle s'il existe, puis zoom minimal. */
async function widen(stream) {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    // Liste indisponible : on garde la caméra ouverte.
  }
  const ultraWide = pickUltraWide(devices, stream.getVideoTracks()[0].getSettings().deviceId);
  if (ultraWide) {
    // Un téléphone n'ouvre qu'une caméra à la fois : on ferme la première avant d'ouvrir l'autre.
    stopStream(stream);
    try {
      stream = await open({ ...BASE_CONSTRAINTS, deviceId: { exact: ultraWide.deviceId } });
    } catch {
      stream = await open({ ...BASE_CONSTRAINTS, facingMode: { ideal: 'environment' } });
    }
  }
  await zoomOut(stream.getVideoTracks()[0]);
  return stream;
}

/** Certains navigateurs exposent le zoom ; sa valeur minimale correspond au champ le plus large. */
async function zoomOut(track) {
  try {
    const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;
    const zoom = capabilities && capabilities.zoom;
    if (!zoom || typeof zoom.min !== 'number') return;
    const current = track.getSettings().zoom;
    if (typeof current === 'number' && current <= zoom.min) return;
    await track.applyConstraints({ advanced: [{ zoom: zoom.min }] });
  } catch {
    // Zoom non réglable : le champ reste celui par défaut.
  }
}

/** Côté de la vignette utilisée pour vérifier que le flux avance. */
const PROBE_SIZE = 16;

/** Empreinte d'une image, sur un octet tous les `step` : change dès que l'image change. */
function signature(data, step) {
  let hash = 0;
  for (let index = 0; index < data.length; index += step) hash = (hash * 31 + data[index]) | 0;
  return hash;
}

export class Camera {
  /**
   * @param video élément <video> qui reçoit le flux
   * @param size côté de l'image carrée fournie au modèle
   */
  constructor(video, size) {
    this.video = video;
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = PROBE_SIZE;
    probeCanvas.height = PROBE_SIZE;
    this.probeContext = probeCanvas.getContext('2d', { willReadFrequently: true });
    /** Dernière image capturée, en pleine définition. */
    this.guide = document.createElement('canvas');
    this.guideContext = this.guide.getContext('2d');
    this.stream = null;
    this.track = null;
    this.label = '';
    this.lastSignature = null;
    this.lastTime = -1;
    this.lastProbeSignature = null;
    this.lastProbeTime = -1;
    this.lastFreshAt = 0;
  }

  get isOpen() {
    return this.stream !== null;
  }

  /** Libellé et définition de la caméra en service, pour l'affichage. */
  get description() {
    if (!this.track) return 'aucune';
    const { videoWidth, videoHeight } = this.video;
    const size = videoWidth ? ` · ${videoWidth}×${videoHeight}` : '';
    return `${this.label || 'caméra'}${size}`;
  }

  /**
   * Ouvre la caméra. Sans `deviceId`, choisit la caméra arrière au champ le plus large.
   * `isCancelled` est interrogée après chaque attente ; si elle répond vrai, lève `CANCELLED`.
   */
  async start(deviceId, isCancelled = () => false) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Caméra inaccessible : ouvrez le site en HTTPS dans Safari ou Chrome.');
    }
    this.stop();

    let stream;
    if (deviceId) {
      stream = await open({ ...BASE_CONSTRAINTS, deviceId: { exact: deviceId } });
    } else {
      stream = await open({ ...BASE_CONSTRAINTS, facingMode: { ideal: 'environment' } });
      if (!isCancelled()) stream = await widen(stream);
    }
    if (isCancelled()) {
      stopStream(stream);
      throw CANCELLED;
    }

    // Un autre démarrage a pu aboutir entre-temps : on libère son flux.
    this.stop();
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    this.label = this.track.label;
    this.video.srcObject = stream;
    await this.video.play();
    this.lastSignature = null;
    this.lastTime = -1;
    this.lastProbeSignature = null;
    this.lastProbeTime = -1;
    this.lastFreshAt = performance.now();
  }

  stop() {
    if (this.stream) stopStream(this.stream);
    this.stream = null;
    this.track = null;
    this.video.srcObject = null;
  }

  /** Relance la lecture si le navigateur l'a mise en pause. */
  resume() {
    if (this.stream && this.video.paused) {
      this.video.play().catch(() => {});
    }
  }

  /**
   * Image courante à la taille du modèle (étirée : tout le champ de la caméra est conservé).
   * Renvoie `null` tant qu'aucune image nouvelle n'est disponible.
   */
  capture() {
    const video = this.video;
    if (!this.stream || video.readyState < 2 || video.videoWidth === 0) return null;
    this.context.drawImage(video, 0, 0, this.size, this.size);
    const pixels = this.context.getImageData(0, 0, this.size, this.size).data;
    // La même image, en pleine définition : elle guidera l'affinage du rendu (voir renderer.js).
    if (this.guide.width !== video.videoWidth || this.guide.height !== video.videoHeight) {
      this.guide.width = video.videoWidth;
      this.guide.height = video.videoHeight;
    }
    this.guideContext.drawImage(video, 0, 0);

    // Deux indices de nouveauté : l'horloge de la vidéo et le contenu de l'image. Un seul suffit,
    // aucun des deux n'étant fiable sur tous les navigateurs.
    const currentSignature = signature(pixels, 164);
    const time = video.currentTime;
    const fresh = currentSignature !== this.lastSignature || time !== this.lastTime;
    this.lastSignature = currentSignature;
    this.lastTime = time;
    if (!fresh) return null;
    this.lastFreshAt = performance.now();
    return pixels;
  }

  /**
   * Vérifie sur une vignette que le flux avance. Indépendant de `capture` : la boucle d'analyse
   * peut attendre le modèle plusieurs secondes sans que la caméra soit en cause.
   */
  probe() {
    const video = this.video;
    if (!this.stream || video.readyState < 2 || video.videoWidth === 0) return;
    this.probeContext.drawImage(video, 0, 0, PROBE_SIZE, PROBE_SIZE);
    const currentSignature = signature(this.probeContext.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data, 4);
    const time = video.currentTime;
    if (currentSignature !== this.lastProbeSignature || time !== this.lastProbeTime) {
      this.lastFreshAt = performance.now();
    }
    this.lastProbeSignature = currentSignature;
    this.lastProbeTime = time;
  }

  /** État du flux : 'ok', 'paused', 'muted', 'ended' ou 'stalled'. Appeler `probe` juste avant. */
  health(now = performance.now()) {
    if (!this.track || this.track.readyState === 'ended') return 'ended';
    if (this.video.paused || this.video.ended) return 'paused';
    if (this.track.muted) return 'muted';
    if (now - this.lastFreshAt > STALL_MS) return 'stalled';
    return 'ok';
  }
}

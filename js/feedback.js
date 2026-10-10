// Retours à l'utilisateur : sons (Web Audio), vibrations et annonces vocales.

import { Band, Level, alertMessage } from './analyzer.js';

// Espacement des impulsions : assez large pour qu'on puisse les compter à l'oreille.
const TAP_SPACING = 0.12;
const TAP_DURATION = 0.07;
const LEVEL_STRENGTH = [0.3, 0.5, 0.75, 1.0];
/** Silence entre deux répétitions du motif, par niveau de danger. */
const PAUSE_AFTER = [1.0, 0.9, 0.45, 0.12];
/** Hauteur des impulsions par secteur : grave à gauche, aiguë à droite. */
const TAP_FREQUENCY = [523, 784, 1047];

/**
 * Motif d'une alerte.
 * - Secteur : nombre d'impulsions finales (gauche = 1, centre = 2, droite = 3), leur hauteur et
 *   leur position stéréo.
 * - Type : préfixe (aucun = obstacle frontal, note longue aiguë = hauteur de tête, note
 *   descendante = dénivelé au sol).
 * - Proximité : volume et cadence de répétition.
 */
export function patternForAlert(alert) {
  const strength = LEVEL_STRENGTH[alert.level];
  const events = [];
  let cursor = 0;

  if (alert.band === Band.HEAD) {
    events.push({ time: 0, duration: 0.45, strength, frequency: 1568 });
    cursor = 0.53;
  } else if (alert.band === Band.GROUND) {
    events.push({ time: 0, duration: 0.36, strength, frequency: 880, frequencyEnd: 220 });
    cursor = 0.44;
  }

  const taps = alert.sector + 1;
  for (let index = 0; index < taps; index++) {
    events.push({
      time: cursor + index * TAP_SPACING,
      duration: TAP_DURATION,
      strength,
      frequency: TAP_FREQUENCY[alert.sector],
      pan: alert.sector - 1,
    });
  }
  return { events, duration: cursor + (taps - 1) * TAP_SPACING + TAP_DURATION };
}

/** Signaux système : `started` (deux notes montantes) ou `fault` (trois notes longues et graves). */
export function patternForNotice(kind) {
  if (kind === 'started') {
    return {
      events: [
        { time: 0, duration: 0.09, strength: 0.6, frequency: 659 },
        { time: 0.13, duration: 0.12, strength: 0.9, frequency: 988 },
      ],
      duration: 0.25,
    };
  }
  const events = [0, 1, 2].map((index) => ({ time: index * 0.32, duration: 0.22, strength: 1, frequency: 330 }));
  return { events, duration: 0.86 };
}

/** Séquence pour `navigator.vibrate` : durées alternées vibration, pause, vibration… en ms. */
export function toVibrationSequence(pattern) {
  const sequence = [];
  let cursor = 0;
  for (const event of pattern.events) {
    const start = Math.round(event.time * 1000);
    const length = Math.round(event.duration * 1000);
    if (sequence.length === 0) {
      if (start > 0) sequence.push(0, start);
    } else {
      sequence.push(Math.max(0, start - cursor));
    }
    sequence.push(length);
    cursor = start + length;
  }
  return sequence;
}

function sameAlert(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.band === b.band && a.sector === b.sector && a.level === b.level;
}

class AudioOutput {
  constructor() {
    this.context = null;
    this.master = null;
    this.active = new Set();
  }

  get isRunning() {
    return this.context !== null && this.context.state === 'running';
  }

  /** À appeler dans un geste de l'utilisateur : les navigateurs bloquent le son sinon. */
  unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      try {
        // Sur iOS, évite que le commutateur silencieux coupe les sons du site.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {
        // Réglage facultatif.
      }
      this.context = new AudioContextClass({ latencyHint: 'interactive' });
      this.master = this.context.createGain();
      this.master.connect(this.context.destination);
    }
    if (this.context.state !== 'running') {
      this.context.resume().catch(() => {});
    }
  }

  setVolume(volume) {
    if (this.master) this.master.gain.value = volume;
  }

  play(pattern) {
    if (!this.isRunning) return;
    const origin = this.context.currentTime + 0.02;
    for (const event of pattern.events) this.schedule(event, origin + event.time);
  }

  schedule(event, at) {
    const context = this.context;
    const end = at + event.duration;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const nodes = [oscillator, gain];

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(event.frequency, at);
    if (event.frequencyEnd) oscillator.frequency.exponentialRampToValueAtTime(event.frequencyEnd, end);

    // Enveloppe courte : sans elle, chaque note commence et finit par un claquement.
    const attackEnd = at + 0.008;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(event.strength, attackEnd);
    gain.gain.setValueAtTime(event.strength, Math.max(attackEnd, end - 0.03));
    gain.gain.linearRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    let output = gain;
    if (event.pan !== undefined && typeof context.createStereoPanner === 'function') {
      const panner = context.createStereoPanner();
      panner.pan.value = event.pan;
      gain.connect(panner);
      nodes.push(panner);
      output = panner;
    }
    output.connect(this.master);

    oscillator.onended = () => {
      this.active.delete(oscillator);
      for (const node of nodes) node.disconnect();
    };
    this.active.add(oscillator);
    oscillator.start(at);
    oscillator.stop(end + 0.02);
  }

  /** Coupe immédiatement les notes en cours ou programmées. */
  silence() {
    for (const oscillator of this.active) {
      try {
        oscillator.stop();
      } catch {
        // Déjà arrêté.
      }
    }
  }
}

/**
 * Safari sur iPhone n'expose pas le moteur de vibration aux sites. Cette astuce (bascule d'un
 * interrupteur invisible) produisait un léger « tic » d'iOS 17.4 à 26.4 ; Apple l'a neutralisée
 * ensuite. Elle est tentée au cas où, sans effet de bord si elle ne fait rien.
 */
function iosTick() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  document.head.appendChild(label);
  label.click();
  document.head.removeChild(label);
}

/**
 * Reçoit le danger prioritaire à chaque image analysée et répète le motif correspondant à une
 * cadence qui dépend de la proximité. Une aggravation interrompt le motif en cours pour être
 * signalée immédiatement.
 */
export class FeedbackEngine {
  constructor() {
    this.settings = { sound: true, vibration: true, voice: true, volume: 0.8 };
    this.audio = new AudioOutput();
    this.timer = null;
    this.currentAlert = null;
    this.lastFiredLevel = Level.NONE;
    this.nextFireTime = 0;
    this.noticeEndTime = 0;
    this.lastSpokenAlert = null;
    this.lastSpeechTime = -Infinity;
    this.tickTimers = [];
    /** Appelé avec l'alerte à chaque motif réellement joué (indicateur visuel). */
    this.onPulse = null;
  }

  /** Vrai si le navigateur sait faire vibrer l'appareil (Android ; pas Safari sur iPhone). */
  get canVibrate() {
    return typeof navigator.vibrate === 'function';
  }

  configure(settings) {
    Object.assign(this.settings, settings);
    this.audio.setVolume(this.settings.volume);
  }

  /** À appeler dans un geste de l'utilisateur (appui sur un bouton). */
  unlock() {
    this.audio.unlock();
    this.audio.setVolume(this.settings.volume);
  }

  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), 25);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.currentAlert = null;
    this.lastFiredLevel = Level.NONE;
    this.nextFireTime = 0;
    this.noticeEndTime = 0;
    this.lastSpokenAlert = null;
    this.silence();
  }

  /** Indique le danger à signaler (`null` = plus rien à signaler). */
  update(alert) {
    if (sameAlert(alert, this.currentAlert)) return;
    this.currentAlert = alert;
    this.announce(alert);
    // Un signal système en cours n'est pas coupé : l'alerte sera jouée juste après lui.
    const noticePlaying = performance.now() / 1000 < this.noticeEndTime;
    if (alert && alert.level > this.lastFiredLevel && !noticePlaying) {
      // Aggravation : on coupe le motif en cours et on rejoue sans attendre.
      this.silence();
      this.nextFireTime = 0;
    }
  }

  /** Joue un signal système et laisse le temps de l'entendre avant la prochaine alerte. */
  notify(kind) {
    const pattern = patternForNotice(kind);
    this.emit(pattern);
    this.noticeEndTime = performance.now() / 1000 + pattern.duration + 0.25;
    this.nextFireTime = this.noticeEndTime;
  }

  /**
   * Annonce vocale. `urgent` interrompt l'annonce en cours et ignore le délai minimal ; `force`
   * passe outre le réglage « Annonces vocales » (pannes : la détection n'est plus assurée).
   */
  speak(text, { urgent = false, force = false, minimumInterval = 2.5 } = {}) {
    if (!('speechSynthesis' in window)) return false;
    if (!force && !this.settings.voice) return false;
    const now = performance.now() / 1000;
    if (!urgent && now - this.lastSpeechTime < minimumInterval) return false;
    const interrupts = window.speechSynthesis.speaking || window.speechSynthesis.pending;
    if (interrupts && !urgent) return false;
    this.lastSpeechTime = now;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'fr-FR';
    utterance.rate = 1.1;
    utterance.volume = this.settings.volume;
    if (interrupts) {
      // Safari ignore une annonce lancée dans la foulée d'une annulation : on laisse un court délai.
      window.speechSynthesis.cancel();
      setTimeout(() => window.speechSynthesis.speak(utterance), 80);
    } else {
      window.speechSynthesis.speak(utterance);
    }
    return true;
  }

  tick() {
    // Retente une annonce écartée (trop rapprochée de la précédente, synthèse occupée).
    this.announce(this.currentAlert);
    const now = performance.now() / 1000;
    if (now < this.nextFireTime) return;
    const alert = this.currentAlert;
    if (!alert) {
      // Fin de cycle sans danger : la prochaine alerte sera jouée immédiatement.
      this.lastFiredLevel = Level.NONE;
      return;
    }
    const pattern = patternForAlert(alert);
    this.emit(pattern);
    this.lastFiredLevel = alert.level;
    this.nextFireTime = now + pattern.duration + PAUSE_AFTER[alert.level];
    if (this.onPulse) this.onPulse(alert);
  }

  /** Annonce les dangers marqués, une fois par changement. */
  announce(alert) {
    if (!alert) {
      this.lastSpokenAlert = null;
      return;
    }
    if (!this.settings.voice || alert.level < Level.WARNING || sameAlert(alert, this.lastSpokenAlert)) return;
    if (this.speak(alertMessage(alert), { urgent: alert.level === Level.CRITICAL })) {
      this.lastSpokenAlert = alert;
    }
  }

  emit(pattern) {
    if (this.settings.sound) this.audio.play(pattern);
    if (!this.settings.vibration) return;
    if (this.canVibrate) {
      navigator.vibrate(toVibrationSequence(pattern));
    } else {
      // Les minuteries du motif précédent ont déjà expiré ou ont été annulées par `silence`.
      this.tickTimers = pattern.events.map((event) => setTimeout(iosTick, event.time * 1000));
    }
  }

  silence() {
    this.audio.silence();
    if (this.canVibrate) navigator.vibrate(0);
    for (const timer of this.tickTimers) clearTimeout(timer);
    this.tickTimers = [];
  }
}

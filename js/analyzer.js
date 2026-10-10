// Analyse de la carte de profondeur : 3 secteurs × 3 bandes, un score de danger par zone.

export const Band = Object.freeze({ HEAD: 0, BODY: 1, GROUND: 2 });
export const Sector = Object.freeze({ LEFT: 0, CENTER: 1, RIGHT: 2 });
export const Level = Object.freeze({ NONE: 0, CAUTION: 1, WARNING: 2, CRITICAL: 3 });

export const BANDS = [Band.HEAD, Band.BODY, Band.GROUND];
export const SECTORS = [Sector.LEFT, Sector.CENTER, Sector.RIGHT];
export const ZONE_COUNT = BANDS.length * SECTORS.length;

export function zoneIndex(band, sector) {
  return band * SECTORS.length + sector;
}

/** Les fractions sont exprimées par rapport à l'image (0 = haut / gauche, 1 = bas / droite). */
export function defaultConfig() {
  return {
    headBandEnd: 0.30,
    groundBandStart: 0.68,
    leftSectorEnd: 0.30,
    rightSectorStart: 0.70,
    // Seuils par bande, dans l'ordre tête, corps, sol.
    thresholds: [
      { caution: 0.50, warning: 0.68, critical: 0.85 },
      { caution: 0.55, warning: 0.70, critical: 0.86 },
      { caution: 0.35, warning: 0.60, critical: 0.85 },
    ],
    // Part des pixels d'une zone frontale qui doit être plus lointaine que le score retenu.
    bodyPercentile: 0.85,
    // Amplification du contraste vertical exigé pour un obstacle suspendu.
    headEdgeGain: 2.5,
    // Rupture du sol tenue pour normale, et rupture donnant le score maximal.
    groundStepFloor: 0.10,
    groundStepCeiling: 0.38,
    sensitivity: 1.0,
    // Poids de la nouvelle image dans le lissage temporel (1 = aucun lissage).
    smoothing: 0.5,
    // Marge sous le seuil avant de redescendre d'un niveau.
    hysteresis: 0.06,
  };
}

/** Rectangle d'une zone en coordonnées normalisées de l'image. */
export function zoneRect(config, band, sector) {
  const rows = [
    [0, config.headBandEnd],
    [config.headBandEnd, config.groundBandStart],
    [config.groundBandStart, 1],
  ][band];
  const columns = [
    [0, config.leftSectorEnd],
    [config.leftSectorEnd, config.rightSectorStart],
    [config.rightSectorStart, 1],
  ][sector];
  return { x: columns[0], y: rows[0], width: columns[1] - columns[0], height: rows[1] - rows[0] };
}

const SECTOR_LOCATION = ['à gauche', 'au centre', 'à droite'];
const BAND_SUBJECT = ['Obstacle en hauteur', 'Obstacle', 'Dénivelé'];
const LEVEL_QUALIFIER = ['', '', ' proche', ' très proche'];

export function alertMessage(alert) {
  return `${BAND_SUBJECT[alert.band]}${LEVEL_QUALIFIER[alert.level]} ${SECTOR_LOCATION[alert.sector]}`;
}

export function emptyResult() {
  const zones = [];
  for (let index = 0; index < ZONE_COUNT; index++) zones.push({ score: 0, level: Level.NONE });
  return { zones, primaryAlert: null };
}

/**
 * MiDaS ne fournit qu'une profondeur relative : un sol ou un plafond apparaissent comme un
 * dégradé régulier (proche en bord d'image, lointain vers l'horizon). Chaque bande utilise donc
 * un critère qui ignore ce dégradé :
 * - tête : zone proche qui se détache verticalement de ce qui l'entoure (objet suspendu) ;
 * - corps : proximité brute, la bande médiane ne contenant que du sol lointain ;
 * - sol : rupture brutale dans le dégradé du sol (marche, quai, obstacle bas).
 */
export class ObstacleAnalyzer {
  constructor(config = defaultConfig()) {
    this.config = config;
    this.reset();
  }

  reset() {
    this.smoothedScores = new Float32Array(ZONE_COUNT);
    this.levels = new Uint8Array(ZONE_COUNT);
    this.hasHistory = false;
  }

  /** `values` : proximités dans [0, 1] (1 = le plus proche), rangée par rangée depuis le haut. */
  analyze(values, width, height) {
    if (width < 12 || height < 24 || values.length !== width * height) return emptyResult();

    const config = this.config;
    const headEnd = clamp(Math.floor(height * config.headBandEnd), 4, height - 12);
    const groundStart = clamp(Math.floor(height * config.groundBandStart), headEnd + 4, height - 8);
    const leftEnd = clamp(Math.floor(width * config.leftSectorEnd), 2, width - 4);
    const rightStart = clamp(Math.floor(width * config.rightSectorStart), leftEnd + 2, width - 2);
    const sectorColumns = [[0, leftEnd], [leftEnd, rightStart], [rightStart, width]];

    const rawScores = new Float32Array(ZONE_COUNT);
    for (const sector of SECTORS) {
      const [columnStart, columnEnd] = sectorColumns[sector];
      rawScores[zoneIndex(Band.HEAD, sector)] = overheadScore(
        values, width, height, headEnd, columnStart, columnEnd, config.headEdgeGain,
      );
      rawScores[zoneIndex(Band.BODY, sector)] = proximityScore(
        values, width, headEnd, groundStart, columnStart, columnEnd, config.bodyPercentile,
      );
      rawScores[zoneIndex(Band.GROUND, sector)] = groundBreakScore(
        values, width, groundStart, height, columnStart, columnEnd,
        config.groundStepFloor, config.groundStepCeiling,
      );
    }

    const zones = [];
    for (const band of BANDS) {
      const thresholds = config.thresholds[band];
      for (const sector of SECTORS) {
        const index = zoneIndex(band, sector);
        const scaled = clamp(rawScores[index] * config.sensitivity, 0, 1);
        const previous = this.smoothedScores[index];
        const smoothed = this.hasHistory ? previous + config.smoothing * (scaled - previous) : scaled;
        const level = resolveLevel(smoothed, this.levels[index], thresholds, config.hysteresis);
        this.smoothedScores[index] = smoothed;
        this.levels[index] = level;
        zones.push({ score: smoothed, level });
      }
    }
    this.hasHistory = true;

    return { zones, primaryAlert: primaryAlert(zones) };
  }
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// --- Scores par bande ----------------------------------------------------------------------------

/**
 * Obstacle suspendu : rangée proche qui se détache nettement de ce qui se trouve au-dessus ou
 * au-dessous d'elle. Un plafond ou un ciel donnent un dégradé régulier et un score faible.
 */
function overheadScore(values, width, height, headEnd, columnStart, columnEnd, edgeGain) {
  const reach = Math.max(2, Math.floor(headEnd / 8));
  // On déborde sous la bande pour mesurer le bord inférieur des objets situés en bas de bande.
  const rowEnd = Math.min(height, headEnd + reach);
  const profile = smoothed(rowPeaks(values, width, 0, rowEnd, columnStart, columnEnd));

  let best = 0;
  for (let row = 0; row < headEnd; row++) {
    const value = profile[row];
    const above = profile[Math.max(0, row - reach)];
    const below = profile[Math.min(profile.length - 1, row + reach)];
    const contrast = Math.max(value - above, value - below);
    best = Math.max(best, Math.min(value, contrast * edgeGain));
  }
  return best;
}

/** Proximité de la zone : valeur dépassée par `1 - percentile` des pixels (histogramme). */
function proximityScore(values, width, rowStart, rowEnd, columnStart, columnEnd, percentile) {
  const binCount = 64;
  const histogram = new Uint32Array(binCount);
  for (let row = rowStart; row < rowEnd; row++) {
    const line = row * width;
    for (let column = columnStart; column < columnEnd; column++) {
      const value = values[line + column];
      // Écriture volontairement robuste aux NaN (toutes les comparaisons échouent → 0).
      const bin = value > 0 ? (value < 1 ? Math.floor(value * binCount) : binCount - 1) : 0;
      histogram[bin] += 1;
    }
  }
  const total = (rowEnd - rowStart) * (columnEnd - columnStart);
  if (total <= 0) return 0;

  const target = Math.max(1, Math.floor(total * (1 - percentile)));
  let cumulative = 0;
  for (let bin = binCount - 1; bin >= 0; bin--) {
    cumulative += histogram[bin];
    if (cumulative >= target) return (bin + 0.5) / binCount;
  }
  return 0;
}

/** Rupture du sol : plus grand saut du profil vertical une fois retirée sa pente moyenne. */
function groundBreakScore(values, width, rowStart, rowEnd, columnStart, columnEnd, floor, ceiling) {
  const profile = smoothed(rowMeans(values, width, rowStart, rowEnd, columnStart, columnEnd));
  const count = profile.length;
  if (count < 8 || ceiling <= floor) return 0;

  const reach = Math.max(2, Math.floor(count / 8));
  const slope = (profile[count - 1] - profile[0]) / (count - 1);
  let largestBreak = 0;
  for (let row = 0; row < count - reach; row++) {
    const deviation = Math.abs(profile[row + reach] - profile[row] - slope * reach);
    largestBreak = Math.max(largestBreak, deviation);
  }
  return clamp((largestBreak - floor) / (ceiling - floor), 0, 1);
}

// --- Profils verticaux ---------------------------------------------------------------------------

function rowPeaks(values, width, rowStart, rowEnd, columnStart, columnEnd) {
  const result = new Float32Array(rowEnd - rowStart);
  for (let row = rowStart; row < rowEnd; row++) {
    const line = row * width;
    let peak = 0;
    for (let column = columnStart; column < columnEnd; column++) {
      const value = values[line + column];
      if (value > peak) peak = value;
    }
    result[row - rowStart] = peak;
  }
  return result;
}

function rowMeans(values, width, rowStart, rowEnd, columnStart, columnEnd) {
  const result = new Float32Array(rowEnd - rowStart);
  const columnCount = columnEnd - columnStart;
  for (let row = rowStart; row < rowEnd; row++) {
    const line = row * width;
    let sum = 0;
    for (let column = columnStart; column < columnEnd; column++) sum += values[line + column];
    result[row - rowStart] = sum / columnCount;
  }
  return result;
}

/** Moyenne glissante sur 3 rangées. */
function smoothed(values) {
  if (values.length < 3) return values;
  const result = Float32Array.from(values);
  for (let index = 1; index < values.length - 1; index++) {
    result[index] = (values[index - 1] + values[index] + values[index + 1]) / 3;
  }
  return result;
}

// --- Niveaux et priorité -------------------------------------------------------------------------

function levelFor(score, thresholds) {
  if (score >= thresholds.critical) return Level.CRITICAL;
  if (score >= thresholds.warning) return Level.WARNING;
  if (score >= thresholds.caution) return Level.CAUTION;
  return Level.NONE;
}

function thresholdFor(level, thresholds) {
  return [0, thresholds.caution, thresholds.warning, thresholds.critical][level];
}

function resolveLevel(score, previous, thresholds, hysteresis) {
  const level = levelFor(score, thresholds);
  // Hystérésis : on ne redescend que si le score passe franchement sous le seuil du niveau courant.
  if (level < previous && score >= thresholdFor(previous, thresholds) - hysteresis) return previous;
  return level;
}

/** Le niveau prime ; à niveau égal le centre passe avant les côtés, puis corps > sol > tête. */
function primaryAlert(zones) {
  const bandWeight = [1, 3, 2];
  let best = null;
  let bestPriority = -Infinity;
  for (const band of BANDS) {
    for (const sector of SECTORS) {
      const reading = zones[zoneIndex(band, sector)];
      if (reading.level === Level.NONE) continue;
      let priority = reading.level * 100 + reading.score + bandWeight[band];
      if (sector === Sector.CENTER) priority += 10;
      if (priority > bestPriority) {
        bestPriority = priority;
        best = { band, sector, level: reading.level };
      }
    }
  }
  return best;
}

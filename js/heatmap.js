// Carte de profondeur en fausses couleurs : rouge = proche, bleu = loin.

/** 256 couleurs, octets rangés R, G, B, A en mémoire (machines petit-boutistes). */
const PALETTE = buildPalette();

function buildPalette() {
  const palette = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    const [red, green, blue] = colorFor(index / 255);
    palette[index] = ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0;
  }
  return palette;
}

/** Dégradé bleu → cyan → vert → jaune → rouge. Renvoie [r, g, b] sur 0-255. */
export function colorFor(proximity) {
  let red;
  let green;
  let blue;
  if (proximity < 0.25) {
    red = 0;
    green = 4 * proximity;
    blue = 1;
  } else if (proximity < 0.5) {
    red = 0;
    green = 1;
    blue = 1 - 4 * (proximity - 0.25);
  } else if (proximity < 0.75) {
    red = 4 * (proximity - 0.5);
    green = 1;
    blue = 0;
  } else {
    red = 1;
    green = 1 - 4 * (proximity - 0.75);
    blue = 0;
  }
  return [red, green, blue].map((channel) => Math.round(Math.min(Math.max(channel, 0), 1) * 255));
}

/** Écrit la carte dans `pixels` (Uint8ClampedArray RGBA de même taille, par exemple ImageData.data). */
export function renderHeatmap(values, pixels) {
  const target = new Uint32Array(pixels.buffer, pixels.byteOffset, values.length);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    // Robuste aux NaN : toutes les comparaisons échouent et donnent l'indice 0.
    const level = value > 0 ? (value < 1 ? Math.floor(value * 255) : 255) : 0;
    target[index] = PALETTE[level];
  }
}

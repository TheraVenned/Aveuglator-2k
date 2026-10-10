// Rendu de la carte de profondeur, telle que le modèle la « voit ».

/**
 * 256 teintes, octets rangés R, G, B, A en mémoire (machines petit-boutistes).
 * `colorFor(proximité)` renvoie [r, g, b] sur 0-255.
 */
function buildPalette(colorFor) {
  const palette = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    const [red, green, blue] = colorFor(index / 255);
    palette[index] = ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0;
  }
  return palette;
}

/** Ombres : le lointain est blanc, ce qui est proche se détache en silhouette sombre. */
export function shadowColor(proximity) {
  // Exposant inférieur à 1 : les plans intermédiaires s'assombrissent tôt, les silhouettes
  // restent lisibles même loin du premier plan.
  const shade = Math.round(246 - 222 * Math.pow(proximity, 0.8));
  return [shade, shade, shade];
}

/** Fausses couleurs : bleu (loin) → cyan → vert → jaune → rouge (proche). */
export function thermalColor(proximity) {
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

const PALETTES = {
  shadow: buildPalette(shadowColor),
  thermal: buildPalette(thermalColor),
};

/**
 * Écrit la carte dans `pixels` (Uint8ClampedArray RGBA de même taille, par exemple ImageData.data).
 * `style` : 'shadow' (par défaut) ou 'thermal'.
 */
export function renderDepth(values, pixels, style = 'shadow') {
  const palette = PALETTES[style] || PALETTES.shadow;
  const target = new Uint32Array(pixels.buffer, pixels.byteOffset, values.length);
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    // Robuste aux NaN : toutes les comparaisons échouent et donnent l'indice 0.
    const level = value > 0 ? (value < 1 ? Math.floor(value * 255) : 255) : 0;
    target[index] = palette[level];
  }
}

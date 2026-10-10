// Affichage de la vision du modèle, en plein cadre.
//
// MiDaS produit une carte de 256 × 256, floue une fois agrandie. Elle est donc affinée sur la
// carte graphique à l'aide de l'image de la caméra, qui sert uniquement de guide :
// - agrandissement « bilatéral joint » : la profondeur ne se mélange pas à travers un contour
//   visible dans l'image, les bords des objets redeviennent nets ;
// - ajout du relief fin de l'image (textures, arêtes) par-dessus la teinte de profondeur.
// La teinte reste celle du modèle : lointain clair, proche sombre.

import { renderDepth } from './heatmap.js';

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  // Rangée 0 des textures = haut de l'image.
  v_uv = vec2(a_position.x * 0.5 + 0.5, 0.5 - a_position.y * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_depth;
uniform sampler2D u_guide;
uniform vec2 u_depthSize;
uniform vec2 u_scale;
uniform float u_hasGuide;

float luma(vec2 p) {
  return dot(texture2D(u_guide, p).rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec2 uv = (v_uv - 0.5) * u_scale + 0.5;
  vec2 texel = 1.0 / u_depthSize;
  vec2 base = (floor(uv * u_depthSize - 0.5) + 0.5) * texel;
  float here = luma(uv);

  float sum = 0.0;
  float weights = 0.0;
  float around = 0.0;
  for (int j = -1; j <= 2; j++) {
    for (int i = -1; i <= 2; i++) {
      vec2 p = base + vec2(float(i), float(j)) * texel;
      float guide = luma(p);
      vec2 delta = (uv - p) * u_depthSize;
      float spatial = exp(-dot(delta, delta) * 0.5);
      float difference = (here - guide) * u_hasGuide;
      // Un voisin d'une autre luminosité appartient sans doute à un autre objet : il pèse peu.
      float w = spatial * exp(-difference * difference * 160.0) + 0.0001;
      sum += w * texture2D(u_depth, p).r;
      weights += w;
      around += guide;
    }
  }
  float depth = sum / weights;

  float shade = mix(0.96, 0.06, pow(depth, 0.8));
  // Relief fin de la scène, plus marqué sur ce qui est proche.
  float detail = (here - around / 16.0) * u_hasGuide;
  shade += detail * (0.35 + 0.5 * depth);
  // Léger grain : évite les paliers visibles dans les dégradés.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  shade += grain / 255.0;
  gl_FragColor = vec4(vec3(clamp(shade, 0.0, 1.0)), 1.0);
}`;

/** Part de la nouvelle carte dans l'image affichée : le reste vient de la précédente (anti-scintillement). */
const TEMPORAL_WEIGHT = 0.65;
/** Au-delà, la densité de pixels n'apporte plus rien de visible et coûte cher. */
const MAX_PIXEL_RATIO = 2;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || 'shader invalide');
  }
  return shader;
}

function createTexture(gl, filter) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

/** Échelle des coordonnées de texture pour remplir le cadre en rognant ce qui dépasse. */
export function coverScale(frameAspect, viewAspect) {
  return viewAspect > frameAspect ? [1, frameAspect / viewAspect] : [viewAspect / frameAspect, 1];
}

export class DepthRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.smoothed = null;
    this.bytes = null;
    this.gl = null;
    this.context2d = null;
    try {
      this.setupWebGL();
    } catch (error) {
      // Sans WebGL : agrandissement simple de la carte, sans affinage.
      console.warn('Affinage du rendu indisponible.', error);
      this.gl = null;
      this.context2d = canvas.getContext('2d');
      this.scratch = document.createElement('canvas');
    }
  }

  setupWebGL() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) throw new Error('WebGL absent');
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || 'programme invalide');
    }
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.depthTexture = createTexture(gl, gl.NEAREST);
    this.guideTexture = createTexture(gl, gl.LINEAR);
    this.uniforms = {
      depthSize: gl.getUniformLocation(program, 'u_depthSize'),
      scale: gl.getUniformLocation(program, 'u_scale'),
      hasGuide: gl.getUniformLocation(program, 'u_hasGuide'),
    };
    gl.uniform1i(gl.getUniformLocation(program, 'u_depth'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_guide'), 1);
    this.gl = gl;
  }

  /** Ajuste la définition du canevas à sa taille à l'écran. */
  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Oublie l'image précédente (nouveau démarrage, changement de caméra). */
  reset() {
    this.smoothed = null;
  }

  /**
   * @param values proximités dans [0, 1], rangée par rangée depuis le haut
   * @param guide canevas contenant l'image de la caméra dont la carte est issue, ou null
   * @param frameAspect largeur / hauteur de l'image de la caméra
   */
  draw(values, width, height, guide, frameAspect) {
    if (!this.smoothed || this.smoothed.length !== values.length) {
      this.smoothed = Float32Array.from(values);
      this.bytes = new Uint8Array(values.length);
    } else {
      for (let index = 0; index < values.length; index++) {
        this.smoothed[index] += TEMPORAL_WEIGHT * (values[index] - this.smoothed[index]);
      }
    }
    this.resize();
    const scale = coverScale(frameAspect, this.canvas.width / this.canvas.height);
    if (this.gl) this.drawWebGL(width, height, guide, scale);
    else this.draw2d(width, height, scale);
  }

  drawWebGL(width, height, guide, scale) {
    const gl = this.gl;
    for (let index = 0; index < this.smoothed.length; index++) {
      this.bytes[index] = this.smoothed[index] * 255;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.bytes);

    const hasGuide = guide !== null && guide.width > 0 && guide.height > 0;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.guideTexture);
    if (hasGuide) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, guide);

    gl.uniform2f(this.uniforms.depthSize, width, height);
    gl.uniform2f(this.uniforms.scale, scale[0], scale[1]);
    gl.uniform1f(this.uniforms.hasGuide, hasGuide ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw2d(width, height, scale) {
    this.scratch.width = width;
    this.scratch.height = height;
    const scratchContext = this.scratch.getContext('2d');
    const image = scratchContext.createImageData(width, height);
    renderDepth(this.smoothed, image.data);
    scratchContext.putImageData(image, 0, 0);
    const sourceWidth = width * scale[0];
    const sourceHeight = height * scale[1];
    this.context2d.imageSmoothingQuality = 'high';
    this.context2d.drawImage(
      this.scratch,
      (width - sourceWidth) / 2, (height - sourceHeight) / 2, sourceWidth, sourceHeight,
      0, 0, this.canvas.width, this.canvas.height,
    );
  }

  /** Efface l'écran (noir). */
  clear() {
    this.reset();
    if (this.gl) {
      this.gl.clearColor(0, 0, 0, 1);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    } else {
      this.context2d.fillStyle = '#000';
      this.context2d.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }
}

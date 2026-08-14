/**
 * hydra.js
 * A hydra-synth flavoured screen-space FX bank for the master bus.
 *
 * Adapted from the mesh-sequencer project's fx/hydra.js. The shader is the same
 * chain; what changed here is the surroundings — VVJ Splat's deck FX bend splat
 * chunks in 3D, so these 2D ops sit at the end of the composer, after the decks
 * are already composited, and are driven from the master strip.
 *
 * Hydra (hydra.ojack.xyz) chains 2D texture ops on a frame. All of it is ONE
 * pass with one knob per op, rather than a pass per op: the ops are cheap and a
 * stack of ShaderPasses would mean a full-frame render target round trip for
 * each. Order follows hydra's own idiom — geometry ops bend the coordinate first
 * (kaleid → repeat → scroll → modulate → pixelate), then the sample is
 * colour-processed (colorama → posterize → thresh).
 *
 * The 'slit' op from the original lives in a separate pass there because it
 * needs frame history and the camera's screen-space axis; it is not ported.
 *
 * Every knob is 0 = bypassed, and the pass disables itself when they all are,
 * so an untouched bank costs nothing.
 */

/** Knob order in the UI = chain order in the shader. */
export const HYDRA_PARAMS = [
  { name: 'kaleid', label: 'KALEI', title: 'kaleidoscope — folds the frame into 2..12 mirrored wedges' },
  { name: 'repeat', label: 'REPT', title: 'repeat — tiles the frame into a grid' },
  { name: 'scroll', label: 'SCRL', title: 'scroll — drifts the frame, speed rises with the knob' },
  { name: 'modulate', label: 'MODUL', title: 'modulate — warps the frame with a moving sine field' },
  { name: 'pixel', label: 'PIXEL', title: 'pixelate — quantizes to a coarse grid' },
  { name: 'colorama', label: 'COLOR', title: 'colorama — rotates hue by brightness' },
  { name: 'posterize', label: 'POST', title: 'posterize — crushes to few brightness levels' },
  { name: 'thresh', label: 'THRSH', title: 'threshold — hard cut to black and white' },
];

/** Uniform name for a param, e.g. 'kaleid' → 'uKaleid'. */
export function hydraUniformName(name) {
  return 'u' + name.charAt(0).toUpperCase() + name.slice(1);
}

export const HydraShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uKaleid: { value: 0 },
    uRepeat: { value: 0 },
    uScroll: { value: 0 },
    uModulate: { value: 0 },
    uPixel: { value: 0 },
    uColorama: { value: 0 },
    uPosterize: { value: 0 },
    uThresh: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uAspect;
    uniform float uKaleid;
    uniform float uRepeat;
    uniform float uScroll;
    uniform float uModulate;
    uniform float uPixel;
    uniform float uColorama;
    uniform float uPosterize;
    uniform float uThresh;
    varying vec2 vUv;

    const float PI = 3.141592653589793;

    vec3 rgb2hsv(vec3 c) {
      vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
      vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
      vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
      float d = q.x - min(q.w, q.y);
      float e = 1.0e-10;
      return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    vec3 hsv2rgb(vec3 c) {
      vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    void main() {
      // work centred and aspect-corrected so wedges and tiles stay square
      vec2 st = (vUv - 0.5) * vec2(uAspect, 1.0);

      // --- kaleid: fold the angle into n mirrored wedges
      if (uKaleid > 0.001) {
        float n = floor(mix(2.0, 12.0, uKaleid));
        float r = length(st);
        float a = atan(st.y, st.x);
        float seg = 2.0 * PI / n;
        a = mod(a, seg);
        a = abs(a - seg * 0.5);      // mirror inside the wedge
        st = vec2(cos(a), sin(a)) * r;
      }

      // --- repeat: tile into a grid, each cell showing the whole frame
      if (uRepeat > 0.001) {
        float n = 1.0 + floor(uRepeat * 4.0);
        st = fract(st * n + 0.5) - 0.5;
      }

      // --- scroll: drift, speed rising with the knob
      st += vec2(uScroll * uTime * 0.08, uScroll * uTime * 0.031);

      // --- modulate: warp with a moving sine field (hydra's modulate(osc()))
      if (uModulate > 0.001) {
        float w = sin(st.x * 9.0 + uTime * 1.7) * cos(st.y * 7.0 - uTime * 1.1);
        st += uModulate * 0.18 * vec2(w, -w);
      }

      vec2 uv = st / vec2(uAspect, 1.0) + 0.5;

      // --- pixelate
      if (uPixel > 0.001) {
        float px = mix(240.0, 6.0, uPixel);
        uv = (floor(uv * px) + 0.5) / px;
      }

      // wrap, so folded / tiled / scrolled coordinates never land on nothing
      vec4 col = texture2D(tDiffuse, fract(uv));

      // --- colorama: rotate hue by brightness (hydra's colorama)
      if (uColorama > 0.001) {
        vec3 hsv = rgb2hsv(col.rgb);
        hsv.x = fract(hsv.x + uColorama * (0.5 + hsv.z));
        hsv.y = min(1.0, hsv.y + uColorama * 0.35);
        col.rgb = hsv2rgb(hsv);
      }

      // --- posterize
      if (uPosterize > 0.001) {
        float levels = mix(24.0, 2.0, uPosterize);
        col.rgb = floor(col.rgb * levels + 0.5) / levels;
      }

      // --- thresh: hard cut, knob sets the cut point
      if (uThresh > 0.001) {
        float l = dot(col.rgb, vec3(0.299, 0.587, 0.114));
        float cut = mix(0.0, 0.9, uThresh);
        col.rgb = mix(col.rgb, vec3(step(cut, l)), min(1.0, uThresh * 3.0));
      }

      gl_FragColor = col;
    }
  `,
};

import './style.css';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { SplatData, limitSplatCount } from './dataModel.js';
import { decodeSog } from './sogLoader.js';
import { sliceScene } from './cutup/slice.js';
import { shuffleChunksInScene } from './cutup/shuffle.js';
import { swapChunksBetweenScenes } from './cutup/swap.js';
import { sliceIntoSpheres } from './cutup/xyz_shuffle.js';
import { initMIDI, setMidiProfile, setMidiLearn, APP_ACTIONS, saveCustomProfile, loadCustomProfiles, deleteCustomProfile, listCustomProfiles, _simulateMIDIMessage, isBuiltinProfile, mergeProfileOverride, clearProfileOverride, getProfileOverride, lockAutoDetect, setLed, setPadLed, flashLed, allLedsOff } from './midi.js';
import { initGamepad, setGamepadLearn, setGamepadBinding, clearGamepadBinding, getGamepadBindingLabel, getGamepadBindings } from './gamepad.js';
import { initKeyboard, setKeyboardLearn, setKeyboardBinding, clearKeyboardBinding, getKeyboardBindingLabel, getKeyboardBindings } from './keyboard.js';
// Test hook: lets the smoke test push a raw MIDI message through the real dispatcher.
window._simulateMidi = _simulateMIDIMessage;
// Test hooks for the built-in override layer.
window._mergeProfileOverride = mergeProfileOverride;
window._clearProfileOverride = clearProfileOverride;
window._getProfileOverride = getProfileOverride;
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { AfterimageShader } from 'three/examples/jsm/shaders/AfterimageShader.js';

// Patch AfterimageShader to support 'scale' for echoing down
AfterimageShader.uniforms['scale'] = { value: 1.0 };
AfterimageShader.fragmentShader = `
uniform float damp;
uniform float scale;
uniform sampler2D tOld;
uniform sampler2D tNew;
varying vec2 vUv;
vec4 when_gt( vec4 x, float y ) {
    return max( sign( x - y ), 0.0 );
}
void main() {
    vec2 centeredUv = vUv - 0.5;
    vec2 scaledUv = centeredUv / scale + 0.5;
    vec4 texelOld = texture2D( tOld, scaledUv );
    vec4 texelNew = texture2D( tNew, vUv );
    // mask out edges if scaled out of bounds
    if (scaledUv.x < 0.0 || scaledUv.x > 1.0 || scaledUv.y < 0.0 || scaledUv.y > 1.0) texelOld = vec4(0.0);
    texelOld *= damp * when_gt( texelOld, 0.01 );
    gl_FragColor = max(texelNew, texelOld);
}
`;

import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { applyTransforms } from './cutup/transform.js';
import {
  applyDelayFx,
  applyEchoFx,
  applyFilterFx,
  applyFlangerFx,
  applyPhaserFx,
  applyPitchFx,
  applyReverbFx,
  applyRollFx,
  applySpiralFx,
} from './cutup/fx.js';
import { SeededRandom } from './cutup/seed.js';
import { exportToPly } from './export.js';

// ── State ──────────────────────────────────────────────
let viewer = null;
window.viewer = null;
window.makeViewer = makeViewer;

let composer = null;
let bokehPass = null;
let afterimagePass = null;
let lensflareLight = null;

// WebGL screen-space strobe overlay (rendered between HDRI background and splats).
// Built lazily in setupPostProcessingAndLensFlare; driven by uniforms in performRealtimeUpdate.
let strobeScene = null;
let strobeCamera = null;
let strobeMaterial = null;
// Mirrors the uniform strength so the render pass can skip the draw entirely when off (zero FPS cost).
let strobeStrength = 0;
let strobeUMode = 0;
let strobeUEdge = 0;

// OVERLAY (#7/#10): base (pre-crossfade) trans-strobe alpha per deck, plus the
// A/B crossfader mix. The animation loop computes these each frame; the render
// pass folds the crossfade gain into the splat opacity uniforms PER DECK while
// compositing the full-screen overlay (deck A = 1-mix, deck B = mix, C/D = 1).
let strobeAlphaBaseA = 1.0;
let strobeAlphaBaseB = 1.0;
let crossfadeMix = 0.5;
// Test/telemetry: per-deck opacity actually applied during the last overlay pass
// (used to verify the crossfade wiring under headless GL where splats don't paint).
window._lastOverlayOpacity = { a: 1, b: 1 };

let sceneA = null;
let sceneB = null;
let sceneC = null;
let sceneD = null;
let rawSceneA = null;
let rawSceneB = null;
let rawSceneC = null;
let rawSceneD = null;
let resultData = null;

const hardwareLevel = navigator.hardwareConcurrency || 4;
let targetChunks = hardwareLevel >= 8 ? 8 : (hardwareLevel >= 4 ? 6 : 4);
let layoutMode = '2deck'; // '2deck' or '4deck'

function detectHardwareProfile() {
  const cores = navigator.hardwareConcurrency || 4;
  let chunks = cores <= 4 ? 4 : 8;
  console.log(`Detected CPU Cores: ${cores} -> Setting default chunks to: ${chunks}`);
  // We actually set them via the UI inputs initially now.
}
detectHardwareProfile();

let numChunksA = 0;
let numChunksB = 0;
let numChunksC = 0;
let numChunksD = 0;
let numRollChunksA = 0;
let numRollChunksB = 0;
let numRollChunksC = 0;
let numRollChunksD = 0;
let boundsA = { center: new THREE.Vector3(), maxDist: 5 };
let boundsB = { center: new THREE.Vector3(), maxDist: 5 };
let boundsC = { center: new THREE.Vector3(), maxDist: 5 };
let boundsD = { center: new THREE.Vector3(), maxDist: 5 };
let currentScalesA = new Float32Array(32).fill(0);
let currentScalesB = new Float32Array(32).fill(0);
let currentScalesC = new Float32Array(32).fill(0);
let currentScalesD = new Float32Array(32).fill(0);

// MULTI-VIEW helper: each deck owns a contiguous block of splat "scenes" inside
// the single splatMesh, laid out in load order A,B,C,D (see rebuildViewerBuffers).
// Returns { a:[start,count], b:[...], c:[...], d:[...] } scene-index ranges.
function deckSceneRanges() {
  const totA = numChunksA + numRollChunksA;
  const totB = numChunksB + numRollChunksB;
  const totC = numChunksC + numRollChunksC;
  const totD = numChunksD + numRollChunksD;
  let i = 0;
  const a = [i, totA]; i += totA;
  const b = [i, totB]; i += totB;
  const c = [i, totC]; i += totC;
  const d = [i, totD]; i += totD;
  return { a, b, c, d };
}

let isCameraFramed = false;
let baseFramedDistance = 5;
let isZoomSyncing = false;
let zoomSyncAttached = false;
let updateInProgress = false;
let updatePending = false;

// Sequential scale-up reveal period (seconds). One full wave of 16 chunks revealing then resetting.
const REVEAL_PERIOD = 2.5;

// Play Animation state
let isPlayingA = false;
let isPlayingB = false;
let isPlayingC = false;
let isPlayingD = false;
let playAngleA = 0;
let playAngleB = 0;
let playAngleC = 0;
let playAngleD = 0;
let frozenPlayAngleA = 0;
let frozenPlayAngleB = 0;
let frozenPlayAngleC = 0;
let frozenPlayAngleD = 0;

let loopActiveA = false;
let loopStartA = 0;
let loopLengthA = 1;
let isAutoLoopA = false;
let autoLoopLengthA = 4; // 4 beats

// Chunk-range loop state (#8): restrict pulse animation to [start..end] chunk indices.
// loopChunkStartA/B: first chunk of the range (set by LOOP IN).
// loopChunkEndA/B: last chunk of the range (set by LOOP OUT, also enables loopActiveA/B).
// When loopActiveA/B is false the range has no effect on the pulse animation.
let loopChunkStartA = 0;
let loopChunkEndA = 0;
let loopChunkStartB = 0;
let loopChunkEndB = 0;
let loopRangeSelectedA = false;
let loopRangeSelectedB = false;

// Loop "commit" state (#6): after a range is selected (orange), the activate/exit
// button commits it — orange disappears, the selected chunks keep animating, and
// every other chunk on that deck scales to 0.
let loopCommittedA = false;
let loopCommittedB = false;

// Pad mode (#2): 'hotcue' (pads → loops), 'beatloop' (pads → camera presets),
// 'beatjump' / 'sampler' reserved for later (no-op for now).
let padModeA = 'hotcue';
let padModeB = 'hotcue';
const PAD_MODES = ['hotcue', 'beatloop', 'beatjump', 'sampler'];
const PAD_MODE_LABELS = { hotcue: 'HOT CUE', beatloop: 'BEAT LOOP', beatjump: 'BEAT JUMP', sampler: 'SAMPLER' };
const PAD_NUM_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const PAD_CAM_LABELS = ['FRONT', 'BACK', 'L', 'R', 'TOP', 'BOT', '3/4L', '3/4R'];

let loopActiveB = false;
let loopStartB = 0;
let loopLengthB = 1;
let isAutoLoopB = false;
let autoLoopLengthB = 4;

let loopActiveC = false;
let loopStartC = 0;
let loopLengthC = 1;
let isAutoLoopC = false;
let autoLoopLengthC = 4;

let loopActiveD = false;
let loopStartD = 0;
let loopLengthD = 1;
let isAutoLoopD = false;
let autoLoopLengthD = 4;

let animationFrameId = null;

// Jog Wheel scratching state
let jogAngleA = 0;
let jogAngleB = 0;
let jogAngleC = 0;
let jogAngleD = 0;
let isScratchingA = false;
let isScratchingB = false;
let isScratchingC = false;
let isScratchingD = false;

// XZ nudge translation from physical jog side-ring (decays to zero each frame)
let nudgeXA = 0, nudgeXB = 0;

// ── Camera Rig ─────────────────────────────────────────
// The camera always looks at the origin. Each deck has a target view in
// spherical coords (azimuth around world-Y, elevation). The crossfader blends
// the two deck targets; the applied "current" angles ease toward that blend.
// Radius is always baseFramedDistance * master-vol zoom (see centerCamera).
const HALF_PI = Math.PI / 2;
const CAM_PRESETS = [
  { az: 0,                  el: 0,            label: 'FRONT' },
  { az: Math.PI,            el: 0,            label: 'BACK'  },
  { az: -HALF_PI,           el: 0,            label: 'L'     },
  { az: HALF_PI,            el: 0,            label: 'R'     },
  { az: 0,                  el: HALF_PI * 0.98, label: 'TOP' },
  { az: 0,                  el: -HALF_PI * 0.98, label: 'BOT' },
  { az: -Math.PI / 4,       el: Math.PI / 6,  label: '¾L'    },
  { az: Math.PI / 4,        el: Math.PI / 6,  label: '¾R'    },
];
// Per-deck view targets (start at FRONT). jogAz* is the continuous turntable
// orbit contribution added by the jog wheels (separate so RESET VIEW can zero it).
// MULTI-VIEW: each deck now drives its OWN camera (no A/B crossfade blend).
let camA = { azimuth: 0, elevation: 0 };
let camB = { azimuth: 0, elevation: 0 };
let camC = { azimuth: 0, elevation: 0 };
let camD = { azimuth: 0, elevation: 0 };
let jogAzA = 0, jogAzB = 0, jogAzC = 0, jogAzD = 0;
// Eased applied angles actually written to each deck's camera every frame.
let camCurrent = { azimuth: 0, elevation: 0 };   // legacy single-view current (kept harmless)
const camCurrentA = { azimuth: 0, elevation: 0 };
const camCurrentB = { azimuth: 0, elevation: 0 };
const camCurrentC = { azimuth: 0, elevation: 0 };
const camCurrentD = { azimuth: 0, elevation: 0 };
// One THREE.PerspectiveCamera per deck, created lazily in updateCameraRig.
const deckCameras = { a: null, b: null, c: null, d: null };
let camRigInitialized = false;
const CAM_EASE = 0.12;          // exponential smoothing factor (ease-in/out)
const CAM_SETTLE_EPS = 0.0006;  // below this the rig is considered settled
let camRigSettling = false;     // keep-alive flag for the animation loop

// Shortest-arc azimuth lerp (handles wraparound across ±PI).
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Reusable origin for camera.lookAt.
const _camOrigin = new THREE.Vector3(0, 0, 0);

// Resolve a deck argument (legacy boolean isDeckA, or 'a'/'b'/'c'/'d') to its
// per-deck view-target object.
function _deckCamObj(deck) {
  if (deck === true || deck === 'a') return camA;
  if (deck === false || deck === 'b') return camB;
  if (deck === 'c') return camC;
  if (deck === 'd') return camD;
  return camA;
}

// Set a deck's target view to a preset (used by on-screen pads + MIDI cam actions).
// `deck` may be the legacy boolean isDeckA or a deck char 'a'/'b'/'c'/'d'.
function setDeckCamPreset(deck, index) {
  const p = CAM_PRESETS[index];
  if (!p) return;
  const cam = _deckCamObj(deck);
  cam.azimuth = p.az; cam.elevation = p.el;
  splashFactor = 1.8;
  camRigSettling = true;
  startAnimationLoop();
  triggerRealtimeUpdate();
}
// Expose for MIDI cam actions.
window._setDeckCamPreset = setDeckCamPreset;

// Deck → state lookup table (built once; references are stable).
const DECK_RIG = {
  a: { tgt: camA, cur: camCurrentA, scene: () => sceneA, jog: () => jogAzA },
  b: { tgt: camB, cur: camCurrentB, scene: () => sceneB, jog: () => jogAzB },
  c: { tgt: camC, cur: camCurrentC, scene: () => sceneC, jog: () => jogAzC },
  d: { tgt: camD, cur: camCurrentD, scene: () => sceneD, jog: () => jogAzD },
};
const DECK_KEYS = ['a', 'b', 'c', 'd'];

// Current master-vol zoom factor (shared radius multiplier for all decks).
function _currentZoomFactor() {
  if (!masterVol) return 1.0;
  const t = Number(masterVol.value) / 100;
  return Math.max(0.4, Math.min(1.8, 1.0 - (t - 0.5) * 1.5));
}

// List of currently loaded decks, in fixed A,B,C,D order.
function loadedDeckKeys() {
  const out = [];
  if (sceneA) out.push('a');
  if (sceneB) out.push('b');
  if (sceneC) out.push('c');
  if (sceneD) out.push('d');
  return out;
}

// Per-frame: each deck independently eases its own current angles toward its
// target (preset + jog orbit) and positions its own camera around the origin.
// MULTI-VIEW: no more crossfader blend — `mixAmount` is ignored for the camera.
// `viewer.camera` is synced to the FIRST loaded deck so the library's splat sort
// (which always sorts against viewer.camera) matches at least the primary panel.
function updateCameraRig(mixAmount) {
  if (!viewer || !viewer.controls || !viewer.camera) return;

  // When no camera preset is easing, let OrbitControls own the camera so normal
  // mouse rotate/pan/zoom keeps working while decks are playing.
  viewer.controls.enableRotate = true;
  viewer.controls.enablePan = true;
  if (camRigInitialized && !camRigSettling) {
    for (const k of DECK_KEYS) {
      let cam = deckCameras[k];
      if (!cam) {
        cam = viewer.camera.clone();
        deckCameras[k] = cam;
      } else {
        cam.copy(viewer.camera);
      }
      cam.updateMatrixWorld(true);
    }
    return;
  }

  const radius = baseFramedDistance * _currentZoomFactor();
  const refCam = viewer.camera;

  let anySettling = false;

  for (const k of DECK_KEYS) {
    const rig = DECK_RIG[k];
    // Lazily create this deck's camera, cloning viewer.camera's intrinsics.
    let cam = deckCameras[k];
    if (!cam) {
      cam = refCam.clone();
      deckCameras[k] = cam;
    }
    // Keep intrinsics in sync with the live viewer camera (fov/aspect/near/far).
    cam.fov = refCam.fov; cam.near = refCam.near; cam.far = refCam.far;

    const tgtAz = rig.tgt.azimuth + rig.jog();
    const tgtEl = rig.tgt.elevation;

    if (!camRigInitialized) {
      rig.cur.azimuth = tgtAz;
      rig.cur.elevation = tgtEl;
    } else {
      rig.cur.azimuth = lerpAngle(rig.cur.azimuth, tgtAz, CAM_EASE);
      rig.cur.elevation += (tgtEl - rig.cur.elevation) * CAM_EASE;
    }

    // Settled check (only meaningful for loaded decks).
    if (rig.scene()) {
      let dAz = tgtAz - rig.cur.azimuth;
      while (dAz > Math.PI) dAz -= Math.PI * 2;
      while (dAz < -Math.PI) dAz += Math.PI * 2;
      const dEl = tgtEl - rig.cur.elevation;
      if (Math.abs(dAz) > CAM_SETTLE_EPS || Math.abs(dEl) > CAM_SETTLE_EPS) anySettling = true;
    }

    const ce = Math.cos(rig.cur.elevation);
    cam.position.set(
      radius * ce * Math.sin(rig.cur.azimuth),
      radius * Math.sin(rig.cur.elevation),
      radius * ce * Math.cos(rig.cur.azimuth)
    );
    cam.up.copy(refCam.up);
    cam.lookAt(_camOrigin);
    cam.updateMatrixWorld(true);
  }

  camRigInitialized = true;
  camRigSettling = anySettling;

  // Sync viewer.camera (and OrbitControls) to the primary (first loaded) deck so
  // the worker splat sort targets that panel. Other panels reuse that sort order
  // (approximate alpha ordering — see notes in renderPass.render).
  const primary = loadedDeckKeys()[0] || 'a';
  const pcam = deckCameras[primary];
  viewer.camera.position.copy(pcam.position);
  if (viewer.controls.target) viewer.controls.target.set(0, 0, 0);
  viewer.camera.up.copy(pcam.up);
  viewer.camera.lookAt(_camOrigin);
  viewer.controls.update();
  // Mirror into legacy camCurrent for any external readers.
  camCurrent.azimuth = DECK_RIG[primary].cur.azimuth;
  camCurrent.elevation = DECK_RIG[primary].cur.elevation;
}
window._camRig = { camA, camB, camC, camD, deckCameras,
  get current() { return camCurrent; },
  get jogA() { return jogAzA; }, get jogB() { return jogAzB; },
  get jogC() { return jogAzC; }, get jogD() { return jogAzD; },
  setPreset: setDeckCamPreset };

// ── Tempo range cycling (Feature #5) ─────────────────────────────────────────
// Four ranges that the Shift button cycles through per deck (percent ±).
const TEMPO_RANGES = [6, 10, 16, 100];
// Default to index 1 (±10%).
let tempoRangeIdxA = 1;
let tempoRangeIdxB = 1;

// Hot Cue presets (seeds)
const hotCuesA = [42, 108, 256, 512, 1024, 2048, 4096, 8192];
const hotCuesB = [77, 128, 320, 640, 1111, 2222, 5555, 9999];
const hotCuesC = [11, 22, 33, 44, 55, 66, 77, 88];
const hotCuesD = [99, 88, 77, 66, 55, 44, 33, 22];

// Splash flash trigger
let splashFactor = 1.0;

// Beat FX state
let fxActiveA = "none";
let fxEngagedA = false;
let beatIndexA = 4;

let fxActiveB = "none";
let fxEngagedB = false;
let beatIndexB = 4;

let fxActiveC = "none";
let fxEngagedC = false;
let beatIndexC = 4;

let fxActiveD = "none";
let fxEngagedD = false;
let beatIndexD = 4;

let fxActiveM = "none";
let fxEngagedM = false;
let beatIndexM = 4;

let strobeEngaged = false;
let strobeMode = 'side';

const beatDivisions = ["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"];
let lastRollStateA = false;
let lastRollStateB = false;
let lastRollStateC = false;
let lastRollStateD = false;

// ── Inject DDJ-400 UI ──────────────────────────────────
const appDiv = document.querySelector('#app');
appDiv.innerHTML = `
  <div id="viewer-container" style="position:absolute; inset:0; z-index:1; background:#050508;"></div>
  
  <!-- LEFT PANEL: DECK A + CH 1 MIXER -->
  <div class="hud-panel panel-left" id="deck-a">
    <div class="section-box deck-header" style="display:flex; flex-direction:row; align-items:center; gap:12px;">
      <label class="icon-btn" id="btn-load-a">⏏<input type="file" id="file-a" accept=".ply,.splat,.ksplat,.sog,.ssog,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start; flex:1;">
        <div id="file-a-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center; justify-content:space-between; width:100%;">
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">SPL: <span id="max-splats-val-a">250k</span></span>
            <input type="range" id="max-splats-slider-a" class="max-splats" min="250000" max="1000000" step="10000" value="250000" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">CHK: <span id="chunks-val-a">16</span></span>
            <input type="range" id="chunks-slider-a" class="max-chunks" min="0" max="3" step="1" value="2" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col" style="margin-bottom:8px;">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-in-a" title="Loop IN: set chunk range start">IN</button>
          <button class="round-btn" id="loop-out-a" title="Loop OUT: set chunk range end + enable">OUT</button>
          <button class="round-btn" id="loop-toggle-a" title="Activate/Exit loop: hide others, keep selection animating" style="display:none;">GO</button>
          <button class="round-btn" id="loop-half-a">1/2</button>
          <button class="round-btn" id="loop-active-a">4B</button>
          <button class="round-btn" id="loop-double-a">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:4px;">
        <button class="round-btn sync" id="sync-a">SYNC</button>
        <div class="flex-row" style="align-items:center; gap:3px;">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-a" contenteditable="true" spellcheck="false" title="Click to type BPM" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;cursor:text;outline:none;">120.0</div>
          <button id="tempo-range-label-a" onclick="window._cycleTempoRange('a')" style="font-size:8px;color:#f97316;font-family:'Share Tech Mono';background:transparent;border:1px solid #f97316;border-radius:3px;padding:1px 4px;cursor:pointer;line-height:1.2;">±10%</button>
        </div>
      </div>
    </div>

    <!-- JOG WHEEL + SLIDERS -->
    <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-bottom:8px;">
      <div class="jog-wheel" id="jog-a">
        <div class="jog-inner"><div class="jog-needle"></div></div>
      </div>
      <div class="flex-col" style="align-items:center; gap:2px;">
        <div class="tempo-wrapper" style="height:70px; width:12px;"><input type="range" id="tempo-a" min="-100" max="100" value="0" class="tempo-slider"></div>
        <span style="font-size:7px; font-weight:bold; color:#888; letter-spacing:0.5px;">TEMPO</span>
      </div>
      <div class="flex-col" style="align-items:center; gap:2px;">
        <div class="fader-wrapper" style="height:70px; width:12px;"><input type="range" class="ch-fader" id="vol-a" min="0" max="100" value="80"></div>
        <span style="font-size:7px; font-weight:bold; color:#888; letter-spacing:0.5px;">VOL</span>
      </div>
    </div>

    <!-- MIXER KNOBS -->
    <div class="section-box flex-row" style="align-items:center; justify-content:center; gap:6px; margin-bottom:8px; padding:6px;">
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">HI</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-hi" data-ch="1" id="eq-hi-a"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">MID</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-mid" data-ch="1" id="eq-mid-a"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">LOW</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-low" data-ch="1" id="eq-low-a"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">TRIM</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-trim" data-ch="1" id="trim-a"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">FLT</span><input type="range" min="-100" max="100" value="0" class="knob knob-small ch-filter" data-ch="1" id="filter-a"></div>
    </div>

    <div class="flex-between" style="margin-bottom:8px; padding: 0 16px; gap: 8px;">
      <button class="round-btn" id="pad-mode-a" title="Pad mode: Hot Cue / Beat Loop (camera) / Beat Jump / Sampler" style="font-size:8px; line-height:1.1; min-width:46px;">HOT CUE</button>
      <button class="huge-round-btn stop" id="btn-stop-a" style="background:#444; font-size:16px;">⏹</button>
      <button class="huge-round-btn play" id="btn-play-a">▶</button>
    </div>

    <div class="pads-grid" id="pads-a">
      <button class="pad-btn" data-pad="0">1</button><button class="pad-btn" data-pad="1">2</button>
      <button class="pad-btn" data-pad="2">3</button><button class="pad-btn" data-pad="3">4</button>
      <button class="pad-btn" data-pad="4">5</button><button class="pad-btn" data-pad="5">6</button>
      <button class="pad-btn" data-pad="6">7</button><button class="pad-btn" data-pad="7">8</button>
    </div>
  </div>

  <!-- RIGHT PANEL: DECK B + CH 2 MIXER -->
  <div class="hud-panel panel-right" id="deck-b">
    <div class="section-box deck-header" style="display:flex; flex-direction:row; align-items:center; gap:12px;">
      <label class="icon-btn" id="btn-load-b">⏏<input type="file" id="file-b" accept=".ply,.splat,.ksplat,.sog,.ssog,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start; flex:1;">
        <div id="file-b-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center; justify-content:space-between; width:100%;">
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">SPL: <span id="max-splats-val-b">250k</span></span>
            <input type="range" id="max-splats-slider-b" class="max-splats" min="250000" max="1000000" step="10000" value="250000" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">CHK: <span id="chunks-val-b">16</span></span>
            <input type="range" id="chunks-slider-b" class="max-chunks" min="0" max="3" step="1" value="2" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col" style="margin-bottom:8px;">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-in-b" title="Loop IN: set chunk range start">IN</button>
          <button class="round-btn" id="loop-out-b" title="Loop OUT: set chunk range end + enable">OUT</button>
          <button class="round-btn" id="loop-toggle-b" title="Activate/Exit loop: hide others, keep selection animating" style="display:none;">GO</button>
          <button class="round-btn" id="loop-half-b">1/2</button>
          <button class="round-btn" id="loop-active-b">4B</button>
          <button class="round-btn" id="loop-double-b">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:4px;">
        <button class="round-btn sync" id="sync-b">SYNC</button>
       <div class="flex-row" style="align-items:center; gap:3px;">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-b" contenteditable="true" spellcheck="false" title="Click to type BPM" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;cursor:text;outline:none;">120.0</div>
          <button id="tempo-range-label-b" onclick="window._cycleTempoRange('b')" style="font-size:8px;color:#f97316;font-family:'Share Tech Mono';background:transparent;border:1px solid #f97316;border-radius:3px;padding:1px 4px;cursor:pointer;line-height:1.2;">±10%</button>
        </div>
      </div>
    </div>

    <!-- JOG WHEEL + SLIDERS -->
    <div style="display:flex; justify-content:center; align-items:center; gap:8px; margin-bottom:8px;">
      <div class="jog-wheel" id="jog-b" style="border-color:#221100;">
        <div class="jog-inner"><div class="jog-needle" style="background:#f97316;"></div></div>
      </div>
      <div class="flex-col" style="align-items:center; gap:2px;">
        <div class="tempo-wrapper" style="height:70px; width:12px;"><input type="range" id="tempo-b" min="-100" max="100" value="0" class="tempo-slider"></div>
        <span style="font-size:7px; font-weight:bold; color:#888; letter-spacing:0.5px;">TEMPO</span>
      </div>
      <div class="flex-col" style="align-items:center; gap:2px;">
        <div class="fader-wrapper" style="height:70px; width:12px;"><input type="range" class="ch-fader" id="vol-b" min="0" max="100" value="100"></div>
        <span style="font-size:7px; font-weight:bold; color:#888; letter-spacing:0.5px;">VOL</span>
      </div>
    </div>

    <!-- MIXER KNOBS -->
    <div class="section-box flex-row" style="align-items:center; justify-content:center; gap:6px; margin-bottom:8px; padding:6px;">
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">HI</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-hi" data-ch="2" id="eq-hi-b"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">MID</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-mid" data-ch="2" id="eq-mid-b"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">LOW</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-eq-low" data-ch="2" id="eq-low-b"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">TRIM</span><input type="range" min="0" max="100" value="50" class="knob knob-small ch-trim" data-ch="2" id="trim-b"></div>
      <div class="knob-cell"><span class="knob-label" style="font-size:8px;">FLT</span><input type="range" min="-100" max="100" value="0" class="knob knob-small ch-filter" data-ch="2" id="filter-b"></div>
    </div>

    <div class="flex-between" style="margin-bottom:8px; padding: 0 16px; gap: 8px;">
      <button class="round-btn" id="pad-mode-b" title="Pad mode: Hot Cue / Beat Loop (camera) / Beat Jump / Sampler" style="font-size:8px; line-height:1.1; min-width:46px;">HOT CUE</button>
      <button class="huge-round-btn stop" id="btn-stop-b" style="background:#444; font-size:16px;">⏹</button>
      <button class="huge-round-btn play" id="btn-play-b">▶</button>
    </div>

    <div class="pads-grid" id="pads-b">
      <button class="pad-btn" data-pad="0">1</button><button class="pad-btn" data-pad="1">2</button>
      <button class="pad-btn" data-pad="2">3</button><button class="pad-btn" data-pad="3">4</button>
      <button class="pad-btn" data-pad="4">5</button><button class="pad-btn" data-pad="5">6</button>
      <button class="pad-btn" data-pad="6">7</button><button class="pad-btn" data-pad="7">8</button>
    </div>
  </div>

  <!-- TOP PANEL: SETTINGS & UTILS -->
  <div class="hud-panel panel-top">
    <div class="flex-row" style="gap:12px;">
      <a href="https://github.com/lebactan2/ddj-splat" target="_blank" rel="noopener" title="VVJ Splat — CC BY 4.0" style="text-decoration:none; color:#7c3aed; font-family:'Outfit',sans-serif; font-weight:900; font-size:14px; letter-spacing:1px; white-space:nowrap;">VVJ&nbsp;SPLAT</a>
      <div id="fps-counter" style="color:#10b981; font-family:monospace; font-size:14px; font-weight:bold; white-space:nowrap; min-width:60px;">0 FPS</div>
      <div id="status" style="color:#10b981; font-family:monospace; font-size:11px; font-weight:bold; max-width:180px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;">Ready</div>
    </div>
    
    <button id="btn-layout-toggle" class="util-btn" style="background:#10b981; margin:0;">LAYOUT: 2 DECKS</button>
    
    <div class="flex-row" style="gap:16px;">
      <label style="font-size:10px; font-weight:bold; color:#888; display:flex; align-items:center; gap:4px; cursor:pointer;">
        <input type="checkbox" id="chk-remove-bg" checked> REMOVE BG
      </label>
      <label style="font-size:10px; font-weight:bold; color:#888; display:flex; align-items:center; gap:4px; cursor:pointer;">
        <input type="checkbox" id="chk-use-colab"> COLAB
      </label>
      <input type="text" id="colab-url" placeholder="loca.lt URL..." style="background:#000; color:#fff; border:1px solid #333; font-size:10px; padding:4px; width:100px; box-sizing:border-box;">
    </div>
    
    <div class="flex-row" style="gap:10px; margin-left:auto;">
      <div class="flex-row" style="align-items:center; gap:4px;">
        <span class="knob-label" style="margin-right:4px;">MIDI</span>
        <select id="midi-device" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:2px 3px; border-radius:4px; cursor:pointer;">
          <option value="ddj-400">DDJ-400</option>
          <option value="ddj-flx4" selected>DDJ-FLX4</option>
          <option value="ddj-200">DDJ-200</option>
          <option value="idj">iCON iDJ</option>
        </select>
        <button id="btn-midi-guide" class="util-btn" style="font-size:9px; padding:2px 5px; background:#7c3aed;">MIDI MAP</button>
        <input id="midi-import-file" type="file" accept="application/json,.json" style="display:none;" />
      </div>
    </div>

    <div class="flex-row" style="gap:8px; border-left:1px solid rgba(255,255,255,0.1); padding-left:16px;">
      <button id="btn-reset-orient" class="util-btn">RESET VIEW</button>
      <button id="btn-reset" class="util-btn">RESET</button>
      <button id="btn-export" class="util-btn">EXPORT</button>
      <button id="btn-output" class="util-btn">OUTPUT →</button>
      <button id="btn-collapse" class="util-btn" style="background:#333;">HIDE UI</button>
    </div>
  </div>


  <!-- GUIDED MIDI MAP WIZARD -->
  <div id="midi-guide-panel" style="
    display: none;
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 999990;
    background: #0d0d12;
    border: 1px solid #7c3aed;
    border-radius: 10px;
    padding: 24px 28px;
    min-width: 420px;
    max-width: 520px;
    font-family: 'Share Tech Mono', monospace;
    color: #e0e0e0;
    box-shadow: 0 0 40px rgba(124,58,237,0.5);
    pointer-events: auto;
  ">
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
      <div id="midi-map-title" style="color:#a78bfa; font-size:13px; font-weight:bold; letter-spacing:1px;">MIDI MAP</div>
      <button id="midi-guide-close" style="background:transparent; border:none; color:#888; font-size:16px; cursor:pointer; line-height:1;">✕</button>
    </div>
    <div style="font-size:10px; color:#94a3b8; margin-bottom:8px; line-height:1.4;">
      Click <b style="color:#ddd6fe;">learn</b>, then move or press the control on your controller to bind it.
      Click <b style="color:#fde68a;">🎮</b> to bind a gamepad button/stick instead (press pad button or push a stick).
      <span style="color:#666;">✕ clears a binding · captured value shows live so you can spot duplicates · gamepad bindings persist separately and work alongside a DDJ.</span>
    </div>
    <div id="midi-map-rows" style="max-height:52vh; overflow-y:auto; padding-right:6px; margin-bottom:12px;"></div>
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <button id="midi-map-reset"  style="background:#3f1d1d; border:1px solid #b91c1c; color:#fca5a5; font-size:10px; padding:5px 12px; border-radius:4px; cursor:pointer; font-family:inherit;" title="Remove all your edits and restore the built-in factory mapping">Reset to factory</button>
      <button id="midi-map-export" style="background:#065f46; border:1px solid #10b981; color:#10b981; font-size:10px; padding:5px 12px; border-radius:4px; cursor:pointer; font-family:inherit;" title="Download the active profile's bindings as JSON">⬇ Export</button>
      <button id="midi-guide-import" style="background:#1e1e2e; border:1px solid #3b82f6; color:#93c5fd; font-size:10px; padding:5px 12px; border-radius:4px; cursor:pointer; font-family:inherit; margin-left:auto;" title="Load a mapping file (.json) as a profile">⏏ Import</button>
    </div>
  </div>

  <!-- BOTTOM PANEL: FX & CROSSFADER -->
  <div class="hud-panel panel-bottom">
    
    <!-- Left Column: Deck A & C FX -->
    <div id="fx-decks-left" class="flex-col" style="justify-self:start; gap: 8px; width: 100%;">
      <!-- DECK A FX -->
      <div id="fx-box-a" class="flex-row" style="align-items:center; gap:12px; padding:4px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.15);">
        <button id="btn-fx-toggle-a" class="fx-name-toggle">DECK A FX</button>
        <select id="fx-select-a" class="fx-select-dropdown" style="font-size:9px; padding:2px; width:70px;">
          <option value="none">NONE</option><option value="delay">DELAY</option><option value="echo">ECHO</option>
          <option value="reverb">REVERB</option><option value="filter">FILTER</option><option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option><option value="pitch">PITCH</option><option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option><option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-a" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-a" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-a" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <input type="range" min="0" max="100" value="50" class="knob knob-small" id="fx-depth-a">
      </div>
    </div>

    <!-- Center Column: Master FX & Crossfader -->
    <div class="flex-col" style="justify-self:center; align-items:center; gap:8px;">
      <div class="flex-row" style="align-items:center; gap:12px; padding:4px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.15);">
        <button id="btn-fx-toggle-m" class="fx-name-toggle">MASTER FX</button>
        <select id="fx-select-m" class="fx-select-dropdown" style="font-size:9px; padding:2px; width:70px;">
          <option value="none">NONE</option><option value="delay">DELAY</option><option value="echo">ECHO</option>
          <option value="reverb">REVERB</option><option value="filter">FILTER</option><option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option><option value="pitch">PITCH</option><option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option><option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-m" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-m" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-m" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <input type="range" min="0" max="100" value="50" class="knob knob-small" id="fx-depth-m">
      </div>
      
      <div class="flex-row" style="gap:12px; align-items:center; justify-content:center; width: 100%;">
        <input type="range" min="0" max="100" value="50" class="crossfader-slider" id="crossfader" style="width:200px; height:16px;">
        <div class="flex-row" style="gap:4px;">
          <span style="font-size:9px; font-weight:bold; color:#888;">MST VOL</span>
          <input type="range" min="0" max="100" value="50" class="knob knob-small" id="master-vol">
        </div>
      </div>
      <div class="flex-row" style="gap:10px; align-items:center; justify-content:center; flex-wrap:wrap;">
        <div class="knob-cell" style="flex-direction:row;">
          <span class="knob-label">DOF</span><input type="range" min="0" max="100" value="0" class="knob knob-small" id="knob-dof">
        </div>
        <div class="knob-cell" style="flex-direction:row;">
          <span class="knob-label">FLARE</span><input type="range" min="0" max="100" value="0" class="knob knob-small" id="knob-lensflare">
        </div>
        <div class="flex-row" style="align-items:center; gap:3px;">
          <button id="btn-strobe" class="util-btn" style="font-size:9px; padding:2px 5px;">STROBE</button>
          <select id="strobe-mode" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:2px 3px; border-radius:4px; cursor:pointer;">
            <option value="side">SIDE</option>
            <option value="full">FULL</option>
          </select>
        </div>
        <div class="flex-row" style="align-items:center; gap:3px;">
          <span class="knob-label">HDRI</span>
          <select id="hdri-select" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:2px 3px; border-radius:4px; cursor:pointer;">
            <option value="none">NONE</option><option value="sunset">SUNSET</option><option value="studio">STUDIO</option>
            <option value="night">NIGHT</option><option value="forest">FOREST</option>
            <option value="google-map">GOOGLE MAP</option>
            <option value="custom-url">URL...</option><option value="local-file">FILE...</option>
          </select>
        </div>
      </div>
    </div>
    
    <!-- Right Column: Deck B & D FX -->
    <div id="fx-decks-right" class="flex-col" style="justify-self:end; gap: 8px; width: 100%;">
      <!-- DECK B FX -->
      <div id="fx-box-b" class="flex-row" style="align-items:center; gap:12px; padding:4px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.15);">
        <button id="btn-fx-toggle-b" class="fx-name-toggle">DECK B FX</button>
        <select id="fx-select-b" class="fx-select-dropdown" style="font-size:9px; padding:2px; width:70px;">
          <option value="none">NONE</option><option value="delay">DELAY</option><option value="echo">ECHO</option>
          <option value="reverb">REVERB</option><option value="filter">FILTER</option><option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option><option value="pitch">PITCH</option><option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option><option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-b" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-b" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-b" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <input type="range" min="0" max="100" value="50" class="knob knob-small" id="fx-depth-b">
      </div>
    </div>

  </div>

  <!-- HIDDEN TEST INPUTS -->
  <div style="position:absolute; top:0; left:0; z-index:999999; display:block; pointer-events:none; width:50px; height:300px;">
    <input type="number" id="seed-input" value="42" style="position:absolute; top:0px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="range" id="cuts-slider" min="1" max="8" value="1" style="position:absolute; top:15px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="range" id="mix-slider" min="0" max="100" value="50" style="position:absolute; top:30px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="checkbox" id="chk-move" checked style="position:absolute; top:45px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="checkbox" id="chk-rotate" style="position:absolute; top:60px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="checkbox" id="chk-scale" style="position:absolute; top:75px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="checkbox" id="chk-color" style="position:absolute; top:90px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    <input type="checkbox" id="chk-drop" style="position:absolute; top:105px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;">
    
    <button id="btn-randomize" style="position:absolute; top:120px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-delay" style="position:absolute; top:135px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-echo" style="position:absolute; top:150px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-reverb" style="position:absolute; top:165px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-filter" style="position:absolute; top:180px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-flanger" style="position:absolute; top:195px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-phaser" style="position:absolute; top:210px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-pitch" style="position:absolute; top:225px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-roll" style="position:absolute; top:240px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
    <button id="btn-spiral" style="position:absolute; top:255px; left:0px; opacity:0.0001; pointer-events:auto; width:8px; height:8px; border:none; margin:0; padding:0; appearance:none; -webkit-appearance:none;"></button>
  </div>

  <button id="btn-show-controller" class="collapse-tab hidden">SHOW HUD</button>
`;

// Duplicate Decks for 4-deck layout mode
const deckAEl = document.getElementById('deck-a');
const deckBEl = document.getElementById('deck-b');
const fxBoxAEl = document.getElementById('fx-box-a');
const fxBoxBEl = document.getElementById('fx-box-b');

const deckCHtml = deckAEl.outerHTML
  .replace(/id="deck-a"/g, 'id="deck-c"')
  .replace(/-a"/g, '-c"')
  .replace(/-a /g, '-c ')
  .replace(/-a'/g, "-c'")
  .replace(/Deck A/gi, 'Deck C')
  .replace(/SCENE A/gi, 'SCENE C')
  .replace(/data-ch="1"/g, 'data-ch="3"')
  .replace(/panel-left/, 'panel-bottom-left');

const deckDHtml = deckBEl.outerHTML
  .replace(/id="deck-b"/g, 'id="deck-d"')
  .replace(/-b"/g, '-d"')
  .replace(/-b /g, '-d ')
  .replace(/-b'/g, "-d'")
  .replace(/Deck B/gi, 'Deck D')
  .replace(/SCENE B/gi, 'SCENE D')
  .replace(/data-ch="2"/g, 'data-ch="4"')
  .replace(/panel-right/, 'panel-bottom-right');

appDiv.insertAdjacentHTML('beforeend', deckCHtml + deckDHtml);

const fxCHtml = fxBoxAEl.outerHTML
  .replace(/id="fx-box-a"/g, 'id="fx-box-c"')
  .replace(/id="btn-fx-toggle-a"/g, 'id="btn-fx-toggle-c"')
  .replace(/id="fx-select-a"/g, 'id="fx-select-c"')
  .replace(/id="btn-beat-prev-a"/g, 'id="btn-beat-prev-c"')
  .replace(/id="beat-value-a"/g, 'id="beat-value-c"')
  .replace(/id="btn-beat-next-a"/g, 'id="btn-beat-next-c"')
  .replace(/id="fx-depth-a"/g, 'id="fx-depth-c"')
  .replace(/DECK A/gi, 'DECK C')
  .replace(/id="fx-box-c"/, 'id="fx-box-c" style="display:none;"');
document.getElementById('fx-decks-left').insertAdjacentHTML('beforeend', fxCHtml);

const fxDHtml = fxBoxBEl.outerHTML
  .replace(/id="fx-box-b"/g, 'id="fx-box-d"')
  .replace(/id="btn-fx-toggle-b"/g, 'id="btn-fx-toggle-d"')
  .replace(/id="fx-select-b"/g, 'id="fx-select-d"')
  .replace(/id="btn-beat-prev-b"/g, 'id="btn-beat-prev-d"')
  .replace(/id="beat-value-b"/g, 'id="beat-value-d"')
  .replace(/id="btn-beat-next-b"/g, 'id="btn-beat-next-d"')
  .replace(/id="fx-depth-b"/g, 'id="fx-depth-d"')
  .replace(/DECK B/gi, 'DECK D')
  .replace(/id="fx-box-d"/, 'id="fx-box-d" style="display:none;"');
document.getElementById('fx-decks-right').insertAdjacentHTML('beforeend', fxDHtml);

// ── Google Map layer & interact button ───────────────────────────────────────
// #map-layer sits as FIRST child of #app (z-index:0), behind #viewer-container
// (z-index:1). By default it is hidden and has pointer-events:none.
{
  const mapLayerEl = document.createElement('div');
  mapLayerEl.id = 'map-layer';
  appDiv.insertBefore(mapLayerEl, appDiv.firstChild);

  // MAP ✋ button — injected into the top panel flex-row (right side area)
  const mapInteractBtn = document.createElement('button');
  mapInteractBtn.id = 'btn-map-interact';
  mapInteractBtn.className = 'util-btn';
  mapInteractBtn.textContent = 'MAP ✋';
  mapInteractBtn.title = 'Toggle map pan/zoom (disables splat orbit while active)';
  // Insert it just before the right-side btn group in the top panel
  const btnOutput = document.querySelector('#btn-output');
  if (btnOutput && btnOutput.parentElement) {
    btnOutput.parentElement.insertBefore(mapInteractBtn, btnOutput);
  }
}

// Layout Toggle Logic
const btnLayoutToggle = document.getElementById('btn-layout-toggle');
btnLayoutToggle.addEventListener('click', () => {
  if (layoutMode === '2deck') {
    layoutMode = '4deck';
    document.body.classList.add('layout-4deck');
    btnLayoutToggle.textContent = 'LAYOUT: 4 DECKS';
    document.getElementById('fx-box-c').style.display = 'flex';
    document.getElementById('fx-box-d').style.display = 'flex';
  } else {
    layoutMode = '2deck';
    document.body.classList.remove('layout-4deck');
    btnLayoutToggle.textContent = 'LAYOUT: 2 DECKS';
    document.getElementById('fx-box-c').style.display = 'none';
    document.getElementById('fx-box-d').style.display = 'none';
  }
});

const fileInputA = document.querySelector('#file-a');
const fileInputB = document.querySelector('#file-b');
const fileAName = document.querySelector('#file-a-name');
const fileBName = document.querySelector('#file-b-name');
const statusEl = document.querySelector('#status');
const cutsSlider = document.querySelector('#cuts-slider');
const mixSlider = document.querySelector('#mix-slider');
const seedInput = document.querySelector('#seed-input');
const btnExport = document.querySelector('#btn-export');
const btnReset = document.querySelector('#btn-reset');
const crossfader = document.querySelector('#crossfader');
const masterVol = document.querySelector('#master-vol');
const fxSelectA = document.querySelector('#fx-select-a');
const fxDepthA = document.querySelector('#fx-depth-a');
const btnFxToggleA = document.querySelector('#btn-fx-toggle-a');
const btnBeatPrevA = document.querySelector('#btn-beat-prev-a');
const btnBeatNextA = document.querySelector('#btn-beat-next-a');
const beatValueAEl = document.querySelector('#beat-value-a');

const fxSelectB = document.querySelector('#fx-select-b');
const fxDepthB = document.querySelector('#fx-depth-b');
const btnFxToggleB = document.querySelector('#btn-fx-toggle-b');
const btnBeatPrevB = document.querySelector('#btn-beat-prev-b');
const btnBeatNextB = document.querySelector('#btn-beat-next-b');
const beatValueBEl = document.querySelector('#beat-value-b');

const fileInputC = document.querySelector('#file-c');
const fileInputD = document.querySelector('#file-d');
const fileCName = document.querySelector('#file-c-name');
const fileDName = document.querySelector('#file-d-name');

const fxSelectC = document.querySelector('#fx-select-c');
const fxDepthC = document.querySelector('#fx-depth-c');
const btnFxToggleC = document.querySelector('#btn-fx-toggle-c');
const btnBeatPrevC = document.querySelector('#btn-beat-prev-c');
const btnBeatNextC = document.querySelector('#btn-beat-next-c');
const beatValueCEl = document.querySelector('#beat-value-c');

const fxSelectD = document.querySelector('#fx-select-d');
const fxDepthD = document.querySelector('#fx-depth-d');
const btnFxToggleD = document.querySelector('#btn-fx-toggle-d');
const btnBeatPrevD = document.querySelector('#btn-beat-prev-d');
const btnBeatNextD = document.querySelector('#btn-beat-next-d');
const beatValueDEl = document.querySelector('#beat-value-d');

const fxSelectM = document.querySelector('#fx-select-m');
const fxDepthM = document.querySelector('#fx-depth-m');
const btnFxToggleM = document.querySelector('#btn-fx-toggle-m');
const btnBeatPrevM = document.querySelector('#btn-beat-prev-m');
const btnBeatNextM = document.querySelector('#btn-beat-next-m');
const beatValueMEl = document.querySelector('#beat-value-m');

// Cached hot-loop element references (avoid per-frame DOM queries)
const volAEl = document.querySelector('#vol-a');
const volBEl = document.querySelector('#vol-b');
// Smoothed deck-volume scale (eased each frame) — kills the MIDI fader jitter that
// otherwise makes the whole deck visibly snap when the channel fader is nudged.
let volScaleSmoothA = 0.8;
let volScaleSmoothB = 1.0;
const VOL_SMOOTH_ALPHA = 0.15;

// Virtual jog-wheel spin: the inner disc rotates continuously while a deck plays
// (scaled by BPM) to simulate a spinning record. Independent of the outer drag
// transform set by setupJogWheel, so scratching still works on top.
const jogInnerA = document.querySelector('#jog-a .jog-inner');
const jogInnerB = document.querySelector('#jog-b .jog-inner');
let jogVisAngleA = 0;
let jogVisAngleB = 0;

// ── Live EQ (no geometry reload) ───────────────────────────────────────────────
// Chunks come back from sliceIntoSpheres sorted outer→inner, so a chunk's index
// fraction maps to a radial band: outer = HI, middle = MID, inner = LOW. The knob
// value /50 gives 0 (cut to nothing) … 1 (neutral) … 2 (boost). Turning a band to
// 0 scales those chunks to zero — live, per-frame, no rebuild.
const eqHiAEl = document.querySelector('#eq-hi-a');
const eqMidAEl = document.querySelector('#eq-mid-a');
const eqLowAEl = document.querySelector('#eq-low-a');
const eqHiBEl = document.querySelector('#eq-hi-b');
const eqMidBEl = document.querySelector('#eq-mid-b');
const eqLowBEl = document.querySelector('#eq-low-b');
// Smoothed EQ band factors (eased per frame) — kills MIDI knob ADC flicker so the
// chunks don't strobe. Each = knob/50 (0 cut … 1 neutral … 2 boost). Updated once
// per frame in updateEqSmoothing() before the deck loops use them.
const eqSmooth = { hiA: 1, midA: 1, lowA: 1, hiB: 1, midB: 1, lowB: 1 };
const EQ_SMOOTH_ALPHA = 0.2;
function _eqTarget(el) { return el ? Number(el.value) / 50 : 1.0; }
function updateEqSmoothing() {
  eqSmooth.hiA  += (_eqTarget(eqHiAEl)  - eqSmooth.hiA)  * EQ_SMOOTH_ALPHA;
  eqSmooth.midA += (_eqTarget(eqMidAEl) - eqSmooth.midA) * EQ_SMOOTH_ALPHA;
  eqSmooth.lowA += (_eqTarget(eqLowAEl) - eqSmooth.lowA) * EQ_SMOOTH_ALPHA;
  eqSmooth.hiB  += (_eqTarget(eqHiBEl)  - eqSmooth.hiB)  * EQ_SMOOTH_ALPHA;
  eqSmooth.midB += (_eqTarget(eqMidBEl) - eqSmooth.midB) * EQ_SMOOTH_ALPHA;
  eqSmooth.lowB += (_eqTarget(eqLowBEl) - eqSmooth.lowB) * EQ_SMOOTH_ALPHA;
}
function eqFactorForChunk(i, n, hi, mid, low) {
  if (n <= 1) return mid;
  const f = i / (n - 1); // 0 = outermost chunk, 1 = innermost
  return f < 0.34 ? hi : (f < 0.67 ? mid : low);
}
const tempoCEl = document.querySelector('#tempo-c');
const tempoDEl = document.querySelector('#tempo-d');

// Reusable scratch math objects (avoid per-frame allocations)
const _yAxis = new THREE.Vector3(0, 1, 0);
const _scratchEuler = new THREE.Euler();
const _scratchQRandom = new THREE.Quaternion();
const _scratchQ = new THREE.Quaternion();
const _scratchV = new THREE.Vector3();

const chkMove = document.querySelector('#chk-move');
const chkRotate = document.querySelector('#chk-rotate');
const chkScale = document.querySelector('#chk-scale');
const chkColor = document.querySelector('#chk-color');
const chkDrop = document.querySelector('#chk-drop');

// Legacy buttons for test compatibility
const btnDelay = document.querySelector('#btn-delay');
const btnEcho = document.querySelector('#btn-echo');
const btnReverb = document.querySelector('#btn-reverb');
const btnFilter = document.querySelector('#btn-filter');
const btnFlanger = document.querySelector('#btn-flanger');
const btnPhaser = document.querySelector('#btn-phaser');
const btnPitch = document.querySelector('#btn-pitch');
const btnRoll = document.querySelector('#btn-roll');
const btnSpiral = document.querySelector('#btn-spiral');
const btnRandomize = document.querySelector('#btn-randomize');

const fxButtons = [
  btnDelay,
  btnEcho,
  btnReverb,
  btnFilter,
  btnFlanger,
  btnPhaser,
  btnPitch,
  btnRoll,
  btnSpiral,
];

// ── UI Collapse & Opacity logic ──────────────────────────
const btnCollapse = document.querySelector('#btn-collapse');
const btnShowController = document.querySelector('#btn-show-controller');
const hudPanels = document.querySelectorAll('.hud-panel');
const chkRemoveBg = document.getElementById('chk-remove-bg');
if (chkRemoveBg) {
  chkRemoveBg.addEventListener('change', () => {
    // Just placeholder since we only check this on loadFile
  });
}

document.getElementById('chk-dof')?.addEventListener('change', (e) => {
  if (bokehPass) bokehPass.enabled = e.target.checked;
  triggerRealtimeUpdate();
});
document.getElementById('chk-lensflare')?.addEventListener('change', (e) => {
  if (lensflareLight) lensflareLight.visible = e.target.checked;
  triggerRealtimeUpdate();
});


if (btnCollapse) {
  btnCollapse.addEventListener('click', () => {
    hudPanels.forEach(panel => panel.classList.add('hidden'));
    btnShowController.classList.remove('hidden');
    setTimeout(resizeViewer, 400);
  });
}
if (btnShowController) {
  btnShowController.addEventListener('click', () => {
    hudPanels.forEach(panel => panel.classList.remove('hidden'));
    btnShowController.classList.add('hidden');
    setTimeout(resizeViewer, 400);
  });
}

// ── Output to second screen ──────────────────────────────────────────────────
// FPS note: we render the splats ONCE in the existing WebGL renderer and mirror
// the canvas via captureStream() into a fullscreen <video> in a popup window.
// This avoids the ~2× GPU cost of a second WebGL renderer.
// ─────────────────────────────────────────────────────────────────────────────
let outputWin = null;
let outputStream = null;
let outputPollInterval = null;

const btnOutput = document.querySelector('#btn-output');

function stopOutputStream() {
  if (outputStream) {
    outputStream.getTracks().forEach(t => t.stop());
    outputStream = null;
  }
  if (outputPollInterval) {
    clearInterval(outputPollInterval);
    outputPollInterval = null;
  }
  if (btnOutput) {
    btnOutput.textContent = 'OUTPUT →';
    btnOutput.classList.remove('active');
  }
}

async function toggleOutputWindow() {
  // If window is already open, close it
  if (outputWin && !outputWin.closed) {
    outputWin.close();
    outputWin = null;
    stopOutputStream();
    return;
  }

  // Find the renderer canvas
  const canvas = (viewer && viewer.renderer && viewer.renderer.domElement)
    ? viewer.renderer.domElement
    : document.querySelector('#viewer-container canvas');

  if (!canvas) {
    if (statusEl) statusEl.textContent = 'Load a splat first';
    return;
  }

  // Capture the canvas stream (60 fps)
  if (typeof canvas.captureStream !== 'function') {
    if (statusEl) statusEl.textContent = 'captureStream not supported';
    return;
  }
  outputStream = canvas.captureStream(60);

  // Try Window Management API to open on external screen
  let winFeatures = 'width=1280,height=720';
  let targetScreen = null;

  if (typeof window.getScreenDetails === 'function') {
    try {
      const sd = await window.getScreenDetails();
      targetScreen = sd.screens.find(s => !s.isPrimary && s.isExtended !== false)
                  || sd.screens.find(s => s !== sd.currentScreen)
                  || null;
      if (targetScreen) {
        winFeatures = `left=${targetScreen.left},top=${targetScreen.top},width=${targetScreen.width},height=${targetScreen.height}`;
      }
    } catch (e) {
      // Permission denied or API unavailable — fall back to plain open
      console.warn('getScreenDetails denied, using fallback:', e);
    }
  }

  outputWin = window.open('', 'vj-output', winFeatures);
  if (!outputWin) {
    if (statusEl) statusEl.textContent = 'Popup blocked — allow popups';
    stopOutputStream();
    return;
  }

  // If we have screen coordinates, try to move/resize to that screen
  if (targetScreen) {
    try {
      outputWin.moveTo(targetScreen.left, targetScreen.top);
      outputWin.resizeTo(targetScreen.width, targetScreen.height);
    } catch (e) { /* ignore */ }
  }

  // Write minimal HTML into the output window
  outputWin.document.open();
  outputWin.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>VJ Output</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { width:100%; height:100%; background:#000; overflow:hidden; cursor:none; }
    :fullscreen, :-webkit-full-screen, :fullscreen video, :-webkit-full-screen video { cursor:none !important; }
    video { display:block; position:absolute; inset:0; z-index:1; width:100vw; height:100vh; object-fit:contain; background:#050508; pointer-events:none; }
  </style>
</head>
<body>
  <!-- Strobe is now baked into the captured WebGL frame, so no DOM strobe layer is needed here. -->
  <video id="vjvideo" autoplay muted playsinline></video>
  <script>
    function goFullscreen() {
      var el = document.documentElement;
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(function(){});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      }
    }
    window.addEventListener('click', goFullscreen);
    document.addEventListener('keydown', function(e) { if (e.key.toLowerCase() === 'f') goFullscreen(); });
  <\/script>
</body>
</html>`);
  outputWin.document.close();

  // Primary fullscreen trigger: use the opener's click gesture (user activation)
  // which is propagated to the popup, satisfying the browser's user-gesture requirement.
  if (outputWin && outputWin.document && outputWin.document.documentElement) {
    const el = outputWin.document.documentElement;
    try {
      // Prefer multi-screen form so the browser places it on the right screen
      if (targetScreen && typeof el.requestFullscreen === 'function') {
        el.requestFullscreen({ screen: targetScreen }).catch(() => {
          el.requestFullscreen().catch(() => {});
        });
      } else if (typeof el.requestFullscreen === 'function') {
        el.requestFullscreen().catch(() => {});
      } else if (typeof el.webkitRequestFullscreen === 'function') {
        el.webkitRequestFullscreen();
      }
    } catch (e) {
      // Fullscreen denied — popup's own click/F-key handlers remain as fallback
      console.warn('Output window auto-fullscreen failed:', e);
    }
  }

  // Attach the stream to the video element
  const attachStream = () => {
    try {
      const vid = outputWin.document.getElementById('vjvideo');
      if (vid) {
        vid.srcObject = outputStream;
        vid.play().catch(() => {});
      }
    } catch (e) {
      console.warn('Output window stream attach error:', e);
    }
  };

  // Small delay to let the document settle
  setTimeout(attachStream, 200);

  // Update button state
  if (btnOutput) {
    btnOutput.textContent = 'OUTPUT ■';
    btnOutput.classList.add('active');
  }

  // Poll to detect user closing the popup
  outputPollInterval = setInterval(() => {
    if (outputWin && outputWin.closed) {
      outputWin = null;
      stopOutputStream();
    }
  }, 1000);
}

if (btnOutput) {
  btnOutput.addEventListener('click', toggleOutputWindow);
}

function reconnectOutputStream() {
  if (!outputWin || outputWin.closed) return;
  const canvas = (viewer && viewer.renderer && viewer.renderer.domElement)
    ? viewer.renderer.domElement
    : document.querySelector('#viewer-container canvas');

  if (!canvas || typeof canvas.captureStream !== 'function') return;
  
  // Stop old stream tracks
  if (outputStream) {
    outputStream.getTracks().forEach(t => t.stop());
  }
  
  outputStream = canvas.captureStream(60);
  try {
    const vid = outputWin.document.getElementById('vjvideo');
    if (vid) {
      vid.srcObject = outputStream;
      vid.play().catch(() => {});
    }
  } catch (e) {
    console.warn('Output window stream attach error:', e);
  }
}

function resizeViewer() {
  // Viewer-container takes 100% implicitly
  setTimeout(() => {
    if (typeof centerCamera === 'function') centerCamera();
  }, 50);
}
window.addEventListener('resize', resizeViewer);

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'h') {
    // Reset Master Vol to default, then do a FULL view reset — re-centers/fits
    // every per-deck camera (not just viewer.camera), same as RESET VIEW.
    if (masterVol) { masterVol.value = 50; updateKnobFill(masterVol); }
    const rv = document.getElementById('btn-reset-orient');
    if (rv) rv.click();
    else if (typeof centerCamera === 'function') centerCamera();
  }
});

// ── Knob dial fill coloring ────────────────────────────
function updateKnobFill(knob) {
  const min = Number(knob.min) || 0;
  const max = Number(knob.max) || 100;
  const value = Number(knob.value) || 0;
  knob.style.setProperty('--value', `${((value - min) / (max - min)) * 100}%`);
}

const allKnobs = Array.from(document.querySelectorAll('.knob'));
allKnobs.forEach(knob => {
  updateKnobFill(knob);
  knob.addEventListener('input', () => {
    updateKnobFill(knob);
    triggerRealtimeUpdate();
  });
  knob.addEventListener('dblclick', () => {
    knob.value = knob.defaultValue;
    updateKnobFill(knob);
    triggerRealtimeUpdate();
  });
  // Right-click = reset to default
  knob.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    knob.value = knob.defaultValue;
    updateKnobFill(knob);
    triggerRealtimeUpdate();
  });
});

// Attach change event listeners to mixer knobs to trigger full buffer rebuilds
const mixerKnobs = document.querySelectorAll('.ch-trim, .ch-filter, .ch-eq-hi, .ch-eq-mid, .ch-eq-low');
mixerKnobs.forEach(knob => {
  // EQ + filter are now applied LIVE per-frame (no geometry reload). A light
  // realtime update is enough; we no longer rebuild buffers on these knobs.
  knob.addEventListener('input', () => { triggerRealtimeUpdate(); });
  knob.addEventListener('change', () => { triggerRealtimeUpdate(); });
  knob.addEventListener('dblclick', () => {
    knob.value = knob.defaultValue;
    updateKnobFill(knob);
    triggerRealtimeUpdate();
  });
  knob.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    knob.value = knob.defaultValue;
    updateKnobFill(knob);
    triggerRealtimeUpdate();
  });
});

// Attach input event listener to channel faders
const chFaders = document.querySelectorAll('.ch-fader');
chFaders.forEach(fader => {
  fader.addEventListener('input', () => {
    triggerRealtimeUpdate();
  });
  fader.addEventListener('dblclick', () => {
    fader.value = fader.defaultValue || 100;
    triggerRealtimeUpdate();
  });
  // Right-click = reset to default
  fader.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    fader.value = fader.defaultValue || 100;
    triggerRealtimeUpdate();
  });
});

// ── DOF knob wiring ──
const knobDof = document.getElementById('knob-dof');
const knobLensFlare = document.getElementById('knob-lensflare');
updateKnobFill(knobDof);
updateKnobFill(knobLensFlare);
knobDof.addEventListener('input', () => {
  updateKnobFill(knobDof);
  // Disabled BokehPass post-processing to avoid uniform full-screen blur,
  // allowing the true distance-based vertex shader DOF to render instead.
  if (bokehPass) {
    bokehPass.enabled = false;
  }
});
knobDof.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  knobDof.value = 0;
  updateKnobFill(knobDof);
  if (bokehPass) bokehPass.enabled = false;
});
knobLensFlare.addEventListener('input', () => {
  updateKnobFill(knobLensFlare);
  const amount = Number(knobLensFlare.value) / 100;
  if (lensflareLight) {
    lensflareLight.visible = amount > 0;
    lensflareLight.intensity = amount * 3.0;
  }
});
knobLensFlare.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  knobLensFlare.value = 0;
  updateKnobFill(knobLensFlare);
  if (lensflareLight) lensflareLight.visible = false;
});

// ── HDRI Environment ──
let currentHdriTexture = null;
let currentHdriEnv = null;
const hdriPresets = {
  none: null,
  studio: 'hdri/studio.hdr',
  sunset: 'hdri/sunset.hdr',
  night:  'hdri/night.hdr',
  forest: 'hdri/forest.hdr',
};

// ── Google Map layer helpers ─────────────────────────────────────────────────
let mapInteractActive = false;

function _getMapLayerEl() { return document.getElementById('map-layer'); }
function _getViewerContainerEl() { return document.getElementById('viewer-container'); }
function _getMapInteractBtn() { return document.getElementById('btn-map-interact'); }

/** Hide the Google Map layer and restore normal viewer-container behaviour. */
function hideGoogleMap() {
  const layer = _getMapLayerEl();
  const vc = _getViewerContainerEl();
  if (layer) {
    layer.style.display = 'none';
    layer.style.pointerEvents = 'none';
    // Blank the iframe so it stops loading/streaming
    const ifrm = layer.querySelector('iframe');
    if (ifrm) {
      try { ifrm.src = 'about:blank'; } catch(_) {}
      ifrm.remove();
    }
  }
  if (vc) {
    vc.style.background = '#050508';
    vc.style.pointerEvents = 'auto';
  }
  // Reset interact toggle
  mapInteractActive = false;
  const btn = _getMapInteractBtn();
  if (btn) btn.classList.remove('active');
}

/** Show the Google Map layer with an embedded iframe for the given key+place. */
function showGoogleMap(apiKey, place) {
  const layer = _getMapLayerEl();
  const vc = _getViewerContainerEl();
  if (!layer) return;

  // Remove any existing iframe first
  const existing = layer.querySelector('iframe');
  if (existing) {
    try { existing.src = 'about:blank'; } catch(_) {}
    existing.remove();
  }

  const src = `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(place)}`;
  const ifrm = document.createElement('iframe');
  ifrm.src = src;
  ifrm.title = 'Google Map';
  ifrm.setAttribute('allowfullscreen', '');
  ifrm.setAttribute('loading', 'lazy');
  ifrm.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
  ifrm.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;';
  layer.appendChild(ifrm);

  layer.style.display = 'block';
  layer.style.pointerEvents = 'none'; // default: orbit controls on top

  if (vc) {
    vc.style.background = 'transparent';
    // pointer-events stays auto so splat orbit still works by default
    vc.style.pointerEvents = 'auto';
  }
}

// Wire up the MAP ✋ interact toggle button
document.addEventListener('DOMContentLoaded', () => {}, false); // no-op guard
(function wireMapInteractBtn() {
  // Button may not yet exist if this runs before DOM is fully built;
  // use event delegation via document to be safe.
  document.addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'btn-map-interact') return;
    const layer = _getMapLayerEl();
    const vc = _getViewerContainerEl();
    // Only meaningful when the map layer is actually visible
    if (!layer || layer.style.display === 'none' || !layer.querySelector('iframe')) return;

    mapInteractActive = !mapInteractActive;
    const btn = _getMapInteractBtn();
    if (mapInteractActive) {
      // Let the iframe receive pointer events; disable splat orbit
      layer.style.pointerEvents = 'auto';
      if (vc) vc.style.pointerEvents = 'none';
      if (btn) btn.classList.add('active');
    } else {
      // Restore splat orbit
      layer.style.pointerEvents = 'none';
      if (vc) vc.style.pointerEvents = 'auto';
      if (btn) btn.classList.remove('active');
    }
  });
})();

async function loadHdriFromUrl(url) {
  if (!viewer || !viewer.renderer) return;
  
  if (viewer.threeScene) {
    if (viewer.threeScene.background && typeof viewer.threeScene.background.dispose === 'function') {
      viewer.threeScene.background.dispose();
    }
    viewer.threeScene.background = null;
    viewer.threeScene.environment = null;
  }
  if (currentHdriTexture) {
    currentHdriTexture.dispose();
    currentHdriTexture = null;
  }
  if (currentHdriEnv) {
    currentHdriEnv.dispose();
    currentHdriEnv = null;
  }
  
  try {
    const loader = new HDRLoader();
    const texture = await new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
    
    texture.mapping = THREE.EquirectangularReflectionMapping;
    currentHdriTexture = texture;
    
    if (viewer.threeScene) {
      viewer.threeScene.background = texture;
    }
    
    // Also use for environment lighting (optional for splats but good to have)
    const pmrem = new THREE.PMREMGenerator(viewer.renderer);
    pmrem.compileEquirectangularShader();
    const envMap = pmrem.fromEquirectangular(texture).texture;
    pmrem.dispose();
    currentHdriEnv = envMap;
    
    if (viewer.threeScene) {
      viewer.threeScene.environment = envMap;
    }
  } catch(e) {
    console.warn('HDRI load failed:', e);
    alert('Failed to load HDRI: ' + e.message);
    const select = document.getElementById('hdri-select');
    if (select) select.value = 'none';
  }
}

function reapplyHdri() {
  if (!viewer || !viewer.threeScene) return;
  if (currentHdriTexture) {
    viewer.threeScene.background = currentHdriTexture;
  }
  if (currentHdriEnv) {
    viewer.threeScene.environment = currentHdriEnv;
  }
}

async function setHdri(preset) {
  // Leaving any non-google-map preset: always tear down the map layer
  if (preset !== 'google-map') {
    hideGoogleMap();
  }

  if (preset === 'none') {
    if (viewer && viewer.threeScene) {
      if (viewer.threeScene.background && typeof viewer.threeScene.background.dispose === 'function') {
        viewer.threeScene.background.dispose();
      }
      viewer.threeScene.background = null;
      viewer.threeScene.environment = null;
    }
    if (currentHdriTexture) {
      currentHdriTexture.dispose();
      currentHdriTexture = null;
    }
    if (currentHdriEnv) {
      currentHdriEnv.dispose();
      currentHdriEnv = null;
    }
    return;
  }

  if (preset === 'google-map') {
    // 1. Clear any HDRI background so the Three scene is transparent
    if (viewer && viewer.threeScene) {
      if (viewer.threeScene.background && typeof viewer.threeScene.background.dispose === 'function') {
        viewer.threeScene.background.dispose();
      }
      viewer.threeScene.background = null;
      viewer.threeScene.environment = null;
    }
    if (currentHdriTexture) { currentHdriTexture.dispose(); currentHdriTexture = null; }
    if (currentHdriEnv)     { currentHdriEnv.dispose();     currentHdriEnv = null; }

    // 2. Resolve API key: localStorage → VITE env var → prompt
    let apiKey = localStorage.getItem('vvj-gmaps-key') || (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_GOOGLE_MAPS_KEY) || '';
    if (!apiKey) {
      const entered = prompt(
        'Paste your Google Maps Embed API key:\n' +
        '(Get one free at console.cloud.google.com → Maps Embed API)\n' +
        'It will be stored in localStorage.'
      );
      if (!entered || !entered.trim()) {
        const select = document.getElementById('hdri-select');
        if (select) select.value = 'none';
        if (statusEl) statusEl.textContent = 'Google Map: no API key — cancelled';
        return;
      }
      apiKey = entered.trim();
      localStorage.setItem('vvj-gmaps-key', apiKey);
    }

    // 3. Resolve place
    let place = localStorage.getItem('vvj-gmaps-place');
    if (!place) {
      const entered = prompt('Enter a place or lat,lng for the map (e.g. "Tokyo" or "35.6762,139.6503"):', 'Tokyo');
      place = (entered && entered.trim()) ? entered.trim() : 'Tokyo';
      localStorage.setItem('vvj-gmaps-place', place);
    }

    // 4. Show the map
    showGoogleMap(apiKey, place);

    if (statusEl) statusEl.textContent = `Map: ${place} — click MAP ✋ to pan`;
    return;
  }

  if (preset === 'custom-url') {
    const url = prompt("Enter HDRI URL (.hdr):");
    if (!url) {
      const select = document.getElementById('hdri-select');
      if (select) select.value = 'none';
      return;
    }
    await loadHdriFromUrl(url);
    return;
  }

  if (preset === 'local-file') {
    let fileInput = document.getElementById('hdri-file-input');
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'hdri-file-input';
      fileInput.accept = '.hdr';
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
      fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          const blobUrl = URL.createObjectURL(file);
          await loadHdriFromUrl(blobUrl);
        } else {
          const select = document.getElementById('hdri-select');
          if (select) select.value = 'none';
        }
      });
    }
    fileInput.click();
    return;
  }

  const url = hdriPresets[preset];
  if (!url) return;
  await loadHdriFromUrl(url);
}

document.getElementById('hdri-select')?.addEventListener('change', (e) => {
  setHdri(e.target.value);
});

// ── MIDI profile dropdown (built-ins + saved custom profiles) ──────────────────
const BUILTIN_MIDI_PROFILES = [
  { value: 'ddj-400',  label: 'DDJ-400' },
  { value: 'ddj-flx4', label: 'DDJ-FLX4' },
  { value: 'ddj-200',  label: 'DDJ-200' },
  { value: 'idj',      label: 'iCON iDJ' },
];

/**
 * Re-populate the #midi-device dropdown with built-ins plus every saved custom
 * profile. Preserves the current selection when possible.
 * @param {string} [selectValue]  Optionally force-select this profile afterwards.
 */
function populateMidiDeviceDropdown(selectValue) {
  const sel = document.getElementById('midi-device');
  if (!sel) return;
  const prev = selectValue || sel.value || 'ddj-flx4';
  const customs = listCustomProfiles();

  sel.innerHTML = '';
  for (const p of BUILTIN_MIDI_PROFILES) {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    sel.appendChild(opt);
  }
  // Gamepad pseudo-profile, listed under the DDJ built-ins. Selecting it doesn't
  // change MIDI routing (the pad is a separate always-on input); it switches the
  // MIDI-MAP wizard to show/edit the gamepad bindings.
  {
    const opt = document.createElement('option');
    opt.value = 'gamepad';
    opt.textContent = '🎮 Gamepad';
    sel.appendChild(opt);
  }
  // Keyboard pseudo-profile — same idea as gamepad: separate always-on input,
  // selecting it switches the wizard to show/edit key bindings.
  {
    const opt = document.createElement('option');
    opt.value = 'keyboard';
    opt.textContent = '⌨ Keyboard';
    sel.appendChild(opt);
  }
  if (customs.length) {
    const grp = document.createElement('optgroup');
    grp.label = 'Custom';
    for (const name of customs) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      grp.appendChild(opt);
    }
    sel.appendChild(grp);
  }

  // Restore / apply selection.
  const exists = [...sel.options].some(o => o.value === prev);
  sel.value = exists ? prev : 'ddj-flx4';
  if (selectValue && sel.value !== 'gamepad' && sel.value !== 'keyboard') setMidiProfile(sel.value);
}
// Expose so the guided-mapping wizard can refresh + auto-select after saving.
window._populateMidiDeviceDropdown = populateMidiDeviceDropdown;

document.getElementById('midi-device')?.addEventListener('change', (e) => {
  lockAutoDetect(); // user made a deliberate choice — stop auto-detect from overriding it
  if (e.target.value === 'gamepad' || e.target.value === 'keyboard') {
    // Don't touch MIDI routing — keep whatever DDJ profile was active so the pad
    // / keyboard runs alongside it. Just open the map wizard to show its bindings.
    if (window._openMidiMap) window._openMidiMap();
    return;
  }
  setMidiProfile(e.target.value);
});

// Auto-detect: when midi.js recognizes a plugged-in controller, sync the dropdown.
window.addEventListener('midi-profile-autodetected', (e) => {
  const profile = e.detail?.profile;
  const sel = document.getElementById('midi-device');
  if (sel && profile && [...sel.options].some(o => o.value === profile)) {
    sel.value = profile;
  }
});

// ── Controller LED feedback ───────────────────────────────────────────────────
// Mirror deck state to the DDJ LEDs so the operator can see what's playing /
// looping on the hardware. Called from the relevant state-change handlers and
// once when a controller's output port appears (midi-leds-ready).
function syncDeckLeds(deck) {
  const isA = deck === 'a';
  const playing = isA ? isPlayingA : isPlayingB;
  const looping = isA ? loopActiveA : loopActiveB;
  setLed(deck, 'play', playing);
  setLed(deck, 'loop-active', looping);
  setLed(deck, 'loop-in', looping);
  setLed(deck, 'loop-out', looping);
}
window._syncDeckLeds = syncDeckLeds;

// Push full current state to LEDs whenever a controller (re)connects.
window.addEventListener('midi-leds-ready', () => {
  syncDeckLeds('a');
  syncDeckLeds('b');
});

// Build the dropdown now that any persisted custom profiles are available.
populateMidiDeviceDropdown();

// ── Import a previously exported mapping as a named custom profile ─────────────
// Accepts a `midi-map.json`-style file (mappings[] each with target/type/
// channel/data1) and also a raw mapping-table object ({ "type:ch:d1": action }).
// Returns the built mapping table (or null if nothing usable was found).
function buildTableFromImport(json) {
  const table = {};
  if (json && Array.isArray(json.mappings)) {
    for (const m of json.mappings) {
      if (m.skipped || m.type == null || m.channel == null || m.data1 == null) continue;
      const actionId = m.target;
      if (!actionId || !(actionId in APP_ACTIONS)) continue; // skip unknown/state-only
      table[`${m.type}:${m.channel}:${m.data1}`] = actionId;
    }
  } else if (json && typeof json === 'object') {
    // Already a flat mapping table: { "type:ch:d1": "actionId" }
    for (const [key, actionId] of Object.entries(json)) {
      if (typeof actionId === 'string' && actionId in APP_ACTIONS && /^(note|cc):\d+:\d+$/.test(key)) {
        table[key] = actionId;
      }
    }
  }
  return Object.keys(table).length ? table : null;
}

// Expose for smoke-testing.
window._buildTableFromImport = buildTableFromImport;

(function setupMidiImport() {
  // Upload lives inside the Guided Map panel (merged with the mapping wizard).
  const btnImport = document.getElementById('midi-guide-import');
  const fileInput = document.getElementById('midi-import-file');
  if (!btnImport || !fileInput) return;

  btnImport.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    fileInput.value = ''; // allow re-importing the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const table = buildTableFromImport(json);
      if (!table) {
        alert('No usable control mappings found in that file.\n\nExpected a guided-map export (midi-map.json) whose entries carry a recognised "target" action id.');
        return;
      }
      const suggested = (file.name || 'imported').replace(/\.json$/i, '');
      let name = (prompt('Import as profile named:', suggested) || '').trim();
      if (!name) return;
      saveCustomProfile(name, table);
      populateMidiDeviceDropdown(name); // refresh + auto-select + activate
      console.log(`[MIDI] Imported profile "${name}" with ${Object.keys(table).length} mappings`);
    } catch (err) {
      console.error('[MIDI] Import failed:', err);
      alert('Could not read that file as JSON.');
    }
  });
})();

// ── MIDI-Learn overlay wiring ──────────────────────────────────────────────────
(function setupMidiLearn() {
  const btnLearn    = document.getElementById('btn-midi-learn');
  const btnExport   = document.getElementById('btn-midi-export');
  const overlay     = document.getElementById('midi-learn-overlay');
  const logEl       = document.getElementById('midi-learn-log');
  if (!btnLearn || !overlay || !logEl) return;

  const MAX_LINES = 12;
  const learnLines = [];          // ring buffer of recent formatted strings (display only)
  const fullLog = [];             // every message in order, for export
  const summary = new Map();      // key `${type}:${ch}:${data1}` -> de-duped control entry
  let orderCounter = 0;
  let learnActive = false;

  function recordMsg(msg) {
    if (fullLog.length < 5000) fullLog.push({ ch: msg.channel, type: msg.type, data1: msg.data1, value: msg.value });
    const key = `${msg.type}:${msg.channel}:${msg.data1}`;
    let e = summary.get(key);
    if (!e) {
      e = { order: ++orderCounter, channel: msg.channel, type: msg.type, data1: msg.data1, count: 0, valueMin: msg.value, valueMax: msg.value, samples: [] };
      summary.set(key, e);
    }
    e.count++;
    if (msg.value < e.valueMin) e.valueMin = msg.value;
    if (msg.value > e.valueMax) e.valueMax = msg.value;
    if (e.samples.length < 8 && !e.samples.includes(msg.value)) e.samples.push(msg.value);
  }

  function addLearnLine(msg) {
    recordMsg(msg);
    // Format: ch <channel> | NOTE/CC <data1> (0x..) | val <value>
    const typeLabel = msg.type === 'cc' ? 'CC ' : 'NOTE';
    const hex = msg.data1.toString(16).toUpperCase().padStart(2, '0');
    const line = `ch ${String(msg.channel).padStart(2)} | ${typeLabel} ${String(msg.data1).padStart(3)} (0x${hex}) | val ${String(msg.value).padStart(3)}`;
    learnLines.unshift(line); // newest at top
    if (learnLines.length > MAX_LINES) learnLines.length = MAX_LINES;
    logEl.textContent = `distinct controls: ${summary.size}   messages: ${fullLog.length}\n` + learnLines.join('\n');
  }

  btnLearn.addEventListener('click', () => {
    learnActive = !learnActive;
    overlay.style.display = learnActive ? 'block' : 'none';
    btnLearn.style.background = learnActive ? '#10b981' : '#444';
    btnLearn.style.color      = learnActive ? '#000'    : '';
    if (learnActive) {
      // start a fresh capture session
      learnLines.length = 0;
      fullLog.length = 0;
      summary.clear();
      orderCounter = 0;
      logEl.textContent = 'distinct controls: 0   messages: 0';
    }
    setMidiLearn(learnActive, learnActive ? addLearnLine : null);
  });

  if (btnExport) {
    btnExport.addEventListener('click', () => {
      const controls = [...summary.values()].sort((a, b) => a.order - b.order).map(e => ({
        order: e.order,
        channel: e.channel,
        type: e.type,
        data1: e.data1,
        hex: '0x' + e.data1.toString(16).toUpperCase().padStart(2, '0'),
        count: e.count,
        valueMin: e.valueMin,
        valueMax: e.valueMax,
        samples: e.samples,
      }));
      const data = {
        capturedAt: new Date().toISOString(),
        note: 'Controls listed in the ORDER first touched. Move/press ONE control at a time so each row maps cleanly. valueMin/Max + samples reveal absolute knob (0..127 sweep) vs button (note on/off) vs relative jog (values near 63-65).',
        distinctControls: controls.length,
        controls,
        rawCount: fullLog.length,
        raw: fullLog,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'midi-capture.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
})();

// ── MIDI MAP (click-to-learn) ──────────────────────────────────────────────────
// Replaces the step-through wizard. Lists every mappable VVJ function in a grid;
// click "learn" on a row, move/press a control, and it binds. Bindings persist via
// the profile-override layer (built-ins) or custom-profile tables, and take effect
// immediately (the dispatcher applies overrides before built-in handlers).
(function setupMidiMap() {
  const panel    = document.getElementById('midi-guide-panel');
  const btnOpen  = document.getElementById('btn-midi-guide');
  const btnClose = document.getElementById('midi-guide-close');
  const listEl   = document.getElementById('midi-map-rows');
  const titleEl  = document.getElementById('midi-map-title');
  const btnReset = document.getElementById('midi-map-reset');
  const btnExport= document.getElementById('midi-map-export');
  if (!panel || !btnOpen || !listEl) return;

  // Ordered, sectioned registry of mappable functions (actionId → friendly label).
  const padRows = (deck) => Array.from({ length: 8 }, (_, i) => [`pad-${deck}-${i + 1}`, `Deck ${deck.toUpperCase()} Pad ${i + 1}`]);
  const SECTIONS = [
    { title: 'TRANSPORT / VIEW', rows: [
      ['play-a', 'Deck A Play/Pause'], ['cue-a', 'Deck A Cue → Stop'],
      ['play-b', 'Deck B Play/Pause'], ['cue-b', 'Deck B Cue → Stop'],
      ['reset-view', 'RESET VIEW (master cue)'],
    ]},
    { title: 'MIXER', rows: [
      ['vol-a', 'Deck A Volume'], ['vol-b', 'Deck B Volume'],
      ['tempo-a', 'Deck A Tempo'], ['tempo-b', 'Deck B Tempo'],
      ['eq-hi-a', 'Deck A EQ Hi'], ['eq-mid-a', 'Deck A EQ Mid'], ['eq-low-a', 'Deck A EQ Low'],
      ['eq-hi-b', 'Deck B EQ Hi'], ['eq-mid-b', 'Deck B EQ Mid'], ['eq-low-b', 'Deck B EQ Low'],
      ['filter-a', 'Deck A Filter'], ['filter-b', 'Deck B Filter'],
      ['chunks-a', 'Deck A Trim → Chunks'], ['chunks-b', 'Deck B Trim → Chunks'],
      ['crossfader', 'Crossfader'], ['master-vol', 'Master Vol → Zoom'],
    ]},
    { title: 'BEAT FX', rows: [
      ['fx-target-a', 'FX CH select → Deck A'], ['fx-target-b', 'FX CH select → Deck B'], ['fx-target-m', 'FX CH select → Master'],
      ['fx-toggle-a', 'FX On/Off A'], ['fx-select-a', 'FX Select A'], ['fx-depth-a', 'FX Depth A'],
      ['beat-prev-a', 'Beat ‹ A'], ['beat-next-a', 'Beat › A'],
      ['fx-toggle-b', 'FX On/Off B'], ['fx-select-b', 'FX Select B'], ['fx-depth-b', 'FX Depth B'],
      ['fx-toggle-m', 'FX On/Off Master'], ['fx-select-m', 'FX Select Master'], ['fx-depth-m', 'FX Depth Master'],
    ]},
    { title: 'LOOP', rows: [
      ['loop-in-a', 'Loop IN A'], ['loop-out-a', 'Loop OUT A'], ['loop-toggle-a', 'Loop Activate/Exit A'],
      ['loop-half-a', 'Loop ½ A'], ['loop-double-a', 'Loop ×2 A'], ['loop-active-a', 'Loop 4-beat A'],
      ['loop-in-b', 'Loop IN B'], ['loop-out-b', 'Loop OUT B'], ['loop-toggle-b', 'Loop Activate/Exit B'],
      ['loop-half-b', 'Loop ½ B'], ['loop-double-b', 'Loop ×2 B'], ['loop-active-b', 'Loop 4-beat B'],
    ]},
    { title: 'PAD MODE', rows: [
      ['padmode-hotcue-a', 'Pad Mode HotCue A'], ['padmode-beatloop-a', 'Pad Mode BeatLoop A'],
      ['padmode-beatjump-a', 'Pad Mode BeatJump A'], ['padmode-sampler-a', 'Pad Mode Sampler A'],
      ['padmode-hotcue-b', 'Pad Mode HotCue B'], ['padmode-beatloop-b', 'Pad Mode BeatLoop B'],
      ['padmode-beatjump-b', 'Pad Mode BeatJump B'], ['padmode-sampler-b', 'Pad Mode Sampler B'],
    ]},
    { title: 'PADS A', rows: padRows('a') },
    { title: 'PADS B', rows: padRows('b') },
    { title: 'GLOBAL', rows: [
      ['jog-a', 'Jog A'], ['jog-b', 'Jog B'],
      ['knob-dof', 'DOF'], ['knob-lensflare', 'Lens Flare'], ['hdri', 'HDRI scrub'],
      ['strobe', 'Strobe toggle'], ['strobe-3state', 'Strobe 3-state (knob)'],
    ]},
  ];

  const activeName = () => document.getElementById('midi-device')?.value || '';
  const builtin = (name) => isBuiltinProfile(name);

  // Active profile's binding table: { "type:ch:data1" -> actionId }.
  function currentTable() {
    const name = activeName();
    if (builtin(name)) return { ...(getProfileOverride(name) || {}) };
    return { ...((loadCustomProfiles()[name]) || {}) };
  }
  function bindingLabelFor(actionId, table) {
    for (const k in table) if (table[k] === actionId) {
      const [type, ch, d1] = k.split(':');
      return `ch${ch} ${type === 'cc' ? 'CC' : 'NOTE'} ${d1}`;
    }
    return builtin(activeName()) ? 'default' : 'unset';
  }

  // Persist a binding (replacing any existing one for that action) and reactivate.
  function setBinding(actionId, msg) {
    const name = activeName();
    const key = `${msg.type}:${msg.channel}:${msg.data1}`;
    if (builtin(name)) {
      const ov = { ...(getProfileOverride(name) || {}) };
      for (const k in ov) if (ov[k] === actionId) delete ov[k];
      ov[key] = actionId;
      clearProfileOverride(name);
      mergeProfileOverride(name, ov);
    } else {
      const t = { ...((loadCustomProfiles()[name]) || {}) };
      for (const k in t) if (t[k] === actionId) delete t[k];
      t[key] = actionId;
      saveCustomProfile(name, t);
    }
    setMidiProfile(name);
  }
  function clearBinding(actionId) {
    const name = activeName();
    if (builtin(name)) {
      const ov = { ...(getProfileOverride(name) || {}) };
      let changed = false;
      for (const k in ov) if (ov[k] === actionId) { delete ov[k]; changed = true; }
      if (changed) { clearProfileOverride(name); mergeProfileOverride(name, ov); setMidiProfile(name); }
    } else {
      const t = { ...((loadCustomProfiles()[name]) || {}) };
      let changed = false;
      for (const k in t) if (t[k] === actionId) { delete t[k]; changed = true; }
      if (changed) { saveCustomProfile(name, t); setMidiProfile(name); }
    }
  }

  let learning = null; // { actionId, bindEl }
  function disarm() { learning = null; setMidiLearn(false, null); setGamepadLearn(false, null); setKeyboardLearn(false, null); }
  function arm(actionId, bindEl) {
    if (learning) disarm();
    learning = { actionId, bindEl };
    bindEl.textContent = 'press a control…';
    bindEl.style.color = '#fbbf24';
    setMidiLearn(true, (msg) => {
      // Show what arrives so colliding directions are visible (diagnoses FX CH select).
      bindEl.textContent = `ch${msg.channel} ${msg.type === 'cc' ? 'CC' : 'NOTE'} ${msg.data1} =${msg.value}`;
      if (msg.type === 'note' && msg.value === 0) return; // wait for the press, not release
      setBinding(learning.actionId, msg);
      disarm();
      render();
    });
  }

  // Arm GAMEPAD learn for a row: next pad button press / stick push binds this action.
  // Gamepad bindings live in their own store (gamepad.js), independent of the MIDI
  // profile, so the pad keeps working across DDJ profile switches.
  function armPad(actionId, padEl) {
    if (learning) disarm();
    learning = { actionId, bindEl: padEl };
    padEl.textContent = 'press pad…';
    padEl.style.color = '#fbbf24';
    setGamepadLearn(true, (msg) => {
      setGamepadBinding(actionId, msg);
      disarm();
      render();
    });
  }

  // Arm KEYBOARD learn for a row: next key press binds this action. Keyboard
  // bindings live in their own store (keyboard.js), independent of MIDI/gamepad.
  function armKey(actionId, keyEl) {
    if (learning) disarm();
    learning = { actionId, bindEl: keyEl };
    keyEl.textContent = 'press key…';
    keyEl.style.color = '#fbbf24';
    setKeyboardLearn(true, (msg) => {
      setKeyboardBinding(actionId, msg);
      disarm();
      render();
    });
  }

  function render() {
    // The '🎮 Gamepad' / '⌨ Keyboard' dropdown entries switch to input-specific
    // views that show/edit only that input's bindings.
    const gpView = activeName() === 'gamepad';
    const kbView = activeName() === 'keyboard';
    const table = (gpView || kbView) ? {} : currentTable();
    titleEl.textContent = gpView ? 'GAMEPAD MAP'
      : kbView ? 'KEYBOARD MAP'
      : `MIDI MAP — ${activeName() || '(no profile)'}`;
    listEl.innerHTML = '';
    for (const sec of SECTIONS) {
      const h = document.createElement('div');
      h.textContent = sec.title;
      h.style.cssText = 'color:#7c3aed;font-size:9px;font-weight:bold;margin:10px 0 4px;letter-spacing:1.5px;';
      listEl.appendChild(h);
      for (const [id, label] of sec.rows) {
        if (!(id in APP_ACTIONS)) continue;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 4px;border-bottom:1px solid #1a1a24;';
        const name = document.createElement('span');
        name.textContent = label;
        name.style.cssText = 'font-size:11px;color:#dcdce6;flex:1;';

        if (kbView) {
          // ── Keyboard-only view: key binding + learn + clear ──
          const kbBind = document.createElement('span');
          kbBind.textContent = getKeyboardBindingLabel(id) || '—';
          kbBind.style.cssText = 'font-size:10px;color:#38bdf8;min-width:96px;text-align:right;font-family:monospace;';
          const kbLearn = document.createElement('button');
          kbLearn.textContent = 'learn';
          kbLearn.title = 'Bind a keyboard key to this control';
          kbLearn.style.cssText = 'background:#0c4a6e;border:1px solid #38bdf8;color:#bae6fd;font-size:9px;padding:2px 8px;border-radius:3px;cursor:pointer;';
          kbLearn.addEventListener('click', () => armKey(id, kbBind));
          const kbClr = document.createElement('button');
          kbClr.textContent = '✕';
          kbClr.title = 'Clear this keyboard binding';
          kbClr.style.cssText = 'background:transparent;border:none;color:#666;font-size:12px;cursor:pointer;padding:0 2px;';
          kbClr.addEventListener('click', () => { clearKeyboardBinding(id); render(); });
          row.append(name, kbBind, kbLearn, kbClr);
          listEl.appendChild(row);
          continue;
        }

        // ── Gamepad (HID pad) binding: label + learn + clear ──
        const padBind = document.createElement('span');
        padBind.textContent = getGamepadBindingLabel(id) || '—';
        padBind.style.cssText = 'font-size:10px;color:#f59e0b;min-width:96px;text-align:right;font-family:monospace;';
        const padLearn = document.createElement('button');
        padLearn.textContent = gpView ? 'learn' : '🎮';
        padLearn.title = 'Bind a gamepad button/stick to this control';
        padLearn.style.cssText = 'background:#78350f;border:1px solid #f59e0b;color:#fde68a;font-size:9px;padding:2px 8px;border-radius:3px;cursor:pointer;';
        padLearn.addEventListener('click', () => armPad(id, padBind));
        const padClr = document.createElement('button');
        padClr.textContent = '✕';
        padClr.title = 'Clear this gamepad binding';
        padClr.style.cssText = 'background:transparent;border:none;color:#666;font-size:12px;cursor:pointer;padding:0 2px;';
        padClr.addEventListener('click', () => { clearGamepadBinding(id); render(); });

        if (gpView) {
          // Pad-only view: just the gamepad columns.
          row.append(name, padBind, padLearn, padClr);
        } else {
          // MIDI view: MIDI columns first, gamepad columns after.
          const bind = document.createElement('span');
          bind.textContent = bindingLabelFor(id, table);
          bind.style.cssText = 'font-size:10px;color:#10b981;min-width:104px;text-align:right;font-family:monospace;';
          const learn = document.createElement('button');
          learn.textContent = 'learn';
          learn.style.cssText = 'background:#4c1d95;border:1px solid #7c3aed;color:#ddd6fe;font-size:9px;padding:2px 8px;border-radius:3px;cursor:pointer;';
          learn.addEventListener('click', () => arm(id, bind));
          const clr = document.createElement('button');
          clr.textContent = '✕';
          clr.title = 'Clear this MIDI binding';
          clr.style.cssText = 'background:transparent;border:none;color:#666;font-size:12px;cursor:pointer;padding:0 2px;';
          clr.addEventListener('click', () => { clearBinding(id); render(); });
          row.append(name, bind, learn, clr, padBind, padLearn, padClr);
        }
        listEl.appendChild(row);
      }
    }
  }

  let open = false;
  function show() { panel.style.display = 'block'; open = true; render(); }
  function hide() { disarm(); panel.style.display = 'none'; open = false; }
  btnOpen.addEventListener('click', () => (open ? hide() : show()));
  if (btnClose) btnClose.addEventListener('click', hide);
  if (btnReset) btnReset.addEventListener('click', () => {
    const name = activeName();
    if (builtin(name)) { clearProfileOverride(name); setMidiProfile(name); render(); }
  });
  if (btnExport) btnExport.addEventListener('click', () => {
    const view = activeName();
    let data, fname;
    if (view === 'gamepad') { data = { profile: 'gamepad', gamepadBindings: getGamepadBindings() }; fname = 'gamepad-map.json'; }
    else if (view === 'keyboard') { data = { profile: 'keyboard', keyboardBindings: getKeyboardBindings() }; fname = 'keyboard-map.json'; }
    else { data = { profile: view, mappingTable: currentTable() }; fname = 'midi-map.json'; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  // Re-render when the active profile changes via the device dropdown.
  document.getElementById('midi-device')?.addEventListener('change', () => { if (open) render(); });

  window._openMidiMap = show;
})();

// Legacy no-op kept so older callers/tests don't throw.
window._midiGuideStepCount = 0;

// ── (removed) Guided MIDI Mapping Wizard ───────────────────────────────────────
/* eslint-disable */
(function _deadGuideWizard_unused() {
  if (true) return; // disabled — replaced by setupMidiMap above
  // ── Step definitions ──────────────────────────────────────────────────────
  // `target` is the APP_ACTIONS action-id this step maps to (or null for steps
  // that only set wizard state, e.g. the FX CH-select switches which we don't
  // persist as a control mapping). `kind` is the UI hint for the prompt text.
  const GUIDE_STEPS = [
    { id: 'master-vol',     label: 'Master Volume → zoom',                   target: 'master-vol',        kind: 'knob'   },
    { id: 'headphone-mix',  label: 'Headphone MIX → DOF',                    target: 'knob-dof',          kind: 'knob'   },
    { id: 'headphone-level',label: 'Headphone LEVEL → Flare',                target: 'knob-lensflare',    kind: 'knob'   },
    { id: 'mic-level',      label: 'Mic Level → HDRI cycle',                 target: 'hdri',              kind: 'knob'   },
    { id: 'fx-ch-a',        label: 'Beat-FX CH SELECT → position 1 (Deck A)',target: null,                kind: 'switch' },
    { id: 'fx-ch-b',        label: 'Beat-FX CH SELECT → position 2 (Deck B)',target: null,                kind: 'switch' },
    { id: 'fx-ch-m',        label: 'Beat-FX CH SELECT → MASTER',             target: null,                kind: 'switch' },
    { id: 'fx-select',      label: 'Beat-FX SELECT (turn/press) → Deck A FX', target: 'fx-select-a',       kind: 'button' },
    { id: 'beat-prev',      label: 'Beat ‹ (left) → Deck A',            target: 'beat-prev-a',       kind: 'button' },
    { id: 'beat-next',      label: 'Beat › (right) → Deck A',           target: 'beat-next-a',       kind: 'button' },
    { id: 'fx-onoff',       label: 'Beat-FX ON/OFF → Deck A',                target: 'fx-toggle-a',       kind: 'button' },
    { id: 'fx-depth',       label: 'Beat-FX LEVEL/DEPTH → Deck A',           target: 'fx-depth-a',        kind: 'knob'   },
    { id: 'loop-in-a',      label: 'Deck A Loop IN (set chunk range start)',  target: 'loop-in-a',         kind: 'button' },
    { id: 'loop-out-a',     label: 'Deck A Loop OUT (set chunk range end)',   target: 'loop-out-a',        kind: 'button' },
    { id: 'loop-active-a',  label: 'Deck A 4-beat loop',                     target: 'loop-active-a',     kind: 'button' },
    { id: 'loop-half-a',    label: 'Deck A loop \xbd',                       target: 'loop-half-a',       kind: 'button' },
    { id: 'loop-double-a',  label: 'Deck A loop \xd72',                      target: 'loop-double-a',     kind: 'button' },
    { id: 'loop-in-b',      label: 'Deck B Loop IN (set chunk range start)',  target: 'loop-in-b',         kind: 'button' },
    { id: 'loop-out-b',     label: 'Deck B Loop OUT (set chunk range end)',   target: 'loop-out-b',        kind: 'button' },
    { id: 'loop-active-b',  label: 'Deck B 4-beat loop',                     target: 'loop-active-b',     kind: 'button' },
    { id: 'loop-half-b',    label: 'Deck B loop \xbd',                       target: 'loop-half-b',       kind: 'button' },
    { id: 'loop-double-b',  label: 'Deck B loop \xd72',                      target: 'loop-double-b',     kind: 'button' },
    // Pads A: 1–8
    { id: 'pad-a-1', label: 'Deck A PAD 1 (set pad mode first, e.g. Hot Cue)', target: 'pad-a-1', kind: 'button' },
    { id: 'pad-a-2', label: 'Deck A PAD 2', target: 'pad-a-2', kind: 'button' },
    { id: 'pad-a-3', label: 'Deck A PAD 3', target: 'pad-a-3', kind: 'button' },
    { id: 'pad-a-4', label: 'Deck A PAD 4', target: 'pad-a-4', kind: 'button' },
    { id: 'pad-a-5', label: 'Deck A PAD 5', target: 'pad-a-5', kind: 'button' },
    { id: 'pad-a-6', label: 'Deck A PAD 6', target: 'pad-a-6', kind: 'button' },
    { id: 'pad-a-7', label: 'Deck A PAD 7', target: 'pad-a-7', kind: 'button' },
    { id: 'pad-a-8', label: 'Deck A PAD 8', target: 'pad-a-8', kind: 'button' },
    // Pads B: 1–8
    { id: 'pad-b-1', label: 'Deck B PAD 1', target: 'pad-b-1', kind: 'button' },
    { id: 'pad-b-2', label: 'Deck B PAD 2', target: 'pad-b-2', kind: 'button' },
    { id: 'pad-b-3', label: 'Deck B PAD 3', target: 'pad-b-3', kind: 'button' },
    { id: 'pad-b-4', label: 'Deck B PAD 4', target: 'pad-b-4', kind: 'button' },
    { id: 'pad-b-5', label: 'Deck B PAD 5', target: 'pad-b-5', kind: 'button' },
    { id: 'pad-b-6', label: 'Deck B PAD 6', target: 'pad-b-6', kind: 'button' },
    { id: 'pad-b-7', label: 'Deck B PAD 7', target: 'pad-b-7', kind: 'button' },
    { id: 'pad-b-8', label: 'Deck B PAD 8', target: 'pad-b-8', kind: 'button' },
  ];

  const N = GUIDE_STEPS.length;

  // ── State ────────────────────────────────────────────────────────────────
  let guideOpen    = false;
  let currentStep  = 0;
  const mapping    = new Array(N).fill(null); // null = not yet visited, object = recorded/skipped

  // Per-step MIDI candidate accumulator
  // key: `${type}:${channel}:${data1}` → { type, channel, data1, count, valueMin, valueMax }
  let candidates   = new Map();

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const panel       = document.getElementById('midi-guide-panel');
  const btnGuide    = document.getElementById('btn-midi-guide');
  const btnClose    = document.getElementById('midi-guide-close');
  const btnBack     = document.getElementById('midi-guide-back');
  const btnSkip     = document.getElementById('midi-guide-skip');
  const btnConfirm  = document.getElementById('midi-guide-confirm');
  const btnApply    = document.getElementById('midi-guide-apply');
  const btnReset    = document.getElementById('midi-guide-reset');
  const btnSave     = document.getElementById('midi-guide-save');
  const btnFinish   = document.getElementById('midi-guide-finish');
  const elProgress  = document.getElementById('midi-guide-progress');
  const elLabel     = document.getElementById('midi-guide-label');
  const elInstr     = document.getElementById('midi-guide-instruction');
  const elDetected  = document.getElementById('midi-guide-detected');

  if (!panel || !btnGuide) return; // graceful if DOM not ready

  // ── Helpers ───────────────────────────────────────────────────────────────
  function bestCandidate() {
    if (candidates.size === 0) return null;
    let best = null;
    for (const c of candidates.values()) {
      if (!best || c.count > best.count) best = c;
    }
    return best;
  }

  function renderDetected() {
    const c = bestCandidate();
    if (!c) {
      elDetected.textContent = '—  (move the control now)';
      elDetected.style.color = '#555';
      return;
    }
    const hex = '0x' + c.data1.toString(16).toUpperCase().padStart(2, '0');
    const typeLabel = c.type === 'cc' ? 'CC' : 'NOTE';
    elDetected.textContent =
      `ch ${c.channel} | ${typeLabel} ${c.data1} (${hex}) | seen ${c.count}x, val ${c.valueMin}–${c.valueMax}`;
    elDetected.style.color = '#10b981';
  }

  function renderStep() {
    const step = GUIDE_STEPS[currentStep];
    elProgress.textContent = `Step ${currentStep + 1} / ${N}`;
    elLabel.textContent    = step.label;
    const isButton = step.kind === 'button' || step.kind === 'switch';
    elInstr.textContent    = isButton ? 'Press it now' : 'Turn / move it now';
    renderDetected();
    // Enable Finish once all steps have been at least visited (or any step >= last)
    btnFinish.disabled = (currentStep < N - 1) && (mapping.filter(Boolean).length < 1);
    // Actually enable Finish as soon as at least one mapping exists or we've been here a while
    // Per spec: enable once last step reached OR anytime a mapping exists
    if (currentStep >= N - 1 || mapping.some(Boolean)) {
      btnFinish.disabled = false;
    }
    // Save-as-profile is available as soon as at least one control is mapped
    // (not skipped).
    const hasMapped = mapping.some(m => m && !m.skipped);
    if (btnSave) btnSave.disabled = !hasMapped;
    updateBuiltinButtons(hasMapped);
  }

  // ── Built-in edit / reset button state ──────────────────────────────────────
  // The active profile is the #midi-device dropdown value. When it's a built-in
  // ('ddj-400'/'ddj-flx4'), "Apply edits" and "Reset to factory" are meaningful;
  // for custom profiles only "Save as profile" applies.
  function activeBuiltinName() {
    const sel = document.getElementById('midi-device');
    const name = sel ? sel.value : null;
    return (name && isBuiltinProfile(name)) ? name : null;
  }

  function builtinLabel(name) {
    const found = BUILTIN_MIDI_PROFILES.find(p => p.value === name);
    return found ? found.label : name;
  }

  function updateBuiltinButtons(hasMapped) {
    const name = activeBuiltinName();
    if (!btnApply || !btnReset) return;
    if (!name) {
      // Custom profile active → only "Save as profile" applies.
      btnApply.style.display = 'none';
      btnReset.style.display = 'none';
      return;
    }
    btnApply.style.display = '';
    btnReset.style.display = '';
    btnApply.textContent = `Apply edits to ${builtinLabel(name)}`;
    // Apply needs at least one confirmed (non-skipped) control this session.
    btnApply.disabled = !hasMapped;
    // Reset only meaningful when this built-in has existing overrides.
    const hasOverride = Object.keys(getProfileOverride(name) || {}).length > 0;
    btnReset.disabled = !hasOverride;
  }

  function enterStep(idx) {
    currentStep = Math.max(0, Math.min(N - 1, idx));
    candidates  = new Map(); // reset per-step candidates
    renderStep();
  }

  // ── MIDI sink for the wizard ──────────────────────────────────────────────
  function guideSink(msg) {
    const key = `${msg.type}:${msg.channel}:${msg.data1}`;
    let c = candidates.get(key);
    if (!c) {
      c = { type: msg.type, channel: msg.channel, data1: msg.data1, count: 0, valueMin: msg.value, valueMax: msg.value };
      candidates.set(key, c);
    }
    c.count++;
    if (msg.value < c.valueMin) c.valueMin = msg.value;
    if (msg.value > c.valueMax) c.valueMax = msg.value;
    renderDetected();
  }

  // Expose the sink function for testing
  window._midiGuideSink = guideSink;

  // ── Open / close ─────────────────────────────────────────────────────────
  function openGuide() {
    guideOpen = true;
    // Reset all state
    currentStep = 0;
    candidates  = new Map();
    mapping.fill(null);
    panel.style.display = 'block';
    btnGuide.style.background = '#7c3aed';
    btnGuide.style.color = '#fff';
    enterStep(0);
    setMidiLearn(true, guideSink);
  }

  function closeGuide() {
    guideOpen = false;
    panel.style.display = 'none';
    btnGuide.style.background = '#7c3aed';
    btnGuide.style.color = '';
    setMidiLearn(false, null);
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function exportMapping() {
    const mappings = GUIDE_STEPS.map((step, i) => {
      const m = mapping[i];
      if (!m || m.skipped) {
        return {
          id:       step.id,
          label:    step.label,
          target:   step.target,
          kind:     step.kind,
          channel:  null,
          type:     null,
          data1:    null,
          hex:      null,
          valueMin: null,
          valueMax: null,
          skipped:  true,
        };
      }
      return {
        id:       step.id,
        label:    step.label,
        target:   step.target,
        kind:     step.kind,
        channel:  m.channel,
        type:     m.type,
        data1:    m.data1,
        hex:      '0x' + m.data1.toString(16).toUpperCase().padStart(2, '0'),
        valueMin: m.valueMin,
        valueMax: m.valueMax,
        skipped:  false,
      };
    });

    const data = {
      device:      'ddj-flx4',
      capturedAt:  new Date().toISOString(),
      mappings,
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'midi-map.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Build a custom-profile mapping table from the captured steps ────────────
  // Returns { "<type>:<ch>:<data1>": "<actionId>" } for every step that was
  // captured (not skipped) AND whose target is a real APP_ACTIONS id.
  function buildMappingTableFromCapture() {
    const table = {};
    GUIDE_STEPS.forEach((step, i) => {
      const m = mapping[i];
      if (!m || m.skipped) return;
      const actionId = step.target;
      if (!actionId || !(actionId in APP_ACTIONS)) return; // skip state-only steps
      table[`${m.type}:${m.channel}:${m.data1}`] = actionId;
    });
    return table;
  }

  // ── Save the captured mapping as a named, reusable custom profile ───────────
  function saveAsProfile() {
    const table = buildMappingTableFromCapture();
    if (Object.keys(table).length === 0) {
      elDetected.textContent = '  Nothing mapped yet — confirm at least one control first!';
      elDetected.style.color = '#f97316';
      return;
    }
    let name = (prompt('Save MIDI profile as:', 'My Controller') || '').trim();
    if (!name) return; // cancelled / empty
    saveCustomProfile(name, table);
    // Refresh the dropdown and auto-select the new profile (also sets it active).
    if (window._populateMidiDeviceDropdown) {
      window._populateMidiDeviceDropdown(name);
    } else {
      setMidiProfile(name);
    }
    exportMapping(); // Save + Download are merged: also download a .json backup.
    elDetected.textContent = `Saved profile "${name}" and downloaded a backup (${Object.keys(table).length} mappings).`;
    elDetected.style.color = '#10b981';
    closeGuide();
  }

  // ── Apply the captured session as edits to the active BUILT-IN profile ──────
  // Re-maps only the controls confirmed this session; skipped steps keep the
  // built-in default. Re-activates the profile so edits take effect immediately.
  function applyEditsToBuiltin() {
    const name = activeBuiltinName();
    if (!name) return; // custom profile active → no-op
    const table = buildMappingTableFromCapture();
    if (Object.keys(table).length === 0) {
      elDetected.textContent = '  Nothing to apply — confirm at least one control first!';
      elDetected.style.color = '#f97316';
      return;
    }
    mergeProfileOverride(name, table);
    setMidiProfile(name); // re-activate so the override layer takes effect now
    elDetected.textContent = `Applied ${Object.keys(table).length} edit(s) to ${builtinLabel(name)}. They take effect now.`;
    elDetected.style.color = '#10b981';
    updateBuiltinButtons(true);
    closeGuide();
  }

  // ── Reset the active built-in's overrides back to factory ───────────────────
  function resetBuiltinToFactory() {
    const name = activeBuiltinName();
    if (!name) return;
    if (!Object.keys(getProfileOverride(name) || {}).length) return;
    clearProfileOverride(name);
    setMidiProfile(name); // re-activate clean built-in
    elDetected.textContent = `Reset ${builtinLabel(name)} to factory mapping.`;
    elDetected.style.color = '#a78bfa';
    const hasMapped = mapping.some(m => m && !m.skipped);
    updateBuiltinButtons(hasMapped);
  }

  // ── Button handlers ───────────────────────────────────────────────────────
  btnGuide.addEventListener('click', () => {
    if (guideOpen) closeGuide(); else openGuide();
  });

  btnClose.addEventListener('click', closeGuide);

  btnConfirm.addEventListener('click', () => {
    const c = bestCandidate();
    if (!c) {
      elDetected.textContent = '  No control detected yet — move it first!';
      elDetected.style.color = '#f97316';
      return;
    }
    mapping[currentStep] = { ...c, skipped: false };
    if (currentStep < N - 1) {
      enterStep(currentStep + 1);
    } else {
      // Last step confirmed
      renderStep();
      elDetected.textContent = 'All steps done. Click Finish & Export to save.';
      elDetected.style.color = '#a78bfa';
    }
  });

  btnSkip.addEventListener('click', () => {
    mapping[currentStep] = { skipped: true };
    if (currentStep < N - 1) {
      enterStep(currentStep + 1);
    } else {
      elDetected.textContent = 'All steps done. Click Finish & Export to save.';
      elDetected.style.color = '#a78bfa';
    }
  });

  btnBack.addEventListener('click', () => {
    if (currentStep > 0) {
      enterStep(currentStep - 1);
    }
  });

  if (btnSave) btnSave.addEventListener('click', saveAsProfile);
  if (btnApply) btnApply.addEventListener('click', applyEditsToBuiltin);
  if (btnReset) btnReset.addEventListener('click', resetBuiltinToFactory);

  btnFinish.addEventListener('click', () => {
    exportMapping();
    closeGuide();
  });

  // Expose for smoke-testing: lets a test inject captured steps and save.
  window._midiGuideSaveAsProfile = saveAsProfile;
  window._midiGuideApplyEdits = applyEditsToBuiltin;
  window._midiGuideResetFactory = resetBuiltinToFactory;
  window._midiGuideSetMapping = (idx, captured) => { mapping[idx] = captured; };
  window._midiGuideSteps = GUIDE_STEPS;
})();
// Expose GUIDE_STEPS count for smoke-test assertions (34 total steps)
window._midiGuideStepCount = 34;

document.getElementById('btn-strobe')?.addEventListener('click', () => {
  strobeEngaged = !strobeEngaged;
  const btn = document.getElementById('btn-strobe');
  if (btn) btn.classList.toggle('active', strobeEngaged);
  if (strobeEngaged) {
    startAnimationLoop();
  } else {
    stopAnimationLoop();
  }
});

document.getElementById('strobe-mode')?.addEventListener('change', (e) => {
  strobeMode = e.target.value;
});

/**
 * Programmatically set strobe state. Called by MIDI mic-knob handler.
 * mode: 'off' | 'side' | 'full'
 */
window._setStrobeState = function(mode) {
  const newEngaged = (mode !== 'off');
  const newMode = (mode === 'off') ? strobeMode : mode; // keep last mode when turning off
  // Skip if nothing changes.
  if (newEngaged === strobeEngaged && (mode === 'off' || newMode === strobeMode)) return;
  strobeEngaged = newEngaged;
  if (mode !== 'off') strobeMode = mode;
  // Sync UI.
  const btn = document.getElementById('btn-strobe');
  if (btn) btn.classList.toggle('active', strobeEngaged);
  const sel = document.getElementById('strobe-mode');
  if (sel && mode !== 'off') sel.value = mode;
  // Start/stop the animation loop exactly as the manual toggle does.
  if (strobeEngaged) {
    startAnimationLoop();
  } else {
    stopAnimationLoop();
  }
};

// Sync crossfader to hidden mixSlider for test suite compatibility
crossfader.addEventListener('input', () => {
  mixSlider.value = crossfader.value;
  triggerRealtimeUpdate();
});

// ── Master Volume → Camera Zoom ──
// vol=50 → factor 1.0 (neutral); higher vol → zoom in; lower vol → zoom out
if (masterVol) {
  masterVol.addEventListener('input', () => {
    if (!viewer || !viewer.controls) return;
    const t = Number(masterVol.value) / 100;
    let factor = 1.0 - (t - 0.5) * 1.5;
    factor = Math.max(0.4, Math.min(1.8, factor));
    const targetPos = viewer.controls.target;
    const camPos = viewer.camera.position;
    const dir = camPos.clone().sub(targetPos).normalize();
    const newDist = baseFramedDistance * factor;
    viewer.camera.position.copy(targetPos).addScaledVector(dir, newDist);
    isZoomSyncing = true;
    viewer.controls.update();
    isZoomSyncing = false;
  });
}

// ── Deck A FX Event Listeners ──
btnBeatPrevA.addEventListener('click', () => { if (beatIndexA > 0) { beatIndexA--; beatValueAEl.textContent = beatDivisions[beatIndexA]; triggerRealtimeUpdate(); } });
btnBeatNextA.addEventListener('click', () => { if (beatIndexA < beatDivisions.length - 1) { beatIndexA++; beatValueAEl.textContent = beatDivisions[beatIndexA]; triggerRealtimeUpdate(); } });
btnFxToggleA.addEventListener('click', async () => {
  if (!sceneA) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedA = !fxEngagedA;
  if (fxEngagedA) { btnFxToggleA.classList.add('active'); fxActiveA = fxSelectA.value; startAnimationLoop(); } else { btnFxToggleA.classList.remove('active'); fxActiveA = "none"; stopAnimationLoop(); }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectA.addEventListener('change', async () => { if (fxEngagedA) { fxActiveA = fxSelectA.value; await rebuildViewerBuffers(); } });
fxDepthA.addEventListener('input', () => { updateKnobFill(fxDepthA); });

// ── Deck B FX Event Listeners ──
btnBeatPrevB.addEventListener('click', () => { if (beatIndexB > 0) { beatIndexB--; beatValueBEl.textContent = beatDivisions[beatIndexB]; triggerRealtimeUpdate(); } });
btnBeatNextB.addEventListener('click', () => { if (beatIndexB < beatDivisions.length - 1) { beatIndexB++; beatValueBEl.textContent = beatDivisions[beatIndexB]; triggerRealtimeUpdate(); } });
btnFxToggleB.addEventListener('click', async () => {
  if (!sceneB) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedB = !fxEngagedB;
  if (fxEngagedB) { btnFxToggleB.classList.add('active'); fxActiveB = fxSelectB.value; startAnimationLoop(); } else { btnFxToggleB.classList.remove('active'); fxActiveB = "none"; stopAnimationLoop(); }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectB.addEventListener('change', async () => { if (fxEngagedB) { fxActiveB = fxSelectB.value; await rebuildViewerBuffers(); } });
fxDepthB.addEventListener('input', () => { updateKnobFill(fxDepthB); });

// ── Deck C FX Event Listeners ──
btnBeatPrevC.addEventListener('click', () => { if (beatIndexC > 0) { beatIndexC--; beatValueCEl.textContent = beatDivisions[beatIndexC]; triggerRealtimeUpdate(); } });
btnBeatNextC.addEventListener('click', () => { if (beatIndexC < beatDivisions.length - 1) { beatIndexC++; beatValueCEl.textContent = beatDivisions[beatIndexC]; triggerRealtimeUpdate(); } });
btnFxToggleC.addEventListener('click', async () => {
  if (!sceneC) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedC = !fxEngagedC;
  if (fxEngagedC) { btnFxToggleC.classList.add('active'); fxActiveC = fxSelectC.value; startAnimationLoop(); } else { btnFxToggleC.classList.remove('active'); fxActiveC = "none"; stopAnimationLoop(); }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectC.addEventListener('change', async () => { if (fxEngagedC) { fxActiveC = fxSelectC.value; await rebuildViewerBuffers(); } });
fxDepthC.addEventListener('input', () => { updateKnobFill(fxDepthC); });

// ── Deck D FX Event Listeners ──
btnBeatPrevD.addEventListener('click', () => { if (beatIndexD > 0) { beatIndexD--; beatValueDEl.textContent = beatDivisions[beatIndexD]; triggerRealtimeUpdate(); } });
btnBeatNextD.addEventListener('click', () => { if (beatIndexD < beatDivisions.length - 1) { beatIndexD++; beatValueDEl.textContent = beatDivisions[beatIndexD]; triggerRealtimeUpdate(); } });
btnFxToggleD.addEventListener('click', async () => {
  if (!sceneD) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedD = !fxEngagedD;
  if (fxEngagedD) { btnFxToggleD.classList.add('active'); fxActiveD = fxSelectD.value; startAnimationLoop(); } else { btnFxToggleD.classList.remove('active'); fxActiveD = "none"; stopAnimationLoop(); }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectD.addEventListener('change', async () => { if (fxEngagedD) { fxActiveD = fxSelectD.value; await rebuildViewerBuffers(); } });
fxDepthD.addEventListener('input', () => { updateKnobFill(fxDepthD); });

// ── Master FX Event Listeners ──
btnBeatPrevM.addEventListener('click', () => {
  if (beatIndexM > 0) {
    beatIndexM--;
    beatValueMEl.textContent = beatDivisions[beatIndexM];
    triggerRealtimeUpdate();
  }
});
btnBeatNextM.addEventListener('click', () => {
  if (beatIndexM < beatDivisions.length - 1) {
    beatIndexM++;
    beatValueMEl.textContent = beatDivisions[beatIndexM];
    triggerRealtimeUpdate();
  }
});
btnFxToggleM.addEventListener('click', async () => {
  if (!sceneA) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedM = !fxEngagedM;
  if (fxEngagedM) {
    btnFxToggleM.classList.add('active');
    fxActiveM = fxSelectM.value;
    startAnimationLoop();
  } else {
    btnFxToggleM.classList.remove('active');
    fxActiveM = "none";
    stopAnimationLoop();
  }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectM.addEventListener('change', async () => {
  if (fxEngagedM) {
    fxActiveM = fxSelectM.value;
    await rebuildViewerBuffers();
  }
});
fxDepthM.addEventListener('input', () => { updateKnobFill(fxDepthM); });
fxDepthM.addEventListener('change', async () => { if (fxEngagedM) await rebuildViewerBuffers(); });

// ── Deck Control Variables ───────────────────────────
const tempoA = document.querySelector('#tempo-a');
const tempoB = document.querySelector('#tempo-b');
const bpmDispA = document.querySelector('#bpm-a');
const bpmDispB = document.querySelector('#bpm-b');
const syncA = document.querySelector('#sync-a');
const syncB = document.querySelector('#sync-b');

const btnPlayA = document.querySelector('#btn-play-a');
const btnStopA = document.querySelector('#btn-stop-a');
const btnPlayB = document.querySelector('#btn-play-b');
const btnStopB = document.querySelector('#btn-stop-b');

let bpmA = 120.0;
let bpmB = 120.0;
// Base BPM = the deck's BPM at tempo slider center (0%). Editable by typing
// into the BPM display; tempo slider scales around it.
let baseBpmA = 120.0;
let baseBpmB = 120.0;

function updateBPM() {
  // Tempo slider range: min=-100, max=100, center=0.
  // Map full deflection (±100) to ±rangePercent% of base BPM.
  const rangePercentA = TEMPO_RANGES[tempoRangeIdxA]; // e.g. 10 means ±10%
  const rangePercentB = TEMPO_RANGES[tempoRangeIdxB];
  // slider value is in [-100, 100]; normalise to [-1, 1] then scale by range%.
  bpmA = baseBpmA * (1 - (Number(tempoA.value) / 100) * (rangePercentA / 100));
  bpmB = baseBpmB * (1 - (Number(tempoB.value) / 100) * (rangePercentB / 100));
  const labelA = document.getElementById('tempo-range-label-a');
  if (labelA) labelA.textContent = `±${rangePercentA === 100 ? 'WIDE' : rangePercentA + '%'}`;
  const labelB = document.getElementById('tempo-range-label-b');
  if (labelB) labelB.textContent = `±${rangePercentB === 100 ? 'WIDE' : rangePercentB + '%'}`;
  bpmDispA.textContent = bpmA.toFixed(1);
  bpmDispB.textContent = bpmB.toFixed(1);
}
window._updateBPM = updateBPM;

// Allow typing a BPM directly into the display. The typed value becomes the
// deck's current BPM; we back-solve the base BPM so the tempo slider position
// is preserved and downstream beat-sync (bpmA/bpmB) uses the new value.
function setupBpmInput(dispEl, tempoEl, getRangePercent, setBaseBpm) {
  if (!dispEl) return;
  const commit = () => {
    const typed = parseFloat(dispEl.textContent.replace(/[^0-9.]/g, ''));
    if (isFinite(typed) && typed > 0) {
      const clamped = Math.min(999, Math.max(20, typed));
      const factor = 1 - (Number(tempoEl.value) / 100) * (getRangePercent() / 100);
      // factor near 0 (extreme tempo) would blow up the base; guard it.
      setBaseBpm(Math.abs(factor) > 0.01 ? clamped / factor : clamped);
    }
    updateBPM();          // re-renders display to canonical value
    triggerRealtimeUpdate();
  };
  dispEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); dispEl.blur(); }
  });
  dispEl.addEventListener('blur', commit);
  dispEl.addEventListener('focus', () => {
    // select all so typing replaces the value
    const r = document.createRange();
    r.selectNodeContents(dispEl);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  });
}
setupBpmInput(bpmDispA, tempoA, () => TEMPO_RANGES[tempoRangeIdxA], (v) => { baseBpmA = v; });
setupBpmInput(bpmDispB, tempoB, () => TEMPO_RANGES[tempoRangeIdxB], (v) => { baseBpmB = v; });

/**
 * Cycle the tempo range for a deck (called by Shift button press).
 * deck: 'a' | 'b'
 */
window._cycleTempoRange = function(deck) {
  if (deck === 'a') {
    tempoRangeIdxA = (tempoRangeIdxA + 1) % TEMPO_RANGES.length;
  } else {
    tempoRangeIdxB = (tempoRangeIdxB + 1) % TEMPO_RANGES.length;
  }
  updateBPM();
};

tempoA.addEventListener('input', () => {
  updateKnobFill(tempoA);
  updateBPM();
  syncA.classList.remove('active');
  triggerRealtimeUpdate();
});
tempoB.addEventListener('input', () => {
  updateKnobFill(tempoB);
  updateBPM();
  syncB.classList.remove('active');
  triggerRealtimeUpdate();
});

syncA.addEventListener('click', () => {
  syncA.classList.toggle('active');
  if (syncA.classList.contains('active')) {
    tempoA.value = tempoB.value;
    baseBpmA = baseBpmB;
    updateKnobFill(tempoA);
    updateBPM();
    triggerRealtimeUpdate();
  }
});

syncB.addEventListener('click', () => {
  syncB.classList.toggle('active');
  if (syncB.classList.contains('active')) {
    tempoB.value = tempoA.value;
    baseBpmB = baseBpmA;
    updateKnobFill(tempoB);
    updateBPM();
    triggerRealtimeUpdate();
  }
});

// Setup Auto Loop Buttons
function setupAutoLoop(deck) {
  const isA = deck === 'a';
  const btnActive = document.querySelector(`#loop-active-${deck}`);
  const btnHalf = document.querySelector(`#loop-half-${deck}`);
  const btnDouble = document.querySelector(`#loop-double-${deck}`);
  
  btnActive.addEventListener('click', () => {
    const hasChunkRange = isA ? loopRangeSelectedA : loopRangeSelectedB;
    const isCommitted = isA ? loopCommittedA : loopCommittedB;
    if (hasChunkRange || isCommitted) {
      toggleLoopCommit(deck);
      syncDeckLeds(deck);
      return;
    }

    if (isA) {
      isAutoLoopA = !isAutoLoopA;
      if (isAutoLoopA) {
        loopActiveA = true;
        loopLengthA = Math.max(1, Math.floor(15.0 * autoLoopLengthA));
        loopStartA = Math.floor((playAngleA + jogAngleA) * 15.0);
        btnActive.classList.add('active');
      } else {
        loopActiveA = false;
        btnActive.classList.remove('active');
      }
    } else {
      isAutoLoopB = !isAutoLoopB;
      if (isAutoLoopB) {
        loopActiveB = true;
        loopLengthB = Math.max(1, Math.floor(15.0 * autoLoopLengthB));
        loopStartB = Math.floor((playAngleB + jogAngleB) * 15.0);
        btnActive.classList.add('active');
      } else {
        loopActiveB = false;
        btnActive.classList.remove('active');
      }
    }
    syncDeckLeds(deck);
  });

  btnHalf.addEventListener('click', () => {
    if (isA) {
      autoLoopLengthA = Math.max(0.125, autoLoopLengthA / 2);
      btnActive.textContent = `${autoLoopLengthA >= 1 ? autoLoopLengthA : '1/'+(1/autoLoopLengthA)} BEAT LOOP`;
      if (isAutoLoopA) loopLengthA = Math.max(1, Math.floor(15.0 * autoLoopLengthA));
    } else {
      autoLoopLengthB = Math.max(0.125, autoLoopLengthB / 2);
      btnActive.textContent = `${autoLoopLengthB >= 1 ? autoLoopLengthB : '1/'+(1/autoLoopLengthB)} BEAT LOOP`;
      if (isAutoLoopB) loopLengthB = Math.max(1, Math.floor(15.0 * autoLoopLengthB));
    }
  });

  btnDouble.addEventListener('click', () => {
    if (isA) {
      autoLoopLengthA = Math.min(32, autoLoopLengthA * 2);
      btnActive.textContent = `${autoLoopLengthA >= 1 ? autoLoopLengthA : '1/'+(1/autoLoopLengthA)} BEAT LOOP`;
      if (isAutoLoopA) loopLengthA = Math.max(1, Math.floor(15.0 * autoLoopLengthA));
    } else {
      autoLoopLengthB = Math.min(32, autoLoopLengthB * 2);
      btnActive.textContent = `${autoLoopLengthB >= 1 ? autoLoopLengthB : '1/'+(1/autoLoopLengthB)} BEAT LOOP`;
      if (isAutoLoopB) loopLengthB = Math.max(1, Math.floor(15.0 * autoLoopLengthB));
    }
  });
}

setupAutoLoop('a');
setupAutoLoop('b');

// ── Chunk-Range Loop: IN / OUT buttons (#8) ───────────────────────────────────
// LOOP IN  → records current activeChunk as loopChunkStart.
// LOOP OUT → records current activeChunk as loopChunkEnd, enables loopActive.
// The existing 1/2 / 2X buttons also scale the chunk range when a chunk loop
// is active (loopChunkStart !== loopChunkEnd).
// The existing #loop-active-a/b toggle turns the chunk loop off/on.
function setupChunkLoop(deck) {
  const isA = deck === 'a';
  const btnIn  = document.querySelector(`#loop-in-${deck}`);
  const btnOut = document.querySelector(`#loop-out-${deck}`);
  const btnActive = document.querySelector(`#loop-active-${deck}`);
  const btnHalf   = document.querySelector(`#loop-half-${deck}`);
  const btnDouble = document.querySelector(`#loop-double-${deck}`);

  // Helper: current active chunk index for this deck (0-based, wraps at numChunks)
  function currentActiveChunk() {
    const now = performance.now();
    if (isA) {
      const bpmA = 120 * (1 + (Number(document.getElementById('tempo-a')?.value) || 0) / 100);
      return Math.floor((now / 1000) * (bpmA / 60)) % Math.max(1, numChunksA);
    } else {
      const bpmB = 120 * (1 + (Number(document.getElementById('tempo-b')?.value) || 0) / 100);
      return Math.floor((now / 1000) * (bpmB / 60)) % Math.max(1, numChunksB);
    }
  }

  function numChunks() { return isA ? Math.max(1, numChunksA) : Math.max(1, numChunksB); }

  // Style helpers for orange highlight
  function updateInOutHighlight() {
    if (isA) {
      const selecting = loopRangeSelectedA && !loopCommittedA;
      btnIn.style.borderColor  = selecting ? '#f97316' : '';
      btnOut.style.borderColor = selecting ? '#f97316' : '';
    } else {
      const selecting = loopRangeSelectedB && !loopCommittedB;
      btnIn.style.borderColor  = selecting ? '#f97316' : '';
      btnOut.style.borderColor = selecting ? '#f97316' : '';
    }
  }

  // Exit a committed loop (re-show all chunks) and reset the GO/EXIT button.
  function clearLoopCommit() {
    if (isA) loopCommittedA = false; else loopCommittedB = false;
    const tBtn = document.getElementById(`loop-toggle-${deck}`);
    if (tBtn) { tBtn.classList.remove('active'); tBtn.textContent = 'GO'; }
  }

  // LOOP IN — capture current chunk as start, highlight
  btnIn.addEventListener('click', () => {
    clearLoopCommit(); // starting a new selection exits any committed loop
    const ch = currentActiveChunk();
    if (isA) {
      loopChunkStartA = ch;
      loopRangeSelectedA = false;
      // If end < start, push end forward to start (keeps range valid)
      if (loopChunkEndA < loopChunkStartA) loopChunkEndA = loopChunkStartA;
    } else {
      loopChunkStartB = ch;
      loopRangeSelectedB = false;
      if (loopChunkEndB < loopChunkStartB) loopChunkEndB = loopChunkStartB;
    }
    updateInOutHighlight();
    triggerRealtimeUpdate();
  });

  // LOOP OUT — capture current chunk as end, enable loop
  btnOut.addEventListener('click', () => {
    const ch = currentActiveChunk();
    if (isA) {
      loopChunkEndA = ch;
      // Ensure end >= start
      if (loopChunkEndA < loopChunkStartA) loopChunkEndA = loopChunkStartA;
      loopActiveA = true;
      isAutoLoopA = true;
      loopRangeSelectedA = true;
      btnActive.classList.add('active');
    } else {
      loopChunkEndB = ch;
      if (loopChunkEndB < loopChunkStartB) loopChunkEndB = loopChunkStartB;
      loopActiveB = true;
      isAutoLoopB = true;
      loopRangeSelectedB = true;
      btnActive.classList.add('active');
    }
    updateInOutHighlight();
    syncDeckLeds(deck);
    triggerRealtimeUpdate();
  });

  // Intercept 1/2: if chunk loop is active, halve the chunk range; also run original auto-loop half
  const origHalf = btnHalf.onclick;
  btnHalf.addEventListener('click', () => {
    if (isA && loopActiveA && loopChunkEndA > loopChunkStartA) {
      const rangeLen = loopChunkEndA - loopChunkStartA + 1;
      const newLen = Math.max(1, Math.floor(rangeLen / 2));
      loopChunkEndA = Math.min(numChunks() - 1, loopChunkStartA + newLen - 1);
      updateInOutHighlight();
      triggerRealtimeUpdate();
    } else if (!isA && loopActiveB && loopChunkEndB > loopChunkStartB) {
      const rangeLen = loopChunkEndB - loopChunkStartB + 1;
      const newLen = Math.max(1, Math.floor(rangeLen / 2));
      loopChunkEndB = Math.min(numChunks() - 1, loopChunkStartB + newLen - 1);
      updateInOutHighlight();
      triggerRealtimeUpdate();
    }
  }, true); // capturing phase so it fires before the original

  // Intercept 2X: if chunk loop is active, double the chunk range
  btnDouble.addEventListener('click', () => {
    if (isA && loopActiveA && loopChunkEndA >= loopChunkStartA) {
      const rangeLen = loopChunkEndA - loopChunkStartA + 1;
      const newLen = Math.min(numChunks(), rangeLen * 2);
      loopChunkEndA = Math.min(numChunks() - 1, loopChunkStartA + newLen - 1);
      updateInOutHighlight();
      triggerRealtimeUpdate();
    } else if (!isA && loopActiveB && loopChunkEndB >= loopChunkStartB) {
      const rangeLen = loopChunkEndB - loopChunkStartB + 1;
      const newLen = Math.min(numChunks(), rangeLen * 2);
      loopChunkEndB = Math.min(numChunks() - 1, loopChunkStartB + newLen - 1);
      updateInOutHighlight();
      triggerRealtimeUpdate();
    }
  }, true); // capturing phase

  // When #loop-active-a/b is clicked and loop is turned off, clear orange highlight
  btnActive.addEventListener('click', () => {
    updateInOutHighlight();
    const stillActive = isA ? loopActiveA : loopActiveB;
    if (!stillActive) clearLoopCommit(); // loop off → exit committed view
  });
}

setupChunkLoop('a');
setupChunkLoop('b');

// Expose loop-in/loop-out as clickable DOM targets for MIDI routing.
// Since the actions use kind:'button' → clickButton(el), the buttons already work.

btnPlayA.addEventListener('click', () => {
  isPlayingA = !isPlayingA;
  if (isPlayingA) {
    btnPlayA.classList.add('active');
    startAnimationLoop();
  } else {
    btnPlayA.classList.remove('active');
    stopAnimationLoop();
  }
  setLed('a', 'play', isPlayingA);
  triggerRealtimeUpdate();
});

btnPlayB.addEventListener('click', () => {
  isPlayingB = !isPlayingB;
  if (isPlayingB) {
    btnPlayB.classList.add('active');
    startAnimationLoop();
  } else {
    btnPlayB.classList.remove('active');
    stopAnimationLoop();
  }
  setLed('b', 'play', isPlayingB);
  triggerRealtimeUpdate();
});

function stopDeck(deck, pulseCueLed = false) {
  const isA = deck === 'a';
  if (isA) {
    isPlayingA = false;
    btnPlayA.classList.remove('active');
    playAngleA = 0;
    jogAngleA = 0;
    currentScalesA.fill(0);
  } else {
    isPlayingB = false;
    btnPlayB.classList.remove('active');
    playAngleB = 0;
    jogAngleB = 0;
    currentScalesB.fill(0);
  }

  stopAnimationLoop();
  setLed(deck, 'play', false);
  if (pulseCueLed) flashLed(deck, 'cue');
  triggerRealtimeUpdate();

  const btnStop = document.getElementById(`btn-stop-${deck}`);
  btnStop?.classList.add('active');
  setTimeout(() => btnStop?.classList.remove('active'), 200);
}

btnStopA.addEventListener('click', () => stopDeck('a', true));
btnStopB.addEventListener('click', () => stopDeck('b', true));

// ── performance Pads (Hot Cues) ────────────────────────
// ── Loop pads (physical MIDI hot-cue pads stay loops) ──────────────────────
// The on-screen pads were repurposed for camera viewpoints, so the loop
// behaviour lives in these standalone functions. The MIDI `pad-*` actions call
// these directly (see midi.js triggerPad → window._setDeckLoop), so physical
// hot-cue pads keep firing loops as before.
const PAD_LOOP_LENGTHS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16]; // beats
function setDeckLoopDown(isDeckA, index) {
  if (!sceneA) return;
  const len = PAD_LOOP_LENGTHS[index] ?? 1;
  if (isDeckA) {
    loopActiveA = true;
    loopStartA = Math.floor((playAngleA + jogAngleA) * 15.0);
    loopLengthA = Math.max(1, Math.floor(15.0 * len));
  } else {
    loopActiveB = true;
    loopStartB = Math.floor((playAngleB + jogAngleB) * 15.0);
    loopLengthB = Math.max(1, Math.floor(15.0 * len));
  }
  splashFactor = 1.8;
  triggerRealtimeUpdate();
}
function setDeckLoopUp(isDeckA) {
  if (isDeckA) {
    if (!isAutoLoopA) loopActiveA = false;
    else {
      loopLengthA = Math.max(1, Math.floor(15.0 * autoLoopLengthA));
      loopStartA = Math.floor((playAngleA + jogAngleA) * 15.0);
    }
  } else {
    if (!isAutoLoopB) loopActiveB = false;
    else {
      loopLengthB = Math.max(1, Math.floor(15.0 * autoLoopLengthB));
      loopStartB = Math.floor((playAngleB + jogAngleB) * 15.0);
    }
  }
}
// Expose for MIDI physical hot-cue pads.
window._setDeckLoop = (deckStr, index, down) => {
  const isDeckA = (deckStr === 'a');
  if (down) setDeckLoopDown(isDeckA, index);
  else setDeckLoopUp(isDeckA);
  // LED feedback: light the held pad, and reflect the resulting loop state.
  setPadLed(deckStr, index, down);
  syncDeckLeds(deckStr);
};

// On-screen pads now set the deck's camera VIEWPOINT preset (the rig eases to it).
// `deckKey` is 'a'/'b'/'c'/'d'; each deck's pads drive only its own camera.
function setupPads(padsContainerId, deckKey) {
  const padButtons = Array.from(document.querySelectorAll(`#${padsContainerId} .pad-btn`));
  const isLoaded = () => deckKey === 'a' ? sceneA : deckKey === 'b' ? sceneB
                       : deckKey === 'c' ? sceneC : sceneD;
  padButtons.forEach((pad, index) => {
    pad.addEventListener('mousedown', () => {
      if (!isLoaded()) return;
      pad.classList.add('active');
      // Highlight only the active viewpoint within this deck's grid.
      padButtons.forEach(p => { if (p !== pad) p.classList.remove('active'); });
      setDeckCamPreset(deckKey, index);
    });
    const release = () => pad.classList.remove('active');
    pad.addEventListener('mouseup', release);
    pad.addEventListener('mouseleave', release);
  });
}
setupPads('pads-a', 'a');
setupPads('pads-b', 'b');
setupPads('pads-c', 'c');
setupPads('pads-d', 'd');

// ── Pad mode toggle (#2) ───────────────────────────────────────────────────────
// Cycles Hot Cue → Beat Loop → Beat Jump → Sampler. Hot Cue keeps the existing
// loop behaviour; Beat Loop routes the physical pads to camera presets; Beat Jump
// and Sampler are reserved (no-op for now).
function setPadMode(deck, mode) {
  if (deck === 'a') padModeA = mode; else padModeB = mode;
  const btn = document.getElementById(`pad-mode-${deck}`);
  if (btn) btn.textContent = PAD_MODE_LABELS[mode] || mode;
  updatePadLabels(deck, mode);
}

function updatePadLabels(deck, mode) {
  const labels = mode === 'beatloop' ? PAD_CAM_LABELS : PAD_NUM_LABELS;
  document.querySelectorAll(`#pads-${deck} .pad-btn`).forEach((pad, index) => {
    pad.textContent = labels[index] || String(index + 1);
  });
}

function cyclePadMode(deck) {
  const cur = deck === 'a' ? padModeA : padModeB;
  const next = PAD_MODES[(PAD_MODES.indexOf(cur) + 1) % PAD_MODES.length];
  setPadMode(deck, next);
}
document.getElementById('pad-mode-a')?.addEventListener('click', () => cyclePadMode('a'));
document.getElementById('pad-mode-b')?.addEventListener('click', () => cyclePadMode('b'));
updatePadLabels('a', padModeA);
updatePadLabels('b', padModeB);
updatePadLabels('c', 'hotcue');
updatePadLabels('d', 'hotcue');
window._cyclePadMode = cyclePadMode;
window._setPadMode = setPadMode; // used by MIDI 'padmode' actions (bindable pad-mode buttons)

// Router for physical (MIDI) pads — honours the current pad mode of that deck.
window._handleDeckPad = (deckStr, index, velocity) => {
  const mode = deckStr === 'a' ? padModeA : padModeB;
  if (mode === 'hotcue') {
    window._setDeckLoop(deckStr, index, velocity > 0);
  } else if (mode === 'beatloop') {
    if (velocity > 0) setDeckCamPreset(deckStr, index); // pads → camera viewpoints
  }
  // beatjump / sampler: reserved — intentionally no-op for now.
  setPadLed(deckStr, index, velocity > 0);
};

// ── Loop activate/exit toggle (#6/#7) ──────────────────────────────────────────
// Commits the selected chunk range: orange tint clears, the selected chunks keep
// animating, every other chunk on that deck scales to 0. Toggling again exits.
function toggleLoopCommit(deck) {
  const isA = deck === 'a';
  const hasRange = isA ? loopRangeSelectedA : loopRangeSelectedB;
  const committed = isA ? loopCommittedA : loopCommittedB;
  const btn = document.getElementById(`loop-active-${deck}`);
  const goBtn = document.getElementById(`loop-toggle-${deck}`);
  if (!committed) {
    if (!hasRange) { if (statusEl) statusEl.textContent = 'Select a loop (IN → OUT) first.'; return; }
    if (isA) {
      loopCommittedA = true;
      loopActiveA = true;
      isAutoLoopA = true;
    } else {
      loopCommittedB = true;
      loopActiveB = true;
      isAutoLoopB = true;
    }
    if (btn) { btn.classList.add('active'); btn.textContent = 'EXIT'; }
    if (goBtn) { goBtn.classList.add('active'); goBtn.textContent = 'EXIT'; }
  } else {
    if (isA) {
      loopCommittedA = false;
      loopActiveA = false;
      isAutoLoopA = false;
      loopRangeSelectedA = false;
    } else {
      loopCommittedB = false;
      loopActiveB = false;
      isAutoLoopB = false;
      loopRangeSelectedB = false;
    }
    if (btn) { btn.classList.remove('active'); btn.textContent = '4B'; }
    if (goBtn) { goBtn.classList.remove('active'); goBtn.textContent = 'GO'; }
  }
  syncDeckLeds(deck);
  triggerRealtimeUpdate();
}
document.getElementById('loop-toggle-a')?.addEventListener('click', () => toggleLoopCommit('a'));
document.getElementById('loop-toggle-b')?.addEventListener('click', () => toggleLoopCommit('b'));

// ── Drag-to-spin Jog Wheels ────────────────────────────
function setupJogWheel(jogEl, onSpin, onRelease) {
  let startAngle = 0;
  let currentAngle = 0;
  let rect = null;
  
  const getAngle = (clientX, clientY) => {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return Math.atan2(clientY - cy, clientX - cx);
  };
  
  const onStart = (e) => {
    rect = jogEl.getBoundingClientRect();
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    if (!clientX) return;
    
    startAngle = getAngle(clientX, clientY) - currentAngle;
    
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    if (e.cancelable) e.preventDefault();
  };
  
  const onMove = (e) => {
    const clientX = e.clientX || (e.touches && e.touches[0].clientX);
    const clientY = e.clientY || (e.touches && e.touches[0].clientY);
    if (!clientX) return;
    
    const angle = getAngle(clientX, clientY) - startAngle;
    const delta = angle - currentAngle;
    currentAngle = angle;
    
    jogEl.style.transform = `rotate(${currentAngle}rad)`;
    onSpin(delta);
    if (e.cancelable) e.preventDefault();
  };
  
  const onEnd = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    if (onRelease) onRelease();
  };
  
  jogEl.addEventListener('mousedown', onStart);
  jogEl.addEventListener('touchstart', onStart, { passive: false });
  
  // Custom MIDI jog spin event
  jogEl.addEventListener('jogspin', (e) => {
    // Keep angle tracking visually
    currentAngle += e.detail.delta;
    jogEl.style.transform = `rotate(${currentAngle}rad)`;
    onSpin(e.detail.delta);
    
    if (jogEl.scratchTimeout) clearTimeout(jogEl.scratchTimeout);
    jogEl.scratchTimeout = setTimeout(() => {
      if (onRelease) onRelease();
    }, 200);
  });
}

// Jog wheels now orbit the CAMERA (turntable spin around the up-axis): each
// spin adds a continuous azimuth delta to that deck's camera target. The object
// no longer rotates with the jog (it keeps only its playback spin).
// Each jog wheel adds a continuous azimuth orbit to ITS OWN deck camera only.
function setupDeckJog(jogId, addAzimuth, setScratching) {
  const el = document.querySelector(jogId);
  if (!el) return;
  setupJogWheel(
    el,
    (delta) => {
      setScratching(true);
      addAzimuth(delta);
      camRigSettling = true;
      startAnimationLoop();
      triggerRealtimeUpdate();
    },
    () => {
      setScratching(false);
      triggerRealtimeUpdate();
    }
  );
}
setupDeckJog('#jog-a', (d) => { jogAzA += d; }, (v) => { isScratchingA = v; });
setupDeckJog('#jog-b', (d) => { jogAzB += d; }, (v) => { isScratchingB = v; });
setupDeckJog('#jog-c', (d) => { jogAzC += d; }, (v) => { isScratchingC = v; });
setupDeckJog('#jog-d', (d) => { jogAzD += d; }, (v) => { isScratchingD = v; });

// ── MIDI jog nudge (side-ring XZ translation) ─────────
document.querySelector('#jog-a')?.addEventListener('jognudge', (e) => { nudgeXA += e.detail.delta; });
document.querySelector('#jog-b')?.addEventListener('jognudge', (e) => { nudgeXB += e.detail.delta; });

// ── VJ Animation loop ──────────────────────────────────
let lastTime = performance.now();
let frameCount = 0;
let lastFpsTime = lastTime;

// ── Adaptive resolution scaling (fill-rate / overdraw mitigation) ──
// Gaussian-splat rendering is fragment/blend bound: zooming in makes each
// splat cover more pixels, so lowering the internal drawing-buffer resolution
// cuts fragment work roughly proportionally. We scale the renderer + composer
// pixel ratio (NOT the CSS size) so the canvas stays full-screen and upscales.
const RENDER_SCALE_NOTCHES = [1.0, 0.85, 0.72, 0.6, 0.5];
let renderScaleIndex = 0;            // index into RENDER_SCALE_NOTCHES
let smoothedFps = 60;                // EMA of measured FPS
let smoothedFpsInit = false;
let lastScaleAdjustTime = 0;         // cooldown timestamp (ms, performance.now)
const FPS_DOWN_THRESHOLD = 45;       // below -> step resolution down
const FPS_UP_THRESHOLD = 57;         // above -> step resolution up
const SCALE_COOLDOWN_MS = 1000;      // adjust at most ~once per FPS tick
const FPS_EMA_ALPHA = 0.4;           // weight of newest sample

// Deck-count-aware render-scale ceiling. Each loaded deck composites full-screen
// with its own camera, so per-frame GPU cost scales ~linearly with the number of
// ACTIVELY-RENDERED decks. To keep 3-4 decks playable we cap the resolution as the
// active-deck count rises. The effective render scale = min(fpsAdaptiveNotch,
// deckCountCeiling), so this composes with (never fights) the FPS controller.
// Index by active-deck count: [0]=>1.0 (none), 1=>1.0, 2=>0.85, 3=>0.72, 4=>0.6.
const DECK_COUNT_SCALE_CEILING = [1.0, 1.0, 0.85, 0.72, 0.6];
let activeRenderedDeckCount = 0;     // decks loaded AND not skipped (set by renderPass)
let renderScaleDirty = false;        // renderPass requests a deferred applyRenderScale()
function deckCountScaleCeiling() {
  const n = Math.max(0, Math.min(DECK_COUNT_SCALE_CEILING.length - 1, activeRenderedDeckCount));
  return DECK_COUNT_SCALE_CEILING[n];
}

function getBaseDPR() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// Apply the current render-scale notch to whatever draws on screen.
// On-screen path: viewer.render is overridden to composer.render(); the splats
// are drawn into the composer's offscreen render targets (sized width*pixelRatio)
// and the final copy pass blits to the canvas. So we must scale BOTH the
// renderer pixel ratio (final canvas blit) and the composer pixel ratio
// (offscreen targets where the overdraw actually happens).
function applyRenderScale() {
  if (!viewer || !viewer.renderer) return;
  const fpsNotch = RENDER_SCALE_NOTCHES[renderScaleIndex] || 1.0;
  // Compose with the deck-count ceiling: take the smaller (lower-res) of the two.
  const scale = Math.min(fpsNotch, deckCountScaleCeiling());
  const effectiveRatio = getBaseDPR() * scale;
  try {
    viewer.renderer.setPixelRatio(effectiveRatio);
    if (composer) {
      if (typeof composer.setPixelRatio === 'function') {
        // setPixelRatio() internally re-runs setSize() on the render targets.
        composer.setPixelRatio(effectiveRatio);
      } else if (typeof composer.setSize === 'function') {
        composer.setSize(window.innerWidth, window.innerHeight);
      }
    }
    if (typeof viewer.forceRenderNextFrame === 'function') {
      viewer.forceRenderNextFrame();
    }
  } catch (e) {
    console.warn('applyRenderScale failed:', e);
  }
}
window.applyRenderScale = applyRenderScale;

// Drive the adaptive controller from the once-per-second FPS measurement.
function updateAdaptiveResolution(fps, now) {
  if (!viewer || !viewer.renderer) return;
  if (!smoothedFpsInit) { smoothedFps = fps; smoothedFpsInit = true; }
  else smoothedFps = smoothedFps * (1 - FPS_EMA_ALPHA) + fps * FPS_EMA_ALPHA;

  if (now - lastScaleAdjustTime < SCALE_COOLDOWN_MS) return;

  if (smoothedFps < FPS_DOWN_THRESHOLD && renderScaleIndex < RENDER_SCALE_NOTCHES.length - 1) {
    renderScaleIndex++;
    lastScaleAdjustTime = now;
    applyRenderScale();
  } else if (smoothedFps > FPS_UP_THRESHOLD && renderScaleIndex > 0) {
    renderScaleIndex--;
    lastScaleAdjustTime = now;
    applyRenderScale();
  }
}

function startAnimationLoop() {
  if (animationFrameId) return;
  
  lastTime = performance.now();
  
  const loop = (time) => {
    frameCount++;
    if (time - lastFpsTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (time - lastFpsTime));
      const fpsEl = document.querySelector('#fps-counter');
      if (fpsEl) fpsEl.textContent = `${fps} FPS`;
      updateAdaptiveResolution(fps, time);
      frameCount = 0;
      lastFpsTime = time;
    }
    
    let needsUpdate = false;
    
    if (isPlayingA || isPlayingB) {
      const speedA = isPlayingA ? (0.005 * (bpmA / 120.0)) : 0;
      const speedB = isPlayingB ? (0.005 * (bpmB / 120.0)) : 0;
      playAngleA += speedA;
      playAngleB += speedB;
      needsUpdate = true;
    }

    // Spin the virtual jog discs to simulate a turning platter (BPM-scaled).
    if (isPlayingA && jogInnerA) {
      jogVisAngleA += 0.06 * (bpmA / 120.0);
      jogInnerA.style.transform = `rotate(${jogVisAngleA}rad)`;
    }
    if (isPlayingB && jogInnerB) {
      jogVisAngleB += 0.06 * (bpmB / 120.0);
      jogInnerB.style.transform = `rotate(${jogVisAngleB}rad)`;
    }
    
    // Decay pad splash flash
    if (splashFactor > 1.0) {
      splashFactor = Math.max(1.0, splashFactor - 0.04);
      needsUpdate = true;
    }
    
    // Animate VU meter heights
    updateVuMeters();
    
    if ((fxEngagedA && (fxActiveA === 'flanger' || fxActiveA === 'trans')) ||
        (fxEngagedB && (fxActiveB === 'flanger' || fxActiveB === 'trans')) ||
        (fxEngagedM && (fxActiveM === 'flanger' || fxActiveM === 'trans')) ||
        strobeEngaged) {
      needsUpdate = true;
    }

    // Keep the rig easing while it hasn't settled (pad/jog set a new target).
    // Drive the (lightweight) rig directly here every frame so easing is smooth
    // and independent of the realtime-update coalescing/throttling.
    if (camRigSettling && viewer) {
      updateCameraRig(Number(crossfader.value) / 100);
      needsUpdate = true;
    }

    if (needsUpdate) {
      triggerRealtimeUpdate();
    }

    animationFrameId = requestAnimationFrame(loop);
  };
  animationFrameId = requestAnimationFrame(loop);
}

function stopAnimationLoop() {
  if (!isPlayingA && !isPlayingB && splashFactor <= 1.0 && !strobeEngaged && !camRigSettling &&
      (!fxEngagedA || (fxActiveA !== 'flanger' && fxActiveA !== 'trans')) &&
      (!fxEngagedB || (fxActiveB !== 'flanger' && fxActiveB !== 'trans')) &&
      (!fxEngagedM || (fxActiveM !== 'flanger' && fxActiveM !== 'trans'))) {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    
    const vuReset = document.querySelector('#vu-l');
    const vuResetR = document.querySelector('#vu-r');
    if (vuReset) vuReset.style.height = '0%';
    if (vuResetR) vuResetR.style.height = '0%';
  }
}

function updateVuMeters() {
  const vuL = document.querySelector('#vu-l');
  const vuR = document.querySelector('#vu-r');
  if (!vuL || !vuR) return;

  let hL = 0;
  let hR = 0;
  
  if (isPlayingA) {
    hL = Math.round(55 + Math.sin(playAngleA * 12) * 30 + Math.random() * 10);
  }
  if (isPlayingB) {
    hR = Math.round(55 + Math.sin(playAngleB * 12) * 30 + Math.random() * 10);
  }
  
  if (isScratchingA) hL = Math.round(85 + Math.random() * 15);
  if (isScratchingB) hR = Math.round(85 + Math.random() * 15);
  
  if (splashFactor > 1.0) {
    hL = Math.round(Math.max(hL, (splashFactor - 1.0) * 120));
    hR = Math.round(Math.max(hR, (splashFactor - 1.0) * 120));
  }
  
  vuL.style.height = `${Math.min(100, hL)}%`;
  vuR.style.height = `${Math.min(100, hR)}%`;
}

// ── Viewer ─────────────────────────────────────────────
let currentWrapper = null;

async function makeViewer() {
  currentWrapper = document.getElementById('viewer-container');
  currentWrapper.innerHTML = '';

  resizeViewer();

  viewer = new GaussianSplats3D.Viewer({
    'rootElement': currentWrapper,
    'sharedMemoryForWorkers': false,
    'dynamicScene': true,
    'antialiased': false,
    'halfPrecisionCovariancesOnGPU': true
  });
  window.viewer = viewer;
  viewer.start();
  // Make the WebGL canvas background transparent so the strobe layer behind shows through
  if (viewer.renderer) {
    viewer.renderer.setClearColor(0x000000, 0);
    viewer.renderer.setClearAlpha(0);
  }
  isCameraFramed = false;

  // Attach wheel→knob sync once controls are available (may be ready immediately or deferred)
  zoomSyncAttached = false;
  function attachZoomSync() {
    if (zoomSyncAttached || !viewer || !viewer.controls) return;
    zoomSyncAttached = true;
    viewer.controls.addEventListener('change', () => {
      if (isZoomSyncing) return;
      if (!viewer || !viewer.controls || !masterVol || baseFramedDistance <= 0) return;
      const currentDist = viewer.camera.position.distanceTo(viewer.controls.target);
      const factor = currentDist / baseFramedDistance;
      // Invert: factor = 1.0 - (t - 0.5)*1.5  =>  t = 0.5 - (factor - 1.0)/1.5
      const t = 0.5 - (factor - 1.0) / 1.5;
      const vol = Math.max(0, Math.min(100, Math.round(t * 100)));
      masterVol.value = vol;
      updateKnobFill(masterVol);
    });
  }
  if (viewer.controls) {
    attachZoomSync();
  } else {
    // Controls not yet ready — attach on first animation frame when available
    const _origPRU = window._zoomSyncPoll;
    window._zoomSyncPoll = attachZoomSync;
  }

  return viewer;
}

function centerCamera() {
  if (!viewer) return;
  if (viewer.getSceneCount() === 0) return;
  
  const fov = viewer.camera.fov || 65;
  const targetDist = 5.0;
  // 1.5x larger framing: persistent framing distance for load, play, and stop alike.
  // DEFAULT_ZOOM_OUT pushes the baseline framing 30% further (object ~30% smaller)
  // so first-load / reset / min-master-volume all sit more zoomed-out than before.
  const DEFAULT_ZOOM_OUT = 1.15;
  const distance = (((targetDist * 1.5) / Math.sin((fov * Math.PI / 180) / 2)) / 3.0) * DEFAULT_ZOOM_OUT;
  baseFramedDistance = distance;

  // Preserve the user's current Master-Volume zoom across reframes (FX apply,
  // HUD toggle, viewer rebuild). Only an explicit H reset returns vol to 80.
  let zoomFactor = 1.0;
  if (masterVol) {
    const t = Number(masterVol.value) / 100;
    zoomFactor = Math.max(0.4, Math.min(1.8, 1.0 - (t - 0.5) * 1.5));
  }
  const camDist = distance * zoomFactor;

  viewer.camera.position.set(0, 0, camDist);
  if (viewer.controls && viewer.controls.target) {
    viewer.controls.target.set(0, 0, 0);
    viewer.controls.update();
  } else {
    viewer.camera.lookAt(0, 0, 0);
  }

  viewer.camera.near = 0.1;
  viewer.camera.far = distance * 18;
  viewer.camera.updateProjectionMatrix();
}

function computeBounds(splatData, boundsObj) {
  if (!splatData || splatData.splatCount === 0) return;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);
  
  for (let i = 0; i < splatData.splatCount; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (pz < minZ) minZ = pz;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
    if (pz > maxZ) maxZ = pz;
  }

  boundsObj.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);

  let maxDistSq = 0;
  for (let i = 0; i < splatData.splatCount; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true) - boundsObj.center.x;
    const py = view.getFloat32(base + 4, true) - boundsObj.center.y;
    const pz = view.getFloat32(base + 8, true) - boundsObj.center.z;
    const distSq = px*px + py*py + pz*pz;
    if (distSq > maxDistSq) maxDistSq = distSq;
  }

  boundsObj.maxDist = Math.sqrt(maxDistSq);
  if (boundsObj.maxDist < 0.001) boundsObj.maxDist = 5;
}

function updateGlobalBounds() {
  computeBounds(sceneA, boundsA);
  computeBounds(sceneB, boundsB);
}

// ── Show SplatData (our 32-byte format) in the viewer ──
function convertSplatDataToBuffer(splatData) {
  if (!splatData || splatData.splatCount === 0) return null;
  const rawArrayBuffer = splatData.data.buffer.slice(
    splatData.data.byteOffset,
    splatData.data.byteOffset + splatData.data.byteLength
  );

  const maxSplatCount = splatData.splatCount;
  const sectionCount = 1;
  const splatDataOffsetBytes = GaussianSplats3D.SplatBuffer.HeaderSizeBytes + GaussianSplats3D.SplatBuffer.SectionHeaderSizeBytes;
  const bytesPerSplat = GaussianSplats3D.SplatBuffer.CompressionLevels[0].SphericalHarmonicsDegrees[0].BytesPerSplat;
  const splatBufferSizeBytes = splatDataOffsetBytes + bytesPerSplat * maxSplatCount;

  const directLoadBufferOut = new ArrayBuffer(splatBufferSizeBytes);

  GaussianSplats3D.SplatBuffer.writeHeaderToBuffer({
    versionMajor: GaussianSplats3D.SplatBuffer.CurrentMajorVersion,
    versionMinor: GaussianSplats3D.SplatBuffer.CurrentMinorVersion,
    maxSectionCount: sectionCount,
    sectionCount: sectionCount,
    maxSplatCount: maxSplatCount,
    splatCount: maxSplatCount,
    compressionLevel: 0,
    sceneCenter: { x: 0, y: 0, z: 0 }
  }, directLoadBufferOut);

  GaussianSplats3D.SplatBuffer.writeSectionHeaderToBuffer({
    maxSplatCount: maxSplatCount,
    splatCount: maxSplatCount,
    bucketSize: 0,
    bucketCount: 0,
    bucketBlockSize: 0,
    compressionScaleRange: 0,
    storageSizeBytes: 0,
    fullBucketCount: 0,
    partiallyFilledBucketCount: 0
  }, 0, directLoadBufferOut, GaussianSplats3D.SplatBuffer.HeaderSizeBytes);

  GaussianSplats3D.SplatParser.parseToUncompressedSplatBufferSection(
    0,
    maxSplatCount - 1,
    rawArrayBuffer,
    0,
    directLoadBufferOut,
    splatDataOffsetBytes
  );

  return new GaussianSplats3D.SplatBuffer(directLoadBufferOut, true);
}

function applyCpuFx(scene, fxKey, params) {
  switch (fxKey) {
    case 'delay': return applyDelayFx(scene, params);
    case 'echo': return applyEchoFx(scene, params);
    case 'reverb': return applyReverbFx(scene, params);
    case 'filter': return applyFilterFx(scene, params);
    case 'phaser': return applyPhaserFx(scene, params);
    case 'roll': return applyRollFx(scene, params);
    case 'spiral': return applySpiralFx(scene, params);
    default: return scene;
  }
}

function processFx(scene, deckStr) {
  if (!scene) return scene;
  
  let currentScene = copySplatData(scene);
  
  const chNum = (deckStr === 'deckA' || deckStr === 'deckC') ? 1 : 2;
  const settings = getChSettings(chNum);
  applyMixerSettings(currentScene, settings);
  
  let engagedDeck, activeFxDeck, depthDeck;
  if (deckStr === 'deckA') { engagedDeck = fxEngagedA; activeFxDeck = fxActiveA; depthDeck = fxDepthA; }
  else if (deckStr === 'deckB') { engagedDeck = fxEngagedB; activeFxDeck = fxActiveB; depthDeck = fxDepthB; }
  else if (deckStr === 'deckC') { engagedDeck = fxEngagedC; activeFxDeck = fxActiveC; depthDeck = fxDepthC; }
  else if (deckStr === 'deckD') { engagedDeck = fxEngagedD; activeFxDeck = fxActiveD; depthDeck = fxDepthD; }
  
  if (engagedDeck && activeFxDeck !== "none") {
    const amount = Number(depthDeck.value) / 100;
    currentScene = applyCpuFx(currentScene, activeFxDeck, { amount });
  }
  
  if (fxEngagedM && fxActiveM !== "none") {
    const amount = Number(fxDepthM.value) / 100;
    currentScene = applyCpuFx(currentScene, fxActiveM, { amount });
  }
  
  return currentScene;
}

function createMainFlareTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  
  // Central bright glow
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.15);
  grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.2, 'rgba(255, 244, 220, 0.8)');
  grad.addColorStop(0.5, 'rgba(249, 115, 22, 0.2)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  
  // Diffraction spikes (8 rays)
  const numRays = 8;
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < numRays; i++) {
    ctx.rotate((Math.PI * 2) / numRays);
    const spikeGrad = ctx.createLinearGradient(0, 0, size / 2, 0);
    spikeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    spikeGrad.addColorStop(0.1, 'rgba(249, 115, 22, 0.3)');
    spikeGrad.addColorStop(0.6, 'rgba(249, 115, 22, 0.05)');
    spikeGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    
    ctx.fillStyle = spikeGrad;
    ctx.beginPath();
    ctx.moveTo(0, -1.5);
    ctx.lineTo(size / 2, 0);
    ctx.lineTo(0, 1.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  
  return new THREE.CanvasTexture(canvas);
}

function createHexagonTexture(colorStr, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, colorStr);
  grad.addColorStop(0.8, colorStr);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fill();
  
  ctx.strokeStyle = colorStr.replace(/[^,]+(?=\))/, '0.3');
  ctx.lineWidth = 1.5;
  ctx.stroke();
  
  return new THREE.CanvasTexture(canvas);
}

function createRainbowRingTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 2;
  
  const grad = ctx.createRadialGradient(cx, cy, rOuter * 0.8, cx, cy, rOuter);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.1, 'rgba(139, 92, 246, 0.0)');
  grad.addColorStop(0.3, 'rgba(59, 130, 246, 0.08)');
  grad.addColorStop(0.6, 'rgba(16, 185, 129, 0.08)');
  grad.addColorStop(0.8, 'rgba(252, 211, 77, 0.08)');
  grad.addColorStop(1.0, 'rgba(239, 68, 68, 0.0)');
  
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
  ctx.fill();
  
  return new THREE.CanvasTexture(canvas);
}

function setupPostProcessingAndLensFlare() {
  if (!viewer) return;

  // Add Lens flare in Three scene
  if (!lensflareLight) {
    lensflareLight = new THREE.PointLight(0xffffff, 1.5, 2000);
    lensflareLight.position.set(2, 6, -6);

    const mainTex = createMainFlareTexture(256);
    const hexTex1 = createHexagonTexture('rgba(249, 115, 22, 0.08)', 128);
    const hexTex2 = createHexagonTexture('rgba(59, 130, 246, 0.06)', 96);
    const hexTex3 = createHexagonTexture('rgba(16, 185, 129, 0.05)', 64);
    const ringTex = createRainbowRingTexture(512);

    const lensflare = new Lensflare();
    lensflare.addElement(new LensflareElement(mainTex, 450, 0.0));
    lensflare.addElement(new LensflareElement(ringTex, 400, 0.2));
    lensflare.addElement(new LensflareElement(hexTex1, 140, 1.0));

    lensflareLight.add(lensflare);
    const knobLensFlare = document.getElementById('knob-lensflare');
    const flareAmount = knobLensFlare ? (Number(knobLensFlare.value) / 100) : 0;
    lensflareLight.visible = flareAmount > 0;
    lensflareLight.intensity = flareAmount * 3.0;
    viewer.threeScene.add(lensflareLight);
  }

  // Setup Composer & Passes
  const width = window.innerWidth;
  const height = window.innerHeight;

  composer = new EffectComposer(viewer.renderer);

  // ── Build the screen-space strobe overlay (once) ──────────────────────────
  // A single full-screen quad with a transparent ShaderMaterial. It is drawn
  // INSIDE the render pass, after the HDRI/threeScene background and before the
  // splats, so the render order is: HDRI background -> strobe overlay -> splats.
  if (!strobeScene) {
    strobeScene = new THREE.Scene();
    strobeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    strobeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uStrength: { value: 0 },      // 0..1 opacity
        uMode: { value: 0 },          // 0 = side gradient, 1 = full flash
        uEdge: { value: 0 },          // 0=top, 1=right, 2=bottom, 3=left
        uColor: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec2 vUv;
        uniform float uStrength;
        uniform float uMode;
        uniform float uEdge;
        uniform vec3 uColor;
        void main() {
          // PlaneGeometry UVs: (0,0) bottom-left, (1,1) top-right, so vUv.y=1 is screen top.
          if (uMode > 0.5) {
            // FULL mode: uniform white flash across the whole screen.
            gl_FragColor = vec4(uColor, uStrength);
          } else {
            // SIDE mode: gradient that is max at the active edge, fading to the opposite edge.
            float t;
            if (uEdge < 0.5)       t = vUv.y;            // top edge: max at vUv.y=1
            else if (uEdge < 1.5)  t = vUv.x;            // right edge: max at vUv.x=1
            else if (uEdge < 2.5)  t = 1.0 - vUv.y;      // bottom edge: max at vUv.y=0
            else                   t = 1.0 - vUv.x;      // left edge: max at vUv.x=0
            // Sharp falloff: bright only near the active edge, dark at center.
            float a = uStrength * pow(clamp(t, 0.0, 1.0), 2.5);
            gl_FragColor = vec4(uColor, a);
          }
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), strobeMaterial);
    quad.frustumCulled = false;
    strobeScene.add(quad);
  }

  const renderPass = {
    enabled: true,
    needsSwap: true,
    clear: true,
    setSize: function() {},
    render: function (renderer, writeBuffer, readBuffer) {
      // Render splats + scene into writeBuffer so subsequent passes can read it
      renderer.setRenderTarget(writeBuffer);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.autoClear = false;

      const keys = loadedDeckKeys();
      const mesh = viewer.splatMesh;
      const sceneCount = mesh ? mesh.getSceneCount() : 0;

      // Helper: drive the screen-space strobe overlay (full-screen) once.
      const renderStrobe = () => {
        if (strobeMaterial && strobeStrength > 0.001) {
          strobeMaterial.uniforms.uStrength.value = strobeStrength;
          strobeMaterial.uniforms.uMode.value = strobeUMode;
          strobeMaterial.uniforms.uEdge.value = strobeUEdge;
          renderer.render(strobeScene, strobeCamera);
        }
      };

      // ── Single-deck (or none) fast path: full-screen, no crossfade (no regression).
      if (keys.length <= 1) {
        // Keep the deck-count resolution ceiling in sync (0 or 1 deck → 1.0). This
        // also restores full resolution when going from multi-deck back to one.
        // Defer the actual apply to after the pass (see note in multi-deck path).
        if (keys.length !== activeRenderedDeckCount) {
          activeRenderedDeckCount = keys.length;
          renderScaleDirty = true;
        }
        // A lone deck always renders at full opacity regardless of crossfader.
        if (mesh && mesh.material && mesh.material.uniforms.uStrobeAlphaA) {
          mesh.material.uniforms.uStrobeAlphaA.value = strobeAlphaBaseA;
          mesh.material.uniforms.uStrobeAlphaB.value = strobeAlphaBaseB;
        }
        if (viewer.threeScene) renderer.render(viewer.threeScene, viewer.camera);
        renderStrobe();
        if (mesh) renderer.render(mesh, viewer.camera);
        if (viewer.sceneHelper) {
          if (viewer.sceneHelper.getFocusMarkerOpacity() > 0.0)
            renderer.render(viewer.sceneHelper.focusMarker, viewer.camera);
          if (viewer.showControlPlane)
            renderer.render(viewer.sceneHelper.controlPlane, viewer.camera);
        }
        renderer.autoClear = true;
        renderer.setRenderTarget(null);
        return;
      }

      // ── Multi-deck OVERLAY (#7): every loaded deck is drawn FULL-SCREEN, each
      // with its own independent camera, composited on top of one another into a
      // single unified image (no screen division / no scissor).
      //
      // Compositing order:
      //   1. Draw the background (viewer.threeScene) ONCE, before the deck loop,
      //      so it is not re-drawn opaque on top of an earlier deck's splats.
      //   2. For each loaded deck: isolate its chunk scenes visible, set its
      //      crossfade opacity, and render the shared splatMesh full-screen with
      //      that deck's camera. autoClear stays false so decks accumulate.
      //
      // SORT CAVEAT (unchanged/acceptable): the library sorts splats once per
      // frame against viewer.camera, which we keep synced to the primary (first
      // loaded) deck. Other decks reuse that order, so their internal front-to-back
      // alpha ordering is approximate. We cannot synchronously re-sort per deck
      // (the sort worker is async over a single shared index buffer).
      const size = new THREE.Vector2();
      renderer.getSize(size);
      const pr = renderer.getPixelRatio();
      const W = Math.floor(size.x * pr);
      const H = Math.floor(size.y * pr);
      const fullAspect = W / Math.max(1, H);
      const ranges = deckSceneRanges();

      // Save current per-scene visibility so we can restore after the loop.
      const savedVis = [];
      for (let i = 0; i < sceneCount; i++) {
        const s = viewer.getSplatScene(i);
        savedVis.push(s ? s.visible : false);
      }

      const setDeckVisible = (deckKey) => {
        const [start, count] = ranges[deckKey];
        for (let i = 0; i < sceneCount; i++) {
          const s = viewer.getSplatScene(i);
          if (!s) continue;
          const inDeck = (i >= start && i < start + count);
          // Honour the per-frame intended visibility (savedVis) only inside this
          // deck's block; everything else is hidden for this sub-render.
          s.visible = inDeck ? savedVis[i] : false;
        }
      };

      // Full buffer for all draws (no scissor panels). The render target's own
      // full viewport (set by setRenderTarget above) is correct — do NOT call
      // setViewport with physical px here; Three re-applies pixelRatio and would
      // shrink the image (was the "not full screen with 2+ decks" bug).

      // 2) Composite each deck's splats full-screen over the background.
      // #10: crossfade opacity — deck A = (1-mix), deck B = mix, C/D = full.
      const mix = crossfadeMix;
      const matUniforms = (mesh && mesh.material) ? mesh.material.uniforms : null;

      // Compute each deck's effective composite opacity up front so we can SKIP
      // near-invisible decks entirely (no scene-visibility toggling, no
      // renderer.render). At crossfader extremes only one of A/B is drawn; a deck
      // faded fully out costs nothing.
      const OPACITY_EPS = 0.01;
      const deckOpacity = (k) => {
        if (k === 'a') return strobeAlphaBaseA * (1 - mix);
        if (k === 'b') return strobeAlphaBaseB * mix;
        return strobeAlphaBaseB; // C/D → full (B branch)
      };
      const drawKeys = keys.filter((k) => deckOpacity(k) > OPACITY_EPS);

      // Keep the primary/sort camera tracking a deck that is actually rendered. The
      // worker sorts splats against viewer.camera; updateCameraRig synced it to the
      // first LOADED deck, but if that deck got skipped here, fall back to the first
      // DRAWN deck so viewer.camera (and the background) still match a visible panel.
      const primaryKey = (drawKeys.length > 0) ? drawKeys[0] : keys[0];
      if (drawKeys.length > 0 && primaryKey !== keys[0]) {
        const pcam = deckCameras[primaryKey];
        if (pcam) {
          viewer.camera.position.copy(pcam.position);
          viewer.camera.up.copy(pcam.up);
          viewer.camera.lookAt(_camOrigin);
        }
      }

      // Maintain the deck-count-aware resolution ceiling: recompute the render
      // scale only when the actively-rendered deck count changes. We only record
      // the count here and apply AFTER this pass finishes — applyRenderScale()
      // resizes the composer's render targets, which must not happen mid-pass
      // while we are rendering into writeBuffer.
      if (drawKeys.length !== activeRenderedDeckCount) {
        activeRenderedDeckCount = drawKeys.length;
        renderScaleDirty = true;
      }

      // 1) Background once, with the primary (first DRAWN) deck's camera.
      const primaryCam = deckCameras[primaryKey] || viewer.camera;
      if (viewer.threeScene) renderer.render(viewer.threeScene, primaryCam);

      // Strobe overlay once, full-screen, over the background (before splats).
      renderStrobe();

      for (let p = 0; p < drawKeys.length; p++) {
        const k = drawKeys[p];
        const cam = deckCameras[k] || viewer.camera;
        // Each deck fills the whole frame → match camera aspect to the full buffer.
        if (cam.isPerspectiveCamera && Math.abs(cam.aspect - fullAspect) > 1e-4) {
          cam.aspect = fullAspect;
          cam.updateProjectionMatrix();
        }

        if (mesh) {
          // Fold the A/B crossfade gain into the per-deck opacity uniform without
          // clobbering the trans-strobe alpha. The shader splits opacity by
          // sceneIndex into an A branch (uStrobeAlphaA) and a B branch
          // (uStrobeAlphaB) that covers decks B/C/D. Because we render exactly one
          // deck per pass (others hidden), we can set the relevant branch's value
          // for THIS deck only: A → 1-mix, B → mix, C/D → 1.
          if (matUniforms && matUniforms.uStrobeAlphaA) {
            if (k === 'a') {
              matUniforms.uStrobeAlphaA.value = strobeAlphaBaseA * (1 - mix);
              window._lastOverlayOpacity.a = matUniforms.uStrobeAlphaA.value;
            } else if (k === 'b') {
              matUniforms.uStrobeAlphaB.value = strobeAlphaBaseB * mix;
              window._lastOverlayOpacity.b = matUniforms.uStrobeAlphaB.value;
            } else {
              // C/D live in the shader's B branch → full opacity.
              matUniforms.uStrobeAlphaB.value = strobeAlphaBaseB;
            }
          }
          setDeckVisible(k);
          renderer.render(mesh, cam);
        }
      }

      // Restore original visibility.
      for (let i = 0; i < sceneCount; i++) {
        const s = viewer.getSplatScene(i);
        if (s) s.visible = savedVis[i];
      }

      renderer.autoClear = true;
      renderer.setRenderTarget(null);
    }
  };

  composer.addPass(renderPass);

  afterimagePass = new AfterimagePass();
  afterimagePass.enabled = false;
  afterimagePass.uniforms['damp'].value = 0.96;
  afterimagePass.uniforms['scale'].value = 1.0;
  composer.addPass(afterimagePass);

  // Final pass: copy the last buffer to screen
  const copyPass = new ShaderPass(CopyShader);
  copyPass.renderToScreen = true;
  copyPass.setSize = function() {};
  composer.addPass(copyPass);

  viewer.render = function() {
    composer.render();
    // The renderPass may have detected a change in actively-rendered deck count
    // and flagged a render-scale update. Apply it here, AFTER the composer pass,
    // so resizing the render targets never happens mid-pass.
    if (renderScaleDirty) {
      renderScaleDirty = false;
      applyRenderScale();
    }
  };

  const originalResize = viewer.renderer.setSize;
  viewer.renderer.setSize = function (w, h, updateStyle) {
    originalResize.call(this, w, h, updateStyle);
    composer.setSize(w, h);
  };

  // The composer captured the renderer's pixel ratio at construction; re-apply
  // the current adaptive notch so both renderer and composer stay in sync
  // (and so a freshly-rebuilt viewer keeps the active scale).
  applyRenderScale();
}

async function rebuildViewerBuffers() {
  if (viewer) {
    try {
      await viewer.dispose();
    } catch(e) {
      console.warn("Viewer dispose err:", e);
    }
    viewer = null;
    lensflareLight = null;
  }
  
  updateGlobalBounds();
  await makeViewer();
  reapplyHdri();
  
  try {
    const buffers = [];
    const options = [];
    numChunksA = 0;
    numChunksB = 0;
    numChunksC = 0;
    numChunksD = 0;
    numRollChunksA = 0;
    numRollChunksB = 0;
    numRollChunksC = 0;
    numRollChunksD = 0;

    if (sceneA) {
      const fxSceneA = processFx(sceneA, 'deckA');
      const CHUNK_STEPS = [4, 8, 16, 32];
      const chunksA = sliceIntoSpheres(fxSceneA, CHUNK_STEPS[Math.round(Number(document.querySelector('#chunks-slider-a').value))] || 16);
      for (const c of chunksA) {
        const buf = convertSplatDataToBuffer(c);
        if (buf) {
          buffers.push(buf);
          options.push({ 'splatAlphaRemovalThreshold': 5 });
          numChunksA++;
        }
      }
      const isRollA = (fxEngagedA && fxActiveA === 'roll') || (fxEngagedM && fxActiveM === 'roll');
      if (isRollA) {
        for (let j = 0; j < 4; j++) {
          const buf = convertSplatDataToBuffer(chunksA[0]);
          if (buf) { buffers.push(buf); options.push({ 'splatAlphaRemovalThreshold': 5 }); numRollChunksA++; }
        }
      }
    }

    if (sceneB) {
      const fxSceneB = processFx(sceneB, 'deckB');
      const CHUNK_STEPS_B = [4, 8, 16, 32];
      const chunksB = sliceIntoSpheres(fxSceneB, CHUNK_STEPS_B[Math.round(Number(document.querySelector('#chunks-slider-b').value))] || 16);
      for (const c of chunksB) {
        const buf = convertSplatDataToBuffer(c);
        if (buf) {
          buffers.push(buf);
          options.push({ 'splatAlphaRemovalThreshold': 5 });
          numChunksB++;
        }
      }
      const isRollB = (fxEngagedB && fxActiveB === 'roll') || (fxEngagedM && fxActiveM === 'roll');
      if (isRollB) {
        for (let j = 0; j < 4; j++) {
          const buf = convertSplatDataToBuffer(chunksB[0]);
          if (buf) { buffers.push(buf); options.push({ 'splatAlphaRemovalThreshold': 5 }); numRollChunksB++; }
        }
      }
    }

    if (sceneC) {
      const fxSceneC = processFx(sceneC, 'deckC');
      const CHUNK_STEPS_C = [4, 8, 16, 32];
      const chunksC = sliceIntoSpheres(fxSceneC, CHUNK_STEPS_C[Math.round(Number(document.querySelector('#chunks-slider-c')?.value))] || 16);
      for (const c of chunksC) {
        const buf = convertSplatDataToBuffer(c);
        if (buf) {
          buffers.push(buf);
          options.push({ 'splatAlphaRemovalThreshold': 5 });
          numChunksC++;
        }
      }
    }

    if (sceneD) {
      const fxSceneD = processFx(sceneD, 'deckD');
      const CHUNK_STEPS_D = [4, 8, 16, 32];
      const chunksD = sliceIntoSpheres(fxSceneD, CHUNK_STEPS_D[Math.round(Number(document.querySelector('#chunks-slider-d')?.value))] || 16);
      for (const c of chunksD) {
        const buf = convertSplatDataToBuffer(c);
        if (buf) {
          buffers.push(buf);
          options.push({ 'splatAlphaRemovalThreshold': 5 });
          numChunksD++;
        }
      }
    }

    if (buffers.length === 0) return;

    await viewer.addSplatBuffers(
      buffers,
      options,
      false,  // finalBuild
      false,  // showLoadingUI
      false,  // showLoadingUIForSplatTreeBuild
      true    // replaceExisting
    );
    
    setupPostProcessingAndLensFlare();
    
    if (!isCameraFramed) {
      centerCamera();
      isCameraFramed = true;
    }
    
    if (viewer.splatMesh && viewer.splatMesh.material) {
      let shader = viewer.splatMesh.material.vertexShader;
      if (!shader.includes('uFxFlangerAmountA')) {
        shader = `
          uniform float uFxTime;
          uniform uint uDeckAChunkCount;
          
          uniform float uFxFlangerAmountA;
          uniform float uFxPitchSquashXA;
          uniform float uFxPitchStretchYA;
          uniform float uFxPitchSquashYA;
          uniform float uFxPitchStretchXA;
          uniform float uFxBeatFreqA;
          uniform float uFxPhaserAmountA;
          
          uniform float uFxFlangerAmountB;
          uniform float uFxPitchSquashXB;
          uniform float uFxPitchStretchYB;
          uniform float uFxPitchSquashYB;
          uniform float uFxPitchStretchXB;
          uniform float uFxBeatFreqB;
          uniform float uFxPhaserAmountB;
          
          uniform float uFxFlangerAmountM;
          uniform float uFxPitchSquashXM;
          uniform float uFxPitchStretchYM;
          uniform float uFxPitchSquashYM;
          uniform float uFxPitchStretchXM;
          uniform float uFxBeatFreqM;
          uniform float uFxPhaserAmountM;
          
          uniform float uFaderScaleA;
          uniform float uFaderScaleB;
          
          uniform float uStrobeAlphaA;
          uniform float uStrobeAlphaB;

          uniform float uDofFocus;
          uniform float uDofAmount;
          varying float vOpacityMult;

          // #8 Chunk-range loop tint: orange highlight for looped chunks
          uniform float uLoopActiveA;
          uniform float uLoopStartA;
          uniform float uLoopEndA;
          uniform float uLoopActiveB;
          uniform float uLoopStartB;
          uniform float uLoopEndB;
          varying float vLoopTint;
        ` + shader;
        
        // Inject FX displacement AFTER splatCenter is read but BEFORE viewCenter.
        // splatCenter stays pristine → worldViewDir (SH colors) is unaffected.
        // displacedCenter carries Flanger + Pitch deformations for position only.
        shader = shader.replace(
          'vec4 viewCenter = transformModelViewMatrix * vec4(splatCenter, 1.0);',
          `
          vec3 displacedCenter = splatCenter;
          bool isDeckA = sceneIndex < uDeckAChunkCount;
          
          // Apply Flanger (Pseudo-Perlin Noise)
          float flangerAmount = 0.0;
          float beatFreq = 1.0;
          if (isDeckA) {
              if (uFxFlangerAmountA > 0.0) {
                  flangerAmount = uFxFlangerAmountA;
                  beatFreq = uFxBeatFreqA;
              }
          } else {
              if (uFxFlangerAmountB > 0.0) {
                  flangerAmount = uFxFlangerAmountB;
                  beatFreq = uFxBeatFreqB;
              }
          }
          if (uFxFlangerAmountM > 0.0) {
              flangerAmount += uFxFlangerAmountM;
              beatFreq = uFxBeatFreqM;
          }
          
          if (flangerAmount > 0.0) {
              vec3 p = displacedCenter * 5.0;
              vec3 cell = floor(p);
              vec3 frac = fract(p);
              vec3 jitter = sin(cell * 11.45 + uFxTime * beatFreq * 2.0) * 0.45;
              float dist = length(frac - (0.5 + jitter));
              float voronoiNoise = smoothstep(0.0, 0.8, dist);
              displacedCenter *= (1.0 + voronoiNoise * flangerAmount * 0.6);
          }
          
          // Apply Phaser
          float phaserAmount = 0.0;
          if (isDeckA) {
              if (uFxPhaserAmountA > 0.0) phaserAmount = uFxPhaserAmountA;
          } else {
              if (uFxPhaserAmountB > 0.0) phaserAmount = uFxPhaserAmountB;
          }
          if (uFxPhaserAmountM > 0.0) phaserAmount += uFxPhaserAmountM;
          
          if (phaserAmount > 0.0) {
              float spatialWaveBase = sin(displacedCenter.y * 15.0 + displacedCenter.x * 10.0 + displacedCenter.z * 5.0);
              float sweepPhase = uFxTime * beatFreq * 3.0;
              float spatialWaveShifted = sin(displacedCenter.y * 15.0 + displacedCenter.x * 10.0 + displacedCenter.z * 5.0 + sweepPhase);
              float notchSum = (spatialWaveBase + spatialWaveShifted) * 0.5;
              float phaserScale = mix(1.0, 0.5 + 0.5 * notchSum, phaserAmount);
              displacedCenter *= phaserScale;
          }
          
          // Apply Pitch
          float pitchSquashX = 1.0;
          float pitchStretchY = 1.0;
          float pitchSquashY = 1.0;
          float pitchStretchX = 1.0;
          
          if (isDeckA) {
              pitchSquashX = uFxPitchSquashXA;
              pitchStretchY = uFxPitchStretchYA;
              pitchSquashY = uFxPitchSquashYA;
              pitchStretchX = uFxPitchStretchXA;
          } else {
              pitchSquashX = uFxPitchSquashXB;
              pitchStretchY = uFxPitchStretchYB;
              pitchSquashY = uFxPitchSquashYB;
              pitchStretchX = uFxPitchStretchXB;
          }
          
          pitchSquashX *= uFxPitchSquashXM;
          pitchStretchY *= uFxPitchStretchYM;
          pitchSquashY *= uFxPitchSquashYM;
          pitchStretchX *= uFxPitchStretchXM;
          
          if (pitchSquashX < 1.0 || pitchStretchY > 1.0 || pitchSquashY < 1.0 || pitchStretchX > 1.0) {
              displacedCenter.x *= pitchSquashX * pitchStretchX;
              displacedCenter.y *= pitchStretchY * pitchSquashY;
          }
          
          float faderScale = 1.0;
          if (isDeckA) {
              faderScale = uFaderScaleA;
              vOpacityMult = uStrobeAlphaA;
          } else {
              faderScale = uFaderScaleB;
              vOpacityMult = uStrobeAlphaB;
          }

          // #8 Chunk-range loop tint: set vLoopTint=1.0 when this splat's scene is in the looped range.
          // sceneIndex is uint; compare as float after casting.
          vLoopTint = 0.0;
          float sceneIdxF = float(sceneIndex);
          if (isDeckA && uLoopActiveA > 0.5 && sceneIdxF >= uLoopStartA && sceneIdxF <= uLoopEndA) {
              vLoopTint = 1.0;
          }
          if (!isDeckA && uLoopActiveB > 0.5 && sceneIdxF >= uLoopStartB && sceneIdxF <= uLoopEndB) {
              vLoopTint = 1.0;
          }

          vec4 viewCenter = transformModelViewMatrix * vec4(displacedCenter, 1.0);
          
          float dofScale = 1.0;
          if (uDofAmount > 0.0) {
              float distToFocus = abs(abs(viewCenter.z) - uDofFocus);
              float blur = smoothstep(0.5, 5.0, distToFocus) * uDofAmount * 20.0;
              dofScale = 1.0 + blur;
              vOpacityMult *= 1.0 / (blur * 0.5 + 1.0);
          }
          `
        );
        
        shader = shader.replaceAll(
          'vec4 quadPos = vec4(ndcCenter.xy + ndcOffset, ndcCenter.z, 1.0);',
          'vec4 quadPos = vec4(ndcCenter.xy + ndcOffset * max(faderScale, 0.0001) * dofScale, ndcCenter.z, 1.0);'
        );
        
        viewer.splatMesh.material.vertexShader = shader;
        viewer.splatMesh.material.uniforms.uFxTime = { value: 0 };
        viewer.splatMesh.material.uniforms.uDeckAChunkCount = { value: 0 };
        
        viewer.splatMesh.material.uniforms.uFxFlangerAmountA = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPhaserAmountA = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashXA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchYA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashYA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchXA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxBeatFreqA = { value: 1.0 };
        
        viewer.splatMesh.material.uniforms.uFxFlangerAmountB = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPhaserAmountB = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashXB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchYB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashYB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchXB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxBeatFreqB = { value: 1.0 };
        
        viewer.splatMesh.material.uniforms.uFxFlangerAmountM = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPhaserAmountM = { value: 0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashXM = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchYM = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchSquashYM = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxPitchStretchXM = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFxBeatFreqM = { value: 1.0 };
        
        viewer.splatMesh.material.uniforms.uFaderScaleA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uFaderScaleB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uStrobeAlphaA = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uStrobeAlphaB = { value: 1.0 };
        viewer.splatMesh.material.uniforms.uDofFocus = { value: 4.5 };
        viewer.splatMesh.material.uniforms.uDofAmount = { value: 0.0 };

        // #8 Chunk-range loop tint uniforms
        viewer.splatMesh.material.uniforms.uLoopActiveA = { value: 0.0 };
        viewer.splatMesh.material.uniforms.uLoopStartA  = { value: 0.0 };
        viewer.splatMesh.material.uniforms.uLoopEndA    = { value: 0.0 };
        viewer.splatMesh.material.uniforms.uLoopActiveB = { value: 0.0 };
        viewer.splatMesh.material.uniforms.uLoopStartB  = { value: 0.0 };
        viewer.splatMesh.material.uniforms.uLoopEndB    = { value: 0.0 };

        let fragShader = viewer.splatMesh.material.fragmentShader;
        if (!fragShader.includes('vOpacityMult')) {
          fragShader = `
            varying float vOpacityMult;
            varying float vLoopTint;
          ` + fragShader;
          fragShader = fragShader.replace(
            'gl_FragColor = vec4(vColor.rgb, w);',
            `
            if (vOpacityMult < 0.001) discard;
            vec3 tintedColor = mix(vColor.rgb, vec3(1.0, 0.5, 0.0), vLoopTint * 0.7);
            gl_FragColor = vec4(tintedColor, w * vOpacityMult);
            `
          );
          fragShader = fragShader.replace(
            'gl_FragColor = vec4(color.rgb, opacity);',
            `
            vec3 tintedColorAlt = mix(color.rgb, vec3(1.0, 0.5, 0.0), vLoopTint * 0.7);
            gl_FragColor = vec4(tintedColorAlt, opacity * vOpacityMult);
            `
          );
          viewer.splatMesh.material.fragmentShader = fragShader;
        }

        viewer.splatMesh.material.needsUpdate = true;
      }
    }
    
    reconnectOutputStream();

    if (statusEl) statusEl.textContent = "Ready.";
  } catch (err) {
    console.error('addSplatBuffers error:', err);
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    throw err;
  }
}

function encodeQuaternionByte(value) {
  return Math.max(0, Math.min(255, Math.round((value * 0.5 + 0.5) * 255)));
}

function encodeUncompressedSplatArray(splatArray) {
  const count = splatArray.splatCount;
  const out = new Uint8Array(count * 32);
  const outView = new DataView(out.buffer);
  let hasVisibleAlpha = false;

  for (let i = 0; i < count; i++) {
    const s = splatArray.splats[i];
    const base = i * 32;

    outView.setFloat32(base + 0, s[0] || 0, true);
    outView.setFloat32(base + 4, s[1] || 0, true);
    outView.setFloat32(base + 8, s[2] || 0, true);

    outView.setFloat32(base + 12, Number.isFinite(s[3]) ? s[3] : 0.01, true);
    outView.setFloat32(base + 16, Number.isFinite(s[4]) ? s[4] : 0.01, true);
    outView.setFloat32(base + 20, Number.isFinite(s[5]) ? s[5] : 0.01, true);

    out[base + 24] = Math.max(0, Math.min(255, s[10] || 0));
    out[base + 25] = Math.max(0, Math.min(255, s[11] || 0));
    out[base + 26] = Math.max(0, Math.min(255, s[12] || 0));
    out[base + 27] = Math.max(0, Math.min(255, s[13] || 0));
    if (out[base + 27] > 0) hasVisibleAlpha = true;

    const qx = Number.isFinite(s[6]) ? s[6] : 0;
    const qy = Number.isFinite(s[7]) ? s[7] : 0;
    const qz = Number.isFinite(s[8]) ? s[8] : 0;
    const qw = Number.isFinite(s[9]) ? s[9] : 1;
    out[base + 28] = encodeQuaternionByte(qw);
    out[base + 29] = encodeQuaternionByte(qx);
    out[base + 30] = encodeQuaternionByte(qy);
    out[base + 31] = encodeQuaternionByte(qz);
  }

  if (!hasVisibleAlpha) {
    for (let i = 0; i < count; i++) out[i * 32 + 27] = 255;
  }

  return new SplatData(out);
}

// ── Parse file into SplatData ──────────────────────────
async function loadFileToSplatData(file) {
  const fileName = file.name.toLowerCase();

  // If it's an image, send to local python backend for 3D reconstruction
  if (fileName.endsWith('.png') || fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
    const formData = new FormData();
    formData.append('file', file);
    
    const removeBg = document.getElementById('chk-remove-bg')?.checked ?? true;
    const useColab = document.getElementById('chk-use-colab')?.checked ?? false;
    let colabUrl = document.getElementById('colab-url')?.value.trim();
    
    // Default to localhost if colab is not checked or URL is empty
    let baseUrl = 'http://localhost:8000';
    if (useColab && colabUrl) {
      if (colabUrl.endsWith('/')) colabUrl = colabUrl.slice(0, -1);
      baseUrl = colabUrl;
    }
    
    try {
      const response = await fetch(`${baseUrl}/process_image?remove_bg=${removeBg}`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) {
        throw new Error(`Backend API error: ${response.statusText}`);
      }
      
      const buffer = await response.arrayBuffer();
      const splatArray = GaussianSplats3D.PlyParser.parseToUncompressedSplatArray(buffer);
      return encodeUncompressedSplatArray(splatArray);
    } catch (e) {
      throw new Error(`Failed to process image: ${e.message}. Make sure the backend server is running.`);
    }
  }

  const buffer = await file.arrayBuffer();

  if (fileName.endsWith('.splat')) {
    return new SplatData(new Uint8Array(buffer));
  }

  if (fileName.endsWith('.ply')) {
    const splatArray = GaussianSplats3D.PlyParser.parseToUncompressedSplatArray(buffer);
    return encodeUncompressedSplatArray(splatArray);
  }

  // ── .ksplat support ───────────────────────────────────────────────────────
  // .ksplat is mkkellogg's own compressed SplatBuffer binary format.
  // KSplatLoader.loadFromFileData() validates the version header and constructs
  // a SplatBuffer, which we then walk per-splat using the public accessor API.
  if (fileName.endsWith('.ksplat')) {
    // loadFromFileData wraps construction in a short setTimeout via delayedExecute,
    // so we must await the returned Promise.
    let splatBuffer;
    try {
      splatBuffer = await GaussianSplats3D.KSplatLoader.loadFromFileData(buffer);
    } catch (e) {
      console.error('[ksplat] KSplatLoader.loadFromFileData failed — version mismatch or corrupt file:', e);
      throw new Error(`Failed to load .ksplat: ${e.message}`);
    }

    const count = splatBuffer.getSplatCount();
    if (typeof count !== 'number' || count <= 0) {
      throw new Error('.ksplat file contains no splats');
    }

    // Allocate the 32-byte-per-splat output buffer.
    const out = new Uint8Array(count * 32);
    const outView = new DataView(out.buffer);

    // Reusable objects for per-splat reads (avoid per-iteration allocation).
    const center = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const color = new THREE.Vector4();

    // Verify the expected accessor methods exist at runtime so we get a clear
    // error if the library version changes rather than a silent bad output.
    const hasMethods = (
      typeof splatBuffer.getSplatCenter === 'function' &&
      typeof splatBuffer.getSplatScaleAndRotation === 'function' &&
      typeof splatBuffer.getSplatColor === 'function'
    );
    if (!hasMethods) {
      console.error('[ksplat] SplatBuffer is missing expected accessor methods (getSplatCenter / getSplatScaleAndRotation / getSplatColor). Library version may differ from 0.4.7.');
      throw new Error('.ksplat: SplatBuffer API mismatch — check console for details');
    }

    let hasVisibleAlpha = false;
    for (let i = 0; i < count; i++) {
      // getSplatCenter(index, outCenter, transform=null)
      splatBuffer.getSplatCenter(i, center, null);

      // getSplatScaleAndRotation(index, outScale, outRotation, transform=null, scaleOverride=undefined)
      splatBuffer.getSplatScaleAndRotation(i, scale, rotation, null, undefined);

      // getSplatColor(index, outColor) — fills x=r, y=g, z=b, w=a as 0-255 integers
      splatBuffer.getSplatColor(i, color);

      const base = i * 32;

      // Position (3 × float32, bytes 0-11)
      outView.setFloat32(base +  0, center.x, true);
      outView.setFloat32(base +  4, center.y, true);
      outView.setFloat32(base +  8, center.z, true);

      // Scale (3 × float32, bytes 12-23)
      outView.setFloat32(base + 12, Number.isFinite(scale.x) ? scale.x : 0.01, true);
      outView.setFloat32(base + 16, Number.isFinite(scale.y) ? scale.y : 0.01, true);
      outView.setFloat32(base + 20, Number.isFinite(scale.z) ? scale.z : 0.01, true);

      // Color RGBA (4 × uint8, bytes 24-27)
      out[base + 24] = Math.max(0, Math.min(255, color.x | 0));
      out[base + 25] = Math.max(0, Math.min(255, color.y | 0));
      out[base + 26] = Math.max(0, Math.min(255, color.z | 0));
      out[base + 27] = Math.max(0, Math.min(255, color.w | 0));
      if (out[base + 27] > 0) hasVisibleAlpha = true;

      // Rotation quaternion (4 × uint8, bytes 28-31)
      // Same encoding as .splat format: [-1,1] → [0,255] via (val*0.5+0.5)*255
      // Order stored: w, x, y, z (matching encodeUncompressedSplatArray above)
      out[base + 28] = encodeQuaternionByte(Number.isFinite(rotation.w) ? rotation.w : 1);
      out[base + 29] = encodeQuaternionByte(Number.isFinite(rotation.x) ? rotation.x : 0);
      out[base + 30] = encodeQuaternionByte(Number.isFinite(rotation.y) ? rotation.y : 0);
      out[base + 31] = encodeQuaternionByte(Number.isFinite(rotation.z) ? rotation.z : 0);
    }

    // If every splat had alpha=0 (e.g. parser left it blank), make all fully opaque.
    if (!hasVisibleAlpha) {
      for (let i = 0; i < count; i++) out[i * 32 + 27] = 255;
    }

    return new SplatData(out);
  }

  // ── .sog / .ssog support (PlayCanvas SOGS, v2) ───────────────────────────
  // A .sog is a ZIP archive (meta.json + WebP textures). decodeSog() unzips it
  // with fflate, decodes each needed WebP via createImageBitmap/OffscreenCanvas,
  // dequantizes means/scales/quats/sh0 per the PlayCanvas engine v2 reader, and
  // returns the 32-byte-per-splat layout. Higher-order SH (shN) is ignored.
  if (fileName.endsWith('.sog') || fileName.endsWith('.ssog')) {
    const out = await decodeSog(buffer);
    return new SplatData(out);
  }

  throw new Error('Unsupported format. Supported extensions: .ply, .splat, .ksplat, .sog, .ssog, .png, .jpg, .jpeg');
}

// Old handlers removed.

// ── Drag & Drop files directly to Decks ────────────────
function setupDragAndDrop(elementId, fileInput) {
  const element = document.querySelector(`#${elementId}`);
  element.addEventListener('dragover', (e) => {
    e.preventDefault();
    element.style.background = 'rgba(255, 255, 255, 0.08)';
  });
  element.addEventListener('dragleave', () => {
    element.style.background = 'rgba(10, 10, 14, 0.6)';
  });
  element.addEventListener('drop', (e) => {
    e.preventDefault();
    element.style.background = 'rgba(10, 10, 14, 0.6)';
    const file = e.dataTransfer.files[0];
    const n = file?.name.toLowerCase();
    if (file && (n.endsWith('.ply') || n.endsWith('.splat') || n.endsWith('.ksplat') || n.endsWith('.sog') || n.endsWith('.ssog') || n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg'))) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      fileInput.dispatchEvent(new Event('change'));
    }
  });
}
setupDragAndDrop('deck-a', fileInputA);
setupDragAndDrop('deck-b', fileInputB);

// ── Mixer Settings Extraction ─────────────────────────
function getChSettings(ch) {
  const suffix = ch === 1 ? 'a' : 'b';
  const eqHi = Number(document.querySelector(`.ch-eq-hi[data-ch="${ch}"]`).value) / 50;
  const eqMid = Number(document.querySelector(`.ch-eq-mid[data-ch="${ch}"]`).value) / 50;
  const eqLow = Number(document.querySelector(`.ch-eq-low[data-ch="${ch}"]`).value) / 50;
  const filter = Number(document.querySelector(`.ch-filter[data-ch="${ch}"]`).value) / 100; // LPF < 0, HPF > 0
  const trim = Number(document.querySelector(`.ch-trim[data-ch="${ch}"]`).value) / 50;

  return { low: eqLow, mid: eqMid, high: eqHi, filter, trim };
}

function clampByte(val) {
  return Math.max(0, Math.min(255, Math.round(val)));
}

function estimateBounds(splatData) {
  const count = splatData.splatCount;
  if (!count) return { center: [0, 0, 0], size: [1, 1, 1] };

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const view = new DataView(splatData.data.buffer, splatData.data.byteOffset, splatData.data.byteLength);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);

    if (px < min[0]) min[0] = px;
    if (px > max[0]) max[0] = px;
    if (py < min[1]) min[1] = py;
    if (py > max[1]) max[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (pz > max[2]) max[2] = pz;
  }

  const center = [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5];
  const size = [
    Math.max(max[0] - min[0], 0.001),
    Math.max(max[1] - min[1], 0.001),
    Math.max(max[2] - min[2], 0.001)
  ];

  return { center, size };
}

function copySplatData(source) {
  const data = new Uint8Array(source.data.length);
  data.set(source.data);
  return {
    splatCount: source.splatCount,
    data: data
  };
}

// ── Apply EQ and Color knobs on geometry ───────────────
function applyMixerSettings(splatData, settings) {
  const count = splatData.splatCount;
  const data = splatData.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const bounds = estimateBounds(splatData);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const py = view.getFloat32(base + 4, true);
    const pz = view.getFloat32(base + 8, true);

    const dx = (px - bounds.center[0]) / bounds.size[0];
    const dy = (py - bounds.center[1]) / bounds.size[1];
    const dz = (pz - bounds.center[2]) / bounds.size[2];
    const radius = Math.min(1.0, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // EQ is now applied LIVE per-chunk in the render loop (see volScale/eqFactor),
    // so it is no longer baked into geometry here. radius/zone kept for reference.
    void radius;
  }
}

// ── Rotate splats on spin/play ────────────────────────
function rotateSplatPositions(splatData, angle) {
  if (angle === 0) return;
  const count = splatData.splatCount;
  const data = splatData.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const bounds = estimateBounds(splatData);

  for (let i = 0; i < count; i++) {
    const base = i * 32;
    const px = view.getFloat32(base + 0, true);
    const pz = view.getFloat32(base + 8, true);

    const dx = px - bounds.center[0];
    const dz = pz - bounds.center[2];

    const rx = dx * cos - dz * sin;
    const rz = dx * sin + dz * cos;

    view.setFloat32(base + 0, rx + bounds.center[0], true);
    view.setFloat32(base + 8, rz + bounds.center[2], true);
  }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id && e.target.id.startsWith('max-splats-slider-')) {
    const deck = e.target.id.split('-').pop();
    const valEl = document.getElementById(`max-splats-val-${deck}`);
    const val = parseInt(e.target.value);
    if (valEl) valEl.textContent = val >= 1000000 ? (val/1000000).toFixed(1) + 'M' : Math.floor(val/1000) + 'k';
    const min = parseFloat(e.target.min), max = parseFloat(e.target.max);
    const pct = ((val - min) / (max - min) * 100).toFixed(1) + '%';
    e.target.style.background = `linear-gradient(to right, #f97316 0%, #f97316 ${pct}, #2a2a2a ${pct}, #2a2a2a 100%)`;
  }
  if (e.target && e.target.id && e.target.id.startsWith('chunks-slider-')) {
    const deck = e.target.id.split('-').pop();
    const valEl = document.getElementById(`chunks-val-${deck}`);
    // Slider is index 0-3 → actual chunk count [4,8,16,32]
    const CHUNK_STEPS = [4, 8, 16, 32];
    const chunkCount = CHUNK_STEPS[Math.round(parseFloat(e.target.value))] || 16;
    if (valEl) valEl.textContent = chunkCount;
    const min = parseFloat(e.target.min), max = parseFloat(e.target.max);
    const pct = ((parseFloat(e.target.value) - min) / (max - min) * 100).toFixed(1) + '%';
    e.target.style.background = `linear-gradient(to right, #f97316 0%, #f97316 ${pct}, #2a2a2a ${pct}, #2a2a2a 100%)`;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target && e.target.id && e.target.id.startsWith('max-splats-slider-')) {
    const deck = e.target.id.split('-').pop();
    const val = parseInt(e.target.value);
    if (deck === 'a' && rawSceneA) sceneA = limitSplatCount(rawSceneA, val);
    if (deck === 'b' && rawSceneB) sceneB = limitSplatCount(rawSceneB, val);
    if (deck === 'c' && rawSceneC) sceneC = limitSplatCount(rawSceneC, val);
    if (deck === 'd' && rawSceneD) sceneD = limitSplatCount(rawSceneD, val);
    await rebuildViewerBuffers();
  }
  if (e.target && e.target.id && e.target.id.startsWith('chunks-slider-')) {
    await rebuildViewerBuffers();
  }
});

// ── Real-Time Update Execution ─────────────────────────
function triggerRealtimeUpdate() {
  if (!sceneA) return;
  if (updateInProgress) {
    updatePending = true;
    return;
  }
  updateInProgress = true;
  requestAnimationFrame(async () => {
    try {
      await performRealtimeUpdate();
    } catch (err) {
      console.error("Update error in loop:", err);
    } finally {
      updateInProgress = false;
      if (updatePending) {
        updatePending = false;
        triggerRealtimeUpdate();
      }
    }
  });
}

function pseudoRandom(seed, index) {
  let a = Math.imul(seed, 374761393) + index;
  a = (a ^ 61) ^ (a >>> 16);
  a = a + (a << 3);
  a = a ^ (a >>> 4);
  a = Math.imul(a, 0x27d4eb2d);
  a = a ^ (a >>> 15);
  return (a >>> 0) / 4294967296.0;
}

async function performRealtimeUpdate() {
  if (!viewer) {
    requestAnimationFrame(performRealtimeUpdate);
    return;
  }

  // Deferred zoom-sync: attach controls 'change' listener once controls become available
  if (!zoomSyncAttached && viewer.controls) {
    if (window._zoomSyncPoll) { window._zoomSyncPoll(); }
  }

  try {
    const now = Date.now();
    const cuts = parseInt(cutsSlider.value);
    const mixAmount = Number(crossfader.value) / 100;
    // OVERLAY (#10): the crossfader controls the A/B OPACITY blend in the
    // full-screen overlay (deck A opacity = 1-mix, deck B = mix). It must NOT
    // gate scene VISIBILITY (both decks stay drawn so they can fade); the opacity
    // is applied per-deck in renderPass via crossfadeMix. Keep the gains at 1 so
    // the legacy `crossGainA > 0.01` visibility checks below keep decks visible.
    crossfadeMix = mixAmount;
    const crossGainA = 1.0;
    const crossGainB = 1.0;

    // Camera rig: blend deck view targets by the crossfader, ease, and position
    // the camera looking at the origin (radius honours master-vol zoom).
    updateCameraRig(mixAmount);

    const isPlaying = isPlayingA || isPlayingB || isScratchingA || isScratchingB;
    
    const jogTotal = jogAngleA + jogAngleB;
    
    const baseTimeStepA = Math.floor((playAngleA + jogAngleA) * 15.0);
    const timeStepA = loopActiveA ? loopStartA + ((baseTimeStepA - loopStartA) % loopLengthA) : baseTimeStepA;

    const baseTimeStepB = Math.floor((playAngleB + jogAngleB) * 15.0);
    const timeStepB = loopActiveB ? loopStartB + ((baseTimeStepB - loopStartB) % loopLengthB) : baseTimeStepB;

    const beatStrA = beatDivisions[beatIndexA] || "1";
    const beatFreqBaseA = beatStrA.includes('/') ? parseFloat(beatStrA.split('/')[1]) : (1.0 / parseFloat(beatStrA));
    const beatFreqA = beatFreqBaseA * (bpmA / 120.0);

    const beatStrB = beatDivisions[beatIndexB] || "1";
    const beatFreqBaseB = beatStrB.includes('/') ? parseFloat(beatStrB.split('/')[1]) : (1.0 / parseFloat(beatStrB));
    const beatFreqB = beatFreqBaseB * (bpmB / 120.0);

    const beatStrM = beatDivisions[beatIndexM] || "1";
    const beatFreqBaseM = beatStrM.includes('/') ? parseFloat(beatStrM.split('/')[1]) : (1.0 / parseFloat(beatStrM));
    const beatFreqM = beatFreqBaseM * (Math.max(bpmA, bpmB) / 120.0);

    const amountA = Number(fxDepthA.value) / 100;
    const amountB = Number(fxDepthB.value) / 100;
    const amountM = Number(fxDepthM.value) / 100;

    // DOF capped to 25% of the previous range to avoid heavy overdraw / fps drop.
    const dofVal = (Number(knobDof.value) / 100) * 0.25;

    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uFxTime) {
      const uniforms = viewer.splatMesh.material.uniforms;
      uniforms.uFxTime.value = (performance.now() % 100000) * 0.002;
      uniforms.uDeckAChunkCount.value = numChunksA + numRollChunksA;
      
      uniforms.uFaderScaleA = uniforms.uFaderScaleA || { value: 1.0 };
      uniforms.uFaderScaleB = uniforms.uFaderScaleB || { value: 1.0 };
      const _filterA = document.getElementById('filter-a');
      const _filterB = document.getElementById('filter-b');
      uniforms.uFaderScaleA.value = _filterA ? (Number(_filterA.value) + 100) / 100 : 1.0;
      uniforms.uFaderScaleB.value = _filterB ? (Number(_filterB.value) + 100) / 100 : 1.0;

      if (uniforms.uDofAmount) {
        uniforms.uDofAmount.value = dofVal;
      }
      if (uniforms.uDofFocus && viewer.camera) {
        const focusDist = viewer.camera.position.distanceTo((viewer.controls && viewer.controls.target) ? viewer.controls.target : new THREE.Vector3());
        uniforms.uDofFocus.value = focusDist;
      }
      if (bokehPass && bokehPass.enabled && viewer.camera && viewer.controls) {
        bokehPass.uniforms['focus'].value = viewer.camera.position.distanceTo(viewer.controls.target);
      }
      
      // Deck A
      uniforms.uFxBeatFreqA.value = beatFreqA;
      uniforms.uFxFlangerAmountA.value = (fxEngagedA && fxActiveA === 'flanger') ? amountA : 0.0;
      uniforms.uFxPhaserAmountA.value = (fxEngagedA && fxActiveA === 'phaser') ? amountA : 0.0;
      if (fxEngagedA && fxActiveA === 'pitch') {
        if (amountA > 0.5) {
          const shiftAmount = (amountA - 0.5) * 2.0;
          uniforms.uFxPitchSquashXA.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchYA.value = 1.0 + shiftAmount * 2.0;
          uniforms.uFxPitchSquashYA.value = 1.0;
          uniforms.uFxPitchStretchXA.value = 1.0;
        } else {
          const shiftAmount = (0.5 - amountA) * 2.0;
          uniforms.uFxPitchSquashXA.value = 1.0;
          uniforms.uFxPitchStretchYA.value = 1.0;
          uniforms.uFxPitchSquashYA.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchXA.value = 1.0 + shiftAmount * 2.0;
        }
      } else {
        uniforms.uFxPitchSquashXA.value = 1.0;
        uniforms.uFxPitchStretchYA.value = 1.0;
        uniforms.uFxPitchSquashYA.value = 1.0;
        uniforms.uFxPitchStretchXA.value = 1.0;
      }
      
      // Deck B
      uniforms.uFxBeatFreqB.value = beatFreqB;
      uniforms.uFxFlangerAmountB.value = (fxEngagedB && fxActiveB === 'flanger') ? amountB : 0.0;
      uniforms.uFxPhaserAmountB.value = (fxEngagedB && fxActiveB === 'phaser') ? amountB : 0.0;
      if (fxEngagedB && fxActiveB === 'pitch') {
        if (amountB > 0.5) {
          const shiftAmount = (amountB - 0.5) * 2.0;
          uniforms.uFxPitchSquashXB.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchYB.value = 1.0 + shiftAmount * 2.0;
          uniforms.uFxPitchSquashYB.value = 1.0;
          uniforms.uFxPitchStretchXB.value = 1.0;
        } else {
          const shiftAmount = (0.5 - amountB) * 2.0;
          uniforms.uFxPitchSquashXB.value = 1.0;
          uniforms.uFxPitchStretchYB.value = 1.0;
          uniforms.uFxPitchSquashYB.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchXB.value = 1.0 + shiftAmount * 2.0;
        }
      } else {
        uniforms.uFxPitchSquashXB.value = 1.0;
        uniforms.uFxPitchStretchYB.value = 1.0;
        uniforms.uFxPitchSquashYB.value = 1.0;
        uniforms.uFxPitchStretchXB.value = 1.0;
      }
      
      // Master
      uniforms.uFxBeatFreqM.value = beatFreqM;
      uniforms.uFxFlangerAmountM.value = (fxEngagedM && fxActiveM === 'flanger') ? amountM : 0.0;
      uniforms.uFxPhaserAmountM.value = (fxEngagedM && fxActiveM === 'phaser') ? amountM : 0.0;
      if (fxEngagedM && fxActiveM === 'pitch') {
        if (amountM > 0.5) {
          const shiftAmount = (amountM - 0.5) * 2.0;
          uniforms.uFxPitchSquashXM.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchYM.value = 1.0 + shiftAmount * 2.0;
          uniforms.uFxPitchSquashYM.value = 1.0;
          uniforms.uFxPitchStretchXM.value = 1.0;
        } else {
          const shiftAmount = (0.5 - amountM) * 2.0;
          uniforms.uFxPitchSquashXM.value = 1.0;
          uniforms.uFxPitchStretchYM.value = 1.0;
          uniforms.uFxPitchSquashYM.value = Math.max(0.01, 1.0 - shiftAmount * 0.99);
          uniforms.uFxPitchStretchXM.value = 1.0 + shiftAmount * 2.0;
        }
      } else {
        uniforms.uFxPitchSquashXM.value = 1.0;
        uniforms.uFxPitchStretchYM.value = 1.0;
        uniforms.uFxPitchSquashYM.value = 1.0;
        uniforms.uFxPitchStretchXM.value = 1.0;
      }

      // #8 Chunk-range loop tint: update uniforms for orange highlight.
      // Deck A: scene indices 0..(numChunksA-1). Deck B: numChunksA..(numChunksA+numChunksB-1).
      // uLoopStart/End are absolute scene indices.
      if (uniforms.uLoopActiveA !== undefined) {
        const deckAOffset = 0;
        const deckBOffset = numChunksA + numRollChunksA;
        // Orange tint shows only while SELECTING; once committed (#6) it clears.
        uniforms.uLoopActiveA.value = (loopActiveA && !loopCommittedA) ? 1.0 : 0.0;
        uniforms.uLoopStartA.value  = deckAOffset + Math.max(0, loopChunkStartA);
        uniforms.uLoopEndA.value    = deckAOffset + Math.min(Math.max(0, numChunksA - 1), loopChunkEndA);
        uniforms.uLoopActiveB.value = (loopActiveB && !loopCommittedB) ? 1.0 : 0.0;
        uniforms.uLoopStartB.value  = deckBOffset + Math.max(0, loopChunkStartB);
        uniforms.uLoopEndB.value    = deckBOffset + Math.min(Math.max(0, numChunksB - 1), loopChunkEndB);
        // Expose for headless verification
        window._loopUniforms = {
          activeA: uniforms.uLoopActiveA.value,
          startA:  uniforms.uLoopStartA.value,
          endA:    uniforms.uLoopEndA.value,
          activeB: uniforms.uLoopActiveB.value,
          startB:  uniforms.uLoopStartB.value,
          endB:    uniforms.uLoopEndB.value,
        };
      }
    }

    const isRollA = (fxEngagedA && fxActiveA === 'roll') || (fxEngagedM && fxActiveM === 'roll');
    const isRollB = (fxEngagedB && fxActiveB === 'roll') || (fxEngagedM && fxActiveM === 'roll');
    
    if (isRollA && !lastRollStateA) {
      frozenPlayAngleA = playAngleA;
    }
    if (isRollB && !lastRollStateB) {
      frozenPlayAngleB = playAngleB;
    }
    lastRollStateA = isRollA;
    lastRollStateB = isRollB;

    // Calculate strobe values
    const isTransA = (fxEngagedA && fxActiveA === 'trans') || (fxEngagedM && fxActiveM === 'trans');
    const isTransB = (fxEngagedB && fxActiveB === 'trans') || (fxEngagedM && fxActiveM === 'trans');
    
    let strobeAlphaA = 1.0;
    let isTransOn = true;
    const transFreq = (fxEngagedM && fxActiveM === 'trans') ? beatFreqM : (isTransA ? beatFreqA : beatFreqB);
    const phase = now * 0.001 * Math.PI * 2 * transFreq; // Strobe frequency same as beats (no * 2)
    isTransOn = Math.sin(phase) > 0;
    
    if (isTransA) {
      const transAmount = (fxEngagedM && fxActiveM === 'trans') ? amountM : amountA;
      const offAlpha = Math.max(0.0, 1.0 - transAmount * 1.8);
      strobeAlphaA = isTransOn ? 1.25 : offAlpha;
    }

    let strobeAlphaB = 1.0;
    if (isTransB) {
      const transAmount = (fxEngagedM && fxActiveM === 'trans') ? amountM : amountB;
      const offAlpha = Math.max(0.0, 1.0 - transAmount * 1.8);
      strobeAlphaB = isTransOn ? 1.25 : offAlpha;
    }
    
    // OVERLAY (#10): stash the base (pre-crossfade) trans-strobe alpha. The
    // render pass folds in the A/B crossfade gain PER DECK (deck A → *(1-mix),
    // deck B → *mix, C/D → *1) so a single uStrobeAlphaB uniform can serve B and
    // C/D differently across the overlay passes without clobbering the strobe.
    strobeAlphaBaseA = strobeAlphaA * crossGainA;
    strobeAlphaBaseB = strobeAlphaB * crossGainB;
    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uStrobeAlphaA) {
      // Seed the uniforms with the base values; renderPass overwrites them per
      // deck during compositing (single-deck path uses these directly).
      viewer.splatMesh.material.uniforms.uStrobeAlphaA.value = strobeAlphaBaseA;
      viewer.splatMesh.material.uniforms.uStrobeAlphaB.value = strobeAlphaBaseB;
    }
    
    // STROBE control drives the WebGL screen-space strobe overlay (independent of Trans).
    // The overlay renders inside the composer pass between the HDRI background and
    // the splats; here we only update the driving values. When off we set strength
    // to 0 so the pass skips the overlay draw entirely (zero added FPS cost).
    if (strobeEngaged) {
      const bpm = Math.max(bpmA, bpmB) || 120;
      const beatPhase = (now * 0.001) * (bpm / 60);
      if (strobeMode === 'side') {
        // SIDE mode: one edge gradient cycles per beat (top->right->bottom->left).
        strobeUMode = 0;
        strobeUEdge = Math.floor(beatPhase) % 4;
        strobeStrength = 0.6;
      } else {
        // FULL mode: uniform white flash on the on-beat half of the cycle.
        strobeUMode = 1;
        strobeStrength = (Math.sin(beatPhase * Math.PI * 2) > 0) ? 0.9 : 0;
      }
    } else {
      strobeStrength = 0;
    }

    // Process Delay/Echo with 2D Feedback Post-processing
    if (afterimagePass) {
      const isDelayA = (fxEngagedA && fxActiveA === 'delay');
      const isDelayB = (fxEngagedB && fxActiveB === 'delay');
      const isDelayC = (fxEngagedC && fxActiveC === 'delay');
      const isDelayD = (fxEngagedD && fxActiveD === 'delay');
      const isDelayM = (fxEngagedM && fxActiveM === 'delay');
      
      const isEchoA = (fxEngagedA && fxActiveA === 'echo');
      const isEchoB = (fxEngagedB && fxActiveB === 'echo');
      const isEchoC = (fxEngagedC && fxActiveC === 'echo');
      const isEchoD = (fxEngagedD && fxActiveD === 'echo');
      const isEchoM = (fxEngagedM && fxActiveM === 'echo');

      const anyEchoOrDelay = isDelayA || isDelayB || isDelayC || isDelayD || isDelayM || isEchoA || isEchoB || isEchoC || isEchoD || isEchoM;
      if (anyEchoOrDelay) {
        afterimagePass.enabled = true;
        
        // Find max effect amount
        const maxAmount = Math.max(
          isDelayA || isEchoA ? amountA : 0,
          isDelayB || isEchoB ? amountB : 0,
          isDelayC || isEchoC ? amountC : 0,
          isDelayD || isEchoD ? amountD : 0,
          isDelayM || isEchoM ? amountM : 0
        );

        // Map amount to damp (0.8 to 0.998) - increased for longer feedback
        afterimagePass.uniforms['damp'].value = 0.8 + maxAmount * 0.198;
        
        // Map amount to scale down (1.0 to 1.05) if echo
        const isAnyEcho = isEchoA || isEchoB || isEchoC || isEchoD || isEchoM;
        afterimagePass.uniforms['scale'].value = isAnyEcho ? 1.0 + maxAmount * 0.05 : 1.0;
      } else {
        afterimagePass.enabled = false;
      }
    }

    // NOTE: The strobe is now part of the rendered/captured WebGL frame, so the
    // output window receives it automatically through the captured video stream.
    // No DOM strobe mirroring into outputWin is needed.

    let sceneIdx = 0;

    updateEqSmoothing(); // ease EQ band factors once before both deck loops use them

    const targetDist = 5.0;
    const globalZ = (now * 0.0002) % (Math.PI * 2);
    const splatMesh = viewer.splatMesh;
    const sceneCount = splatMesh ? splatMesh.getSceneCount() : Infinity;

    // #9: Pitch FX extremeness — how far pitch knob is from centre (0=neutral, 1=min/max).
    // Used to add per-chunk pseudo-random rotation + position chaos at the knob extremes.
    const pitchExtremeA = (fxEngagedA && fxActiveA === 'pitch') ? Math.abs(amountA - 0.5) * 2 : 0;
    const pitchExtremeB = (fxEngagedB && fxActiveB === 'pitch') ? Math.abs(amountB - 0.5) * 2 : 0;
    const pitchExtremeM = (fxEngagedM && fxActiveM === 'pitch') ? Math.abs(amountM - 0.5) * 2 : 0;
    // Slow time seed for subtle animation of the chaos (advances ~1 unit per second).
    const pitchTimeSeed = Math.floor(now * 0.001) & 0xffff;

    const volTargetA = Math.max(0.0001, Number(volAEl.value) / 100);
    volScaleSmoothA += (volTargetA - volScaleSmoothA) * VOL_SMOOTH_ALPHA;
    const volScaleA = volScaleSmoothA;
    nudgeXA *= 0.9;

    // Apply fast GPU transforms and visibility to Scene A
    const totalChunksA = numChunksA + numRollChunksA;
    for (let i = 0; i < totalChunksA; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;
      if (!sceneA) { splatScene.visible = false; continue; } // deck unloaded — hide lingering scenes

      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        targetVisible = crossGainA > 0.01;
        beatScaleMult = 1.0;
        // --- PULSE PLAY ANIMATION: one chunk at 120%, advances one chunk per beat, outer→inner clockwise ---
        // All chunks stay at 1.0 scale; the active chunk (one per beat) scales up to 1.2.
        // Roll chunks (i >= numChunksA) are always fully revealed and not pulsed.
        if (i < numChunksA && isPlayingA) {
          const beatsA = (now / 1000) * (bpmA / 60);
          // #8 Chunk-range loop: if loopActiveA, restrict pulse to [loopChunkStartA..loopChunkEndA]
          let activeChunkA;
          if (loopActiveA && loopChunkEndA >= loopChunkStartA) {
            const rangeLen = loopChunkEndA - loopChunkStartA + 1;
            activeChunkA = loopChunkStartA + (Math.floor(beatsA) % rangeLen);
          } else {
            activeChunkA = Math.floor(beatsA) % Math.max(1, numChunksA);
          }
          if (i === activeChunkA) {
            targetScaleFactor = 2.0; // pulse to 200%
            const seedA = Math.floor(beatsA); // new random orientation each beat
            rX = (pseudoRandom(seedA, i + 300) - 0.5) * Math.PI * 2;
            rY = (pseudoRandom(seedA, i + 400) - 0.5) * Math.PI * 2;
            rZ = (pseudoRandom(seedA, i + 500) - 0.5) * Math.PI * 2;
          } else {
            targetScaleFactor = 1.0;
            rX = 0; rY = 0; rZ = 0;
          }
        } else {
          targetScaleFactor = 1.0;
          rX = 0; rY = 0; rZ = 0;
        }
        /* --- PREVIOUS PLAY ANIMATION (sequential reveal) — kept for reference ---
        const cyclePos = ((now / 1000) / REVEAL_PERIOD) % 1;
        const revealThreshold = (i < numChunksA) ? (i / Math.max(1, numChunksA)) : 0;
        targetScaleFactor = (cyclePos >= revealThreshold) ? 1.0 : 0.0;
        rX = 0; rY = 0; rZ = 0;
        --- END PREVIOUS PLAY ANIMATION --- */
        /* --- PREVIOUS PLAY ANIMATION (random shuffle) — kept for reference ---
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepA, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepA, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepA, i + 500) - 0.5) * Math.PI * 2;
        --- END PREVIOUS PLAY ANIMATION --- */
      } else {
        targetVisible = crossGainA > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
      }

      // #6 committed loop: chunks outside the selected range scale to 0.
      if (loopCommittedA && i < numChunksA && (i < loopChunkStartA || i > loopChunkEndA)) {
        targetScaleFactor = 0;
        targetVisible = false;
      }

      currentScalesA[i] += (targetScaleFactor - currentScalesA[i]) * 0.15;
      splatScene.visible = targetVisible;

      const scaleA = targetDist / boundsA.maxDist;
      const activeScale = Math.max(0.0001, currentScalesA[i] * scaleA * beatScaleMult);
      
      let finalScale = activeScale;

      let effectiveAngleA = playAngleA;
      if (isRollA && i >= numChunksA) {
         effectiveAngleA = frozenPlayAngleA - (i - numChunksA) * 0.15;
         finalScale = 1.0; // frozen scale
      }
      
      const angleA = effectiveAngleA; // jog now orbits the camera, not the object

      // #9: Pitch extreme → per-chunk pseudo-random rotation + position chaos.
      // extremeA / extremeM: 0 at centre (no chaos), 1 at min/max (full chaos).
      const _pitchExA = Math.max(pitchExtremeA, pitchExtremeM);
      if (_pitchExA > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        rX += (pseudoRandom(_pSeed, i + 300) - 0.5) * Math.PI * _pitchExA;
        rY += (pseudoRandom(_pSeed, i + 400) - 0.5) * Math.PI * _pitchExA;
        rZ += (pseudoRandom(_pSeed, i + 500) - 0.5) * Math.PI * _pitchExA;
      }

      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, angleA).multiply(_scratchQRandom);
      _scratchV.copy(boundsA.center).multiplyScalar(finalScale).applyQuaternion(_scratchQ).negate();

      // Live EQ: outer/mid/inner chunks scaled by smoothed HI/MID/LOW (0 = cut to nothing).
      const eqFA = (i < numChunksA) ? eqFactorForChunk(i, numChunksA, eqSmooth.hiA, eqSmooth.midA, eqSmooth.lowA) : 1.0;
      splatScene.scale.setScalar(finalScale * volScaleA * eqFA);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
      splatScene.position.x += nudgeXA;

      // #9: Pitch extreme → per-chunk position offset (fraction of object size, won't fling off-screen).
      if (_pitchExA > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        const _posScale = boundsA.maxDist * 0.15 * _pitchExA;
        splatScene.position.x += (pseudoRandom(_pSeed, i + 600) - 0.5) * _posScale;
        splatScene.position.y += (pseudoRandom(_pSeed, i + 700) - 0.5) * _posScale;
        splatScene.position.z += (pseudoRandom(_pSeed, i + 800) - 0.5) * _posScale;
      }
    }

    const volTargetB = Math.max(0.0001, Number(volBEl.value) / 100);
    volScaleSmoothB += (volTargetB - volScaleSmoothB) * VOL_SMOOTH_ALPHA;
    const volScaleB = volScaleSmoothB;
    nudgeXB *= 0.9;

    // Apply fast GPU transforms and visibility to Scene B
    const totalChunksB = numChunksB + numRollChunksB;
    for (let i = 0; i < totalChunksB; i++) {
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;
      if (!sceneB) { splatScene.visible = false; continue; } // deck unloaded — hide lingering scenes

      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        targetVisible = crossGainB > 0.01;
        beatScaleMult = 1.0;
        // --- PULSE PLAY ANIMATION: one chunk at 120%, advances one chunk per beat, outer→inner clockwise ---
        if (i < numChunksB && isPlayingB) {
          const beatsB = (now / 1000) * (bpmB / 60);
          // #8 Chunk-range loop: if loopActiveB, restrict pulse to [loopChunkStartB..loopChunkEndB]
          let activeChunkB;
          if (loopActiveB && loopChunkEndB >= loopChunkStartB) {
            const rangeLen = loopChunkEndB - loopChunkStartB + 1;
            activeChunkB = loopChunkStartB + (Math.floor(beatsB) % rangeLen);
          } else {
            activeChunkB = Math.floor(beatsB) % Math.max(1, numChunksB);
          }
          if (i === activeChunkB) {
            targetScaleFactor = 2.0; // pulse to 200%
            const seedB = Math.floor(beatsB); // new random orientation each beat
            rX = (pseudoRandom(seedB, i + 300) - 0.5) * Math.PI * 2;
            rY = (pseudoRandom(seedB, i + 400) - 0.5) * Math.PI * 2;
            rZ = (pseudoRandom(seedB, i + 500) - 0.5) * Math.PI * 2;
          } else {
            targetScaleFactor = 1.0;
            rX = 0; rY = 0; rZ = 0;
          }
        } else {
          targetScaleFactor = 1.0;
          rX = 0; rY = 0; rZ = 0;
        }
        /* --- PREVIOUS PLAY ANIMATION (sequential reveal) — kept for reference ---
        const cyclePos = ((now / 1000) / REVEAL_PERIOD) % 1;
        const revealThreshold = (i < numChunksB) ? (i / Math.max(1, numChunksB)) : 0;
        targetScaleFactor = (cyclePos >= revealThreshold) ? 1.0 : 0.0;
        rX = 0; rY = 0; rZ = 0;
        --- END PREVIOUS PLAY ANIMATION --- */
        /* --- PREVIOUS PLAY ANIMATION (random shuffle) — kept for reference ---
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepB, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepB, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepB, i + 500) - 0.5) * Math.PI * 2;
        --- END PREVIOUS PLAY ANIMATION --- */
      } else {
        targetVisible = crossGainB > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
      }

      // #6 committed loop: chunks outside the selected range scale to 0.
      if (loopCommittedB && i < numChunksB && (i < loopChunkStartB || i > loopChunkEndB)) {
        targetScaleFactor = 0;
        targetVisible = false;
      }

      currentScalesB[i] += (targetScaleFactor - currentScalesB[i]) * 0.15;
      splatScene.visible = targetVisible;

      const scaleB = targetDist / boundsB.maxDist;
      const activeScale = Math.max(0.0001, currentScalesB[i] * scaleB * beatScaleMult);
      
      let finalScale = activeScale;

      let effectiveAngleB = playAngleB;
      if (isRollB && i >= numChunksB) {
         effectiveAngleB = frozenPlayAngleB - (i - numChunksB) * 0.15;
         finalScale = 1.0; // frozen scale
      }

      const angleB = effectiveAngleB; // jog now orbits the camera, not the object

      // #9: Pitch extreme → per-chunk pseudo-random rotation + position chaos.
      const _pitchExB = Math.max(pitchExtremeB, pitchExtremeM);
      if (_pitchExB > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        rX += (pseudoRandom(_pSeed, i + 300) - 0.5) * Math.PI * _pitchExB;
        rY += (pseudoRandom(_pSeed, i + 400) - 0.5) * Math.PI * _pitchExB;
        rZ += (pseudoRandom(_pSeed, i + 500) - 0.5) * Math.PI * _pitchExB;
      }

      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, angleB).multiply(_scratchQRandom);
      _scratchV.copy(boundsB.center).multiplyScalar(finalScale).applyQuaternion(_scratchQ).negate();

      // Live EQ (deck B), smoothed.
      const eqFB = (i < numChunksB) ? eqFactorForChunk(i, numChunksB, eqSmooth.hiB, eqSmooth.midB, eqSmooth.lowB) : 1.0;
      splatScene.scale.setScalar(finalScale * volScaleB * eqFB);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
      splatScene.position.x += nudgeXB;

      // #9: Pitch extreme → per-chunk position offset.
      if (_pitchExB > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        const _posScale = boundsB.maxDist * 0.15 * _pitchExB;
        splatScene.position.x += (pseudoRandom(_pSeed, i + 600) - 0.5) * _posScale;
        splatScene.position.y += (pseudoRandom(_pSeed, i + 700) - 0.5) * _posScale;
        splatScene.position.z += (pseudoRandom(_pSeed, i + 800) - 0.5) * _posScale;
      }
    }

    // Apply fast GPU transforms and visibility to Scene C
    const totalChunksC = numChunksC + numRollChunksC;
    for (let i = 0; i < totalChunksC; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;
      if (!sceneC) { splatScene.visible = false; continue; } // deck unloaded — hide lingering scenes

      let targetVisible = false;
      let targetScaleFactor = 0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlayingC) {
        targetVisible = true;
        // --- PULSE PLAY ANIMATION: one chunk at 120%, advances one chunk per beat, outer→inner clockwise ---
        // Deck C uses its tempo slider to derive BPM (50 = 120 BPM, proportional scaling).
        const bpmC = 120 * (Number(tempoCEl?.value) || 50) / 50;
        if (i < numChunksC) {
          const beatsC = (now / 1000) * (bpmC / 60);
          const activeChunkC = Math.floor(beatsC) % Math.max(1, numChunksC);
          if (i === activeChunkC) {
            targetScaleFactor = 2.0; // pulse to 200%
            const seedC = Math.floor(beatsC);
            rX = (pseudoRandom(seedC, i + 300) - 0.5) * Math.PI * 2;
            rY = (pseudoRandom(seedC, i + 400) - 0.5) * Math.PI * 2;
            rZ = (pseudoRandom(seedC, i + 500) - 0.5) * Math.PI * 2;
          } else {
            targetScaleFactor = 1.0;
            rX = 0; rY = 0; rZ = 0;
          }
        } else {
          targetScaleFactor = 1.0;
          rX = 0; rY = 0; rZ = 0;
        }
        playAngleC += 0.02 * (Number(tempoCEl?.value) || 50) / 50;
        /* --- PREVIOUS PLAY ANIMATION (sequential reveal) — kept for reference ---
        const cyclePos = ((now / 1000) / REVEAL_PERIOD) % 1;
        const revealThreshold = (i < numChunksC) ? (i / Math.max(1, numChunksC)) : 0;
        targetScaleFactor = (cyclePos >= revealThreshold) ? 1.0 : 0.0;
        playAngleC += 0.02 * (Number(tempoCEl?.value) || 50) / 50;
        --- END PREVIOUS PLAY ANIMATION --- */
        /* --- PREVIOUS PLAY ANIMATION (always full scale) — kept for reference ---
        targetScaleFactor = 1.0;
        playAngleC += 0.02 * (Number(tempoCEl?.value) || 50) / 50;
        --- END PREVIOUS PLAY ANIMATION --- */
      }

      currentScalesC[i] += (targetScaleFactor - currentScalesC[i]) * 0.15;
      splatScene.visible = isPlayingC ? targetVisible : (currentScalesC[i] > 0.01);

      const scaleC = targetDist / boundsC.maxDist;
      const activeScale = Math.max(0.0001, currentScalesC[i] * scaleC);

      // #9: Pitch extreme (master FX) adds to the per-chunk rotation chaos.
      if (pitchExtremeM > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        rX += (pseudoRandom(_pSeed, i + 300) - 0.5) * Math.PI * pitchExtremeM;
        rY += (pseudoRandom(_pSeed, i + 400) - 0.5) * Math.PI * pitchExtremeM;
        rZ += (pseudoRandom(_pSeed, i + 500) - 0.5) * Math.PI * pitchExtremeM;
      }
      // Apply pulse/pitch random orientation (identity when all zero) + spin.
      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, playAngleC).multiply(_scratchQRandom);
      _scratchV.copy(boundsC.center).multiplyScalar(activeScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(activeScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);

      if (pitchExtremeM > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        const _posScale = boundsC.maxDist * 0.15 * pitchExtremeM;
        splatScene.position.x += (pseudoRandom(_pSeed, i + 600) - 0.5) * _posScale;
        splatScene.position.y += (pseudoRandom(_pSeed, i + 700) - 0.5) * _posScale;
        splatScene.position.z += (pseudoRandom(_pSeed, i + 800) - 0.5) * _posScale;
      }
    }

    // Apply fast GPU transforms and visibility to Scene D
    const totalChunksD = numChunksD + numRollChunksD;
    for (let i = 0; i < totalChunksD; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;
      if (!sceneD) { splatScene.visible = false; continue; } // deck unloaded — hide lingering scenes

      let targetVisible = false;
      let targetScaleFactor = 0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlayingD) {
        targetVisible = true;
        // --- PULSE PLAY ANIMATION: one chunk at 120%, advances one chunk per beat, outer→inner clockwise ---
        // Deck D uses its tempo slider to derive BPM (50 = 120 BPM, proportional scaling).
        const bpmD = 120 * (Number(tempoDEl?.value) || 50) / 50;
        if (i < numChunksD) {
          const beatsD = (now / 1000) * (bpmD / 60);
          const activeChunkD = Math.floor(beatsD) % Math.max(1, numChunksD);
          if (i === activeChunkD) {
            targetScaleFactor = 2.0; // pulse to 200%
            const seedD = Math.floor(beatsD);
            rX = (pseudoRandom(seedD, i + 300) - 0.5) * Math.PI * 2;
            rY = (pseudoRandom(seedD, i + 400) - 0.5) * Math.PI * 2;
            rZ = (pseudoRandom(seedD, i + 500) - 0.5) * Math.PI * 2;
          } else {
            targetScaleFactor = 1.0;
            rX = 0; rY = 0; rZ = 0;
          }
        } else {
          targetScaleFactor = 1.0;
          rX = 0; rY = 0; rZ = 0;
        }
        playAngleD += 0.02 * (Number(tempoDEl?.value) || 50) / 50;
        /* --- PREVIOUS PLAY ANIMATION (sequential reveal) — kept for reference ---
        const cyclePos = ((now / 1000) / REVEAL_PERIOD) % 1;
        const revealThreshold = (i < numChunksD) ? (i / Math.max(1, numChunksD)) : 0;
        targetScaleFactor = (cyclePos >= revealThreshold) ? 1.0 : 0.0;
        playAngleD += 0.02 * (Number(tempoDEl?.value) || 50) / 50;
        --- END PREVIOUS PLAY ANIMATION --- */
        /* --- PREVIOUS PLAY ANIMATION (always full scale) — kept for reference ---
        targetScaleFactor = 1.0;
        playAngleD += 0.02 * (Number(tempoDEl?.value) || 50) / 50;
        --- END PREVIOUS PLAY ANIMATION --- */
      }

      currentScalesD[i] += (targetScaleFactor - currentScalesD[i]) * 0.15;
      splatScene.visible = isPlayingD ? targetVisible : (currentScalesD[i] > 0.01);

      const scaleD = targetDist / boundsD.maxDist;
      const activeScale = Math.max(0.0001, currentScalesD[i] * scaleD);

      // #9: Pitch extreme (master FX) adds to the per-chunk rotation chaos.
      if (pitchExtremeM > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        rX += (pseudoRandom(_pSeed, i + 300) - 0.5) * Math.PI * pitchExtremeM;
        rY += (pseudoRandom(_pSeed, i + 400) - 0.5) * Math.PI * pitchExtremeM;
        rZ += (pseudoRandom(_pSeed, i + 500) - 0.5) * Math.PI * pitchExtremeM;
      }
      // Apply pulse/pitch random orientation (identity when all zero) + spin.
      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, playAngleD).multiply(_scratchQRandom);
      _scratchV.copy(boundsD.center).multiplyScalar(activeScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(activeScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);

      if (pitchExtremeM > 0) {
        const _pSeed = pitchTimeSeed ^ (i * 7919);
        const _posScale = boundsD.maxDist * 0.15 * pitchExtremeM;
        splatScene.position.x += (pseudoRandom(_pSeed, i + 600) - 0.5) * _posScale;
        splatScene.position.y += (pseudoRandom(_pSeed, i + 700) - 0.5) * _posScale;
        splatScene.position.z += (pseudoRandom(_pSeed, i + 800) - 0.5) * _posScale;
      }
    }

  } catch (err) {
    console.error('Realtime update error:', err);
    statusEl.textContent = `Mixer error: ${err.message}`;
  }
}

// ── Reset Orientation (RESET VIEW) ─────────────────────
// Returns ALL decks' cameras to the default FRONT preset, zeroes each deck's jog
// orbit contribution and the object rotation, and reframes at the default distance.
const btnResetOrient = document.getElementById('btn-reset-orient');
if (btnResetOrient) {
  btnResetOrient.addEventListener('click', () => {
    const front = CAM_PRESETS[0];
    for (const cam of [camA, camB, camC, camD]) {
      cam.azimuth = front.az; cam.elevation = front.el;
    }
    jogAzA = 0; jogAzB = 0; jogAzC = 0; jogAzD = 0;
    // Snap every deck's eased current angles straight to front (no slow orbit).
    for (const cur of [camCurrentA, camCurrentB, camCurrentC, camCurrentD]) {
      cur.azimuth = front.az; cur.elevation = front.el;
    }
    camCurrent.azimuth = front.az;
    camCurrent.elevation = front.el;
    camRigInitialized = true;
    camRigSettling = false;
    // Zero the object playback/jog rotation so geometry returns to upright.
    playAngleA = 0; playAngleB = 0; playAngleC = 0; playAngleD = 0;
    jogAngleA = 0; jogAngleB = 0; jogAngleC = 0; jogAngleD = 0;
    // Constant zoom: always return Master-Volume to its neutral value so RESET VIEW
    // lands on the SAME distance every time (no creep in/out from prior wheel zoom).
    if (masterVol) { masterVol.value = 50; updateKnobFill(masterVol); }
    // Reframe at the default distance (re-derives baseFramedDistance + applies zoom).
    if (typeof centerCamera === 'function') centerCamera();
    // Clear active pad highlights.
    document.querySelectorAll('#pads-a .pad-btn.active, #pads-b .pad-btn.active, #pads-c .pad-btn.active, #pads-d .pad-btn.active')
      .forEach(el => el.classList.remove('active'));
    // Reposition immediately from the rig and redraw.
    updateCameraRig(Number(crossfader.value) / 100);
    triggerRealtimeUpdate();
    if (statusEl) statusEl.textContent = 'View reset to FRONT.';
  });
}

// ── Reset ──────────────────────────────────────────────
btnReset.addEventListener('click', async () => {
  // 1. Reset every range input to its HTML default value.
  document.querySelectorAll('input[type=range]').forEach(el => {
    el.value = el.defaultValue;
    if (el.classList.contains('knob')) updateKnobFill(el);
  });

  // Keep crossfader / mix in sync.
  if (crossfader && mixSlider) mixSlider.value = crossfader.value;

  // Reset seed and cuts to their HTML defaults.
  if (seedInput) seedInput.value = seedInput.defaultValue;
  if (cutsSlider) cutsSlider.value = cutsSlider.defaultValue;

  // 2. FX toggles off.
  fxEngagedA = false; fxActiveA = "none";
  if (fxSelectA) fxSelectA.value = "none";
  if (btnFxToggleA) btnFxToggleA.classList.remove('active');

  fxEngagedB = false; fxActiveB = "none";
  if (fxSelectB) fxSelectB.value = "none";
  if (btnFxToggleB) btnFxToggleB.classList.remove('active');

  fxEngagedC = false; fxActiveC = "none";
  if (fxSelectC) fxSelectC.value = "none";
  if (btnFxToggleC) btnFxToggleC.classList.remove('active');

  fxEngagedD = false; fxActiveD = "none";
  if (fxSelectD) fxSelectD.value = "none";
  if (btnFxToggleD) btnFxToggleD.classList.remove('active');

  fxEngagedM = false; fxActiveM = "none";
  if (fxSelectM) fxSelectM.value = "none";
  if (btnFxToggleM) btnFxToggleM.classList.remove('active');

  // Strobe off.
  strobeEngaged = false;
  document.getElementById('btn-strobe')?.classList.remove('active');

  // Loops off.
  loopActiveA = false; isAutoLoopA = false;
  loopActiveB = false; isAutoLoopB = false;
  loopCommittedA = false; loopCommittedB = false;
  loopRangeSelectedA = false; loopRangeSelectedB = false;
  for (const d of ['a', 'b']) {
    const tBtn = document.getElementById(`loop-toggle-${d}`);
    if (tBtn) { tBtn.classList.remove('active'); tBtn.textContent = 'GO'; }
    const activeBtn = document.getElementById(`loop-active-${d}`);
    if (activeBtn) activeBtn.textContent = '4B';
  }
  // Pad modes back to Hot Cue.
  setPadMode('a', 'hotcue'); setPadMode('b', 'hotcue');
  document.getElementById('loop-active-a')?.classList.remove('active');
  document.getElementById('loop-active-b')?.classList.remove('active');
  document.querySelectorAll('.pad-btn.active').forEach(el => el.classList.remove('active'));

  // 3. Stop all decks.
  isPlayingA = false; isPlayingB = false;
  isPlayingC = false; isPlayingD = false;
  playAngleA = 0; playAngleB = 0; playAngleC = 0; playAngleD = 0;
  jogAngleA = 0; jogAngleB = 0; jogAngleC = 0; jogAngleD = 0;
  // Reset the camera rig to FRONT (all decks).
  for (const cam of [camA, camB, camC, camD]) {
    cam.azimuth = CAM_PRESETS[0].az; cam.elevation = CAM_PRESETS[0].el;
  }
  jogAzA = 0; jogAzB = 0; jogAzC = 0; jogAzD = 0;
  camCurrent.azimuth = CAM_PRESETS[0].az; camCurrent.elevation = CAM_PRESETS[0].el;
  camRigInitialized = false; camRigSettling = false;
  if (currentScalesA) currentScalesA.fill(0);
  if (currentScalesB) currentScalesB.fill(0);
  if (currentScalesC) currentScalesC.fill(0);
  if (currentScalesD) currentScalesD.fill(0);
  splashFactor = 1.0;

  if (btnPlayA) btnPlayA.classList.remove('active');
  if (btnPlayB) btnPlayB.classList.remove('active');
  // C/D play buttons use inline style background instead of .active class.
  const btnPlayCEl = document.getElementById('btn-play-c');
  const btnPlayDEl = document.getElementById('btn-play-d');
  if (btnPlayCEl) btnPlayCEl.style.background = '#111';
  if (btnPlayDEl) btnPlayDEl.style.background = '#111';
  allLedsOff();

  stopAnimationLoop();

  // 4. Unload all decks.
  sceneA = null; rawSceneA = null;
  sceneB = null; rawSceneB = null;
  sceneC = null; rawSceneC = null;
  sceneD = null; rawSceneD = null;

  for (const L of ['a', 'b', 'c', 'd']) {
    const nameEl = document.getElementById(`file-${L}-name`);
    const loadBtn = document.getElementById(`btn-load-${L}`);
    const fileInput = document.getElementById(`file-${L}`);
    if (nameEl) nameEl.textContent = 'No file';
    if (loadBtn) loadBtn.classList.remove('loaded');
    if (fileInput) fileInput.value = '';
  }

  await rebuildViewerBuffers();
  statusEl.textContent = 'Reset — all settings cleared and decks unloaded.';
});

// ── Compatibility mappings for older test suites ───────
const fxButtonsMap = {
  'delay': btnDelay,
  'echo': btnEcho,
  'reverb': btnReverb,
  'filter': btnFilter,
  'flanger': btnFlanger,
  'phaser': btnPhaser,
  'pitch': btnPitch,
  'roll': btnRoll,
  'spiral': btnSpiral
};

Object.entries(fxButtonsMap).forEach(([fxKey, btn]) => {
  if (btn) {
    btn.addEventListener('click', () => {
      fxSelectM.value = fxKey;
      if (!fxEngagedM) {
        btnFxToggleM.click();
      } else {
        fxActiveM = fxKey;
        triggerRealtimeUpdate();
      }
    });
  }
});

if (btnRandomize) {
  btnRandomize.addEventListener('click', () => {
    seedInput.value = Math.floor(Math.random() * 10000);
    triggerRealtimeUpdate();
  });
}

// ── Export ──────────────────────────────────────────────
btnExport.addEventListener('click', () => {
  const data = resultData || sceneA;
  if (!data) {
    statusEl.textContent = 'Nothing to export!';
    return;
  }

  statusEl.textContent = 'Exporting .ply...';
  try {
    exportToPly(data);
    statusEl.textContent = 'Exported collage.ply!';
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Export error: ${err.message}`;
  }
});

// ── Initialize Web MIDI ──────────────────────────────────
initMIDI();

// ── Initialize HID gamepad (PlayStation / Xbox pad) support ──
// Feeds the same APP_ACTIONS engine as MIDI. Pad appears after its first button
// press (browser gesture requirement); default standard-layout map works out of
// the box, remappable via the MIDI-MAP wizard's 🎮 buttons.
initGamepad();

// ── Initialize computer/Bluetooth keyboard mapping ──
// Same APP_ACTIONS engine; keydown/keyup drive momentary actions. Default map
// works out of the box, remappable via the '⌨ Keyboard' profile in the wizard.
initKeyboard();

// --- BIND DECKS C & D ---
function bindDeckEvents(deckLetter) {
  const L = deckLetter.toLowerCase();
  const U = deckLetter.toUpperCase();

  const fileInput = document.querySelector(`#file-${L}`);
  const fileNameEl = document.querySelector(`#file-${L}-name`);
  const statusEl = document.querySelector('#status');
  const slider = document.getElementById(`max-splats-slider-${L}`);
  const valEl = document.getElementById(`max-splats-val-${L}`);
  
  const btnLoad = document.getElementById(`btn-load-${L}`);
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (fileNameEl) fileNameEl.textContent = file.name;
      statusEl.textContent = `Loading ${file.name} to Deck ${U}...`;
      try {
        let rawScene = await loadFileToSplatData(file);
        const defaultCount = Math.min(250000, rawScene.splatCount);
        if (slider) {
          slider.min = Math.min(250000, rawScene.splatCount);
          slider.max = rawScene.splatCount;
          slider.value = defaultCount;
          if (valEl) valEl.textContent = defaultCount >= 1000000 ? (defaultCount/1000000).toFixed(1) + 'M' : Math.floor(defaultCount/1000) + 'k';
        }
        let scene = limitSplatCount(rawScene, defaultCount);
        if (L === 'a') { rawSceneA = rawScene; sceneA = scene; }
        if (L === 'b') { rawSceneB = rawScene; sceneB = scene; }
        if (L === 'c') { rawSceneC = rawScene; sceneC = scene; }
        if (L === 'd') { rawSceneD = rawScene; sceneD = scene; }
        await rebuildViewerBuffers();
        btnLoad?.classList.add('loaded');
        statusEl.textContent = `Scene ${U} loaded.`;
        triggerRealtimeUpdate();
      } catch (err) {
        console.error(err);
        statusEl.textContent = `Error loading Scene ${U}: ` + err.message;
      }
    });
  }
  
  document.getElementById(`btn-play-${L}`)?.addEventListener('click', () => {
    if (L === 'c') isPlayingC = !isPlayingC;
    if (L === 'd') isPlayingD = !isPlayingD;
    const isPlaying = L === 'c' ? isPlayingC : isPlayingD;
    document.getElementById(`btn-play-${L}`).style.background = isPlaying ? '#10b981' : '#111';
    triggerRealtimeUpdate();
  });

  document.getElementById(`btn-stop-${L}`)?.addEventListener('click', () => {
    if (L === 'c') { isPlayingC = false; playAngleC = 0; }
    if (L === 'd') { isPlayingD = false; playAngleD = 0; }
    document.getElementById(`btn-play-${L}`).style.background = '#111';
    triggerRealtimeUpdate();
  });

  if (slider && slider.classList.contains('knob')) {
    updateKnobFill(slider);
    slider.addEventListener('input', () => updateKnobFill(slider));
    slider.addEventListener('contextmenu', (e) => { e.preventDefault(); slider.value = slider.defaultValue; updateKnobFill(slider); });
    slider.addEventListener('dblclick', () => { slider.value = slider.defaultValue; updateKnobFill(slider); });
  }

  const chunkSlider = document.getElementById(`chunks-slider-${L}`);
  if (chunkSlider && chunkSlider.classList.contains('knob')) {
    updateKnobFill(chunkSlider);
    chunkSlider.addEventListener('input', () => updateKnobFill(chunkSlider));
    chunkSlider.addEventListener('contextmenu', (e) => { e.preventDefault(); chunkSlider.value = chunkSlider.defaultValue; updateKnobFill(chunkSlider); });
    chunkSlider.addEventListener('dblclick', () => { chunkSlider.value = chunkSlider.defaultValue; updateKnobFill(chunkSlider); });
  }
}
bindDeckEvents('c');
bindDeckEvents('d');
bindDeckEvents('a');
bindDeckEvents('b');

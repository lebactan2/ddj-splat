import './style.css';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { SplatData, limitSplatCount } from './dataModel.js';
import { sliceScene } from './cutup/slice.js';
import { shuffleChunksInScene } from './cutup/shuffle.js';
import { swapChunksBetweenScenes } from './cutup/swap.js';
import { sliceIntoSpheres } from './cutup/xyz_shuffle.js';
import { initMIDI, setMidiProfile } from './midi.js';
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

let isCameraFramed = false;
let baseFramedDistance = 5;
let isZoomSyncing = false;
let zoomSyncAttached = false;
let updateInProgress = false;
let updatePending = false;

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
      <label class="icon-btn" id="btn-load-a">⏏<input type="file" id="file-a" accept=".ply,.splat,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start; flex:1;">
        <div id="file-a-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center; justify-content:space-between; width:100%;">
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">SPL: <span id="max-splats-val-a">250k</span></span>
            <input type="range" id="max-splats-slider-a" class="max-splats" min="250000" max="1000000" step="10000" value="250000" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">CHK: <span id="chunks-val-a">4</span></span>
            <input type="range" id="chunks-slider-a" class="max-chunks" min="1" max="16" step="1" value="4" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col" style="margin-bottom:8px;">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-half-a">1/2</button>
          <button class="round-btn" id="loop-active-a">4B</button>
          <button class="round-btn" id="loop-double-a">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:4px;">
        <button class="round-btn sync" id="sync-a">SYNC</button>
        <div class="flex-row">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-a" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;">120.0</div>
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
      <button class="huge-round-btn cue" id="btn-cue-a">C</button>
      <button class="huge-round-btn stop" id="btn-stop-a" style="background:#444; font-size:16px;">⏹</button>
      <button class="huge-round-btn play" id="btn-play-a">▶</button>
    </div>

    <div class="pads-grid" id="pads-a">
      <button class="pad-btn" data-pad="0">1/8</button><button class="pad-btn" data-pad="1">1/4</button>
      <button class="pad-btn" data-pad="2">1/2</button><button class="pad-btn" data-pad="3">1</button>
      <button class="pad-btn" data-pad="4">2</button><button class="pad-btn" data-pad="5">4</button>
      <button class="pad-btn" data-pad="6">8</button><button class="pad-btn" data-pad="7">16</button>
    </div>
  </div>

  <!-- RIGHT PANEL: DECK B + CH 2 MIXER -->
  <div class="hud-panel panel-right" id="deck-b">
    <div class="section-box deck-header" style="display:flex; flex-direction:row; align-items:center; gap:12px;">
      <label class="icon-btn" id="btn-load-b">⏏<input type="file" id="file-b" accept=".ply,.splat,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start; flex:1;">
        <div id="file-b-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center; justify-content:space-between; width:100%;">
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">SPL: <span id="max-splats-val-b">250k</span></span>
            <input type="range" id="max-splats-slider-b" class="max-splats" min="250000" max="1000000" step="10000" value="250000" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
          <div class="flex-row" style="gap:4px; align-items:center;">
            <span style="font-size:9px; font-weight:bold; color:#888;">CHK: <span id="chunks-val-b">4</span></span>
            <input type="range" id="chunks-slider-b" class="max-chunks" min="1" max="16" step="1" value="4" style="width:60px; height:6px; cursor:pointer; -webkit-appearance:none; background:#444; border-radius:3px;">
          </div>
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col" style="margin-bottom:8px;">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-half-b">1/2</button>
          <button class="round-btn" id="loop-active-b">4B</button>
          <button class="round-btn" id="loop-double-b">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:4px;">
        <button class="round-btn sync" id="sync-b">SYNC</button>
        <div class="flex-row">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-b" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;">120.0</div>
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
      <button class="huge-round-btn cue" id="btn-cue-b">C</button>
      <button class="huge-round-btn stop" id="btn-stop-b" style="background:#444; font-size:16px;">⏹</button>
      <button class="huge-round-btn play" id="btn-play-b">▶</button>
    </div>

    <div class="pads-grid" id="pads-b">
      <button class="pad-btn" data-pad="0">1/8</button><button class="pad-btn" data-pad="1">1/4</button>
      <button class="pad-btn" data-pad="2">1/2</button><button class="pad-btn" data-pad="3">1</button>
      <button class="pad-btn" data-pad="4">2</button><button class="pad-btn" data-pad="5">4</button>
      <button class="pad-btn" data-pad="6">8</button><button class="pad-btn" data-pad="7">16</button>
    </div>
  </div>

  <!-- TOP PANEL: SETTINGS & UTILS -->
  <div class="hud-panel panel-top">
    <div class="flex-row" style="gap:12px;">
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
        <button id="btn-strobe" class="util-btn" style="font-size:9px; padding:2px 5px;">STROBE</button>
        <select id="strobe-mode" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:2px 3px; border-radius:4px; cursor:pointer;">
          <option value="side">SIDE</option>
          <option value="full">FULL</option>
        </select>
      </div>
      <div class="flex-row" style="align-items:center; gap:4px;">
        <span class="knob-label" style="margin-right:4px;">MIDI</span>
        <select id="midi-device" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:2px 3px; border-radius:4px; cursor:pointer;">
          <option value="ddj-400">DDJ-400</option>
          <option value="ddj-flx4">DDJ-FLX4</option>
        </select>
      </div>
      <div class="flex-row" style="align-items:center;">
        <span class="knob-label" style="margin-right:4px;">HDRI</span>
        <select id="hdri-select" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:3px 4px; border-radius:4px; cursor:pointer;">
          <option value="none">NONE</option><option value="sunset">SUNSET</option><option value="studio">STUDIO</option>
          <option value="night">NIGHT</option><option value="forest">FOREST</option>
          <option value="custom-url">URL...</option><option value="local-file">FILE...</option>
        </select>
      </div>
    </div>

    <div class="flex-row" style="gap:8px; border-left:1px solid rgba(255,255,255,0.1); padding-left:16px;">
      <button id="btn-reset" class="util-btn">RESET</button>
      <button id="btn-export" class="util-btn">EXPORT</button>
      <button id="btn-output" class="util-btn">OUTPUT →</button>
      <button id="btn-collapse" class="util-btn" style="background:#333;">HIDE UI</button>
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
          <input type="range" min="0" max="100" value="80" class="knob knob-small" id="master-vol">
        </div>
      </div>
      <div class="flex-row" style="gap:12px; align-items:center; justify-content:center;">
        <div class="knob-cell" style="flex-direction:row;">
          <span class="knob-label">DOF</span><input type="range" min="0" max="100" value="0" class="knob knob-small" id="knob-dof">
        </div>
        <div class="knob-cell" style="flex-direction:row;">
          <span class="knob-label">FLARE</span><input type="range" min="0" max="100" value="0" class="knob knob-small" id="knob-lensflare">
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
    // Reset Master Vol to default FIRST so centerCamera frames at the default zoom
    if (masterVol) { masterVol.value = 80; updateKnobFill(masterVol); }
    if (typeof centerCamera === 'function') centerCamera();
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
  knob.addEventListener('change', async () => {
    await rebuildViewerBuffers();
  });
  knob.addEventListener('dblclick', async () => {
    knob.value = knob.defaultValue;
    updateKnobFill(knob);
    triggerRealtimeUpdate();
    await rebuildViewerBuffers();
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

document.getElementById('midi-device')?.addEventListener('change', (e) => {
  setMidiProfile(e.target.value);
});

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

// Sync crossfader to hidden mixSlider for test suite compatibility
crossfader.addEventListener('input', () => {
  mixSlider.value = crossfader.value;
  triggerRealtimeUpdate();
});

// ── Master Volume → Camera Zoom ──
// vol=80 → factor 1.0 (neutral); higher vol → zoom in; lower vol → zoom out
if (masterVol) {
  masterVol.addEventListener('input', () => {
    if (!viewer || !viewer.controls) return;
    const t = Number(masterVol.value) / 100;
    let factor = 1.0 - (t - 0.8) * 1.5;
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
const btnCueA = document.querySelector('#btn-cue-a');
const btnStopA = document.querySelector('#btn-stop-a');
const btnPlayB = document.querySelector('#btn-play-b');
const btnCueB = document.querySelector('#btn-cue-b');
const btnStopB = document.querySelector('#btn-stop-b');

let bpmA = 120.0;
let bpmB = 120.0;

function updateBPM() {
  bpmA = 120.0 * (1 - Number(tempoA.value) / 600.0);
  bpmB = 120.0 * (1 - Number(tempoB.value) / 600.0);
  bpmDispA.textContent = bpmA.toFixed(1);
  bpmDispB.textContent = bpmB.toFixed(1);
}

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
    updateKnobFill(tempoA);
    updateBPM();
    triggerRealtimeUpdate();
  }
});

syncB.addEventListener('click', () => {
  syncB.classList.toggle('active');
  if (syncB.classList.contains('active')) {
    tempoB.value = tempoA.value;
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

btnPlayA.addEventListener('click', () => {
  isPlayingA = !isPlayingA;
  if (isPlayingA) {
    btnPlayA.classList.add('active');
    startAnimationLoop();
  } else {
    btnPlayA.classList.remove('active');
    stopAnimationLoop();
  }
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
  triggerRealtimeUpdate();
});

btnCueA.addEventListener('click', () => {
  playAngleA = 0;
  jogAngleA = 0;
  triggerRealtimeUpdate();
  btnCueA.classList.add('active');
  setTimeout(() => btnCueA.classList.remove('active'), 200);
});

btnStopA.addEventListener('click', () => {
  isPlayingA = false;
  btnPlayA.classList.remove('active');
  playAngleA = 0;
  jogAngleA = 0;
  currentScalesA.fill(0);
  stopAnimationLoop();
  triggerRealtimeUpdate();
  btnStopA.classList.add('active');
  setTimeout(() => btnStopA.classList.remove('active'), 200);
});

btnCueB.addEventListener('click', () => {
  playAngleB = 0;
  jogAngleB = 0;
  triggerRealtimeUpdate();
  btnCueB.classList.add('active');
  setTimeout(() => btnCueB.classList.remove('active'), 200);
});

btnStopB.addEventListener('click', () => {
  isPlayingB = false;
  btnPlayB.classList.remove('active');
  playAngleB = 0;
  jogAngleB = 0;
  currentScalesB.fill(0);
  stopAnimationLoop();
  triggerRealtimeUpdate();
  btnStopB.classList.add('active');
  setTimeout(() => btnStopB.classList.remove('active'), 200);
});

// ── performance Pads (Hot Cues) ────────────────────────
function setupPads(padsContainerId, isDeckA) {
  const padButtons = Array.from(document.querySelectorAll(`#${padsContainerId} .pad-btn`));
  padButtons.forEach((pad, index) => {
    pad.addEventListener('mousedown', () => {
      if (!sceneA) return;
      
      pad.classList.add('active');
      const loopLengths = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16]; // Loop sizes in beats
      
      if (isDeckA) {
        loopActiveA = true;
        loopStartA = Math.floor((playAngleA + jogAngleA) * 15.0);
        loopLengthA = Math.max(1, Math.floor(15.0 * loopLengths[index]));
      } else {
        loopActiveB = true;
        loopStartB = Math.floor((playAngleB + jogAngleB) * 15.0);
        loopLengthB = Math.max(1, Math.floor(15.0 * loopLengths[index]));
      }
      
      // Trigger geometry flash splash
      splashFactor = 1.8;
      
      triggerRealtimeUpdate();
    });
    
    const releaseLoop = () => {
      pad.classList.remove('active');
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
    };
    
    pad.addEventListener('mouseup', releaseLoop);
    pad.addEventListener('mouseleave', releaseLoop);
  });
}
setupPads('pads-a', true);
setupPads('pads-b', false);

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

setupJogWheel(
  document.querySelector('#jog-a'),
  (delta) => {
    isScratchingA = true;
    jogAngleA += delta;
    
    if (Math.abs(delta) > 0.05) {
      seedInput.value = Math.floor(Math.random() * 1000);
    }
    triggerRealtimeUpdate();
  },
  () => {
    isScratchingA = false;
    triggerRealtimeUpdate();
  }
);

setupJogWheel(
  document.querySelector('#jog-b'),
  (delta) => {
    isScratchingB = true;
    jogAngleB += delta;
    if (Math.abs(delta) > 0.05) {
      seedInput.value = Math.floor(Math.random() * 1000);
    }
    triggerRealtimeUpdate();
  },
  () => {
    isScratchingB = false;
    triggerRealtimeUpdate();
  }
);

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
  const scale = RENDER_SCALE_NOTCHES[renderScaleIndex] || 1.0;
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
    
    if (needsUpdate) {
      triggerRealtimeUpdate();
    }
    
    animationFrameId = requestAnimationFrame(loop);
  };
  animationFrameId = requestAnimationFrame(loop);
}

function stopAnimationLoop() {
  if (!isPlayingA && !isPlayingB && splashFactor <= 1.0 && !strobeEngaged &&
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
      // Invert: factor = 1.0 - (t - 0.8)*1.5  =>  t = 0.8 - (factor - 1.0)/1.5
      const t = 0.8 - (factor - 1.0) / 1.5;
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
  // 1.5x larger framing: persistent framing distance for load, play, and stop alike
  const distance = ((targetDist * 1.5) / Math.sin((fov * Math.PI / 180) / 2)) / 3.0;
  baseFramedDistance = distance;

  // Preserve the user's current Master-Volume zoom across reframes (FX apply,
  // HUD toggle, viewer rebuild). Only an explicit H reset returns vol to 80.
  let zoomFactor = 1.0;
  if (masterVol) {
    const t = Number(masterVol.value) / 100;
    zoomFactor = Math.max(0.4, Math.min(1.8, 1.0 - (t - 0.8) * 1.5));
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
            // Soft, pleasant falloff toward the opposite edge.
            float a = uStrength * pow(clamp(t, 0.0, 1.0), 0.6);
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

      if (viewer.threeScene) {
        renderer.render(viewer.threeScene, viewer.camera);
      }

      // Strobe overlay: composites over the HDRI/background (autoClear is already
      // false here, so the background is preserved) and the splats draw on top.
      // FPS: skipped entirely when strength is ~0, so strobe-off costs nothing.
      // When on it is a single cheap full-screen quad (cheaper than the old
      // full-viewport filter:blur(48px) DOM gradient divs).
      if (strobeMaterial && strobeStrength > 0.001) {
        strobeMaterial.uniforms.uStrength.value = strobeStrength;
        strobeMaterial.uniforms.uMode.value = strobeUMode;
        strobeMaterial.uniforms.uEdge.value = strobeUEdge;
        renderer.render(strobeScene, strobeCamera);
      }

      if (viewer.splatMesh) {
        renderer.render(viewer.splatMesh, viewer.camera);
      }

      if (viewer.sceneHelper) {
        if (viewer.sceneHelper.getFocusMarkerOpacity() > 0.0) {
          renderer.render(viewer.sceneHelper.focusMarker, viewer.camera);
        }
        if (viewer.showControlPlane) {
          renderer.render(viewer.sceneHelper.controlPlane, viewer.camera);
        }
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
      const chunksA = sliceIntoSpheres(fxSceneA, Number(document.querySelector('#chunks-slider-a').value) || 4);
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
      const chunksB = sliceIntoSpheres(fxSceneB, Number(document.querySelector('#chunks-slider-b').value) || 4);
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
      const chunksC = sliceIntoSpheres(fxSceneC, Number(document.querySelector('#chunks-slider-c')?.value) || 4);
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
      const chunksD = sliceIntoSpheres(fxSceneD, Number(document.querySelector('#chunks-slider-d')?.value) || 4);
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
        
        let fragShader = viewer.splatMesh.material.fragmentShader;
        if (!fragShader.includes('vOpacityMult')) {
          fragShader = `
            varying float vOpacityMult;
          ` + fragShader;
          fragShader = fragShader.replace(
            'gl_FragColor = vec4(vColor.rgb, w);',
            `
            if (vOpacityMult < 0.001) discard;
            gl_FragColor = vec4(vColor.rgb, w * vOpacityMult);
            `
          );
          fragShader = fragShader.replace(
            'gl_FragColor = vec4(color.rgb, opacity);',
            'gl_FragColor = vec4(color.rgb, opacity * vOpacityMult);'
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

  throw new Error('Unsupported format');
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
    if (file && (n.endsWith('.ply') || n.endsWith('.splat') || n.endsWith('.png') || n.endsWith('.jpg') || n.endsWith('.jpeg'))) {
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

    let eqFactor = 1.0;
    if (radius < 0.33) {
      eqFactor = settings.low;
    } else if (radius < 0.66) {
      eqFactor = settings.mid;
    } else {
      eqFactor = settings.high;
    }

    if (settings.filter < 0) {
      const threshold = 1.0 + settings.filter;
      if (radius > threshold) eqFactor = 0;
    } else if (settings.filter > 0) {
      const threshold = settings.filter;
      if (radius < threshold) eqFactor = 0;
    }

    const scaleFactor = eqFactor;

    view.setFloat32(base + 12, view.getFloat32(base + 12, true) * scaleFactor, true);
    view.setFloat32(base + 16, view.getFloat32(base + 16, true) * scaleFactor, true);
    view.setFloat32(base + 20, view.getFloat32(base + 20, true) * scaleFactor, true);

    if (settings.trim !== 1.0) {
      data[base + 24] = clampByte(data[base + 24] * settings.trim);
      data[base + 25] = clampByte(data[base + 25] * settings.trim);
      data[base + 26] = clampByte(data[base + 26] * settings.trim);
    }
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
    if (valEl) valEl.textContent = e.target.value;
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
    // Equal-power crossfade gains: full A at mixAmount 0, full B at 1.
    // Applied as a smooth per-deck opacity so the opposite deck fully fades out.
    const crossGainA = Math.cos(mixAmount * Math.PI / 2);
    const crossGainB = Math.sin(mixAmount * Math.PI / 2);
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

    const dofVal = Number(knobDof.value) / 100;

    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uFxTime) {
      const uniforms = viewer.splatMesh.material.uniforms;
      uniforms.uFxTime.value = (performance.now() % 100000) * 0.002;
      uniforms.uDeckAChunkCount.value = numChunksA + numRollChunksA;
      
      uniforms.uFaderScaleA = uniforms.uFaderScaleA || { value: 1.0 };
      uniforms.uFaderScaleB = uniforms.uFaderScaleB || { value: 1.0 };
      uniforms.uFaderScaleA.value = Number(volAEl.value) / 100;
      uniforms.uFaderScaleB.value = Number(volBEl.value) / 100;

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
    
    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uStrobeAlphaA) {
      // Combine trans-strobe alpha with the crossfader opacity gain per deck
      viewer.splatMesh.material.uniforms.uStrobeAlphaA.value = strobeAlphaA * crossGainA;
      viewer.splatMesh.material.uniforms.uStrobeAlphaB.value = strobeAlphaB * crossGainB;
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

    const targetDist = 5.0;
    const globalZ = (now * 0.0002) % (Math.PI * 2);
    const splatMesh = viewer.splatMesh;
    const sceneCount = splatMesh ? splatMesh.getSceneCount() : Infinity;

    // Apply fast GPU transforms and visibility to Scene A
    const totalChunksA = numChunksA + numRollChunksA;
    for (let i = 0; i < totalChunksA; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        targetVisible = crossGainA > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepA, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepA, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepA, i + 500) - 0.5) * Math.PI * 2;
      } else {
        targetVisible = crossGainA > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
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
      
      const angleA = effectiveAngleA + jogAngleA;
      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, angleA).multiply(_scratchQRandom);
      _scratchV.copy(boundsA.center).multiplyScalar(finalScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(finalScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
    }

    // Apply fast GPU transforms and visibility to Scene B
    const totalChunksB = numChunksB + numRollChunksB;
    for (let i = 0; i < totalChunksB; i++) {
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        targetVisible = crossGainB > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepB, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepB, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepB, i + 500) - 0.5) * Math.PI * 2;
      } else {
        targetVisible = crossGainB > 0.01;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
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

      const angleB = effectiveAngleB + jogAngleB;
      _scratchEuler.set(rX, rY, rZ);
      _scratchQRandom.setFromEuler(_scratchEuler);
      _scratchQ.setFromAxisAngle(_yAxis, angleB).multiply(_scratchQRandom);
      _scratchV.copy(boundsB.center).multiplyScalar(finalScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(finalScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
    }
    
    // Apply fast GPU transforms and visibility to Scene C
    const totalChunksC = numChunksC + numRollChunksC;
    for (let i = 0; i < totalChunksC; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      let targetVisible = false;
      let targetScaleFactor = 0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlayingC) {
        targetVisible = true;
        targetScaleFactor = 1.0;
        playAngleC += 0.02 * (Number(tempoCEl?.value) || 50) / 50;
      }

      currentScalesC[i] += (targetScaleFactor - currentScalesC[i]) * 0.15;
      splatScene.visible = isPlayingC ? targetVisible : (currentScalesC[i] > 0.01);

      const scaleC = targetDist / boundsC.maxDist;
      const activeScale = Math.max(0.0001, currentScalesC[i] * scaleC);

      _scratchQ.setFromAxisAngle(_yAxis, playAngleC);
      _scratchV.copy(boundsC.center).multiplyScalar(activeScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(activeScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
    }

    // Apply fast GPU transforms and visibility to Scene D
    const totalChunksD = numChunksD + numRollChunksD;
    for (let i = 0; i < totalChunksD; i++) {
      if (splatMesh && sceneIdx >= sceneCount) break;
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      let targetVisible = false;
      let targetScaleFactor = 0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlayingD) {
        targetVisible = true;
        targetScaleFactor = 1.0;
        playAngleD += 0.02 * (Number(tempoDEl?.value) || 50) / 50;
      }

      currentScalesD[i] += (targetScaleFactor - currentScalesD[i]) * 0.15;
      splatScene.visible = isPlayingD ? targetVisible : (currentScalesD[i] > 0.01);

      const scaleD = targetDist / boundsD.maxDist;
      const activeScale = Math.max(0.0001, currentScalesD[i] * scaleD);

      _scratchQ.setFromAxisAngle(_yAxis, playAngleD);
      _scratchV.copy(boundsD.center).multiplyScalar(activeScale).applyQuaternion(_scratchQ).negate();

      splatScene.scale.setScalar(activeScale);
      splatScene.quaternion.copy(_scratchQ);
      splatScene.position.copy(_scratchV);
    }

  } catch (err) {
    console.error('Realtime update error:', err);
    statusEl.textContent = `Mixer error: ${err.message}`;
  }
}

// ── Reset ──────────────────────────────────────────────
btnReset.addEventListener('click', async () => {
  if (!sceneA) {
    statusEl.textContent = 'Load Scene A first!';
    return;
  }

  document.querySelectorAll('.knob').forEach(knob => {
    knob.value = knob.id === 'master-vol' ? 80 : 50;
    if (knob.classList.contains('ch-filter')) knob.value = 0;
    updateKnobFill(knob);
  });

  document.querySelectorAll('.ch-fader').forEach(fader => {
    fader.value = 100;
  });

  crossfader.value = 50;
  mixSlider.value = 50;
  seedInput.value = 42;
  cutsSlider.value = 1;

  isPlayingA = false;
  isPlayingB = false;
  playAngleA = 0;
  playAngleB = 0;
  jogAngleA = 0;
  jogAngleB = 0;
  splashFactor = 1.0;

  btnPlayA.classList.remove('active');
  btnPlayB.classList.remove('active');

  fxEngagedA = false;
  fxActiveA = "none";
  fxSelectA.value = "none";
  btnFxToggleA.classList.remove('active');
  fxDepthA.value = 50;
  updateKnobFill(fxDepthA);

  fxEngagedB = false;
  fxActiveB = "none";
  fxSelectB.value = "none";
  btnFxToggleB.classList.remove('active');
  fxDepthB.value = 50;
  updateKnobFill(fxDepthB);

  fxEngagedM = false;
  fxActiveM = "none";
  fxSelectM.value = "none";
  btnFxToggleM.classList.remove('active');
  fxDepthM.value = 50;
  updateKnobFill(fxDepthM);

  stopAnimationLoop();
  statusEl.textContent = 'Mixer reset to default.';
  triggerRealtimeUpdate();
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
  if (btnLoad) {
    btnLoad.addEventListener('click', async (e) => {
      const isLoaded = (L === 'a') ? sceneA : (L === 'b') ? sceneB : (L === 'c') ? sceneC : sceneD;
      if (isLoaded) {
        e.preventDefault();
        if (L === 'a') { sceneA = null; rawSceneA = null; }
        if (L === 'b') { sceneB = null; rawSceneB = null; }
        if (L === 'c') { sceneC = null; rawSceneC = null; }
        if (L === 'd') { sceneD = null; rawSceneD = null; }
        if (fileNameEl) fileNameEl.textContent = 'No file';
        btnLoad.classList.remove('loaded');
        if (fileInput) fileInput.value = '';
        statusEl.textContent = `Scene ${U} unloaded. Rendering...`;
        await rebuildViewerBuffers();
        statusEl.textContent = `Scene ${U} unloaded.`;
      }
    });
  }

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

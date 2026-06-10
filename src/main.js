import './style.css';
import * as GaussianSplats3D from '@mkkellogg/gaussian-splats-3d';
import { SplatData, limitSplatCount } from './dataModel.js';
import { sliceScene } from './cutup/slice.js';
import { shuffleChunksInScene } from './cutup/shuffle.js';
import { swapChunksBetweenScenes } from './cutup/swap.js';
import { sliceIntoSpheres } from './cutup/xyz_shuffle.js';
import { initMIDI } from './midi.js';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
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
let lensflareLight = null;

let sceneA = null;
let sceneB = null;
let rawSceneA = null;
let rawSceneB = null;
let resultData = null;
let numChunksA = 0;
let numChunksB = 0;
let numRollChunksA = 0;
let numRollChunksB = 0;
let boundsA = { center: new THREE.Vector3(), maxDist: 5 };
let boundsB = { center: new THREE.Vector3(), maxDist: 5 };
let currentScalesA = new Float32Array(32).fill(0);
let currentScalesB = new Float32Array(32).fill(0);

let isCameraFramed = false;
let updateInProgress = false;
let updatePending = false;

// Play Animation state
let isPlayingA = false;
let isPlayingB = false;
let playAngleA = 0;
let playAngleB = 0;
let frozenPlayAngleA = 0;
let frozenPlayAngleB = 0;

let loopActiveA = false;
let loopStartA = 0;
let loopLengthA = 1;
let isAutoLoopA = false;
let autoLoopLengthA = 4; // 4 beats

let loopActiveB = false;
let loopStartB = 0;
let loopLengthB = 1;
let isAutoLoopB = false;
let autoLoopLengthB = 4; // 4 beats
let animationFrameId = null;

// Jog Wheel scratching state
let jogAngleA = 0;
let jogAngleB = 0;
let isScratchingA = false;
let isScratchingB = false;

// Hot Cue presets (seeds)
const hotCuesA = [42, 108, 256, 512, 1024, 2048, 4096, 8192];
const hotCuesB = [77, 128, 320, 640, 1111, 2222, 5555, 9999];

// Splash flash trigger
let splashFactor = 1.0;

// Beat FX state
let fxActiveA = "none";
let fxEngagedA = false;
let beatIndexA = 4;

let fxActiveB = "none";
let fxEngagedB = false;
let beatIndexB = 4;

let fxActiveM = "none";
let fxEngagedM = false;
let beatIndexM = 4;

const beatDivisions = ["1/32", "1/16", "1/8", "1/4", "1/2", "1", "2", "4", "8", "16", "32"];
let lastRollStateA = false;
let lastRollStateB = false;

// ── Inject DDJ-400 UI ──────────────────────────────────
const appDiv = document.querySelector('#app');
appDiv.innerHTML = `
  <div id="strobe-overlay" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:white; pointer-events:none; z-index:999999; opacity:0; mix-blend-mode:difference;"></div>
  <div id="viewer-container"></div>
  <div id="fps-counter" style="position:absolute; top:12px; left:12px; z-index:9999; color:#10b981; font-family:monospace; font-size:16px; font-weight:bold; text-shadow: 1px 1px 2px #000;">0 FPS</div>
  
  <!-- LEFT PANEL: DECK A + CH 1 MIXER -->
  <div class="hud-panel panel-left" id="deck-a">
    <div class="section-box deck-header" style="display:flex; flex-direction:row; align-items:center; gap:12px;">
      <label class="load-btn" style="background:#f97316; margin:0;">LOAD SCENE A<input type="file" id="file-a" accept=".ply,.splat,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start;">
        <div id="file-a-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center;">
          <span style="font-size:10px; font-weight:bold; color:#888;">MAX SPLATS: <span id="max-splats-val-a">250k</span></span>
          <input type="range" id="max-splats-slider-a" min="250000" max="1000000" step="10000" value="250000" style="width:60px;cursor:pointer;">
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-half-a">1/2X</button>
          <button class="round-btn" id="loop-active-a">4 BEAT</button>
          <button class="round-btn" id="loop-double-a">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:8px;">
        <button class="round-btn sync" id="sync-a">BEAT SYNC</button>
        <div class="flex-row">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-a" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;">120.0</div>
        </div>
      </div>
    </div>

    <div class="jog-wheel" id="jog-a" style="margin: 12px auto;">
      <div class="jog-inner"><div class="jog-needle"></div></div>
    </div>

    <!-- MIXER CONTROLS FOR CH 1 -->
    <div class="section-box" style="display:flex; gap:12px;">
      <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <div class="knob-cell"><span class="knob-label">TRIM</span><input type="range" min="0" max="100" value="50" class="knob ch-trim" data-ch="1" id="trim-a"></div>
        <div class="knob-cell"><span class="knob-label">FILTER</span><input type="range" min="-100" max="100" value="0" class="knob ch-filter" data-ch="1" id="filter-a"></div>
        <div class="knob-cell"><span class="knob-label">HI</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-hi" data-ch="1" id="eq-hi-a"></div>
        <div class="knob-cell"><span class="knob-label">MID</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-mid" data-ch="1" id="eq-mid-a"></div>
        <div class="knob-cell" style="grid-column: span 2;"><span class="knob-label">LOW</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-low" data-ch="1" id="eq-low-a"></div>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-items:center;">
        <div class="tempo-wrapper"><input type="range" id="tempo-a" min="-100" max="100" value="0" class="tempo-slider"></div>
        <div class="fader-wrapper"><input type="range" class="ch-fader" id="vol-a" min="0" max="100" value="80"></div>
        <span class="knob-label">CH FADER</span>
      </div>
    </div>

    <div class="flex-between" style="margin-bottom:12px; padding: 0 16px; gap: 8px;">
      <button class="huge-round-btn cue" id="btn-cue-a">CUE</button>
      <button class="huge-round-btn stop" id="btn-stop-a" style="background:#444; width:48px; height:48px; font-size:12px;">STOP</button>
      <button class="huge-round-btn play" id="btn-play-a">PLAY</button>
    </div>

    <div class="pads-grid" id="pads-a">
      <button class="pad-btn" data-pad="0">1</button><button class="pad-btn" data-pad="1">2</button>
      <button class="pad-btn" data-pad="2">3</button><button class="pad-btn" data-pad="3">4</button>
      <button class="pad-btn" data-pad="4">5</button><button class="pad-btn" data-pad="5">6</button>
      <button class="pad-btn" data-pad="6">7</button><button class="pad-btn" data-pad="7">8</button>
    </div>

    <!-- DECK A FX (inline at bottom of deck A) -->
    <div class="section-box" style="margin-top:8px; margin-bottom:0; padding:8px;">
      <span class="section-title" style="color:#f97316; margin-bottom:6px;">DECK A FX</span>
      <div class="flex-row" style="gap:6px; flex-wrap:wrap;">
        <select id="fx-select-a" class="fx-select-dropdown" style="font-size:9px; padding:2px; flex:1; min-width:70px;">
          <option value="none">NONE</option>
          <option value="delay">DELAY</option>
          <option value="echo">ECHO</option>
          <option value="reverb">REVERB</option>
          <option value="filter">FILTER</option>
          <option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option>
          <option value="pitch">PITCH</option>
          <option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option>
          <option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px 4px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-a" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-a" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-a" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <div class="flex-row" style="gap:4px; align-items:center;">
          <span style="font-size:8px;color:#666;">DEPTH</span>
          <input type="range" min="0" max="100" value="50" class="knob" id="fx-depth-a" style="width:32px; height:32px;">
        </div>
        <button id="btn-fx-toggle-a" class="fx-toggle-btn" style="padding:4px 8px; font-size:9px;">ON</button>
      </div>
    </div>
  </div>

  <!-- RIGHT PANEL: DECK B + CH 2 MIXER -->
  <div class="hud-panel panel-right" id="deck-b">
    <div class="section-box deck-header" style="display:flex; flex-direction:row; align-items:center; gap:12px;">
      <label class="load-btn" style="background:#f97316; margin:0;">LOAD SCENE B<input type="file" id="file-b" accept=".ply,.splat,.png,.jpg,.jpeg"></label>
      <div class="flex-col" style="gap:4px; align-items:flex-start;">
        <div id="file-b-name" class="deck-file-name" style="color:#f97316; margin:0;">No file</div>
        <div class="flex-row" style="gap:4px; align-items:center;">
          <span style="font-size:10px; font-weight:bold; color:#888;">MAX SPLATS: <span id="max-splats-val-b">250k</span></span>
          <input type="range" id="max-splats-slider-b" min="250000" max="1000000" step="10000" value="250000" style="width:60px;cursor:pointer;">
        </div>
      </div>
    </div>
    
    <div class="section-box flex-col">
      <div class="flex-between">
        <span class="section-title" style="margin:0;">LOOP</span>
        <div class="flex-row">
          <button class="round-btn" id="loop-half-b">1/2X</button>
          <button class="round-btn" id="loop-active-b">4 BEAT</button>
          <button class="round-btn" id="loop-double-b">2X</button>
        </div>
      </div>
      <div class="flex-between" style="margin-top:8px;">
        <button class="round-btn sync" id="sync-b">BEAT SYNC</button>
        <div class="flex-row">
          <span style="font-size:10px;color:#888;">BPM</span>
          <div class="bpm-display" id="bpm-b" style="font-family:'Share Tech Mono';color:#fff;font-size:14px;background:#000;padding:2px 6px;border-radius:2px;">120.0</div>
        </div>
      </div>
    </div>

    <div class="jog-wheel" id="jog-b" style="margin: 12px auto; border-color:#221100;">
      <div class="jog-inner"><div class="jog-needle" style="background:#f97316;"></div></div>
    </div>

    <!-- MIXER CONTROLS FOR CH 2 -->
    <div class="section-box" style="display:flex; gap:12px;">
      <div style="flex:1; display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <div class="knob-cell"><span class="knob-label">TRIM</span><input type="range" min="0" max="100" value="50" class="knob ch-trim" data-ch="2" id="trim-b"></div>
        <div class="knob-cell"><span class="knob-label">FILTER</span><input type="range" min="-100" max="100" value="0" class="knob ch-filter" data-ch="2" id="filter-b"></div>
        <div class="knob-cell"><span class="knob-label">HI</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-hi" data-ch="2" id="eq-hi-b"></div>
        <div class="knob-cell"><span class="knob-label">MID</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-mid" data-ch="2" id="eq-mid-b"></div>
        <div class="knob-cell" style="grid-column: span 2;"><span class="knob-label">LOW</span><input type="range" min="0" max="100" value="50" class="knob ch-eq-low" data-ch="2" id="eq-low-b"></div>
      </div>
      <div style="display:flex; flex-direction:column; gap:8px; align-items:center;">
        <div class="tempo-wrapper"><input type="range" id="tempo-b" min="-100" max="100" value="0" class="tempo-slider"></div>
        <div class="fader-wrapper"><input type="range" class="ch-fader" id="vol-b" min="0" max="100" value="100"></div>
        <span class="knob-label">CH FADER</span>
      </div>
    </div>

    <div class="flex-between" style="margin-bottom:12px; padding: 0 16px; gap: 8px;">
      <button class="huge-round-btn cue" id="btn-cue-b">CUE</button>
      <button class="huge-round-btn stop" id="btn-stop-b" style="background:#444; width:48px; height:48px; font-size:12px;">STOP</button>
      <button class="huge-round-btn play" id="btn-play-b">PLAY</button>
    </div>

    <div class="pads-grid" id="pads-b">
      <button class="pad-btn" data-pad="0">1</button><button class="pad-btn" data-pad="1">2</button>
      <button class="pad-btn" data-pad="2">3</button><button class="pad-btn" data-pad="3">4</button>
      <button class="pad-btn" data-pad="4">5</button><button class="pad-btn" data-pad="5">6</button>
      <button class="pad-btn" data-pad="6">7</button><button class="pad-btn" data-pad="7">8</button>
    </div>

    <!-- DECK B FX (inline at bottom of deck B) -->
    <div class="section-box" style="margin-top:8px; margin-bottom:0; padding:8px;">
      <span class="section-title" style="color:#f97316; margin-bottom:6px;">DECK B FX</span>
      <div class="flex-row" style="gap:6px; flex-wrap:wrap;">
        <select id="fx-select-b" class="fx-select-dropdown" style="font-size:9px; padding:2px; flex:1; min-width:70px;">
          <option value="none">NONE</option>
          <option value="delay">DELAY</option>
          <option value="echo">ECHO</option>
          <option value="reverb">REVERB</option>
          <option value="filter">FILTER</option>
          <option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option>
          <option value="pitch">PITCH</option>
          <option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option>
          <option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px 4px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-b" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-b" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-b" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <div class="flex-row" style="gap:4px; align-items:center;">
          <span style="font-size:8px;color:#666;">DEPTH</span>
          <input type="range" min="0" max="100" value="50" class="knob" id="fx-depth-b" style="width:32px; height:32px;">
        </div>
        <button id="btn-fx-toggle-b" class="fx-toggle-btn" style="padding:4px 8px; font-size:9px;">ON</button>
      </div>
    </div>
  </div>

  <!-- TOP PANEL: MASTER MIXER -->
  <div class="hud-panel panel-top">
    <div class="master-section">
      <div class="knob-cell" style="flex-direction:row; gap:8px;">
        <span class="knob-label">MASTER</span>
        <input type="range" min="0" max="100" value="80" class="knob" id="master-vol">
      </div>
      <div class="crossfader-container">
        <span class="section-title" style="display:block; text-align:center;">CROSSFADER</span>
        <input type="range" min="0" max="100" value="50" class="crossfader-slider" id="crossfader">
      </div>
      <div class="vu-meters">
        <div class="vu-bar"><div class="vu-active" id="vu-l"></div></div>
        <div class="vu-bar"><div class="vu-active" id="vu-r"></div></div>
      </div>
    </div>
  </div>

  <!-- BOTTOM PANEL: MASTER FX & UTILS -->
  <div class="hud-panel panel-bottom">
    <!-- Settings (Left Column) -->
    <div class="flex-col" style="justify-self: start; gap:6px; align-items: flex-start;">
      <div class="flex-row">
        <span style="font-size:10px; font-weight:bold; color:#888;">UI OPACITY</span>
        <input type="range" id="ui-opacity" min="10" max="100" value="100" style="width:70px;cursor:pointer;">
      </div>
      <label style="font-size:10px; font-weight:bold; color:#888; display:flex; align-items:center; gap:4px; cursor:pointer;">
        <input type="checkbox" id="chk-remove-bg" checked> REMOVE BG (IMAGES)
      </label>
      
      <div class="flex-row" style="gap:16px; align-items: flex-end; margin-top:2px;">
        <div class="flex-col" style="gap:4px;">
          <label style="font-size:10px; font-weight:bold; color:#888; display:flex; align-items:center; gap:4px; cursor:pointer;">
            <input type="checkbox" id="chk-use-colab"> USE COLAB GPU
          </label>
          <input type="text" id="colab-url" placeholder="Paste loca.lt URL here..." style="background:#000; color:#fff; border:1px solid #333; font-size:10px; padding:4px; width:110px; box-sizing:border-box;">
        </div>
        
        <div class="flex-row" style="gap:12px;">
          <div class="knob-cell">
            <span class="knob-label">DOF</span>
            <input type="range" min="0" max="100" value="0" class="knob" id="knob-dof">
          </div>
          <div class="knob-cell">
            <span class="knob-label">FLARE</span>
            <input type="range" min="0" max="100" value="0" class="knob" id="knob-lensflare">
          </div>
          <div class="knob-cell" style="align-items:flex-start;">
            <span class="knob-label" style="margin-bottom:2px;">HDRI</span>
            <select id="hdri-select" style="background:#111; border:1px solid #333; color:#fff; font-size:9px; padding:3px 4px; border-radius:4px; cursor:pointer; width:80px;">
              <option value="none">NONE</option>
              <option value="sunset">SUNSET</option>
              <option value="studio">STUDIO</option>
              <option value="night">NIGHT CITY</option>
              <option value="forest">FOREST</option>
              <option value="custom-url">CUSTOM URL...</option>
              <option value="local-file">UPLOAD FILE...</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- MASTER FX (Middle Column) -->
    <div class="flex-col" style="justify-self: center; align-items:center; gap:4px; padding:4px; border:1px solid rgba(255,255,255,0.05); border-radius:6px; background:rgba(0,0,0,0.15);">
      <span style="font-size:9px; font-weight:bold; color:#f97316;">MASTER FX</span>
      <div class="flex-row" style="gap:6px;">
        <select id="fx-select-m" class="fx-select-dropdown" style="font-size:9px; padding:2px;">
          <option value="none">NONE</option>
          <option value="delay">DELAY</option>
          <option value="echo">ECHO</option>
          <option value="reverb">REVERB</option>
          <option value="filter">FILTER</option>
          <option value="flanger">FLANGER</option>
          <option value="phaser">PHASER</option>
          <option value="pitch">PITCH</option>
          <option value="roll">ROLL</option>
          <option value="spiral">SPIRAL</option>
          <option value="trans">TRANS</option>
        </select>
        <div class="flex-row" style="background:#000; padding:2px; border-radius:4px; border:1px solid #333; gap:4px;">
          <button id="btn-beat-prev-m" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&lt;</button>
          <span id="beat-value-m" style="font-size:9px;color:#fff;font-weight:bold;">1/2</span>
          <button id="btn-beat-next-m" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:9px;padding:0 2px;">&gt;</button>
        </div>
        <input type="range" min="0" max="100" value="50" class="knob" id="fx-depth-m" style="width:32px; height:32px;">
        <button id="btn-fx-toggle-m" class="fx-toggle-btn" style="padding:4px 8px; font-size:9px; border-radius:4px; border-width:1px;">ON</button>
      </div>
    </div>
    
    <!-- UTILS (Right Column) -->
    <div class="util-section" style="justify-self: end; display:flex; flex-direction:column; align-items:flex-end;">
      <div class="flex-row">
        <button id="btn-reset" class="util-btn">RESET</button>
        <button id="btn-export" class="util-btn">EXPORT PLY</button>
        <button id="btn-collapse" class="util-btn" style="background:#333;">HIDE UI</button>
      </div>
      <div id="status">HUD System Ready</div>
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

const fxSelectM = document.querySelector('#fx-select-m');
const fxDepthM = document.querySelector('#fx-depth-m');
const btnFxToggleM = document.querySelector('#btn-fx-toggle-m');
const btnBeatPrevM = document.querySelector('#btn-beat-prev-m');
const btnBeatNextM = document.querySelector('#btn-beat-next-m');
const beatValueMEl = document.querySelector('#beat-value-m');

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
const uiOpacity = document.querySelector('#ui-opacity');
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

if (uiOpacity) {
  uiOpacity.addEventListener('input', () => {
    hudPanels.forEach(panel => {
      panel.style.opacity = uiOpacity.value / 100;
    });
  });
}

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

function resizeViewer() {
  // Viewer-container takes 100% implicitly
  setTimeout(() => {
    if (typeof centerCamera === 'function') centerCamera();
  }, 50);
}
window.addEventListener('resize', resizeViewer);

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'h') {
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
  studio: '/hdri/studio.hdr',
  sunset: '/hdri/sunset.hdr',
  night:  '/hdri/night.hdr',
  forest: '/hdri/forest.hdr',
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

// Sync crossfader to hidden mixSlider for test suite compatibility
crossfader.addEventListener('input', () => {
  mixSlider.value = crossfader.value;
  triggerRealtimeUpdate();
});

// ── Deck A FX Event Listeners ──
btnBeatPrevA.addEventListener('click', () => {
  if (beatIndexA > 0) {
    beatIndexA--;
    beatValueAEl.textContent = beatDivisions[beatIndexA];
    triggerRealtimeUpdate();
  }
});
btnBeatNextA.addEventListener('click', () => {
  if (beatIndexA < beatDivisions.length - 1) {
    beatIndexA++;
    beatValueAEl.textContent = beatDivisions[beatIndexA];
    triggerRealtimeUpdate();
  }
});
btnFxToggleA.addEventListener('click', async () => {
  if (!sceneA) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedA = !fxEngagedA;
  if (fxEngagedA) {
    btnFxToggleA.classList.add('active');
    fxActiveA = fxSelectA.value;
    startAnimationLoop();
  } else {
    btnFxToggleA.classList.remove('active');
    fxActiveA = "none";
    stopAnimationLoop();
  }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectA.addEventListener('change', async () => {
  if (fxEngagedA) {
    fxActiveA = fxSelectA.value;
    await rebuildViewerBuffers();
  }
});
fxDepthA.addEventListener('input', () => { updateKnobFill(fxDepthA); });
fxDepthA.addEventListener('change', async () => { if (fxEngagedA) await rebuildViewerBuffers(); });

// ── Deck B FX Event Listeners ──
btnBeatPrevB.addEventListener('click', () => {
  if (beatIndexB > 0) {
    beatIndexB--;
    beatValueBEl.textContent = beatDivisions[beatIndexB];
    triggerRealtimeUpdate();
  }
});
btnBeatNextB.addEventListener('click', () => {
  if (beatIndexB < beatDivisions.length - 1) {
    beatIndexB++;
    beatValueBEl.textContent = beatDivisions[beatIndexB];
    triggerRealtimeUpdate();
  }
});
btnFxToggleB.addEventListener('click', async () => {
  if (!sceneA) { statusEl.textContent = 'Load a splat scene first!'; return; }
  fxEngagedB = !fxEngagedB;
  if (fxEngagedB) {
    btnFxToggleB.classList.add('active');
    fxActiveB = fxSelectB.value;
    startAnimationLoop();
  } else {
    btnFxToggleB.classList.remove('active');
    fxActiveB = "none";
    stopAnimationLoop();
  }
  await rebuildViewerBuffers();
  statusEl.textContent = 'FX Ready';
});
fxSelectB.addEventListener('change', async () => {
  if (fxEngagedB) {
    fxActiveB = fxSelectB.value;
    await rebuildViewerBuffers();
  }
});
fxDepthB.addEventListener('input', () => { updateKnobFill(fxDepthB); });
fxDepthB.addEventListener('change', async () => { if (fxEngagedB) await rebuildViewerBuffers(); });

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

function startAnimationLoop() {
  if (animationFrameId) return;
  
  lastTime = performance.now();
  
  const loop = (time) => {
    frameCount++;
    if (time - lastFpsTime >= 1000) {
      const fps = Math.round((frameCount * 1000) / (time - lastFpsTime));
      const fpsEl = document.querySelector('#fps-counter');
      if (fpsEl) fpsEl.textContent = `${fps} FPS`;
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
        (fxEngagedM && (fxActiveM === 'flanger' || fxActiveM === 'trans'))) {
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
  if (!isPlayingA && !isPlayingB && splashFactor <= 1.0 && 
      (!fxEngagedA || (fxActiveA !== 'flanger' && fxActiveA !== 'trans')) &&
      (!fxEngagedB || (fxActiveB !== 'flanger' && fxActiveB !== 'trans')) &&
      (!fxEngagedM || (fxActiveM !== 'flanger' && fxActiveM !== 'trans'))) {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    
    document.querySelector('#vu-l').style.height = '0%';
    document.querySelector('#vu-r').style.height = '0%';
  }
}

function updateVuMeters() {
  const vuL = document.querySelector('#vu-l');
  const vuR = document.querySelector('#vu-r');
  
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
    'antialiased': false
  });
  window.viewer = viewer;
  viewer.start();
  isCameraFramed = false;
  return viewer;
}

function centerCamera() {
  if (!viewer) return;
  if (viewer.getSceneCount() === 0) return;
  
  const fov = viewer.camera.fov || 65;
  const targetDist = 5.0;
  const distance = (targetDist * 1.5) / Math.sin((fov * Math.PI / 180) / 2);

  viewer.camera.position.set(0, 0, distance);
  if (viewer.controls && viewer.controls.target) {
    viewer.controls.target.set(0, 0, 0);
    viewer.controls.update();
  } else {
    viewer.camera.lookAt(0, 0, 0);
  }
  
  viewer.camera.near = 0.1;
  viewer.camera.far = distance * 10;
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
  
  const chNum = deckStr === 'deckA' ? 1 : 2;
  const settings = getChSettings(chNum);
  applyMixerSettings(currentScene, settings);
  
  const engagedDeck = deckStr === 'deckA' ? fxEngagedA : fxEngagedB;
  const activeFxDeck = deckStr === 'deckA' ? fxActiveA : fxActiveB;
  const depthDeck = deckStr === 'deckA' ? fxDepthA : fxDepthB;
  
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
    lensflare.addElement(new LensflareElement(hexTex1, 90, 0.5));
    lensflare.addElement(new LensflareElement(hexTex2, 120, 0.75));
    lensflare.addElement(new LensflareElement(hexTex3, 60, 0.9));
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
  
  const renderPass = {
    enabled: true,
    needsSwap: true,
    clear: true,
    setSize: function() {},
    render: function (renderer, writeBuffer, readBuffer) {
      // Render splats + scene into writeBuffer so subsequent passes can read it
      renderer.setRenderTarget(writeBuffer);
      renderer.clear();
      renderer.autoClear = false;

      if (viewer.threeScene) {
        renderer.render(viewer.threeScene, viewer.camera);
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

  bokehPass = new BokehPass(viewer.threeScene, viewer.camera, {
    focus: 4.5,
    aperture: 0.0005,
    maxblur: 0.005,
    width: width,
    height: height
  });

  // Start with DOF disabled - user toggles via checkbox
  const chkDof = document.getElementById('chk-dof');
  bokehPass.enabled = chkDof ? chkDof.checked : false;
  bokehPass.renderToScreen = false;

  if (!bokehPass.setSize) {
    bokehPass.setSize = function() {};
  }

  composer.addPass(bokehPass);

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
    numRollChunksA = 0;
    numRollChunksB = 0;

    if (sceneA) {
      const fxSceneA = processFx(sceneA, 'deckA');
      const chunksA = sliceIntoSpheres(fxSceneA, 16);
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
      const chunksB = sliceIntoSpheres(fxSceneB, 16);
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
          
          // Apply Vertex-based Depth of Field
          float dist = -viewCenter.z;
          float coc = abs(dist - uDofFocus) * uDofAmount;
          float dofScale = 1.0 + coc * 8.0;
          vOpacityMult *= 1.0 / (1.0 + coc * coc * 12.0);
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
            'gl_FragColor = vec4(vColor.rgb, w * vOpacityMult);'
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

// ── File input handlers ────────────────────────────────
fileInputA.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (fileAName) fileAName.textContent = file.name;
  
  if (file.name.toLowerCase().match(/\.(png|jpg|jpeg)$/)) {
    statusEl.textContent = `Converting ${file.name} to 3D Model... This may take ~10 seconds.`;
  } else {
    statusEl.textContent = `Loading ${file.name}...`;
  }

  try {
    rawSceneA = await loadFileToSplatData(file);
    
    // Dynamically update slider range for Deck A
    const sliderA = document.getElementById('max-splats-slider-a');
    if (sliderA) {
      sliderA.min = Math.min(250000, rawSceneA.splatCount);
      sliderA.max = rawSceneA.splatCount;
      sliderA.value = rawSceneA.splatCount;
      const valAEl = document.getElementById('max-splats-val-a');
      if (valAEl) {
        valAEl.textContent = rawSceneA.splatCount >= 1000000 ? (rawSceneA.splatCount/1000000).toFixed(1) + 'M' : Math.floor(rawSceneA.splatCount/1000) + 'k';
      }
    }

    sceneA = limitSplatCount(rawSceneA, rawSceneA.splatCount);
    
    resultData = null;
    isCameraFramed = false;
    
    statusEl.textContent = `Scene A loaded: ${sceneA.splatCount.toLocaleString()} splats. Rendering...`;
    
    await rebuildViewerBuffers();
    statusEl.textContent = `Scene A active: ${sceneA.splatCount.toLocaleString()} splats`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error loading Scene A: ${err.message}`;
  }
});

fileInputB.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  if (fileBName) fileBName.textContent = file.name;

  if (file.name.toLowerCase().match(/\.(png|jpg|jpeg)$/)) {
    statusEl.textContent = `Converting ${file.name} to 3D Model... This may take ~10 seconds.`;
  } else {
    statusEl.textContent = `Loading ${file.name}...`;
  }

  try {
    rawSceneB = await loadFileToSplatData(file);

    // Dynamically update slider range for Deck B
    const sliderB = document.getElementById('max-splats-slider-b');
    if (sliderB) {
      sliderB.min = Math.min(250000, rawSceneB.splatCount);
      sliderB.max = rawSceneB.splatCount;
      sliderB.value = rawSceneB.splatCount;
      const valBEl = document.getElementById('max-splats-val-b');
      if (valBEl) {
        valBEl.textContent = rawSceneB.splatCount >= 1000000 ? (rawSceneB.splatCount/1000000).toFixed(1) + 'M' : Math.floor(rawSceneB.splatCount/1000) + 'k';
      }
    }

    sceneB = limitSplatCount(rawSceneB, rawSceneB.splatCount);

    statusEl.textContent = `Scene B loaded: ${sceneB.splatCount.toLocaleString()} splats. Rendering...`;
    
    await rebuildViewerBuffers();
    statusEl.textContent = `Scene B active: ${sceneB.splatCount.toLocaleString()} splats. Ready to crossfade!`;
    triggerRealtimeUpdate();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error loading Scene B: ${err.message}`;
  }
});

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

document.getElementById('max-splats-slider-a')?.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  document.getElementById('max-splats-val-a').textContent = val >= 1000000 ? (val/1000000).toFixed(1) + 'M' : Math.floor(val/1000) + 'k';
});
document.getElementById('max-splats-slider-b')?.addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  document.getElementById('max-splats-val-b').textContent = val >= 1000000 ? (val/1000000).toFixed(1) + 'M' : Math.floor(val/1000) + 'k';
});

document.getElementById('max-splats-slider-a')?.addEventListener('change', async (e) => {
  if (rawSceneA) {
    sceneA = limitSplatCount(rawSceneA, parseInt(e.target.value));
    await rebuildViewerBuffers();
  }
});
document.getElementById('max-splats-slider-b')?.addEventListener('change', async (e) => {
  if (rawSceneB) {
    sceneB = limitSplatCount(rawSceneB, parseInt(e.target.value));
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
  
  console.time('performRealtimeUpdate');
  try {
    const cuts = parseInt(cutsSlider.value);
    const mixAmount = Number(crossfader.value) / 100;
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

    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uFxTime) {
      const uniforms = viewer.splatMesh.material.uniforms;
      uniforms.uFxTime.value = (performance.now() % 100000) * 0.002;
      uniforms.uDeckAChunkCount.value = numChunksA + numRollChunksA;
      
      uniforms.uFaderScaleA = uniforms.uFaderScaleA || { value: 1.0 };
      uniforms.uFaderScaleB = uniforms.uFaderScaleB || { value: 1.0 };
      uniforms.uFaderScaleA.value = Number(document.querySelector('#vol-a').value) / 100;
      uniforms.uFaderScaleB.value = Number(document.querySelector('#vol-b').value) / 100;
      
      if (uniforms.uDofAmount) {
        uniforms.uDofAmount.value = Number(document.getElementById('knob-dof').value) / 100;
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
    const phase = Date.now() * 0.001 * Math.PI * 2 * transFreq; // Strobe frequency same as beats (no * 2)
    isTransOn = Math.sin(phase) > 0;
    
    if (isTransA) {
      const transAmount = (fxEngagedM && fxActiveM === 'trans') ? amountM : amountA;
      const offAlpha = Math.max(0.0, 1.0 - transAmount);
      strobeAlphaA = isTransOn ? 1.0 : offAlpha;
    }
    
    let strobeAlphaB = 1.0;
    if (isTransB) {
      const transAmount = (fxEngagedM && fxActiveM === 'trans') ? amountM : amountB;
      const offAlpha = Math.max(0.0, 1.0 - transAmount);
      strobeAlphaB = isTransOn ? 1.0 : offAlpha;
    }
    
    if (viewer.splatMesh && viewer.splatMesh.material && viewer.splatMesh.material.uniforms && viewer.splatMesh.material.uniforms.uStrobeAlphaA) {
      viewer.splatMesh.material.uniforms.uStrobeAlphaA.value = strobeAlphaA;
      viewer.splatMesh.material.uniforms.uStrobeAlphaB.value = strobeAlphaB;
    }
    
    // Background sequencer strobe (strips around edges)
    if (!document.getElementById('seq-t')) {
      const seqStyle = "position:absolute; background:white; opacity:0; pointer-events:none; z-index:10; box-shadow:0 0 80px 40px white; transition:opacity 0.05s ease-out; mix-blend-mode:screen;";
      const createBlock = (id, props) => {
        const el = document.createElement('div');
        el.id = id;
        el.style.cssText = seqStyle + props;
        const parent = document.getElementById('viewer-container') || document.body;
        parent.appendChild(el);
      };
      createBlock('seq-t', 'top:0; left:0; width:100vw; height:3vh;');
      createBlock('seq-r', 'top:0; right:0; width:3vh; height:100vh;');
      createBlock('seq-b', 'bottom:0; left:0; width:100vw; height:3vh;');
      createBlock('seq-l', 'top:0; left:0; width:3vh; height:100vh;');
    }

    const anyTransActive = isTransA || isTransB;
    if (anyTransActive) {
      const globalSeqPhase = Math.floor((Date.now() * 0.001 * transFreq)) % 4; // Freq same as beats
      const overallTransAmount = Math.max(
        (fxEngagedA && fxActiveA === 'trans') ? amountA : 0,
        (fxEngagedB && fxActiveB === 'trans') ? amountB : 0,
        (fxEngagedM && fxActiveM === 'trans') ? amountM : 0
      );
      
      const seqBlocks = ['seq-t', 'seq-r', 'seq-b', 'seq-l'];
      seqBlocks.forEach((id, idx) => {
        const el = document.getElementById(id);
        if (el) {
          if (idx === globalSeqPhase && isTransOn) { // Strobe on beat
            el.style.opacity = overallTransAmount * 0.95;
          } else {
            el.style.opacity = 0;
          }
        }
      });
    } else {
      const seqBlocks = ['seq-t', 'seq-r', 'seq-b', 'seq-l'];
      seqBlocks.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.opacity = 0;
      });
    }

    const strobeOverlayEl = document.getElementById('strobe-overlay');
    if (strobeOverlayEl) {
      // strobeOverlayEl.style.opacity = maxStrobeOpacity; // Removed bg strobe as requested
    }

    let sceneIdx = 0;

    const targetDist = 5.0;
    
    // Apply fast GPU transforms and visibility to Scene A
    const totalChunksA = numChunksA + numRollChunksA;
    for (let i = 0; i < totalChunksA; i++) {
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      const globalZ = (Date.now() * 0.0002) % (Math.PI * 2);
      
      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        const rand = pseudoRandom(timeStepA, i + 100);
        targetVisible = rand >= mixAmount;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepA, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepA, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepA, i + 500) - 0.5) * Math.PI * 2;
      } else {
        targetVisible = mixAmount < 1.0;
        targetScaleFactor = 1.0 - mixAmount;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
      }
      
      currentScalesA[i] += (targetScaleFactor - currentScalesA[i]) * 0.15;
      splatScene.visible = isPlaying ? targetVisible : (currentScalesA[i] > 0.01);
      
      const scaleA = targetDist / boundsA.maxDist;
      const activeScale = Math.max(0.0001, currentScalesA[i] * scaleA * beatScaleMult);
      
      let finalScale = activeScale;

      let effectiveAngleA = playAngleA;
      if (isRollA && i >= numChunksA) {
         effectiveAngleA = frozenPlayAngleA - (i - numChunksA) * 0.15;
         finalScale = 1.0; // frozen scale
      }
      
      const angleA = effectiveAngleA + jogAngleA;
      const qRandomA = new THREE.Quaternion().setFromEuler(new THREE.Euler(rX, rY, rZ));
      const qA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angleA).multiply(qRandomA);
      const posA = boundsA.center.clone().multiplyScalar(finalScale).applyQuaternion(qA).negate();

      splatScene.scale.setScalar(finalScale);
      splatScene.quaternion.copy(qA);
      splatScene.position.copy(posA);
    }

    // Apply fast GPU transforms and visibility to Scene B
    const totalChunksB = numChunksB + numRollChunksB;
    for (let i = 0; i < totalChunksB; i++) {
      const splatScene = viewer.getSplatScene(sceneIdx++);
      if (!splatScene) continue;

      const globalZ = (Date.now() * 0.0002) % (Math.PI * 2);
      
      let targetVisible = false;
      let targetScaleFactor = 0;
      let beatScaleMult = 1.0;
      let rX = 0, rY = 0, rZ = globalZ;
      
      if (isPlaying) {
        const rand = pseudoRandom(timeStepB, i + 100);
        targetVisible = rand < mixAmount;
        targetScaleFactor = 1.0;
        beatScaleMult = 1.0; // Play scaling disabled as requested
        rX = (pseudoRandom(timeStepB, i + 300) - 0.5) * Math.PI * 2;
        rY = (pseudoRandom(timeStepB, i + 400) - 0.5) * Math.PI * 2;
        rZ = (pseudoRandom(timeStepB, i + 500) - 0.5) * Math.PI * 2;
      } else {
        targetVisible = mixAmount > 0.0;
        targetScaleFactor = mixAmount;
        beatScaleMult = 1.0;
        rX = 0; rY = 0; rZ = 0;
      }
      
      currentScalesB[i] += (targetScaleFactor - currentScalesB[i]) * 0.15;
      splatScene.visible = isPlaying ? targetVisible : (currentScalesB[i] > 0.01);
      
      const scaleB = targetDist / boundsB.maxDist;
      const activeScale = Math.max(0.0001, currentScalesB[i] * scaleB * beatScaleMult);
      
      let finalScale = activeScale;

      let effectiveAngleB = playAngleB;
      if (isRollB && i >= numChunksB) {
         effectiveAngleB = frozenPlayAngleB - (i - numChunksB) * 0.15;
         finalScale = 1.0; // frozen scale
      }

      const angleB = effectiveAngleB + jogAngleB;
      const qRandomB = new THREE.Quaternion().setFromEuler(new THREE.Euler(rX, rY, rZ));
      const qB = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angleB).multiply(qRandomB);
      const posB = boundsB.center.clone().multiplyScalar(finalScale).applyQuaternion(qB).negate();

      splatScene.scale.setScalar(finalScale);
      splatScene.quaternion.copy(qB);
      splatScene.position.copy(posB);
    }

  } catch (err) {
    console.error('Realtime update error:', err);
    statusEl.textContent = `Mixer error: ${err.message}`;
  } finally {
    console.timeEnd('performRealtimeUpdate');
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

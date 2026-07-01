// ─────────────────────────────────────────────────────────────────────────────
// gamepad.js  –  HID gamepad (PlayStation / Xbox pad) support for VVJ Splat
//
// PlayStation / Xbox pads enumerate as "HID game controller" on Windows, NOT as
// MIDI, so midi.js never sees them. This module bridges the browser Gamepad API
// into the SAME action layer midi.js uses (APP_ACTIONS + runAction), so a pad
// drives the exact same app controls a DDJ does — no downstream changes.
//
// Design:
//   • A requestAnimationFrame poll loop diffs button/axis state each frame.
//   • Each physical control is identified by a stable numeric CODE:
//       buttons → code = button index          (0..99)
//       axes    → code = 100 + axis index       (100..199)
//   • Bindings map "<gamepadIndex>:<code>" → actionId. They live in their OWN
//     localStorage key (independent of the MIDI profile) so the pad keeps working
//     when you switch DDJ profiles, and vice-versa.
//   • If no user binding exists for a control, a built-in DEFAULT_MAP (standard
//     gamepad layout) is used, so a freshly-plugged pad is useful immediately.
//   • The action's KIND (from APP_ACTIONS) decides note-vs-continuous dispatch:
//       slider/jog/selectScrub/strobe3 → continuous  (analog value → 0-127)
//       everything else (button/pad/…)  → note        (press = 127, release = 0)
// ─────────────────────────────────────────────────────────────────────────────

import { APP_ACTIONS, runAction } from './midi.js';

// ── Tuning ────────────────────────────────────────────────────────────────────
const AXIS_DEADZONE   = 0.12; // ignore stick wobble near center (|v| below this = 0)
const AXIS_EPS        = 0.01; // min change to re-dispatch a continuous axis
const TRIGGER_EPS     = 0.01; // min change to re-dispatch an analog trigger
const BTN_THRESHOLD   = 0.5;  // analog button (trigger) counted "pressed" above this
const LEARN_AXIS_TRIG = 0.6;  // axis must move this far from rest to arm during learn

// Codes: axes are offset so they never collide with button indices.
const AXIS_CODE_BASE = 100;
const isAxisCode = (code) => code >= AXIS_CODE_BASE;
const axisIndex  = (code) => code - AXIS_CODE_BASE;

// ── Default standard-layout mapping ─────────────────────────────────────────────
// Applies when gamepad.mapping === 'standard' (Chrome/Edge map most PS/Xbox pads
// to this). Codes follow the W3C Standard Gamepad. Overridden per-control by any
// user binding. Users can remap everything via the MIDI-MAP wizard's 🎮 button.
//
// Buttons: 0=✕/A 1=○/B 2=▢/X 3=△/Y 4=L1 5=R1 6=L2 7=R2 8=Share 9=Options
//          10=L3 11=R3 12=D↑ 13=D↓ 14=D← 15=D→ 16=PS
// Axes:    0=L-stick X  1=L-stick Y  2=R-stick X  3=R-stick Y
const DEFAULT_MAP = {
  0:  'play-a',        // ✕      → Deck A play/pause
  1:  'play-b',        // ○      → Deck B play/pause
  2:  'cue-a',         // ▢      → Deck A cue/stop
  3:  'cue-b',         // △      → Deck B cue/stop
  4:  'loop-active-a', // L1     → Deck A 4-beat loop
  5:  'loop-active-b', // R1     → Deck B 4-beat loop
  6:  'filter-a',      // L2     → Deck A filter (analog trigger)
  7:  'filter-b',      // R2     → Deck B filter (analog trigger)
  9:  'reset-view',    // Options→ reset view
  10: 'strobe',        // L3     → strobe toggle
  12: 'beat-next-a',   // D↑     → Deck A beat ›
  13: 'beat-prev-a',   // D↓     → Deck A beat ‹
  14: 'beat-prev-b',   // D←     → Deck B beat ‹
  15: 'beat-next-b',   // D→     → Deck B beat ›
  [AXIS_CODE_BASE + 0]: 'crossfader',  // L-stick X → crossfader
  [AXIS_CODE_BASE + 1]: 'vol-a',       // L-stick Y → Deck A volume
  [AXIS_CODE_BASE + 2]: 'master-vol',  // R-stick X → master vol → zoom
  [AXIS_CODE_BASE + 3]: 'vol-b',       // R-stick Y → Deck B volume
};

// ── Binding store (localStorage) ────────────────────────────────────────────────
const STORE_KEY = 'vvj-gamepad-map';

// In-memory table: { "<gpIndex>:<code>": actionId }. Loaded on init.
let _bindings = {};

function _load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    _bindings = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('[GP] Failed to load gamepad bindings:', e);
    _bindings = {};
  }
  return _bindings;
}

function _persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(_bindings));
  } catch (e) {
    console.warn('[GP] Failed to persist gamepad bindings:', e);
  }
}

/** Resolve a control (gpIndex, code) to an actionId: user binding first, else default. */
function _resolve(gpIndex, code) {
  const userId = _bindings[`${gpIndex}:${code}`];
  if (userId) return userId;
  // Defaults are keyed by code alone (apply to any standard pad).
  return DEFAULT_MAP[code] || null;
}

/** Is an action continuous (fader/knob) rather than a momentary button? */
function _isContinuous(actionId) {
  const a = APP_ACTIONS[actionId];
  if (!a) return false;
  return a.kind === 'slider' || a.kind === 'jog' || a.kind === 'selectScrub' || a.kind === 'strobe3';
}

// ── Public binding API (used by the MIDI-MAP wizard) ─────────────────────────────

/**
 * Human-readable label for an action's gamepad binding, or null if unbound.
 * Shows "(default)" when only the built-in default applies.
 */
export function getGamepadBindingLabel(actionId) {
  for (const k in _bindings) {
    if (_bindings[k] === actionId) {
      const [gp, code] = k.split(':').map(Number);
      return `🎮${gp} ${_codeLabel(code)}`;
    }
  }
  // fall back to default map
  for (const code in DEFAULT_MAP) {
    if (DEFAULT_MAP[code] === actionId) return `🎮 ${_codeLabel(Number(code))} (default)`;
  }
  return null;
}

function _codeLabel(code) {
  return isAxisCode(code) ? `Axis ${axisIndex(code)}` : `Btn ${code}`;
}

/** Bind a control (from a learn message) to an action, replacing any prior binding. */
export function setGamepadBinding(actionId, msg) {
  const key = `${msg.gpIndex}:${msg.code}`;
  // one action ← one control: drop any other control currently bound to it
  for (const k in _bindings) if (_bindings[k] === actionId) delete _bindings[k];
  _bindings[key] = actionId;
  _persist();
  console.log(`[GP] Bound ${actionId} → ${key}`);
}

/** Remove any gamepad binding for an action (reverts to default map, if any). */
export function clearGamepadBinding(actionId) {
  let changed = false;
  for (const k in _bindings) if (_bindings[k] === actionId) { delete _bindings[k]; changed = true; }
  if (changed) _persist();
}

/** Export current user bindings (for the unified mapping bundle, Phase 4). */
export function getGamepadBindings() { return { ..._bindings }; }
/** Replace all user bindings (from an imported bundle). */
export function setGamepadBindings(table) {
  _bindings = (table && typeof table === 'object') ? { ...table } : {};
  _persist();
}

// ── Learn mode ──────────────────────────────────────────────────────────────────
// When active, a deliberate control activation (button press, or axis moved past
// LEARN_AXIS_TRIG) is forwarded ONCE to sinkFn as {gpIndex, code, value, kind}.
// The poll loop calls _learnProbe(); the wizard supplies the sink.

let _learnEnabled = false;
let _learnSink = null;
let _learnArmedAxes = {}; // gate so a held stick fires the sink only once per push

export function setGamepadLearn(enabled, sinkFn) {
  _learnEnabled = enabled;
  _learnSink = enabled ? (sinkFn || null) : null;
  _learnArmedAxes = {};
}

// ── Poll loop ─────────────────────────────────────────────────────────────────
// Per-gamepad previous state so we can edge-detect buttons and de-jitter axes.
const _prev = {}; // gpIndex → { buttons: number[], axes: number[] }

function _pollGamepad(gp) {
  const gi = gp.index;
  const prev = _prev[gi] || (_prev[gi] = { buttons: [], axes: [] });

  // ── Buttons (includes analog triggers via .value) ──
  for (let b = 0; b < gp.buttons.length; b++) {
    const btn = gp.buttons[b];
    const val = btn.value; // 0..1 (1 for plain digital buttons)
    const wasPressed = (prev.buttons[b] ?? 0) >= BTN_THRESHOLD;
    const isPressed  = val >= BTN_THRESHOLD;

    const actionId = _resolve(gi, b);
    if (actionId) {
      if (_isContinuous(actionId)) {
        // Analog trigger driving a fader/knob: dispatch on meaningful change.
        if (Math.abs(val - (prev.buttons[b] ?? 0)) >= TRIGGER_EPS) {
          runAction(actionId, Math.round(val * 127), false);
        }
      } else if (isPressed !== wasPressed) {
        // Momentary: send press (127) / release (0) edges only.
        runAction(actionId, isPressed ? 127 : 0, true);
      }
    }

    // Learn: fire once on the press edge.
    if (_learnEnabled && _learnSink && isPressed && !wasPressed) {
      _learnSink({ gpIndex: gi, code: b, value: 127, kind: 'button' });
    }
    prev.buttons[b] = val;
  }

  // ── Axes (sticks) ──
  for (let a = 0; a < gp.axes.length; a++) {
    let raw = gp.axes[a];
    // Deadzone around center so a resting stick doesn't stream values.
    const dz = Math.abs(raw) < AXIS_DEADZONE ? 0 : raw;
    const code = AXIS_CODE_BASE + a;
    const actionId = _resolve(gi, code);

    if (actionId && (Math.abs(dz - (prev.axes[a] ?? 0)) >= AXIS_EPS)) {
      if (_isContinuous(actionId)) {
        // Map -1..1 → 0..127 (center = ~63).
        runAction(actionId, Math.round(((dz + 1) / 2) * 127), false);
      } else if (Math.abs(dz) >= BTN_THRESHOLD && Math.abs(prev.axes[a] ?? 0) < BTN_THRESHOLD) {
        // Axis bound to a momentary action → treat a hard push as a press.
        runAction(actionId, 127, true);
      }
    }

    // Learn: arm on a big push, fire once, re-arm after the stick returns near center.
    if (_learnEnabled && _learnSink) {
      if (Math.abs(raw) >= LEARN_AXIS_TRIG && !_learnArmedAxes[`${gi}:${a}`]) {
        _learnArmedAxes[`${gi}:${a}`] = true;
        _learnSink({ gpIndex: gi, code, value: Math.round(((dz + 1) / 2) * 127), kind: 'axis' });
      } else if (Math.abs(raw) < AXIS_DEADZONE) {
        _learnArmedAxes[`${gi}:${a}`] = false;
      }
    }
    prev.axes[a] = dz;
  }
}

let _rafId = 0;
function _loop() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const gp of pads) if (gp && gp.connected) _pollGamepad(gp);
  _rafId = requestAnimationFrame(_loop);
}

// ── Init ────────────────────────────────────────────────────────────────────────

let _started = false;

/**
 * Start gamepad support. Safe to call once at boot. The Gamepad API only exposes
 * a pad AFTER the user presses a button on it (browser gesture requirement), so
 * we log on connect and the poll loop picks it up automatically thereafter.
 */
export function initGamepad() {
  if (_started) return;
  if (!('getGamepads' in navigator)) {
    console.warn('[GP] Gamepad API not supported in this browser.');
    return;
  }
  _started = true;
  _load();

  window.addEventListener('gamepadconnected', (e) => {
    const gp = e.gamepad;
    console.log(`[GP] Connected: "${gp.id}" (index ${gp.index}, mapping "${gp.mapping || 'non-standard'}", ${gp.buttons.length} buttons / ${gp.axes.length} axes)`);
    if (gp.mapping !== 'standard') {
      console.warn('[GP] Pad is NOT in "standard" mapping — default map may be wrong; remap via the MIDI-MAP wizard 🎮 buttons.');
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gamepad-status', { detail: { connected: true, id: gp.id, index: gp.index } }));
    }
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    console.log(`[GP] Disconnected: index ${e.gamepad.index}`);
    delete _prev[e.gamepad.index];
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('gamepad-status', { detail: { connected: false, index: e.gamepad.index } }));
    }
  });

  _loop();
  console.log('[GP] Gamepad support started — press any button on the pad to activate it.');
}

/** Stop the poll loop (rarely needed; here for completeness/tests). */
export function stopGamepad() {
  if (_rafId) cancelAnimationFrame(_rafId);
  _rafId = 0;
  _started = false;
}

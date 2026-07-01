// ─────────────────────────────────────────────────────────────────────────────
// keyboard.js  –  Computer/Bluetooth keyboard mapping for VVJ Splat
//
// A Bluetooth (or wired) keyboard is just a keyboard to the browser — plain
// keydown/keyup events. This module maps physical keys to the SAME action layer
// midi.js and gamepad.js use (APP_ACTIONS + runAction), so keys drive the exact
// same app controls a DDJ or gamepad does.
//
// Design (mirrors gamepad.js):
//   • Keys are identified by KeyboardEvent.code (physical, layout-independent:
//     'KeyA', 'Digit1', 'Space', 'ArrowLeft', …) so mappings survive keyboard
//     layout / language changes.
//   • Bindings map "<code>" → actionId, in their OWN localStorage key,
//     independent of the MIDI profile and gamepad map. All three inputs coexist.
//   • No user binding → a built-in DEFAULT_MAP is used, so it works immediately.
//   • Keys are momentary: keydown → press (127), keyup → release (0). Continuous
//     actions (faders) aren't meaningful from a key, so everything dispatches as
//     a note press/release.
//   • Dispatch is SUPPRESSED while typing in a field (input/textarea/select/
//     contenteditable — e.g. the editable BPM display) so mapping never eats
//     real text entry.
// ─────────────────────────────────────────────────────────────────────────────

import { APP_ACTIONS, runAction } from './midi.js';

// ── Default mapping ─────────────────────────────────────────────────────────────
// Keyed by KeyboardEvent.code. Avoids 'KeyF' (fullscreen) and 'KeyH' (reset),
// which main.js already uses as global shortcuts. Fully remappable in the wizard.
const DEFAULT_MAP = {
  // Transport
  KeyQ: 'play-a',  KeyW: 'cue-a',
  KeyO: 'play-b',  KeyP: 'cue-b',
  KeyR: 'reset-view',
  // Loops
  KeyA: 'loop-active-a', KeyL: 'loop-active-b',
  // Beat ‹ / › (arrows)
  ArrowLeft: 'beat-prev-a', ArrowRight: 'beat-next-a',
  ArrowDown: 'beat-prev-b', ArrowUp: 'beat-next-b',
  // Strobe
  KeyS: 'strobe',
  // Pads A → number row 1-8
  Digit1: 'pad-a-1', Digit2: 'pad-a-2', Digit3: 'pad-a-3', Digit4: 'pad-a-4',
  Digit5: 'pad-a-5', Digit6: 'pad-a-6', Digit7: 'pad-a-7', Digit8: 'pad-a-8',
  // Pads B → bottom letter row
  KeyZ: 'pad-b-1', KeyX: 'pad-b-2', KeyC: 'pad-b-3', KeyV: 'pad-b-4',
  KeyB: 'pad-b-5', KeyN: 'pad-b-6', KeyM: 'pad-b-7', Comma: 'pad-b-8',
};

// ── Binding store (localStorage) ────────────────────────────────────────────────
const STORE_KEY = 'vvj-keyboard-map';
let _bindings = {}; // { "<code>": actionId }

function _load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    _bindings = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('[KB] Failed to load keyboard bindings:', e);
    _bindings = {};
  }
  return _bindings;
}

function _persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(_bindings));
  } catch (e) {
    console.warn('[KB] Failed to persist keyboard bindings:', e);
  }
}

/** Resolve a key code to an actionId: user binding first, else default. */
function _resolve(code) {
  return _bindings[code] || DEFAULT_MAP[code] || null;
}

// ── Public binding API (used by the MIDI-MAP wizard) ─────────────────────────────

/** Friendly label for a key code, e.g. 'A', '1', 'Space', '←'. */
export function keyLabel(code) {
  const SYM = {
    Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
    Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`',
    Enter: '⏎', Backspace: '⌫', Tab: '⇥', Escape: 'Esc',
  };
  if (SYM[code]) return SYM[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  return code;
}

/** Label for an action's keyboard binding, or null if unbound. */
export function getKeyboardBindingLabel(actionId) {
  for (const code in _bindings) {
    if (_bindings[code] === actionId) return `⌨ ${keyLabel(code)}`;
  }
  for (const code in DEFAULT_MAP) {
    if (DEFAULT_MAP[code] === actionId) return `⌨ ${keyLabel(code)} (default)`;
  }
  return null;
}

/** Bind a key (from a learn message) to an action, replacing any prior binding. */
export function setKeyboardBinding(actionId, msg) {
  for (const c in _bindings) if (_bindings[c] === actionId) delete _bindings[c];
  _bindings[msg.code] = actionId;
  _persist();
  console.log(`[KB] Bound ${actionId} → ${msg.code}`);
}

/** Remove any keyboard binding for an action (reverts to default map, if any). */
export function clearKeyboardBinding(actionId) {
  let changed = false;
  for (const c in _bindings) if (_bindings[c] === actionId) { delete _bindings[c]; changed = true; }
  if (changed) _persist();
}

/** Export current user bindings (for the unified mapping bundle, Phase 4). */
export function getKeyboardBindings() { return { ..._bindings }; }
/** Replace all user bindings (from an imported bundle). */
export function setKeyboardBindings(table) {
  _bindings = (table && typeof table === 'object') ? { ...table } : {};
  _persist();
}

// ── Learn mode ──────────────────────────────────────────────────────────────────
let _learnEnabled = false;
let _learnSink = null;

export function setKeyboardLearn(enabled, sinkFn) {
  _learnEnabled = enabled;
  _learnSink = enabled ? (sinkFn || null) : null;
}

// ── Event wiring ─────────────────────────────────────────────────────────────────

// True when the user is typing into a field — suppress action dispatch then.
function _typingInField(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

// Track keys currently held so keyup releases the right action even if the
// binding changed mid-hold, and so we ignore auto-repeat.
const _down = {}; // code → actionId dispatched on press

function _onKeyDown(e) {
  // Learn: bind the next key press. Ignore lone modifier keys.
  if (_learnEnabled && _learnSink) {
    if (['ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','MetaLeft','MetaRight'].includes(e.code)) return;
    e.preventDefault();
    _learnSink({ code: e.code, value: 127 });
    return;
  }

  if (e.repeat) return;                 // auto-repeat while held → one press only
  if (_typingInField(e)) return;        // don't hijack real typing
  const actionId = _resolve(e.code);
  if (!actionId) return;
  e.preventDefault();                   // bound key: stop page scroll / default
  _down[e.code] = actionId;
  runAction(actionId, 127, true);       // press
}

function _onKeyUp(e) {
  const actionId = _down[e.code];
  if (!actionId) return;
  delete _down[e.code];
  runAction(actionId, 0, true);         // release
}

// ── Init ────────────────────────────────────────────────────────────────────────
let _started = false;

/** Start keyboard support. Safe to call once at boot. */
export function initKeyboard() {
  if (_started) return;
  _started = true;
  _load();
  window.addEventListener('keydown', _onKeyDown);
  window.addEventListener('keyup', _onKeyUp);
  console.log('[KB] Keyboard mapping active.');
}

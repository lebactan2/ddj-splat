// ─────────────────────────────────────────────────────────────────────────────
// midi.js  –  Multi-controller MIDI support
//
// Supported profiles:
//   'ddj-400'  — Pioneer DDJ-400
//   'ddj-flx4' — Pioneer DDJ-FLX4
//   'idj'      — ICON iDJ
//
// MIDI numbers sourced from:
//   DDJ-400 : mixxxdj/mixxx Pioneer-DDJ-400.midi.xml (derived from official
//             Pioneer DDJ-400 MIDI Message List E1, pioneerdj.com)
//   DDJ-FLX4: mixxxdj/mixxx Pioneer-DDJ-FLX4.midi.xml (derived from official
//             Pioneer DDJ-FLX4 MIDI Message List E1, pioneerdj.com)
//   iDJ     : ICON's stock VirtualDJ device.xml (iconproaudio.com/product/idj/),
//             verified against the physical unit (VID_1D03/PID_0027).
//
// Channel → Deck convention (same on both controllers):
//   ch 0 = Deck A, ch 1 = Deck B
//   ch 6 = Mixer (crossfader, filter)
//   ch 4 = Beat FX section
// ─────────────────────────────────────────────────────────────────────────────

// ── MIDI-Learn state ─────────────────────────────────────────────────────────

let midiLearnEnabled = false;
let midiLearnSink = null;

/**
 * Enable or disable MIDI-Learn mode.
 * When enabled, every incoming MIDI message is forwarded to sinkFn in addition
 * to (not instead of) normal profile handling, so live mapping still works.
 *
 * @param {boolean} enabled
 * @param {function|null} sinkFn  Called with {channel, type:'note'|'cc', data1, value}
 */
export function setMidiLearn(enabled, sinkFn) {
  midiLearnEnabled = enabled;
  midiLearnSink = enabled ? (sinkFn || null) : null;
  console.log(`[MIDI] MIDI-Learn ${enabled ? 'ON' : 'OFF'}`);
}

// ── Debounce map for mapSlider ────────────────────────────────────────────────
// Keyed by elementId. Each entry is a timer id for the pending 'change' dispatch.
const _changeTimers = {};
const CHANGE_DEBOUNCE_MS = 200;

// ── Jitter suppression for mapSlider ──────────────────────────────────────────
// Pioneer/Korg faders & knobs emit ADC noise (the value flickers ±1-2 at rest
// and can jump). We smooth the raw 0-127 value and apply a small deadzone so the
// visuals stop jittering without adding noticeable lag to deliberate moves.
const _smoothVal = {};    // per-element smoothed 0-127 value
const _lastApplied = {};  // per-element last value actually written
const _stepIndex = {};    // per-element last applied integer index (discrete sliders)
const SMOOTH_ALPHA = 0.35; // 0..1 — higher = more responsive, lower = smoother
const DEADZONE = 2.5;      // ignore changes smaller than this (in 0-127 units) —
                           // suppresses controller ADC rest-jitter (DDJ faders/knobs)
                           // so it can't flicker visuals or re-trigger buffer rebuilds.

// ── Helper functions ──────────────────────────────────────────────────────────

/**
 * Map a 0-127 MIDI value to a specific HTML input slider range.
 *
 * Sensitivity fix: dispatches 'input' immediately (cheap) and debounces
 * 'change' to ~200ms after the last movement so heavy rebuilds (e.g.
 * rebuildViewerBuffers) fire once when the user stops moving, not on every tick.
 */
function mapSlider(elementId, midiValue) {
  const el = document.getElementById(elementId);
  if (!el) return;

  // Smooth the raw value (exponential) to kill ADC jitter.
  const prev = _smoothVal[elementId];
  const sm = (prev === undefined) ? midiValue : prev + (midiValue - prev) * SMOOTH_ALPHA;
  _smoothVal[elementId] = sm;
  // Deadzone: ignore sub-threshold wiggle so the visuals don't flicker at rest.
  const last = _lastApplied[elementId];
  if (last !== undefined && Math.abs(sm - last) < DEADZONE) return;
  _lastApplied[elementId] = sm;

  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  const step = parseFloat(el.step) || 0;
  const norm = sm / 127.0;

  // Discrete sliders (small integer range, e.g. TRIM → chunk count 0..2) trigger a
  // heavy rebuild on every 'change'. ADC jitter near a step boundary would flip the
  // index back and forth and thrash rebuilds. Quantize with hysteresis: only move
  // to the next index once the smoothed value passes 0.6 of a step beyond current.
  const range = max - min;
  if (step === 1 && range > 0 && range <= 8) {
    const idxFloat = (norm * range);
    const cur = _stepIndex[elementId];
    let target = Math.round(idxFloat);
    if (cur !== undefined && Math.abs(idxFloat - cur) < 0.6) target = cur; // deadband
    target = Math.max(0, Math.min(range, target));
    if (cur === target) return;        // no index change → no rebuild
    _stepIndex[elementId] = target;
    el.value = min + target;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (_changeTimers[elementId]) clearTimeout(_changeTimers[elementId]);
    _changeTimers[elementId] = setTimeout(() => {
      delete _changeTimers[elementId];
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, CHANGE_DEBOUNCE_MS);
    return;
  }

  // normalized value 0.0 - 1.0
  el.value = min + norm * range;

  // Fire 'input' immediately — updates visuals and lightweight logic.
  el.dispatchEvent(new Event('input', { bubbles: true }));

  // Debounce 'change' — heavy rebuilds (viewer buffer, HDRI, etc.) fire only
  // once the user stops moving the physical control.
  if (_changeTimers[elementId]) clearTimeout(_changeTimers[elementId]);
  _changeTimers[elementId] = setTimeout(() => {
    delete _changeTimers[elementId];
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, CHANGE_DEBOUNCE_MS);
}

/**
 * Cycle a <select> element to the next option (wrapping around).
 * Dispatches a 'change' event so the app reacts.
 */
function cycleSelect(elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const n = el.options.length;
  if (n === 0) return;
  el.selectedIndex = (el.selectedIndex + 1) % n;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Map a 0-127 MIDI value to the closest option index of a <select> element
 * and dispatch 'change'.  Used for Mic Level knob → HDRI scrubbing.
 */
function mapSelectByValue(elementId, midiValue) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const n = el.options.length;
  if (n === 0) return;
  const idx = Math.min(n - 1, Math.floor(midiValue / 127 * n));
  if (el.selectedIndex !== idx) {
    el.selectedIndex = idx;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** Simulate a button click (only trigger on Note On: velocity > 0). */
function clickButton(elementId, velocity) {
  if (velocity > 0) {
    const el = document.getElementById(elementId);
    if (el) el.click();
  }
}

/**
 * Handle relative encoder (Jog Wheel).
 * Both DDJ-400 and DDJ-FLX4 send ~65 (0x41) for forward, ~63 (0x3F) for backward.
 * Scale tuned to ~0.03 rad/tick — responsive without being hyperactive.
 * Increase towards 0.05 for a heavier, more physical feel; lower to 0.015 for precision.
 */
function spinJog(elementId, midiValue, scale = 0.03) {
  const delta = midiValue < 64 ? midiValue : -(128 - midiValue);
  // scale rad/tick. Top-plate scratch uses ~0.03 (responsive); the side/bend
  // ring uses a much smaller scale for fine micro-nudges.
  const radianDelta = delta * scale;

  const jogEl = document.getElementById(elementId);
  if (!jogEl) return;

  // Dispatch a custom 'jogspin' event that main.js listens for.
  jogEl.dispatchEvent(new CustomEvent('jogspin', { detail: { delta: radianDelta } }));
}

/**
 * Trigger a physical hot-cue pad → LOOP (the on-screen pads were repurposed for
 * camera viewpoints, so we call the loop helper main.js exposes instead of
 * clicking the DOM pad). Falls back to the DOM pad if the hook isn't present.
 */
function triggerPad(deckStr, padIndex, velocity) {
  // Pad-mode aware router (Hot Cue → loops, Beat Loop → camera, etc.).
  if (typeof window !== 'undefined' && typeof window._handleDeckPad === 'function') {
    window._handleDeckPad(deckStr, padIndex, velocity);
    return;
  }
  if (typeof window !== 'undefined' && typeof window._setDeckLoop === 'function') {
    window._setDeckLoop(deckStr, padIndex, velocity > 0);
    return;
  }
  const padsGrid = document.getElementById(`pads-${deckStr}`);
  if (!padsGrid) return;
  const padBtns = padsGrid.querySelectorAll('.pad-btn');
  if (padBtns[padIndex]) {
    if (velocity > 0) {
      padBtns[padIndex].dispatchEvent(new Event('mousedown', { bubbles: true }));
    } else {
      padBtns[padIndex].dispatchEvent(new Event('mouseup', { bubbles: true }));
    }
  }
}

/** Trigger a camera viewpoint preset on the rig (deck A/B, preset 0-7). */
function triggerCam(deckStr, presetIndex, velocity) {
  if (velocity <= 0) return;
  if (typeof window !== 'undefined' && typeof window._setDeckCamPreset === 'function') {
    window._setDeckCamPreset(deckStr === 'a', presetIndex);
  }
}

// ── Profile definitions ───────────────────────────────────────────────────────
//
// Each profile is an object with two handler functions:
//   handleNoteOn(channel, note, velocity)
//   handleCC(channel, cc, value)
//
// Deck A = channel 0, Deck B = channel 1.
// Mixer globals (crossfader, filter) live on channel 6.
// Beat FX section lives on channel 4.
// ─────────────────────────────────────────────────────────────────────────────

const PROFILES = {

  // ── Pioneer DDJ-400 ─────────────────────────────────────────────────────────
  // Source: mixxxdj/mixxx Pioneer-DDJ-400.midi.xml
  //         (official Pioneer DDJ-400 MIDI Message List E1)
  //         https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-400/ddj-400_midi_message_list_e1.pdf
  // The DDJ-400 and DDJ-FLX4 share nearly all note/CC numbers (Pioneer reused the
  // DDJ-400 message map for the FLX4). This profile therefore mirrors the FLX4
  // mapping, which was CONFIRMED via in-app guided capture. Items the DDJ-400 may
  // differ on (or that were never hardware-verified on a 400) are tagged
  // ⚠VERIFY — re-capture them with GUIDED MAP / MIDI Learn if they misbehave.
  'ddj-400': {
    handleNoteOn(channel, note, velocity) {
      // ── Deck transport / loops (ch0 = Deck A, ch1 = Deck B) ──
      if (channel === 0 || channel === 1) {
        const deckStr = channel === 0 ? 'a' : 'b';

        if (note === 11) clickButton(`btn-play-${deckStr}`, velocity); // Play/Pause 0x0B
        if (note === 12) clickButton(`btn-stop-${deckStr}`, velocity); // Cue 0x0C → Stop

        // Shift (0x3F) → cycle tempo range on press
        if (note === 63 && velocity > 0) { if (window._cycleTempoRange) window._cycleTempoRange(deckStr); }

        // Loop section — manual IN/OUT (DDJ-400: LOOP IN 0x10, LOOP OUT 0x11)
        if (note === 16) clickButton(`loop-in-${deckStr}`, velocity);   // ⚠VERIFY
        if (note === 17) clickButton(`loop-out-${deckStr}`, velocity);  // ⚠VERIFY

        // Reloop/Exit → activate/exit the selected chunk loop (commit toggle).
        if (note === 77) clickButton(`loop-active-${deckStr}`, velocity); // RELOOP/EXIT ⚠VERIFY
        if (note === 81) clickButton(`loop-half-${deckStr}`, velocity);   // ½          ⚠VERIFY
        if (note === 83) clickButton(`loop-double-${deckStr}`, velocity); // ×2         ⚠VERIFY

        // Load — ⚠️ a file dialog cannot be opened from a MIDI event (browsers
        // require a real user gesture). Use the on-screen LOAD button.
        if (note === 70 || note === 71) console.warn('[MIDI] Load via MIDI not possible (file dialog needs a user gesture); use the on-screen LOAD button.');
      }

      // ── Performance pads (ch7 = Deck A, ch9 = Deck B; Hot Cue notes 0-7) ──
      // DDJ-400 pads emit different notes per pad mode; this targets Hot Cue mode.
      // Re-capture with GUIDED MAP if you map a different pad mode.        ⚠VERIFY
      if (channel === 7 && note >= 0 && note <= 7) triggerPad('a', note, velocity);
      if (channel === 9 && note >= 0 && note <= 7) triggerPad('b', note, velocity);

      // ── Beat FX section (ch4) ──
      if (channel === 4) {
        // CH-select switch → which deck the FX section drives.
        // DDJ-400 Beat-FX "CH SELECT" is a 3-position selector: 1 → Deck A,
        // 2 → Deck B, MASTER → master bus. Notes per Pioneer/Mixxx map. ⚠VERIFY
        if (velocity > 0) {
          if (note === 16 || note === 0)  ddj400FxTarget = 'a'; // CH 1
          if (note === 17 || note === 1)  ddj400FxTarget = 'b'; // CH 2
          if (note === 18 || note === 2)  ddj400FxTarget = 'm'; // MASTER
        }

        if (note === 71) clickButton(`btn-fx-toggle-${ddj400FxTarget}`, velocity);  // ON/OFF
        if (note === 99 && velocity > 0) cycleSelect(`fx-select-${ddj400FxTarget}`); // FX SELECT ⚠VERIFY
        if (note === 74 && velocity > 0) clickButton(`btn-beat-prev-${ddj400FxTarget}`, velocity); // Beat ‹ ⚠VERIFY
        if (note === 75 && velocity > 0) clickButton(`btn-beat-next-${ddj400FxTarget}`, velocity); // Beat › ⚠VERIFY
      }

      // ── Master section (ch6) ──
      if (channel === 6) {
        // Master Cue → RESET VIEW (re-centers all deck cameras + zoom).
        if (note === 84) clickButton('btn-reset-orient', velocity);
      }
    },

    handleCC(channel, cc, value) {
      // ── Deck controls (ch0 = A, ch1 = B) ──
      if (channel === 0 || channel === 1) {
        const deckStr = channel === 0 ? 'a' : 'b';

        if (cc === 34) spinJog(`jog-${deckStr}`, value);       // jog top plate = scratch (0x22)
        if (cc === 35) {                                        // jog ring = XZ translation nudge (0x21)
          const ndelta = (value < 64 ? value : -(128 - value));
          const jogEl = document.getElementById(`jog-${deckStr}`);
          if (jogEl) jogEl.dispatchEvent(new CustomEvent('jognudge', { detail: { delta: ndelta * 0.003 } }));
        }
        // Tempo fader MSB (LSB 0x20 ignored). Inverted (127-value) so pushing the
        // physical fader DOWN raises BPM and UP lowers it, per house convention.
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, 127 - value);
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);   // EQ High  0x27
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);  // EQ Mid   0x2B
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);  // EQ Low   0x2F
        if (cc === 36) mapSlider(`chunks-slider-${deckStr}`, value); // Trim/Gain → chunk count 0x24
        if (cc === 51) mapSlider(`vol-${deckStr}`, value);     // Channel fader 0x33
      }

      // ── Mixer / master section (ch6) ──
      if (channel === 6) {
        if (cc === 31) mapSlider('crossfader', value);         // Crossfader 0x1F
        if (cc === 23) mapSlider('filter-a', value);           // Color/Quick filter A
        if (cc === 24) mapSlider('filter-b', value);           // Color/Quick filter B
        if (cc === 8)  mapSlider('master-vol', value);         // Master level → zoom        ⚠VERIFY
        if (cc === 12) mapSlider('knob-dof', value);           // Headphone MIX → DOF         ⚠VERIFY
        if (cc === 13) runAction('strobe-3state', value, false); // Headphone CUE LEVEL → strobe 3-state (0 off / mid side / full)
        if (cc === 5)  mapSlider('knob-lensflare', value);     // Mic level → lens flare      ⚠VERIFY
      }

      // ── Beat FX depth (ch4 CC2) → current target deck's FX depth ──
      if (channel === 4) {
        if (cc === 2) mapSlider(`fx-depth-${ddj400FxTarget}`, value);
      }
    },
  },

  // ── Pioneer DDJ-FLX4 ────────────────────────────────────────────────────────
  // Source: mixxxdj/mixxx Pioneer-DDJ-FLX4.midi.xml
  //         (official Pioneer DDJ-FLX4 MIDI Message List E1)
  //         https://www.pioneerdj.com/-/media/pioneerdj/software-info/controller/ddj-flx4/ddj-flx4_midi_message_list_e1.pdf
  //
  // The DDJ-FLX4 shares most note/CC numbers with the DDJ-400.
  // Key differences confirmed from the Mixxx XML:
  //   - Filter:      ch6 CC 23 (deck A) / CC 24 (deck B)  [same as DDJ-400]
  //   - Trim:        CC 36 on ch0/ch1  (same)
  //   - EQ:          CC 39/43/47  (same)
  //   - Vol:         CC 51  (same)
  //   - Jog touch:   Note 54 (same)
  //   - Jog turn:    CC 34 vinyl / CC 35 pitch (same)
  //   - Beat FX Depth: ch4 CC 2  (same)
  //   - Beat FX On/Off: ch4 Note 71  (TODO verify ch split for FLX4)
  //
  // FLX4-specific Beat FX section:
  //   A module-level fxTarget variable tracks which deck's FX is being controlled.
  //   CH-select notes set fxTarget; FX-select, beat prev/next, depth, on/off all
  //   route to the current fxTarget deck.
  // ─────────────────────────────────────────────────────────────────────────────
  'ddj-flx4': {
    handleNoteOn(channel, note, velocity) {
      // ── Deck transport / loops (ch0 = Deck A, ch1 = Deck B) ──
      if (channel === 0 || channel === 1) {
        const deckStr = channel === 0 ? 'a' : 'b';
        if (note === 11) clickButton(`btn-play-${deckStr}`, velocity); // Play/Pause
        if (note === 12) clickButton(`btn-stop-${deckStr}`, velocity); // Cue → Stop

        // Shift button — Note 63 (0x3F): cycle tempo range on press
        if (note === 63 && velocity > 0) { if (window._cycleTempoRange) window._cycleTempoRange(deckStr); }

        // Loops (CONFIRMED via guided capture): 4-beat=77, half=81, double=83
        if (note === 77) clickButton(`loop-active-${deckStr}`, velocity);
        if (note === 81) clickButton(`loop-half-${deckStr}`, velocity);
        if (note === 83) clickButton(`loop-double-${deckStr}`, velocity);

        // Load — ⚠️ a file dialog cannot be opened from a MIDI event (browsers
        // require a real user gesture). Use the on-screen LOAD button.
        if (note === 70 || note === 71) console.warn('[MIDI] Load via MIDI not possible (file dialog needs a user gesture); use the on-screen LOAD button.');
      }

      // ── Performance pads (CONFIRMED: ch7 = Deck A, ch9 = Deck B; notes 0-7) ──
      // NOTE: FLX4 pads emit different notes/channels per pad mode; this was
      // captured in one mode. Re-capture if you switch pad modes.
      if (channel === 7 && note >= 0 && note <= 7) triggerPad('a', note, velocity);
      if (channel === 9 && note >= 0 && note <= 7) triggerPad('b', note, velocity);

      // ── Beat FX section (ch4) ──
      if (channel === 4) {
        // CH-select switch → which deck the FX section controls.
        // Physical CH1 (note 16) = Deck A, Physical CH2 (note 17) = Deck B.
        if (note === 16) flx4FxTarget = 'a';
        if (note === 17) flx4FxTarget = 'b';

        // Beat FX ON/OFF (CONFIRMED note 71) → toggle the target deck's FX
        if (note === 71) clickButton(`btn-fx-toggle-${flx4FxTarget}`, velocity);

        // FX SELECT (CONFIRMED note 99) → cycle the target deck's FX dropdown
        if (note === 99 && velocity > 0) cycleSelect(`fx-select-${flx4FxTarget}`);

        // Beat ‹ / › (CONFIRMED: prev=74, next=75) → step beat division for target
        if (note === 74 && velocity > 0) clickButton(`btn-beat-prev-${flx4FxTarget}`, velocity);
        if (note === 75 && velocity > 0) clickButton(`btn-beat-next-${flx4FxTarget}`, velocity);
      }

      // Master section (ch 6)
      if (channel === 6) {
        if (note === 84) clickButton('btn-strobe', velocity); // Master Cue → strobe toggle
      }
    },

    handleCC(channel, cc, value) {
      // ── Deck controls (ch0 = A, ch1 = B) — not in guided capture; best-known. ──
      if (channel === 0 || channel === 1) {
        const deckStr = channel === 0 ? 'a' : 'b';
        if (cc === 34) spinJog(`jog-${deckStr}`, value);        // top plate = scratch (rotation)
        if (cc === 35) {                                         // side/bend ring = XZ translation nudge
          const ndelta = (value < 64 ? value : -(128 - value));
          const jogEl = document.getElementById(`jog-${deckStr}`);
          if (jogEl) jogEl.dispatchEvent(new CustomEvent('jognudge', { detail: { delta: ndelta * 0.003 } }));
        }
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, value);
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);
        if (cc === 36) mapSlider(`chunks-slider-${deckStr}`, value); // trim → chunk count
        if (cc === 51) mapSlider(`vol-${deckStr}`, value);
      }

      // ── Mixer / master section (ch6) ──
      if (channel === 6) {
        if (cc === 31) mapSlider('crossfader', value);         // crossfader (best-known)
        if (cc === 23) mapSlider('filter-a', value);           // color filter A (best-known)
        if (cc === 24) mapSlider('filter-b', value);           // color filter B (best-known)
        // CONFIRMED via guided capture:
        if (cc === 8)  mapSlider('master-vol', value);         // Master volume → zoom
        if (cc === 12) mapSlider('knob-dof', value);           // Headphone MIX → DOF
        if (cc === 13) mapSlider('knob-lensflare', value);     // Headphone LEVEL → Flare
        if (cc === 5) runAction('strobe-3state', value, false); // Mic level → strobe 3-state
      }

      // ── Beat FX depth (ch4 CC2) → current target deck's FX depth ──
      if (channel === 4) {
        if (cc === 2) mapSlider(`fx-depth-${flx4FxTarget}`, value);
      }
    },
  },

  // ── ICON iDJ ────────────────────────────────────────────────────────────────
  // Source: ICON's own stock VirtualDJ device definition, bundled in the "Setup
  // procedure illustration - VirtualDJ" download on iconproaudio.com/product/idj/
  // (Devices/icon idj.xml, vid=0x1D03 pid=0x0027, drivername "iCON idj V1.01").
  // Verified against the physical unit connected to this machine (matching
  // VID/PID). Unlike the DDJ pair, both decks share MIDI channel 0 — they're
  // split by note/CC number instead of channel. Crossfader alone is ch8.
  // Pitch faders report inverted (min=0x7F at top), so we flip them like the
  // DDJ-400 tempo fader to keep the "push down = faster" house convention.
  'idj': {
    handleNoteOn(channel, note, velocity) {
      if (channel !== 0) return;

      if (note === 0x46) clickButton('btn-play-a', velocity);
      if (note === 0x37) clickButton('btn-play-b', velocity);
      if (note === 0x33) clickButton('btn-stop-a', velocity);  // Cue → Stop
      if (note === 0x47) clickButton('btn-stop-b', velocity);
      if (note === 0x65) clickButton('sync-a', velocity);
      if (note === 0x67) clickButton('sync-b', velocity);

      if (note === 0x34) clickButton('loop-in-a', velocity);
      if (note === 0x32) clickButton('loop-out-a', velocity);
      if (note === 0x36) clickButton('loop-in-b', velocity);
      if (note === 0x38) clickButton('loop-out-b', velocity);
      if (note === 0x66) clickButton('loop-half-a', velocity);
      if (note === 0x42) clickButton('loop-double-a', velocity);
      if (note === 0x68) clickButton('loop-half-b', velocity);
      if (note === 0x43) clickButton('loop-double-b', velocity);

      if (note === 0x16) clickButton('btn-fx-toggle-a', velocity);
      if (note === 0x17) clickButton('btn-fx-toggle-b', velocity);

      // Sampler pads (iDJ only exposes one pad per deck — L/R).
      if (note === 0x4E) triggerPad('a', 0, velocity);
      if (note === 0x53) triggerPad('b', 0, velocity);

      // Load — same browser limitation as the DDJ profiles: a file dialog
      // cannot be opened from a MIDI event, needs a real user gesture.
      if (note === 0x58 || note === 0x5B) console.warn('[MIDI] Load via MIDI not possible (file dialog needs a user gesture); use the on-screen LOAD button.');
    },

    handleCC(channel, cc, value) {
      if (channel === 8) {
        if (cc === 0x08) mapSlider('crossfader', value);
        return;
      }
      if (channel !== 0) return;

      if (cc === 0x0E) mapSlider('tempo-a', 127 - value);  // Pitch fader (inverted, see header note)
      if (cc === 0x0F) mapSlider('tempo-b', 127 - value);
      if (cc === 0x0C) mapSlider('vol-a', value);
      if (cc === 0x0D) mapSlider('vol-b', value);
      if (cc === 0x1C) mapSlider('trim-a', value);         // Gain → trim
      if (cc === 0x1D) mapSlider('trim-b', value);
      if (cc === 0x14) mapSlider('eq-hi-a', value);
      if (cc === 0x1B) mapSlider('eq-hi-b', value);
      if (cc === 0x15) mapSlider('eq-mid-a', value);
      if (cc === 0x19) mapSlider('eq-mid-b', value);
      if (cc === 0x17) mapSlider('eq-low-a', value);
      if (cc === 0x18) mapSlider('eq-low-b', value);
      if (cc === 0x55) mapSlider('filter-a', value);
      if (cc === 0x57) mapSlider('filter-b', value);
      if (cc === 0x10) spinJog('jog-a', value, 0.03);
      if (cc === 0x11) spinJog('jog-b', value, 0.03);
    },
  },
};

// ── Beat FX target state (FLX4) ───────────────────────────────────────────────
// Tracks which deck the FLX4 Beat FX section is currently controlling.
// Changed by the CH-select buttons (1 → 'a', 2 → 'b', MST → 'm').
let flx4FxTarget = 'a';

// Same idea for the DDJ-400 Beat FX section (CH-select → which deck FX controls).
let ddj400FxTarget = 'a';

// ═════════════════════════════════════════════════════════════════════════════
// GENERIC MAPPING ENGINE
// ═════════════════════════════════════════════════════════════════════════════
//
// APP_ACTIONS is a registry of every app control that a MIDI message can drive,
// keyed by a stable action-id. Each entry declares a `kind` that selects which
// helper runs it:
//
//   slider      → mapSlider(el, value)            continuous knobs / faders
//   button      → clickButton(el, velocity)       momentary buttons (note-on)
//   jog         → spinJog(el, value, scale)        relative encoders
//   pad         → triggerPad(deck, index, vel)     performance pads (down/up)
//   selectCycle → cycleSelect(el)                 advance a <select> on note-on
//   selectScrub → mapSelectByValue(el, value)      knob scrubs a <select>
//
// A *custom profile* is just a mapping table:
//   { "<type>:<channel>:<data1>": "<actionId>" }
// where <type> is 'note' or 'cc'. makeCustomProfile() turns that table into a
// { handleNoteOn, handleCC } object compatible with the built-in PROFILES.
// ─────────────────────────────────────────────────────────────────────────────

export const APP_ACTIONS = {
  // ── Continuous sliders / knobs (Deck A & B) ──
  'vol-a':    { kind: 'slider', el: 'vol-a' },
  'vol-b':    { kind: 'slider', el: 'vol-b' },
  'eq-hi-a':  { kind: 'slider', el: 'eq-hi-a' },
  'eq-hi-b':  { kind: 'slider', el: 'eq-hi-b' },
  'eq-mid-a': { kind: 'slider', el: 'eq-mid-a' },
  'eq-mid-b': { kind: 'slider', el: 'eq-mid-b' },
  'eq-low-a': { kind: 'slider', el: 'eq-low-a' },
  'eq-low-b': { kind: 'slider', el: 'eq-low-b' },
  'filter-a': { kind: 'slider', el: 'filter-a' },
  'filter-b': { kind: 'slider', el: 'filter-b' },
  'trim-a':   { kind: 'slider', el: 'trim-a' },
  'trim-b':   { kind: 'slider', el: 'trim-b' },
  'tempo-a':  { kind: 'slider', el: 'tempo-a' },
  'tempo-b':  { kind: 'slider', el: 'tempo-b' },
  'chunks-a': { kind: 'slider', el: 'chunks-slider-a' },
  'chunks-b': { kind: 'slider', el: 'chunks-slider-b' },

  // ── Global mixer / master sliders ──
  'crossfader':     { kind: 'slider', el: 'crossfader' },
  'master-vol':     { kind: 'slider', el: 'master-vol' },
  'knob-dof':       { kind: 'slider', el: 'knob-dof' },
  'knob-lensflare': { kind: 'slider', el: 'knob-lensflare' },

  // ── FX depth (per deck + master) ──
  'fx-depth-a': { kind: 'slider', el: 'fx-depth-a' },
  'fx-depth-b': { kind: 'slider', el: 'fx-depth-b' },
  'fx-depth-m': { kind: 'slider', el: 'fx-depth-m' },

  // ── FX select dropdowns (cycle on press) ──
  'fx-select-a': { kind: 'selectCycle', el: 'fx-select-a' },
  'fx-select-b': { kind: 'selectCycle', el: 'fx-select-b' },
  'fx-select-m': { kind: 'selectCycle', el: 'fx-select-m' },

  // ── FX toggle buttons ──
  'fx-toggle-a': { kind: 'button', el: 'btn-fx-toggle-a' },
  'fx-toggle-b': { kind: 'button', el: 'btn-fx-toggle-b' },
  'fx-toggle-m': { kind: 'button', el: 'btn-fx-toggle-m' },

  // ── Beat prev/next buttons (per deck + master) ──
  'beat-prev-a': { kind: 'button', el: 'btn-beat-prev-a' },
  'beat-next-a': { kind: 'button', el: 'btn-beat-next-a' },
  'beat-prev-b': { kind: 'button', el: 'btn-beat-prev-b' },
  'beat-next-b': { kind: 'button', el: 'btn-beat-next-b' },
  'beat-prev-m': { kind: 'button', el: 'btn-beat-prev-m' },
  'beat-next-m': { kind: 'button', el: 'btn-beat-next-m' },

  // ── Transport ──
  'play-a': { kind: 'button', el: 'btn-play-a' },
  'play-b': { kind: 'button', el: 'btn-play-b' },
  'cue-a':  { kind: 'button', el: 'btn-stop-a' },
  'cue-b':  { kind: 'button', el: 'btn-stop-b' },

  // ── Loop controls ──
  'loop-active-a': { kind: 'button', el: 'loop-active-a' },
  'loop-half-a':   { kind: 'button', el: 'loop-half-a' },
  'loop-double-a': { kind: 'button', el: 'loop-double-a' },
  'loop-in-a':     { kind: 'button', el: 'loop-in-a' },
  'loop-out-a':    { kind: 'button', el: 'loop-out-a' },
  'loop-active-b': { kind: 'button', el: 'loop-active-b' },
  'loop-half-b':   { kind: 'button', el: 'loop-half-b' },
  'loop-double-b': { kind: 'button', el: 'loop-double-b' },
  'loop-in-b':     { kind: 'button', el: 'loop-in-b' },
  'loop-out-b':    { kind: 'button', el: 'loop-out-b' },

  // ── Loop activate/exit (commit toggle) ──
  'loop-toggle-a': { kind: 'button', el: 'loop-toggle-a' },
  'loop-toggle-b': { kind: 'button', el: 'loop-toggle-b' },

  // ── Beat-FX channel-select target (which deck the FX section drives) ──
  'fx-target-a': { kind: 'fxTarget', target: 'a' },
  'fx-target-b': { kind: 'fxTarget', target: 'b' },
  'fx-target-m': { kind: 'fxTarget', target: 'm' },

  // ── View / global ──
  'reset-view': { kind: 'button', el: 'btn-reset-orient' },

  // ── Pad-mode select (per deck) ──
  'padmode-hotcue-a':   { kind: 'padmode', deck: 'a', mode: 'hotcue' },
  'padmode-beatloop-a': { kind: 'padmode', deck: 'a', mode: 'beatloop' },
  'padmode-beatjump-a': { kind: 'padmode', deck: 'a', mode: 'beatjump' },
  'padmode-sampler-a':  { kind: 'padmode', deck: 'a', mode: 'sampler' },
  'padmode-hotcue-b':   { kind: 'padmode', deck: 'b', mode: 'hotcue' },
  'padmode-beatloop-b': { kind: 'padmode', deck: 'b', mode: 'beatloop' },
  'padmode-beatjump-b': { kind: 'padmode', deck: 'b', mode: 'beatjump' },
  'padmode-sampler-b':  { kind: 'padmode', deck: 'b', mode: 'sampler' },

  // ── Misc buttons ──
  'strobe': { kind: 'button', el: 'btn-strobe' },

  // ── Strobe 3-state (off / side / full) — driven by knob/CC value 0-127 ──
  'strobe-3state': { kind: 'strobe3' },

  // ── Jog wheels ──
  'jog-a': { kind: 'jog', el: 'jog-a', scale: 0.03 },
  'jog-b': { kind: 'jog', el: 'jog-b', scale: 0.03 },

  // ── HDRI environment scrub ──
  'hdri': { kind: 'selectScrub', el: 'hdri-select' },

  // ── Performance pads (8 per deck) — physical hot-cue pads stay LOOPS ──
  ...buildPadActions('a'),
  ...buildPadActions('b'),

  // ── Camera viewpoint presets (8 per deck) ──
  // Maps the physical "Beat Loop" pad mode (or any control) to the camera rig.
  ...buildCamActions('a'),
  ...buildCamActions('b'),
};

function buildPadActions(deck) {
  const out = {};
  for (let i = 0; i < 8; i++) {
    out[`pad-${deck}-${i + 1}`] = { kind: 'pad', deck, index: i };
  }
  return out;
}

function buildCamActions(deck) {
  const out = {};
  for (let i = 0; i < 8; i++) {
    out[`cam-${deck}-${i + 1}`] = { kind: 'cam', deck, index: i };
  }
  return out;
}

/**
 * Execute a single APP_ACTION for an incoming MIDI message.
 * @param {string} actionId  Key into APP_ACTIONS.
 * @param {number} value     data2 of the message (velocity for notes, 0-127 for CC).
 * @param {boolean} isNote   true for note on/off, false for CC.
 */
export function runAction(actionId, value, isNote) {
  const action = APP_ACTIONS[actionId];
  if (!action) return;
  switch (action.kind) {
    case 'slider':
      mapSlider(action.el, value);
      break;
    case 'button':
      // Buttons fire on note-on (velocity > 0). clickButton already guards this.
      clickButton(action.el, value);
      break;
    case 'jog':
      spinJog(action.el, value, action.scale ?? 0.03);
      break;
    case 'pad':
      // Pads need both down (velocity > 0) and up (velocity 0) — pass through.
      triggerPad(action.deck, action.index, value);
      break;
    case 'cam':
      // Camera viewpoint preset (fires on press only).
      triggerCam(action.deck, action.index, value);
      break;
    case 'selectCycle':
      if (value > 0) cycleSelect(action.el);
      break;
    case 'selectScrub':
      mapSelectByValue(action.el, value);
      break;
    case 'strobe3': {
      // Quantize 0-127 into thirds: <43 = off, 43-85 = side, >85 = full.
      const strobeTarget = value < 43 ? 'off' : value <= 85 ? 'side' : 'full';
      if (window._setStrobeState) window._setStrobeState(strobeTarget);
      break;
    }
    case 'fxTarget':
      // Beat-FX CH select → which deck ('a'/'b'/'m') the FX section drives.
      if (value > 0) ddj400FxTarget = action.target;
      break;
    case 'padmode':
      // Pad-mode select → Hot Cue / Beat Loop / Beat Jump / Sampler for a deck.
      if (value > 0 && window._setPadMode) window._setPadMode(action.deck, action.mode);
      break;
    default:
      console.warn(`[MIDI] Unknown action kind "${action.kind}" for "${actionId}"`);
  }
}

/**
 * Build a profile object ({handleNoteOn, handleCC}) from a custom mapping table.
 * @param {Object<string,string>} mappingTable  "<type>:<channel>:<data1>" → actionId
 */
export function makeCustomProfile(mappingTable) {
  const table = mappingTable || {};
  return {
    handleNoteOn(channel, note, velocity) {
      const actionId = table[`note:${channel}:${note}`];
      if (actionId) runAction(actionId, velocity, true);
    },
    handleCC(channel, cc, value) {
      const actionId = table[`cc:${channel}:${cc}`];
      if (actionId) runAction(actionId, value, false);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOM PROFILE STORAGE  (localStorage)
// ═════════════════════════════════════════════════════════════════════════════

const PROFILE_STORE_KEY = 'vvj-midi-profiles';

/** Load all saved custom profiles: { [name]: mappingTable }. */
export function loadCustomProfiles() {
  try {
    const raw = localStorage.getItem(PROFILE_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('[MIDI] Failed to load custom profiles:', e);
    return {};
  }
}

/** Save (or overwrite) a custom profile by name. */
export function saveCustomProfile(name, mappingTable) {
  if (!name) return;
  const all = loadCustomProfiles();
  all[name] = mappingTable || {};
  try {
    localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(all));
    console.log(`[MIDI] Saved custom profile "${name}" (${Object.keys(mappingTable || {}).length} mappings)`);
  } catch (e) {
    console.warn('[MIDI] Failed to save custom profile:', e);
  }
}

/** Delete a custom profile by name. */
export function deleteCustomProfile(name) {
  const all = loadCustomProfiles();
  if (name in all) {
    delete all[name];
    try {
      localStorage.setItem(PROFILE_STORE_KEY, JSON.stringify(all));
      console.log(`[MIDI] Deleted custom profile "${name}"`);
    } catch (e) {
      console.warn('[MIDI] Failed to delete custom profile:', e);
    }
  }
}

/** List the names of all saved custom profiles. */
export function listCustomProfiles() {
  return Object.keys(loadCustomProfiles());
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILT-IN PROFILE OVERRIDE LAYER  (localStorage)
// ═════════════════════════════════════════════════════════════════════════════
//
// Lets the user RE-MAP individual controls of a built-in profile without losing
// the built-in's behavior for controls they leave alone. An override is a
// per-control table layered ON TOP of the hardcoded handler:
//
//   { [builtinName]: { "<type>:<channel>:<data1>": "<actionId>" } }
//
// At dispatch time, if the active profile is a built-in and the incoming
// message key matches an override entry, we run that action via the generic
// engine and SKIP the built-in handler for that message. Everything else falls
// through to the original hardcoded behavior untouched.

const OVERRIDE_STORE_KEY = 'vvj-profile-overrides';

// In-memory cache of all overrides, loaded on startup via loadProfileOverrides().
let _profileOverrides = {};

/** Persist the in-memory override map to localStorage. */
function _persistOverrides() {
  try {
    localStorage.setItem(OVERRIDE_STORE_KEY, JSON.stringify(_profileOverrides));
  } catch (e) {
    console.warn('[MIDI] Failed to persist profile overrides:', e);
  }
}

/**
 * Load all built-in overrides from localStorage into memory.
 * Call once on startup. Returns the loaded map.
 */
export function loadProfileOverrides() {
  try {
    const raw = localStorage.getItem(OVERRIDE_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    _profileOverrides = (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (e) {
    console.warn('[MIDI] Failed to load profile overrides:', e);
    _profileOverrides = {};
  }
  return _profileOverrides;
}

/** Get the override table for a built-in profile ({} if none). */
export function getProfileOverride(name) {
  const t = _profileOverrides[name];
  return (t && typeof t === 'object') ? t : {};
}

/**
 * Merge a partial mapping table into a built-in's override and persist.
 * Existing entries for keys NOT in `table` are preserved; matching keys are
 * replaced. Steps the user skipped (absent from `table`) keep the built-in
 * default.
 */
export function mergeProfileOverride(name, table) {
  if (!name || !table || typeof table !== 'object') return getProfileOverride(name);
  const merged = { ...getProfileOverride(name), ...table };
  _profileOverrides[name] = merged;
  _persistOverrides();
  console.log(`[MIDI] Merged ${Object.keys(table).length} override(s) into built-in "${name}" (total ${Object.keys(merged).length})`);
  return merged;
}

/** Remove all overrides for a built-in profile and persist. */
export function clearProfileOverride(name) {
  if (name in _profileOverrides) {
    delete _profileOverrides[name];
    _persistOverrides();
    console.log(`[MIDI] Cleared overrides for built-in "${name}"`);
  }
}

/** True if `name` is one of the hardcoded built-in profiles. */
export function isBuiltinProfile(name) {
  return Object.prototype.hasOwnProperty.call(PROFILES, name);
}

// Eagerly hydrate overrides at module load so the dispatcher honors saved
// re-mappings even before initMIDI() runs (e.g. in headless smoke tests).
loadProfileOverrides();

// ── Active profile state ──────────────────────────────────────────────────────
//
// The dispatcher uses a single resolved profile object (`activeProfileObj`) so
// built-in and custom profiles are handled uniformly. `activeProfile` keeps the
// human-readable name for logging / UI.

let activeProfile = 'ddj-flx4';
let activeProfileObj = PROFILES['ddj-flx4'];

/**
 * Switch the active MIDI profile.
 * @param {string} name  A built-in ('ddj-400' | 'ddj-flx4') or a saved custom profile name.
 */
export function setMidiProfile(name) {
  if (PROFILES[name]) {
    activeProfile = name;
    activeProfileObj = PROFILES[name];
    console.log(`[MIDI] Profile switched to built-in: ${name}`);
    return;
  }

  const customs = loadCustomProfiles();
  if (name in customs) {
    activeProfile = name;
    activeProfileObj = makeCustomProfile(customs[name]);
    console.log(`[MIDI] Profile switched to custom: ${name}`);
    return;
  }

  console.warn(`[MIDI] Unknown profile "${name}". Built-ins: ${Object.keys(PROFILES).join(', ')}; customs: ${Object.keys(customs).join(', ') || '(none)'}`);
}

// ── MIDI message dispatcher ───────────────────────────────────────────────────

function getMIDIMessage(message) {
  const [status, data1, data2] = message.data;

  // Message types:
  // 0x90-0x9F: Note On  (channel 0-15)
  // 0x80-0x8F: Note Off (channel 0-15)
  // 0xB0-0xBF: Control Change (channel 0-15)

  const cmd      = status >> 4;
  const channel  = status & 0x0f;
  const isNoteOn = cmd === 9;
  const isNoteOff= cmd === 8;
  const isCC     = cmd === 11;
  const velocity = data2;
  const type     = isCC ? 'cc' : 'note';

  // ── MIDI-Learn forward ────────────────────────────────────────────────────
  // When MIDI Learn is active, forward every parsed message to the sink callback.
  // Normal profile handling continues in parallel so live control still works.
  if (midiLearnEnabled && midiLearnSink) {
    midiLearnSink({
      channel,
      type,
      data1,
      value: velocity,
    });
  }

  const profile = activeProfileObj;
  if (!profile) return;

  // ── Built-in override layer ───────────────────────────────────────────────
  // If the active profile is a built-in and this control has been re-mapped,
  // run the override action and SKIP the built-in handler for this message.
  // Custom profiles are already fully table-driven, so they bypass this.
  if (isBuiltinProfile(activeProfile)) {
    const override = getProfileOverride(activeProfile);
    if (override && Object.keys(override).length) {
      const key = `${type}:${channel}:${data1}`;
      const actionId = override[key];
      if (actionId) {
        // Note-off (velocity 0) must still reach runAction (pad/button mouseup).
        const v = isCC ? velocity : (isNoteOn ? velocity : 0);
        runAction(actionId, v, !isCC);
        return; // override replaces the built-in default for this control
      }
    }
  }

  if (isNoteOn || isNoteOff) {
    // Pass Note Off (velocity 0) so pads get mouseup events
    profile.handleNoteOn(channel, data1, isNoteOn ? velocity : 0);
  }

  if (isCC) {
    profile.handleCC(channel, data1, velocity);
  }
}

// ── MIDI access ───────────────────────────────────────────────────────────────

/**
 * Guess the matching built-in profile from a MIDI input's device name.
 * Returns a profile key ('ddj-400' | 'ddj-flx4' | 'idj') or null if unrecognized.
 * FLX4 is checked first so "DDJ-FLX4" never matches the looser "400" test.
 */
function profileFromDeviceName(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  if (n.includes('FLX4') || n.includes('FLX-4')) return 'ddj-flx4';
  if (n.includes('DDJ-400') || n.includes('DDJ400') || n.includes('400')) return 'ddj-400';
  if (n.includes('IDJ') || n.includes('ICON')) return 'idj';
  return null;
}

// Auto-detect runs only until the user manually picks a profile, so we never
// clobber a deliberate choice when a device re-announces itself.
let _autoDetectLocked = false;

/** Called by the UI when the user manually changes the profile dropdown. */
export function lockAutoDetect() {
  _autoDetectLocked = true;
}

/** Try to auto-select a built-in profile from a device name. */
function tryAutoDetect(deviceName) {
  if (_autoDetectLocked) return;
  const guess = profileFromDeviceName(deviceName);
  if (!guess) return;
  setMidiProfile(guess);
  console.log(`[MIDI] Auto-detected "${deviceName}" → profile "${guess}"`);
  // Let the UI sync the dropdown to match.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('midi-profile-autodetected', { detail: { profile: guess } }));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MIDI OUTPUT  →  CONTROLLER LED FEEDBACK
// ═════════════════════════════════════════════════════════════════════════════
//
// Pioneer DDJ LEDs are lit by sending the controller a Note On whose channel +
// note match the *button's own* input message. velocity 0x7F = lit, 0x00 = off.
// We mirror app state back to the hardware so the operator can see, on the deck,
// what is playing / looping / cued without looking at the screen.
//
// LED note numbers below mirror the DDJ-400 input map in PROFILES['ddj-400'].
// Anything the 400 input map tags ⚠VERIFY is equally unverified for output —
// if an LED doesn't light, confirm the note with MIDI Learn and update here.
// ─────────────────────────────────────────────────────────────────────────────

let _midiOutputs = [];     // all connected MIDI output ports
const LED_ON = 0x7f;
const LED_OFF = 0x00;

// Deck → base MIDI channel for transport/loop buttons (a=0, b=1).
function _deckChannel(deck) { return deck === 'b' ? 1 : 0; }
// Deck → performance-pad channel (a=7, b=9), matching the input map.
function _padChannel(deck) { return deck === 'b' ? 9 : 7; }

// Named transport/loop LEDs → note number on the deck channel.
const LED_NOTES = {
  'play':        11, // 0x0B
  'cue':         12, // 0x0C
  'loop-in':     16, // ⚠VERIFY
  'loop-out':    17, // ⚠VERIFY
  'loop-active': 77, // ⚠VERIFY
  'loop-half':   81, // ⚠VERIFY
  'loop-double': 83, // ⚠VERIFY
};

/** Refresh the cached list of output ports from a MIDIAccess object. */
function _collectOutputs(midiAccess) {
  _midiOutputs = [...midiAccess.outputs.values()];
  for (const o of _midiOutputs) console.log(`[MIDI] Output port: ${o.name}`);
}

/** Low-level: send a 3-byte message to every output port. Safe if none exist. */
function _sendOut(bytes) {
  if (!_midiOutputs.length) return;
  for (const out of _midiOutputs) {
    try { out.send(bytes); } catch (e) { /* port busy / closed — ignore */ }
  }
}

/** Send a Note On to set one LED on/off. */
function _led(channel, note, on) {
  _sendOut([0x90 | (channel & 0x0f), note & 0x7f, on ? LED_ON : LED_OFF]);
}

/**
 * Set a named transport/loop LED for a deck.
 * @param {'a'|'b'} deck
 * @param {string}  control  key in LED_NOTES (e.g. 'play', 'loop-active')
 * @param {boolean} on
 */
export function setLed(deck, control, on) {
  const note = LED_NOTES[control];
  if (note === undefined) return;
  _led(_deckChannel(deck), note, on);
}

/** Set a performance-pad LED (index 0-7) for a deck. */
export function setPadLed(deck, index, on) {
  if (index < 0 || index > 7) return;
  _led(_padChannel(deck), index, on);
}

/** Briefly flash a named LED (used for momentary buttons like Cue). */
export function flashLed(deck, control, ms = 150) {
  setLed(deck, control, true);
  setTimeout(() => setLed(deck, control, false), ms);
}

/** Turn every LED this module knows about off (both decks + all pads). */
export function allLedsOff() {
  for (const deck of ['a', 'b']) {
    for (const control of Object.keys(LED_NOTES)) setLed(deck, control, false);
    for (let i = 0; i < 8; i++) setPadLed(deck, i, false);
  }
}

/**
 * Quick "lamp test" so the user sees feedback is live: blink play + all pads,
 * then clear. Called once when a DDJ output is detected.
 */
function _lampTest() {
  for (const deck of ['a', 'b']) {
    setLed(deck, 'play', true);
    for (let i = 0; i < 8; i++) setPadLed(deck, i, true);
  }
  setTimeout(allLedsOff, 250);
}

function onMIDISuccess(midiAccess) {
  console.log('[MIDI] Access successful');
  for (let input of midiAccess.inputs.values()) {
    console.log(`[MIDI] Connected: ${input.name}`);
    input.onmidimessage = getMIDIMessage;
    tryAutoDetect(input.name);
  }

  _collectOutputs(midiAccess);
  if (_midiOutputs.length) {
    _lampTest();
    // Ask the app to push current state to the freshly-found LEDs.
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('midi-leds-ready'));
  }

  midiAccess.onstatechange = (e) => {
    console.log(`[MIDI] State change: ${e.port.name} → ${e.port.state}`);
    if (e.port.state === 'connected' && e.port.type === 'input') {
      e.port.onmidimessage = getMIDIMessage;
      tryAutoDetect(e.port.name);
    }
    // Rebuild the output list on any output connect/disconnect.
    if (e.port.type === 'output') {
      _collectOutputs(midiAccess);
      if (e.port.state === 'connected' && _midiOutputs.length) {
        _lampTest();
        if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('midi-leds-ready'));
      }
    }
  };
}

function onMIDIFailure() {
  console.error('[MIDI] Could not access MIDI devices.');
}

/**
 * Test hook: feed a raw MIDI byte array ([status, data1, data2]) through the
 * real dispatcher. Used by the Puppeteer smoke test since headless has no real
 * MIDI. Routes to the active profile exactly like a hardware message would.
 */
export function _simulateMIDIMessage(bytes) {
  getMIDIMessage({ data: bytes });
}

export function initMIDI() {
  loadProfileOverrides(); // restore any saved built-in re-mappings
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
  } else {
    console.warn('[MIDI] Web MIDI API not supported in this browser.');
  }
}

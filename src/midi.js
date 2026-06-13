// ─────────────────────────────────────────────────────────────────────────────
// midi.js  –  Multi-controller MIDI support
//
// Supported profiles:
//   'ddj-400'  — Pioneer DDJ-400
//   'ddj-flx4' — Pioneer DDJ-FLX4
//
// MIDI numbers sourced from:
//   DDJ-400 : mixxxdj/mixxx Pioneer-DDJ-400.midi.xml (derived from official
//             Pioneer DDJ-400 MIDI Message List E1, pioneerdj.com)
//   DDJ-FLX4: mixxxdj/mixxx Pioneer-DDJ-FLX4.midi.xml (derived from official
//             Pioneer DDJ-FLX4 MIDI Message List E1, pioneerdj.com)
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
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  // normalized value 0.0 - 1.0
  const norm = midiValue / 127.0;
  el.value = min + norm * (max - min);

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

/** Trigger a pad button (hot cue / beat jump pad). */
function triggerPad(deckStr, padIndex, velocity) {
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
  'ddj-400': {
    handleNoteOn(channel, note, velocity) {
      const isDeckA = (channel === 0);
      const isDeckB = (channel === 1);
      const isDeck  = isDeckA || isDeckB;
      const deckStr = isDeckA ? 'a' : 'b';

      if (isDeck) {
        // Play/Pause  — Note 11 (0x0B)
        if (note === 11) clickButton(`btn-play-${deckStr}`, velocity);

        // Cue — Note 12 (0x0C) → performs Stop in the app
        if (note === 12) clickButton(`btn-cue-${deckStr}`, velocity);

        // Hot Cue pads — Notes 0-7 (0x00-0x07)
        if (note >= 0 && note <= 7) {
          triggerPad(deckStr, note, velocity);
        }

        // Loop controls — TODO verify exact notes on DDJ-400
        if (note === 20) clickButton(`loop-active-${deckStr}`, velocity); // 4-beat loop toggle // TODO verify
        if (note === 21) clickButton(`loop-half-${deckStr}`, velocity);   // loop half          // TODO verify
        if (note === 22) clickButton(`loop-double-${deckStr}`, velocity); // loop double        // TODO verify

        // Load track — Deck A: Note 70 (0x46), Deck B: Note 71 (0x47)
        // ⚠️ Cannot open a file dialog from a MIDI event — browsers require a
        // real user gesture (click). Calling fileInput.click() silently fails.
        // Use the on-screen LOAD button instead; MIDI Learn will confirm the note.
        if (isDeckA && note === 70) console.warn('[MIDI] Load Deck A triggered via MIDI — file dialog cannot be opened from MIDI event; use on-screen button.');
        if (isDeckB && note === 71) console.warn('[MIDI] Load Deck B triggered via MIDI — file dialog cannot be opened from MIDI event; use on-screen button.');
      }

      // Beat FX channel (ch 4)
      if (channel === 4) {
        // Beat FX On/Off — Note 71 (0x47) // TODO verify
        if (note === 71) clickButton('btn-fx-toggle-a', velocity);
      }
    },

    handleCC(channel, cc, value) {
      const isDeckA = (channel === 0);
      const isDeckB = (channel === 1);
      const isDeck  = isDeckA || isDeckB;
      const deckStr = isDeckA ? 'a' : 'b';

      if (isDeck) {
        // Jog wheel vinyl turn — CC 34 (0x22)
        if (cc === 34) spinJog(`jog-${deckStr}`, value);

        // Tempo fader MSB — CC 0 (0x00)
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, value);
        // Tempo fader LSB — CC 32 (0x20) — fine resolution, skip

        // EQ High — CC 39 (0x27)
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);
        // EQ Mid  — CC 43 (0x2B)
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);
        // EQ Low  — CC 47 (0x2F)
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);

        // Trim/Gain — CC 36 (0x24)
        if (cc === 36) mapSlider(`trim-${deckStr}`, value);

        // Channel Fader (Vol) — CC 51 (0x33)
        if (cc === 51) mapSlider(`vol-${deckStr}`, value);

        // Filter — DDJ-400 may send on ch0/ch1 CC 22; TODO verify
        if (cc === 22) mapSlider(`filter-${deckStr}`, value); // TODO verify CC
      }

      // Mixer channel (ch 6)
      if (channel === 6) {
        // Crossfader — CC 31 (0x1F)
        if (cc === 31) mapSlider('crossfader', value);

        // Filter (Quick Filter) — ch6 CC 23 (deck A) / 24 (deck B)
        if (cc === 23) mapSlider('filter-a', value);
        if (cc === 24) mapSlider('filter-b', value);

        // Master volume — CC 5 on ch6 // TODO verify CC
        if (cc === 5) mapSlider('master-vol', value); // TODO verify CC
      }

      // Beat FX channel (ch 4)
      if (channel === 4) {
        // Beat FX Depth/Level — CC 2 (0x02)
        if (cc === 2) mapSlider('fx-depth-a', value);
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
        if (note === 12) clickButton(`btn-cue-${deckStr}`, velocity);  // Cue → Stop

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
        // CONFIRMED: CH1 → note 17, CH2 → note 16. The FLX4 switch has no third
        // note for MASTER (only 16/17 exist), so the Master FX target must be
        // chosen on-screen (the MASTER position shares note 17 with CH1).
        if (note === 17) flx4FxTarget = 'a';
        if (note === 16) flx4FxTarget = 'b';

        // Beat FX ON/OFF (CONFIRMED note 71) → toggle the target deck's FX
        if (note === 71) clickButton(`btn-fx-toggle-${flx4FxTarget}`, velocity);

        // FX SELECT (CONFIRMED note 99) → cycle the target deck's FX dropdown
        if (note === 99 && velocity > 0) cycleSelect(`fx-select-${flx4FxTarget}`);

        // Beat ‹ / › (CONFIRMED: prev=74, next=75) → step beat division for target
        if (note === 74 && velocity > 0) clickButton(`btn-beat-prev-${flx4FxTarget}`, velocity);
        if (note === 75 && velocity > 0) clickButton(`btn-beat-next-${flx4FxTarget}`, velocity);
      }
    },

    handleCC(channel, cc, value) {
      // ── Deck controls (ch0 = A, ch1 = B) — not in guided capture; best-known. ──
      if (channel === 0 || channel === 1) {
        const deckStr = channel === 0 ? 'a' : 'b';
        if (cc === 34) spinJog(`jog-${deckStr}`, value);        // top plate = scratch (full)
        if (cc === 35) spinJog(`jog-${deckStr}`, value, 0.008); // side/bend ring = fine micro-nudge
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, value);
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);
        if (cc === 36) mapSlider(`trim-${deckStr}`, value);
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
        if (cc === 5)  mapSelectByValue('hdri-select', value); // Mic level → HDRI scrub
      }

      // ── Beat FX depth (ch4 CC2) → current target deck's FX depth ──
      if (channel === 4) {
        if (cc === 2) mapSlider(`fx-depth-${flx4FxTarget}`, value);
      }
    },
  },
};

// ── Beat FX target state (FLX4) ───────────────────────────────────────────────
// Tracks which deck the FLX4 Beat FX section is currently controlling.
// Changed by the CH-select buttons (1 → 'a', 2 → 'b', MST → 'm').
let flx4FxTarget = 'a';

// ── Active profile state ──────────────────────────────────────────────────────

let activeProfile = 'ddj-flx4';

/**
 * Switch the active MIDI profile.
 * @param {string} name  One of 'ddj-400' or 'ddj-flx4'.
 */
export function setMidiProfile(name) {
  if (!PROFILES[name]) {
    console.warn(`[MIDI] Unknown profile "${name}". Valid profiles: ${Object.keys(PROFILES).join(', ')}`);
    return;
  }
  activeProfile = name;
  console.log(`[MIDI] Profile switched to: ${name}`);
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

  const profile = PROFILES[activeProfile];
  if (!profile) return;

  if (isNoteOn || isNoteOff) {
    // Pass Note Off (velocity 0) so pads get mouseup events
    profile.handleNoteOn(channel, data1, isNoteOn ? velocity : 0);
  }

  if (isCC) {
    profile.handleCC(channel, data1, velocity);
  }
}

// ── MIDI access ───────────────────────────────────────────────────────────────

function onMIDISuccess(midiAccess) {
  console.log('[MIDI] Access successful');
  for (let input of midiAccess.inputs.values()) {
    console.log(`[MIDI] Connected: ${input.name}`);
    input.onmidimessage = getMIDIMessage;
  }

  midiAccess.onstatechange = (e) => {
    console.log(`[MIDI] State change: ${e.port.name} → ${e.port.state}`);
    if (e.port.state === 'connected' && e.port.type === 'input') {
      e.port.onmidimessage = getMIDIMessage;
    }
  };
}

function onMIDIFailure() {
  console.error('[MIDI] Could not access MIDI devices.');
}

export function initMIDI() {
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
  } else {
    console.warn('[MIDI] Web MIDI API not supported in this browser.');
  }
}

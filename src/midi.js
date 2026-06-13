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

// ── Helper functions ──────────────────────────────────────────────────────────

// Map 0-127 MIDI value to a specific HTML input slider range
function mapSlider(elementId, midiValue) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const min = parseFloat(el.min) || 0;
  const max = parseFloat(el.max) || 100;
  // normalized value 0.0 - 1.0
  const norm = midiValue / 127.0;
  el.value = min + norm * (max - min);

  // Trigger input event to update the app logic
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Simulate a button click (only trigger on Note On: velocity > 0)
function clickButton(elementId, velocity) {
  if (velocity > 0) {
    const el = document.getElementById(elementId);
    if (el) el.click();
  }
}

// Handle relative encoder (Jog Wheel)
// Both DDJ-400 and DDJ-FLX4 send ~65 (0x41) for forward, ~63 (0x3F) for backward
function spinJog(elementId, midiValue) {
  const delta = midiValue < 64 ? midiValue : -(128 - midiValue);
  // Scale the physical delta to the virtual jog wheel radians
  const radianDelta = delta * 0.05;

  const jogEl = document.getElementById(elementId);
  if (!jogEl) return;

  // Dispatch a custom 'jogspin' event that main.js listens for
  jogEl.dispatchEvent(new CustomEvent('jogspin', { detail: { delta: radianDelta } }));
}

// Trigger a pad button (hot cue / beat jump pad)
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

        // Cue         — Note 12 (0x0C)
        if (note === 12) clickButton(`btn-cue-${deckStr}`, velocity);

        // Jog touch   — Note 54 (0x36)  (scratch mode engage; no app action needed)
        // if (note === 54) { /* scratch mode */ }

        // Hot Cue pads — Notes 0-7 (0x00-0x07)
        if (note >= 0 && note <= 7) {
          triggerPad(deckStr, note, velocity);
        }

        // Load track  — Deck A: Note 70 (0x46), Deck B: Note 71 (0x47)
        if (isDeckA && note === 70) clickButton('btn-load-a', velocity);
        if (isDeckB && note === 71) clickButton('btn-load-b', velocity);
      }

      // Beat FX channel (ch 4)
      if (channel === 4) {
        // Beat FX Select — Note 99 (0x63)
        // TODO verify: map to fx-select cycle if needed
        // Beat FX On/Off — Note 71 (0x47)
        if (note === 71) clickButton('btn-fx-toggle-a', velocity); // master FX toggle
      }
    },

    handleCC(channel, cc, value) {
      const isDeckA = (channel === 0);
      const isDeckB = (channel === 1);
      const isDeck  = isDeckA || isDeckB;
      const deckStr = isDeckA ? 'a' : 'b';

      if (isDeck) {
        // Jog wheel vinyl turn  — CC 34 (0x22)
        if (cc === 34) spinJog(`jog-${deckStr}`, value);

        // Tempo fader MSB       — CC 0  (0x00)
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, value);
        // Tempo fader LSB       — CC 32 (0x20) — fine resolution, ignore for now
        // if (cc === 32) { /* LSB, skip */ }

        // EQ High               — CC 39 (0x27)
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);
        // EQ Mid                — CC 43 (0x2B)
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);
        // EQ Low                — CC 47 (0x2F)
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);

        // Trim/Gain             — CC 36 (0x24)
        if (cc === 36) mapSlider(`trim-${deckStr}`, value);

        // Channel Fader (Vol)   — CC 51 (0x33)
        if (cc === 51) mapSlider(`vol-${deckStr}`, value);
      }

      // Mixer channel (ch 6)
      if (channel === 6) {
        // Crossfader            — CC 31 (0x1F)
        if (cc === 31) mapSlider('crossfader', value);

        // Filter (Quick Filter) — CC 23 (0x17) for deck A
        // DDJ-400 sends filter for both decks on ch6 CC 23/24;
        // Mixxx XML uses ch6 CC 23 (deck A filter) – map to active deck or ch0 filter
        // TODO verify: DDJ-400 may send deck-specific filter on ch0/ch1 CC 22 instead
        if (cc === 23) mapSlider('filter-a', value);
        if (cc === 24) mapSlider('filter-b', value);
      }

      // Beat FX channel (ch 4)
      if (channel === 4) {
        // Beat FX Depth/Level   — CC 2 (0x02)
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
  //   - Filter:  ch6 CC 23 (deck A) / CC 24 (deck B)  [same as DDJ-400 above]
  //   - Trim:    CC 36 on ch0/ch1  (same)
  //   - EQ:      CC 39/43/47  (same)
  //   - Vol:     CC 51  (same)
  //   - Jog touch: Note 54 (same)
  //   - Jog turn: CC 34 vinyl / CC 35 pitch / CC 33 side (same)
  //   - Load:    Deck A Note 70, Deck B Note 71  (same)
  //   - Beat FX Depth: ch4 CC 2  (same)
  //   - Beat FX On/Off: ch4 or ch5 Note 71  (TODO verify ch split)
  'ddj-flx4': {
    handleNoteOn(channel, note, velocity) {
      const isDeckA = (channel === 0);
      const isDeckB = (channel === 1);
      const isDeck  = isDeckA || isDeckB;
      const deckStr = isDeckA ? 'a' : 'b';

      if (isDeck) {
        // Play/Pause  — Note 11 (0x0B)
        if (note === 11) clickButton(`btn-play-${deckStr}`, velocity);

        // Cue         — Note 12 (0x0C)
        if (note === 12) clickButton(`btn-cue-${deckStr}`, velocity);

        // Jog touch   — Note 54 (0x36)
        // if (note === 54) { /* scratch mode */ }

        // Hot Cue pads — Notes 0-7 (0x00-0x07)
        if (note >= 0 && note <= 7) {
          triggerPad(deckStr, note, velocity);
        }

        // Load track  — Deck A: Note 70 (0x46), Deck B: Note 71 (0x47)
        if (isDeckA && note === 70) clickButton('btn-load-a', velocity);
        if (isDeckB && note === 71) clickButton('btn-load-b', velocity);
      }

      // Beat FX channel (ch 4/5)
      // FLX4 Beat FX On/Off: ch4 Note 71 (deck A side) / ch5 Note 71 (deck B side)
      // TODO verify: exact channel split for FLX4 Beat FX vs DDJ-400
      if (channel === 4 || channel === 5) {
        if (note === 71) {
          const fxDeck = (channel === 4) ? 'a' : 'b';
          clickButton(`btn-fx-toggle-${fxDeck}`, velocity);
        }
        // Beat FX Select — Note 99 (0x63)
        // TODO verify: FLX4 Beat FX select channel
      }
    },

    handleCC(channel, cc, value) {
      const isDeckA = (channel === 0);
      const isDeckB = (channel === 1);
      const isDeck  = isDeckA || isDeckB;
      const deckStr = isDeckA ? 'a' : 'b';

      if (isDeck) {
        // Jog wheel vinyl turn  — CC 34 (0x22)
        if (cc === 34) spinJog(`jog-${deckStr}`, value);
        // Jog wheel pitch turn  — CC 35 (0x23) — same physical wheel in non-vinyl mode
        if (cc === 35) spinJog(`jog-${deckStr}`, value);

        // Tempo fader MSB       — CC 0  (0x00)
        if (cc === 0)  mapSlider(`tempo-${deckStr}`, value);
        // Tempo fader LSB       — CC 32 (0x20) — fine resolution, skip

        // EQ High               — CC 39 (0x27)
        if (cc === 39) mapSlider(`eq-hi-${deckStr}`, value);
        // EQ Mid                — CC 43 (0x2B)
        if (cc === 43) mapSlider(`eq-mid-${deckStr}`, value);
        // EQ Low                — CC 47 (0x2F)
        if (cc === 47) mapSlider(`eq-low-${deckStr}`, value);

        // Trim/Gain             — CC 36 (0x24)
        if (cc === 36) mapSlider(`trim-${deckStr}`, value);

        // Channel Fader (Vol)   — CC 51 (0x33)
        if (cc === 51) mapSlider(`vol-${deckStr}`, value);
      }

      // Mixer channel (ch 6)
      if (channel === 6) {
        // Crossfader            — CC 31 (0x1F)
        if (cc === 31) mapSlider('crossfader', value);

        // Filter deck A         — CC 23 (0x17)
        if (cc === 23) mapSlider('filter-a', value);
        // Filter deck B         — CC 24 (0x18)  ← FLX4 adds a second filter CC
        if (cc === 24) mapSlider('filter-b', value);
      }

      // Beat FX channel (ch 4)
      if (channel === 4) {
        // Beat FX Depth/Level   — CC 2 (0x02)
        if (cc === 2) mapSlider('fx-depth-a', value);
      }
    },
  },
};

// ── Active profile state ──────────────────────────────────────────────────────

let activeProfile = 'ddj-400';

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

  // Uncomment to debug unknown MIDI signals:
  // console.log(`MIDI: cmd=${cmd.toString(16)}, ch=${channel}, d1=0x${data1.toString(16)} (${data1}), d2=${velocity}`);

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

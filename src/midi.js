export function initMIDI() {
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(onMIDISuccess, onMIDIFailure);
  } else {
    console.warn("Web MIDI API is not supported in this browser.");
  }
}

function onMIDISuccess(midiAccess) {
  console.log("MIDI Access Successful!");
  for (let input of midiAccess.inputs.values()) {
    console.log(`Connected to MIDI device: ${input.name}`);
    input.onmidimessage = getMIDIMessage;
  }
  
  midiAccess.onstatechange = (e) => {
    console.log(`MIDI State Change: ${e.port.name} ${e.port.state}`);
    if (e.port.state === 'connected' && e.port.type === 'input') {
      e.port.onmidimessage = getMIDIMessage;
    }
  };
}

function onMIDIFailure() {
  console.error("Could not access your MIDI devices.");
}

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
// DDJ-400 sends ~65 (0x41) for forward, and ~63 (0x3F) for backward
function spinJog(elementId, midiValue) {
  const delta = midiValue < 64 ? midiValue : -(128 - midiValue);
  // Scale the physical delta to the virtual jog wheel radians
  const radianDelta = delta * 0.05; 
  
  const jogEl = document.getElementById(elementId);
  if (!jogEl) return;
  
  // Fake a mousedown / mousemove / mouseup sequence by just calling the internal logic, 
  // but since our jog wheel logic is encapsulated in main.js, we can dispatch a custom event or click
  // Actually, let's dispatch a custom 'jogspin' event that main.js will listen to
  jogEl.dispatchEvent(new CustomEvent('jogspin', { detail: { delta: radianDelta } }));
}

function getMIDIMessage(message) {
  const [status, data1, data2] = message.data;
  
  // Message types:
  // 0x90 to 0x9F: Note On (Channel 0-15)
  // 0x80 to 0x8F: Note Off (Channel 0-15)
  // 0xB0 to 0xBF: Control Change (Channel 0-15)
  
  const cmd = status >> 4;
  const channel = status & 0x0f; 
  const isNoteOn = cmd === 9;
  const isCC = cmd === 11;
  const velocity = data2;

  // Uncomment to debug unknown MIDI signals:
  // console.log(`MIDI: cmd=${cmd} (hex ${cmd.toString(16)}), ch=${channel}, d1=${data1} (hex ${data1.toString(16)}), d2=${velocity}`);

  // DECK A (Channel 0) / DECK B (Channel 1)
  const isDeckA = (channel === 0);
  const isDeckB = (channel === 1);
  const isMixer = (channel === 6 || channel === 0 || channel === 1); // Mixer CCs can sometimes appear on ch 0/1/6
  const deckStr = isDeckA ? 'a' : 'b';

  if (isNoteOn) {
    // Play/Pause (DDJ-400 Play is usually Note 11)
    if (data1 === 11) clickButton(`btn-play-${deckStr}`, velocity);
    // Cue (DDJ-400 Cue is usually Note 12)
    if (data1 === 12) clickButton(`btn-cue-${deckStr}`, velocity);
    // Stop (Custom mapping, let's map Shift+Play or something, but we'll leave it out for hardware unless known)

    // Performance Pads (Hot Cues) Note 0-7
    if (data1 >= 0 && data1 <= 7) {
      // Find the pad button in the correct deck
      const padsGrid = document.getElementById(`pads-${deckStr}`);
      if (padsGrid) {
        const padBtns = padsGrid.querySelectorAll('.pad-btn');
        if (padBtns[data1]) {
           if (velocity > 0) padBtns[data1].dispatchEvent(new Event('mousedown', { bubbles: true }));
           else padBtns[data1].dispatchEvent(new Event('mouseup', { bubbles: true }));
        }
      }
    }
  }

  if (isCC) {
    // DDJ-400 Jog Wheel is usually CC 34
    if (data1 === 34) {
      spinJog(`jog-${deckStr}`, velocity);
    }
    
    // Tempo Slider (CC 0)
    if (data1 === 0) {
      mapSlider(`tempo-${deckStr}`, velocity);
    }

    // Mixer section
    // EQ High (CC 14)
    if (data1 === 14) mapSlider(`eq-hi-${deckStr}`, velocity);
    // EQ Mid (CC 10)
    if (data1 === 10) mapSlider(`eq-mid-${deckStr}`, velocity);
    // EQ Low (CC 7)
    if (data1 === 7) mapSlider(`eq-low-${deckStr}`, velocity);
    // Filter (CC 22)
    if (data1 === 22) mapSlider(`filter-${deckStr}`, velocity);
    // Trim (CC 4)
    if (data1 === 4) mapSlider(`trim-${deckStr}`, velocity);
    // Channel Fader (CC 19)
    if (data1 === 19) mapSlider(`vol-${deckStr}`, velocity);

    // Crossfader (CC 31)
    if (data1 === 31) {
      mapSlider('crossfader', velocity);
    }

    // Beat FX Depth Knob (CC 94)
    if (data1 === 94) {
      mapSlider('fx-depth', velocity);
    }
  }

  // FX ON/OFF Button (Note 71)
  if (isNoteOn && data1 === 71) {
    clickButton('btn-fx-toggle', velocity);
  }
}

# VVJ Splat

A browser-based **VJ tool for 3D Gaussian Splats** — load splats onto decks, mix
them like a DJ controller, and drive beat-synced visual FX live. Supports
Pioneer DDJ-400 / DDJ-FLX4 / DDJ-200, the ICON iDJ, and arbitrary MIDI
controllers via a custom mapping wizard, with output to a second screen.

**Live:** https://lebactan2.github.io/ddj-splat/

## Supported deck files
| Kind | Extensions | Notes |
| --- | --- | --- |
| Splats | `.ply`, `.splat`, `.ksplat` | |
| SOGS | `.sog`, `.ssog`, or a loose `meta.json` + `.webp` set | Select/drop the whole unbundled folder |
| SPZ | `.spz` | Niantic v2, v3 (gzip) and v4 (ZSTD streams) |
| Meshes | `.obj`, `.fbx`, `.usdz`, `.gltf`, `.glb` | Rendered as solid lit geometry; drop the `.mtl`/`.bin`/textures alongside |
| Images | `.png`, `.jpg`, `.webp` | Single-image 3D reconstruction via the Python backend |

A loaded mesh renders as real triangles (lit, textured) and the whole deck drives
it: it is cut into the same chunks as the splats, so slicing, the play pulse, EQ
band scaling, the chunk-range loop, roll, jog, volume, crossfade and the strobe
all apply. The FX follow too — flanger, phaser, pitch, the channel filter and the
filter FX run the same maths in the mesh's shader, and spiral/reverb draw the
same fading ghost trails. Uncheck **SOLID MESH** in the header to convert the
model to gaussian splats instead.

Two FX are adapted rather than copied: spiral stacks its ghosts further up the Y
axis and collapses them more gently (inside an opaque shell the splat version's
copies would never be seen), and reverb scatters one direction per chunk instead
of per splat.

A solid mesh never goes translucent. Where splats crossfade by alpha, a mesh
**shrinks out**: it stays fully opaque and its scale follows the crossfader, the
same language the volume fader already uses, so two models mixing still read as
solid objects. Ghost trails from spiral/reverb stay translucent (that is what
they are) and are drawn behind the model. The strobe/trans FX still flashes a
mesh by alpha, since that is a flash rather than a mix.

## KORG nanoKONTROL2

Built-in profile, factory ("CC mode") preset — no KORG Kontrol Editor setup
needed. Plug in, open the app, and it is auto-detected from the port name; if it
is not, pick **KORG nanoKONTROL2** in the MIDI dropdown in the header.

Deck A is the left half of the board (channels 1-4), deck B the right (5-8).

| Control | CC | Does |
| --- | --- | --- |
| Slider 1 / 2 | 0 / 1 | Deck A / B volume (scales the deck) |
| Slider 3 | 2 | Crossfader |
| Slider 4 | 3 | Master level → camera zoom |
| Slider 5 / 6 / 7 | 4 / 5 / 6 | FX depth: deck A / deck B / master |
| Slider 8 | 7 | Deck A tempo |
| Knob 1-3 | 16-18 | Deck A EQ HI / MID / LOW (cuts chunk bands) |
| Knob 4 | 19 | Deck A channel filter |
| Knob 5-7 | 20-22 | Deck B EQ HI / MID / LOW |
| Knob 8 | 23 | Deck B channel filter |
| SOLO 1-4 | 32-35 | Deck A: play, stop, sync, FX on/off |
| SOLO 5-8 | 36-39 | Deck B: play, stop, sync, FX on/off |
| MUTE 1-4 | 48-51 | Deck A: loop in, loop out, loop on/off, loop ½ |
| MUTE 5-8 | 52-55 | Deck B: loop in, loop out, loop on/off, loop ½ |
| REC 1-4 | 64-67 | Deck A hot-cue pads 1-4 |
| REC 5-8 | 68-71 | Deck B hot-cue pads 1-4 |
| ◀◀ / ▶▶ | 43 / 44 | Master FX beat ÷ / × |
| ■ / ▶ | 42 / 41 | Deck A stop / play |
| ● (REC) | 45 | Master FX on/off |
| CYCLE | 46 | RESET VIEW |
| TRACK ◀ / ▶ | 58 / 59 | Step deck A / deck B FX selection |
| MARKER SET | 60 | Step master FX selection |
| MARKER ◀ / ▶ | 61 / 62 | Deck A / B loop ×2 |

### Walkthrough

1. Connect the nanoKONTROL2 **before** loading the page (Web MIDI enumerates on
   startup), and allow MIDI access when the browser asks.
2. Check the header dropdown reads *KORG nanoKONTROL2*. Auto-detect matches the
   port name; selecting it by hand also locks auto-detect so it stops changing.
3. Load a scene on deck A with the ⏏ button, and a second one on deck B.
4. Push **slider 3** (crossfader) fully left, **sliders 1-2** up. Deck A is now
   what you see.
5. **SOLO 1** starts deck A's cut-up animation; **SOLO 5** does the same for B.
6. Turn **knobs 1-3** to cut deck A's chunk bands — HI is the outer shell, LOW
   the core. Same on **knobs 5-7** for deck B.
7. Pick an FX with **TRACK ◀**, set its depth with **slider 5**, and arm it with
   **SOLO 4**. The master FX equivalents are MARKER SET / slider 7 / REC.
8. Ride **slider 3** to bring deck B in.
9. **CYCLE** re-centres the view if a jog or an FX has thrown it off.

Anything you want moved: hit **MIDI MAP**, pick the action, and touch the
control. That override is stored per profile and survives reloads. If a button
latches instead of firing once, its mode was changed in the KORG Kontrol Editor
— set it back to *Momentary*.

Note the nanoKONTROL2 has no jog wheels, so scratching and jog nudges are
on-screen (or on a second controller) only. Its LEDs stay dark unless the unit
is switched to external LED mode in the Kontrol Editor; the app does not drive
them.

## DJC-DIY

Built-in profile for the [MandićLab DJC-DIY](https://github.com/mandiclab/djc-diy),
an open-source DJ controller you 3D-print and wire yourself around an Arduino Pro
Micro. Numbers come from that repo's `firmware/firmware.ino` (what the board
emits) read against its `mixxx mapping files/DJC-DIY.midi.xml` (what each control
means), so a stock build works unmodified.

Everything is on MIDI channel 1; the decks are split by note/CC number rather
than by channel.

| Control | MIDI | Does |
| --- | --- | --- |
| Jog wheel 1 / 2 | CC 0x14 / 0x15 | Deck A / B scratch (relative encoder) |
| Play/Pause 1 / 2 | Note 0x43 / 0x3F | Deck A / B play |
| Cue 1 / 2 | Note 0x42 / 0x40 | Deck A / B stop |
| Perf pad 1-2, deck 1 | Note 0x3C / 0x3D | Deck A pads 1-2 (loops) |
| Perf pad 1-2, deck 2 | Note 0x41 / 0x3E | Deck B pads 1-2 (loops) |
| Tempo fader 1 / 2 | CC 0x0E / 0x10 | Deck A / B tempo (inverted) |
| Crossfader | CC 0x0F | Crossfader (inverted) |
| EQ knob 1 / 2 | CC 0x0D / 0x0B | Deck A / B EQ LOW |
| FX knob 1 / 2 | CC 0x0C / 0x0A | Deck A / B channel filter |

Auto-detect matches the port name. The stock firmware doesn't set a USB product
string, so the board announces itself as *Arduino Micro* / *Arduino Leonardo* /
*Pro Micro* — those names select this profile too. If yours reports something
else, pick **DJC-DIY** in the header dropdown.

Its jog wheels are rotary encoders that send one message per detent with a fixed
0x41 / 0x3F payload, not a tick count — a different decode from the DDJ platters.
If you re-map a jog with **MIDI MAP**, pick the **Jog A/B (DIY encoder)** action,
not plain *Jog A/B*, or one detent reads as a ~63-tick sweep.

The device has no volume faders, hi/mid EQ, loop buttons or FX section, so those
stay on-screen. Every button, pot and encoder on the board is already mapped, so
re-mapping with **MIDI MAP** trades one function for another rather than filling
a gap. There is no MIDI output on this controller, so no LED feedback.

## Features
- Multi-deck Gaussian-splat mixing with an equal-power crossfader
- Beat-synced FX (roll, spiral, reverb, filter, flanger, phaser, trans, …)
- WebGL strobe layer rendered between the HDRI environment and the splats
- HDRI environments + (optional) Google Map background
- Adaptive resolution scaling for FPS under heavy zoom/overdraw
- Web MIDI: built-in DDJ-400 / DDJ-FLX4 / DDJ-200 / iCON iDJ / KORG
  nanoKONTROL2 / DJC-DIY profiles + a
  **Guided Map** wizard to map and save a custom profile for *any* controller
- Second-screen output (mirrors the render to a fullscreen window)

## Develop
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs dist/
```

## License
This project is licensed under **Creative Commons Attribution 4.0 International
(CC BY 4.0)** — see [LICENSE](./LICENSE). You may share and adapt it, including
commercially, **with attribution** to *VVJ Splat (lebactan2)* and a link to the
license.

Bundled libraries — [@mkkellogg/gaussian-splats-3d](https://github.com/mkkellogg/GaussianSplats3D),
[three.js](https://threejs.org), and [Vite](https://vitejs.dev) — remain under
their own MIT licenses.

---

# Migration Guide

To move this project seamlessly to another PC, you have two options. The **Colab Route** is the easiest and works on any PC (even laptops without GPUs). The **Local Route** requires setting up the heavy AI models again.

## 🚀 Option A: The Easy Way (Using Google Colab Backend)

If you plan to use Google Colab to handle the 3D processing, moving the project is extremely simple:

1. **Copy the Folder:** Copy your entire `splat-cutup` folder to a USB drive or cloud storage and paste it onto the new PC.
2. **Install Node.js:** Download and install [Node.js](https://nodejs.org/) on the new PC.
3. **Install Dependencies:** Open a terminal (Command Prompt or PowerShell) inside the copied `splat-cutup` folder and run:
   ```bash
   npm install
   ```
4. **Run the App:**
   ```bash
   npm run dev
   ```
5. **Start the Backend:** Just like before, upload `backend/colab_backend.ipynb` to Google Colab, hit "Run All", and paste the Cloudflare URL into the DJ app's backend settings!

---

## 💻 Option B: The Local Way (Running the AI on the new PC's GPU)

If your new PC has a powerful Nvidia GPU and you want to run the 3D generation locally without the internet, you will need to re-setup the Python environment.

1. **Copy the Folders:**
   Copy the `splat-cutup` folder AND your `E:\gaussian real time\splatter-image` folder to the new PC.
2. **Start the Frontend:**
   Just like Option A, install Node.js, open a terminal in `splat-cutup`, run `npm install`, and then `npm run dev`.
3. **Update the Python Script:**
   Open `splat-cutup/backend/server.py` in a text editor. Near the top, you will see this line:
   ```python
   SPLATTER_DIR = "E:\\gaussian real time\\splatter-image"
   ```
   Change this path to wherever you placed the `splatter-image` folder on your new PC!
4. **Setup Python:**
   - Install Python on the new PC.
   - Re-create the virtual environment inside your `splatter-image` folder.
   - Re-install the requirements: `pip install torch torchvision rembg fastapi uvicorn python-multipart plyfile einops imageio imageio-ffmpeg omegaconf`
5. **Run the Backend:**
   Open a terminal, activate your python environment, and run:
   ```bash
   python "C:\path\to\splat-cutup\backend\server.py"
   ```

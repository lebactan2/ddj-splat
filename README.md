# VVJ Splat

A browser-based **VJ tool for 3D Gaussian Splats** — load splats onto decks, mix
them like a DJ controller, and drive beat-synced visual FX live. Supports
Pioneer DDJ-400 / DDJ-FLX4 / DDJ-200, the ICON iDJ, and arbitrary MIDI
controllers via a custom mapping wizard, with output to a second screen.

**Live:** https://lebactan2.github.io/ddj-splat/

## Features
- Multi-deck Gaussian-splat mixing with an equal-power crossfader
- Beat-synced FX (roll, spiral, reverb, filter, flanger, phaser, trans, …)
- WebGL strobe layer rendered between the HDRI environment and the splats
- HDRI environments + (optional) Google Map background
- Adaptive resolution scaling for FPS under heavy zoom/overdraw
- Web MIDI: built-in DDJ-400 / DDJ-FLX4 / DDJ-200 / iCON iDJ profiles + a
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

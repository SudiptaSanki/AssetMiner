# Asset Miner

A local-first Chrome extension (Manifest V3) for progressive source code recovery, folder tree reconstruction, and asset extraction from visible web environments.

Repository: [https://github.com/SudiptaSanki/AssetMiner](https://github.com/SudiptaSanki/AssetMiner)

---

## Overview

Asset Miner helps you organize, inspect, and export source code and assets directly from web-based IDEs, code editors, and previews:
- **Intelligent Tree Scanning:** Discovers folder structures and hierarchies dynamically, preserving original layout and nesting even as items scroll in and out of view.
- **Progressive Line Capture:** Seamlessly merges visible lines from virtualized editors (CodeMirror 6, Monaco, CodeMirror 5, Ace, and plain code blocks) without duplicates.
- **Short & Long File Detection:** Automatically captures short files in a single view; provides live guidance to scroll long files top-to-bottom for full coverage.
- **Side-by-Side IDE Explorer:** Follows your active file in real-time, displays live code/image previews, and allows manual editing or pasting before export.
- **Asset Extraction & Export:** Downloads full project source code as a structured ZIP, complete with binary assets (images, icons, SVGs) and an honest verification report.
- **Local & Private:** Runs entirely within your browser using local storage (IndexedDB). No external servers, no telemetry.

---

## Quick Setup

### Prerequisites
- Node.js (v18 or later recommended)
- npm

### Installation & Build

```bash
# Clone the repository
git clone https://github.com/SudiptaSanki/AssetMiner.git
cd AssetMiner

# Install dependencies
npm install

# Run test suite
npm test

# Build extension
npm run build
```

The build outputs to `dist/` (and mirrors a copy to `extension/`).

---

## Loading into Chrome / Chromium Browsers

1. Open `chrome://extensions` in your browser.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `dist/` folder (or `extension/` folder) from the project directory.
5. Click the Asset Miner icon in your toolbar to open the dockable panel on any page.

---

## Usage Guide

1. **Browse & Expand:** Navigate to your web IDE or coding workspace. Open or expand the folders in the website's sidebar tree to let Asset Miner detect the directory hierarchy.
2. **Follow & Capture:**
   - Click a file in the website tree or use the live *On page* bar to follow it.
   - For short files, content is detected and verified automatically.
   - For long virtualized files, scroll smoothly from top to bottom so all lines render and record into the session.
3. **Review & Edit:** Use the **Project Explorer** tab to inspect captured lines, view image previews, or use **Edit / Fix Code** to make manual corrections.
4. **Export:** Go to the **Export Center** to download your full project archive as a clean ZIP package.

---

## License

This project is open-source under the [MIT License](LICENSE).
Author: [Sudipta Sanki](https://github.com/SudiptaSanki)

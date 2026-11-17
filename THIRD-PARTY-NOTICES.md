# Third-Party Notices — Software Bill of Materials

Asset Miner bundles only open-source dependencies, all locally (no CDN runtime
dependencies). Build-time tooling is listed for completeness.

## Runtime dependencies (bundled into the extension)

| Package | Version | License | Use |
|---|---|---|---|
| react | ^19 | MIT | Panel UI |
| react-dom | ^19 | MIT | Panel UI renderer |
| jszip | ^3.10 | MIT (or GPLv3, MIT chosen) | ZIP generation |
| idb | ^8 | ISC | IndexedDB wrapper |

## Development dependencies (not shipped)

| Package | Version | License |
|---|---|---|
| typescript | ^5.9 | Apache-2.0 |
| vite | ^6 | MIT |
| @vitejs/plugin-react | ^4 | MIT |
| vitest | ^3 | MIT |
| fake-indexeddb | ^6 | Apache-2.0 |
| happy-dom | ^17 | MIT |
| @types/chrome | ^0.1 | MIT |
| @types/react / @types/react-dom | ^19 | MIT |

All licenses permit use, modification and redistribution in open-source and
commercial software. Full license texts are available in each package under
`node_modules/<pkg>/LICENSE`.

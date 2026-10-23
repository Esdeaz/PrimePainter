# Contributing to PrimePainter

PrimePainter is an independent PBR texture editor. Keep contributions focused on working tools, accurate behavior, and the existing architecture. Contributions are made under the repository's [MIT license](LICENSE); retain any applicable third-party notices.

## Requirements

- Node.js 22.12.0 or newer and npm.
- Windows with Microsoft Edge installed for the current automated test configuration.
- A desktop session and GPU/WebGL support for browser and Electron rendering tests.

The current portable packaging target is Windows. Other operating systems and unattended CI environments have not been validated. Installing dependencies requires network access, including the Electron runtime download.

## Setup and commands

Run commands from the repository root:

```powershell
npm ci
npm run dev
```

`npm ci` installs the versions recorded in `package-lock.json`. Commit both the manifest and lockfile when intentionally changing dependencies.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite browser workspace on localhost. |
| `npm run desktop` | Build the renderer, then launch Electron. |
| `npm run build` | Check TypeScript and build the production renderer into `dist/`. |
| `npm test` | Run the desktop self-check and Playwright browser/Electron tests. |
| `npm run package` | Build and package the Windows portable executable into `release/`. |

Build before running tests:

```powershell
npm run build
npm test
```

The production Electron test loads `dist/index.html`; `npm test` does **not** rebuild it. Rebuild after renderer changes so the native test exercises the same source as the browser tests. Playwright uses installed Edge and starts Vite on `127.0.0.1:5173`; keep that port available or ensure an existing server belongs to this checkout.

Test artifacts belong in `test-results/playwright/`. Keep manual Electron profiles outside that directory: Playwright clears its output directory before a run, and an open profile can lock files. Generated builds, test output, local profiles, and credentials do not belong in commits.

## Where changes belong

| Location | Responsibility |
| --- | --- |
| `src/main.ts` | Application UI, commands, project workflows, recovery, and texture export. |
| `src/engine.ts` | Raster painting, PBR composition, layers, masks, history, and validated texture project data. |
| `src/viewport.ts` | Three.js rendering, model import, UV picking, texture uploads, and UV overlay caching. |
| `src/demo-model.ts` | Procedural demonstration geometry and UV layouts. |
| `src/shortcuts.ts` | Keyboard shortcut resolution. |
| `src/styles.css` | Workspace appearance and layout. |
| `electron/main.cjs` | Privileged window operations, native dialogs, validated IPC, and atomic file saving. |
| `electron/preload.cjs` | The narrow renderer-to-desktop bridge. |
| `electron/self-check.cjs` | Desktop IPC and file-operation contract checks. |
| `tests/` | Engine, viewport, UI, keyboard, and production Electron regressions. |
| `docs/` | Reference research and the feature implementation matrix. |

Extend these components before adding another state store, painting system, file bridge, or rendering layer. Use repository-relative fixtures and runtime platform paths; never introduce fixed developer drive paths or home directories.

## Making a change

- Read the connected callers and preserve existing project data and error handling. Keep the diff limited to the requested behavior.
- Add a focused regression for nontrivial changes. Painting optimizations should preserve pixels and undo; compare partial composition with a full recomputation. Rejected imports and project loads must leave the open project intact.
- Keep IPC sender/frame checks, payload validation, file size limits, renderer isolation, and atomic saving. Expose specific bridge operations rather than arbitrary filesystem access from the renderer.
- Measure performance in a stated environment. Separate CPU painting/composition time from GPU rendering and frame timing; do not trade away resolution or channels without making that behavior explicit.
- Include only code and assets you may distribute, and document additional licenses. Adobe formats and features that remain unsupported must stay clearly identified.
- Explain the problem, resulting behavior, checks run, and remaining limitations in the pull request. Update the README and feature matrix when supported behavior changes. Report untested tablet, large-project, platform, or native-dialog behavior accurately.

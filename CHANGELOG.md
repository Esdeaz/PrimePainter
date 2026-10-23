# Changelog

## Unreleased

- Prepare the source repository for GitHub with English documentation, an MIT license, dependency notices and clean source packaging.
- Keep generated files, local projects and third-party research images out of version control.

## 0.1.1 — 2026-10-24

- Fix Windows mesh import and file saving with visible native dialogs.
- Support editor shortcuts with Russian keyboard layouts.
- Cache the UV wireframe and limit painting updates to changed regions and channels without lowering texture resolution or render quality.
- Add regression coverage for native imports, cancellation, keyboard layouts and incremental texture updates.

## 0.1.0 — 2026-10-24

- Initial experimental PBR painting workspace with a Three.js viewport and an Electron desktop shell.
- Add OBJ/GLB import, 3D and UV painting, layers, masks, undo/redo, `.prime` projects and PNG texture export presets.

# AGENTS.md — smart-home tray

Read `docs/PROJECT.md` first. The approved journeys in `.graphhelm/journeys/*.journey.yaml` are the
contract for the UI: headings, button names, roles and the `?fixture=` URLs must match exactly.
Never edit or re-approve journey files.

## Architecture (fixed — do not change without the orchestrator)
- Electron + TypeScript + React, bundled with `electron-vite`. Node 22+. Package manager: npm.
- `src/shared/` — types and IPC contract shared by main and renderer. `src/shared/types.ts` owns
  `Room`, `Light`, `AirConditioner`, `LightState`, `AcState`, `DeviceCommand`.
- `src/main/` — Electron main process: tray icon, frameless popup window near the tray, IPC handlers.
  - `src/main/tuya/` — Tuya local protocol (3.3/3.4/3.5) client + Smart Life QR login discovery.
  - `src/main/lg/` — LG ThinQ Connect REST client (PAT from `LG_PAT`, country `LG_COUNTRY`).
  - `src/main/store/` — config + secrets (Electron `safeStorage`), loads `.env` via `dotenv`.
- `src/renderer/` — React UI. Dark, rounded cards, like the reference AC widget.
- The renderer talks to devices ONLY through `window.api` (preload, `src/preload/`).
- **Fixture mode**: when the URL has `?fixture=house` or `?fixture=empty`, or when the renderer runs in
  a plain browser (no `window.api`), use `src/renderer/fixtures/` fake data and fake API. The Vite dev
  server must serve the renderer on `http://127.0.0.1:5173` so journeys run in a normal browser.

## Rules
- Branch `issue-<N>-<desc>`, one PR per issue, body has `Closes #N`, tests run + results.
- Only touch the paths your issue names. Need more? Say so in the PR, don't spread.
- Secrets: never log, print, commit or put in fixtures the values of `.env` keys, local keys or tokens.
- Windows: any child process hidden (`windowsHide: true`). No visible console windows.
- CI is local: `sh ci/local-ci.sh` (typecheck + lint + unit tests). Must pass before push.
  GitHub Actions is disabled on purpose — never add or enable workflows.
- Tests: vitest for units. No network in unit tests (mock sockets/fetch).
- Commit body first line after subject: `Session: <name> · Head: <sha8>` is added by the orchestrator;
  you just write a normal conventional commit ending with
  `Co-Authored-By: Codex <noreply@openai.com>`.

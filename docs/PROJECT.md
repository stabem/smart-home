# Smart Home Tray

## Problem
Gabriel controls the house lights through the Smart Life app and the LG air conditioners through the
LG ThinQ app, both on the phone. On the PC there is no fast way to switch a light or the AC.

## Promise
From the Windows system tray, in two clicks, Gabriel switches any light or room and any LG AC in the
house, without opening a phone app and without unlinking anything from Smart Life or ThinQ.

## Actors
- **Gabriel** — only user, on his Windows 11 PC on the home Wi-Fi.
- **Tuya devices** — lamps and smart switches (Smart Life). Controlled over the LAN with the Tuya
  local protocol (3.3/3.4/3.5) using each device's local key.
- **Tuya IoT Cloud** — used once (and on "Refresh devices") to read device ids, local keys and rooms.
- **LG ThinQ Connect API** — official cloud API, personal access token (PAT), for the 3 ACs.

## Rooms
| Room | Lights | AC |
|---|---|---|
| Entrada | yes | — |
| Cozinha | yes | — |
| Mesa de jantar | yes | — |
| Sala de estar | yes | yes |
| Banheiro | yes | — |
| Banheiro da suíte | yes | — |
| Office | yes | yes |
| Quarto | yes | yes |

## Journeys
1. **toggle-room-lights** — Click tray icon → popup "Casa" with room list → click a room's light
   button → every light in the room turns on/off; the button state matches the real devices.
2. **adjust-light** — Popup → click room name → room screen → light card: on/off, brightness slider,
   color/white-temperature picker (only where the device supports it).
3. **control-ac** — Popup → room with AC → AC card like the reference: room temperature, power
   button, target temp (− / slider 16–30 / +), Modo, Ventilação, Turbo toggle, "Atualizado" status.
4. **first-setup** — First run with no config → "Configurar" screen: status of `.env` (LG token,
   Tuya keys) → "Buscar dispositivos" → devices listed per room → "Salvar".

Screens: tray popup (room list), room screen, setup screen.

## Risks
- Secrets: LG PAT, Tuya access secret, device local keys. Kept in `.env` and an OS-encrypted store
  (Electron `safeStorage`); never committed, never logged.
- Wrong command to AC is reversible (user can switch it back). No money, no personal data.
- Device on unreachable IP → show "offline", never hang the UI.

## Out of scope (v1)
Scenes, schedules, voice, phone/remote access, non-Tuya/non-LG devices, multi-user.

## Stack
Electron + TypeScript, `tuyapi`-style local protocol client, LG ThinQ Connect REST.
Runs at Windows login, tray only (no taskbar window), all child processes hidden.

## v1 done
Journeys 1, 2 (on/off + brightness), 3 (power + temperature) and 4 pass on the real house.

## Open questions
- Exact LG AC model capabilities (mode/fan lists) — read from the ThinQ device profile at runtime.
- Tuya protocol version per device — detected at setup.

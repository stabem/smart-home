# Design — Smart Home Control Center

The tray panel follows the compact macOS Sonoma/Sequoia Control Center. References: [Apple Community Sonoma screenshot](https://discussions.apple.com/thread/255659893) and [Control Center screenshot](https://www.imobie.com/screen-mirror/how-to-airplay-on-mac.htm). The useful pattern is one frosted floating sheet, a tight arrangement of separate rounded modules, circular active controls, and wide filled sliders.

## Window

- 420 × 640 frameless Electron window, transparent, with Windows 11 acrylic material. The renderer tints the desktop at roughly 68% opacity and blurs it by 42 px. The glass has a 20 px radius, one 1 px light inner stroke, and an outer shadow. No title bar or scrollbar gutter.
- When the OS asks for reduced transparency, use an opaque surface with the same readable contrast.
- Follow the system light or dark mode. Switzer, bundled locally, stands in for SF Pro: 13 px body and module titles, 11 px secondary text, tight tracking, tabular temperatures. Sentence case throughout.

## Modules

- Modules have 15–16 px radii, 8 px gaps, 10–12 px padding, and a quiet fill: about 10% white in dark mode and a pale tint on light glass. No module borders or interior shadows.
- Active lights use a warm amber circular button. Active AC uses restrained cool blue. Offline and partial failures use a small red message with the device name.
- Home shows **Casa**, a compact summary with **Apagar tudo**, and all eight rooms in a two-column grid. Room name opens the room; the separate circular light button changes the room. A grouped track counts as one light. Cloud operation is a small glyph with a tooltip.
- Room view shows **Voltar**, then the room name and one module per light or group. No count-and-AC metadata line. A group shows its name and member count, with one power button, brightness control, and inline color controls.
- Brightness uses a 30 px filled pill with a sun inside the track and no visible thumb. **Cor** reveals round swatches below the other controls in normal document flow. Expanding it must never overlap the next module.
- AC uses one module: current and target temperatures, small circular minus/plus buttons, a temperature slider, and compact **Modo**, **Ventilação**, and **Turbo** pills. Keep **Atualizado** or **Offline** visible.
- Room content scrolls inside the fixed window only when necessary. The scrollbar is transparent until hover and never reserves a Windows gutter.
- Toggles and expansion use a 180–220 ms ease-out. The room enters with a short 200 ms slide. Reduced motion removes these effects. Idle home schedules no animation frames.

## Group behavior and setup

- Lights in the same room with a shared base and `_N` suffix are suggested as a group. `Office_1` through `Office_4` become **Trilho do Office**. Setup lets the user create a group, edit its name and members, or ungroup it. Membership is saved in the encrypted setup store.
- A command to a group runs against all members in parallel. Group power is on if any member is on. Brightness and color come from the first online member. A partial failure names each member that failed.
- The last requested group state is saved. On refresh, the default-on sync guard reapplies it only to members whose live state drifted. Settings has a switch to turn this guard off.

## Setup and proof

**Configurar** keeps the same glass surface, clear connection status, User Code, QR action, discovery, room assignment, group editor, and **Salvar**. Never display secret values.

Use `/?fixture=house` and `/?fixture=empty` on a free local port. The approved `.graphhelm/journeys/` files fix accessible headings, button names, roles, and fixture URLs. Save light and dark 420 × 640 home, Office track, and AC screenshots on a wallpaper-like backdrop in `test-results/design/`. Inspect the captures against the reference for fit, density, glass, modules, sliders, and overlap. Check keyboard focus, reduced motion, contrast, and axe.

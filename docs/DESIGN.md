# Design — Smart Home Tray

The tray popup should feel like a small macOS Sonoma widget or Control Center panel: quiet, precise and useful at a glance. The apartment's light oak, pale plaster and graphite palette supplies warmth without drawing an illustration of the home.

## Window and surface

- One 420 × 640 frameless, transparent Electron window. On Windows, request the native acrylic material. The renderer uses a translucent tint, 38 px backdrop blur, a 24 px radius, a hairline inner edge and one soft window shadow.
- Follow the system light or dark appearance. When the OS requests reduced transparency, use an opaque surface with the same contrast. No visual content requires transparency to be understood.
- Tiles and controls have subtle borders and their own translucent fill. Keep shadows on the outer panel only. Selected lights are warm; active AC is cool blue. Offline and errors use a restrained red.
- Type is Switzer, bundled offline during installation. It has a close, calm rhythm to SF Pro. Use tight spacing for large temperatures and tabular numerals. Sentence case throughout.

## Home

The header says **Casa** and holds settings. A small status panel reports room and light counts with **Apagar tudo**. **Cômodos** is a two-column grid. Each rounded room tile has an icon, name, live state and a separate light button. Tapping the tile opens its room; tapping the icon button switches the room lights. AC rooms show a large temperature. The accessible list is the grid itself, so keyboard and pointer users reach the same controls.

## Room

**Voltar** returns home. The room title and small category strip lead into device panels. Light panels show a switch, a thick filled brightness slider, and **Cor**, which reveals the device's available color and white-temperature controls. AC panels show ambient and target temperatures, power, target slider, minus/plus, and compact **Modo**, **Ventilação**, **Turbo** controls. The current status remains visible as **Atualizado** or **Offline**.

The room view enters with a short, subtle transition. Reduced motion removes it. The bundled bulb and airflow Lottie assets play only while active; the home view schedules no animation frames while idle.

## Setup and copy

**Configurar** uses the same glass panel, clear connection statuses, User Code field, QR action, device search, room assignment and **Salvar**. Buttons name their action. Errors state which device failed and what to check.

## Proof

Use the fixture URLs `/?fixture=house` and `/?fixture=empty` on a free local port. The approved journeys in `.graphhelm/journeys/` fix the headings, roles and accessible names. Save light and dark screenshots on a soft wallpaper-like backdrop in `test-results/design/`. Check keyboard focus, reduced motion, contrast and axe.

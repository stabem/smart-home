# Design — Smart Home Control Center

The tray uses the visual language of macOS Control Center: one frosted sheet over wallpaper, compact rounded modules, direct circular controls, and filled pill sliders. References: the [Apple Control Center screenshot](https://support.apple.com/guide/mac-pro/control-center-apdc362a41b2/mac) and an [unannotated macOS Ventura screenshot](https://www.techrepublic.com/article/customize-macos-ventura-control-center/). Copies are in `test-results/design/reference/`; the unannotated screenshot is used in the side-by-side composite.

## Window and type

- The popup is 420 × 640 px. The browser fixture draws a soft wallpaper gradient behind it so the glass can be judged.
- Dark glass is `rgba(30,30,32,.62)`; light glass is `rgba(245,245,250,.72)`. It has a 0.5 px inner white stroke (18% dark, 12% light), a 24 px radius, and no outer border. Reduced transparency uses an opaque sheet.
- Use system UI type, with SF Pro where available and Segoe UI on Windows. Text is compact and tabular numbers keep temperatures stable.
- Modules use a 16 px radius, 8 px gaps, quiet translucent fill, and no decorative borders. Interactive elements have visible keyboard focus.

## Home

- The header is **Casa** at 22 px/600 with a gear. There is no overline or summary banner.
- **Cômodos** has a small **Apagar tudo** text button at its right only when at least one light is on.
- Eight rooms form two columns of 88 px tiles with 8 px gaps, all visible without scrolling.
- Each tile has one 36 px circular bulb button at top left, an AC temperature at top right when applicable, then the room name at 15 px/600 and state at 13 px. The room name opens the room. The circle alone controls its lights.

## Room controls

- A simple **Voltar** row precedes a plain 24 px/600 room title. There is no shared surface behind the title.
- Every light and group has one 36 px circular bulb switch. On is amber `#FFB84D` with a white glyph and a soft 0.5 px inner highlight. Off is 12% white in dark mode or 6% black in light mode, with a 60% glyph. Pressed scale is 0.94.
- A dimmable light gets a 30 px filled pill slider below the header. The sun sits inside the left end and the percentage inside the right end. A drag can show a small value bubble.
- Color-capable lights always show five 22 px round swatches and a round **+** button. That button has the accessible name **Cor** and reveals the custom picker and temperature control in normal flow.
- The AC header is a 36 px snowflake circle, name, and 36 px circular power button. Both circles turn blue `#5AC8FA` when on. The body has **Ambiente 24°** at 13 px, a centered tabular 34 px target with 32 px minus and plus circles, a slider, and three equal-width pills. **Atualizado** or **Offline** stays visible.

## Behavior and proof

- Device commands remain optimistic: the pressed control updates immediately, a pending dot is local to it, and a failure restores the last confirmed state with an inline message. Brightness and target temperature drags coalesce for about 150 ms.
- React Aria keeps switch, toggle, slider, and button roles. The approved `.graphhelm/journeys/` names and fixture URLs are unchanged.
- Motion keeps the short room transition, module layout and custom-control expansion. Reduced motion removes those effects. Idle home schedules no animation frames.
- Setup retains LG and Tuya status, User Code, QR action, discovery, room assignment, group editing, and save. No secret value appears in the UI.
- Use the fixture on a free port. Capture light and dark home, Office room, AC on, and setup at 420 × 640. Inspect every capture and the side-by-side composite with the real reference. Block on overlap, duplicate bulb icons, elements outside modules, misaligned baselines, or axe serious/critical findings.

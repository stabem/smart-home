# Design — Smart Home Tray

Source of truth for the look: the owner's interior project (light oak, off-white plaster, graphite
metal, concrete grey, warm 2700 K light). The widget should feel like a scale model of the
apartment, not a generic dashboard.

## Tokens

| Token | Light (day) | Dark (night) | Use |
|---|---|---|---|
| `--plaster` | `#EEEBE5` | `#1F1E1C` | background |
| `--plaster-2` | `#F7F5F1` | `#2A2826` | raised surfaces |
| `--oak` | `#C8A47E` | `#B08D66` | wood accents, selected room, sliders |
| `--graphite` | `#2A2A2C` | `#ECE8E1` | text, icons, frames |
| `--concrete` | `#B8B4AD` | `#5A5650` | walls in the 3D model, borders |
| `--glow` | `#FFD69A` | `#FFC874` | light ON (room floor glow, toggles) |
| `--air` | `#86BFE6` | `#7AB6E0` | AC ON (cool ripple, AC controls) |
| `--alert` | `#B4462F` | `#E07A60` | offline / error only |

- Theme follows `prefers-color-scheme` (Windows theme). Contrast ≥ 4.5:1 for text; `--glow`/`--air`
  are never used as text colour on `--plaster`.
- Type: **Hanken Grotesk** (bundled via `@fontsource-variable/hanken-grotesk`, no network), one
  family. Scale 12 / 14 / 16 / 20 / 28 / 44. Big temperature numerals: 44, weight 300, tabular.
  Sentence case everywhere. No all-caps labels.
- Radius by hierarchy: popup 18, panels 14, controls 10, chips full. Shadows only on the popup.

## Layout (popup ~420 × 640, frameless, anchored to tray)

```
┌──────────────────────────────────────┐
│ Casa                     21°C   ⚙    │  heading + outside/indoor temp + settings
│ ┌──────────────────────────────────┐ │
│ │   3D model of the apartment      │ │  the memorable element (≈ 260 px tall)
│ │   rooms glow when lit, ripple    │ │
│ │   when AC is on; click = select  │ │
│ └──────────────────────────────────┘ │
│ Cômodos (list, scrolls)              │  accessible mirror of the map
│  Sala de estar   ●luz   ❄22°   [⏻]   │  "Luzes <Room>" toggle + "Abrir <Room>"
│  Office ...                          │
└──────────────────────────────────────┘
Room view: camera flies to the room; panel slides up with light cards
(switch, Brilho, Cor) and the AC card (reference tweet layout: room temp,
power, − Temperatura +, Modo, Ventilação, Turbo, Atualizado). "Voltar" returns.
```

Left-aligned text. The model and the list are always in sync (hover/focus a row highlights the room
and vice versa).

## 3D model

- three.js (`three` npm, bundled). Orthographic camera, isometric-ish (≈ 35° tilt, 45° yaw), limited
  orbit (yaw ±30°), no free zoom. Floors are flat slabs in `--plaster-2`, walls extruded 0.35 units
  in `--concrete`, oak floor in Sala/Office/Suíte. Light ON = emissive `--glow` floor + soft point
  light; AC ON = slow `--air` ripple ring on the floor. Offline = desaturated with a small `--alert` dot.
- `prefers-reduced-motion`: no camera flights (cut), no ripple animation (static ring).
- Canvas has `aria-hidden="true"`; the room list is the accessible control surface. Each room mesh
  is also reachable by Tab through the list.
- Fallback: if WebGL fails, render the same rooms as a flat SVG plan.

## Floor plan (metres, origin = top-left of the drawing, x right, y down)

Derived from `DETALHAMENTO TECNICO - ANTEPROJETO.pdf` sheet 01 (1:100). Rectangles `x, y, w, h`.
`room` = id used by the app (matches docs/PROJECT.md); `—` = drawn but has no devices.

| Area on plan | room | x | y | w | h |
|---|---|---|---|---|---|
| Entrada (hall by the front door) | entrada | 0.0 | 4.7 | 1.2 | 1.5 |
| Cozinha | cozinha | 1.2 | 3.1 | 3.8 | 3.0 |
| Sala de jantar | mesa-de-jantar | 0.0 | 6.1 | 6.5 | 3.1 |
| Sala de estar | sala-de-estar | 0.0 | 9.3 | 3.2 | 3.9 |
| Home office | office | 3.3 | 9.3 | 3.2 | 3.9 |
| Banho social | banheiro | 4.9 | 4.9 | 1.6 | 3.2 |
| Closet | — | 6.5 | 4.9 | 3.2 | 3.2 |
| Suíte | quarto | 6.6 | 8.6 | 3.1 | 4.6 |
| Banho suíte | banheiro-da-suite | 5.1 | 13.3 | 2.8 | 2.0 |
| Área de serviço | — | 5.0 | 1.7 | 1.6 | 3.1 |
| Pets | — | 3.9 | 0.0 | 2.6 | 1.7 |
| Varanda (estar/office) | — | 0.0 | 13.3 | 5.0 | 0.7 |
| Varanda (suíte) | — | 7.9 | 13.3 | 1.7 | 0.7 |

ACs sit on the outer wall of Sala de estar, Office and Suíte (y ≈ 13.0).
Store this as data in `src/renderer/map/floorplan.ts`; never commit the source PDFs or renders.

## Copy

Buttons say what happens: "Ligar luzes", "Desligar ar", "Salvar". Errors say what broke and what to
do: "Luz da cozinha não respondeu. Ela está ligada na tomada?" No apologies, no exclamation marks.

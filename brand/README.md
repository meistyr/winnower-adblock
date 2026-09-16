# winnower brand

```
npm run brand
```

Regenerates every mark and toolbar icon from `build.ts`. Don't hand-edit the outputs; change the
script and rebuild. The script prints its measurements and exits non-zero if any of them drift.
The icons are committed, so `npm run update` copies them in without needing the rasteriser.

| File | Use |
|---|---|
| `winnower-mark-on-{light,dark}.svg` | Bare leaf. Where the mark sits directly on a page: README headers, favicons, inline next to text. |
| `winnower-chip-on-{light,dark}.svg` | Leaf cut out of a turned tile. Where the mark has to hold its own shape: toolbar, store listing, avatars. |
| `winnower-lockup-on-{light,dark}.svg` | Leaf + `winnower_` wordmark, outlined (no font needed). |
| `readme/lockup-on-{light,dark}.svg` | The repository README's logo. Ink baked in, because GitHub shows README images through `<img>`; the README picks one with `<picture>`. |
| `icons/chip-on-{light,dark}-{16,32,48,128}.png` | Chrome icons. The service worker swaps the toolbar set to match Chrome's light or dark mode. |

`on-light` and `on-dark` name the **background** the file is for. Use the matching one: the two
are drawn differently, not just recoloured.

## Colour

- **Marks are monochrome.** The SVGs use `currentColor`, so inline they take the surrounding
  text colour. Loaded through `<img>`, `currentColor` has nothing to inherit and draws black.
- **The `_` is the popup's `--on` green, `#7bd88f`.**
- **The PNG ink is the popup's `--bg` (`#0f1310`) on light toolbars, and `--text` (`#ececec`) on dark.**
- The build reads all three from `src/popup.html`, so changing the popup palette and rerunning
  `npm run brand` keeps the icons in step.
- The green is made for the dark popup (10.8:1 on `#0f1310`). On white it is pale, 1.7:1.

Files are cropped tight to the ink. Leave clear space around them where they're placed.

## Why it looks the way it does

Measured, not eyeballed, except where noted:

- **Leaf.** A leaf with its tip cut off along a straight line.
- **Wordmark.** Geist Mono Medium, `winnower_`.
- **Tilt 34.04°.** The leaf turns until its cut runs parallel to the outer left stroke of the `w`,
  which sits at 79.04° in the font's outline, (18,532) → (121,0).
- **Lockup height.** The icon is centred on the middle of the x-height. It reaches as far above
  the letters as it drops below the baseline (148.9 font units each way).
- **Lockup gap 115.76.** The space between the cut and the `w` is the same as the space between
  the `o` and the second `w`. That's the one letter pair that leads into a `w`'s left edge.
- **Chip turn −10.96°.** The tile turns until its right side is parallel to the cut. In the
  tile's own frame the leaf then sits at exactly 45°.
- **Chip gaps 7 / 7 / 7 / 7.** Measured at right angles to the tile's edges. At 45° the leaf is
  wider than it is tall, so the tile is 48 × 43.96 rather than square. One accepted cost: the
  leaf comes within 5.5 of a rounded corner, closer than its 7 from the straight edges.
- **Thinner leaf where it is light (judged by eye).** A light shape on a dark ground looks heavier
  than the same shape dark on light (irradiation). Wherever the leaf itself is light, it is drawn
  with a stem of 3.0 instead of 3.6, a vein of 2.2 instead of 1.8, and its outline pulled in 0.3
  (64-grid units). That means bare and lockup on dark, and the chip on light, where the cut-out
  shows the light background. Placement is always measured on the regular leaf, so both sit in
  the same spot.
- **Toolbar icons fill their square.** The PNGs are cropped to the turned tile's own rounded edges
  (51.7 × 48.5 grid units), so the tile touches the icon's left and right edges and draws 1.24×
  larger than the chip SVG, which keeps its 64-grid margin.
- **16px.** The vein would be under half a pixel, so it is dropped. The stem is held at one pixel.

# WORLDSMITH — Explorable Halloween 3D Worlds

Spooky explorable environments generated with World Labs' Marble API (Gaussian
splats), hosted on Namecheap, viewable in browser + VR (WebXR).

**Target: soft-launch before Oct 31.** 🎃

## Architecture (locked 2026-09-18)

- **100% custom static site — no WordPress, no PHP, no DB.**
- **Manifest-driven:** adding a world = drop `.ply` in `worlds/` + one line in
  `site/manifest.json` (id, title, description, thumbnail, splat path, tiers).
  Gallery + viewer pages both render from the manifest.
- **Viewer:** PlayCanvas [SuperSplat Viewer](https://github.com/playcanvas/supersplat-viewer)
  — static, open source, WebXR (VR in Quest browser).
- **Deploy:** rsync over SSH to Namecheap cPanel (`public_html` or subdomain folder).

## Layout

```
worldsmith/
├── site/            # static site (gallery, viewer, assets) — deploys as-is
│   ├── index.html
│   ├── world.html   # per-world viewer page (?world=<id>)
│   ├── manifest.json
│   └── assets/      # css, js, fonts, audio
├── worlds/          # exported .ply splats (NOT committed to git if huge — see .gitignore)
├── pipeline/        # Marble API scripts (generate, poll, export)
├── deploy/          # deploy script + rsync config
├── docs/            # world briefs, prompt library, run notes
├── panos/           # equirectangular pano JPEGs (POT 2048x1024, committed)
├── pano/            # pano-viewer assets + per-world ambience MP3s
└── README.md
```

## Pano viewer architecture (option B, 2026-09-21)

Marble worlds are **panorama captures, not photogrammetry** — free-roam splat
viewing produces smears/voids (user-verified 2026-09-19). The default
experience is now a self-hosted **360° equirectangular panorama viewer**.

- **`pano/viewer.js`** — vanilla WebGL 1.0, zero dependencies, no build step.
  Pano mapped onto the inside of a sphere; pointer drag / touch to look,
  wheel / pinch to zoom (FOV 35–100°), optional slow drift (auto-rotate).
- **`world.html?id=<world>`** — per-world page, manifest-driven. Atmosphere
  overlays (vignette + drifting fog), fullscreen, ambience toggle, hidden VR
  button that only appears when `immersive-vr` is actually supported.
  Deep-linkable: `&lon=&lat=&fov=` pre-aims the camera.
- **Splat stack kept but superseded:** `viewer/` (SuperSplat) and the `.ply`
  files are untouched; `world.html` now renders the pano instead of the splat
  iframe. `manifest.json` keeps each world's `splat` field for the archive.
- **Textures are POT (2048×1024)** — WebGL1 REPEAT/mipmaps require
  power-of-two; Marble's raw seeds are 2304×1152 NPOT. Regenerate with PIL
  (resize + JPEG q85) if seeds change.

### Adding a world

1. Export/copy the equirectangular seed PNG (from Marble) — resize to
   **2048×1024 JPEG q85** into `panos/<id>.jpg` (keep the raw PNG in
   `pipeline/seeds/`, don't commit it).
2. Add a manifest entry in `manifest.json`:
   ```json
   {
     "id": "my_world",
     "title": "My World",
     "description": "One spooky sentence.",
     "thumbnail": "assets/thumbs/my_world.webp",
     "pano": "panos/my_world.jpg",
     "tier": "plus",
     "date": "2026-10-01",
     "featured": true
   }
   ```
   `splat` / `world_id` / `seed_file` are optional archive fields.
3. The gallery card and viewer page pick it up automatically. No build step.

### Local test

```bash
python3 -m http.server 8777
# open http://localhost:8777/  and  http://localhost:8777/world.html?id=grav_fog_dense
```

## World theme & prompt craft

- Foggy graveyards, candlelit haunted houses, jack-o'-lantern fields at dusk,
  witch's forest, abandoned carnival, moonlit corn maze, crypts.
- Reads well in splats: heavy fog, volumetric moonlight, emissive light
  (candles, lanterns, glowing pumpkins). Dark good, pure black risky (test).
- Splats are static captures — no fast-motion input.
- Family-friendly spooky by default (jump scares only behind an opt-in toggle).

## Cost notes

- Text→world: draft ~$0.18, standard ~$1.26, plus median ~$1.28 (p95 ~$2.48).
- Free export: PLY splat. HQ GLB mesh $2.80 (skip unless justified).
- API credits ONLY from platform.worldlabs.ai ($1 = 1,250cr, min $5).
- WARNING: overage can push balance negative; auto-refill doesn't cap.

## Pipeline (once WLT_API_KEY is in ~/.hermes/.env)

1. Draft batch (~$0.18 each) → user picks winners
2. Full-quality regen of winners + free PLY export (resolution tiers 500k/150k/100k)
3. Drop into `worlds/`, add manifest line, deploy

## Status

- [x] Workspace scaffold (this session)
- [x] Pano viewer replaces splat viewer as default (option B, 2026-09-21)
- [ ] Phase 0: WLT_API_KEY + Namecheap SSH + domain (user)
- [ ] Site mockup for review
- [x] SuperSplat viewer local test with sample .ply (superseded — pano default)
- [ ] Smoke test: 1 draft world end-to-end

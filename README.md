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
└── README.md
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
- [ ] Phase 0: WLT_API_KEY + Namecheap SSH + domain (user)
- [ ] Site mockup for review
- [ ] SuperSplat viewer local test with sample .ply
- [ ] Smoke test: 1 draft world end-to-end

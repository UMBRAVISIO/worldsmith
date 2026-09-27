WORLDSMITH PoC BUILD — Cinematic layer on the pano viewer (Stone Angel world)

You are building the proof-of-concept "cinema layer" for the WORLDSMITH site. Work in ~/worldsmith (git repo, site at repo ROOT, deployed by pushing to main → GitHub Pages auto-build). All existing state works; do not regress it.

CONTEXT (read these first):
- manifest.json drives gallery (index.html) and viewer (world.html?id=...).
- Two viewers in pano/: viewer.js (WebGL, real GPUs) and viewer2d.js (2D canvas fallback for SwiftShader/software-GL). world.html probes the GL renderer string and auto-picks. Both support drag/zoom/drift and a per-world startLon.
- Existing audio: manifest "ambience" field → toggle in world.html plays pano/ambience/<world>.mp3. Keep this working.
- Target world ONLY: "grav_angel_statue" (The Stone Angel). Other worlds must be untouched/default-off.

ASSETS ALREADY COMMITTED (do not regenerate):
- pano/tours/grav_angel_statue/narration.mp3 — 71s caretaker voice tour
- pano/tours/grav_angel_statue/music.mp3 — 120s ambient music bed
- pano/tours/grav_angel_statue/bell.mp3 — 10s church bell toll
- Narration script with timing cues: pano/tours/grav_angel_statue_narration.md (the bell tolls at the line "when the bell tolls" — time the bell SFX to match that moment, roughly mid-tour)

BUILD THREE FEATURES:

1. GUIDED TOUR MODE (director mode)
   - A "▶ Take the tour" button on world.html for this world (manifest-gated).
   - Camera follows a keyframed lon/lat/fov timeline (~75-90s, synced to narration.mp3). Choreograph a slow drift toward the angel statue as the caretaker speaks about her, hold on the candle field during the candle line, etc. Read the narration script for beats.
   - Music bed plays under narration; bell.mp3 fires at the bell line; end of tour = camera returns to startLon, ambience resumes.
   - User drag/zoom input interrupts and cancels the tour gracefully (audio fades out, ambience returns).
   - MUST work on BOTH viewers (WebGL and 2D fallback). If the two viewers expose different camera state, unify via a small adapter.

2. DIRECTIONAL AUDIO ENGINE
   - Layer the existing ambience loop with position-aware sound: WebAudio StereoPannerNode driven by camera lon (e.g. wind layer always at back-relative pan, a distant bell/crow presence that pans as the user turns).
   - Random ambient event scheduler: occasional one-shot events (reuse bell.mp3 quiet/filtered, or synthesize creaks/wind gusts via WebAudio oscillators/noise — no new asset files needed) at random 20-60s intervals, random pan.
   - Performance-safe on 4GB laptop: no per-frame allocations, single AudioContext, everything behind the existing audio toggle (off by default until user enables sound).
   - Graceful: any WebAudio failure must leave the pano fully usable.

3. ATMOSPHERE OVERLAY
   - Canvas overlay on the pano (pointer-events: none, z-index above canvas below UI): drifting fog layers, candle-glow flicker in the lower arc where the votives are, subtle vignette.
   - Params per-world via manifest ("fx": {...}) — only enabled for grav_angel_statue in this PoC.
   - Must fail gracefully and must not touch the viewer render paths (no changes to viewer.js/viewer2d.js rendering; composition via DOM layering only).

CONSTRAINTS:
- WIP CHECKPOINTING: every ~45 minutes of work, commit whatever is stable with a message starting "WIP:" (e.g. "WIP: directional audio engine, events untested"). This guarantees a cap/interrupt mid-build never loses more than ~45 min of work. Resume-from-WIP is expected and fine.
- Static site: vanilla JS, no build step, no external CDNs (vendor any lib or go vanilla).
- Manifest-driven: add per-world optional fields (e.g. "tour", "fx") — absent field = feature off, zero behavior change for other worlds.
- 4GB/SwiftShader laptop is the dev machine: keep per-frame work light. Verify the 2D path actually animates (KNOWN TRAP: headless full-page screenshots can be stale compositor frames — verify via canvas element screenshots + content hashes / frame diffs, not full-page shots).
- Don't touch worlds/*.ply, pipeline/, or the splat path. Don't commit files >2MB.
- Commit incrementally with clear messages. When verified, push to main, then confirm the Pages deploy actually serves the new files (curl https://umbravisio.github.io/worldsmith/world.html and the new JS assets).

DELIVERABLE (your final report):
- List of files added/changed + commit SHAs
- How the tour timing was choreographed (keyframes vs narration beats)
- What you verified (headless checks, Pages deploy)
- Any deviations from this brief and why
- What UMBRAVISIO should test on his PC with headphones

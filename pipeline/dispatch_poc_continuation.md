# Dispatch: WORLDSMITH PoC continuation (fires 2026-09-27 11:25am ET, after Opus cap reset)

Background: a prior Opus run hit the Claude 5-hour cap MID-BUILD (most code written, no browser testing). Its work was recovered and committed as **8309ddb** — WIP: pano/cam-adapter.js, pano/cinema-audio.js, pano/cinema-tour.js, pano/cinema-fx.js, pano/tours/grav_angel_statue/tour.json, world.html + manifest.json wiring. Syntax-checked, UNTESTED.

## Steps

1. `cd ~/worldsmith && git status --porcelain` — must be clean; `git log --oneline -1` must show 8309ddb or later. If dirty, commit nothing yourself — stop and report the dirt.

2. Check Opus availability: `cd ~/worldsmith && claude -p "/usage" --model claude-opus-5-5`. If session is still ~100% used, STOP and output exactly: `OPUS STILL CAPPED — dispatch aborted`. Do not retry.

3. If available, launch the build as a long-running background terminal process (background=true, persist_on_release=true, notify=true) with this command:

```
cd ~/worldsmith && opus -z "Continue the WORLDSMITH cinematic PoC. First read pipeline/opus_brief_poc_cinema.md fully, then review the recovered WIP at commit 8309ddb (pano/cam-adapter.js, pano/cinema-audio.js, pano/cinema-tour.js, pano/cinema-fx.js, pano/tours/grav_angel_statue/tour.json, world.html and manifest.json wiring) — it is untested. Verify, fix, and complete it against the brief rather than rebuilding from scratch. Test in headless browser on the 2D viewer path, remembering the stale-compositor trap (canvas element screenshots plus content hashes, not full-page shots). Make all three brief features work with synced tour audio. Commit incrementally with WIP: prefix every ~45 minutes, and push to main when verified." > ~/.hermes/workspace/opus_poc_build_260927.log 2>&1
```

The build may take 30–90 minutes — expected; do NOT wait for it.

4. Confirm the log file begins filling, then end your final response with one line: `DISPATCHED pid=<pid>` or `FAILED: <reason>`.

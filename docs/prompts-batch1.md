# World Prompt Library — Halloween batch 1

Candidate prompts for the first draft batch (~$0.18 each on marble-1.0-draft).
Craft rules: heavy fog, volumetric moonlight, emissive light sources, no fast
motion, dark but not pure black.

## Batch 1 candidates (7 — pick 5 for first spend)

1. **Graveyard Fog** — A fog-drowned rural churchyard at midnight, weathered
   tilted headstones, a single candle lantern glowing on a stone plinth, thin
   mist rolling between graves, full moon diffused behind clouds, bare oak
   silhouettes.

2. **Haunted House Porch** — A Victorian haunted house seen from the front
   porch, warm candlelight flickering in two upstairs windows, carved
   jack-o'-lantern on the porch rail, wooden porch boards in foreground, blue
   hour dusk light.

3. **Pumpkin Field Dusk** — A field of glowing jack-o'-lanterns at dusk
   arranged in rows, deep orange and teal color palette, low ground fog, a
   crooked scarecrow silhouette, distant farmhouse with one lit window.

4. **Witch's Forest** — A dense forest path at night lit by floating wisps of
   green-blue light between the trees, gnarled roots crossing the path, heavy
   low fog, moonbeams in volumetric shafts through the canopy.

5. **Abandoned Carnival Gate** — The entrance gate of an abandoned carnival at
   night, peeling paint, one flickering string of orange bulbs still glowing,
   ticket booth with dim interior light, fog pooling on the midway beyond.

6. **Corn Maze Moonlight** — A moonlit corn maze, tall dry corn walls on both
   sides of a dirt path, a glowing jack-o'-lantern on a post at the path's
   fork, silver moonlight, faint mist.

7. **Crypt Interior** — A candlelit stone crypt interior, arched ceiling,
   rows of stone sarcophagi, dozens of small candles on ledges casting warm
   pools of light, cold blue light from an iron door ajar, light dust motes.

## Notes for iteration
- Evaluate drafts for: fog readability, emissive light pop, geometry garbage
  at edges, near-field detail (players start here).
- Winners get marble-1.1-plus regen; keep drafts for comparison.
- Export PLY at 500k/150k/100k tiers for bandwidth.

## CONFIRMED LESSONS (2026-09-19 batch 1A)
- **Plus-tier TEXT regen = new world, not an upgrade.** Same prompt re-rolls
  composition entirely (church vanished, angel scene over-densified). To
  preserve a draft's composition: image-to-world — feed the draft's
  pano/image as image_prompt to marble-1.1-plus. API drafts returned
  pano_url:null; may need pano exported from web app.
- Warm-vs-cold contrast (candlelight vs cold fog) beats "true midnight" —
  model resists pure black; blood-orange moon reads great.
- Say "tilted, chaotic, half-sunk" explicitly or stones come out neat rows.
- Enclosure words matter: "intimate, no open spaces" — vast open graveyards
  read as empty (mausoleum draft criticized as "too vast").
- Emissive focal objects need "clearly defined" geometry or they go muddy.
- Pumpkins read poorly at draft fidelity (blobby).

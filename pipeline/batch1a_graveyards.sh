#!/usr/bin/env bash
# Batch 1A — graveyard variants (draft tier). Results land in pipeline/.state/
set -e
cd "$(dirname "$0")/.."

declare -A PROMPTS=(
  [grav_fog_dense]="A fog-drowned rural churchyard at midnight, densely packed weathered headstones all tilted and leaning at chaotic angles, many half-sunk into the earth, a candle lantern burning on a clearly defined stone plinth in the foreground, near-black sky with a faint sliver of moon, thick ground mist swallowing everything beyond ten feet, crooked iron fence, bare twisted oak silhouettes"
  [grav_mausoleum]="A grand crumbling stone mausoleum in an overgrown graveyard at midnight, heavy carved door ajar with warm candlelight spilling out, ivy climbing cracked columns, tilted and toppled headstones scattered in wild grass, deep black sky with brilliant stars and a low blood-orange moon, ground fog curling around the mausoleum steps, gnarled dead trees framing the scene"
  [grav_moonlit_hill]="A hillside graveyard overlooking a misty valley at true midnight, rows of leaning crooked headstones casting long moonlight shadows, a lantern-lit stone path winding up between the graves, sharp crescent moon in a cloud-streaked indigo sky, volumetric moonbeams, wind-bent bare trees, a small ruined chapel at the hilltop"
  [grav_angel_statue]="A Victorian cemetery at midnight dominated by a towering weathered stone angel statue with spread wings, its face eroded and eerie, surrounded by tilted aged headstones and crumbling plinths, dozens of small votive candles glowing at the statue's base, dense low fog, pitch-black night sky, lightning-branch bare trees, ravens perched on stones"
  [grav_autumn_dusk]="A small country graveyard at deep autumn dusk, scattered slate headstones heavily tilted and moss-covered, fallen orange leaves drifted against the stones, a jack-o-lantern glowing on a fresh grave, carved pumpkins lining the rusty iron gate, deep blue-black twilight sky with the first stars, thin ground mist, dark forest edge beyond the fence"
)

for name in grav_fog_dense grav_mausoleum grav_moonlit_hill grav_angel_statue grav_autumn_dusk; do
  echo "=== Generating: $name ==="
  python3 pipeline/generate_world.py \
    --prompt "${PROMPTS[$name]}" \
    --quality draft \
    --name "$name" \
    --tags halloween graveyard > "pipeline/.state/batch-${name}.log" 2>&1 \
    && echo "  OK -> pipeline/.state/batch-${name}.log" \
    || { echo "  FAILED:"; tail -5 "pipeline/.state/batch-${name}.log"; }
done

echo "=== DONE ==="

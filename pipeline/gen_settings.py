#!/usr/bin/env python3
"""Generate per-world SuperSplat experience settings (camera poses).

Camera coordinates are hand-tuned from measured splat geometry (parse the PLY,
find the warm bright cluster = candle/statue) and user screenshots.
Run: python3 pipeline/gen_settings.py
Writes viewer/settings-<id>.json per walkable world in the manifest.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "manifest.json")
OUT_DIR = os.path.join(ROOT, "viewer")

BASE = {
    "version": 2,
    "tonemapping": "linear",
    "highPrecisionRendering": False,
    "background": {"color": [0.02, 0.02, 0.025]},
    "postEffectSettings": {
        "sharpness": {"enabled": True, "amount": 0.3},
        "bloom": {"enabled": True, "intensity": 0.25, "blurLevel": 2},
        "grading": {"enabled": True, "brightness": 1.05, "contrast": 1.08, "saturation": 1.05, "tint": [1, 1, 1]},
        "vignette": {"enabled": True, "intensity": 0.4, "inner": 0.4, "outer": 0.85, "curvature": 1},
        "fringing": {"enabled": False, "intensity": 0.5},
    },
    "cameras": [],
    "animTracks": [],
    "annotations": [],
    "startMode": "default",
}

# hand-tuned poses. CRITICAL: camera must sit INSIDE the splat data bounds
# (fog: x[-11.6,9] z[-11.6,3.7]; angel: x[-31.7,13.9] z[-23.5,13.9]) or the
# frame includes void beyond the world's edge.
POSES = {
    "grav_fog_dense": [
        {"initial": {"position": [2.5, 1.7, 2.8], "target": [0.0, 0.7, 0.2], "fov": 60}},
        {"initial": {"position": [4.5, 1.8, 2.0], "target": [0.0, 0.7, 0.2], "fov": 62}},
        {"initial": {"position": [1.5, 1.6, 3.0], "target": [-0.5, 0.8, -1.5], "fov": 62}},
    ],
    "grav_angel_statue": [
        {"initial": {"position": [0.0, 1.8, 9.0], "target": [0.0, 1.5, 0.5], "fov": 60}},
        {"initial": {"position": [6.0, 2.2, 7.0], "target": [0.0, 1.3, 0.4], "fov": 58}},
        {"initial": {"position": [-4.0, 2.0, -7.0], "target": [0.0, 1.4, 0.4], "fov": 60}},
    ],
}

DEFAULT = [{"initial": {"position": [2.0, 1.8, 6.5], "target": [0.0, 0.8, 0.2], "fov": 65}}]


def main():
    manifest = json.load(open(MANIFEST))
    os.makedirs(OUT_DIR, exist_ok=True)
    for w in manifest["worlds"]:
        if not w.get("splat"):
            continue
        doc = dict(BASE)
        doc["cameras"] = POSES.get(w["id"], DEFAULT)
        out = os.path.join(OUT_DIR, f"settings-{w['id']}.json")
        with open(out, "w") as f:
            json.dump(doc, f, indent=2)
        print("wrote", out)


if __name__ == "__main__":
    main()

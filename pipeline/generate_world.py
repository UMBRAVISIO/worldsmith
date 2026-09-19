#!/usr/bin/env python3
"""WORLDSMITH — Marble API pipeline.

Generates a world via World Labs Marble API and polls until done.
Requires WLT_API_KEY in ~/.hermes/.env (or environment).

Usage:
  python3 pipeline/generate_world.py --prompt "..." [--quality draft] [--name "Title"]
  python3 pipeline/generate_world.py --credits          # check balance, no spend
  python3 pipeline/generate_world.py --poll-only OP_ID  # resume polling an operation

API: https://api.worldlabs.ai/marble/v1
  POST /worlds:generate  {world_prompt: {type: text, text_prompt: "..."}, model, display_name, tags, permission}
  GET  /operations/{id}  -> {done, response, error, cost}
  GET  /credits          -> balance
Docs: docs.worldlabs.ai/llms.txt
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://api.worldlabs.ai/marble/v1"
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".state")


def load_key():
    key = os.environ.get("WLT_API_KEY")
    if key:
        return key
    env_path = os.path.expanduser("~/.hermes/.env")
    if os.path.exists(env_path):
        for line in open(env_path):
            if line.startswith("WLT_API_KEY="):
                return line.strip().split("=", 1)[1]
    sys.exit("ERROR: WLT_API_KEY not found in env or ~/.hermes/.env (Phase 0 not done)")


def api(method, path, key, payload=None):
    req = urllib.request.Request(
        f"{API_BASE}{path}",
        method=method,
        headers={"WLT-Api-Key": key, "Content-Type": "application/json"},
        data=json.dumps(payload).encode() if payload else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        sys.exit(f"API {method} {path} -> HTTP {e.code}: {body}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", help="text prompt for the world (or guidance text with --image)")
    ap.add_argument("--image", metavar="PNG", help="path to a seed image (jpg/png) — image-to-world mode; use --pano for panoramas")
    ap.add_argument("--pano", action="store_true", help="seed image is an equirectangular panorama (sets is_pano=true)")
    ap.add_argument("--name", help="display name (max 64 chars)")
    ap.add_argument("--quality", default="draft", choices=["draft", "standard", "plus"])
    ap.add_argument("--tags", nargs="*", default=["halloween"])
    ap.add_argument("--public", action="store_true", help="make world public")
    ap.add_argument("--credits", action="store_true", help="check credit balance only, no spend")
    ap.add_argument("--poll-only", metavar="OP_ID", help="poll an existing operation instead of generating")
    args = ap.parse_args()

    key = load_key()
    os.makedirs(STATE_DIR, exist_ok=True)
    ts = time.strftime("%y%m%d-%H%M%S")

    if args.credits:
        print(json.dumps(api("GET", "/credits", key), indent=2))
        return

    if args.poll_only:
        op_id = args.poll_only
    else:
        if not args.prompt and not args.image:
            sys.exit("--prompt required (or --credits / --poll-only)")
        model = {"draft": "marble-1.0-draft", "standard": "marble-1.1", "plus": "marble-1.1-plus"}[args.quality]
        if args.image:
            import base64
            ext = os.path.splitext(args.image)[1].lstrip(".").lower() or "png"
            b64 = base64.b64encode(open(args.image, "rb").read()).decode()
            prompt_block = {
                "type": "image",
                "image_prompt": {"source": "data_base64", "data_base64": b64, "extension": ext},
            }
            if args.pano:
                prompt_block["is_pano"] = True
            if args.prompt:
                prompt_block["text_prompt"] = args.prompt
                prompt_block["type"] = "image"
        else:
            prompt_block = {"type": "text", "text_prompt": args.prompt}
        payload = {
            "world_prompt": prompt_block,
            "model": model,
            "tags": args.tags[:10],
            "permission": {"public": args.public},
        }
        if args.name:
            payload["display_name"] = args.name[:64]
        op = api("POST", "/worlds:generate", key, payload)
        op_id = op["operation_id"]
        print(f"Operation started: {op_id}")
        json.dump(op, open(f"{STATE_DIR}/op-{ts}.json", "w"), indent=2)

    while True:
        status = api("GET", f"/operations/{op_id}", key)
        done = status.get("done")
        meta = status.get("metadata") or {}
        pct = meta.get("progress") or meta.get("progress_percentage") or ""
        print(f"  poll {time.strftime('%H:%M:%S')}: done={done} {pct}")
        if done:
            break
        time.sleep(20)

    json.dump(status, open(f"{STATE_DIR}/result-{ts}.json", "w"), indent=2)
    if status.get("error"):
        sys.exit(f"GENERATION FAILED: {json.dumps(status['error'])[:300]}")
    cost = status.get("cost")
    if cost:
        print(f"Cost: {json.dumps(cost)}")
    print(f"COMPLETE — result saved to {STATE_DIR}/result-{ts}.json")
    print(json.dumps(status.get("response"), indent=2)[:2000])


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""WORLDSMITH — Marble API pipeline (smoke test mode).

Generates one draft world via World Labs Marble API and polls until done.
Requires WLT_API_KEY in ~/.hermes/.env (or environment).

Usage:
  python3 pipeline/generate_world.py --prompt "..." [--quality draft] [--dry-run]

API: api.worldlabs.ai/marble/v1 — flow: worlds:generate -> poll operations -> world -> export
Docs index: docs.worldlabs.ai/llms.txt  (OpenAPI spec available)
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_BASE = "https://api.worldlabs.ai/marble/v1"
STATE_DIR = os.path.join(os.path.dirname(__file__), ".state")


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
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--quality", default="draft", choices=["draft", "standard", "plus"])
    ap.add_argument("--model", default="marble-1.0-draft")
    ap.add_argument("--dry-run", action="store_true", help="Print request payload only, no API call")
    args = ap.parse_args()

    payload = {"prompt": args.prompt, "quality": args.quality, "model": args.model}
    print(json.dumps(payload, indent=2))

    if args.dry_run:
        print("DRY RUN — no API call made.")
        return

    key = load_key()
    os.makedirs(STATE_DIR, exist_ok=True)
    ts = time.strftime("%y%m%d-%H%M%S")
    op = api("POST", "/worlds:generate", key, payload)
    op_id = op.get("name") or op.get("id")
    print(f"Operation started: {op_id}")
    json.dump(op, open(f"{STATE_DIR}/op-{ts}.json", "w"), indent=2)

    while True:
        status = api("GET", f"/{op_id}", key)
        done = status.get("done") or status.get("state") == "SUCCEEDED"
        print(f"  poll: {json.dumps(status)[:120]}")
        if done:
            break
        time.sleep(20)
    json.dump(status, open(f"{STATE_DIR}/result-{ts}.json", "w"), indent=2)
    print(f"COMPLETE — result saved to {STATE_DIR}/result-{ts}.json")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""WORLDSMITH audio generation via Venice API (TTS/music/SFX).
Flow: /audio/quote -> /audio/queue -> poll /audio/retrieve (RAW wav when done) -> /audio/complete.
Usage: python3 gen_audio.py tts <textfile> <out.wav> [voice_desc]
       python3 gen_audio.py music <prompt> <out.wav> <duration_sec>
       python3 gen_audio.py sfx <prompt> <out.wav> <duration_sec> [loop]
"""
import sys, os, json, time, urllib.request, urllib.error

ENV = os.path.expanduser("~/.hermes/.env")
def envget(k):
    for line in open(ENV):
        if line.startswith(k + "="):
            return line.strip().split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit(f"{k} not in {ENV}")

KEY = envget("VENICE_ADMIN_KEY")
BASE = "https://api.venice.ai/api/v1/audio"

def call(path, payload):
    req = urllib.request.Request(BASE + path, method="POST",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()

def main():
    mode = sys.argv[1]
    out = sys.argv[3]
    if mode == "tts":
        text = open(sys.argv[2]).read()
        if text.startswith("#"):  # strip leading comment lines
            text = "\n".join(l for l in text.splitlines() if not l.startswith("#")).strip()
        model, params = "elevenlabs-tts-v3", {}
        payload = {"model": model, "prompt": text}
        if len(sys.argv) > 4:
            payload["voice_description"] = sys.argv[4]
    elif mode == "music":
        model = "sonilo-v1-1-music"
        payload = {"model": model, "prompt": sys.argv[2], "duration_seconds": int(sys.argv[4])}
    else:  # sfx
        model = "stable-audio-25"
        payload = {"model": model, "prompt": sys.argv[2], "duration_seconds": int(sys.argv[4])}
        if len(sys.argv) > 5 and sys.argv[5] == "loop":
            payload["loop"] = True

    # 1. quote
    st, body = call("/quote", payload)
    print("QUOTE", st, body[:500].decode(errors="replace"))
    if st != 200: sys.exit(1)
    q = json.loads(body)

    # 2. queue
    st, body = call("/queue", payload)
    print("QUEUE", st, body[:300].decode(errors="replace"))
    if st != 200: sys.exit(1)
    queue_id = json.loads(body).get("queue_id") or json.loads(body).get("id")
    print("queue_id:", queue_id)

    # 3. poll retrieve
    deadline = time.time() + 420
    while time.time() < deadline:
        time.sleep(6)
        req = urllib.request.Request(BASE + "/retrieve", method="POST",
            data=json.dumps({"queue_id": queue_id, "model": model}).encode(),
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                ct = r.headers.get("Content-Type", "")
                data = r.read()
        except urllib.error.HTTPError as e:
            print("retrieve HTTP", e.code, e.read()[:200]); continue
        if "audio" in ct:
            open(out, "wb").write(data)
            print(f"DONE -> {out} ({len(data)/1e6:.1f} MB)")
            call("/complete", {"queue_id": queue_id, "model": model})
            print("quote was:", json.dumps(q)[:300])
            return
        try:
            j = json.loads(data)
            print("status:", json.dumps(j)[:200])
        except Exception:
            print("non-json, non-audio:", data[:200])
    sys.exit("TIMEOUT")

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Meeting Agent - local web interface.

  .venv/bin/python app.py            -> http://localhost:4610 (this Mac only)
  .venv/bin/python app.py --lan      -> also reachable from the office network (no login! demo use only)

Wraps transcribe.py + minutes.py. Staff can record or upload a meeting, watch it process,
read the minutes, fix speaker names and approve or skip each proposed action.
Approved items are created in Zoho / Outlook by an admin running /meeting in Claude Code,
which writes the Zoho task ids back into actions.json so the page shows them as done.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from config import load_config, load_staff, meetings_dir

HERE = Path(__file__).resolve().parent
if "--config" in sys.argv:  # must be set before the config is read
    os.environ["MEETING_AGENT_CONFIG"] = str(Path(sys.argv[sys.argv.index("--config") + 1]).resolve())
CFG = load_config()
MEETINGS = meetings_dir(CFG)
INBOX = HERE / "inbox"
WEB = HERE / "web"
PY = sys.executable
ZOHO_TASK_URL = CFG["zoho_task_url"]
ALLOWED = {".m4a", ".mp3", ".wav", ".webm", ".mp4", ".mov", ".ogg", ".aac", ".vtt"}

app = Flask(__name__, static_folder=None)
job_lock = threading.Lock()  # one transcription at a time (the speech model uses a lot of memory)


# ---------- helpers ----------
def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "meeting"


def folder_for(mid: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", mid):
        abort(404)
    f = MEETINGS / mid
    if not f.is_dir():
        abort(404)
    return f


def read_json(p: Path, default=None):
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(p: Path, data) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(p)


def set_status(folder: Path, stage: str, message: str = "") -> None:
    write_json(folder / "status.json", {"stage": stage, "message": message, "updated": time.time()})


def staff():
    return load_staff(CFG)["staff"]


def build_actions(folder: Path) -> dict:
    """Turn minutes.json into an approval list. Keeps anything already created/approved."""
    m = read_json(folder / "minutes.json")
    if not m:
        return {"items": []}
    old = {i["key"]: i for i in read_json(folder / "actions.json", {"items": []})["items"]}
    mins = m["minutes"]
    emails = {s["name"]: s["email"] for s in staff()}
    items = []
    for a in mins["action_items"]:
        items.append({"key": a["id"], "type": "task", "status": "pending", "task": a["task"], "owner": a["owner"],
                      "due_date": a["due_date"], "due_text": a["due_text"], "priority": a["priority"],
                      "related_to": a["related_to"], "quote": a["quote"], "timestamp": a["timestamp"]})
    for i, f in enumerate(mins["follow_up_meetings"], 1):
        items.append({"key": f"F{i}", "type": "meeting", "status": "pending", "title": f["title"], "date": f["date"],
                      "start_time": f["start_time"], "duration_minutes": f["duration_minutes"],
                      "attendees": f["attendees"], "purpose": f["purpose"]})
    attendees = sorted({a["owner"] for a in mins["action_items"]} | set(m.get("confirmed_names", {}).values()))
    items.append({"key": "EMAIL", "type": "email", "status": "pending", "subject": mins["recap_email_subject"],
                  "body": mins["recap_email_body"], "to": [emails[n] for n in attendees if emails.get(n)]})
    # Never lose work that already happened.
    for it in items:
        prev = old.get(it["key"])
        if prev and prev["status"] in ("created", "sent", "draft"):
            it.update(prev)
    kept = {it["key"] for it in items}
    items += [p for k, p in old.items() if k not in kept and p["status"] in ("created", "sent", "draft")]
    data = {"items": items, "updated": time.time()}
    write_json(folder / "actions.json", data)
    return data


# ---------- pipeline ----------
def run_pipeline(folder: Path, src: Path, title: str, date: str, speakers: int | None, names: str = ""):
    set_status(folder, "queued", "Waiting for the previous meeting to finish")
    with job_lock:
        try:
            if src is not None:
                cmd = [PY, "-u", str(HERE / "transcribe.py"), str(src), "--title", title, "--date", date,
                       "--folder", str(folder)]
                if speakers:
                    cmd += ["--speakers", str(speakers)]
                set_status(folder, "converting", "Preparing audio")
                proc = subprocess.Popen(cmd, cwd=HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                log = []
                for line in proc.stdout:
                    log.append(line)
                    if line.startswith("2/3"):
                        set_status(folder, "diarizing", "Telling speakers apart")
                    elif line.startswith("3/3"):
                        set_status(folder, "transcribing", "Writing down what was said")
                    elif line.startswith("Reading transcript"):
                        set_status(folder, "transcribing", "Reading the transcript file")
                if proc.wait() != 0:
                    raise RuntimeError("Transcription failed: " + "".join(log[-5:]).strip())
            set_status(folder, "minutes", "Claude is writing the minutes")
            cmd = [PY, str(HERE / "minutes.py"), str(folder)]
            if names:
                cmd += ["--names", names]
            r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1])
            build_actions(folder)
            set_status(folder, "ready")
        except Exception as e:  # surface any failure on the page
            set_status(folder, "error", str(e)[:500])


# ---------- routes ----------
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(WEB / "static", name)


@app.get("/api/config")
def api_config():
    return jsonify(org_name=CFG["org_name"], admin_name=CFG["admin_name"], logo=f"/static/{CFG['logo']}" if CFG["logo"] else "")


@app.get("/api/staff")
def api_staff():
    return jsonify([{"name": s["name"], "role": s["role"]} for s in staff()])


@app.get("/api/meetings")
def api_meetings():
    out = []
    for f in sorted(MEETINGS.glob("*/"), key=lambda p: p.stat().st_mtime, reverse=True):
        t = read_json(f / "transcript.json", {})
        m = read_json(f / "minutes.json", {})
        st = read_json(f / "status.json", {"stage": "ready" if m else "transcribed"})
        a = read_json(f / "actions.json", {"items": []})["items"]
        meta = t.get("meta") or read_json(f / "meta.json", {})
        out.append({
            "id": f.name, "title": meta.get("title", f.name), "date": meta.get("date", ""),
            "stage": st["stage"], "speakers": len(meta.get("speakers", {})),
            "actions": sum(1 for i in a if i["type"] == "task"),
            "done": sum(1 for i in a if i["status"] in ("created", "sent", "draft")),
            "approved": sum(1 for i in a if i["status"] == "approved"),
        })
    return jsonify(out)


@app.get("/api/meetings/<mid>")
def api_meeting(mid):
    f = folder_for(mid)
    actions = read_json(f / "actions.json")
    if actions is None and (f / "minutes.json").exists():
        actions = build_actions(f)
    for it in (actions or {"items": []})["items"]:
        if it.get("zoho_id") and ZOHO_TASK_URL:
            it["zoho_url"] = ZOHO_TASK_URL.format(it["zoho_id"])
    return jsonify({
        "id": mid,
        "meta": read_json(f / "meta.json", {}),
        "status": read_json(f / "status.json", {"stage": "ready"}),
        "transcript": read_json(f / "transcript.json"),
        "minutes": read_json(f / "minutes.json"),
        "actions": actions,
        "has_audio": (f / "audio.wav").exists(),
    })


@app.get("/api/meetings/<mid>/audio")
def api_audio(mid):
    p = folder_for(mid) / "audio.wav"
    if not p.exists():
        abort(404)
    return send_file(p, mimetype="audio/wav", conditional=True)


@app.post("/api/meetings")
def api_create():
    file = request.files.get("file")
    title = (request.form.get("title") or "Meeting").strip()[:80]
    date = request.form.get("date") or dt.date.today().isoformat()
    try:
        dt.date.fromisoformat(date)
    except ValueError:
        return jsonify(error="Bad date"), 400
    speakers = request.form.get("speakers", type=int)
    if not file or not file.filename:
        return jsonify(error="Choose a recording or record one first"), 400
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED:
        return jsonify(error=f"Unsupported file type {ext}"), 400
    stamp = dt.datetime.now().strftime("%H%M%S")
    mid = f"{date}_{slugify(title)}_{stamp}"
    folder = MEETINGS / mid
    folder.mkdir(parents=True)
    INBOX.mkdir(exist_ok=True)
    src = INBOX / f"{mid}{ext}"
    file.save(src)
    write_json(folder / "meta.json", {"title": title, "date": date, "source": file.filename})
    threading.Thread(target=run_pipeline, args=(folder, src, title, date, speakers), daemon=True).start()
    return jsonify(id=mid)


@app.post("/api/meetings/<mid>/names")
def api_names(mid):
    f = folder_for(mid)
    names = request.get_json(force=True).get("names", {})
    clean = {k: v.strip() for k, v in names.items()
             if re.fullmatch(r"Speaker \d+", k) and v and "," not in v and "=" not in v}
    arg = ",".join(f"{k}={v}" for k, v in clean.items())
    meta = read_json(f / "transcript.json", {}).get("meta", {})
    threading.Thread(target=run_pipeline, args=(f, None, meta.get("title", ""), meta.get("date", ""), None, arg),
                     daemon=True).start()
    return jsonify(ok=True)


@app.post("/api/meetings/<mid>/actions/<key>")
def api_action(mid, key):
    """Approve / skip / edit one item. Created items are locked."""
    f = folder_for(mid)
    data = read_json(f / "actions.json") or build_actions(f)
    body = request.get_json(force=True)
    for it in data["items"]:
        if it["key"] == key:
            if it["status"] in ("created", "sent", "draft"):
                return jsonify(error="Already done in Zoho/Outlook"), 409
            if body.get("status") in ("pending", "approved", "skipped"):
                it["status"] = body["status"]
            for field in ("task", "owner", "due_date", "priority", "related_to", "title", "date", "start_time",
                          "subject", "body"):
                if field in body and isinstance(body[field], str):
                    it[field] = body[field][:5000]
            if "to" in body and isinstance(body["to"], list):
                it["to"] = [str(x)[:120] for x in body["to"]][:50]
            data["updated"] = time.time()
            write_json(f / "actions.json", data)
            return jsonify(it)
    abort(404)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4610)
    ap.add_argument("--config", help="settings file (default config.json, else config.example.json)")
    ap.add_argument("--lan", action="store_true", help="listen on the office network too (no login - demo only)")
    a = ap.parse_args()
    MEETINGS.mkdir(exist_ok=True)
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    print(f"Meeting Agent ({CFG['org_name']}) on http://localhost:{a.port}")
    app.run(host=host, port=a.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()

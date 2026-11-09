#!/usr/bin/env python3
"""Meeting Agent - local transcription with speaker separation.

Turns a meeting recording (or a Teams/Zoho .vtt transcript) into a speaker-labelled
transcript. Everything runs on this Mac: audio never leaves the machine.

  .venv/bin/python transcribe.py <file> --title "Staff meeting" [--speakers 4] [--date 2026-11-09]

Inputs:  any audio/video ffmpeg can read (m4a, mp3, wav, webm, mp4, mov) or a .vtt transcript
         (Teams/Zoho transcripts already carry real names, so diarization is skipped).
Outputs: meetings/<date>_<slug>/ with audio.wav, transcript.json, transcript.md
"""
import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE / "models"
SEG_MODEL = MODELS / "sherpa-onnx-pyannote-segmentation-3-0" / "model.onnx"
EMB_MODEL = MODELS / "nemo_en_titanet_small.onnx"
WHISPER = "mlx-community/whisper-large-v3-turbo"
SR = 16000


def ts(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def slugify(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "meeting"


def to_wav(src: Path, dst: Path) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", str(SR), str(dst)],
        check=True,
    )


def _diarize_once(audio, threshold: float):
    import sherpa_onnx

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(SEG_MODEL)),
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(EMB_MODEL)),
        # num_clusters is deliberately NOT used: forcing a count made the library merge two voices
        # (tested 2026-11-09). Threshold mode decides the count itself; higher threshold = fewer speakers.
        clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=threshold),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        sys.exit("Diarization config invalid - are the model files in meeting-agent/models/?")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)
    result = sd.process(audio).sort_by_start_time()
    return [(r.start, r.end, r.speaker) for r in result]


def diarize(wav: Path, expected: int | None):
    """Speaker segments. `expected` (people who spoke) is only a check: if the first pass finds a
    different number, nudge the threshold up to 3 times and keep the closest result."""
    import soundfile as sf

    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    audio = audio[:, 0]
    assert sr == SR, f"expected {SR} Hz, got {sr}"
    threshold = 0.6
    best = segs = _diarize_once(audio, threshold)
    count = lambda s: len({k for _, _, k in s})
    if expected:
        for _ in range(3):
            n = count(segs)
            if n == expected:
                return segs
            threshold += 0.08 if n > expected else -0.08
            segs = _diarize_once(audio, threshold)
            if abs(count(segs) - expected) < abs(count(best) - expected):
                best = segs
        if count(best) != expected:
            print(f"   note: found {count(best)} voices, you said {expected}")
    return best


def transcribe_words(wav: Path):
    import mlx_whisper

    # Priming with real names/terms fixes misspellings like "Pratig" and "Jamie".
    from config import load_config, load_staff
    cfg = load_config()
    staff = load_staff(cfg)
    prompt = f"{cfg['org_name']} staff meeting with " + ", ".join(s["name"] for s in staff["staff"]) + \
             ". Topics: " + ", ".join(staff["vocabulary"]) + "."
    out = mlx_whisper.transcribe(
        str(wav), path_or_hf_repo=WHISPER, word_timestamps=True, language="en",
        condition_on_previous_text=False, initial_prompt=prompt,
    )
    words = []
    for seg in out.get("segments", []):
        for w in seg.get("words", []):
            if w["word"].strip():
                words.append({"start": w["start"], "end": w["end"], "text": w["word"]})
    return words


def speaker_for(word, segments) -> int | None:
    """Speaker whose segment overlaps the word most; nearest segment if none overlap."""
    best, best_ov = None, 0.0
    for s, e, spk in segments:
        ov = min(e, word["end"]) - max(s, word["start"])
        if ov > best_ov:
            best, best_ov = spk, ov
    if best is not None:
        return best
    mid = (word["start"] + word["end"]) / 2
    nearest = min(segments, key=lambda seg: min(abs(seg[0] - mid), abs(seg[1] - mid)), default=None)
    return nearest[2] if nearest else None


def build_turns(words, segments):
    # Renumber speakers 1..N in order of first appearance.
    order: dict[int, str] = {}
    turns = []
    for w in words:
        raw = speaker_for(w, segments)
        if raw not in order:
            order[raw] = f"Speaker {len(order) + 1}"
        spk = order[raw]
        gap = turns and w["start"] - turns[-1]["end"] > 2.5
        if turns and turns[-1]["speaker"] == spk and not gap:
            turns[-1]["text"] += w["text"]
            turns[-1]["end"] = w["end"]
        else:
            turns.append({"speaker": spk, "start": w["start"], "end": w["end"], "text": w["text"]})
    for t in turns:
        t["text"] = t["text"].strip()
    return turns


def parse_vtt(path: Path):
    """Teams/Zoho WebVTT: cues like '<v Maria Lopez>text</v>' or 'Name: text'."""
    turns = []
    cue_re = re.compile(r"(\d+:)?(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d+:)?(\d{2}):(\d{2})[.,](\d{3})")

    def secs(h, m, s, ms):
        return int((h or "0:")[:-1]) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

    start = end = 0.0
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        m = cue_re.search(line)
        if m:
            g = m.groups()
            start, end = secs(*g[0:4]), secs(*g[4:8])
            continue
        line = line.strip()
        if not line or line.startswith(("WEBVTT", "NOTE")) or line.isdigit() or re.fullmatch(r"[0-9a-f-]{20,}(/\d+-\d+)?", line):
            continue
        v = re.match(r"<v\s+([^>]+)>(.*?)(</v>)?$", line)
        if v:
            spk, text = v.group(1).strip(), re.sub(r"<[^>]+>", "", v.group(2)).strip()
        elif ":" in line[:40]:
            spk, text = (p.strip() for p in line.split(":", 1))
        else:
            spk, text = (turns[-1]["speaker"] if turns else "Unknown"), line
        if turns and turns[-1]["speaker"] == spk and start - turns[-1]["end"] < 2.5:
            turns[-1]["text"] += " " + text
            turns[-1]["end"] = end
        else:
            turns.append({"speaker": spk, "start": start, "end": end, "text": text})
    return turns


def write_outputs(folder: Path, meta: dict, turns: list) -> None:
    speakers: dict[str, dict] = {}
    for t in turns:
        s = speakers.setdefault(t["speaker"], {"talk_seconds": 0.0, "turns": 0})
        s["talk_seconds"] += t["end"] - t["start"]
        s["turns"] += 1
    meta["speakers"] = {k: {"talk_seconds": round(v["talk_seconds"]), "turns": v["turns"]} for k, v in speakers.items()}
    (folder / "transcript.json").write_text(json.dumps({"meta": meta, "turns": turns}, indent=2))
    lines = [f"# {meta['title']} — transcript", "", f"Date: {meta['date']} · Source: {meta['source']} · "
             f"Length: {ts(turns[-1]['end']) if turns else '0'}", ""]
    for t in turns:
        lines.append(f"**{t['speaker']}** [{ts(t['start'])}] {t['text']}")
        lines.append("")
    (folder / "transcript.md").write_text("\n".join(lines))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("--title", default="Meeting")
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--speakers", type=int, default=None, help="number of people who spoke, if known (improves accuracy)")
    ap.add_argument("--folder", type=Path, default=None, help="output folder (default meetings/<date>_<title>)")
    args = ap.parse_args()

    src = args.input.expanduser().resolve()
    if not src.exists():
        sys.exit(f"Not found: {src}")
    from config import meetings_dir
    folder = args.folder or meetings_dir() / f"{args.date}_{slugify(args.title)}"
    folder.mkdir(parents=True, exist_ok=True)
    meta = {"title": args.title, "date": args.date, "source": src.name}

    if src.suffix.lower() == ".vtt":
        print("Reading transcript (speaker names come from the file)…")
        turns = parse_vtt(src)
        meta["speaker_mode"] = "named"
    else:
        wav = folder / "audio.wav"
        print("1/3 Converting audio…")
        to_wav(src, wav)
        print("2/3 Separating speakers…")
        segments = diarize(wav, args.speakers)
        print("3/3 Transcribing (first run downloads the speech model, ~1.5 GB)…")
        words = transcribe_words(wav)
        if not segments:
            segments = [(0.0, 10**9, 0)]
        turns = build_turns(words, segments)
        meta["speaker_mode"] = "anonymous"

    write_outputs(folder, meta, turns)
    print(f"\nDone: {len(turns)} turns, {len(meta['speakers'])} speakers")
    for k, v in meta["speakers"].items():
        print(f"  {k}: {v['turns']} turns, {v['talk_seconds']}s")
    print(f"FOLDER={folder}")


if __name__ == "__main__":
    main()

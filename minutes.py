#!/usr/bin/env python3
"""Meeting Agent - AI minutes and proposed actions (Claude API).

  .venv/bin/python minutes.py meetings/<folder> [--names "Speaker 1=Maria Lopez,Speaker 2=Sam Carter"]

Reads transcript.json, asks Claude for minutes + proposed actions, and writes
minutes.json and minutes.md into the same folder. Nothing is created in Zoho or
Outlook here: every action is only a PROPOSAL until someone approves it.

Needs ANTHROPIC_API_KEY in meeting-agent/.env (see .env.example).
"""
import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Literal

import anthropic
from pydantic import BaseModel, Field

from config import load_config, load_staff

HERE = Path(__file__).resolve().parent
MODEL = "claude-opus-5-5"


# ---------- output schema ----------
class SpeakerGuess(BaseModel):
    label: str = Field(description="Label as it appears in the transcript, e.g. 'Speaker 2'")
    likely_name: str = Field(description="Best guess at the real name from the staff list, or 'Unknown'")
    confidence: Literal["high", "medium", "low"]
    evidence: str = Field(description="Short reason, e.g. 'Addressed as Sam at 00:00:11'")


class Topic(BaseModel):
    title: str
    notes: list[str]


class Decision(BaseModel):
    decision: str
    made_by: str


class ActionItem(BaseModel):
    id: str = Field(description="A1, A2, ...")
    task: str = Field(description="Imperative, specific, self-contained task title")
    owner: str = Field(description="Full staff name, or 'Unassigned' if nobody took it")
    due_date: str = Field(description="YYYY-MM-DD resolved from the meeting date, or '' if none stated")
    due_text: str = Field(description="How the deadline was said, e.g. 'by Thursday', or ''")
    priority: Literal["High", "Normal", "Low"]
    related_to: str = Field(description="Named student, lead, employer or batch this concerns, or ''")
    timestamp: str = Field(description="HH:MM:SS where it was agreed")
    quote: str = Field(description="Short verbatim quote that supports it")


class FollowUpMeeting(BaseModel):
    title: str
    date: str = Field(description="YYYY-MM-DD resolved from the meeting date, or ''")
    start_time: str = Field(description="24h HH:MM, or ''")
    duration_minutes: int
    attendees: list[str]
    purpose: str


class Minutes(BaseModel):
    summary: str = Field(description="3-6 sentence plain-language summary")
    speaker_guesses: list[SpeakerGuess]
    topics: list[Topic]
    decisions: list[Decision]
    action_items: list[ActionItem]
    follow_up_meetings: list[FollowUpMeeting]
    open_questions: list[str]
    recap_email_subject: str
    recap_email_body: str = Field(description="Plain-text recap email to attendees: summary, decisions, each person's tasks with due dates, open questions")


SYSTEM = """You are the meeting secretary for {org_name}, {org_description}.

Turn a speaker-labelled meeting transcript into accurate minutes that staff can act on.

Rules:
- Only record what was actually said. Never invent tasks, owners, dates or decisions.
- An action item is a concrete commitment or request someone accepted ("I'll call them by Wednesday", \
"Alex, can you send me the list?" + "Sure"). Ideas, status updates and complaints are not actions.
- Owner = the person who committed or was asked and agreed. Use full names from the staff list. If a \
speaker label has not been mapped to a name, infer it from how others address them; otherwise 'Unassigned'.
- Resolve relative dates ("Thursday", "next Tuesday", "end of week") against the meeting date given. \
'This week' with no day = the Friday of the meeting week.
- A follow-up meeting only counts if a time or day was agreed. List it under follow_up_meetings ONLY - do not \
also add an action item to "put it on the calendar" or "schedule it" (the calendar invite is created from \
follow_up_meetings).
- Open questions = things someone explicitly raised and left undecided. Do not add your own concerns.
- recap_email_body ends with "Thanks," and nothing after it (the sender's name is added when it is sent).
- Transcription can misspell names and terms; correct them using the staff list and vocabulary.
- Keep it short and plain. Staff read this on a phone."""


def load_env():
    env = HERE / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def ts(sec: float) -> str:
    sec = int(sec)
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def render_md(meta: dict, m: Minutes, names: dict) -> str:
    out = [f"# {meta['title']} — minutes", "",
           f"**Date:** {meta['date']}  ·  "
           + ("**Speakers:** not separated (one microphone)" if meta.get("speaker_mode") == "unlabelled" else
              "**Attendees (speakers):** " + ", ".join(names.get(g.label, g.likely_name) for g in m.speaker_guesses)), "",
           "## Summary", "", m.summary, ""]
    if m.decisions:
        out += ["## Decisions", ""] + [f"- {d.decision} — *{d.made_by}*" for d in m.decisions] + [""]
    if m.action_items:
        out += ["## Action items (proposed — not created yet)", "",
                "| # | Task | Owner | Due | Related to |", "|---|---|---|---|---|"]
        for a in m.action_items:
            due = a.due_date or "—"
            if a.due_text:
                due += f" ({a.due_text})"
            out.append(f"| {a.id} | {a.task} | {a.owner} | {due} | {a.related_to or '—'} |")
        out.append("")
    if m.follow_up_meetings:
        out += ["## Follow-up meetings (proposed)", ""]
        for f in m.follow_up_meetings:
            out.append(f"- **{f.title}** — {f.date or 'date TBD'} {f.start_time} ({f.duration_minutes} min) · "
                       f"{', '.join(f.attendees)} · {f.purpose}")
        out.append("")
    if m.open_questions:
        out += ["## Open questions", ""] + [f"- {q}" for q in m.open_questions] + [""]
    out += ["## Discussion notes", ""]
    for t in m.topics:
        out.append(f"**{t.title}**")
        out += [f"- {n}" for n in t.notes]
        out.append("")
    out += ["## Who was speaking", ""]
    for g in m.speaker_guesses:
        confirmed = g.label in names
        out.append(f"- {g.label} → **{names.get(g.label, g.likely_name)}**"
                   + (" (confirmed)" if confirmed else f" (AI guess, {g.confidence}: {g.evidence})"))
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path)
    ap.add_argument("--names", default="", help='"Speaker 1=Maria Lopez,Speaker 2=Sam Carter"')
    args = ap.parse_args()

    folder = args.folder.resolve()
    data = json.loads((folder / "transcript.json").read_text())
    meta, turns = data["meta"], data["turns"]
    names = dict(p.split("=", 1) for p in args.names.split(",") if "=" in p)
    names = {k.strip(): v.strip() for k, v in names.items()}

    cfg = load_config()
    staff = load_staff(cfg)
    system = SYSTEM.format(org_name=cfg["org_name"], org_description=cfg["org_description"])
    meeting_day = dt.date.fromisoformat(meta["date"])
    unlabelled = meta.get("speaker_mode") == "unlabelled"
    if unlabelled:  # one microphone, voices not separated: no speaker prefix at all
        transcript = "\n".join(f"[{ts(t['start'])}] {t['text']}" for t in turns)
    else:
        transcript = "\n".join(
            f"[{ts(t['start'])}] {names.get(t['speaker'], t['speaker'])}"
            + (f" ({t['speaker']})" if t["speaker"] in names else "")
            + f": {t['text']}"
            for t in turns
        )
    if unlabelled:
        speaker_note = ("This transcript has NO speaker labels (one microphone in the room). Take a task owner ONLY "
                        "from a name actually spoken (e.g. \"Sam, can you...\" then agreement). Never guess an owner "
                        "from who seems to be talking; use 'Unassigned' instead. Return an empty speaker_guesses list.\n")
    elif names:
        speaker_note = f"Confirmed speaker names: {json.dumps(names)}\n"
    else:
        speaker_note = "Speaker names are NOT confirmed - infer them, and report your guesses in speaker_guesses.\n"
    context = (
        f"Meeting: {meta['title']}\n"
        f"Meeting date: {meeting_day.isoformat()} ({meeting_day.strftime('%A')})\n"
        f"Staff list: " + "; ".join(
            f"{s['name']} ({s['role']}; also called {', '.join(s.get('aliases', [])) or '-'})" for s in staff["staff"]
        ) + "\n"
        f"Vocabulary: {', '.join(staff['vocabulary'])}\n"
        + speaker_note
    )

    load_env()
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("No ANTHROPIC_API_KEY. Copy .env.example to .env and paste your key from console.anthropic.com.")
    # Explicit base_url: the shell may carry an ANTHROPIC_BASE_URL meant for another tool.
    client = anthropic.Anthropic(api_key=key, base_url="https://api.anthropic.com")

    print(f"Asking Claude ({MODEL}) for minutes…")
    try:
        resp = client.messages.parse(
            model=MODEL,
            max_tokens=16000,
            system=system,
            output_config={"effort": "high"},
            messages=[{"role": "user", "content": f"{context}\n<transcript>\n{transcript}\n</transcript>"}],
            output_format=Minutes,
            # On a safety decline, re-run on Anthropic's recommended fallback model instead of failing.
            extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
            extra_body={"fallbacks": "default"},
        )
    except anthropic.AuthenticationError:
        sys.exit("API key rejected - check ANTHROPIC_API_KEY in .env")
    except anthropic.RateLimitError:
        sys.exit("Rate limited by the Claude API - wait a minute and re-run.")
    except anthropic.APIStatusError as e:
        sys.exit(f"Claude API error {e.status_code}: {e.message}")
    except anthropic.APIConnectionError:
        sys.exit("Could not reach the Claude API - check the internet connection.")

    if resp.stop_reason == "refusal":
        sys.exit(f"Claude declined this transcript: {resp.stop_details}")
    if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
        sys.exit(f"Incomplete response (stop_reason={resp.stop_reason}); re-run.")

    m: Minutes = resp.parsed_output
    u = resp.usage
    cost = u.input_tokens * 4 / 1e6 + u.output_tokens * 20 / 1e6
    record = {"meta": meta, "confirmed_names": names, "model": resp.model,
              "usage": {"input_tokens": u.input_tokens, "output_tokens": u.output_tokens, "est_cost_usd": round(cost, 4)},
              "minutes": m.model_dump()}
    (folder / "minutes.json").write_text(json.dumps(record, indent=2))
    (folder / "minutes.md").write_text(render_md(meta, m, names))
    print(f"Done: {len(m.action_items)} actions, {len(m.decisions)} decisions, "
          f"{len(m.follow_up_meetings)} follow-ups · ~${cost:.3f}")
    print(f"MINUTES={folder / 'minutes.md'}")


if __name__ == "__main__":
    main()

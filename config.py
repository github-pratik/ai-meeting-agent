"""Shared settings. Organisation-specific values live in config.json (git-ignored);
config.example.json is the public demo default. Override the file with MEETING_AGENT_CONFIG=path."""
import json
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _resolve(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else HERE / path


def load_config() -> dict:
    env = os.environ.get("MEETING_AGENT_CONFIG")
    path = Path(env) if env else (HERE / "config.json" if (HERE / "config.json").exists() else HERE / "config.example.json")
    cfg = json.loads(path.read_text())
    cfg.setdefault("org_name", "Your Organization")
    cfg.setdefault("org_description", "a small organization")
    cfg.setdefault("staff_file", "staff.example.json")
    cfg.setdefault("meetings_dir", "meetings")
    cfg.setdefault("zoho_task_url", "")  # e.g. https://crm.zoho.com/crm/<org>/tab/Tasks/{}
    cfg.setdefault("admin_name", "An admin")  # who runs /meeting to create approved items
    cfg.setdefault("logo", "")           # file in web/static/, optional
    return cfg


def load_staff(cfg: dict | None = None) -> dict:
    cfg = cfg or load_config()
    return json.loads(_resolve(cfg["staff_file"]).read_text())


def meetings_dir(cfg: dict | None = None) -> Path:
    cfg = cfg or load_config()
    return _resolve(cfg["meetings_dir"])

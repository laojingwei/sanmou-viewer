# -*- coding: utf-8 -*-
"""配置解析：定位 Sanmou 数据库，管理应用级设置。"""
from __future__ import annotations

import json
import os
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = APP_DIR / "config.json"
EXPORT_DIR = APP_DIR / "exports"
SNAPSHOT_DIR = APP_DIR / ".snapshot"

# 常见的 Sanmou 数据目录名，用于自动探测
_APP_DIR_NAMES = ("com.sanmou.alliance-manager", "com.sanmou.alliance_manager")
_DB_NAMES = ("sanmou-alliance-manager.db", "sanmou_alliance_manager.db")


def _candidate_paths() -> list[Path]:
    """按优先级列出可能的数据库路径。"""
    out: list[Path] = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if not base:
            continue
        for name in _APP_DIR_NAMES:
            for db in _DB_NAMES:
                out.append(Path(base) / name / db)
    home = os.environ.get("USERPROFILE")
    if home:
        for name in _APP_DIR_NAMES:
            for db in _DB_NAMES:
                out.append(Path(home) / "AppData" / "Roaming" / name / db)
    return out


DEFAULT_CONFIG = {
    "database_path": "",
    "host": "127.0.0.1",
    "port": 8770,
    "prefer_live": True,
    "page_size": 50,
    "max_export_rows": 0,
}


def load_config() -> dict:
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception:
            pass

    if cfg.get("database_path"):
        p = Path(cfg["database_path"]).expanduser()
        if p.exists():
            return cfg
        cfg["database_path"] = ""
        cfg["_warning"] = f"配置的数据库路径不存在：{p}"

    for cand in _candidate_paths():
        if cand.exists():
            cfg["database_path"] = str(cand)
            break
    return cfg


def save_config(cfg: dict) -> None:
    data = {k: v for k, v in cfg.items() if not k.startswith("_")}
    CONFIG_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def ensure_dirs() -> None:
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

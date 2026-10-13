# -*- coding: utf-8 -*-
"""战报数据源：发现 Sanmou 抓取到的战报 JSON，并导出为 alliance-counter 可用的格式。

数据来源
--------
Sanmou 抓取模块把战报写在：

    <APPDATA>/com.sanmou.alliance-manager/battle-grabber-v6/output/workspaces/
        <工作区>/alliance_protocol/
            alliance_battles.persist.json      累计全量
            alliance_battles.persist.jsonl     同上，行式（可流式）
        <工作区>/capture_*/alliance_protocol/
            alliance_battles.latest.json       每次抓取的快照
            ocr_alliance_battles.latest.json   OCR 来源（若有）

重要：Sanmou 界面上的「总记录数」是把 **persist + 所有 latest.json 合并去重** 后的结果
（见 src-tauri/src/battle_grabber.rs 的 latest_alliance_records）。
只读 persist.json 会少算——实测 9,336 vs 9,900。所以本模块默认提供「合并全部来源」。
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

# 兵种 ID → 名称（与 sanmou 源码 armsNameFromId 一致）
ARMS_NAME = {1: "盾兵", 2: "弓兵", 3: "枪兵", 4: "骑兵"}

# 属性 key → 数组下标（武力/智力/统率/速度）
ATTR_INDEX = {"might": 0, "intelligence": 1, "command": 2, "speed": 3}

WINNER_MAP = {
    "attacker_win": "atk",
    "defender_win": "def",
    "attacker": "atk",
    "defender": "def",
    "draw": "draw",
}


# ---------------------------------------------------------------- 数据源发现

def _app_roots() -> list[Path]:
    """列出 Sanmou 的应用数据目录（去重，避免 APPDATA 与 USERPROFILE 指向同一处）。"""
    seen: list[Path] = []
    for env in ("APPDATA", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            seen.append(Path(base) / "com.sanmou.alliance-manager")
    home = os.environ.get("USERPROFILE")
    if home:
        seen.append(Path(home) / "AppData" / "Roaming" / "com.sanmou.alliance-manager")

    out: list[Path] = []
    resolved: set[str] = set()
    for p in seen:
        if not p.exists():
            continue
        try:
            key = str(p.resolve()).lower()
        except OSError:
            key = str(p).lower()
        if key in resolved:
            continue
        resolved.add(key)
        out.append(p)
    return out


def _workspaces() -> list[Path]:
    out: list[Path] = []
    for root in _app_roots():
        ws_root = root / "battle-grabber-v6" / "output" / "workspaces"
        if not ws_root.is_dir():
            continue
        for ws in sorted(ws_root.iterdir()):
            if ws.is_dir():
                out.append(ws)
    return out


def find_sources() -> list[dict]:
    """列出所有可用的战报数据源（按路径去重）。

    每个工作区提供一个「合并全部来源」条目，以及若干单独文件条目。
    """
    items: list[dict] = []
    seen: set[str] = set()

    def add(path: Path, ws: str, label: str, group: str, merge: bool = False) -> None:
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = str(path).lower()
        if key in seen:
            return
        seen.add(key)
        items.append(_describe(path, ws, label, group, merge))

    for ws in _workspaces():
        name = ws.name
        # ① 合并来源（推荐，与 Sanmou 界面数字一致）
        persist_json = ws / "alliance_protocol" / "alliance_battles.persist.json"
        persist_jsonl = ws / "alliance_protocol" / "alliance_battles.persist.jsonl"
        if persist_json.exists() or persist_jsonl.exists():
            n_cap = len(list(ws.glob("capture_*/alliance_protocol/alliance_battles.latest.json")))
            add(ws, name, f"合并全部来源（累计 + {n_cap} 个捕获）", "merged", merge=True)

        # ② 累计文件（单独）
        if persist_jsonl.is_file():
            add(persist_jsonl, name, "累计(行式)", "persist")
        if persist_json.is_file():
            add(persist_json, name, "累计(整体)", "persist")

        # ③ 单次捕获
        for cap in sorted(ws.iterdir(), reverse=True):
            if not cap.is_dir() or not cap.name.startswith("capture_"):
                continue
            p = cap / "alliance_protocol" / "alliance_battles.latest.json"
            if p.is_file():
                add(p, name, f"捕获 {cap.name}", "capture")

    items.sort(key=lambda x: (x["kind_group"] != "merged", x["kind_group"] != "persist", -x["mtime"]))
    return items


def _describe(p: Path, workspace: str, label: str, group: str, merge: bool = False) -> dict:
    if merge and p.is_dir():
        st = p.stat()
        size = sum(f.stat().st_size for f in _merged_files(p))
        mtime = max((f.stat().st_mtime for f in _merged_files(p)), default=st.st_mtime)
        meta = _merged_meta(p)
    else:
        st = p.stat()
        size, mtime = st.st_size, st.st_mtime
        meta = _read_meta(p)
    return {
        "path": str(p),
        "name": p.name,
        "workspace": workspace,
        "label": label,
        "kind_group": group,
        "merge": merge,
        "size": size,
        "mtime": mtime,
        "modified": datetime.fromtimestamp(mtime).isoformat(timespec="seconds"),
        "meta": meta,
    }


def _merged_files(ws: Path) -> list[Path]:
    """合并来源包含的文件：persist + 所有 latest.json。"""
    out: list[Path] = []
    for name in ("alliance_battles.persist.jsonl", "alliance_battles.persist.json"):
        p = ws / "alliance_protocol" / name
        if p.is_file():
            out.append(p)
    out.extend(sorted(ws.rglob("alliance_battles.latest.json")))
    out.extend(sorted(ws.rglob("ocr_alliance_battles.latest.json")))
    return out


def _merged_meta(ws: Path) -> dict:
    """合并来源的元信息：只读 persist 的头（记录数需真正合并才知道）。"""
    for name in ("alliance_battles.persist.json", "alliance_battles.persist.jsonl"):
        p = ws / "alliance_protocol" / name
        if p.is_file():
            m = _read_meta(p)
            if m:
                return m
    return {}


def _read_meta(p: Path) -> dict:
    """读取文件开头的元信息（不解析全部内容）。"""
    if p.suffix == ".jsonl":
        return {}
    try:
        with open(p, "r", encoding="utf-8") as fh:
            head = fh.read(4096)
        i = head.find('"records"')
        if i < 0:
            return {}
        frag = head[:i].rstrip().rstrip(",") + "}"
        meta = json.loads(frag)
        return {k: v for k, v in meta.items() if isinstance(v, (str, int, float, bool))}
    except Exception:
        return {}


# ---------------------------------------------------------------- 读取

def _record_key(rec: dict) -> str:
    """与 Rust 端 alliance_record_key 保持一致。"""
    for f in ("battleCode", "combatCode", "blockHash", "combatHashKey", "recordKey"):
        v = rec.get(f)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            return s
    bid = str(rec.get("battleId") or "").strip()
    if not bid:
        return ""
    parts = []
    for f in ("parentBattleId", "battleId", "index"):
        v = rec.get(f)
        if v is None:
            continue
        s = str(v).strip()
        if s:
            parts.append(s)
    return ":".join(parts)


def _ts(rec: dict) -> int:
    v = rec.get("timeStamp")
    if isinstance(v, (int, float)):
        return int(v)
    try:
        return int(str(v))
    except (TypeError, ValueError):
        return 0


def _iter_file(path: Path):
    """逐个产出文件里的原始记录。"""
    if path.suffix == ".jsonl":
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue
    else:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            for r in data.get("records") or []:
                yield r
        elif isinstance(data, list):
            for r in data:
                yield r


def iter_merged(ws: Path, stats: dict | None = None):
    """合并一个工作区下的全部来源（与 Sanmou 的 latest_alliance_records 一致）。

    按 key 去重，timeStamp 大者胜出。
    stats 会被填入 {"scanned": 扫过的条数, "deduped": 去掉的重复数}。
    """
    by_key: dict[str, dict] = {}
    scanned = 0
    for p in _merged_files(ws):
        for i, rec in enumerate(_iter_file(p)):
            scanned += 1
            key = _record_key(rec) or f"{p}:{i}"
            old = by_key.get(key)
            if old is None or _ts(rec) > _ts(old):
                by_key[key] = rec
    if stats is not None:
        stats["scanned"] = scanned
        stats["deduped"] = scanned - len(by_key)
    # 与 Rust 一致：按 timeStamp 倒序
    for rec in sorted(by_key.values(), key=_ts, reverse=True):
        yield rec


def iter_records(path: str, merge: bool = False, stats: dict | None = None):
    """产出原始记录。path 为目录或 merge=True 时走合并模式。"""
    p = Path(path)
    if merge or p.is_dir():
        if not p.is_dir():
            raise FileNotFoundError(f"工作区目录不存在：{path}")
        yield from iter_merged(p, stats)
        return
    if not p.is_file():
        raise FileNotFoundError(f"文件不存在：{path}")
    for rec in _iter_file(p):
        if stats is not None:
            stats["scanned"] = stats.get("scanned", 0) + 1
        yield rec


# ---------------------------------------------------------------- 转换

def _attr_list(items) -> tuple[list, dict]:
    """把 equipAttrs / horseAttrs 转成 [武力,智力,统率,速度] + 特技特效。"""
    out = [None, None, None, None]
    extra: dict[str, str] = {}
    for a in items or []:
        key = a.get("key")
        if key in ATTR_INDEX:
            out[ATTR_INDEX[key]] = a.get("value")
        elif a.get("name"):
            extra[key] = a["name"]
    return out, extra


def _convert_hero(h: dict) -> dict:
    ea, ex_ea = _attr_list(h.get("equipAttrs"))
    ha, ex_ha = _attr_list(h.get("horseAttrs"))
    skills = h.get("skills") or []
    return {
        "n": h.get("name") or "",
        "i": h.get("index"),
        "lv": h.get("level"),
        "g": h.get("group"),
        "t": ARMS_NAME.get(h.get("basicArmsId"), ""),
        "ti": h.get("basicArmsId"),
        "red": h.get("evolution"),
        "pin": h.get("enlighten"),
        "sk": [f"{s.get('name')}(Lv{s.get('level')})" for s in skills],
        "sp": [s.get("orderLevel") for s in skills],
        "bk": [b.get("name") for b in (h.get("warbooks") or [])],
        "eq": h.get("equipName") or "",
        "eqs": ex_ea.get("skill", ""),
        "eqe": ex_ea.get("effect", ""),
        "eqa": ea,
        "ho": h.get("horseName") or "",
        "hos": ex_ha.get("skill", ""),
        "hoe": ex_ha.get("effect", ""),
        "hoa": ha,
        "o": h.get("originTroops"),
        "r": h.get("remainingTroops"),
        "w": h.get("wounded"),
        "d": h.get("dead"),
    }


def _convert_side(s: dict) -> dict:
    s = s or {}
    player = s.get("player") or {}
    totals = s.get("totals") or {}
    return {
        "p": player.get("name") or "",
        "a": player.get("allianceName") or "",
        "aid": player.get("avatarId") or "",
        "f": player.get("faction"),
        "b": player.get("bornStateId"),
        "fm": s.get("formationName") or "",
        "lu": s.get("lineup") or "",
        "wx": s.get("merit"),
        "mo": s.get("morale"),
        "role": s.get("roleId"),
        "o": totals.get("originTroops"),
        "r": totals.get("remainingTroops"),
        "w": totals.get("wounded"),
        "d": totals.get("dead"),
        "hs": [_convert_hero(h) for h in (s.get("heroes") or [])],
    }


def _convert_record(rec: dict) -> dict:
    return {
        "id": rec.get("battleId") or rec.get("recordKey") or "",
        "t": rec.get("recordType") or "",
        "pa": rec.get("parentBattleId") or "",
        "tm": rec.get("battleTime") or "",
        "ts": rec.get("timeStamp") or 0,
        "lo": rec.get("location") or "",
        "rs": WINNER_MAP.get(rec.get("winnerSide"), rec.get("result") or ""),
        "rt": rec.get("result") or "",
        "rd": rec.get("endRound"),
        "dr": rec.get("drawNum"),
        "cn": rec.get("childNum"),
        "A": _convert_side(rec.get("attacker")),
        "D": _convert_side(rec.get("defender")),
    }


def build_dataset(path: str, include_child: bool = True, merge: bool = False,
                  progress=None) -> dict:
    """读取并转换。merge=True（或 path 是目录）时合并全部来源。"""
    by_id: dict[str, dict] = {}
    scanned: dict = {}
    dropped_no_id = 0
    dropped_child = 0

    for raw in iter_records(path, merge=merge, stats=scanned):
        rec = _convert_record(raw)
        if not rec["id"]:
            dropped_no_id += 1
            continue
        if not include_child and rec["t"] == "child":
            dropped_child += 1
            continue
        old = by_id.get(rec["id"])
        if old is None or (rec["ts"] or 0) > (old["ts"] or 0):
            by_id[rec["id"]] = rec
        if progress and len(by_id) % 2000 == 0:
            progress(scanned.get("scanned", 0), len(by_id))

    records = sorted(by_id.values(), key=lambda r: -(r["ts"] or 0))
    stats = _stats(records, scanned.get("scanned", 0))
    stats["scanned"] = scanned.get("scanned", 0)   # 扫过的原始条数（含各来源重复）
    stats["deduped"] = scanned.get("deduped", 0)   # 合并来源时去掉的重复
    stats["dropped_no_id"] = dropped_no_id
    stats["dropped_child"] = dropped_child
    return {"records": records, "stats": stats}


def _stats(records: list[dict], raw_total: int) -> dict:
    blocks = [r for r in records if r["t"] != "child"]
    children = [r for r in records if r["t"] == "child"]
    ids = {r["id"] for r in records}
    linked = sum(1 for r in children if r["pa"] and r["pa"] in ids)
    heroes = sum(len(r["A"]["hs"]) + len(r["D"]["hs"]) for r in records)
    players = {r["A"]["p"] for r in records} | {r["D"]["p"] for r in records}
    times = [r["tm"] for r in records if r["tm"]]
    return {
        "raw_total": raw_total,
        "records": len(records),
        "blocks": len(blocks),
        "children": len(children),
        "children_linked": linked,
        "heroes": heroes,
        "players": len(players - {""}),
        "earliest": min(times) if times else "",
        "latest": max(times) if times else "",
    }


# ---------------------------------------------------------------- 脱敏

def anonymize(dataset: dict) -> dict:
    """把玩家名/同盟名替换为固定假名（保持一一对应）。"""
    players: dict[str, str] = {}
    alliances: dict[str, str] = {}

    def pname(v: str) -> str:
        if not v:
            return v
        if v not in players:
            players[v] = f"玩家{len(players) + 1:04d}"
        return players[v]

    def aname(v: str) -> str:
        if not v:
            return v
        if v not in alliances:
            alliances[v] = f"同盟{len(alliances) + 1:03d}"
        return alliances[v]

    for r in dataset["records"]:
        for k in ("A", "D"):
            s = r[k]
            s["p"] = pname(s["p"])
            s["a"] = aname(s["a"])
            s["aid"] = ""
    stats = dict(dataset["stats"])
    stats["anonymized_players"] = len(players)
    stats["anonymized_alliances"] = len(alliances)
    return {"records": dataset["records"], "stats": stats}


# ---------------------------------------------------------------- 输出格式

def to_counter_js(dataset: dict, source_name: str = "") -> str:
    """alliance-counter 可直接 <script src> 加载的 .js 数据文件。

    打包成 .js 而不是 .json：双击 index.html（file://）时 fetch 会被 CORS 拦截，
    而 <script src> 不受影响。
    """
    s = dataset["stats"]
    header = [
        "/* Sanmou 战报数据（由 sanmou-viewer 导出，勿手改）",
        f"   来源: {source_name}",
        f"   生成: {datetime.now().isoformat(timespec='seconds')}",
        f"   记录: {s['records']} 场（完整交战 {s['blocks']} / 续战段 {s['children']}）",
        f"   武将: {s['heroes']} 条 · 玩家: {s['players']} 人",
        f"   时间: {s['earliest']} ~ {s['latest']}",
        "   用法: 放到 alliance-counter/js/ 下，在 index.html 里用 <script src> 引入 */",
    ]
    payload = {
        "schema": "ac-battle-data-v1",
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": source_name,
        "stats": s,
        "records": dataset["records"],
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return "\n".join(header) + "\nwindow.AC = window.AC || {};\nwindow.AC.battleData = " + body + ";\n"


def to_counter_json(dataset: dict, source_name: str = "") -> str:
    payload = {
        "schema": "ac-battle-data-v1",
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": source_name,
        "stats": dataset["stats"],
        "records": dataset["records"],
    }
    return json.dumps(payload, ensure_ascii=False, indent=1)

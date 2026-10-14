# -*- coding: utf-8 -*-
"""战斗详情（回合明细）数据源：发现并读取 Sanmou 抓到的 1008 全量战报。

数据来源
--------
Sanmou 在客户端点开某场战斗详情时，会向服务器请求
``RPCGetAllCombatInfoResponse``（协议号 1008），抓包模块落盘并解析出：

    <APPDATA>/com.sanmou.alliance-manager/battle-grabber-v6/output/workspaces/
        <工作区>/capture_*/protocol/
            ..._recv_1008_RPCGetAllCombatInfoResponse/
                ..._eventDataList.parsed_events.json   原始解析事件（最全）
                ..._eventDataList.events.json          事件简表
        <工作区>/capture_*/reports/
            <id>.battle.json        Sanmou 生成的战斗报告（含双方阵容+事件流）
            <id>.battle.md / .readable.csv / .html / .txt
        <工作区>/reports.index.json(l)               全部报告的索引

注意：1008 是按需请求——只有被点开看过的战斗才有回合明细。
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

# 事件类型 ID → 名称（依据实测样本归纳）
EVENT_NAMES = {
    0: "列队布阵",
    50: "补给",
    52: "获得阵型",
    56: "阵营加成",
    100: "行动顺序",
    208: "损失兵力",
    211: "普通攻击",
    212: "战法效果",
    213: "属性变化",
    214: "战法发动",
    215: "治疗",
    218: "伤害",
    247: "增益",
    248: "减益",
}

# tab 值 → 页签名（与游戏内战报页签一致）
TAB_NAMES = {0: "概览", 1: "详情", 2: "状态", 3: "兵力", 4: "战法"}


def _app_roots() -> list[Path]:
    """列出 Sanmou 的应用数据目录（与 battles._app_roots 一致，去重）。"""
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


# ---------------------------------------------------------------- 报告发现

def _scan_workspace_reports(ws: Path) -> list[dict]:
    """扫描一个工作区下所有 capture 的 1008 抓包与 reports 目录。"""
    found: dict[str, dict] = {}   # id -> 报告条目
    for cap in sorted(ws.iterdir()):
        if not cap.is_dir() or not cap.name.startswith("capture_"):
            continue
        # ① Sanmou 已生成的报告（优先，含阵容）
        reports_dir = cap / "reports"
        if reports_dir.is_dir():
            for f in sorted(reports_dir.glob("*.battle.json")):
                rid = f.name[: -len(".battle.json")]
                found[rid] = {
                    "id": rid,
                    "capture": cap.name,
                    "report_json": str(f),
                    "md": str(f.with_name(rid + ".battle.md")),
                }
        # ② 只有抓包没生成报告的（回退：解析 parsed_events.json）
        for proto in cap.glob("protocol/*_recv_1008_*"):
            pe = None
            for cand in proto.glob("*.parsed_events.json"):
                pe = cand
                break
            if pe is None:
                continue
            rid = pe.name[: -len(".parsed_events.json")]
            if rid in found:
                continue
            found[rid] = {
                "id": rid,
                "capture": cap.name,
                "report_json": "",
                "md": "",
                "parsed_events": str(pe),
            }
    return list(found.values())


def list_reports(refresh: bool = False) -> dict:
    """列出所有有回合明细的战斗（按 capture 倒序）。

    返回 {"workspaces": [...], "reports": [...], "count": N}
    """
    items: list[dict] = []
    for ws in _workspaces():
        for rep in _scan_workspace_reports(ws):
            rep["workspace"] = ws.name
            rep["battle_id"] = ""
            rep["mtime"] = 0
            items.append(rep)

    items.sort(key=lambda x: (x.get("capture", ""), x["id"]), reverse=True)
    return {"reports": items, "count": len(items)}


# ---------------------------------------------------------------- 报告读取

def _load_report(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


ARMS_NAME = {1: "盾兵", 2: "弓兵", 3: "枪兵", 4: "骑兵"}


def _side_summary(side: dict) -> dict:
    """提取一侧的概要信息（结构见 battle.json 的 battleDetails.attacker/defender）。"""
    if not isinstance(side, dict):
        return {}
    player = side.get("player") or {}
    heroes_out = []
    for h in side.get("heroes") or []:
        heroes_out.append(
            {
                "id": str(h.get("heroId") or ""),
                "name": h.get("displayName") or h.get("name") or "",
                # position 是游戏内的站位序号（1/2/3），决定他填进阵型的哪个槽位
                "position": h.get("position"),
                "level": h.get("level"),
                "red": h.get("evolution"),
                "arms": ARMS_NAME.get(h.get("basicArmsId"), ""),
                "troops": h.get("remainingTroops"),
                "origin": h.get("originTroops"),
                "wounded": h.get("wounded"),
                "dead": h.get("dead"),
                "skills": [
                    f"{s.get('name')}(Lv{s.get('level')})"
                    for s in (h.get("skills") or [])
                    if s.get("name")
                ],
            }
        )
    return {
        "player": player.get("name") or "",
        "alliance": player.get("allianceName") or "",
        "formation": side.get("formationName") or "",
        "win": bool(side.get("winner")),
        "army_id": str(side.get("armyId") or ""),
        "morale": side.get("morale"),
        "heroes": heroes_out,
    }


def read_report(report: dict, max_events: int = 0) -> dict:
    """读取一份报告的完整内容，归一化为前端友好的结构。

    report 来自 list_reports() 的条目。max_events>0 时截断事件流。
    """
    rid = report["id"]
    detail: dict = {"id": rid, "events": [], "summary": {}, "source": ""}

    if report.get("report_json"):
        data = _load_report(report["report_json"])
        detail["source"] = report["report_json"]
        detail["summary"] = data.get("summary") or {}
        bd = data.get("battleDetails") or {}
        detail["battle"] = {
            "battleId": bd.get("battleId") or "",
            "endRound": bd.get("endRound"),
            "winnerArmyId": bd.get("winnerArmyId") or "",
            "location": bd.get("location") or "",
            "attacker": _side_summary(bd.get("attacker") or {}),
            "defender": _side_summary(bd.get("defender") or {}),
        }
        events = data.get("events") or []
    elif report.get("parsed_events"):
        with open(report["parsed_events"], "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        detail["source"] = report["parsed_events"]
        events = []
        for ev in raw:
            if isinstance(ev, dict) and "eventData" in ev:
                ed = ev.get("eventData") or {}
                desc = ed.get("finalDesc") or ""
                # 去掉游戏内富文本标记
                if "<" in desc:
                    import re
                    desc = re.sub(r"<[^>]+>", "", desc)
                events.append(
                    {
                        "seq": ev.get("index"),
                        "eventId": ev.get("eventId"),
                        "tab": ev.get("tab"),
                        "round": ed.get("round"),
                        "description": desc,
                        "teamId": ed.get("teamId") or "",
                        "heroId": ed.get("heroId") or "",
                        "skillId": ed.get("skillId") or "",
                        "changeSoldierNum": ed.get("changeSoldierNum"),
                        "resultSoldierNum": ed.get("resultSoldierNum"),
                    }
                )
    else:
        return detail

    # 统一事件字段 + 附加可读名称
    out = []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        eid = ev.get("eventId")
        row = {
            "seq": ev.get("seq"),
            "eventId": eid,
            "eventName": EVENT_NAMES.get(eid, ""),
            "tab": ev.get("tab"),
            "tabName": TAB_NAMES.get(ev.get("tab"), ""),
            "round": ev.get("round"),
            # 受击/受影响方
            "teamId": str(ev.get("teamId") or ""),
            "heroId": str(ev.get("heroId") or ""),
            # 施加方（伤害/效果的真正来源）—— 回放归因必须靠这两个字段
            "teamId2": str(ev.get("teamId2") or ""),
            "heroId2": str(ev.get("heroId2") or ""),
            "skillId": str(ev.get("skillId") or ""),
            "buffId": str(ev.get("buffId") or ""),
            "change": ev.get("changeSoldierNum"),
            "result": ev.get("resultSoldierNum"),
            "desc": ev.get("description") or "",
        }
        out.append(row)
    if max_events and len(out) > max_events:
        detail["events"] = out[:max_events]
        detail["events_truncated"] = True
        detail["events_total"] = len(out)
    else:
        detail["events"] = out
        detail["events_truncated"] = False
        detail["events_total"] = len(out)

    # 回放辅助数据：英雄/部队映射 + 初始兵力 + 队型
    detail["roster"] = _build_roster(detail.get("battle") or {}, out)
    return detail


def _build_roster(battle: dict, events: list[dict]) -> dict:
    """构建回放用的花名册：heroId → 展示信息，teamId → 阵营。

    事件流里同一武将的 heroId 在双方可能重复（如双方都有 heroId=2003 诸葛亮），
    必须用 (teamId, heroId) 二元组区分。
    """
    teams: dict[str, dict] = {}

    def ensure_team(tid: str, side_key: str) -> dict:
        if tid not in teams:
            teams[tid] = {"side": side_key, "heroes": {}}
        return teams[tid]

    for key in ("attacker", "defender"):
        side = battle.get(key) or {}
        side_key = "atk" if key == "attacker" else "def"
        tid = str(side.get("army_id") or "")
        if not tid:
            continue
        team = ensure_team(tid, side_key)
        team["player"] = side.get("player") or ""
        team["alliance"] = side.get("alliance") or ""
        team["formation"] = side.get("formation") or ""
        team["win"] = side.get("win")
        # 按游戏内 position 排序后分配槽位（第 N 个武将填第 N 个阵型槽），
        # 而不是依赖数组下标——数组顺序与 position 不一定一致，会导致武将站错位
        hero_list = list(side.get("heroes") or [])
        hero_list.sort(key=lambda h: (h.get("position") if isinstance(h.get("position"), int) else 999))
        for i, h in enumerate(hero_list):
            hid = str(h.get("id") or "")
            if not hid:
                continue
            team["heroes"][hid] = {
                "name": h.get("name") or "",
                "arms": h.get("arms") or "",
                "red": h.get("red"),
                "level": h.get("level"),
                # 剩余兵力作为初始值（战斗开始时），事件流里的 result 会覆盖
                "troops": h.get("troops") or 0,
                "origin": h.get("origin") or 0,
                # 伤兵 / 阵亡：用于把血条拆成「剩余兵力 / 伤兵 / 阵亡」三段
                "wounded": h.get("wounded") or 0,
                "dead": h.get("dead") or 0,
                "pos": i,           # 槽位序号 0..2（已按 position 排好）
                "position": h.get("position"),
                "skills": h.get("skills") or [],
            }

    # 从事件流兜底：roster 里没有的 (teamId, heroId) 组合补进去
    for ev in events:
        tid = ev.get("teamId") or ""
        hid = ev.get("heroId") or ""
        if tid and hid and hid not in (teams.get(tid) or {}).get("heroes", {}):
            team = ensure_team(tid, "")
            team["heroes"][hid] = {
                "name": f"武将{hid}", "arms": "", "red": None, "level": None,
                "troops": 0, "origin": 0, "pos": len(team["heroes"]),
                "skills": [],
            }

    return {"teams": teams}


def read_report_by_rid(rid: str, max_events: int = 0) -> dict:
    """按报告 ID 读取（重新扫描定位，避免前端持有过期路径）。"""
    for ws in _workspaces():
        for rep in _scan_workspace_reports(ws):
            if rep["id"] == rid:
                return read_report(rep, max_events=max_events)
    raise FileNotFoundError(f"未找到报告：{rid}")


def find_reports_by_battle(battle_id: str) -> list[dict]:
    """按战斗 ID（battleID / blockHash 里的数字）找有明细的报告。"""
    needle = str(battle_id).strip()
    if not needle:
        return []
    hits = []
    for ws in _workspaces():
        for rep in _scan_workspace_reports(ws):
            if needle == rep.get("battle_id") or needle in rep["id"]:
                hits.append(rep)
            elif rep.get("report_json"):
                bid = _report_battle_id(rep["report_json"])
                rep["battle_id"] = bid
                if needle == bid:
                    hits.append(rep)
    return hits


_BID_CACHE: dict[str, str] = {}


def _report_battle_id(report_json: str) -> str:
    """读取报告里的战斗 ID（带缓存，避免重复解析大文件）。"""
    if report_json in _BID_CACHE:
        return _BID_CACHE[report_json]
    bid = ""
    try:
        with open(report_json, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        bd = data.get("battleDetails") or {}
        bid = str(bd.get("battleId") or "")
    except Exception:  # noqa: BLE001
        pass
    _BID_CACHE[report_json] = bid
    return bid

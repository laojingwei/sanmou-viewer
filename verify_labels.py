# -*- coding: utf-8 -*-
"""验证中文名与深色主题相关接口。"""
import json
import urllib.request

BASE = "http://127.0.0.1:8770"


def call(path, payload=None, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={"Content-Type": "application/json"},
        method=method or ("POST" if data else "GET"),
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


print("=== 1. 表列表（中文名）===")
tables = call("/api/tables")["data"]
for t in tables[:8]:
    print("   %-26s %-14s %s 行" % (t["name"], t["label"], t["rows"]))

print("\n=== 2. 表结构（中文字段名）===")
d = call("/api/tables/member_snapshot")["data"]
print("表名: %s (%s)" % (d["label"], d["name"]))
print("说明: %s" % d["description"])
for c in d["columns"][:14]:
    enums = c.get("enums") or {}
    n = len(enums.get("options", []))
    print("   %-24s -> %-12s [%s]%s" % (
        c["name"], c["label"], c["kind"], "  枚举%d项" % n if n else ""))

print("\n=== 3. 查询结果带中文标签 ===")
q = call("/api/query", {
    "table": "member_snapshot",
    "columns": ["avatar_name", "official_name", "state", "weekly_merit", "profession_name"],
    "sort": [{"field": "weekly_merit", "dir": "desc"}],
    "page": 1, "page_size": 3,
})["data"]
print("表: %s" % q["table_label"])
print("列: %s" % " | ".join("%s(%s)" % (m["label"], m["name"]) for m in q["column_meta"]))
for r in q["rows"]:
    print("   %s | %s | %s | %s | %s" % (
        r["avatar_name"], r["official_name"], r["state"],
        r["weekly_merit"], r["profession_name"]))

print("\n=== 4. 枚举字段的可选值 ===")
d2 = call("/api/tables/lineup_matchup")["data"]
for c in d2["columns"]:
    if c["name"] in ("outcome", "winner_side"):
        print("   %s (%s):" % (c["label"], c["name"]))
        for o in c["enums"]["options"]:
            print("      %-14s -> %-8s (%s 场)" % (o["value"], o["label"], o["count"]))

print("\n=== 5. 导出 CSV：中文表头 + 枚举翻译 ===")
ex = call("/api/export", {
    "table": "lineup_matchup",
    "columns": ["attacker_player_name", "defender_player_name", "outcome", "battle_time"],
    "sort": [{"field": "battle_time", "dir": "desc"}],
    "format": "csv",
    "max_rows": 5,
    "header_lang": "zh",
    "translate_enums": True,
})["data"]
print("文件: %s (%s 行)" % (ex["filename"], ex["rows"]))
print("表头: %s" % ex["column_labels"])
with open(ex["path"], encoding="utf-8-sig") as fh:
    for i, line in enumerate(fh):
        print("   " + line.rstrip())
        if i >= 5:
            break

print("\n=== 6. 导出 CSV：英文表头对照 ===")
ex2 = call("/api/export", {
    "table": "lineup_matchup",
    "columns": ["attacker_player_name", "defender_player_name", "outcome"],
    "format": "csv",
    "max_rows": 2,
    "header_lang": "en",
})["data"]
print("表头: %s" % ex2["column_labels"])

print("\n=== 7. 字典统计 ===")
st = call("/api/status")["data"]
print("   %s" % st["label_stats"])

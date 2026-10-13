# -*- coding: utf-8 -*-
"""端到端验证：查询、筛选、排序、导出。"""
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


print("=== 4. 查询 + 排序（按周武勋降序）===")
q = call("/api/query", {
    "table": "member_snapshot",
    "columns": ["avatar_name", "official_name", "weekly_merit", "season_score"],
    "sort": [{"field": "weekly_merit", "dir": "desc"}],
    "page": 1, "page_size": 5,
})["data"]
print("total=%s pages=%s" % (q["total"], q["pages"]))
for r in q["rows"]:
    print("   %-18s %-12s 武勋=%-9s 赛季=%s" % (
        r["avatar_name"], r["official_name"], r["weekly_merit"], r["season_score"]))

print("\n=== 5. 多条件筛选（武勋>100万 且 名字含“小”）===")
q2 = call("/api/query", {
    "table": "member_snapshot",
    "columns": ["avatar_name", "weekly_merit"],
    "filters": [
        {"field": "weekly_merit", "op": "gt", "value": "1000000"},
        {"field": "avatar_name", "op": "contains", "value": "小"},
    ],
    "page": 1, "page_size": 5,
})["data"]
print("命中 %s 行" % q2["total"])
for r in q2["rows"]:
    print("   %-16s = %s" % (r["avatar_name"], r["weekly_merit"]))

print("\n=== 6. 战报表（lineup_matchup）最近对战 ===")
q3 = call("/api/query", {
    "table": "lineup_matchup",
    "columns": ["attacker_player_name", "defender_player_name", "outcome", "battle_time", "location"],
    "sort": [{"field": "battle_time", "dir": "desc"}],
    "page": 1, "page_size": 5,
})["data"]
print("total=%s" % q3["total"])
for r in q3["rows"]:
    print("   %s  vs  %s  -> %s  @%s %s" % (
        r["attacker_player_name"], r["defender_player_name"],
        r["outcome"], r["location"], r["battle_time"]))

print("\n=== 7. 导出 CSV（自定义字段）===")
ex = call("/api/export", {
    "table": "member_snapshot",
    "columns": ["avatar_name", "official_name", "weekly_merit", "season_score", "legion_name"],
    "filters": [{"field": "weekly_merit", "op": "gt", "value": "500000"}],
    "sort": [{"field": "weekly_merit", "dir": "desc"}],
    "format": "csv",
})["data"]
print("文件=%s  行数=%s  字段数=%s  大小=%s bytes" % (
    ex["filename"], ex["rows"], len(ex["columns"]), ex["size"]))
print("路径=%s" % ex["path"])

print("\n=== 8. 导出 Excel ===")
try:
    ex2 = call("/api/export", {
        "table": "lineup_matchup",
        "columns": ["attacker_player_name", "defender_player_name", "outcome"],
        "format": "xlsx",
    })["data"]
    print("OK 文件=%s 行数=%s" % (ex2["filename"], ex2["rows"]))
except Exception as e:
    print("xlsx 不可用（需 pip install openpyxl）：%s" % e)

print("\n=== 9. CSV 内容抽查（验证中文与表头）===")
with open(ex["path"], "rb") as fh:
    raw = fh.read()
print("BOM=%s" % (raw[:3] == b"\xef\xbb\xbf"))
text = raw.decode("utf-8-sig")
lines = text.splitlines()
print("表头: %s" % lines[0])
for ln in lines[1:4]:
    print("  %s" % ln)
print("总行数(含表头): %d" % len(lines))

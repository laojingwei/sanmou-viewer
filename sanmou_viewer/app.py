# -*- coding: utf-8 -*-
"""Sanmou 数据浏览器 —— Flask 应用入口。

只读访问 Sanmou 的 SQLite 数据库，提供网页浏览、筛选、排序与自定义字段导出。
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import traceback
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory

from . import battles, config, db, exporter, labels

APP_DIR = config.APP_DIR
STATIC_DIR = APP_DIR / "static"

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
app.json.ensure_ascii = False


def ok(payload=None, **extra):
    data = {"ok": True}
    if payload is not None:
        data["data"] = payload
    data.update(extra)
    return jsonify(data)


def fail(msg, code=400):
    return jsonify({"ok": False, "error": str(msg)}), code


@app.errorhandler(Exception)
def on_error(exc):  # noqa: ANN001
    if isinstance(exc, sqlite3.Error):
        return fail(f"数据库错误：{exc}", 500)
    if isinstance(exc, (ValueError, FileNotFoundError, RuntimeError)):
        return fail(exc, 400)
    traceback.print_exc()
    return fail(f"内部错误：{exc}", 500)


# ---------------------------------------------------------------- 页面

@app.get("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.get("/favicon.ico")
def favicon():
    # 项目暂无图标文件，返回 204 避免浏览器默认请求刷出 404 堆栈
    return "", 204


# ---------------------------------------------------------------- API

@app.get("/api/status")
def api_status():
    # 先建立连接，再读取状态，这样 mode 才是本次实际使用的模式
    reachable = True
    reach_error = None
    tables = None
    try:
        con = db.get_connection()
        try:
            tables = len(db.list_tables(con))
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001
        reachable = False
        reach_error = str(exc)

    st = db.get_status()
    st["export_dir"] = str(config.EXPORT_DIR)
    st["xlsx_available"] = exporter.HAS_XLSX
    st["tables"] = tables
    st["reachable"] = reachable
    st["reach_error"] = reach_error
    st["label_stats"] = labels.coverage()
    return ok(st)


@app.get("/api/labels")
def api_labels():
    """返回完整的中文字典，供前端本地翻译使用。"""
    return ok(
        {
            "tables": labels.TABLE_LABELS,
            "descriptions": labels.TABLE_DESCRIPTIONS,
            "columns": labels.COLUMN_LABELS,
            "overrides": labels.TABLE_COLUMN_OVERRIDES,
            "enums": labels.ENUM_LABELS,
            "enum_scope": {f"{k[0]}.{k[1]}": v for k, v in labels.ENUM_SCOPE.items()},
        }
    )


@app.get("/api/tables")
def api_tables():
    con = db.get_connection()
    try:
        return ok(db.list_tables(con))
    finally:
        con.close()


@app.get("/api/tables/<table>")
def api_table_detail(table: str):
    con = db.get_connection()
    try:
        return ok(db.describe_table(con, table))
    finally:
        con.close()


@app.post("/api/query")
def api_query():
    body = request.get_json(silent=True) or {}
    table = body.get("table")
    if not table:
        return fail("缺少 table 参数")
    con = db.get_connection()
    try:
        result = db.query_rows(
            con,
            table,
            columns=body.get("columns"),
            filters=body.get("filters"),
            sort=body.get("sort"),
            page=body.get("page", 1),
            page_size=body.get("page_size", 50),
        )
        return ok(result)
    finally:
        con.close()


@app.post("/api/export")
def api_export():
    body = request.get_json(silent=True) or {}
    table = body.get("table")
    if not table:
        return fail("缺少 table 参数")
    cfg = config.load_config()
    max_rows = body.get("max_rows")
    if max_rows in (None, ""):
        max_rows = cfg.get("max_export_rows", 0)
    con = db.get_connection()
    try:
        result = exporter.export_to_path(
            con,
            table,
            columns=body.get("columns"),
            filters=body.get("filters"),
            sort=body.get("sort"),
            fmt=body.get("format", "csv"),
            max_rows=int(max_rows or 0),
            header_lang=body.get("header_lang", "zh"),
            translate_enums=body.get("translate_enums", True),
        )
        return ok(result)
    finally:
        con.close()


@app.post("/api/export/preview")
def api_export_preview():
    body = request.get_json(silent=True) or {}
    table = body.get("table")
    if not table:
        return fail("缺少 table 参数")
    con = db.get_connection()
    try:
        text = exporter.preview_csv(
            con,
            table,
            columns=body.get("columns"),
            filters=body.get("filters"),
            sort=body.get("sort"),
            limit=int(body.get("limit", 20)),
            header_lang=body.get("header_lang", "zh"),
        )
        return ok({"preview": text})
    finally:
        con.close()


@app.get("/api/exports")
def api_exports():
    return ok(exporter.list_exports())


@app.get("/api/exports/download/<path:name>")
def api_export_download(name: str):
    safe = os.path.basename(name)
    path = config.EXPORT_DIR / safe
    if not path.exists() or not path.is_file():
        return fail("文件不存在", 404)
    return send_file(str(path), as_attachment=True, download_name=safe)


@app.delete("/api/exports/<path:name>")
def api_export_delete(name: str):
    deleted = exporter.delete_export(name)
    if not deleted:
        return fail("文件不存在", 404)
    return ok({"deleted": name})


@app.post("/api/snapshot")
def api_snapshot():
    return ok(db.refresh_snapshot())


# ---------------------------------------------------------------- 战报数据

@app.get("/api/battles/sources")
def api_battle_sources():
    """列出磁盘上可用的战报数据文件。"""
    try:
        items = battles.find_sources()
        return ok({"sources": items, "count": len(items)})
    except Exception as exc:  # noqa: BLE001
        return fail(f"扫描战报数据失败：{exc}")


@app.post("/api/battles/preview")
def api_battle_preview():
    """读取并转换，返回统计与样例（不落盘）。"""
    body = request.get_json(silent=True) or {}
    path = body.get("path")
    if not path:
        return fail("缺少 path 参数")
    if not os.path.exists(path):
        return fail(f"文件不存在：{path}")

    ds = battles.build_dataset(
        path,
        include_child=bool(body.get("include_child", True)),
        merge=bool(body.get("merge", False)),
    )
    sample = []
    for r in ds["records"][:3]:
        sample.append(
            {
                "id": r["id"],
                "type": r["t"],
                "time": r["tm"],
                "location": r["lo"],
                "result": r["rt"],
                "attacker": r["A"]["p"],
                "attacker_alliance": r["A"]["a"],
                "attacker_lineup": r["A"]["lu"],
                "defender": r["D"]["p"],
                "defender_alliance": r["D"]["a"],
                "defender_lineup": r["D"]["lu"],
                "heroes": [h["n"] for h in r["A"]["hs"]],
            }
        )
    return ok({"stats": ds["stats"], "sample": sample})


@app.post("/api/battles/export")
def api_battle_export():
    """导出为 alliance-counter 可用的数据文件。"""
    body = request.get_json(silent=True) or {}
    path = body.get("path")
    if not path:
        return fail("缺少 path 参数")
    if not os.path.exists(path):
        return fail(f"文件不存在：{path}")

    fmt = (body.get("format") or "js").lower()
    anon = bool(body.get("anonymize", False))
    include_child = bool(body.get("include_child", True))
    merge = bool(body.get("merge", False))

    ds = battles.build_dataset(path, include_child=include_child, merge=merge)
    if anon:
        ds = battles.anonymize(ds)

    config.ensure_dirs()
    src_name = os.path.basename(path)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    if fmt == "js":
        text = battles.to_counter_js(ds, src_name)
        ext = "js"
        fname = f"battle-data_{ts}.js"
    elif fmt == "json":
        text = battles.to_counter_json(ds, src_name)
        ext = "json"
        fname = f"battle-data_{ts}.json"
    elif fmt == "jsonl":
        lines = []
        for r in ds["records"]:
            lines.append(json.dumps(r, ensure_ascii=False))
        text = "\n".join(lines) + "\n"
        ext = "jsonl"
        fname = f"battle-data_{ts}.jsonl"
    else:
        return fail(f"不支持的格式：{fmt}")

    out_path = config.EXPORT_DIR / fname
    out_path.write_text(text, encoding="utf-8")

    return ok(
        {
            "ok": True,
            "path": str(out_path),
            "filename": fname,
            "format": ext,
            "size": out_path.stat().st_size,
            "anonymized": anon,
            "stats": ds["stats"],
        }
    )


@app.get("/api/battles/download/<path:name>")
def api_battle_download(name: str):
    safe = os.path.basename(name)
    p = config.EXPORT_DIR / safe
    if not p.exists() or not p.is_file():
        return fail("文件不存在", 404)
    return send_file(str(p), as_attachment=True, download_name=safe)


@app.post("/api/battles/raw")
def api_battle_raw():
    """把原始 JSON/JSONL 复制到导出目录，便于直接取用。"""
    body = request.get_json(silent=True) or {}
    path = body.get("path")
    if not path or not os.path.exists(path):
        return fail("文件不存在")
    config.ensure_dirs()
    src = Path(path)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = config.EXPORT_DIR / f"{src.stem}_{ts}{src.suffix}"
    shutil.copy2(str(src), str(dst))
    return ok(
        {
            "path": str(dst),
            "filename": dst.name,
            "size": dst.stat().st_size,
        }
    )


@app.get("/api/settings")
def api_settings_get():
    cfg = config.load_config()
    return ok(
        {
            "database_path": cfg.get("database_path"),
            "prefer_live": cfg.get("prefer_live", True),
            "page_size": cfg.get("page_size", 50),
            "max_export_rows": cfg.get("max_export_rows", 0),
            "warning": cfg.get("_warning"),
        }
    )


@app.post("/api/settings")
def api_settings_set():
    body = request.get_json(silent=True) or {}
    cfg = config.load_config()
    cfg.pop("_warning", None)
    if body.get("database_path"):
        p = os.path.expanduser(str(body["database_path"]))
        if not os.path.exists(p):
            return fail(f"路径不存在：{p}")
        cfg["database_path"] = p
    if "prefer_live" in body:
        cfg["prefer_live"] = bool(body["prefer_live"])
    if "page_size" in body:
        cfg["page_size"] = max(1, min(int(body["page_size"]), 500))
    if "max_export_rows" in body:
        cfg["max_export_rows"] = max(0, int(body["max_export_rows"]))
    config.save_config(cfg)
    return ok({"saved": True, "database_path": cfg.get("database_path")})


def create_app():
    config.ensure_dirs()
    return app

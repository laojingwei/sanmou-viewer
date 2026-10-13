# -*- coding: utf-8 -*-
"""导出模块：把选定字段的数据写成 CSV / JSON / XLSX。"""
from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from . import config, labels
from .db import iter_export_rows

try:  # 可选依赖
    import openpyxl  # type: ignore

    HAS_XLSX = True
except Exception:  # noqa: BLE001
    HAS_XLSX = False


def _safe_name(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]+', "_", str(s)).strip()
    return s[:80] or "export"


def make_filename(table: str, fmt: str, columns: list[str] | None) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    tag = f"_{len(columns)}fields" if columns else "_all"
    return f"{_safe_name(table)}{tag}_{ts}.{fmt}"


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, bytes):
        return f"<binary {len(v)} bytes>"
    return v


def export_to_path(
    con: sqlite3.Connection,
    table: str,
    columns: list[str] | None,
    filters: list[dict] | None,
    sort: list[dict] | None,
    fmt: str = "csv",
    max_rows: int = 0,
    header_lang: str = "zh",
    translate_enums: bool = True,
) -> dict:
    """执行导出，返回结果描述。文件写入项目 exports 目录。

    header_lang: 'zh' 使用中文表头，'en' 使用原始英文表头。
    translate_enums: 是否把 win/loss 这类枚举值翻译成中文。
    """
    config.ensure_dirs()
    fmt = (fmt or "csv").lower()
    if fmt == "xlsx" and not HAS_XLSX:
        raise RuntimeError("未安装 openpyxl，无法导出 Excel。可执行：pip install openpyxl")
    if fmt not in ("csv", "json", "jsonl", "xlsx"):
        raise ValueError(f"不支持的导出格式：{fmt}")

    out_path = config.EXPORT_DIR / make_filename(table, fmt, columns)
    count = 0
    used_cols: list[str] = []

    def headers_for(cols: list[str]) -> list[str]:
        if header_lang == "en":
            return list(cols)
        return [labels.column_label(table, c) for c in cols]

    def value_for(col: str, v):
        if translate_enums:
            v = labels.enum_value(table, col, v)
        return _cell(v)

    if fmt == "csv":
        # utf-8-sig 让 Excel 直接正确显示中文
        with open(out_path, "w", newline="", encoding="utf-8-sig") as fh:
            writer = None
            for cols, row in iter_export_rows(con, table, columns, filters, sort):
                if writer is None:
                    used_cols = cols
                    writer = csv.writer(fh)
                    writer.writerow(headers_for(cols))
                writer.writerow([value_for(c, row[c]) for c in cols])
                count += 1
                if max_rows and count >= max_rows:
                    break

    elif fmt in ("json", "jsonl"):
        # JSON 保持原始字段名，避免下游程序解析时产生歧义
        with open(out_path, "w", encoding="utf-8") as fh:
            if fmt == "json":
                fh.write("[\n")
            first = True
            for cols, row in iter_export_rows(con, table, columns, filters, sort):
                if not used_cols:
                    used_cols = cols
                item = json.dumps(row, ensure_ascii=False, default=str)
                if fmt == "jsonl":
                    fh.write(item + "\n")
                else:
                    fh.write(("" if first else ",\n") + item)
                    first = False
                count += 1
                if max_rows and count >= max_rows:
                    break
            if fmt == "json":
                fh.write("\n]\n")

    else:  # xlsx
        wb = openpyxl.Workbook(write_only=True)
        ws = wb.create_sheet(title=_safe_name(labels.table_label(table) if header_lang == "zh" else table)[:31])
        header_written = False
        for cols, row in iter_export_rows(con, table, columns, filters, sort):
            if not header_written:
                used_cols = cols
                ws.append(headers_for(cols))
                header_written = True
            ws.append([value_for(c, row[c]) for c in cols])
            count += 1
            if max_rows and count >= max_rows:
                break
        if not header_written:
            ws.append(headers_for(columns or []))
        wb.save(out_path)

    return {
        "ok": True,
        "path": str(out_path),
        "filename": out_path.name,
        "rows": count,
        "columns": used_cols,
        "column_labels": headers_for(used_cols) if used_cols else [],
        "format": fmt,
        "header_lang": header_lang,
        "size": out_path.stat().st_size if out_path.exists() else 0,
    }


def preview_csv(con, table, columns, filters, sort, limit=20, header_lang="zh") -> str:
    """生成一段 CSV 文本预览（用于导出前确认）。"""
    buf = io.StringIO()
    writer = csv.writer(buf)
    n = 0
    for cols, row in iter_export_rows(con, table, columns, filters, sort):
        if n == 0:
            if header_lang == "en":
                writer.writerow(cols)
            else:
                writer.writerow([labels.column_label(table, c) for c in cols])
        writer.writerow([
            _cell(labels.enum_value(table, c, row[c])) for c in cols
        ])
        n += 1
        if n >= limit:
            break
    return buf.getvalue()


def list_exports() -> list[dict]:
    config.ensure_dirs()
    items = []
    for p in sorted(config.EXPORT_DIR.glob("*"), key=lambda x: x.stat().st_mtime, reverse=True):
        if p.is_file():
            items.append(
                {
                    "name": p.name,
                    "path": str(p),
                    "size": p.stat().st_size,
                    "modified": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds"),
                }
            )
    return items


def delete_export(name: str) -> bool:
    """只允许删除 exports 目录内的文件。"""
    config.ensure_dirs()
    target = (config.EXPORT_DIR / Path(name).name).resolve()
    root = config.EXPORT_DIR.resolve()
    if root != target.parent:
        raise ValueError("非法路径")
    if target.exists() and target.is_file():
        target.unlink()
        return True
    return False

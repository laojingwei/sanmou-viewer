# -*- coding: utf-8 -*-
"""数据库访问层。

安全约定：对源库只做只读访问（mode=ro + query_only），
程序运行中也能安全读取；若源库被独占，则自动降级到快照副本。
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from . import config, labels

# ---------------------------------------------------------------- 连接管理

_lock = threading.RLock()
_state = {
    "mode": "unknown",       # live | snapshot | error
    "error": None,
    "snapshot_path": None,
    "snapshot_at": None,
    "db_path": None,
}
_SNAPSHOT_MAX_AGE = 90.0  # 秒；源库不可读时快照的复用时长


def _snapshot_paths() -> tuple[Path, Path]:
    base = config.SNAPSHOT_DIR / "snapshot.db"
    return base, config.SNAPSHOT_DIR


def _make_snapshot(src: str) -> Path:
    """复制 db/-wal/-shm 生成一致快照。"""
    config.ensure_dirs()
    dst, tmp_dir = _snapshot_paths()
    tmp = tmp_dir / "snapshot.tmp.db"
    for p in (tmp, Path(str(tmp) + "-wal"), Path(str(tmp) + "-shm")):
        if p.exists():
            p.unlink()
    for suffix in ("", "-wal", "-shm"):
        s = src + suffix
        if os.path.exists(s):
            shutil.copy2(s, str(tmp) + suffix)
    if dst.exists():
        dst.unlink()
    tmp.replace(dst)
    for suffix in ("-wal", "-shm"):
        p = Path(str(tmp) + suffix)
        if p.exists():
            p.unlink()
    return dst


def _try_connect(path: str, readonly: bool) -> sqlite3.Connection:
    if readonly:
        uri = "file:" + Path(path).as_posix() + "?mode=ro"
        con = sqlite3.connect(uri, uri=True, timeout=5)
        con.execute("PRAGMA query_only=1")
    else:
        con = sqlite3.connect(path, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def get_connection() -> sqlite3.Connection:
    """获取可用连接，必要时刷新快照。"""
    with _lock:
        cfg = config.load_config()
        src = cfg.get("database_path")
        if not src or not os.path.exists(src):
            _state.update(mode="error", error="未找到数据库文件", db_path=src)
            raise FileNotFoundError("未找到 Sanmou 数据库文件，请在设置中指定路径。")

        _state["db_path"] = src

        if cfg.get("prefer_live", True):
            try:
                con = _try_connect(src, readonly=True)
                con.execute("SELECT 1")
                _state.update(mode="live", error=None)
                return con
            except sqlite3.Error as exc:
                _state["error"] = f"源库只读打开失败，改用快照：{exc}"

        # 降级到快照
        snap, _ = _snapshot_paths()
        need = (
            not snap.exists()
            or _state["snapshot_at"] is None
            or (time.time() - _state["snapshot_at"]) > _SNAPSHOT_MAX_AGE
        )
        try:
            if need:
                snap = _make_snapshot(src)
                _state["snapshot_at"] = time.time()
            con = _try_connect(str(snap), readonly=False)
            _state.update(mode="snapshot", snapshot_path=str(snap))
            return con
        except Exception as exc:  # noqa: BLE001
            _state.update(mode="error", error=str(exc))
            raise


def refresh_snapshot() -> dict:
    with _lock:
        cfg = config.load_config()
        src = cfg.get("database_path")
        if not src or not os.path.exists(src):
            raise FileNotFoundError("未找到数据库文件")
        _make_snapshot(src)
        _state["snapshot_at"] = time.time()
        return get_status()


def get_status() -> dict:
    cfg = config.load_config()
    return {
        "mode": _state["mode"],
        "error": _state["error"],
        "db_path": _state["db_path"] or cfg.get("database_path"),
        "db_exists": bool(cfg.get("database_path") and os.path.exists(cfg["database_path"])),
        "db_size": _size_of(cfg.get("database_path")),
        "snapshot_at": _state["snapshot_at"],
        "prefer_live": cfg.get("prefer_live", True),
        "warning": cfg.get("_warning"),
    }


def _size_of(p) -> int | None:
    try:
        return os.path.getsize(p) if p and os.path.exists(p) else None
    except OSError:
        return None


# ---------------------------------------------------------------- 标识符安全

_IDENT_RE = re.compile(r"^[A-Za-z0-9_\u4e00-\u9fff]+$")


def quote_ident(name: str) -> str:
    """校验并引用表名/列名，阻断 SQL 注入。"""
    if not isinstance(name, str) or not name or not _IDENT_RE.match(name):
        raise ValueError(f"非法的标识符：{name!r}")
    return '"' + name + '"'


# ---------------------------------------------------------------- 元数据

_SYSTEM_TABLES = {"sqlite_sequence", "sqlite_stat1", "sqlite_stat4"}


def list_tables(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        "SELECT name, type FROM sqlite_master "
        "WHERE type IN ('table','view') ORDER BY name"
    ).fetchall()
    out = []
    for r in rows:
        name = r["name"]
        if name in _SYSTEM_TABLES:
            continue
        try:
            cnt = con.execute(f"SELECT COUNT(*) FROM {quote_ident(name)}").fetchone()[0]
        except sqlite3.Error:
            cnt = None
        try:
            cols = con.execute(f"PRAGMA table_info({quote_ident(name)})").fetchall()
            ncol = len(cols)
        except sqlite3.Error:
            ncol = 0
        out.append(
            {
                "name": name,
                "type": r["type"],
                "rows": cnt,
                "columns": ncol,
                "empty": (cnt == 0),
                "label": labels.table_label(name),
                "description": labels.table_description(name),
                "translated": labels.table_label(name) != name,
            }
        )
    return out


def _infer_kind(decl_type: str, samples: list) -> str:
    """结合声明类型与实际样本推断字段类型，便于前端选择筛选方式。"""
    t = (decl_type or "").upper()
    vals = [v for v in samples if v is not None and v != ""]
    if not vals:
        if "INT" in t:
            return "integer"
        if any(k in t for k in ("REAL", "FLOA", "DOUB", "NUM", "DEC")):
            return "number"
        return "text"
    all_int = all(isinstance(v, int) for v in vals)
    all_num = all(isinstance(v, (int, float)) for v in vals)
    if "INT" in t and all_int:
        return "integer"
    if any(k in t for k in ("REAL", "FLOA", "DOUB", "NUM", "DEC")) and all_num:
        return "number"
    # 时间形态识别
    iso = re.compile(r"^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?")
    if all(isinstance(v, str) and iso.match(v) for v in vals[:50]):
        return "datetime"
    if all_int:
        return "integer"
    if all_num:
        return "number"
    return "text"


def describe_table(con: sqlite3.Connection, table: str) -> dict:
    qt = quote_ident(table)
    cols = con.execute(f"PRAGMA table_info({qt})").fetchall()
    if not cols:
        raise ValueError(f"表不存在：{table}")

    info = []
    for c in cols:
        name = c["name"]
        try:
            samples = [
                r[0]
                for r in con.execute(
                    f"SELECT {quote_ident(name)} FROM {qt} "
                    f"WHERE {quote_ident(name)} IS NOT NULL LIMIT 60"
                ).fetchall()
            ]
        except sqlite3.Error:
            samples = []
        distinct = None
        try:
            distinct = con.execute(
                f"SELECT COUNT(DISTINCT {quote_ident(name)}) FROM {qt}"
            ).fetchone()[0]
        except sqlite3.Error:
            pass
        info.append(
            {
                "name": name,
                "decl_type": c["type"] or "",
                "notnull": bool(c["notnull"]),
                "pk": bool(c["pk"]),
                "kind": _infer_kind(c["type"], samples),
                "distinct": distinct,
                "sample": samples[:5],
                "label": labels.column_label(table, name),
                "translated": labels.column_label(table, name) != name,
                "enums": _enum_options(con, table, name, samples, distinct),
            }
        )

    total = con.execute(f"SELECT COUNT(*) FROM {qt}").fetchone()[0]
    return {
        "name": table,
        "label": labels.table_label(table),
        "description": labels.table_description(table),
        "columns": info,
        "rows": total,
    }


def _enum_options(con, table: str, column: str, samples: list, distinct) -> dict:
    """若该字段是枚举型（取值少且有中文译名），返回可选值列表。"""
    key = labels.ENUM_SCOPE.get((table, column))
    if not key or not distinct or distinct > 60:
        return {}
    try:
        rows = con.execute(
            f"SELECT {quote_ident(column)}, COUNT(*) FROM {quote_ident(table)} "
            f"GROUP BY 1 ORDER BY 2 DESC LIMIT 60"
        ).fetchall()
    except sqlite3.Error:
        return {}
    mapping = labels.ENUM_LABELS.get(key, {})
    options = []
    for raw, cnt in rows:
        if raw is None:
            continue
        text = mapping.get(str(raw))
        options.append({"value": raw, "label": text if text else str(raw), "count": cnt})
    return {"key": key, "options": options} if options else {}


# ---------------------------------------------------------------- 查询

def _build_filters(columns: list[dict], filters: list[dict]) -> tuple[str, list]:
    """把前端筛选条件转成 WHERE 子句。"""
    valid = {c["name"]: c for c in columns}
    clauses: list[str] = []
    params: list = []
    for f in filters or []:
        field = f.get("field")
        if field not in valid:
            continue
        op = (f.get("op") or "contains").lower()
        value = f.get("value")
        col = quote_ident(field)
        if op in ("isnull", "notnull"):
            clauses.append(f"{col} IS {'NULL' if op == 'isnull' else 'NOT NULL'}")
            continue
        if value is None or value == "":
            continue
        if op in ("contains", "notcontains"):
            clauses.append(f"{col} {'NOT LIKE' if op == 'notcontains' else 'LIKE'} ?")
            params.append(f"%{value}%")
        elif op in ("eq", "ne"):
            clauses.append(f"{col} {'<>' if op == 'ne' else '='} ?")
            params.append(value)
        elif op in ("gt", "gte", "lt", "lte"):
            sym = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}[op]
            clauses.append(f"{col} {sym} ?")
            params.append(value)
        elif op == "in":
            vals = value if isinstance(value, list) else [v.strip() for v in str(value).split(",") if v.strip()]
            if vals:
                clauses.append(f"{col} IN ({','.join('?' * len(vals))})")
                params.extend(vals)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params


def _build_order(columns: list[dict], sort: list[dict] | None, fallback_pk: str | None) -> str:
    valid = {c["name"] for c in columns}
    parts = []
    for s in sort or []:
        f = s.get("field")
        if f in valid:
            d = "DESC" if str(s.get("dir", "asc")).lower() == "desc" else "ASC"
            parts.append(f"{quote_ident(f)} {d}")
    if not parts and fallback_pk:
        parts.append(f"{quote_ident(fallback_pk)} DESC")
    return (" ORDER BY " + ", ".join(parts)) if parts else ""


def query_rows(
    con: sqlite3.Connection,
    table: str,
    columns: list[str] | None = None,
    filters: list[dict] | None = None,
    sort: list[dict] | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict:
    meta = describe_table(con, table)
    all_cols = meta["columns"]
    valid = {c["name"] for c in all_cols}
    picked = [c for c in (columns or []) if c in valid] or [c["name"] for c in all_cols]

    where, params = _build_filters(all_cols, filters or [])
    pk = next((c["name"] for c in all_cols if c["pk"]), None)
    order = _build_order(all_cols, sort, pk)

    total = con.execute(
        f"SELECT COUNT(*) FROM {quote_ident(table)}{where}", params
    ).fetchone()[0]

    page = max(1, int(page))
    page_size = max(1, min(int(page_size), 1000))
    offset = (page - 1) * page_size
    sel = ", ".join(quote_ident(c) for c in picked)
    rows = con.execute(
        f"SELECT {sel} FROM {quote_ident(table)}{where}{order} LIMIT ? OFFSET ?",
        params + [page_size, offset],
    ).fetchall()

    by_name = {c["name"]: c for c in all_cols}
    col_meta = [
        {
            "name": c,
            "label": labels.column_label(table, c),
            "kind": by_name.get(c, {}).get("kind", "text"),
            "enums": by_name.get(c, {}).get("enums") or {},
        }
        for c in picked
    ]

    return {
        "table": table,
        "table_label": labels.table_label(table),
        "columns": picked,
        "column_meta": col_meta,
        "all_columns": [
            {
                "name": c["name"],
                "label": labels.column_label(table, c["name"]),
                "kind": c["kind"],
                "pk": c["pk"],
            }
            for c in all_cols
        ],
        "rows": [dict(r) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": (total + page_size - 1) // page_size if page_size else 0,
        "sql": f"SELECT {sel} FROM {quote_ident(table)}{where}{order} LIMIT {page_size} OFFSET {offset}",
    }


def iter_export_rows(
    con: sqlite3.Connection,
    table: str,
    columns: list[str] | None,
    filters: list[dict] | None = None,
    sort: list[dict] | None = None,
    batch: int = 2000,
):
    """流式产出用于导出的行，避免一次性载入内存。"""
    meta = describe_table(con, table)
    all_cols = meta["columns"]
    valid = {c["name"] for c in all_cols}
    picked = [c for c in (columns or []) if c in valid] or [c["name"] for c in all_cols]

    where, params = _build_filters(all_cols, filters or [])
    pk = next((c["name"] for c in all_cols if c["pk"]), None)
    order = _build_order(all_cols, sort, pk)
    sel = ", ".join(quote_ident(c) for c in picked)

    cur = con.execute(
        f"SELECT {sel} FROM {quote_ident(table)}{where}{order}", params
    )
    while True:
        chunk = cur.fetchmany(batch)
        if not chunk:
            break
        for r in chunk:
            yield picked, dict(r)

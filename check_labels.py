# -*- coding: utf-8 -*-
"""检查中文字典对全部表和字段的覆盖率。

用法：
    python check_labels.py path/to/schema_dump.json

schema_dump.json 是从 Sanmou 数据库导出的表结构转储，格式形如：
    { "表名": { "columns": [ { "name": "字段名", ... }, ... ] }, ... }
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sanmou_viewer import labels


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python check_labels.py <schema_dump.json>")
        print("  schema_dump.json: 从 Sanmou 数据库导出的表结构转储文件")
        return 1

    with open(sys.argv[1], encoding="utf-8") as fh:
        schema = json.load(fh)

    missing_tables = []
    missing_cols = []

    for t, info in schema.items():
        if t not in labels.TABLE_LABELS:
            missing_tables.append(t)
        for c in info["columns"]:
            name = c["name"]
            if labels.column_label(t, name) == name:
                missing_cols.append((t, name))

    total_cols = sum(len(i["columns"]) for i in schema.values())
    print("表: %d/%d 有中文名" % (len(schema) - len(missing_tables), len(schema)))
    print("字段: %d/%d 有中文名" % (total_cols - len(missing_cols), total_cols))
    print()
    if missing_tables:
        print("缺中文名的表:", missing_tables)
    if missing_cols:
        print("缺中文名的字段 (%d 个):" % len(missing_cols))
        for t, c in missing_cols:
            print("   %-28s %s" % (t, c))
    else:
        print("全部字段均已覆盖 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())

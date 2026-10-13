# -*- coding: utf-8 -*-
"""启动入口：python run.py [--port 8770] [--host 127.0.0.1] [--no-browser]"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from sanmou_viewer import config
from sanmou_viewer.app import create_app


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanmou 数据浏览器")
    parser.add_argument("--host", default=None, help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=None, help="监听端口（默认 8770）")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--debug", action="store_true", help="开启调试模式")
    args = parser.parse_args()

    cfg = config.load_config()
    host = args.host or cfg.get("host", "127.0.0.1")
    port = args.port or cfg.get("port", 8770)

    print("=" * 62)
    print("  Sanmou 数据浏览器")
    print("=" * 62)
    if cfg.get("database_path"):
        print(f"  数据库：{cfg['database_path']}")
    else:
        print("  数据库：未找到（请在页面右上角“设置”中指定路径）")
    print(f"  导出目录：{config.EXPORT_DIR}")
    print(f"  访问地址：http://{host}:{port}")
    print("=" * 62)
    print("  按 Ctrl+C 停止服务")
    print()

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f"http://{host}:{port}")).start()

    app = create_app()
    app.run(host=host, port=port, debug=args.debug, use_reloader=False, threaded=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())

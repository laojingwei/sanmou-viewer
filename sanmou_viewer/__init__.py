# -*- coding: utf-8 -*-
"""Sanmou 数据浏览器。"""

import sys
from pathlib import Path

__version__ = "1.0.0"

# 允许把依赖装到项目内的 vendor/ 目录（无需管理员权限、不污染全局环境）
_VENDOR = Path(__file__).resolve().parent.parent / "vendor"
if _VENDOR.is_dir():
    _p = str(_VENDOR)
    if _p not in sys.path:
        sys.path.insert(0, _p)

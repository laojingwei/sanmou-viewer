# -*- coding: utf-8 -*-
"""中文字典：为表名、字段名和枚举值提供中文名称。

设计说明
--------
* 未收录的名称会原样返回（英文），保证任何新增字段都不会报错。
* 枚举值翻译只做展示层替换，不影响筛选与导出时使用的原始值。
"""
from __future__ import annotations

# ---------------------------------------------------------------- 表名

TABLE_LABELS: dict[str, str] = {
    "alliance": "同盟",
    "alliance_intel_entry": "同盟情报条目",
    "alliance_intel_snapshot": "同盟情报快照",
    "alliance_member_binding": "成员绑定关系",
    "app_setting": "应用设置",
    "battle_block": "战报区块",
    "building_snapshot": "建筑快照",
    "capture_session": "抓取会话",
    "export_job": "导出任务",
    "lineup_matchup": "阵容对战记录",
    "lineup_profile": "阵容档案",
    "lineup_stat": "阵容统计",
    "member_snapshot": "成员快照",
    "player": "玩家",
    "raw_artifact": "原始抓取文件",
    "union_group": "同盟分组",
    "union_log_event": "同盟日志",
    "workspace": "工作区",
}

TABLE_DESCRIPTIONS: dict[str, str] = {
    "alliance": "同盟基本信息",
    "alliance_intel_entry": "情报榜单中的每一条排名明细",
    "alliance_intel_snapshot": "某一时刻抓取到的情报榜单",
    "alliance_member_binding": "玩家账号与游戏角色的对应关系",
    "app_setting": "程序自身的配置项",
    "battle_block": "战报数据块（尚未抓取到数据）",
    "building_snapshot": "城池/建筑状态（尚未抓取到数据）",
    "capture_session": "每次数据抓取的会话记录",
    "export_job": "导出任务历史（尚未产生记录）",
    "lineup_matchup": "每一场战斗的攻守双方与胜负结果",
    "lineup_profile": "玩家常用阵容档案（尚未抓取到数据）",
    "lineup_stat": "按阵容汇总的胜负与伤亡统计",
    "member_snapshot": "同盟成员的各项数值快照",
    "player": "出现过的基础玩家信息",
    "raw_artifact": "抓取过程中保存的原始文件",
    "union_group": "同盟内部编组（尚未抓取到数据）",
    "union_log_event": "同盟人事、城池、攻城等事件日志",
    "workspace": "工作区（对应一个服务器/赛季）",
}

# ---------------------------------------------------------------- 字段名
# 全局通用字段：所有表共用同一套译名

COLUMN_LABELS: dict[str, str] = {
    # —— 主键与关联 ——
    "id": "ID",
    "workspace_id": "工作区ID",
    "alliance_id": "同盟ID",
    "capture_session_id": "抓取会话ID",
    "snapshot_id": "快照ID",
    "player_id": "玩家ID",
    "raw_artifact_id": "原始文件ID",

    # —— 时间 ——
    "created_at": "创建时间",
    "updated_at": "更新时间",
    "observed_at": "采集时间",
    "captured_at": "抓取时间",
    "started_at": "开始时间",
    "finished_at": "结束时间",
    "event_time": "事件时间",
    "battle_time": "战斗时间",
    "last_battle_time": "最后战斗时间",
    "valid_from": "生效开始",
    "valid_to": "生效结束",
    "last_offline_ts": "最后离线时间",
    "join_ts": "加入时间",

    # —— 玩家与成员 ——
    "avatar_id": "角色ID",
    "avatar_name": "角色名",
    "display_name": "玩家昵称",
    "player_name": "玩家名",
    "attacker_player_name": "进攻方玩家",
    "defender_player_name": "防守方玩家",
    "attacker_avatar_id": "进攻方角色ID",
    "defender_avatar_id": "防守方角色ID",
    "is_self": "是否本人",
    "is_online": "是否在线",
    "state": "状态",
    "official_name": "官职",
    "profession_name": "职业",
    "profession_id": "职业ID",
    "role_id": "职位ID",
    "legion_name": "军团名",
    "legion_id": "军团ID",
    "legion_leader": "是否军团长",
    "confidence": "可信度",
    "side": "所属方",
    "notes": "备注",

    # —— 数值 ——
    "prosperity": "繁荣度",
    "weekly_merit": "周武勋",
    "weekly_contribution": "周贡献",
    "season_score": "赛季积分",
    "demolition_value": "拆迁值",
    "coordinate_x": "坐标X",
    "coordinate_y": "坐标Y",
    "t_feat": "特性值",
    "t_forage_use": "总屯田消耗",
    "w_forage_use": "本周屯田消耗",
    "weekly_statistics_json": "每周统计(原始)",
    "raw_json": "原始数据",
    "metrics_json": "指标数据",
    "payload_json": "详细数据",
    "summary_json": "汇总数据",
    "extra_json": "附加数据",
    "heroes_json": "武将数据",
    "hero_ids_json": "武将ID列表",
    "hero_levels_json": "武将等级列表",
    "raw_event_json": "原始事件数据",
    "attacker_json": "进攻方数据",
    "defender_json": "防守方数据",
    "battlefield_environment_json": "战场环境数据",
    "request_json": "请求参数",
    "output_paths_json": "输出文件路径",

    # —— 工作区 / 同盟 ——
    "name": "名称",
    "server_name": "服务器",
    "season_name": "赛季",
    "alliance_game_id": "同盟游戏ID",
    "union_name": "所属同盟",
    "alliance_name": "同盟名",
    "group_id": "分组ID",
    "group_name": "分组名",
    "member_count": "成员数",
    "text": "日志内容",
    "actor_name": "操作者",
    "target_name": "对象",
    "log_category": "日志分类",
    "log_section": "日志板块",

    # —— 情报 ——
    "kind": "类型",
    "rank": "排名",
    "subject_key": "对象标识",
    "subject_label": "对象名称",
    "entry_count": "条目数",
    "value": "数值",
    "source_func": "来源接口",

    # —— 战斗 / 阵容 ——
    "battle_id": "战斗ID",
    "battle_code": "战斗编号",
    "record_index": "记录序号",
    "occurred_at": "发生时间",
    "location": "地点",
    "match_type": "匹配类型",
    "combat_type": "战斗类型",
    "scenario_id": "赛季场景ID",
    "end_round": "结束回合",
    "result": "结果",
    "winner_side": "胜方",
    "outcome": "胜负结果",
    "attacker_lineup_key": "进攻方阵容标识",
    "attacker_lineup_label": "进攻方阵容",
    "defender_lineup_key": "防守方阵容标识",
    "defender_lineup_label": "防守方阵容",
    "lineup_key": "阵容标识",
    "lineup_fingerprint": "阵容指纹",
    "label": "阵容名称",
    "formation_id": "阵型ID",
    "formation_name": "阵型",
    "avg_evolution": "平均红度",
    "battles": "总场次",
    "wins": "胜场",
    "losses": "负场",
    "draws": "平局",
    "attack_battles": "进攻场次",
    "defend_battles": "防守场次",
    "total_merit": "总武勋",
    "total_origin_troops": "我方原始兵力",
    "total_remaining_troops": "我方剩余兵力",
    "total_wounded": "我方伤兵",
    "total_dead": "我方阵亡",
    "total_enemy_origin_troops": "敌方原始兵力",
    "total_enemy_remaining_troops": "敌方剩余兵力",
    "total_enemy_wounded": "敌方伤兵",
    "total_enemy_dead": "敌方阵亡",
    "loss_exchange_ratio": "战损交换比",
    "source_battle_id": "来源战斗ID",

    # —— 建筑 ——
    "building_name": "建筑名",
    "facility_type": "设施类型",
    "facility_type_id": "设施类型ID",
    "role_facility_type": "角色设施类型",
    "cfg_id": "配置ID",
    "carrier_id": "占领方ID",
    "level": "等级",
    "status_id": "状态ID",
    "operator_avatar_id": "操作者角色ID",
    "operator_name": "操作者",
    "benefit": "收益",
    "mine_count": "已占领矿点",
    "max_mine_count": "矿点上限",
    "effect": "效果",

    # —— 抓取 / 文件 ——
    "capture_type": "抓取类型",
    "status": "状态",
    "path": "文件路径",
    "artifact_type": "文件类型",
    "source_module": "来源模块",
    "sha256": "文件校验值",
    "sensitive_scan_status": "敏感信息检查",
    "key": "配置项",
    "job_kind": "任务类型",
    "format": "格式",
    "target": "目标",

    # —— 兼容兜底 ——
    "workspace_name": "工作区名称",
    "server": "服务器",
}

# 同一字段在不同表中含义不同，按「表.字段」覆盖
TABLE_COLUMN_OVERRIDES: dict[str, dict[str, str]] = {
    "member_snapshot": {
        "state": "在线状态",
        "status": "状态",
    },
    "lineup_matchup": {
        "location": "战斗地点",
    },
    "union_log_event": {
        "text": "日志内容",
    },
    "alliance_intel_entry": {
        "name": "名称",
    },
    "capture_session": {
        "status": "状态",
    },
    "export_job": {
        "status": "状态",
    },
    "app_setting": {
        "key": "配置项",
        "value": "配置值",
    },
    "raw_artifact": {
        "path": "文件路径",
    },
}

# ---------------------------------------------------------------- 枚举值

ENUM_LABELS: dict[str, dict[str, str]] = {
    "outcome": {"win": "胜", "loss": "负", "draw": "平"},
    "result": {"win": "胜", "loss": "负", "draw": "平"},
    "winner_side": {
        "attacker_win": "进攻方胜",
        "defender_win": "防守方胜",
        "draw": "平局",
    },
    "state": {"在线": "在线", "离线": "离线"},
    "is_online": {"1": "在线", "0": "离线"},
    "is_self": {"1": "是", "0": "否"},
    "legion_leader": {"1": "是", "0": "否"},
    "side": {"attacker": "进攻方", "defender": "防守方"},
    "confidence": {"自动绑定": "自动绑定", "manual": "手动绑定"},
    "capture_type": {"alliance_data": "同盟数据", "battle_passive": "战报监听"},
    "status": {
        "completed": "已完成",
        "running": "进行中",
        "failed": "失败",
        "pending": "等待中",
    },
    "artifact_type": {
        "runtime_rpc_dump": "运行时协议数据",
        "capture_manifest": "抓取清单",
    },
    "sensitive_scan_status": {
        "flagged": "已标记",
        "clean": "无敏感信息",
        "passed": "检查通过",
    },
    "log_section": {
        "personnel": "人事",
        "city": "城池",
        "siege": "攻城",
        "system": "系统",
    },
    "log_category": {
        "personnel:join": "加入同盟",
        "personnel:leave": "退出同盟",
    },
    "kind": {
        "player_profile": "玩家档案",
        "server_rank": "全服排名",
    },
    "format": {"csv": "CSV", "xlsx": "Excel", "json": "JSON", "jsonl": "JSON Lines"},
    "match_type": {"0": "常规"},
    "combat_type": {"1": "常规战斗"},
    "job_kind": {"export": "导出"},
}

# 需要翻译枚举的表.字段（限定范围，避免误伤同名字段）
ENUM_SCOPE: dict[tuple[str, str], str] = {
    ("member_snapshot", "state"): "state",
    ("member_snapshot", "is_online"): "is_online",
    ("member_snapshot", "is_self"): "is_self",
    ("member_snapshot", "legion_leader"): "legion_leader",
    ("lineup_matchup", "outcome"): "outcome",
    ("lineup_matchup", "winner_side"): "winner_side",
    ("lineup_matchup", "match_type"): "match_type",
    ("lineup_matchup", "combat_type"): "combat_type",
    ("lineup_profile", "side"): "side",
    ("lineup_profile", "confidence"): "confidence",
    ("alliance_member_binding", "confidence"): "confidence",
    ("capture_session", "capture_type"): "capture_type",
    ("capture_session", "status"): "status",
    ("export_job", "status"): "status",
    ("export_job", "format"): "format",
    ("export_job", "job_kind"): "job_kind",
    ("raw_artifact", "artifact_type"): "artifact_type",
    ("raw_artifact", "sensitive_scan_status"): "sensitive_scan_status",
    ("union_log_event", "log_section"): "log_section",
    ("union_log_event", "log_category"): "log_category",
    ("alliance_intel_snapshot", "kind"): "kind",
    ("alliance_intel_entry", "kind"): "kind",
}


# ---------------------------------------------------------------- 查询接口

def table_label(table: str) -> str:
    """表的中文名，未收录则返回原名。"""
    return TABLE_LABELS.get(table, table)


def table_description(table: str) -> str:
    return TABLE_DESCRIPTIONS.get(table, "")


def column_label(table: str, column: str) -> str:
    """字段的中文名：先查表级覆盖，再查全局，最后返回原名。"""
    override = TABLE_COLUMN_OVERRIDES.get(table, {})
    if column in override:
        return override[column]
    return COLUMN_LABELS.get(column, column)


def is_translated(table: str, column: str) -> bool:
    return column_label(table, column) != column


def enum_value(table: str, column: str, value):
    """把枚举值翻译成中文；未收录则原样返回。"""
    key = ENUM_SCOPE.get((table, column))
    if not key:
        return value
    mapping = ENUM_LABELS.get(key, {})
    return mapping.get(str(value), value)


def decorate_columns(table: str, columns: list[dict]) -> list[dict]:
    """给表结构里的每个字段补上中文名。"""
    out = []
    for c in columns:
        c2 = dict(c)
        c2["label"] = column_label(table, c["name"])
        c2["translated"] = c2["label"] != c["name"]
        out.append(c2)
    return out


def decorate_tables(tables: list[dict]) -> list[dict]:
    out = []
    for t in tables:
        t2 = dict(t)
        t2["label"] = table_label(t["name"])
        t2["description"] = table_description(t["name"])
        t2["translated"] = t2["label"] != t["name"]
        out.append(t2)
    return out


def coverage() -> dict:
    """统计翻译覆盖率，便于自检。"""
    return {
        "tables": len(TABLE_LABELS),
        "columns": len(COLUMN_LABELS),
        "enums": len(ENUM_LABELS),
    }

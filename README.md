# Sanmou 数据浏览器

一个本地网页工具，用来查看 **[Sanmou Ledger](https://github.com/damiaozhang/sanmou-alliance-manager)**（三谋同盟管理）抓取到的数据，并支持**自定义选择字段导出为 CSV / Excel / JSON**。

程序对源数据库**只读访问**，不会修改或损坏原始数据。

> 感谢  [sanmou-alliance-manager](https://github.com/damiaozhang/sanmou-alliance-manager)  提供的开源工具

---

## 快速开始

双击 **`start.bat`** 即可。它会自动检查依赖、启动服务并打开浏览器。

或者手动启动：

```powershell
cd 你本地路径\sanmou-viewer
python run.py
```

默认地址：[http://127.0.0.1:8770](http://127.0.0.1:8770)

命令行参数：


| 参数             | 说明                     |
| ---------------- | ------------------------ |
| `--port 9000`    | 指定端口（默认 8770）    |
| `--host 0.0.0.0` | 允许局域网内其他设备访问 |
| `--no-browser`   | 启动后不自动打开浏览器   |
| `--debug`        | 调试模式                 |

---

## 功能

### 界面

- **深色主题为默认**，护眼不刺眼；顶栏可一键切换浅色 / 深色，选择会被记住
- **全中文界面**：18 张表、236 个字段都有中文名，看不懂的英文字段名不再是障碍
- 中文字段名下方以小字标注原始英文名，方便对照
- 顶栏可切换「中文 / 英文」显示，英文模式下完全按原字段名展示
- 顶栏「数据库表 / 战报数据」切换两个视图

### 战报数据导出（给 alliance-counter 用）

顶栏切到「战报数据」，可以把 Sanmou 抓包得到的战报转成
[alliance-counter](https://github.com/laojingwei/alliance-counter) 能直接加载的数据文件。

**不需要手动找文件**——viewer 会自动扫描本机 Sanmou 的抓取目录并列出可选数据源：

```
%APPDATA%\com.sanmou.alliance-manager\battle-grabber-v6\output\workspaces\
    <工作区>\alliance_protocol\
        alliance_battles.persist.jsonl      累计全量（抓取中会持续增长）
        alliance_battles.persist.json       同上，整体 JSON
    <工作区>\capture_*\alliance_protocol\
        alliance_battles.latest.json        每次抓取的快照
```

数据源分两类：


| 类型                     | 说明                                                         |
| ------------------------ | ------------------------------------------------------------ |
| **合并全部来源**（推荐） | 把累计数据与所有单次捕获合并去重，**数字与 Sanmou 界面一致** |
| 累计 / 单次捕获          | 单独文件，只读它会少算（实测少 564 条）                      |

> ⚠️ **为什么必须用「合并全部来源」**：Sanmou 界面显示的记录数来自
> `latest_alliance_records()`（见 `src-tauri/src/battle_grabber.rs:876`），
> 它会把 persist 与所有 `latest.json` 合并去重。
> 只读 `persist.json` 会漏掉尚未写回累计文件的记录。
>
> 实测：只读累计 9,336 条 → 合并后 **9,900 条**（与界面完全一致）。
> 合并过程会扫过 30,354 条原始记录，去掉 20,300 条重复。

操作步骤：

1. 切到「战报数据」，选「合并全部来源」（默认只显示汇总来源）
2. 点「预览统计」确认数据正常（会显示记录数、去重情况、父战报匹配率、样例）
3. 点「导出数据文件」，得到 `battle-data_<时间戳>.js`

> **关于数字变动**：若 Sanmou 正在抓取，`persist.json` 和 `latest.json` 会持续写入，
> 每次预览/导出的数字都可能变大。这是正常的——和 Sanmou 界面一样，
> 它是「读取那一刻」的快照。想要固定结果，先停止抓取再导出。

**为什么导出 `.js` 而不是 `.json`**：alliance-counter 是纯静态页面，
用户可能双击 `index.html` 打开，此时 `fetch("x.json")` 会被浏览器 CORS 拦截，
而 `<script src="x.js">` 不受影响。

导出选项：


| 选项       | 说明                                                     |
| ---------- | -------------------------------------------------------- |
| 输出格式   | `.js`（给 AC 用）/ `.json`（通用）/ `.jsonl`（每行一条） |
| 脱敏       | 玩家名、同盟名替换为「玩家0001」「同盟001」等固定假名    |
| 保留续战段 | 保留`child` 记录，让明细更完整（AC 统计时会自动过滤）    |

导出文件会带上统计头注释：

```js
/* Sanmou 战报数据（由 sanmou-viewer 导出，勿手改）
   来源: alliance_battles.persist.jsonl
   记录: 9335 场（完整交战 4789 / 续战段 4546）
   武将: 54044 条 · 玩家: 401 人
   时间: 2026-10-10T21:47:18 ~ 2026-10-13T03:24:42 */
window.AC = window.AC || {};
window.AC.battleData = {...};
```

在 alliance-counter 里使用：

```html
<script src="js/battle-data.js"></script>      <!-- viewer 导出的数据 -->
<script src="js/sanmou-source.js"></script>    <!-- AC 侧的加载器 -->
<script src="js/app.js"></script>
```

实测数据（合并全部来源，与 Sanmou 界面一致）：


| 指标              | 值            |
| ----------------- | ------------- |
| 扫描原始记录      | 30,354 条     |
| 去掉重复          | 20,300 条     |
| 最终战报          | 10,054 场     |
| 完整交战 / 续战段 | 5,169 / 4,885 |
| 武将记录          | 58,254 条     |
| 父战报匹配率      | **99.4%**     |
| 导出文件大小      | 约 27 MB      |

### 数据浏览

- 左侧列出全部数据表及行数，支持搜索表名、隐藏空表
- 分页查看（20 / 50 / 100 / 200 / 500 行每页）
- 点击表头排序（升序 → 降序 → 取消）
- 枚举值自动翻译成中文，如 `win` → **胜**、`1` → **在线**

### 字段选择

- 点「字段」按钮，勾选任意字段组合
- 支持全选 / 全不选 / 反选 / 按中英文名称搜索
- 每个字段标注类型和去重值数量
- 表格只显示选中的列，点「应用」刷新

### 筛选

- 点「筛选」按钮添加条件，支持「并且」组合多个条件
- 运算符：包含、不包含、等于、不等于、大于、大于等于、小于、小于等于、属于（逗号分隔）、为空、不为空
- **枚举字段自动变成下拉框**，直接选「胜 / 负 / 平」，不用手输 `win`
- 已生效的筛选条件以标签形式展示，可单独移除或一键清空

### 导出（核心功能）

点「导出」按钮，在对话框中：

1. **导出范围**：当前选中字段 / 全部字段
2. **导出条数**：全部筛选结果 / 仅当前页
3. **文件格式**：
   - **CSV** —— 带 UTF-8 BOM，Excel 双击即可正确显示中文
   - **Excel (.xlsx)**
   - **JSON**（数组）/ **JSON Lines**（每行一条）
4. **表头语言**：中文（如「周武勋」）/ 英文（如「weekly_merit」）
5. **取值翻译**：可勾选把 `win` / `loss` 也翻译成「胜 / 负」
6. **限制最大行数**（0 = 不限制）
7. 可先点「预览」查看前 20 行效果

> JSON 格式始终使用原始英文字段名，便于其他程序解析。

导出文件保存在项目的 `exports/` 目录，页面顶部的「导出文件」按钮可查看、下载、删除历史导出。

---

## 数据来源

默认自动定位 Sanmou 的数据库：

```
C:\Users\<用户名>\AppData\Roaming\com.sanmou.alliance-manager\sanmou-alliance-manager.db
```

点右上角「设置」可以手动指定其他路径。

### 读取模式


| 模式                 | 说明                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **直连源库**（默认） | 以只读方式直接打开源数据库，数据永远是最新的；即使 Sanmou 程序正在运行也能安全读取            |
| **快照模式**         | 把`db` / `-wal` / `-shm` 复制一份到 `.snapshot/` 后读取。当源库被独占、只读打开失败时自动启用 |

顶栏徽标会显示当前模式。点「刷新快照」可手动重建快照。

> **关于 WAL**：Sanmou 使用 WAL 日志模式，部分最新数据可能还在 `.db-wal` 文件里。
> 本工具会自动带上 WAL 一起读取，所以看到的是完整数据。
> 但如果你用其他工具直接打开 `.db`，可能会「少数据」——建议先退出 Sanmou 程序。

---

## 项目结构

```
sanmou-viewer/
├── run.py                    启动入口
├── start.bat                 Windows 一键启动
├── requirements.txt          依赖清单
├── config.json               运行配置（首次保存设置后生成）
├── exports/                  导出的文件
├── .snapshot/                数据库快照（快照模式下使用）
├── vendor/                   项目内依赖（无需管理员权限安装）
├── verify_api.py             接口自检脚本
├── verify_labels.py          中文名与导出验证脚本
├── sanmou_viewer/
│   ├── __init__.py           包入口（自动加载 vendor/）
│   ├── config.py             配置与数据库定位
│   ├── labels.py             中文字典（表名/字段名/枚举值）
│   ├── db.py                 只读连接、元数据、查询、筛选
│   ├── battles.py            战报数据发现、解析、转换（给 alliance-counter）
│   ├── exporter.py           CSV / Excel / JSON 导出
│   └── app.py                Flask 路由
└── static/
    ├── index.html            页面结构
    ├── style.css             样式
    └── app.js                前端逻辑
```

---

## API


| 方法       | 路径                             | 说明                                   |
| ---------- | -------------------------------- | -------------------------------------- |
| GET        | `/api/status`                    | 连接状态、数据库路径、表数量、字典统计 |
| GET        | `/api/labels`                    | 完整中文字典（表名/字段名/枚举值）     |
| GET        | `/api/battles/sources`           | 扫描本机可用的战报数据源               |
| POST       | `/api/battles/preview`           | 读取并转换战报，返回统计与样例         |
| POST       | `/api/battles/export`            | 导出战报为 alliance-counter 可用格式   |
| GET        | `/api/battles/download/<文件名>` | 下载导出的战报文件                     |
| GET        | `/api/tables`                    | 所有表及行数（含中文名）               |
| GET        | `/api/tables/<表名>`             | 表结构（字段、类型、去重数、样例值）   |
| POST       | `/api/query`                     | 查询数据（支持字段、筛选、排序、分页） |
| POST       | `/api/export`                    | 执行导出                               |
| POST       | `/api/export/preview`            | 导出预览（前 N 行 CSV）                |
| GET        | `/api/exports`                   | 已导出文件列表                         |
| GET        | `/api/exports/download/<文件名>` | 下载导出文件                           |
| DELETE     | `/api/exports/<文件名>`          | 删除导出文件                           |
| POST       | `/api/snapshot`                  | 重建数据库快照                         |
| GET / POST | `/api/settings`                  | 读取 / 保存设置                        |

查询示例：

```json
POST /api/query
{
  "table": "member_snapshot",
  "columns": ["avatar_name", "weekly_merit"],
  "filters": [{"field": "weekly_merit", "op": "gt", "value": "1000000"}],
  "sort": [{"field": "weekly_merit", "dir": "desc"}],
  "page": 1,
  "page_size": 50
}
```

导出示例（中文表头 + 枚举翻译）：

```json
POST /api/export
{
  "table": "lineup_matchup",
  "columns": ["attacker_player_name", "defender_player_name", "outcome"],
  "format": "csv",
  "header_lang": "zh",
  "translate_enums": true
}
```

导出的 CSV 表头会变成「进攻方玩家,防守方玩家,胜负结果」，取值变成「胜 / 负 / 平」。

---

## 中文名是怎么来的

`sanmou_viewer/labels.py` 里维护了一套完整字典：

- **表名**：`member_snapshot` → 成员快照（附一句话说明）
- **字段名**：`weekly_merit` → 周武勋
- **枚举值**：`win` → 胜、`completed` → 已完成

几个设计要点：

- 同一字段在不同表里含义不同时，用「表.字段」覆盖，例如 `state` 在 `member_snapshot` 里是「在线状态」
- 字典里没有的名称会**原样返回英文**，所以将来 Sanmou 新增字段也不会报错
- 枚举翻译只在**展示层**生效，筛选和查询仍然用原始值，不会影响数据准确性
- JSON 导出刻意保留英文字段名，避免下游程序解析困难

新增字段时只要在 `labels.py` 的 `COLUMN_LABELS` 里加一行即可。

运行覆盖率自检：

```powershell
python check_labels.py
```

---

## 安全说明

- 对源库始终使用 `mode=ro` 只读连接并附加 `PRAGMA query_only=1`
- 表名、字段名经过白名单正则校验后才拼入 SQL，筛选值全部走参数绑定，无注入风险
- 导出与删除文件限制在项目的 `exports/` 目录内，防止路径穿越
- 服务默认只监听 `127.0.0.1`，不对外暴露

---

## 常见问题

**Q：页面上提示「未找到数据库文件」？**
点右上角「设置」，把数据库路径填成 Sanmou 的 `.db` 文件完整路径。

**Q：Sanmou 正在运行，能读吗？**
能。默认的直连模式就是只读的。如果确实打不开，会自动切到快照模式。

**Q：导出的 CSV 在 Excel 里中文乱码？**
本工具导出的 CSV 带 UTF-8 BOM，Excel 能正常识别。若仍有问题，用「数据 → 从文本/CSV」导入并选择 UTF-8。

**Q：导出 Excel 报错？**
需要 `openpyxl`。执行：

```powershell
python -m pip install --target vendor openpyxl
```

（装到项目内 `vendor/` 目录，无需管理员权限。）

**Q：数据表是空的？**
`battle_block`、`building_snapshot`、`union_group` 等表需要 Sanmou 完成对应类型的抓取后才会填充，属于正常现象。

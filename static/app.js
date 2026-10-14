/* Sanmou 数据浏览器 —— 前端逻辑 */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  tables: [],
  table: null,
  meta: null,            // { name, label, columns:[{name,label,kind,...}], rows }
  selected: [],          // 选中的字段名（始终存英文原名）
  filters: [],           // [{field, op, value}]
  sort: [],              // [{field, dir}]
  page: 1,
  pageSize: 50,
  total: 0,
  pages: 0,
  status: {},
  theme: 'dark',
  lang: 'zh',
  view: 'db',                       // db | battles
  battleSources: [],
  battleSource: null,               // 选中的源（路径）
  battleSourceInfo: null,           // 选中的源（完整信息，含 merge 标记）
  reports: [],                      // 有回合明细的战斗（列表）
  reportDetail: null,               // 当前打开的报告（详情）
  repShowAll: false,                // 事件流是否展开全部
  dict: { tables: {}, columns: {}, overrides: {}, enums: {}, enum_scope: {} },
};

const KIND_LABEL = {
  integer: '整数', number: '数值', text: '文本', datetime: '时间',
};

const OP_LABEL = {
  contains: '包含', notcontains: '不包含', eq: '等于', ne: '不等于',
  gt: '大于', gte: '大于等于', lt: '小于', lte: '小于等于',
  in: '属于(逗号分隔)', isnull: '为空', notnull: '不为空',
};

/* ------------------------------------------------------------------ 中文名 */

/** 字段中文名：优先用后端给的 label，其次查字典，最后回退原名 */
function colLabel(table, col, metaCol) {
  if (state.lang === 'en') return col;
  if (metaCol && metaCol.label) return metaCol.label;
  const ov = state.dict.overrides[table] || {};
  if (ov[col]) return ov[col];
  return state.dict.columns[col] || col;
}

function tblLabel(table) {
  if (state.lang === 'en') return table;
  return state.dict.tables[table] || table;
}

/** 枚举值中文：win → 胜 */
function enumLabel(table, col, value) {
  const key = state.dict.enum_scope[table + '.' + col];
  if (!key) return null;
  const m = state.dict.enums[key];
  if (!m) return null;
  return m[String(value)] || null;
}

/* ------------------------------------------------------------------ 工具 */

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error(`服务器返回异常 (HTTP ${res.status})`);
  }
  if (!body.ok) throw new Error(body.error || `请求失败 (HTTP ${res.status})`);
  return body.data !== undefined ? body.data : body;
}

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, type === 'err' ? 5200 : 2600);
}

function fmtNum(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('zh-CN');
}

function fmtSize(b) {
  if (!b && b !== 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
const escapeAttr = escapeHtml;

function openOverlay(id, show) {
  const el = document.getElementById(id);
  if (el) el.hidden = !show;
}

/* ------------------------------------------------------------------ 主题 */

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('sanmou-theme', theme); } catch (e) {}
  $$('#themeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.themeVal === theme);
  });
}

function applyLang(lang) {
  state.lang = lang;
  try { localStorage.setItem('sanmou-lang', lang); } catch (e) {}
  $$('#langSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  // 主题与语言：优先读取本地记忆
  let theme = 'dark', lang = 'zh';
  try {
    theme = localStorage.getItem('sanmou-theme') || 'dark';
    lang = localStorage.getItem('sanmou-lang') || 'zh';
  } catch (e) {}
  applyTheme(theme);
  applyLang(lang);

  await loadDict();
  await loadStatus();
  await loadTables();
  bindEvents();

  // 恢复上次的视图
  let view = 'db';
  try { view = localStorage.getItem('sanmou-view') || 'db'; } catch (e) {}
  setView(view);

  const cfg = await api('/api/settings').catch(() => null);
  if (cfg) {
    state.pageSize = cfg.page_size || 50;
    $('#pgSize').value = String(state.pageSize);
    $('#exportMaxRows').value = cfg.max_export_rows || 0;
  }
}

async function loadDict() {
  try {
    state.dict = await api('/api/labels');
  } catch (e) {
    console.warn('字典加载失败，将显示英文原名', e);
  }
}

async function loadStatus() {
  try {
    const st = await api('/api/status');
    state.status = st;
    const badge = $('#modeBadge');
    const modeMap = { live: ['直连源库', 'live'], snapshot: ['快照模式', 'snapshot'], error: ['连接失败', 'error'] };
    const [label, cls] = modeMap[st.mode] || ['未知', ''];
    badge.textContent = label;
    badge.className = 'badge ' + cls;
    $('#dbInfo').textContent = st.db_path
      ? `${st.db_path}${st.db_size ? ' · ' + fmtSize(st.db_size) : ''}`
      : '未找到数据库文件';
    if (st.mode === 'error' && st.error) toast(st.error, 'err');
  } catch (e) {
    $('#modeBadge').textContent = '连接失败';
    $('#modeBadge').className = 'badge error';
    $('#dbInfo').textContent = e.message;
  }
}

async function loadTables() {
  const list = $('#tableList');
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">'
    + '<span class="spinner"></span>加载中…</div>';
  try {
    state.tables = await api('/api/tables');
    renderTables();
  } catch (e) {
    list.innerHTML = `<div style="padding:18px;color:var(--err);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
}

function renderTables() {
  const kw = ($('#tableSearch').value || '').trim().toLowerCase();
  const hideEmpty = $('#hideEmpty').checked;
  const list = $('#tableList');
  const items = state.tables.filter(t => {
    if (hideEmpty && t.empty) return false;
    if (!kw) return true;
    // 中英文名都可搜
    return t.name.toLowerCase().includes(kw)
      || (t.label || '').toLowerCase().includes(kw)
      || (t.description || '').toLowerCase().includes(kw);
  });
  if (!items.length) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">没有匹配的表</div>';
    return;
  }
  list.innerHTML = items.map(t => {
    const zh = state.lang === 'en' ? t.name : (t.label || t.name);
    const showEn = state.lang === 'zh' && zh !== t.name;
    return `
    <div class="table-item ${t.empty ? 'empty' : ''} ${state.table === t.name ? 'active' : ''}"
         data-table="${escapeAttr(t.name)}"
         title="${escapeAttr((t.label || t.name) + (t.description ? ' —— ' + t.description : '') + '\n' + t.name + '\n' + fmtNum(t.rows) + ' 行')}">
      <span class="tmain">
        <span class="tname">${escapeHtml(zh)}</span>
        ${showEn ? `<span class="ten">${escapeHtml(t.name)}</span>` : ''}
      </span>
      <span class="trows">${fmtNum(t.rows)}</span>
    </div>`;
  }).join('');
}

/* ------------------------------------------------------------------ 选表 */

async function selectTable(name) {
  state.table = name;
  state.page = 1;
  state.filters = [];
  state.sort = [];
  renderTables();
  $('#emptyState').hidden = true;
  $('#workspace').hidden = false;

  const zh = tblLabel(name);
  $('#tableTitle').innerHTML = state.lang === 'zh' && zh !== name
    ? `${escapeHtml(zh)}<span class="tbl-en">${escapeHtml(name)}</span>`
    : escapeHtml(name);
  $('#tableMeta').innerHTML = '<span class="spinner"></span>读取结构…';
  $('#tableMsg').hidden = true;

  try {
    const meta = await api('/api/tables/' + encodeURIComponent(name));
    state.meta = meta;
    state.selected = meta.columns.map(c => c.name);
    const desc = meta.description ? ` · ${meta.description}` : '';
    $('#tableMeta').textContent =
      `${meta.columns.length} 个字段 · ${fmtNum(meta.rows)} 行数据${desc}`;
    renderColumnChips();
    renderFilterBar();
    await runQuery();
  } catch (e) {
    $('#tableMeta').textContent = '';
    toast(e.message, 'err');
  }
}

/* ------------------------------------------------------------------ 查询 */

async function runQuery() {
  if (!state.table) return;
  const tbody = $('#tbody');
  $('#tableMsg').hidden = false;
  $('#tableMsg').innerHTML = '<span class="spinner"></span>查询中…';
  tbody.innerHTML = '';
  $('#thead').innerHTML = '';

  try {
    const data = await api('/api/query', {
      method: 'POST',
      body: JSON.stringify({
        table: state.table,
        columns: state.selected,
        filters: state.filters,
        sort: state.sort,
        page: state.page,
        page_size: state.pageSize,
      }),
    });
    state.total = data.total;
    state.pages = data.pages;
    renderTable(data);
    renderPager();
    if (data.rows.length) {
      $('#tableMsg').hidden = true;
      $('#tableMsg').innerHTML = '';
    }
  } catch (e) {
    $('#tableMsg').hidden = false;
    $('#tableMsg').innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)}</div>`;
  }
}

function renderTable(data) {
  const metas = data.column_meta || [];
  const sortMap = {};
  state.sort.forEach(s => { sortMap[s.field] = s.dir; });

  // 表头：中文名为主，英文名以小字副标题显示
  $('#thead').innerHTML = '<tr><th class="rowno">#</th>' + metas.map(m => {
    const zh = colLabel(state.table, m.name, m);
    const showEn = state.lang === 'zh' && zh !== m.name;
    const dir = sortMap[m.name];
    const mark = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '';
    return `<th data-col="${escapeAttr(m.name)}" title="点击排序：${escapeAttr(zh)}（${escapeAttr(m.name)}）">
      ${escapeHtml(zh)}${mark ? `<span class="sort-mark">${mark}</span>` : ''}
      ${showEn ? `<span class="col-en">${escapeHtml(m.name)}</span>` : ''}
      <span class="kind">${KIND_LABEL[m.kind] || '文本'}</span>
    </th>`;
  }).join('') + '</tr>';

  const base = (state.page - 1) * state.pageSize;
  $('#tbody').innerHTML = data.rows.map((row, i) => {
    const tds = metas.map(m => {
      const raw = row[m.name];
      // 枚举值翻译（win → 胜）
      const zhEnum = state.lang === 'zh' ? enumLabel(state.table, m.name, raw) : null;
      if (zhEnum) {
        const tip = escapeAttr(String(raw));
        return `<td title="${tip}"><span class="enum-badge">${escapeHtml(zhEnum)}</span></td>`;
      }
      if (raw === null || raw === undefined) {
        return '<td class="null">NULL</td>';
      }
      let text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      if (text.length > 400) text = text.slice(0, 400) + '…';
      const cls = (m.kind === 'integer' || m.kind === 'number') ? 'num' : '';
      const tip = escapeAttr(text.length > 300 ? text.slice(0, 300) : text);
      return `<td class="${cls}" title="${tip}">${escapeHtml(text)}</td>`;
    }).join('');
    return `<tr><td class="rowno">${base + i + 1}</td>${tds}</tr>`;
  }).join('');

  if (!data.rows.length) {
    $('#tableMsg').hidden = false;
    $('#tableMsg').textContent = state.filters.length ? '没有符合筛选条件的数据' : '表中暂无数据';
  } else {
    $('#tableMsg').hidden = true;
  }
}

function renderPager() {
  $('#pagerInfo').textContent =
    `共 ${fmtNum(state.total)} 行 · 每页 ${state.pageSize} 行 · 第 ${state.page} / ${Math.max(1, state.pages)} 页`;
  $('#pgTotal').textContent = Math.max(1, state.pages);
  $('#pgInput').value = state.page;
  $('#pgInput').max = Math.max(1, state.pages);
  $('#pgFirst').disabled = state.page <= 1;
  $('#pgPrev').disabled = state.page <= 1;
  $('#pgNext').disabled = state.page >= state.pages;
  $('#pgLast').disabled = state.page >= state.pages;
}

/* ------------------------------------------------------------------ 字段 */

function renderColumnChips() {
  const box = $('#columnChips');
  const cols = state.meta ? state.meta.columns : [];
  const sel = state.selected;
  $('#colCount').textContent = sel.length;
  const foot = $('#colFootHint');
  if (foot) foot.textContent = `已选 ${sel.length} / ${cols.length} 个字段，点击「应用」刷新表格`;
  if (!cols.length) { box.innerHTML = ''; return; }
  if (sel.length === cols.length) {
    box.innerHTML = `<span class="chip">已选全部 ${cols.length} 个字段</span>`;
    return;
  }
  const byName = {};
  cols.forEach(c => { byName[c.name] = c; });
  const show = sel.slice(0, 14);
  box.innerHTML = show.map(c => {
    const zh = colLabel(state.table, c, byName[c]);
    const en = state.lang === 'zh' && zh !== c ? `<span class="k">${escapeHtml(c)}</span>` : '';
    return `<span class="chip">${escapeHtml(zh)}${en}</span>`;
  }).join('')
    + (sel.length > show.length ? `<span class="chip more">+${sel.length - show.length} 个</span>` : '')
    + (sel.length === 0 ? '<span class="chip more">未选择任何字段，将显示全部</span>' : '');
}

function renderColumnList() {
  const kw = ($('#colSearch').value || '').trim().toLowerCase();
  const cols = (state.meta ? state.meta.columns : []).filter(c => {
    if (!kw) return true;
    return c.name.toLowerCase().includes(kw)
      || (c.label || '').toLowerCase().includes(kw);
  });
  const selSet = new Set(state.selected);
  $('#colList').innerHTML = cols.map(c => {
    const zh = state.lang === 'en' ? c.name : (c.label || c.name);
    const showEn = state.lang === 'zh' && zh !== c.name;
    return `
    <label class="col-item">
      <input class="cbox" type="checkbox" data-col="${escapeAttr(c.name)}" ${selSet.has(c.name) ? 'checked' : ''}>
      <span class="cmain">
        <span class="cname" title="${escapeAttr(zh + ' (' + c.name + ')')}">${escapeHtml(zh)}${c.pk ? ' 🔑' : ''}</span>
        ${showEn ? `<span class="cen">${escapeHtml(c.name)}</span>` : ''}
      </span>
      <span class="ctype">${KIND_LABEL[c.kind] || '文本'}</span>
      <span class="cdist">${c.distinct !== null && c.distinct !== undefined ? fmtNum(c.distinct) + ' 种' : ''}</span>
    </label>`;
  }).join('')
    || '<div style="padding:16px;color:var(--muted);font-size:12px">没有匹配的字段</div>';
}

/* ------------------------------------------------------------------ 筛选 */

function renderFilterBar() {
  const bar = $('#filterBar');
  $('#filterCount').textContent = state.filters.length;
  if (!state.filters.length) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = state.filters.map((f, i) => {
    const zh = colLabel(state.table, f.field);
    const en = state.lang === 'zh' && zh !== f.field ? `<span class="k">${escapeHtml(f.field)}</span>` : '';
    // 枚举字段展示中文取值，如 outcome=win → 「胜负结果 等于 胜」
    let shown = String(f.value);
    if (state.lang === 'zh') {
      const zhEnum = enumLabel(state.table, f.field, f.value);
      if (zhEnum) shown = zhEnum;
    }
    const v = (f.op === 'isnull' || f.op === 'notnull')
      ? ''
      : ` “${escapeHtml(shown)}”`;
    return `<span class="filter-tag">
      ${escapeHtml(zh)}${en} ${OP_LABEL[f.op] || f.op}${v}
      <button data-rm-filter="${i}" title="移除">✕</button>
    </span>`;
  }).join('') + '<button class="btn ghost sm" id="btnClearAllFilters">清空全部</button>';
}

function renderFilterRows() {
  const cols = state.meta ? state.meta.columns : [];
  const box = $('#filterRows');
  if (!state.filters.length) {
    state.filters.push({ field: cols[0] ? cols[0].name : '', op: 'contains', value: '' });
  }
  box.innerHTML = state.filters.map((f, i) => {
    const fieldCol = cols.find(c => c.name === f.field);
    const enums = fieldCol && fieldCol.enums && fieldCol.enums.options ? fieldCol.enums.options : null;
    // 枚举字段用下拉选精确值，「包含」语义不适用，自动改为「等于」
    if (enums && (f.op === 'contains' || f.op === 'notcontains')) {
      f.op = 'eq';
      if (f.value === '' && enums.length) f.value = enums[0].value;
    }
    const fieldOpts = cols.map(c => {
      const zh = state.lang === 'en' ? c.name : (c.label || c.name);
      return `<option value="${escapeAttr(c.name)}" ${c.name === f.field ? 'selected' : ''}>${escapeHtml(zh)}</option>`;
    }).join('');
    const opOpts = Object.entries(OP_LABEL).map(([k, v]) =>
      `<option value="${k}" ${k === f.op ? 'selected' : ''}>${v}</option>`
    ).join('');
    // 枚举字段用下拉选择，避免手输英文
    const noValue = f.op === 'isnull' || f.op === 'notnull';
    let valInput;
    if (noValue) {
      valInput = '<input class="f-val" type="text" value="" placeholder="（无需填写）" disabled>';
    } else if (enums) {
      valInput = `<select class="f-val">${enums.map(o =>
        `<option value="${escapeAttr(String(o.value))}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${escapeHtml(o.label)} (${fmtNum(o.count)})</option>`
      ).join('')}</select>`;
    } else {
      valInput = `<input class="f-val" type="text" value="${escapeAttr(f.value ?? '')}" placeholder="值">`;
    }
    return `
    <div class="filter-row" data-idx="${i}">
      <select class="f-field">${fieldOpts}</select>
      <select class="f-op">${opOpts}</select>
      ${valInput}
      <button class="f-del" data-del="${i}" title="删除">✕</button>
    </div>`;
  }).join('');
}

function collectFilterRows() {
  const out = [];
  $$('#filterRows .filter-row').forEach(r => {
    const field = r.querySelector('.f-field').value;
    const op = r.querySelector('.f-op').value;
    const valEl = r.querySelector('.f-val');
    const value = valEl && !valEl.disabled ? valEl.value : '';
    if (!field) return;
    if (op !== 'isnull' && op !== 'notnull' && value === '') return;
    out.push({ field, op, value });
  });
  return out;
}

/* ------------------------------------------------------------------ 导出 */

function exportParams() {
  const scope = document.querySelector('input[name="scope"]:checked').value;
  const hlang = document.querySelector('input[name="hlang"]:checked').value;
  return {
    columns: scope === 'all' ? null : state.selected,
    filters: state.filters,
    sort: state.sort,
    header_lang: hlang,
    translate_enums: $('#translateEnums').checked,
  };
}

async function doExport() {
  const rowScope = document.querySelector('input[name="rows"]:checked').value;
  const format = $('#exportFormat').value;
  const maxRows = parseInt($('#exportMaxRows').value || '0', 10) || 0;
  const p = exportParams();

  const btn = $('#btnTableExport');
  btn.disabled = true;
  const old = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>导出中…';
  $('#exportResult').hidden = true;

  try {
    if (rowScope === 'page') {
      // 仅当前页：直接在前端生成 CSV
      const data = await api('/api/query', {
        method: 'POST',
        body: JSON.stringify({
          table: state.table, columns: p.columns, filters: p.filters, sort: p.sort,
          page: state.page, page_size: state.pageSize,
        }),
      });
      const headers = (data.column_meta || []).map(m =>
        p.header_lang === 'en' ? m.name : (m.label || m.name));
      const csv = toCsv(headers, data.column_meta, data.rows);
      downloadBlob(csv, `${state.table}_page${state.page}_${stamp()}.csv`);
      showExportResult({ rows: data.rows.length, filename: `当前页 ${data.rows.length} 行（浏览器下载）`, path: '' });
      toast(`已导出当前页 ${data.rows.length} 行`, 'ok');
    } else {
      const res = await api('/api/export', {
        method: 'POST',
        body: JSON.stringify({
          table: state.table,
          columns: p.columns,
          filters: p.filters,
          sort: p.sort,
          format,
          max_rows: maxRows,
          header_lang: p.header_lang,
          translate_enums: p.translate_enums,
        }),
      });
      showExportResult(res);
      toast(`导出完成：${fmtNum(res.rows)} 行`, 'ok');
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function showExportResult(res) {
  const box = $('#exportResult');
  box.hidden = false;
  if (res.path) {
    box.innerHTML = `已导出 <b>${fmtNum(res.rows)}</b> 行 × <b>${(res.columns || []).length}</b> 字段`
      + `（${fmtSize(res.size)}）<br>文件：${escapeHtml(res.filename)}`
      + ` · <a href="/api/exports/download/${encodeURIComponent(res.filename)}">下载</a>`;
  } else {
    box.textContent = res.filename;
  }
}

function toCsv(headers, metas, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.map(esc).join(',')];
  rows.forEach(r => {
    lines.push(metas.map(m => {
      const raw = r[m.name];
      const zh = state.lang === 'zh' ? enumLabel(state.table, m.name, raw) : null;
      return esc(zh || raw);
    }).join(','));
  });
  return '\uFEFF' + lines.join('\r\n');
}

function downloadBlob(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function previewExport() {
  const pre = $('#exportPreview');
  pre.textContent = '生成中…';
  try {
    const p = exportParams();
    const res = await api('/api/export/preview', {
      method: 'POST',
      body: JSON.stringify({
        table: state.table,
        columns: p.columns,
        filters: p.filters,
        sort: p.sort,
        limit: 20,
        header_lang: p.header_lang,
      }),
    });
    pre.textContent = res.preview || '（无数据）';
  } catch (e) {
    pre.textContent = '预览失败：' + e.message;
  }
}

async function loadFiles() {
  const box = $('#fileList');
  box.innerHTML = '<span class="spinner"></span>加载中…';
  try {
    const files = await api('/api/exports');
    if (!files.length) {
      box.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:14px">还没有导出过文件</div>';
      return;
    }
    box.innerHTML = files.map(f => `
      <div class="file-row">
        <span class="fname" title="${escapeAttr(f.path)}">${escapeHtml(f.name)}</span>
        <span class="fmeta">${fmtSize(f.size)} · ${escapeHtml(f.modified.replace('T', ' '))}</span>
        <a class="btn ghost sm" href="/api/exports/download/${encodeURIComponent(f.name)}">下载</a>
        <button class="btn ghost sm" data-del-file="${escapeAttr(f.name)}">删除</button>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ 战报数据 */

function setView(view) {
  state.view = view;
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  $('#viewDb').hidden = view !== 'db';
  $('#viewBattles').hidden = view !== 'battles';
  $('#viewReports').hidden = view !== 'reports';
  // 侧边栏只属于数据库视图
  const sb = $('.sidebar');
  if (sb) sb.style.display = view === 'db' ? '' : 'none';
  // 顶栏按钮按视图显示
  const dbOnly = ['#btnRefreshSnap'];
  dbOnly.forEach(sel => {
    const el = $(sel);
    if (el) el.hidden = view !== 'db';
  });
  try { localStorage.setItem('sanmou-view', view); } catch (e) {}
  if (view === 'battles' && !state.battleSources.length) loadBattleSources();
  if (view === 'reports' && !state.reports.length) loadReports();
}

async function loadBattleSources() {
  const box = $('#srcList');
  box.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);font-size:12px">'
    + '<span class="spinner"></span>扫描中…</div>';
  try {
    const res = await api('/api/battles/sources');
    state.battleSources = res.sources || [];
    renderBattleSources();
  } catch (e) {
    box.innerHTML = `<div style="padding:16px;color:var(--err);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
}

function renderBattleSources() {
  const box = $('#srcList');
  const onlySummary = $('#onlyPersist').checked;
  const items = state.battleSources.filter(
    s => !onlySummary || s.kind_group === 'merged' || s.kind_group === 'persist'
  );
  $('#srcCount').textContent = items.length;

  if (!items.length) {
    box.innerHTML = `<div style="padding:18px;color:var(--muted);font-size:13px;line-height:1.8">
      没有找到战报数据。<br>
      请先在 <b>Sanmou</b> 里完成一次战报抓取，然后点右上角「重新扫描」。</div>`;
    return;
  }

  box.innerHTML = items.map((s, i) => {
    const meta = s.meta || {};
    const extra = meta.recordCount
      ? `${fmtNum(meta.recordCount)} 场（主 ${fmtNum(meta.blockCount)} / 续 ${fmtNum(meta.childCount)}）`
      : '';
    const badge = s.merge
      ? '<span class="src-badge">推荐</span>'
      : (s.kind_group === 'capture' ? '<span class="src-badge dim">单次</span>' : '');
    return `
    <label class="src-item ${state.battleSource === s.path ? 'active' : ''}" data-idx="${i}">
      <input class="sradio" type="radio" name="bsrc" value="${escapeAttr(s.path)}"
             ${state.battleSource === s.path ? 'checked' : ''}>
      <span class="smain">
        <span class="slabel">${badge}${escapeHtml(s.label)} · ${escapeHtml(s.workspace)}</span>
        <span class="spath" title="${escapeAttr(s.path)}">${escapeHtml(s.path)}</span>
      </span>
      <span class="smeta">
        <span class="ssize">${fmtSize(s.size)}</span>
        ${escapeHtml(s.modified.replace('T', ' ').slice(0, 16))}
        ${extra ? `<br>${escapeHtml(extra)}` : ''}
      </span>
    </label>`;
  }).join('');
}

async function previewBattles() {
  if (!state.battleSource) { toast('请先选择一个数据源', 'err'); return; }
  const box = $('#statBox');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span>读取并转换中，大文件可能需要十几秒…';
  $('#bfResult').hidden = true;

  const btn = $('#btnPreview');
  btn.disabled = true;
  try {
    const res = await api('/api/battles/preview', {
      method: 'POST',
      body: JSON.stringify({
        path: state.battleSource,
        include_child: $('#bfChild').checked,
        merge: !!(state.battleSourceInfo && state.battleSourceInfo.merge),
      }),
    });
    renderBattleStats(res.stats, res.sample);
  } catch (e) {
    box.innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderBattleStats(s, sample) {
  const linkRate = s.children ? (100 * s.children_linked / s.children) : 100;
  const linkCls = linkRate >= 95 ? 'ok' : (linkRate >= 80 ? '' : 'warn');
  const isMerge = !!(state.battleSourceInfo && state.battleSourceInfo.merge);
  $('#statBox').innerHTML = `
    <div class="stat-grid">
      <div class="stat-item"><span class="k">战报记录</span><span class="v">${fmtNum(s.records)}</span></div>
      <div class="stat-item"><span class="k">完整交战 (block)</span><span class="v ok">${fmtNum(s.blocks)}</span></div>
      <div class="stat-item"><span class="k">续战段 (child)</span><span class="v">${fmtNum(s.children)}</span></div>
      <div class="stat-item"><span class="k">武将记录</span><span class="v">${fmtNum(s.heroes)}</span></div>
      <div class="stat-item"><span class="k">玩家数</span><span class="v">${fmtNum(s.players)}</span></div>
      <div class="stat-item"><span class="k">父战报匹配率</span><span class="v ${linkCls}">${linkRate.toFixed(1)}%</span></div>
    </div>
    <div class="stat-note">
      时间范围：${escapeHtml(s.earliest || '—')} ~ ${escapeHtml(s.latest || '—')}
      ${isMerge
        ? `<br>合并 ${fmtNum(s.scanned)} 条原始记录，去掉 ${fmtNum(s.deduped)} 条重复后得到 ${fmtNum(s.records)} 场。`
        : `<br>读取 ${fmtNum(s.scanned)} 条记录。`}
      ${isMerge ? '数字与 Sanmou 界面一致。' : ''}
      <br>⚠️ 若 Sanmou 正在抓取，这里的数字会持续变大——它与 Sanmou 界面一样，是「读取那一刻」的快照。
      ${linkRate < 95 ? '<br>⚠️ 父战报匹配率偏低，说明「战斗ID」列可能缺失，alliance-counter 会退回按兵力衔接识别续战。' : ''}
    </div>
    ${sample && sample.length ? `
    <table class="sample-table">
      <thead><tr><th>战斗</th><th>时间</th><th>攻方</th><th>阵容</th><th>守方</th><th>阵容</th></tr></thead>
      <tbody>${sample.map(r => `
        <tr>
          <td title="${escapeAttr(r.id)}">${escapeHtml(r.type)}</td>
          <td>${escapeHtml((r.time || '').replace('T', ' '))}</td>
          <td>${escapeHtml(r.attacker)}</td>
          <td title="${escapeAttr(r.attacker_lineup)}">${escapeHtml(r.attacker_lineup)}</td>
          <td>${escapeHtml(r.defender)}</td>
          <td title="${escapeAttr(r.defender_lineup)}">${escapeHtml(r.defender_lineup)}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : ''}`;
}

async function doBattleExport() {
  if (!state.battleSource) { toast('请先选择一个数据源', 'err'); return; }
  const btn = $('#btnDoExport');
  const old = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>导出中…';
  $('#bfResult').hidden = true;

  try {
    const res = await api('/api/battles/export', {
      method: 'POST',
      body: JSON.stringify({
        path: state.battleSource,
        format: $('#bfFormat').value,
        anonymize: $('#bfAnon').checked,
        include_child: $('#bfChild').checked,
        merge: !!(state.battleSourceInfo && state.battleSourceInfo.merge),
      }),
    });
    const box = $('#bfResult');
    box.hidden = false;
    box.innerHTML =
      `已导出 <b>${fmtNum(res.stats.records)}</b> 场战报（${fmtSize(res.size)}）` +
      (res.anonymized ? ' · 已脱敏' : '') +
      `<br>文件：${escapeHtml(res.filename)} · ` +
      `<a href="/api/battles/download/${encodeURIComponent(res.filename)}">下载</a>`;
    toast('导出完成：' + res.filename, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ------------------------------------------------------------------ 战斗详情（回合明细） */

async function loadReports() {
  const box = $('#repList');
  box.innerHTML = '<div style="padding:18px;text-align:center;color:var(--muted);font-size:12px">'
    + '<span class="spinner"></span>扫描中…</div>';
  try {
    const res = await api('/api/battle_reports');
    state.reports = res.reports || [];
    renderReports();
  } catch (e) {
    box.innerHTML = `<div style="padding:16px;color:var(--err);font-size:12px">${escapeHtml(e.message)}</div>`;
  }
}

function filteredReports() {
  const kw = ($('#repSearch').value || '').trim().toLowerCase();
  if (!kw) return state.reports;
  return state.reports.filter(r =>
    (r.id || '').toLowerCase().includes(kw)
    || (r.capture || '').toLowerCase().includes(kw)
  );
}

function renderReports() {
  const box = $('#repList');
  const items = filteredReports();
  $('#repCount').textContent = items.length;

  if (!items.length) {
    box.innerHTML = `<div style="padding:18px;color:var(--muted);font-size:13px;line-height:1.8">
      还没有可用的回合明细。<br>
      1008 战报是<b>按需抓取</b>的——只有当客户端在游戏里点开某场战斗的详情时才会被记录。<br>
      先在游戏里打开几场战报的「详情」，再回这里点「重新扫描」。</div>`;
    return;
  }

  box.innerHTML = items.map((r, i) => `
    <label class="src-item rep-item" data-rid="${escapeAttr(r.id)}" data-idx="${i}">
      <span class="smain">
        <span class="slabel">📋 ${escapeHtml(r.id.replace('_eventDataList', ''))}</span>
        <span class="spath" title="${escapeAttr(r.report_json || r.parsed_events || '')}">
          ${escapeHtml(r.workspace)} / ${escapeHtml(r.capture)}
          ${r.report_json ? '' : ' · <b>仅原始抓包</b>'}
        </span>
      </span>
      <span class="smeta">${escapeHtml((r.capture || '').replace('capture_', ''))}</span>
    </label>`).join('');
}

function sideHtml(side, title) {
  const heroes = (side.heroes || []).map(h => `
    <div class="rep-hero">
      <span class="rh-name">${escapeHtml(h.name)}</span>
      <span class="rh-meta">红${h.red ?? '?'} · Lv.${h.level ?? '?'} · ${escapeHtml(h.arms || '—')}</span>
      <span class="rh-troops">兵力 ${fmtNum(h.troops)}${h.origin ? ' / ' + fmtNum(h.origin) : ''}</span>
      ${h.skills && h.skills.length ? `<span class="rh-skills" title="${escapeAttr(h.skills.join('、'))}">${escapeHtml(h.skills.join('、'))}</span>` : ''}
    </div>`).join('');
  return `
    <div class="rep-side-box">
      <div class="rep-side-head">
        <span class="rs-title">${escapeHtml(title)}</span>
        <span class="rs-player">${escapeHtml(side.player || '—')}${side.alliance ? ' · ' + escapeHtml(side.alliance) : ''}</span>
        ${side.win ? '<span class="badge live">胜</span>' : '<span class="badge error">负</span>'}
      </div>
      <div class="rep-side-sub">
        ${side.formation ? '阵型 ' + escapeHtml(side.formation) : ''}${side.morale != null ? ' · 士气 ' + escapeHtml(String(side.morale)) : ''}
      </div>
      ${heroes || '<div class="hint">无武将信息</div>'}
    </div>`;
}

function renderReportDetail(d) {
  $('#reportsListPane').hidden = true;
  $('#reportsDetailPane').hidden = false;

  const b = d.battle || {};
  const atk = b.attacker || {}, def = b.defender || {};
  $('#repDetailTitle').textContent =
    [atk.player || '攻方', 'vs', def.player || '守方'].join(' ');
  const s = d.summary || {};
  $('#repDetailMeta').textContent =
    `战斗ID ${b.battleId || d.id} · ${s.round_count ?? '?'} 回合 · 事件 ${d.events_total ?? (d.events || []).length} 条`
    + (b.location ? ` · 位置 ${b.location}` : '');

  $('#repStatBox').hidden = false;
  const et = s.event_types || [];
  const topTypes = et.slice(0, 6).map(([id, n]) =>
    `<span class="stat-item"><span class="k">事件 ${id}</span><span class="v">${fmtNum(n)}</span></div>`
  ).join('');
  $('#repStatBox').innerHTML = `
    <div class="stat-grid">
      <div class="stat-item"><span class="k">回合数</span><span class="v ok">${fmtNum(s.round_count)}</span></div>
      <div class="stat-item"><span class="k">事件总数</span><span class="v">${fmtNum(s.event_count ?? d.events_total)}</span></div>
      <div class="stat-item"><span class="k">伤害事件</span><span class="v">${fmtNum(s.damage_events)}</span></div>
      <div class="stat-item"><span class="k">治疗事件</span><span class="v">${fmtNum(s.heal_events)}</span></div>
    </div>
    ${topTypes ? `<div class="stat-grid" style="margin-top:8px">${topTypes}</div>` : ''}`;

  $('#repAtkSide').innerHTML = sideHtml(atk, '攻方');
  $('#repDefSide').innerHTML = sideHtml(def, '守方');

  // 回合下拉
  const rounds = [...new Set((d.events || []).map(e => e.round).filter(r => r != null))].sort((a, b) => a - b);
  $('#repRoundFilter').innerHTML = '<option value="">全部</option>'
    + rounds.map(r => `<option value="${r}">第 ${r} 回合</option>`).join('');
  $('#repRoundFilter').value = '';
  state.repShowAll = false;

  renderRepEvents();
  openPlayback();
}

function renderRepEvents() {
  const d = state.reportDetail;
  if (!d) return;
  const sel = $('#repRoundFilter').value;
  let events = d.events || [];
  if (sel !== '') events = events.filter(e => String(e.round) === sel);

  const box = $('#repEvents');
  $('#repEvCount').textContent = `${events.length}${d.events_truncated ? ' / ' + d.events_total : ''}`;

  if (!events.length) {
    box.innerHTML = '<div class="hint" style="padding:12px">没有匹配的事件</div>';
    return;
  }

  // 大事件流分批渲染：先显示 500 条，点「展开全部」再全量
  const LIMIT = 500;
  const limited = events.length > LIMIT && !state.repShowAll;
  const shown = limited ? events.slice(0, LIMIT) : events;

  const CLS = {
    208: 'ev-loss', 218: 'ev-dmg', 215: 'ev-heal', 212: 'ev-skill',
    214: 'ev-cast', 211: 'ev-atk', 247: 'ev-buff', 248: 'ev-debuff',
    213: 'ev-attr', 50: 'ev-info', 52: 'ev-info', 56: 'ev-info', 100: 'ev-info', 0: 'ev-info',
  };
  let html = shown.map(e => {
    let desc = e.desc;
    // 去掉游戏内富文本标记（若后端未清理）
    if (desc && desc.includes('<')) desc = desc.replace(/<[^>]+>/g, '');
    const rTag = e.round != null && e.round > 0 ? `<span class="ev-round">R${e.round}</span>` : '';
    const troop = e.change != null && e.change !== ''
      ? `<span class="ev-troop">${e.change > 0 ? '+' : ''}${fmtNum(Number(e.change))}${e.result != null && e.result !== '' ? ' → ' + fmtNum(Number(e.result)) : ''}</span>`
      : '';
    const meta = e.eventName ? `<span class="ev-name">${escapeHtml(e.eventName)}</span>` : '';
    return `<div class="rep-ev ${CLS[e.eventId] || ''}">
      <span class="ev-seq">${String(e.seq ?? '').padStart(4, '0')}</span>
      ${rTag}${meta}
      <span class="ev-desc">${escapeHtml(desc || '')}</span>${troop}
    </div>`;
  }).join('');
  if (limited) {
    html += `<div class="rep-ev-more">已显示前 ${LIMIT} 条（共 ${events.length} 条）
      <button class="btn ghost sm" id="btnRepShowAll">展开全部</button></div>`;
  }
  box.innerHTML = html;
  const moreBtn = $('#btnRepShowAll');
  if (moreBtn) moreBtn.addEventListener('click', () => {
    state.repShowAll = true;
    renderRepEvents();
  });
}

/* ------------------------------------------------ 回放动画（BattleAnim 引擎） */

/** 事件流水跟随高亮：按序号定位到流水行
 *  注意：这里**只滚动事件流水容器自身**，绝不使用 scrollIntoView——
 *  后者会连带滚动整个页面，导致播放时页面乱跳。 */
function pbHighlightEvent(seq) {
  const box = $('#repEvents');
  if (!box || seq == null) return;
  const want = String(seq).padStart(4, '0');
  const rows = box.querySelectorAll('.rep-ev');
  for (const row of rows) {
    const t = (row.querySelector('.ev-seq') || {}).textContent;
    if (t && String(t).trim().padStart(4, '0') === want) {
      rows.forEach((r) => r.classList.remove('ev-follow'));
      row.classList.add('ev-follow');
      // 用 rect 差值算出目标 scrollTop：只影响容器内部滚动位置
      const boxRect = box.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const delta = rowRect.top - boxRect.top;
      const target = box.scrollTop + delta - box.clientHeight / 2 + rowRect.height / 2;
      box.scrollTop = Math.max(0, target);
      return;
    }
  }
}

/** 打开回放：把当前报告交给演出引擎 */
function openPlayback() {
  const d = state.reportDetail;
  if (!d || !d.roster || typeof BattleAnim === 'undefined') return;
  $('#repPlaybackSection').hidden = false;
  BattleAnim.onHighlight = pbHighlightEvent;
  // 面板开关状态同步给引擎（自动连播默认勾选）
  const chkAuto = $('#pbAutoNext');
  if (chkAuto) BattleAnim.setAutoNext(chkAuto.checked);
  const chkSound = $('#pbSound');
  if (chkSound) BattleAnim.setSound(chkSound.checked);
  BattleAnim.open(d);
}

function stopPlayback() { if (typeof BattleAnim !== 'undefined') BattleAnim.stop(); }
function pbToggle() { BattleAnim.toggle(); }
function pbStepOnce(dir) { BattleAnim.stepOnce(dir); }
function pbSeekPercent(pct) { BattleAnim.seek(pct); }
function pbSetSpeed(v) { BattleAnim.setSpeed(v); }
function pbSetRound(r) { BattleAnim.setRound(r); }
function pbSetAutoNext(on) { BattleAnim.setAutoNext(on); }


async function openReport(rid) {
  const box = $('#repEvents');
  $('#reportsListPane').hidden = true;
  $('#reportsDetailPane').hidden = false;
  $('#repDetailTitle').textContent = rid.replace('_eventDataList', '');
  $('#repDetailMeta').textContent = '加载中…';
  $('#repStatBox').hidden = true;
  $('#repAtkSide').innerHTML = '';
  $('#repDefSide').innerHTML = '';
  box.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">'
    + '<span class="spinner"></span>读取报告…</div>';
  try {
    const d = await api('/api/battle_reports/detail', {
      method: 'POST',
      body: JSON.stringify({ id: rid }),
    });
    state.reportDetail = d;
    renderReportDetail(d);
    // 内容渲染会改变页面高度（动画面板展开等），浏览器可能把视口顶到别处；
    // 这里显式把视口对齐到报告详情顶部，保证用户看到的是报告开头。
    requestAnimationFrame(() => {
      const pane = $('#reportsDetailPane');
      if (!pane) return;
      const top = pane.getBoundingClientRect().top + window.scrollY - 8;
      window.scrollTo(0, Math.max(0, top));
    });
  } catch (e) {
    box.innerHTML = `<div style="color:var(--err)">${escapeHtml(e.message)}</div>`;
  }
}

function backToReports() {
  $('#reportsDetailPane').hidden = true;
  $('#reportsListPane').hidden = false;
  state.reportDetail = null;
  stopPlayback();
}

/* ------------------------------------------------------------------ 事件 */

function bindEvents() {
  // 视图切换
  $('#viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  // 战报数据
  $('#srcList').addEventListener('click', (e) => {
    const item = e.target.closest('.src-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx, 10);
    const onlySummary = $('#onlyPersist').checked;
    const items = state.battleSources.filter(
      s => !onlySummary || s.kind_group === 'merged' || s.kind_group === 'persist'
    );
    const s = items[idx];
    if (!s) return;
    state.battleSource = s.path;
    state.battleSourceInfo = s;
    renderBattleSources();
    $('#exportPanel').hidden = false;
    $('#statBox').hidden = true;
    $('#bfResult').hidden = true;
    $('#bfHint').textContent = s.merge
      ? `已选：${s.label}（会把累计与所有捕获合并去重）`
      : `已选：${s.label}`;
  });
  $('#onlyPersist').addEventListener('change', renderBattleSources);
  $('#btnRescan').addEventListener('click', async () => {
    const b = $('#btnRescan');
    b.disabled = true; b.textContent = '扫描中…';
    await loadBattleSources();
    b.disabled = false; b.textContent = '重新扫描';
  });
  $('#btnPreview').addEventListener('click', previewBattles);
  $('#btnDoExport').addEventListener('click', doBattleExport);

  // 战斗详情
  $('#repList').addEventListener('click', (e) => {
    const item = e.target.closest('.rep-item');
    if (item) openReport(item.dataset.rid);
  });
  $('#repSearch').addEventListener('input', renderReports);
  $('#btnReportsRescan').addEventListener('click', async () => {
    const b = $('#btnReportsRescan');
    b.disabled = true; b.textContent = '扫描中…';
    state.reports = [];
    await loadReports();
    b.disabled = false; b.textContent = '重新扫描';
  });
  $('#btnRepBack').addEventListener('click', backToReports);
  $('#repRoundFilter').addEventListener('change', () => {
    state.repShowAll = false;   // 切换回合后重新分批
    renderRepEvents();
  });

  // 回放控制（全部转发给 BattleAnim 演出引擎）
  $('#pbPlay').addEventListener('click', pbToggle);
  $('#pbSkipFwd').addEventListener('click', () => pbStepOnce(1));
  $('#pbSpeed').addEventListener('change', (e) => pbSetSpeed(parseFloat(e.target.value) || 1));
  $('#pbRoundSel').addEventListener('change', (e) => pbSetRound(parseInt(e.target.value, 10) || 0));
  $('#pbProgress').addEventListener('input', (e) => pbSeekPercent(parseInt(e.target.value, 10) || 0));
  $('#pbAutoNext').addEventListener('change', (e) => pbSetAutoNext(e.target.checked));
  $('#pbSound').addEventListener('change', (e) => BattleAnim.setSound(e.target.checked));
  // 播放按钮是用户手势：顺手初始化音频上下文（浏览器自动播放策略）
  $('#pbPlay').addEventListener('mousedown', () => BattleAnim.unlockAudio(), { once: false });

  // 主题 / 语言
  $('#themeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-val]');
    if (b) applyTheme(b.dataset.themeVal);
  });
  $('#langSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-lang]');
    if (!b) return;
    applyLang(b.dataset.lang);
    renderTables();
    if (state.table) {
      const zh = tblLabel(state.table);
      $('#tableTitle').innerHTML = state.lang === 'zh' && zh !== state.table
        ? `${escapeHtml(zh)}<span class="tbl-en">${escapeHtml(state.table)}</span>`
        : escapeHtml(state.table);
      renderColumnChips();
      renderFilterBar();
      runQuery();
    }
  });

  // 表列表
  $('#tableList').addEventListener('click', (e) => {
    const item = e.target.closest('.table-item');
    if (item) selectTable(item.dataset.table);
  });
  $('#tableSearch').addEventListener('input', renderTables);
  $('#hideEmpty').addEventListener('change', renderTables);

  // 顶栏
  $('#btnSettings').addEventListener('click', async () => {
    try {
      const s = await api('/api/settings');
      $('#setDbPath').value = s.database_path || '';
      $('#setPreferLive').checked = !!s.prefer_live;
      $('#setPageSize').value = s.page_size || 50;
      $('#setMaxRows').value = s.max_export_rows || 0;
      openOverlay('maskSettings', true); openOverlay('modalSettings', true);
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btnSaveSettings').addEventListener('click', async () => {
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          database_path: $('#setDbPath').value.trim(),
          prefer_live: $('#setPreferLive').checked,
          page_size: parseInt($('#setPageSize').value, 10) || 50,
          max_export_rows: parseInt($('#setMaxRows').value, 10) || 0,
        }),
      });
      openOverlay('maskSettings', false); openOverlay('modalSettings', false);
      toast('设置已保存', 'ok');
      await loadStatus(); await loadTables();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#btnRefreshSnap').addEventListener('click', async () => {
    const b = $('#btnRefreshSnap');
    b.disabled = true; b.innerHTML = '<span class="spinner"></span>刷新中…';
    try {
      await api('/api/snapshot', { method: 'POST' });
      toast('快照已刷新', 'ok');
      await loadStatus(); await loadTables();
    } catch (e) { toast(e.message, 'err'); }
    finally { b.disabled = false; b.textContent = '刷新快照'; }
  });

  // 字段抽屉
  $('#btnColumns').addEventListener('click', () => {
    renderColumnList();
    openOverlay('maskColumns', true); openOverlay('drawerColumns', true);
  });
  $('#colSearch').addEventListener('input', renderColumnList);
  $('#colList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-col]');
    if (!cb) return;
    const name = cb.dataset.col;
    if (cb.checked) {
      if (!state.selected.includes(name)) state.selected.push(name);
    } else {
      state.selected = state.selected.filter(c => c !== name);
    }
    renderColumnChips();
  });
  $('#colAll').addEventListener('click', () => {
    state.selected = state.meta.columns.map(c => c.name);
    renderColumnList(); renderColumnChips();
  });
  $('#colNone').addEventListener('click', () => {
    state.selected = [];
    renderColumnList(); renderColumnChips();
  });
  $('#colInvert').addEventListener('click', () => {
    const all = state.meta.columns.map(c => c.name);
    state.selected = all.filter(c => !state.selected.includes(c));
    renderColumnList(); renderColumnChips();
  });
  $('#applyColumns').addEventListener('click', () => {
    openOverlay('maskColumns', false); openOverlay('drawerColumns', false);
    state.page = 1;
    runQuery();
  });

  // 筛选抽屉
  $('#btnFilters').addEventListener('click', () => {
    renderFilterRows();
    openOverlay('maskFilters', true); openOverlay('drawerFilters', true);
  });
  $('#addFilter').addEventListener('click', () => {
    state.filters = collectFilterRows();
    state.filters.push({ field: state.meta.columns[0].name, op: 'contains', value: '' });
    renderFilterRows();
  });
  $('#filterRows').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      state.filters = collectFilterRows();
      state.filters.splice(parseInt(del.dataset.del, 10), 1);
      if (!state.filters.length) {
        state.filters.push({ field: state.meta.columns[0].name, op: 'contains', value: '' });
      }
      renderFilterRows();
    }
  });
  // 切换字段或运算符时重建行（枚举字段需要换成下拉框）
  $('#filterRows').addEventListener('change', (e) => {
    if (e.target.classList.contains('f-field') || e.target.classList.contains('f-op')) {
      const idx = parseInt(e.target.closest('.filter-row').dataset.idx, 10);
      const saved = collectFilterRows();
      const cur = saved[idx] || state.filters[idx] || { field: '', op: 'contains', value: '' };
      cur.field = e.target.closest('.filter-row').querySelector('.f-field').value;
      cur.op = e.target.closest('.filter-row').querySelector('.f-op').value;
      cur.value = '';
      state.filters = saved;
      state.filters[idx] = cur;
      renderFilterRows();
    }
  });
  $('#clearFilters').addEventListener('click', () => {
    state.filters = [{ field: state.meta.columns[0].name, op: 'contains', value: '' }];
    renderFilterRows();
  });
  $('#applyFilters').addEventListener('click', () => {
    state.filters = collectFilterRows();
    state.page = 1;
    renderFilterBar();
    openOverlay('maskFilters', false); openOverlay('drawerFilters', false);
    runQuery();
  });
  $('#filterBar').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-filter]');
    if (rm) {
      state.filters.splice(parseInt(rm.dataset.rmFilter, 10), 1);
      state.page = 1; renderFilterBar(); runQuery();
      return;
    }
    if (e.target.id === 'btnClearAllFilters') {
      state.filters = []; state.page = 1; renderFilterBar(); runQuery();
    }
  });

  // 表头排序
  $('#thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-col]');
    if (!th) return;
    const col = th.dataset.col;
    const cur = state.sort.find(s => s.field === col);
    if (!cur) state.sort = [{ field: col, dir: 'asc' }];
    else if (cur.dir === 'asc') cur.dir = 'desc';
    else state.sort = state.sort.filter(s => s.field !== col);
    state.page = 1;
    runQuery();
  });

  // 分页
  $('#pgFirst').addEventListener('click', () => { state.page = 1; runQuery(); });
  $('#pgPrev').addEventListener('click', () => { if (state.page > 1) { state.page--; runQuery(); } });
  $('#pgNext').addEventListener('click', () => { if (state.page < state.pages) { state.page++; runQuery(); } });
  $('#pgLast').addEventListener('click', () => { state.page = Math.max(1, state.pages); runQuery(); });
  $('#pgInput').addEventListener('change', () => {
    let p = parseInt($('#pgInput').value, 10) || 1;
    p = Math.min(Math.max(1, p), Math.max(1, state.pages));
    state.page = p; runQuery();
  });
  $('#pgSize').addEventListener('change', () => {
    state.pageSize = parseInt($('#pgSize').value, 10);
    state.page = 1; runQuery();
  });

  // 导出
  $('#btnExport').addEventListener('click', () => {
    $('#exportColHint').textContent = `当前选中 ${state.selected.length} 个字段`;
    $('#exportRowHint').textContent = state.filters.length
      ? `筛选后共 ${fmtNum(state.total)} 行`
      : `表中共 ${fmtNum(state.total)} 行`;
    $('#exportResult').hidden = true;
    $('#exportPreview').textContent = '点击「预览」生成…';
    openOverlay('maskExport', true); openOverlay('modalExport', true);
  });
  $('#btnTablePreview').addEventListener('click', previewExport);
  $('#btnTableExport').addEventListener('click', doExport);
  // JSON 格式下隐藏表头语言选项（JSON 始终用英文键名）
  $('#exportFormat').addEventListener('change', (e) => {
    const isJson = e.target.value === 'json' || e.target.value === 'jsonl';
    $('#headerLangField').style.opacity = isJson ? '.45' : '1';
    $('#headerLangField').querySelectorAll('input').forEach(i => { i.disabled = isJson; });
  });

  // 遮罩与关闭
  $$('[data-close]').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.close;
    openOverlay(id, false);
    const maskId = 'mask' + id.replace(/^(drawer|modal)/, '');
    openOverlay(maskId, false);
  }));
  ['maskColumns', 'maskFilters', 'maskExport', 'maskSettings', 'maskFiles'].forEach(mid => {
    document.getElementById(mid).addEventListener('click', () => {
      openOverlay(mid, false);
      openOverlay(mid.replace('mask', 'drawer'), false);
      openOverlay(mid.replace('mask', 'modal'), false);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['maskColumns', 'maskFilters', 'maskExport', 'maskSettings', 'maskFiles'].forEach(mid => {
        openOverlay(mid, false);
        openOverlay(mid.replace('mask', 'drawer'), false);
        openOverlay(mid.replace('mask', 'modal'), false);
      });
    }
  });

  // 导出文件列表
  $('#fileList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del-file]');
    if (!del) return;
    const name = del.dataset.delFile;
    try {
      await api('/api/exports/' + encodeURIComponent(name), { method: 'DELETE' });
      toast('已删除 ' + name, 'ok');
      loadFiles();
    } catch (err) { toast(err.message, 'err'); }
  });

  const filesBtn = document.createElement('button');
  filesBtn.className = 'btn ghost';
  filesBtn.textContent = '导出文件';
  filesBtn.addEventListener('click', () => {
    loadFiles();
    openOverlay('maskFiles', true); openOverlay('modalFiles', true);
  });
  $('.top-actions').insertBefore(filesBtn, $('#btnSettings'));
}

document.addEventListener('DOMContentLoaded', boot);

/* ==========================================================================
   Sanmou 战斗演出引擎（卡牌回合制式回放）
   --------------------------------------------------------------------------
   设计目标：让观众实时看懂整场战斗的因果链——
     谁行动 → 走到哪 → 发动什么战法 → 从身上打出什么特效 → 打中谁
     → 谁掉了多少兵 → 谁获得了什么增益/减益/异常 → 谁阵亡

   三层结构：
     1) 编译层：原始事件流 → 演出脚本（Action / Beat）
     2) 播放层：时间轴推进，触发 beat
     3) 渲染层：Canvas 画战场与特效，DOM 画字幕/顺序栏/横幅
   ========================================================================== */
'use strict';

const BattleAnim = (function () {
  /* ==================== 一、常量与工具 ==================== */

  const FIELD_W = 960;
  const FIELD_H = 420;

  const C = {
    atk: '#4d8dff', atkSoft: 'rgba(77,141,255,.20)', atkDark: '#2c4a7c',
    def: '#f87171', defSoft: 'rgba(248,113,113,.20)', defDark: '#7c2c2c',
    dmg: '#ff5a5a', heal: '#6ee7a0', buff: '#7ee8a4', debuff: '#ff9a6b',
    attr: '#8fd0ff', status: '#c084fc', gold: '#ffd76b', shield: '#9ecbff',
  };

  const ARMS_ICON = { '盾兵': '🛡', '弓兵': '🏹', '枪兵': '🔱', '骑兵': '🐎' };

  /** 阵型站位表（与游戏内一致：r=1 前排 / r=2 后排，c=1..3 左→右） */
  const FORMATIONS = {
    '一字阵': [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }],
    '箕形阵': [{ r: 1, c: 2 }, { r: 2, c: 2 }, { r: 2, c: 3 }],
    '雁形阵': [{ r: 1, c: 2 }, { r: 1, c: 3 }, { r: 2, c: 1 }],
    '方圆阵': [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 2, c: 3 }],
    '锥形阵': [{ r: 1, c: 2 }, { r: 2, c: 1 }, { r: 2, c: 3 }],
    '鱼鳞阵': [{ r: 1, c: 1 }, { r: 2, c: 2 }, { r: 2, c: 3 }],
    '钩行阵': [{ r: 1, c: 3 }, { r: 2, c: 1 }, { r: 2, c: 2 }],
    '偃月阵': [{ r: 1, c: 1 }, { r: 1, c: 3 }, { r: 2, c: 2 }],
  };

  /** 每类 beat 的基础时长（1× 速度，毫秒）
   *  说明：不做任何"把多笔操作合成一拍"的压缩——每一笔伤害、每一条状态都独立成拍；
   *  这里只区分「首笔」与「连续输出」的节奏快慢，让连击看起来紧凑而不丢信息。 */
  const DUR = {
    intro: 620,      // 场景起手（聚光灯 + 字幕）
    move: 640,       // 冲锋贴身
    cast: 800,       // 战法发动（大字 + 法阵）
    castFail: 520,   // 战法未发动
    strike: 440,     // 近战挥击
    shot: 340,       // 远程/技能弹道（首笔）
    shotRapid: 210,  // 连续输出的后续笔
    shotFast: 250,   // 敌方反击 / 第三方触发
    impact: 160,     // 命中冲击
    heal: 240,       // 治疗结算
    num: 280,        // 伤害/治疗数字（首笔）
    numRapid: 190,   // 连续输出的后续笔
    state: 120,      // 状态逐条（属性/增减益/异常）
    dodge: 480,      // 闪避
    death: 1100,     // 阵亡
    ret: 460,        // 归位
    round: 1500,     // 回合标题
    end: 1800,       // 胜负结算
  };

  /** 属性/通用词——从【xx】里提取战法名时排除这些噪音 */
  const ATTR_WORDS = new Set([
    '武力', '智力', '统率', '速度', '先攻', '攻心', '会心几率', '奇谋几率', '会心伤害', '奇谋伤害',
    '造成伤害', '受到伤害', '造成谋略伤害', '造成兵刃伤害', '造成治疗效果', '治疗效果',
    '破甲', '看破', '抵御次数', '抵御', '规避', '补给', '兵力', '伤害', '指挥战法伤害',
    '被动技能伤害', '主动战法伤害', '普攻伤害', '连击率', '暴击率', '命中率', '闪避率',
  ]);

  /* ---- 状态分类（依据游戏内「战斗状态说明」）---- */
  /** 功能性增益：清醒 / 抵御 / 必中 / 破御 / 伏兵 */
  const FUNC_BUFFS = new Set(['清醒', '抵御', '必中', '破御', '伏兵']);
  /** 异常·非控制：洪水 / 火攻 / 风暴 / 畏惧 / 妖术 */
  const ABNORMALS = new Set(['洪水', '火攻', '风暴', '畏惧', '妖术']);
  /** 异常·控制：震慑 / 缴械 / 技穷 / 混乱 / 嘲讽 / 虚弱 / 断粮 */
  const CONTROLS = new Set(['震慑', '缴械', '技穷', '混乱', '嘲讽', '虚弱', '断粮']);

  const easeOutCubic = (k) => 1 - Math.pow(1 - k, 3);
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-CN');

  /** 带阵营前缀的武将名——双方可能有同名武将（如双方都有诸葛亮），必须能区分 */
  function nm(u) {
    if (!u) return '?';
    return (u.side === 'atk' ? '攻·' : '守·') + (u.name || '?');
  }

  function keyOf(tid, hid) { return tid + '|' + hid; }

  /** 依据战法名 / 兵种决定特效外观 */
  function fxStyleOf(skillName, arms) {
    const s = String(skillName || '');
    if (/火|焰|燎|焚|烧|炎/.test(s)) return 'fire';
    if (/雷|电|霆|霹雳|天罚/.test(s)) return 'thunder';
    if (/水|冰|寒|霜|雪|涛|涛/.test(s)) return 'ice';
    if (/风|飓|罡|疾/.test(s)) return 'wind';
    if (/箭|射|弓|矢|弦|羽/.test(s) || arms === '弓兵') return 'arrow';
    if (/刀|枪|剑|斩|刺|斧|戟|击/.test(s) || arms === '枪兵' || arms === '骑兵') return 'blade';
    if (/毒|瘟|瘴/.test(s)) return 'poison';
    return 'orb';
  }

  /** 特效配色 */
  function fxColor(style, side) {
    switch (style) {
      case 'fire': return ['#ffb347', '#ff5722'];
      case 'thunder': return ['#c7b3ff', '#7c4dff'];
      case 'ice': return ['#a8e6ff', '#2196f3'];
      case 'wind': return ['#c8f7d4', '#4ade80'];
      case 'poison': return ['#c7f464', '#7cb342'];
      case 'arrow': return ['#ffe9b0', side === 'atk' ? '#4d8dff' : '#f87171'];
      case 'blade': return ['#ffffff', side === 'atk' ? '#7fb0ff' : '#ffb0b0'];
      default: return ['#fff3c4', side === 'atk' ? '#5b9bff' : '#ff8a8a'];
    }
  }

  /* ==================== 二、运行时状态 ==================== */

  const S = {
    data: null,             // reportDetail
    canvas: null, ctx: null,
    units: {},              // key -> unit
    order: [],              // 单位 key 顺序（渲染用）
    actions: [],            // 当前回合演出脚本
    round: 0,
    roundList: [],
    ai: 0,                  // 当前 action 下标
    at: 0,                  // 当前 action 已播时长
    running: false,
    speed: 1,
    raf: null,
    lastTs: 0,
    fx: [],                 // 粒子/飞行物/光环
    floats: [],             // 飘字
    spotlight: null,        // 当前行动者 key
    caption: '',            // 字幕
    feedLines: [],
    hit: null,              // 受击抖动 { key, t }
    deathFx: null,
    bannerTimer: null,
    captionTimer: null,
    _paused: false,
    onHighlight: null,      // 外部回调：高亮事件流水行
    phase: 'idle',          // idle | playing | paused | done
    oneShot: false,         // 「下一幕」模式：只演这一幕
    autoNext: false,        // 自动连播下一回合
    shake: null,            // 屏幕震动 { amp, t, dur }
    flash: null,            // 全屏闪光 { t, dur, alpha, color }
    zoom: null,             // 镜头推近 { t, dur, amount }
    hitStop: 0,             // 打击顿帧剩余时间（真实毫秒）
  };

  /** 屏幕震动（多次触发取较强的一次，不叠加到失控） */
  function shake(amp, dur) {
    const cur = S.shake;
    const base = (cur && cur.t > 0) ? cur.amp * 0.55 : 0;
    S.shake = { amp: Math.max(amp, base), t: dur, dur };
  }
  /** 全屏闪光（命中/战法/阵亡的冲击感） */
  function flash(alpha, dur, color) {
    S.flash = { t: dur, dur, alpha, color: color || '#cfd6dd' };
  }
  /** 镜头推近（战法发动时） */
  function zoom(amount, dur) {
    const cur = S.zoom;
    const base = (cur && cur.t > 0) ? Math.max(0, cur.amount - 0.015) : 0;
    S.zoom = { t: dur, dur, amount: Math.max(amount, base) };
  }

  /* ==================== 三、布局 ==================== */

  /** 阵型 slot → 战场坐标
   *  【关键】游戏内阵型是「上下」布局（前排朝向敌方），而本画面对战是「左右」布局，
   *  所以要把阵型整体旋转 90°：
   *    · 旋转后，前排(r=1) 朝向画面中线（两军之间就是前排方向），后排(r=2) 靠己方外侧
   *    · 原来的列 c=1..3 变成纵向分布（上 / 中 / 下）
   *  守方需要**前后 + 左右都镜像**，这样两军才是"照镜子"的对阵形态（而不是同手同脚）。
   *  武将位置只由「position 顺序 + 阵型 slot」决定，与该侧剩余人数无关——
   *  有人阵亡时，其他人保持原位不动。 */
  function slotXY(side, r, c) {
    const W = FIELD_W, H = FIELD_H;
    // 前后：r=1 前排靠中线，r=2 后排靠外侧（距中线的横向距离）
    const xFromCenter = { 1: 0.435, 2: 0.235 };
    // 纵列：c=1 上 / c=2 中 / c=3 下
    const laneY = { 1: 0.30, 2: 0.52, 3: 0.74 };

    let x = (xFromCenter[r] || 0.30) * W;
    let y = (laneY[c] || 0.52) * H;
    if (side === 'def') {
      x = W - x;    // 前后镜像（守方前排朝左，面向攻方）
      y = H - y;    // 左右镜像（与攻方呈照镜对阵）
    }

    // 透视：靠中线（前排）略大，远端略小
    const sc = r === 1 ? 1.06 : 0.92;
    return { x, y, sc };
  }

  /** 按【阵容固定顺序】落位：只分配位置，不做「存活者重排」 */
  function layoutSide(side) {
    const teams = (S.data && S.data.roster && S.data.roster.teams) || {};
    let tid = '', team = null;
    for (const [t, v] of Object.entries(teams)) {
      if ((v.side === 'atk' ? 'atk' : 'def') === side) { tid = t; team = v; break; }
    }
    if (!team) return;

    const slots = (FORMATIONS[team.formation] ||
      [{ r: 1, c: 1 }, { r: 1, c: 2 }, { r: 1, c: 3 }]).slice();
    // 与游戏内一致：槽位按「列 c 从左到右」排序（跨前后排）
    slots.sort((a, b) => (a.c - b.c) || (a.r - b.r));

    // 武将按其 position（游戏内站位序号）排序后依次填入槽位；
    // 阵亡者腾出的位置空着，其他人不动。
    const entries = Object.entries(team.heroes || {})
      .sort((a, b) => ((a[1].pos == null ? 99 : a[1].pos) - (b[1].pos == null ? 99 : b[1].pos)));
    entries.forEach(([hid], i) => {
      const u = S.units[keyOf(tid, hid)];
      if (!u) return;
      const sl = slots[Math.min(i, slots.length - 1)] || slots[0];
      const p = slotXY(side, sl.r, sl.c);
      u.baseX = p.x;
      u.baseY = p.y;
      u.sc = p.sc;
      u.slot = sl;     // 记录槽位，便于调试与展示
    });
  }

  function teamOf(side) {
    if (!S.data || !S.data.roster) return null;
    const teams = S.data.roster.teams || {};
    for (const [tid, t] of Object.entries(teams)) {
      const s = t.side === 'atk' ? 'atk' : 'def';
      if (s === side) return t;
    }
    return null;
  }

  function teamIdOf(side) {
    const teams = (S.data && S.data.roster && S.data.roster.teams) || {};
    for (const [tid, t] of Object.entries(teams)) {
      if ((t.side === 'atk' ? 'atk' : 'def') === side) return tid;
    }
    return '';
  }

  /* ==================== 四、初始化 ==================== */

  function init(data) {
    S.data = data;
    S.canvas = document.getElementById('pbStage');
    S.ctx = S.canvas ? S.canvas.getContext('2d') : null;

    // 建单位
    S.units = {};
    S.order = [];
    const teams = (data.roster && data.roster.teams) || {};
    for (const [tid, team] of Object.entries(teams)) {
      const side = team.side === 'atk' ? 'atk' : 'def';
      for (const [hid, h] of Object.entries(team.heroes || {})) {
        const k = keyOf(tid, hid);
        S.units[k] = {
          key: k, tid, hid, side, hero: h,
          name: h.name || '?', arms: h.arms || '',
          maxTroops: h.origin || 0, troops: h.origin || 0,
          dead: false, x: 0, y: 0, baseX: 0, baseY: 0, sc: 1,
          mv: null, mvQueue: [], buffs: [], shield: 0, leader: false,
          // 伤兵比例（用于把血条拆成「剩余 / 伤兵 / 阵亡」三段）
          woundRate: (() => {
            const w = Number(h.wounded) || 0, d = Number(h.dead) || 0;
            return (w + d) > 0 ? w / (w + d) : 0.5;
          })(),
        };
        S.order.push(k);
      }
      if (team.leaderHeroId) {
        const kk = keyOf(tid, team.leaderHeroId);
        if (S.units[kk]) S.units[kk].leader = true;
      }
    }

    // 初始满兵（事件流里的 result 是战后值，需回溯出开战值）
    for (const ev of data.events || []) {
      if (ev.change != null && ev.change !== '' && ev.result != null && ev.result !== '') {
        const u = S.units[keyOf(ev.teamId, ev.heroId)];
        if (u) {
          const before = Number(ev.result) + Number(ev.change);
          if (before > u.maxTroops) u.maxTroops = before;
        }
      }
    }
    for (const u of Object.values(S.units)) u.troops = u.maxTroops;

    layoutSide('atk');
    layoutSide('def');
    for (const u of Object.values(S.units)) { u.x = u.baseX; u.y = u.baseY; }

    preloadIcons();

    // 回合列表
    const rounds = [...new Set((data.events || []).map((e) => e.round).filter((r) => r != null))]
      .sort((a, b) => a - b);
    S.roundList = rounds;
    S.round = rounds[0] != null ? rounds[0] : 0;

    const sel = document.getElementById('pbRoundSel');
    if (sel) {
      sel.innerHTML = rounds.map((r) =>
        `<option value="${r}">${r === 0 ? '布阵阶段' : '第 ' + r + ' 回合'}</option>`).join('');
      sel.value = String(S.round);
    }
    buildRound(S.round);
    render();
    updateHUD();
  }

  /* ==================== 五、编译：事件流 → 演出脚本 ==================== */

  /** 取某回合的事件 */
  function eventsOfRound(round) {
    return (S.data.events || []).filter((e) => String(e.round) === String(round));
  }

  /** 编译一个回合的演出脚本 */
  function compileRound(round) {
    const evs = eventsOfRound(round);
    const acts = [];
    let cur = null;

    const flush = () => { if (cur) { acts.push(cur); cur = null; } };

    for (const ev of evs) {
      const eid = ev.eventId;

      if (eid === 1) { flush(); acts.push({ t: 'round', ev, beats: [] }); continue; }
      if (eid === 3) { flush(); acts.push({ t: 'end', ev, beats: [] }); continue; }

      if (eid === 2) {   // 开始行动 → 新 action
        flush();
        cur = {
          t: 'act', ev, actorKey: keyOf(ev.teamId, ev.heroId),
          raw: [], skill: '', normalTarget: null, hasNormal: false,
        };
        continue;
      }
      if (!cur) { cur = { t: 'pre', ev, raw: [ev] }; continue; }
      cur.raw.push(ev);
    }
    flush();

    // 二次分析：把 raw 事件翻译成 beats
    const out = [];
    for (const a of acts) {
      if (a.t === 'round' || a.t === 'end') { out.push(a); continue; }
      out.push(buildAction(a));
    }
    return out;
  }

  /** 把一组原始事件编译为一场行动演出 */
  function buildAction(a) {
    // 战斗开始前的杂项（布阵/缘分/属性铺垫）：不演出，直接静默结算
    if (a.t === 'pre') {
      return { t: 'pre', beats: [], dur: 60, raw: a.raw || [] };
    }

    const actor = S.units[a.actorKey];
    const beats = [];
    const raw = a.raw || [];
    const actorSide = actor ? actor.side : '';
    const actorArms = actor ? actor.arms : '';

    // ---- 1) 兵力变化（伤害/治疗）----
    const changes = raw.filter((e) => e.change != null && e.change !== '');

    // ---- 2) 战法/效果名 ----
    // 优先级：① 明确的「发动战法【x】」 ② 真正造成伤害的战法效果（e212「由于…【x】」）
    //         ③ 其它事件（排除「因几率未发动」——那是没打出来的技能）
    const castEv = raw.find((e) => e.eventId === 204);
    let skillName = castEv ? (String(castEv.desc || '').match(/【([^】]+)】/) || [])[1] || '' : '';
    const isActiveSkill = !!castEv;
    if (!skillName) {
      const tally = (evs) => {
        const cnt = {};
        for (const e of evs) {
          const ms = String(e.desc || '').match(/【([^】]+)】/g) || [];
          for (const x of ms) {
            const n = x.slice(1, -1);
            if (ATTR_WORDS.has(n)) continue;
            if (/韬略|缘分|善本|手抄|兵书|马匹/.test(n)) continue;
            cnt[n] = (cnt[n] || 0) + 1;
          }
        }
        return Object.entries(cnt).sort((p, q) => q[1] - p[1]);
      };
      let best = tally(changes)[0];                       // ② 只看真正产生伤害的战法效果
      if (!best) best = tally(raw.filter((e) => e.eventId !== 239))[0];   // ③ 排除未发动
      if (best) skillName = best[0];
    }
    // 本段是否存在"由战法效果造成的伤害"（用于决定要不要补触发起手）
    const hasSkillDamage = changes.some((e) => /由于\[[^\]]+\]【/.test(String(e.desc || '')));

    // ---- 3) 普攻宣告（e207）：其 teamId/heroId 是**施法者本人**；
    //         是否贴身由紧随的伤害事件判定（在主循环里）----
    const atkEv = raw.find((e) => e.eventId === 207 || /发动普通攻击/.test(e.desc || ''));

    const push = (b) => beats.push(b);

    /* ===== 严格按事件流顺序编排：每一步都独立成拍，不合并、不采样 =====
       归因规则（关键）：每一笔伤害/效果的「施加者」一律取 (teamId2, heroId2)，
       受击者取 (teamId, heroId)。当施加者不是当前行动者时，说明是敌方反击、
       第三方被动或连锁触发——特效必须从**真实施法者**身上发出，不能画成行动者。 */

    // 1. 起手：行动者高亮
    push({ t: 'intro', dur: DUR.intro, key: a.actorKey });

    // 1b. 本段没有「发动战法」事件、但确实由战法效果造成伤害时，
    //     补一个「触发」起手，保证观众总能看到技能从谁身上发出（纯普攻段不补）
    const hasCast204 = raw.some((e) => e.eventId === 204);
    if (!hasCast204 && skillName && hasSkillDamage) {
      push({
        t: 'cast', dur: DUR.cast * 0.65, key: a.actorKey,
        skill: skillName, arms: actorArms, passive: true,
      });
    }

    let meleeArmed = !!atkEv;   // 本段有普攻宣告
    let meleeDone = false;      // 一个行动段只冲锋贴一次身
    let seqHits = 0;            // 本段已结算的伤害笔数（用于节奏与进度）
    // 承伤转移：e249「[承担者]为[原目标]承担伤害」。若紧接着的伤害打在承担者身上，
    // 说明这一击被"转移"了——轨迹要画成折线：施法者 → 原目标 → 转向承担者。
    let pendingBear = null;

    for (const ev of raw) {
      const eid = ev.eventId;
      const desc = String(ev.desc || '');

      /* ---------- 战法发动 ---------- */
      if (eid === 204) {
        push({
          t: 'cast', dur: isActiveSkill ? DUR.cast : DUR.cast * 0.7,
          key: a.actorKey, skill: skillName, arms: actorArms, passive: !isActiveSkill,
        });
        continue;
      }

      /* ---------- 战法因几率未发动 ---------- */
      if (eid === 239) {
        push({ t: 'castFail', dur: DUR.castFail, key: a.actorKey, skill: extractBracket(desc) || '' });
        continue;
      }

      /* ---------- 承伤转移：记录「谁替谁挡」 ---------- */
      if (eid === 249 || /承担伤害|代为承受/.test(desc)) {
        const bearerKey = keyOf(ev.teamId, ev.heroId);
        const m = desc.match(/\[([^\]]+)\]为\[([^\]]+)\]承担伤害/);
        let origKey = null;
        if (m) origKey = findByNameInTeam(ev.teamId, m[2]);   // 原目标按名字在同队里找
        if (origKey && origKey !== bearerKey) {
          pendingBear = { bearerKey, origKey, origName: m[2] };
          push({
            t: 'state', dur: DUR.state, kind: 'share', key: bearerKey,
            text: `为${m[2]}承伤`, ev, evSeq: ev.seq, origKey,
          });
        } else {
          push({ t: 'state', dur: DUR.state, kind: 'share', key: bearerKey, text: '承担伤害', ev, evSeq: ev.seq });
        }
        continue;
      }

      /* ---------- 普攻宣告：标记，真正演出在紧随的第一笔伤害 ---------- */
      if (eid === 207 || /发动普通攻击/.test(desc)) {
        meleeArmed = true;
        continue;
      }

      /* ---------- 兵力变化：每一笔都是独立的一次攻防 ---------- */
      if (ev.change != null && ev.change !== '') {
        const victimKey = keyOf(ev.teamId, ev.heroId);
        const hasSrc = !!(ev.teamId2 && ev.heroId2);
        const srcKey = hasSrc ? keyOf(ev.teamId2, ev.heroId2) : a.actorKey;
        const srcUnit = S.units[srcKey];
        const vUnit = S.units[victimKey];
        const val = Math.abs(Number(ev.change) || 0);
        const isHeal = eid === 205 || Number(ev.change) < 0;
        // 施加者不是当前行动者 → 敌方反击 / 第三方触发 / 连锁反应
        const external = hasSrc && srcKey !== a.actorKey;
        // 这一笔是"行动者本人贴身普攻敌方"
        const meleeNow = meleeArmed && !meleeDone && !external && !isHeal &&
          vUnit && vUnit.side !== actorSide && !!srcUnit;
        const rapid = seqHits > 0 && !external;   // 连续输出：节奏紧凑但每笔独立
        // 这一笔的效果属性（用于弹道外观与命中音效）
        const fxSkill0 = skillOfEvent(desc, skillName);
        const fxStyle0 = fxStyleOf(fxSkill0, (srcUnit && srcUnit.arms) || actorArms);
        // 承伤转移：这一击原本打 pendingBear.origKey，实际由承担者（victimKey）承受
        const viaOrig = (pendingBear && pendingBear.bearerKey === victimKey && pendingBear.origKey &&
          S.units[pendingBear.origKey]) ? pendingBear.origKey : null;
        if (viaOrig) pendingBear = null;

        if (viaOrig) {
          // 承伤转移：无论原本是近战还是远程，都改用「折线弹道」表现——
          // 施法者 → 原目标 → 转向承担者，这样"被挡下"一眼可见。
          const shooter = S.units[srcKey] ? srcKey : a.actorKey;
          const shooterUnit = S.units[shooter] || actor;
          push({
            t: 'shot', dur: DUR.shot,
            srcKey: shooter, targetKey: victimKey, actorKey: a.actorKey,
            style: fxStyle0, external, fxSkill: fxSkill0,
            srcSide: shooterUnit ? shooterUnit.side : actorSide,
            origKey: viaOrig,
          });
          meleeDone = true;   // 已经用弹道表现，避免再触发冲锋
        } else if (meleeNow) {
          push({ t: 'move', dur: DUR.move, key: a.actorKey, toKey: victimKey });
          push({ t: 'strike', dur: DUR.strike, key: a.actorKey, targetKey: victimKey, skill: skillName });
          meleeDone = true;
        } else if (srcUnit && !isHeal) {
          // 远程攻击 / 敌方反击 / 第三方触发：从真实施法者位置发射
          push({
            t: 'shot', dur: external ? DUR.shotFast : (rapid ? DUR.shotRapid : DUR.shot),
            srcKey, targetKey: victimKey, actorKey: a.actorKey,
            style: fxStyle0, external, fxSkill: fxSkill0,
            srcSide: srcUnit.side,
          });
        }
        if (!isHeal) {
          // 命中音效按属性附加对应的法术爆裂
          push({ t: 'impact', dur: DUR.impact, key: victimKey, kind: 'damage', style: fxStyle0 });
        } else {
          push({ t: 'heal', dur: DUR.impact, key: victimKey });
        }
        push({
          t: 'num', dur: rapid ? DUR.numRapid : DUR.num, key: victimKey,
          srcKey, value: val, kind: isHeal ? 'heal' : 'damage',
          external, ev, evSeq: ev.seq, result: ev.result,
          hitIndex: ++seqHits, origKey: viaOrig,
        });
        continue;
      }

      /* ---------- 闪避 ---------- */
      if (eid === 220 || /成功规避|闪避/.test(desc)) {
        push({ t: 'dodge', dur: DUR.dodge, key: keyOf(ev.teamId, ev.heroId), text: '闪避', ev });
        continue;
      }

      /* ---------- 抵御 / 护盾 ---------- */
      if (eid === 237 || /抵御/.test(desc)) {
        push({ t: 'state', dur: DUR.state, kind: 'shield', key: keyOf(ev.teamId, ev.heroId),
          text: '抵御', ev });
        continue;
      }

      /* ---------- 状态：施加 / 叠加 / 消失 —— 逐条独立成拍 ---------- */
      if ([213, 214, 215, 247, 248, 209, 210, 252, 253, 249, 218, 242, 226].includes(eid)) {
        const k = keyOf(ev.teamId, ev.heroId);
        // 描述形如「由于[某人]【兵书/战法】的「嘲讽」效果」——真正的状态名在「」里；
        // 没有该结构时才退回取【】（如「【造成伤害】提升14%」）。
        const mQuote = desc.match(/的「([^」]+)」/);
        const label = mQuote ? mQuote[1] : (extractBracket(desc) || extractQuote(desc) || '');
        // 状态分类：功能增益 / 异常 / 控制 / 常规增益 / 常规负面
        let kind;
        if (eid === 242) kind = 'proc';
        else if (eid === 215 || /已消失|被驱散|已清除/.test(desc)) kind = 'fade';   // 效果消失 → 摘掉图标
        else if (eid === 249) kind = 'share';
        else if (eid === 253) kind = 'reduce';
        else if (eid === 226) kind = 'control';
        else if (CONTROLS.has(label)) kind = 'control';
        else if (ABNORMALS.has(label)) kind = 'abnormal';
        else if (FUNC_BUFFS.has(label)) kind = 'func';
        else if (eid === 237 || /抵御/.test(desc)) kind = 'func';
        else if (eid === 209 || eid === 210 || /施加|叠加|刷新|已满层/.test(desc)) kind = 'status';
        else if (eid === 248 || eid === 214 || /降低|减少/.test(desc)) kind = 'debuff';
        else kind = 'buff';
        // 层数归零也算结束
        const zeroed = /\(\s*0\s*\)/.test(desc) && /降低|消耗/.test(desc);
        push({ t: 'state', dur: DUR.state, kind: zeroed ? 'fade' : kind, key: k, text: label, ev, evSeq: ev.seq });
        continue;
      }

      /* ---------- 阵亡 ---------- */
      if (eid === 51) {
        if (ev.heroId) push({ t: 'death', dur: DUR.death, key: keyOf(ev.teamId, ev.heroId), ev });
        continue;
      }
    }

    // 归位（贴身过才需要）
    if (meleeDone) push({ t: 'ret', dur: DUR.ret, key: a.actorKey });

    return {
      t: 'act', actorKey: a.actorKey, actorName: actor ? actor.name : '?',
      side: actorSide, skill: skillName, beats,
      evSeq: a.ev.seq, raw: raw, ev: a.ev,
    };
  }

  /** 取【】里的内容 */
  function extractBracket(s) {
    const m = String(s || '').match(/【([^】]+)】/);
    return m ? m[1] : '';
  }
  /** 按名字在同一队伍内找单位 key（承伤事件里只给了名字，需在同队解析） */
  function findByNameInTeam(tid, name) {
    const team = (S.data && S.data.roster && S.data.roster.teams || {})[String(tid)];
    if (!team || !name) return null;
    for (const [hid, h] of Object.entries(team.heroes || {})) {
      const n = h.name || '';
      if (n === name || (n && name.includes(n)) || (n && n.includes(name))) {
        return keyOf(tid, hid);
      }
    }
    return null;
  }
  /** 取「」里的内容 */
  function extractQuote(s) {
    const m = String(s || '').match(/「([^」]+)」/);
    return m ? m[1] : '';
  }
  /** 从事件描述里取技能名（【】优先，其次「」），取不到则回退到本段战法名 */
  function skillOfEvent(desc, fallback) {
    const d = String(desc || '');
    const m = d.match(/由于\[[^\]]+\]【([^】]+)】/) || d.match(/【([^】]+)】/);
    return (m && m[1]) || fallback || '';
  }

  /** 生成回合脚本 */
  function buildRound(round) {
    S.actions = compileRound(round);
    // 预计算每个 beat 的起始时间
    for (const a of S.actions) {
      let t = 0;
      for (const b of a.beats) { b.at = t; t += effDur(b); }
      a.dur = Math.max(t, 320);
    }
    S.ai = 0;
    S.at = 0;
    resetUnitsForRound();
    renderOrder();
    updateHUD();
  }

  /** 一个 beat 的实际时长（每拍都按自身 dur 走，不做压缩） */
  function effDur(b) {
    return b.dur || 200;
  }

  /** 重置单位到本回合起点状态 */
  function resetUnitsForRound() {
    const teams = (S.data.roster && S.data.roster.teams) || {};
    // 兵力：从回合开始处回溯（用事件流中该回合第一笔变化前的值）
    const before = {};
    for (const ev of S.data.events || []) {
      if (String(ev.round) === String(S.round)) break;
      if (ev.change != null && ev.change !== '' && ev.result != null && ev.result !== '') {
        before[keyOf(ev.teamId, ev.heroId)] = Number(ev.result);
      }
    }
    for (const u of Object.values(S.units)) {
      u.troops = before[u.key] != null ? before[u.key] : u.maxTroops;
      u.dead = u.troops <= 0;
      u.buffs = [];
      u.shield = 0;
      u.mv = null;
    }
    layoutSide('atk'); layoutSide('def');
    for (const u of Object.values(S.units)) {
      u.x = u.baseX; u.y = u.baseY;
      if (u.dead) { u.x = u.baseX; }
    }
    S.fx = []; S.floats = []; S.spotlight = null; S.hit = null; S.deathFx = null;
    S.shake = null; S.flash = null; S.zoom = null; S.hitStop = 0;
    S.feedLines = [];
    renderFeed();
    setCaption('');
  }

  /* ==================== 六、播放控制 ==================== */

  function play() {
    if (S.running) return;
    if (S.ai >= S.actions.length) {
      // 已在本回合末尾：开了自动连播就接下一回合，否则从头再放一遍
      if (S.autoNext) { onRoundEnd(); if (!S.running) return; return; }
      S.ai = 0; S.at = 0; resetUnitsForRound();
    }
    S.running = true;
    S.phase = 'playing';
    S.lastTs = performance.now();
    setPlayBtn('⏸ 暂停');
    loop();
  }

  function pause() {
    S.running = false;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = null;
    setPlayBtn('▶ 播放');
    if (S.phase === 'playing') S.phase = 'paused';
  }

  function toggle() { S.running ? pause() : play(); }

  function stop() {
    S.running = false;
    S.phase = 'idle';
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = null;
    setPlayBtn('▶ 播放');
  }

  function loop() {
    S.raf = requestAnimationFrame((ts) => {
      if (!S.running) return;
      const rawDt = Math.min(64, ts - S.lastTs);   // 真实经过时间
      S.lastTs = ts;
      // 打击顿帧：命中瞬间把演出时间几乎冻结一小会儿，制造"顿"的手感
      let scale = 1;
      if (S.hitStop > 0) {
        scale = 0.10;
        S.hitStop = Math.max(0, S.hitStop - rawDt);   // 顿帧用真实时间倒计时
      }
      tick(rawDt * S.speed * scale);
      render();
      if (S.running) loop();
    });
  }

  /** 每帧推进当前 action */
  function tick(dt) {
    advanceFx(dt);
    const a = S.actions[S.ai];
    if (!a) { pause(); return; }

    // 回合/胜负/铺垫类场景
    if (a.t !== 'act') {
      S.at += dt;
      if (a.at == null) { a.at = 0; enterScene(a); }
      const lim = a.t === 'round' ? DUR.round : a.t === 'end' ? DUR.end : 60;
      if (S.at >= lim) {
        if (a.t === 'pre') for (const ev of a.raw || []) silentApplyEvent(ev);
        S.ai++; S.at = 0;
        updateHUD();
        if (S.ai >= S.actions.length) onRoundEnd();
        else enterScene(S.actions[S.ai]);
      }
      return;
    }

    // 行动场景：按时间轴触发 beats
    S.at += dt;
    for (const b of a.beats) {
      if (!b._fired && S.at >= b.at) { b._fired = true; fireBeat(a, b); }
    }
    if (S.at >= a.dur) {
      finishAction(a);
      S.ai++; S.at = 0;
      updateHUD();
      if (S.oneShot) { S.oneShot = false; pause(); render(); return; }   // 「下一幕」只演这一幕
      if (S.ai >= S.actions.length) onRoundEnd();
      else enterScene(S.actions[S.ai]);
    }
  }

  /** 一个回合播完：自动连播下一回合，或停下 */
  function onRoundEnd() {
    if (S.autoNext) {
      const i = S.roundList.indexOf(S.round);
      if (i >= 0 && i < S.roundList.length - 1) {
        S.round = S.roundList[i + 1];
        const sel = document.getElementById('pbRoundSel');
        if (sel) sel.value = String(S.round);
        showBanner((S.round === 0 ? '布阵阶段' : '第 ' + S.round + ' 回合') + ' · 开始');
        buildRound(S.round);
        render();
        play();
        return;
      }
      pause();
      S.phase = 'done';
      showBanner('战斗结束');
      return;
    }
    pause();
    S.phase = 'done';
    showBanner('回合结束');
  }

  /** 进入一个场景 */
  function enterScene(a) {
    a.at = 0;
    for (const b of a.beats || []) b._fired = false;

    if (a.t === 'pre') return;      // 铺垫类：静默，不演出

    if (a.t === 'round') {
      const txt = String(a.ev.desc || '').replace(/第(.+)回合/, '第 $1 回合');
      SFX.play('round');
      shake(1.0, 300);
      showBanner(txt || '战斗开始');
      setCaption('');
      S.spotlight = null;
      renderOrder();
      return;
    }
    if (a.t === 'end') {
      const d = String(a.ev.desc || '');
      SFX.play('end');
      flash(0.015, 380, '#e6d9a8');
      showBanner(/攻方胜利/.test(d) ? '攻方胜利！' : /守方胜利/.test(d) ? '守方胜利！' : d);
      return;
    }
    // 行动
    a.beats.forEach((b) => { b._fired = false; });
    if (a.t === 'act') {
      S.spotlight = a.actorKey;
      renderOrder();
      if (S.onHighlight && a.evSeq != null) S.onHighlight(a.evSeq);
    }
  }

  /** 触发一个 beat —— 演出核心 */
  function fireBeat(a, b) {
    switch (b.t) {
      /* ---------- 起手：聚光 + 字幕 ---------- */
      case 'intro': {
        const u = S.units[b.key];
        if (!u) break;
        setCaption(`${nm(u)} 开始行动`);
        break;
      }

      /* ---------- 移动：武将离开阵位走向目标 ---------- */
      case 'move': {
        const u = S.units[b.key];
        const tgt = S.units[b.toKey];
        if (!u || !tgt) break;
        // 站到目标侧前方：保持半个身位，既贴身又不糊在一起
        const dx = u.baseX < tgt.x ? -1 : 1;
        const dest = {
          x: tgt.x + dx * 62,
          y: tgt.y + (u.baseY < tgt.y ? -20 : 22),
        };
        u.mv = { fx: u.x, fy: u.y, tx: dest.x, ty: dest.y, t: 0, dur: b.dur || DUR.move };
        // 冲锋残影：沿路径留下一串虚影
        for (let i = 1; i <= 4; i++) {
          const kk = i / 5;
          S.fx.push({
            kind: 'ghost', t: 0, dur: 260 + i * 60, side: u.side, x: 0, y: 0,
            trail: true, key: u.key,
            tx: u.x + (dest.x - u.x) * kk, ty: u.y + (dest.y - u.y) * kk,
          });
        }
        SFX.play('move');
        shake(0.5, 130);
        setCaption(`${nm(u)} 冲向 ${nm(tgt)}`);
        break;
      }

      /* ---------- 施法起手：光环 + 前压 + 大字 ---------- */
      case 'cast': {
        const u = S.units[b.key];
        if (!u) break;
        spawnAura(u, b.skill, b.arms);
        // 战法发动：专门的魔幻施法音（与命中/弹道音区分开）
        SFX.play('cast', fxStyleOf(b.skill, b.arms));
        zoom(0.055, 700);
        shake(1.3, 340);
        flash(0.014, 220, u.side === 'atk' ? '#8fb6e0' : '#e0a0a0');
        if (b.passive) setCaption(`${nm(u)} 触发【${b.skill}】`);
        else { showSkillBanner(b.skill, u.side); setCaption(`${nm(u)} 发动战法【${b.skill}】`); }
        // 前压动作：向敌方方向略进（远程施法也有位置变化；近战已贴身则不前压）
        if (!b.noPress) {
          const dir = u.side === 'atk' ? 1 : -1;
          u.mv = { fx: u.x, fy: u.y, tx: u.x + dir * 34, ty: u.y - 5, t: 0, dur: Math.min(b.dur || DUR.cast, 520) };
          u._pressed = true;
        }
        break;
      }

      /* ---------- 近战挥击：斩击弧光 ---------- */
      case 'strike': {
        const u = S.units[b.key];
        const tgt = S.units[b.targetKey];
        if (!u || !tgt) break;
        spawnSlash(u, tgt);
        SFX.play('attack', u.arms);
        shake(0.9, 180);
        setCaption(`${nm(u)} 挥击 ${nm(tgt)}`);
        break;
      }

      /* ---------- 战法未发动 ---------- */
      case 'castFail': {
        const u = S.units[b.key];
        if (!u) break;
        addFloat(u, '未发动', 'dodge');
        setCaption(`${nm(u)} 因几率未发动【${b.skill || '战法'}】`);
        break;
      }

      /* ---------- 远程飞行物：严格从真实施法者发出 ---------- */
      case 'shot': {
        // srcKey 已经是 (teamId2, heroId2) 解析出的**真实施法者**；
        // 只有取不到时才退回行动者，避免把敌方反击画成行动者的攻击
        const from = S.units[b.srcKey] || S.units[b.actorKey];
        const to = S.units[b.targetKey];
        if (!from || !to) break;
        spawnShot(from, to, b.style, b.targetKey, b.origKey);
        SFX.play('shot', b.style);   // 飞行音（自带较大间隔限流，连击时不会刷屏）
        shake(0.4, 100);

        const skill = b.fxSkill || '';
        if (b.origKey && S.units[b.origKey]) {
          // 承伤转移：明确说明"这一击原本打谁、被谁挡下"
          const orig = S.units[b.origKey];
          setCaption(`↳ ${nm(from)}${skill ? '【' + skill + '】' : ''} 本应命中 ${nm(orig)}，被 ${nm(to)} 挡下`);
        } else if (b.external) {
          // 敌方反击 / 第三方触发：给施法者一个醒目的"外部施法"标记
          spawnExternalMark(from);
          const dir = from.side === to.side ? '' : (from === S.units[b.actorKey] ? '' : '↩ 反击 ');
          setCaption(`${dir}${nm(from)}${skill ? '【' + skill + '】' : ''} → ${nm(to)}`);
        } else if (skill) {
          setCaption(`${nm(from)}【${skill}】 → ${nm(to)}`);
        } else {
          setCaption(`${nm(from)} → ${nm(to)}`);
        }
        break;
      }

      /* ---------- 命中冲击 ---------- */
      case 'impact': {
        const u = S.units[b.key];
        if (!u) break;
        spawnImpact(u, false);
        SFX.play('hit', b.style);
        S.hit = { key: b.key, t: 280 };
        shake(1.5, 200);
        flash(0.010, 130, '#cfd6dd');
        S.hitStop = Math.max(S.hitStop, 95);   // 顿帧：命中瞬间的时间凝滞
        break;
      }

      /* ---------- 治疗结算 ---------- */
      case 'heal': {
        const u = S.units[b.key];
        if (!u) break;
        spawnImpact(u, true);
        SFX.play('heal');
        flash(0.006, 170, '#8fd6ae');
        break;
      }

      /* ---------- 状态：逐条挂载 ---------- */
      case 'state': {
        const u = S.units[b.key];
        if (!u) break;
        const k = b.kind;
        const txt = b.text || '';
        const ICON = { buff: '↑', debuff: '↓', func: '🛡', abnormal: '◆', control: '✦', status: '◆' };
        if (k === 'proc') { addFloat(u, '⚡' + (txt || '触发'), 'buff', true); setCaption(`${nm(u)} 触发${txt || '效果'}`); break; }
        if (k === 'fade') {
          // 效果消失 / 被清除：摘掉图标
          const removed = removeBuff(u, txt);
          if (removed) addFloat(u, '—' + (txt || '效果'), 'dodge', true);
          break;
        }
        if (k === 'share') { addFloat(u, '🛡承担伤害', 'status', true); setCaption(`${nm(u)} 承担伤害`); break; }
        if (k === 'reduce') { addFloat(u, '↓伤害降低', 'debuff', true); break; }
        if (!txt) break;

        const kindLabel = {
          buff: '获得增益', debuff: '受到负面', func: '获得功能增益',
          abnormal: '陷入异常', control: '受到控制', status: '状态变化',
        }[k] || '状态变化';
        pushBuff(u, txt, { up: k === 'buff' || k === 'func', kind: k });
        // 状态结算不发声（高频事件，逐行加音效会很吵）
        // 只有重要状态（控制/异常/功能增益）才飘字提示；普通属性变化以图标+字幕呈现
        if (k === 'control' || k === 'abnormal' || k === 'func') {
          addFloat(u, (ICON[k] || '') + txt, k, true);
        }
        setCaption(`${nm(u)} ${kindLabel}【${txt}】`);
        break;
      }

      /* ---------- 伤害/治疗数字 ---------- */
      case 'num': {
        const u = S.units[b.key];
        const ev = b.ev;
        if (!u || !ev) break;
        const val = b.value;
        if (b.kind === 'heal') {
          u.troops = Math.min(u.maxTroops, u.troops + val);
          // 颜色由类型决定（治疗=绿），与数值大小无关；0 值同样显示
          addFloat(u, '+' + fmt(val), 'heal');
        } else {
          // 有精确结果就用结果，否则按本笔数值扣减
          if (b.result != null && b.result !== '') u.troops = Math.max(0, Number(b.result));
          else u.troops = Math.max(0, u.troops - val);
          // 颜色由类型决定（伤害=红），与数值大小无关；0 值同样显示
          addFloat(u, '-' + fmt(val), 'dmg');
          if (u.troops <= 0) u.dead = true;
        }

        // ---- 字幕：严格按真实施法者归因 ----
        const src = S.units[b.srcKey];
        const orig = b.origKey ? S.units[b.origKey] : null;
        const cause = String(ev.desc || '');
        const m = cause.match(/由于\[([^\]]+)\]【([^】]+)】/);
        const verb = b.kind === 'heal' ? '恢复' : '受到';
        let detail;
        if (orig) {
          // 承伤转移：原目标转移给承担者
          const sk = m ? `【${m[2]}】` : '';
          detail = `↳ ${src ? nm(src) : ''}${sk} 本应命中 ${nm(orig)}，由 ${nm(u)} 承伤 ${fmt(val)}`;
        } else if (b.srcKey === b.key) {
          detail = `${nm(u)} 因【${m ? m[2] : '自身效果'}】${verb} ${fmt(val)}`;
        } else if (b.external && src) {
          const sk = m ? `【${m[2]}】` : '';
          detail = `↩ ${nm(src)}${sk} 反击 → ${nm(u)} ${verb} ${fmt(val)}`;
        } else if (m) {
          detail = `${m[1]}【${m[2]}】 → ${nm(u)} ${verb} ${fmt(val)}`;
        } else if (src) {
          detail = `${nm(src)} → ${nm(u)} ${b.kind === 'heal' ? '恢复' : '造成'} ${fmt(val)}`;
        } else {
          detail = `${nm(u)} ${verb} ${fmt(val)}`;
        }
        if (b.hitIndex) detail += ` [${b.hitIndex}]`;
        setCaption(detail);
        pushFeed(b.kind === 'heal' ? 'heal' : 'dmg', detail);
        if (S.onHighlight && ev.seq != null) S.onHighlight(ev.seq);

        // 远程施法者前压后归位
        const caster = S.units[b.srcKey];
        if (caster && caster._pressed && !caster.mv) {
          caster._pressed = false;
          if (Math.abs(caster.x - caster.baseX) > 6 || Math.abs(caster.y - caster.baseY) > 6) {
            caster.mv = { fx: caster.x, fy: caster.y, tx: caster.baseX, ty: caster.baseY, t: 0, dur: 340 };
          }
        }
        break;
      }

      /* ---------- 闪避 ---------- */
      case 'dodge': {
        const u = S.units[b.key];
        if (!u) break;
        addFloat(u, '闪避', 'dodge');
        SFX.play('dodge');
        spawnAfterimage(u);
        setCaption(`${nm(u)} 闪避了攻击`);
        pushFeed('info', `${nm(u)} 闪避`);
        break;
      }

      /* ---------- 阵亡 ---------- */
      case 'death': {
        const u = S.units[b.key];
        if (!u) break;
        u.dead = true;
        u.troops = 0;
        S.deathFx = { key: b.key, t: DUR.death };
        SFX.play('death');
        shake(2.3, 380);
        flash(0.016, 240, '#b9c2d6');
        zoom(0.03, 600);
        S.hitStop = Math.max(S.hitStop, 200);   // 阵亡顿帧更久，突出沉重感
        addFloat(u, '阵亡', 'death');
        setCaption(`${nm(u)} 阵亡`);
        pushFeed('death', `${nm(u)} 阵亡`);
        // 注意：阵亡者腾出的位置保持空置，同侧其他武将不改变原始站位
        break;
      }

      /* ---------- 归位 ---------- */
      case 'ret': {
        const u = S.units[b.key];
        if (!u) break;
        u.mv = { fx: u.x, fy: u.y, tx: u.baseX, ty: u.baseY, t: 0, dur: b.dur || DUR.ret };
        break;
      }
      default: break;
    }
  }

  function finishAction(a) {
    // 收尾：清理前压标记，把偏离阵位的单位平滑送回（保证下一幕站位干净）
    for (const u of Object.values(S.units)) {
      u._pressed = false;
      if (!u.mv && (Math.abs(u.x - u.baseX) > 3 || Math.abs(u.y - u.baseY) > 3)) {
        u.mv = { fx: u.x, fy: u.y, tx: u.baseX, ty: u.baseY, t: 0, dur: 320 };
      }
    }
  }

  /* ==================== 七、特效系统 ==================== */

  function spawnAura(u, skill, arms) {
    const style = fxStyleOf(skill, arms);
    S.fx.push({ kind: 'aura', key: u.key, t: 0, dur: 700, style, side: u.side });
  }

  function spawnAuraTint(u, up) {
    S.fx.push({ kind: 'tint', key: u.key, t: 0, dur: 620, up, side: u.side });
  }

  function spawnSlash(u, tgt) {
    S.fx.push({
      kind: 'slash', key: u.key, tKey: tgt.key, t: 0, dur: 420,
      side: u.side, color: C.gold,
    });
  }

  function spawnShot(from, to, style, targetKey, origKey) {
    S.fx.push({
      kind: 'shot', srcKey: from.key, tKey: targetKey, t: 0,
      dur: 460, style: style || 'orb', side: from.side,
      x0: from.x, y0: from.y - 12, color: fxColor(style, from.side),
      origKey: origKey || null,        // 承伤转移：先飞向原目标再折向承担者
    });
    if (origKey) {
      // 原目标处的"转向"提示（伤害在此被引开）
      S.fx.push({ kind: 'turnmark', key: origKey, t: 0, dur: 620, tKey: targetKey });
    }
  }

  function spawnImpact(u, heal) {
    S.fx.push({ kind: 'impact', key: u.key, t: 0, dur: 320, heal: !!heal });
    if (!heal) {
      // 冲击碎片：更密更快，强化打击感
      for (let i = 0; i < 20; i++) {
        const ang = Math.random() * Math.PI * 2;
        const sp = 70 + Math.random() * 170;
        S.fx.push({
          kind: 'spark', t: 0, dur: 320 + Math.random() * 260,
          x: u.x, y: u.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 40,
          color: Math.random() < 0.45 ? '#ffd76b' : (Math.random() < 0.6 ? C.dmg : '#ffffff'),
          r: 1.4 + Math.random() * 2.6,
        });
      }
      // 第二层冲击波（延迟出现，形成双环）
      S.fx.push({ kind: 'impact', key: u.key, t: -130, dur: 360, heal: false, ring2: true });
    } else {
      for (let i = 0; i < 14; i++) {
        S.fx.push({
          kind: 'spark', t: 0, dur: 460 + Math.random() * 260,
          x: u.x + (Math.random() - 0.5) * 34, y: u.y + 12,
          vx: (Math.random() - 0.5) * 40, vy: -40 - Math.random() * 70,
          color: Math.random() < 0.7 ? C.heal : '#ffffff', r: 1.5 + Math.random() * 2.2,
        });
      }
    }
  }

  function spawnAfterimage(u) {
    S.fx.push({ kind: 'ghost', key: u.key, t: 0, dur: 420, side: u.side });
  }

  /** 外部施法者标记：敌方反击 / 第三方触发时，让"真正出手的人"一眼可见 */
  function spawnExternalMark(u) {
    S.fx.push({ kind: 'external', key: u.key, t: 0, dur: 620, side: u.side });
  }

  function addFloat(u, text, kind, small) {
    S.floats.push({
      key: u.key, text, kind, small: !!small,
      t: 0, dur: small ? 1600 : 1400, ox: (Math.random() - 0.5) * 26,
    });
  }

  /** 挂状态图标：**持续存在**，只在数据里出现「消失 / 被清除 / 层数归零」时才移除。
   *  同名状态只保留一个（叠加会刷新并累加层数）。 */
  function pushBuff(u, text, opt) {
    const exist = u.buffs.find((b) => b.text === text);
    if (exist) {
      exist.count = (exist.count || 1) + 1;
      if (opt.up != null) exist.up = opt.up;
      if (opt.kind) exist.kind = opt.kind;
      return;
    }
    u.buffs.push({
      text, count: 1,
      up: !!opt.up,
      kind: opt.kind || (opt.status ? 'status' : (opt.up ? 'buff' : 'debuff')),
      status: !!opt.status || opt.kind === 'status' || opt.kind === 'abnormal' || opt.kind === 'control',
    });
    // 仅防止无限膨胀：保留最近 30 条（显示时会按重要度排序取前几个）
    if (u.buffs.length > 30) u.buffs.splice(0, u.buffs.length - 30);
  }

  /** 移除状态（效果消失 / 被清除 / 层数归零） */
  function removeBuff(u, text) {
    if (!u || !text) return false;
    // 描述可能是「韬略-《势连》」「草船借箭」这类带前缀的写法，按包含关系匹配
    let i = u.buffs.findIndex((b) => b.text === text);
    if (i < 0) i = u.buffs.findIndex((b) => b.text && (text.includes(b.text) || b.text.includes(text)));
    if (i >= 0) { u.buffs.splice(i, 1); return true; }
    return false;
  }

  /** 状态图标配色（依据游戏内「战斗状态说明」的分类） */
  function buffStyle(b) {
    switch (b.kind) {
      case 'func': return { c: '#7fd8ff', bg: 'rgba(127,216,255,.26)', sym: '🛡' };
      case 'abnormal': return { c: '#c084fc', bg: 'rgba(192,132,252,.26)', sym: '◆' };
      case 'control': return { c: '#ff6bd6', bg: 'rgba(255,107,214,.28)', sym: '✦' };
      case 'debuff': return { c: '#ff9a6b', bg: 'rgba(255,154,107,.26)', sym: '↓' };
      case 'status': return { c: '#c084fc', bg: 'rgba(192,132,252,.24)', sym: '◆' };
      default: return { c: '#7ee8a4', bg: 'rgba(126,232,164,.26)', sym: '↑' };
    }
  }

  /** 推进所有特效/飘字寿命 */
  function advanceFx(dt) {
    for (const u of Object.values(S.units)) {
      // 状态不再按时间过期——只在数据里出现「消失/清除」时才摘除
      if (u.mv) {
        u.mv.t += dt;
        const k = clamp(u.mv.t / u.mv.dur, 0, 1);
        const e = easeInOut(k);
        u.x = u.mv.fx + (u.mv.tx - u.mv.fx) * e;
        u.y = u.mv.fy + (u.mv.ty - u.mv.fy) * e;
        if (k >= 1) u.mv = null;
      }
    }
    S.fx.forEach((f) => { f.t += dt; });
    S.fx = S.fx.filter((f) => f.t < f.dur);
    S.floats.forEach((f) => { f.t += dt; });
    S.floats = S.floats.filter((f) => f.t < f.dur);
    if (S.hit) { S.hit.t -= dt; if (S.hit.t <= 0) S.hit = null; }
    if (S.deathFx) { S.deathFx.t -= dt; if (S.deathFx.t <= 0) S.deathFx = null; }
    if (S.shake) { S.shake.t -= dt; if (S.shake.t <= 0) S.shake = null; }
    if (S.flash) { S.flash.t -= dt; if (S.flash.t <= 0) S.flash = null; }
    if (S.zoom) { S.zoom.t -= dt; if (S.zoom.t <= 0) S.zoom = null; }
  }

  /* ==================== 八、渲染 ==================== */

  function render() {
    const ctx = S.ctx;
    if (!ctx) return;
    const W = FIELD_W, H = FIELD_H;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.restore();

    ctx.save();

    // 镜头推近（战法发动的冲击感）
    if (S.zoom && S.zoom.t > 0) {
      const k = 1 - S.zoom.t / S.zoom.dur;          // 0→1
      const s = 1 + S.zoom.amount * Math.sin(k * Math.PI);
      ctx.translate(W / 2, H / 2);
      ctx.scale(s, s);
      ctx.translate(-W / 2, -H / 2);
    }
    // 屏幕震动（命中/普攻/阵亡）
    if (S.shake && S.shake.t > 0) {
      const k = S.shake.t / S.shake.dur;             // 1→0
      const a = S.shake.amp * k * k;
      ctx.translate((Math.random() * 2 - 1) * a, (Math.random() * 2 - 1) * a);
    }

    drawGround(ctx, W, H);
    drawTopBars(ctx, W);

    // 单位：按 y 排序，后排先画
    const list = S.order.map((k) => S.units[k]).filter((u) => u && (!u.dead || (S.deathFx && S.deathFx.key === u.key)));
    list.sort((a, b) => a.y - b.y);
    for (const u of list) drawUnit(ctx, u);

    drawFx(ctx);
    drawFloats(ctx);

    ctx.restore();

    // 全屏闪光（不受震动影响，快速衰减）
    if (S.flash && S.flash.t > 0) {
      const k = S.flash.t / S.flash.dur;
      ctx.save();
      ctx.globalAlpha = S.flash.alpha * k * k;
      ctx.fillStyle = S.flash.color;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  /** 战场：地面 + 氛围光（绘制范围外扩，避免镜头震动时露边） */
  function drawGround(ctx, W, H) {
    const pad = 40;
    const g = ctx.createLinearGradient(0, -pad, 0, H + pad);
    g.addColorStop(0, '#151a22');
    g.addColorStop(0.5, '#1d2430');
    g.addColorStop(1, '#131820');
    ctx.fillStyle = g;
    ctx.fillRect(-pad, -pad, W + pad * 2, H + pad * 2);

    // 中央沙场
    const cg = ctx.createRadialGradient(W / 2, H * 0.55, 40, W / 2, H * 0.55, W * 0.5);
    cg.addColorStop(0, 'rgba(150,160,130,.10)');
    cg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = cg;
    ctx.fillRect(0, 0, W, H);

    // 中线
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.setLineDash([4, 10]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 70);
    ctx.lineTo(W / 2, H - 10);
    ctx.stroke();
    ctx.restore();

    // 双方阵地底色
    const atkG = ctx.createLinearGradient(0, 0, W * 0.45, 0);
    atkG.addColorStop(0, 'rgba(77,141,255,.07)');
    atkG.addColorStop(1, 'rgba(77,141,255,0)');
    ctx.fillStyle = atkG;
    ctx.fillRect(0, 60, W * 0.45, H - 60);
    const defG = ctx.createLinearGradient(W, 0, W * 0.55, 0);
    defG.addColorStop(0, 'rgba(248,113,113,.07)');
    defG.addColorStop(1, 'rgba(248,113,113,0)');
    ctx.fillStyle = defG;
    ctx.fillRect(W * 0.55, 60, W * 0.45, H - 60);
  }

  /** 顶部：双方总兵力条 */
  function drawTopBars(ctx, W) {
    const sides = { atk: 0, def: 0, atkMax: 0, defMax: 0, atkName: '攻方', defName: '守方' };
    const teams = (S.data.roster && S.data.roster.teams) || {};
    for (const [tid, t] of Object.entries(teams)) {
      const side = t.side === 'atk' ? 'atk' : 'def';
      let cur = 0, max = 0;
      for (const [hid, h] of Object.entries(t.heroes || {})) {
        const u = S.units[keyOf(tid, hid)];
        if (!u) continue;
        cur += Math.max(0, u.troops);
        max += u.maxTroops || 0;
      }
      if (side === 'atk') { sides.atk = cur; sides.atkMax = max; sides.atkName = t.player || '攻方'; }
      else { sides.def = cur; sides.defMax = max; sides.defName = t.player || '守方'; }
    }

    const barY = 20, barH = 15, midW = W * 0.30, cx = W / 2;
    const drawBar = (x, w, ratio, col, dark) => {
      ctx.fillStyle = 'rgba(0,0,0,.62)';
      ctx.fillRect(x - 2, barY - 2, w + 4, barH + 4);
      ctx.fillStyle = dark;
      ctx.fillRect(x, barY, w, barH);
      ctx.fillStyle = col;
      ctx.fillRect(x, barY, w * clamp(ratio, 0, 1), barH);
    };
    drawBar(cx - 10 - midW, midW, sides.atkMax ? sides.atk / sides.atkMax : 0, C.atk, C.atkDark);
    drawBar(cx + 10, midW, sides.defMax ? sides.def / sides.defMax : 0, C.def, C.defDark);

    ctx.textAlign = 'right';
    ctx.font = '800 14px system-ui, sans-serif';
    ctx.fillStyle = C.atk;
    ctx.fillText(sides.atkName, cx - 12, barY - 6);
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#dfe3e9';
    ctx.fillText(`${fmt(sides.atk)} / ${fmt(sides.atkMax)}`, cx - 12, barY + 12);

    ctx.textAlign = 'left';
    ctx.font = '800 14px system-ui, sans-serif';
    ctx.fillStyle = C.def;
    ctx.fillText(sides.defName, cx + 12, barY - 6);
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.fillStyle = '#dfe3e9';
    ctx.fillText(`${fmt(sides.def)} / ${fmt(sides.defMax)}`, cx + 12, barY + 12);
  }

  /** 单个武将：士兵方阵 + 头像 + 血条 + 状态 */
  function drawUnit(ctx, u) {
    const isSpot = S.spotlight === u.key;
    let x = u.x, y = u.y, sc = u.sc;

    // 受击抖动
    if (S.hit && S.hit.key === u.key) x += Math.sin(S.hit.t * 0.12) * 5;
    if (isSpot) sc *= 1.12;

    // 所有武将一律全亮——行动者已有「聚光地环 + 金色名字 + 放大」三重标识，
    // 足够区分谁在行动，不需要压暗其他人（压暗会让头像与状态图标看不清）。
    const alpha = 1;
    ctx.save();
    ctx.globalAlpha = alpha;

    const main = u.side === 'atk' ? C.atk : C.def;
    const soft = u.side === 'atk' ? C.atkSoft : C.defSoft;
    const ratio = u.maxTroops ? clamp(u.troops / u.maxTroops, 0, 1) : 0;

    // ---- 士兵方阵（兵力可视化）----
    const pips = Math.round(ratio * 18);
    for (let i = 0; i < pips; i++) {
      const col = i % 6, row = Math.floor(i / 6);
      const bx = x + (col - 2.5) * 10 * sc + (u.side === 'atk' ? -10 : 10);
      const by = y + 28 * sc + row * 8 * sc;
      ctx.fillStyle = u.side === 'atk' ? 'rgba(90,140,220,.5)' : 'rgba(210,100,100,.5)';
      ctx.fillRect(bx - 3.5, by - 2.5, 7, 4.5);
    }

    // ---- 阴影 ----
    ctx.beginPath();
    ctx.ellipse(x, y + 24 * sc, 34 * sc, 8 * sc, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.42)';
    ctx.fill();

    // ---- 聚光地环 ----
    if (isSpot) {
      ctx.beginPath();
      ctx.ellipse(x, y + 24 * sc, 40 * sc, 11 * sc, 0, 0, Math.PI * 2);
      ctx.strokeStyle = C.gold;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ---- 头像 ----
    const R = 27 * sc;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    const img = iconImg(u.name);
    if (img) {
      const s = Math.max((R * 2) / img.naturalWidth, (R * 2) / img.naturalHeight);
      const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
      ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
    } else {
      ctx.fillStyle = soft;
      ctx.fillRect(x - R, y - R, R * 2, R * 2);
      ctx.fillStyle = main;
      ctx.beginPath(); ctx.arc(x, y - 5 * sc, 8 * sc, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y + 13 * sc, 13 * sc, Math.PI, 0); ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.strokeStyle = u.dead ? '#666c76' : main;
    ctx.lineWidth = isSpot ? 3 : 2.2;
    ctx.stroke();

    /* ---- 头顶兵力条：剩余兵力 / 伤兵 / 阵亡 三段（与游戏内一致）---- */
    const barW = 62 * sc, barH = 6;
    const barY = y - 40 * sc;
    const total = Math.max(1, u.maxTroops);
    const cur = Math.max(0, u.troops);
    const lost = Math.max(0, total - cur);
    // 实时伤兵/阵亡无法从事件流精确拆分，用该单位最终的伤兵比例做近似
    const wr = u.woundRate == null ? 0.5 : u.woundRate;
    const woundNow = lost * wr;
    const wCur = barW * (cur / total);
    const wWound = barW * (woundNow / total);
    const wDead = Math.max(0, barW - wCur - wWound);

    ctx.fillStyle = 'rgba(0,0,0,.72)';
    ctx.fillRect(x - barW / 2 - 1.5, barY - 1.5, barW + 3, barH + 3);
    // 剩余兵力（亮）
    ctx.fillStyle = u.side === 'atk' ? '#5ec8f0' : '#ff7b7b';
    ctx.fillRect(x - barW / 2, barY, wCur, barH);
    // 伤兵（中，可恢复）
    ctx.fillStyle = u.side === 'atk' ? '#2a6f8e' : '#9c3b3b';
    ctx.fillRect(x - barW / 2 + wCur, barY, wWound, barH);
    // 阵亡（深，不可恢复）
    ctx.fillStyle = '#1b2733';
    ctx.fillRect(x - barW / 2 + wCur + wWound, barY, wDead, barH);

    // ---- 名字 ----
    ctx.textAlign = 'center';
    ctx.font = `700 ${Math.round(12 * sc)}px "Microsoft YaHei", system-ui, sans-serif`;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0,0,0,.85)';
    ctx.strokeText(u.name, x, barY - 6);
    ctx.fillStyle = isSpot ? C.gold : '#f0f3f7';
    ctx.fillText(u.name, x, barY - 6);

    // ---- 兵力数字（剩余 / 总数）----
    ctx.font = `${Math.round(10 * sc)}px system-ui, sans-serif`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,.8)';
    const tstr = `${fmt(cur)}`;
    ctx.strokeText(tstr, x, y + 43 * sc);
    ctx.fillStyle = '#cfd4db';
    ctx.fillText(tstr, x, y + 43 * sc);

    // ---- 状态图标（持续显示；按重要度排序：控制 > 异常 > 功能增益 > 增益 > 负面）----
    // 显示最重要的 4 个（宽度与头像相当，避免横跨到相邻武将），其余用 +N 提示
    const KIND_ORDER = { control: 0, abnormal: 1, func: 2, status: 3, buff: 4, debuff: 5 };
    const allBuffs = (u.buffs || []).slice().sort(
      (b1, b2) => (KIND_ORDER[b1.kind] ?? 9) - (KIND_ORDER[b2.kind] ?? 9));
    const buffs = allBuffs.slice(0, 4);
    const extra = allBuffs.length - buffs.length;
    buffs.forEach((b, i) => {
      const bx = x - (buffs.length - 1) * 9 + i * 18;
      const byy = barY - 20;
      const st = buffStyle(b);
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(bx, byy, 8, 0, Math.PI * 2);
      ctx.fillStyle = st.bg;
      ctx.fill();
      ctx.strokeStyle = st.c;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.fillStyle = st.c;
      ctx.fillText(st.sym, bx, byy + 3.2);
      // 控制状态额外加一圈脉冲提示
      if (b.kind === 'control') {
        ctx.beginPath();
        ctx.arc(bx, byy, 11.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,107,214,.55)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = alpha;
    });
    // 状态过多时在右侧提示还有几个
    if (extra > 0) {
      const lx = x + (buffs.length - 1) * 9 + 16;
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      ctx.font = '700 10px system-ui, sans-serif';
      ctx.fillStyle = '#9aa3ae';
      ctx.fillText('+' + extra, lx, barY - 16.5);
    }

    ctx.restore();

    // ---- 死亡消散 ----
    if (u.dead && S.deathFx && S.deathFx.key === u.key) {
      const t = clamp(S.deathFx.t / DUR.death, 0, 1);
      ctx.save();
      ctx.globalAlpha = t;
      ctx.beginPath();
      ctx.arc(x, y, R + (1 - t) * 44, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(220,220,230,.75)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = '800 15px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(230,230,240,.9)';
      ctx.fillText('阵亡', x, y - 50 - (1 - t) * 16);
      ctx.restore();
    }
  }

  /** 特效层 */
  function drawFx(ctx) {
    for (const f of S.fx) {
      const k = clamp(f.t / f.dur, 0, 1);
      const u = f.key ? S.units[f.key] : null;

      switch (f.kind) {
        case 'aura': {
          if (!u) break;
          const col = fxColor(f.style, u.side);
          // 地面法阵
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.9;
          ctx.translate(u.x, u.y + 22);
          ctx.scale(1, 0.34);
          ctx.beginPath();
          ctx.arc(0, 0, 26 + k * 34, 0, Math.PI * 2);
          ctx.strokeStyle = col[0];
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(0, 0, 16 + k * 22, 0, Math.PI * 2);
          ctx.strokeStyle = col[1];
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.restore();
          // 上升光柱
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.5;
          const lg = ctx.createLinearGradient(u.x, u.y + 20, u.x, u.y - 70);
          lg.addColorStop(0, col[0]);
          lg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = lg;
          ctx.fillRect(u.x - 16, u.y - 70, 32, 92);
          ctx.restore();
          break;
        }
        case 'tint': {
          if (!u) break;
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.6;
          ctx.beginPath();
          ctx.arc(u.x, u.y, 30 + k * 16, 0, Math.PI * 2);
          ctx.strokeStyle = f.up ? C.buff : C.debuff;
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'slash': {
          const tgt = S.units[f.tKey];
          if (!tgt) break;
          ctx.save();
          ctx.translate(tgt.x, tgt.y);
          ctx.rotate(-0.7 + k * 1.4);
          ctx.globalAlpha = 1 - k;
          ctx.beginPath();
          ctx.arc(0, 0, 34, -0.9, 0.5);
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 4.5;
          ctx.shadowColor = f.color;
          ctx.shadowBlur = 16;
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'shot': {
          const to = S.units[f.tKey];
          if (!to) break;
          const orig = f.origKey ? S.units[f.origKey] : null;
          let x, y, ang;
          if (orig) {
            // 承伤转移：两段折线（施法者 → 原目标 → 承担者）
            if (k < 0.5) {
              const kk = easeOutCubic(k / 0.5);
              x = f.x0 + (orig.x - f.x0) * kk;
              y = f.y0 + (orig.y - 12 - f.y0) * kk - Math.sin((k / 0.5) * Math.PI) * 26;
              ang = Math.atan2(orig.y - 12 - f.y0, orig.x - f.x0);
            } else {
              const kk = easeOutCubic((k - 0.5) / 0.5);
              x = orig.x + (to.x - orig.x) * kk;
              y = (orig.y - 12) + (to.y - 12 - (orig.y - 12)) * kk - Math.sin(kk * Math.PI) * 20;
              ang = Math.atan2(to.y - orig.y, to.x - orig.x);
            }
          } else {
            x = f.x0 + (to.x - f.x0) * easeOutCubic(k);
            y = f.y0 + (to.y - 12 - f.y0) * k - Math.sin(k * Math.PI) * 26;
            ang = Math.atan2(to.y - 12 - f.y0, to.x - f.x0);
          }
          ctx.save();
          ctx.globalAlpha = 0.95;
          ctx.shadowColor = f.color[1];
          ctx.shadowBlur = 14;
          if (f.style === 'arrow') {
            ctx.translate(x, y);
            ctx.rotate(ang);
            ctx.fillStyle = f.color[0];
            ctx.fillRect(-11, -1.5, 22, 3);
            ctx.beginPath();
            ctx.moveTo(11, -4); ctx.lineTo(19, 0); ctx.lineTo(11, 4);
            ctx.fill();
          } else if (f.style === 'blade') {
            ctx.translate(x, y);
            ctx.rotate(ang);
            ctx.fillStyle = f.color[0];
            ctx.beginPath();
            ctx.moveTo(-12, -3); ctx.lineTo(14, 0); ctx.lineTo(-12, 3);
            ctx.closePath(); ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(x, y, 6 + Math.sin(k * Math.PI) * 3, 0, Math.PI * 2);
            ctx.fillStyle = f.color[0];
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x, y, 3, 0, Math.PI * 2);
            ctx.fillStyle = f.color[1];
            ctx.fill();
          }
          ctx.restore();
          // 拖尾：折线时按当前段画
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.4;
          ctx.beginPath();
          if (orig && k >= 0.5) { ctx.moveTo(orig.x, orig.y - 12); }
          else { ctx.moveTo(f.x0, f.y0); }
          ctx.lineTo(x, y);
          ctx.strokeStyle = f.color[1];
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.restore();
          break;
        }
        case 'turnmark': {
          // 承伤转向标记：原目标处的护盾弧 + 折向承担者的箭头
          if (!u) break;
          const dest = f.tKey ? S.units[f.tKey] : null;
          const al = k < 0.25 ? k / 0.25 : (1 - k) / 0.75;
          ctx.save();
          ctx.globalAlpha = Math.max(0, al) * 0.9;
          // 护盾弧（伤害在此被引开）
          ctx.beginPath();
          ctx.arc(u.x, u.y, 34, -Math.PI * 0.75, Math.PI * 0.75);
          ctx.strokeStyle = '#7fd8ff';
          ctx.lineWidth = 3;
          ctx.stroke();
          if (dest) {
            // 折向箭头
            const ang = Math.atan2(dest.y - u.y, dest.x - u.x);
            const ax = u.x + Math.cos(ang) * 40, ay = u.y + Math.sin(ang) * 40;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - Math.cos(ang - 0.5) * 12, ay - Math.sin(ang - 0.5) * 12);
            ctx.lineTo(ax - Math.cos(ang + 0.5) * 12, ay - Math.sin(ang + 0.5) * 12);
            ctx.closePath();
            ctx.fillStyle = '#7fd8ff';
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'impact': {
          if (!u) break;
          if (f.t < 0) break;                    // 第二层冲击波：延迟出现
          const col = f.heal ? C.heal : (f.ring2 ? '#ffffff' : '#ffd76b');
          const r0 = f.ring2 ? 18 : 12;
          const grow = f.ring2 ? 40 : 30;
          ctx.save();
          ctx.globalAlpha = (1 - k) * (f.ring2 ? 0.7 : 1);
          ctx.beginPath();
          ctx.arc(u.x, u.y, r0 + k * grow, 0, Math.PI * 2);
          ctx.strokeStyle = col;
          ctx.lineWidth = (f.ring2 ? 2 : 3) * (1 - k) + 1;
          ctx.stroke();
          if (!f.ring2) {
            ctx.beginPath();
            ctx.arc(u.x, u.y, 6 + k * 18, 0, Math.PI * 2);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
          }
          ctx.restore();
          break;
        }
        case 'spark': {
          const x = f.x + f.vx * (f.t / 1000);
          const y = f.y + f.vy * (f.t / 1000) + 90 * Math.pow(f.t / 1000, 2);
          ctx.save();
          ctx.globalAlpha = 1 - k;
          ctx.beginPath();
          ctx.arc(x, y, f.r * (1 - k * 0.5), 0, Math.PI * 2);
          ctx.fillStyle = f.color;
          ctx.fill();
          ctx.restore();
          break;
        }
        case 'ghost': {
          // trail=true 的残影使用自身坐标（冲锋路径）；否则跟随单位
          const gx = f.trail ? f.tx : (u ? u.x - 14 * (1 - k) : null);
          const gy = f.trail ? f.ty : (u ? u.y : null);
          if (gx == null) break;
          ctx.save();
          ctx.globalAlpha = (1 - k) * (f.trail ? 0.42 : 0.5);
          ctx.beginPath();
          ctx.arc(gx, gy, f.trail ? 20 : 24, 0, Math.PI * 2);
          ctx.strokeStyle = f.side === 'atk' ? 'rgba(120,180,255,.9)' : 'rgba(255,150,150,.9)';
          ctx.lineWidth = f.trail ? 3 : 2;
          ctx.stroke();
          if (f.trail) {
            ctx.beginPath();
            ctx.arc(gx, gy, 12, 0, Math.PI * 2);
            ctx.fillStyle = f.side === 'atk' ? 'rgba(120,180,255,.16)' : 'rgba(255,150,150,.16)';
            ctx.fill();
          }
          ctx.restore();
          break;
        }
        case 'external': {
          // 外部施法者（敌方反击/第三方触发）：青色脉冲双环 + 顶部标记
          if (!u) break;
          ctx.save();
          ctx.globalAlpha = (1 - k) * 0.95;
          ctx.beginPath();
          ctx.arc(u.x, u.y, 32 + k * 20, 0, Math.PI * 2);
          ctx.strokeStyle = '#5ee7e7';
          ctx.lineWidth = 3;
          ctx.shadowColor = '#5ee7e7';
          ctx.shadowBlur = 12;
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(u.x, u.y, 24 + k * 12, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255,255,255,.8)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.shadowBlur = 0;
          // 顶部三角标记
          ctx.globalAlpha = 1 - k;
          ctx.beginPath();
          ctx.moveTo(u.x, u.y - 46 - k * 6);
          ctx.lineTo(u.x - 7, u.y - 58 - k * 6);
          ctx.lineTo(u.x + 7, u.y - 58 - k * 6);
          ctx.closePath();
          ctx.fillStyle = '#5ee7e7';
          ctx.fill();
          ctx.restore();
          break;
        }
        default: break;
      }
    }
  }

  /** 飘字层 */
  function drawFloats(ctx) {
    const slot = {};
    for (const f of S.floats) {
      const u = S.units[f.key];
      if (!u) continue;
      slot[f.key] = (slot[f.key] || 0) + 1;
      const idx = slot[f.key] - 1;
      const k = clamp(f.t / f.dur, 0, 1);
      const rise = f.small ? 26 : 42;
      // 从状态图标上方开始飘，避免与头顶图标重叠
      const y = u.y - 76 - k * rise - Math.floor(idx / 3) * 15;
      const x = u.x + f.ox + (idx % 3 === 1 ? -30 : idx % 3 === 2 ? 30 : 0);
      const alpha = k < 0.12 ? k / 0.12 : (k > 0.7 ? (1 - k) / 0.3 : 1);

      // 飘字颜色完全由【类型】决定（伤害=红、治疗=绿、增益/减益/异常/控制各按类型），
      // 与数值大小无关——0 值同样用所属类型的颜色。
      let color = C.dmg, size = f.small ? 12 : 18;
      const text = f.text;
      if (f.kind === 'heal') { color = C.heal; }
      else if (f.kind === 'buff') { color = C.buff; size = 12; }
      else if (f.kind === 'func') { color = '#7fd8ff'; size = 12; }
      else if (f.kind === 'debuff') { color = C.debuff; size = 12; }
      else if (f.kind === 'abnormal') { color = C.status; size = 12; }
      else if (f.kind === 'control') { color = '#ff6bd6'; size = 13; }
      else if (f.kind === 'status') { color = C.status; size = 12; }
      else if (f.kind === 'dodge') { color = '#cbd5e1'; size = 16; }
      else if (f.kind === 'death') { color = '#e5e7eb'; size = 18; }

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = 'center';
      // 弹出动画：刚出现时放大回弹（伤害数字更有冲击力）
      const pop = k < 0.16 ? 1 + 0.75 * (1 - k / 0.16) : 1;
      ctx.font = `800 ${Math.round(size * pop)}px "Microsoft YaHei", system-ui, sans-serif`;
      ctx.lineWidth = 3.5 + (pop - 1) * 2;
      ctx.strokeStyle = 'rgba(0,0,0,.85)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
      ctx.restore();
    }
  }

  /* ==================== 九、音效（Web Audio 合成，无需外部音频文件） ==================== */

  const SFX = {
    ctx: null,
    on: true,
    master: null,
    ready: false,
    last: {},          // 按音效类型的上次播放时间（各自限流，互不干扰）

    /** 首次用户交互时初始化（浏览器要求） */
    init() {
      if (this.ready) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        const c = new AC();
        this.ctx = c;
        // 动态压缩：防止多层音叠加时削波，同时把整体响度顶起来
        this.comp = c.createDynamicsCompressor();
        this.comp.threshold.value = -10;
        this.comp.knee.value = 8;
        this.comp.ratio.value = 5;
        this.comp.attack.value = 0.003;
        this.comp.release.value = 0.2;
        this.master = c.createGain();
        this.master.gain.value = 0.62;         // 干声总线（整体响度平衡，不刺耳）
        this.master.connect(this.comp);
        this.comp.connect(c.destination);
        // 混响支路：让战法/阵亡有空间感与"宏大"感
        this.wet = c.createGain();
        this.wet.gain.value = 0.7;
        this.reverb = this.makeReverb(1.8, 2.4);
        this.wet.connect(this.reverb);
        this.reverb.connect(this.comp);
        this.ready = true;
      } catch (e) { /* 不支持音频时静默降级 */ }
    },
    /** 用噪声衰减脉冲合成一个简易混响 IR */
    makeReverb(seconds, decay) {
      const c = this.ctx;
      const rate = c.sampleRate;
      const len = Math.max(1, Math.floor(rate * seconds));
      const buf = c.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
          d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        }
      }
      const conv = c.createConvolver();
      conv.buffer = buf;
      return conv;
    },
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
    setEnabled(v) { this.on = !!v; },
    /** 按类型限流：同类音效至少间隔 gap 毫秒，避免连续结算时刷屏 */
    allow(type, gap) {
      const t = performance.now();
      if (t - (this.last[type] || 0) < gap) return false;
      this.last[type] = t;
      return true;
    },

    /** 把一路信号接到主输出（并可送入混响） */
    send(node, wet = 0) {
      node.connect(this.master);
      if (wet > 0 && this.wet) {
        const s = this.ctx.createGain();
        s.gain.value = wet;
        node.connect(s);
        s.connect(this.wet);
      }
    },

    /** 低频冲击（战斗打击的核心）：音高快速下坠 + 短促包络 */
    kick(freq = 70, dur = 0.32, { vol = 0.55, wet = 0.25, delay = 0, shape = 2.4 } = {}) {
      const c = this.ctx; if (!c) return;
      const t0 = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * shape, t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.55), t0 + dur * 0.7);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g);
      this.send(g, wet);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },

    /** 单个振荡器音（可扫频）
     *  attack：起音时长，调大可让声音更柔和（治疗等不该有尖锐瞬态）
     *  lp：低通截止频率，用来削掉刺耳的高频 */
    tone(freq, dur, { type = 'sine', vol = 0.2, to = null, delay = 0, wet = 0.12, attack = 0.012, lp = 0 } = {}) {
      const c = this.ctx; if (!c) return;
      const t0 = c.currentTime + delay;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t0);
      if (to) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      if (lp > 0) {
        const f = c.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = lp;
        o.connect(f); f.connect(g);
      } else {
        o.connect(g);
      }
      this.send(g, wet);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },

    /** 噪声脉冲（打击 / 风声 / 爆裂） */
    noise(dur, { vol = 0.2, freq = 1200, q = 1, delay = 0, sweepTo = null, wet = 0.15, type = 'bandpass' } = {}) {
      const c = this.ctx; if (!c) return;
      const t0 = c.currentTime + delay;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.8);
      const src = c.createBufferSource();
      src.buffer = buf;
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.setValueAtTime(freq, t0);
      if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), t0 + dur);
      f.Q.value = q;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g);
      this.send(g, wet);
      src.start(t0); src.stop(t0 + dur + 0.02);
    },

    /** 魔幻施法音：多层微失谐正弦 + 上行滑音 + 高频 shimmer + 大混响
     *  表现"法术释放 / 能量汇聚"，与打击音效明显区分。 */
    magic(style, { base = 300, dur = 1.0 } = {}) {
      const c = this.ctx; if (!c) return;
      const B = { fire: 200, thunder: 160, ice: 420, wind: 280, poison: 240, blade: 320, arrow: 380, orb: 300 }[style] || base;
      // ① 三层微失谐正弦（合唱感 → 超自然）
      [0, -9, 7].forEach((cents, i) => {
        this.tone(B * Math.pow(2, cents / 1200), dur, {
          type: 'sine', vol: 0.15 - i * 0.025, to: B * 2.6, wet: 0.75, delay: i * 0.014,
        });
      });
      // ② 蓄力上行滑音（能量汇聚）
      this.tone(B * 0.5, dur * 1.15, { type: 'triangle', vol: 0.13, to: B * 2.1, wet: 0.8 });
      // ③ 高频 shimmer（魔法粒子闪烁）
      for (let i = 0; i < 4; i++) {
        this.tone(B * (3 + i * 0.73), 0.46, {
          type: 'sine', vol: 0.045, to: B * (4.1 + i), delay: 0.1 + i * 0.085, wet: 0.9,
        });
      }
      // ④ 低频涌动
      this.kick(B * 0.32, dur * 0.62, { vol: 0.34, wet: 0.6, shape: 1.8 });
    },

    /** 按事件类型播放。
     *  只在「有实际动作」的节点发声：移动 / 普攻 / 战法发动 / 命中 / 治疗 / 闪避 / 阵亡 / 回合 / 结局。
     *  状态结算（增益、减益、属性变化等高频事件）**不发声**，否则每一行都响、非常吵。 */
    play(kind, style, gap) {
      if (!this.on) return;
      this.init();
      if (!this.ready) return;
      this.resume();
      // 各类音效的默认最小间隔：飞行/命中密集出现所以间隔更大
      const GAP = { shot: 170, hit: 110, attack: 90, move: 160, heal: 140, cast: 200 };
      if (!this.allow(kind, gap == null ? (GAP[kind] || 60) : gap)) return;

      switch (kind) {
        case 'move':    // 冲锋：脚步声 + 气流
          this.kick(90, 0.2, { vol: 0.32, wet: 0.1 });
          this.noise(0.22, { vol: 0.16, freq: 500, q: 0.8, sweepTo: 1400, wet: 0.1 });
          break;
        case 'attack': { // 普攻：按兵种给不同质感
          const arms = style || '';
          if (arms === '弓兵') {
            // 弓弦释放：绷弦 + 破空
            this.tone(320, 0.1, { type: 'triangle', vol: 0.2, to: 180, wet: 0.2 });
            this.noise(0.18, { vol: 0.24, freq: 3200, q: 2.4, sweepTo: 1100, wet: 0.25 });
          } else if (arms === '骑兵') {
            // 铁骑冲撞：马蹄 + 重击
            this.kick(105, 0.22, { vol: 0.45, wet: 0.2, shape: 2.6 });
            this.noise(0.2, { vol: 0.24, freq: 900, q: 0.9, sweepTo: 300, wet: 0.2 });
            this.tone(260, 0.16, { type: 'square', vol: 0.1, to: 120, wet: 0.2 });
          } else if (arms === '枪兵') {
            // 长枪突刺：尖锐破风
            this.noise(0.14, { vol: 0.28, freq: 5200, q: 2.8, sweepTo: 1800, wet: 0.2 });
            this.tone(1800, 0.14, { type: 'triangle', vol: 0.16, to: 700, wet: 0.25 });
          } else {
            // 盾兵 / 其他：钝器重击
            this.kick(96, 0.24, { vol: 0.48, wet: 0.2, shape: 2.2 });
            this.noise(0.16, { vol: 0.26, freq: 1400, q: 0.8, sweepTo: 380, wet: 0.2 });
            this.tone(420, 0.14, { type: 'triangle', vol: 0.12, to: 200, wet: 0.2 });
          }
          break;
        }
        case 'hit': {    // 命中：重击 + 按属性附加的法术爆裂
          this.kick(85, 0.3, { vol: 0.6, wet: 0.3, shape: 2.8 });
          // 爆裂噪声走低通，避免尖锐刺耳
          this.noise(0.14, { vol: 0.26, freq: 1100, q: 0.6, sweepTo: 240, wet: 0.25, type: 'lowpass' });
          if (style === 'fire') this.noise(0.3, { vol: 0.15, freq: 380, q: 0.5, sweepTo: 1100, wet: 0.5, type: 'lowpass' });
          else if (style === 'thunder') this.noise(0.2, { vol: 0.18, freq: 3200, q: 0.7, sweepTo: 700, wet: 0.5 });
          else if (style === 'ice') this.tone(1560, 0.24, { type: 'sine', vol: 0.09, to: 2400, wet: 0.55, lp: 4200 });
          else if (style === 'wind') this.noise(0.26, { vol: 0.13, freq: 1200, q: 1.4, sweepTo: 2000, wet: 0.4 });
          break;
        }
        case 'cast':     // 战法发动：魔幻施法音（能量汇聚，按属性不同基频）
          this.magic(style, { dur: 1.0 });
          break;
        case 'skill': {  // 战法效果：低频轰鸣打底 + 按属性的主音
          this.kick(58, 0.55, { vol: 0.5, wet: 0.5, shape: 2.0 });
          switch (style) {
            case 'fire':
              this.noise(0.7, { vol: 0.3, freq: 260, q: 0.5, sweepTo: 2200, wet: 0.5 });
              this.tone(84, 0.7, { type: 'sawtooth', vol: 0.22, to: 260, wet: 0.5 });
              this.tone(168, 0.5, { type: 'triangle', vol: 0.12, to: 420, delay: 0.06, wet: 0.5 });
              break;
            case 'thunder':
              this.noise(0.4, { vol: 0.42, freq: 4200, q: 0.6, sweepTo: 480, wet: 0.55 });
              this.tone(220, 0.42, { type: 'square', vol: 0.2, to: 55, wet: 0.5 });
              this.kick(48, 0.7, { vol: 0.5, wet: 0.6, delay: 0.02 });
              break;
            case 'ice':
              this.tone(1320, 0.45, { type: 'sine', vol: 0.2, to: 2500, wet: 0.6 });
              this.tone(1760, 0.4, { type: 'sine', vol: 0.15, to: 3100, delay: 0.06, wet: 0.6 });
              this.noise(0.3, { vol: 0.16, freq: 5200, q: 2.5, sweepTo: 2200, wet: 0.5 });
              break;
            case 'wind':
              this.noise(0.75, { vol: 0.26, freq: 700, q: 1.4, sweepTo: 3200, wet: 0.45 });
              this.tone(300, 0.6, { type: 'sine', vol: 0.12, to: 900, wet: 0.4 });
              break;
            case 'arrow':
              this.noise(0.22, { vol: 0.32, freq: 3400, q: 2.6, sweepTo: 900, wet: 0.3 });
              this.tone(980, 0.18, { type: 'triangle', vol: 0.12, to: 520, wet: 0.3 });
              break;
            case 'blade':
              this.tone(1900, 0.26, { type: 'triangle', vol: 0.24, to: 480, wet: 0.35 });
              this.noise(0.16, { vol: 0.26, freq: 4600, q: 1.5, wet: 0.3 });
              break;
            case 'poison':
              this.tone(430, 0.62, { type: 'sawtooth', vol: 0.18, to: 150, wet: 0.5 });
              this.noise(0.5, { vol: 0.14, freq: 900, q: 1.2, sweepTo: 300, wet: 0.5 });
              break;
            default:
              this.magic(style, { dur: 0.75 });
          }
          break;
        }
        case 'heal': {   // 治疗：中低频柔和和弦缓缓铺开（缓起音 + 低通，避免刺耳）
          const chord = [196, 246.94, 293.66, 392];   // G3 大三和弦 + 高八度，整体比原来低一个八度
          chord.forEach((f, i) => {
            this.tone(f, 1.15 - i * 0.08, {
              type: 'sine', vol: 0.10 - i * 0.015, to: f * 1.28,
              delay: i * 0.07, wet: 0.55,
              attack: 0.09 + i * 0.02,   // 缓入：柔和不突刺
              lp: 2200,                  // 低通：削掉尖锐高频
            });
          });
          // 一点点空气感，不做高频"叮"
          this.noise(0.7, { vol: 0.035, freq: 2200, q: 0.8, sweepTo: 900, wet: 0.6, type: 'lowpass' });
          break;
        }
        case 'dodge':   // 闪避：利落的风切
          this.noise(0.22, { vol: 0.22, freq: 2400, q: 2.6, sweepTo: 600, wet: 0.2 });
          break;
        case 'death':   // 阵亡：沉重钟声 + 余韵
          this.kick(70, 0.5, { vol: 0.55, wet: 0.5, shape: 1.6 });
          this.tone(196, 1.2, { type: 'sine', vol: 0.24, to: 92, wet: 0.7 });
          this.tone(147, 1.5, { type: 'sine', vol: 0.19, to: 70, delay: 0.1, wet: 0.75 });
          this.noise(0.9, { vol: 0.12, freq: 300, q: 0.6, sweepTo: 120, wet: 0.6 });
          break;
        case 'round':   // 回合开始：战鼓
          this.kick(96, 0.28, { vol: 0.5, wet: 0.4 });
          this.kick(96, 0.28, { vol: 0.42, wet: 0.4, delay: 0.17 });
          this.tone(392, 0.4, { type: 'triangle', vol: 0.16, delay: 0.34, wet: 0.5 });
          break;
        case 'end':     // 战斗结束：号角式上行
          this.kick(88, 0.35, { vol: 0.5, wet: 0.5 });
          this.tone(523, 0.4, { type: 'triangle', vol: 0.22, wet: 0.5 });
          this.tone(659, 0.4, { type: 'triangle', vol: 0.2, delay: 0.18, wet: 0.55 });
          this.tone(784, 0.95, { type: 'triangle', vol: 0.22, delay: 0.36, wet: 0.65 });
          break;
        default:
          break;
      }
    },
  };

  /* ==================== 十、DOM UI ==================== */

  function setCaption(text) {
    S.caption = text || '';
    const el = document.getElementById('pbCaption');
    if (!el) return;
    if (!text) { el.hidden = true; return; }
    el.textContent = text.length > 54 ? text.slice(0, 54) + '…' : text;
    el.hidden = false;
    el.classList.remove('pb-cap-anim');
    void el.offsetWidth;
    el.classList.add('pb-cap-anim');
    clearTimeout(S.captionTimer);
    S.captionTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function showBanner(text) {
    const el = document.getElementById('pbBanner');
    if (!el) return;
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('pb-banner-anim');
    void el.offsetWidth;
    el.classList.add('pb-banner-anim');
    clearTimeout(S.bannerTimer);
    S.bannerTimer = setTimeout(() => { el.hidden = true; }, 1900);
  }

  /** 战法名横幅（居中，光带扫过） */
  function showSkillBanner(skill, side) {
    if (!skill) return;
    const el = document.getElementById('pbBanner');
    if (!el) return;
    el.textContent = '【' + skill + '】';
    el.hidden = false;
    el.style.color = side === 'atk' ? '#cfe2ff' : '#ffd3d3';
    el.classList.remove('pb-banner-anim');
    void el.offsetWidth;
    el.classList.add('pb-banner-anim');
    clearTimeout(S.bannerTimer);
    S.bannerTimer = setTimeout(() => { el.hidden = true; el.style.color = ''; }, 1200);
  }

  function pushFeed(kind, text) {
    S.feedLines.push({ kind, text });
    if (S.feedLines.length > 5) S.feedLines.shift();
    renderFeed();
  }

  function renderFeed() {
    const box = document.getElementById('pbFeed');
    if (!box) return;
    box.innerHTML = S.feedLines.map((l) => {
      const arrow = l.kind === 'dmg' ? '🔻' : l.kind === 'heal' ? '🟢'
        : l.kind === 'death' ? '💀' : l.kind === 'cast' ? '⚡' : '•';
      const cls = 'pb-feed-line feed-' + (l.kind === 'death' ? 'dmg' : l.kind);
      return `<div class="${cls}"><span class="pf-arrow">${arrow}</span><span class="pf-text">${esc(l.text)}</span></div>`;
    }).join('');
  }

  /** 行动顺序栏 */
  function renderOrder() {
    const box = document.getElementById('pbOrder');
    if (!box) return;
    const acts = S.actions.filter((a) => a.t === 'act');
    if (!acts.length) { box.innerHTML = ''; return; }
    const seen = new Set();
    box.innerHTML = acts.map((a, i) => {
      if (seen.has(a.actorKey)) return '';
      seen.add(a.actorKey);
      const u = S.units[a.actorKey];
      if (!u) return '';
      const idx = S.actions.indexOf(a);
      const isCur = idx === S.ai;
      const isDone = idx < S.ai;
      const img = iconImg(u.name);
      const src = img ? img.src : PB_ICON_DEFAULT;
      return `<div class="pb-order-item side-${u.side} ${isCur ? 'cur' : ''} ${isDone ? 'done' : ''}">
        <img src="${src}" alt=""><span>${esc(nm(u))}</span></div>`;
    }).join('');
  }

  function updateHUD() {
    const pos = document.getElementById('pbPos');
    if (pos) pos.textContent = `${Math.min(S.ai + 1, S.actions.length)} / ${S.actions.length}`;
    const pr = document.getElementById('pbProgress');
    if (pr) pr.value = S.actions.length ? Math.round(100 * S.ai / S.actions.length) : 0;
    const rl = document.getElementById('repPbRound');
    if (rl) rl.textContent = S.round === 0 ? '布阵阶段' : '第 ' + S.round + ' 回合';
  }

  function setPlayBtn(txt) {
    const b = document.getElementById('pbPlay');
    if (b) b.textContent = txt;
  }

  /* ==================== 十、头像 ==================== */

  const PB_ICON_BASE = '/static/heroes/';
  const PB_ICON_DEFAULT = PB_ICON_BASE + '_default.webp';
  const ICON_CACHE = Object.create(null);
  const ICON_MISS = Object.create(null);

  function iconCandidates(name) {
    const n = String(name || '').trim();
    if (!n) return [];
    const m = /^sp[\s·_-]*(.+)$/i.exec(n);
    if (m) { const b = m[1].trim(); return b ? [b + '_2', b] : []; }
    return [n];
  }

  function preloadIcons() {
    for (const u of Object.values(S.units)) {
      for (const cand of iconCandidates(u.name)) {
        const url = PB_ICON_BASE + encodeURIComponent(cand) + '.webp';
        if (ICON_CACHE[url]) continue;
        const img = new Image();
        img.src = url;
        ICON_CACHE[url] = img;
      }
    }
  }

  function iconImg(name) {
    if (ICON_MISS[name]) return null;
    const cands = iconCandidates(name);
    for (const c of cands) {
      const img = ICON_CACHE[PB_ICON_BASE + encodeURIComponent(c) + '.webp'];
      if (img && img.complete && img.naturalWidth > 0) return img;
    }
    if (cands.length) {
      const all = cands.map((c) => ICON_CACHE[PB_ICON_BASE + encodeURIComponent(c) + '.webp']);
      if (all.every((i) => i && i.complete && i.naturalWidth === 0)) ICON_MISS[name] = true;
    }
    return null;
  }

  /* ==================== 十一、对外 API ==================== */

  function open(data) {
    init(data);
    // 面板显示由调用方控制
    render();
  }

  function close() {
    stop();
    S.data = null;
  }

  /** 切换速度（v 为倍率：1 = 原速，2 = 两倍速） */
  function setSpeed(v) { S.speed = Math.max(0.1, Number(v) || 1); }

  /** 自动连播下一回合 */
  function setAutoNext(on) { S.autoNext = !!on; }

  /** 切换回合 */
  function setRound(r) {
    S.round = Number(r) || 0;
    buildRound(S.round);
    render();
  }

  /** 跳到指定百分比（按 action 粒度，静默重建状态） */
  function seek(pct) {
    const target = clamp(Math.round(S.actions.length * pct / 100), 0, S.actions.length);
    pause();
    resetUnitsForRound();
    // 静默重放 0..target 的状态
    for (let i = 0; i < target; i++) silentApply(S.actions[i]);
    S.ai = target;
    S.at = 0;
    S.spotlight = null;
    updateHUD();
    renderOrder();
    render();
  }

  /** 「下一幕」：进入下一幕并**完整演出这一幕**，演完自动暂停
   *  （自动跳过没有可视内容的铺垫幕，直接定位到真正有演出的一幕） */
  function stepOnce(dir) {
    pause();
    if (dir > 0) {
      const cur = S.actions[S.ai];
      if (cur && cur.t === 'act') silentApply(cur);   // 补齐当前幕剩余状态
      let ni = S.ai + 1;
      // 跳过无演出内容的场景（pre 铺垫 / 空幕）
      while (ni < S.actions.length) {
        const s = S.actions[ni];
        const empty = s.t === 'pre' || (s.t === 'act' && !(s.beats || []).length);
        if (!empty) break;
        if (s.t === 'pre') for (const ev of s.raw || []) silentApplyEvent(ev);
        ni++;
      }
      if (ni >= S.actions.length) { showBanner('本回合已结束'); return; }
      S.ai = ni;
      S.at = 0;
      const nx = S.actions[ni];
      (nx.beats || []).forEach((b) => { delete b._fired; });
      S.oneShot = true;
      enterScene(nx);
      updateHUD(); renderOrder();
      play();
      return;
    }
    // 回退一幕：用 seek 重建状态
    const pct = S.actions.length ? 100 * Math.max(0, S.ai - 1) / S.actions.length : 0;
    seek(pct);
  }

  /** 静默应用一个事件对兵力的影响（用于铺垫场景 / seek） */
  function silentApplyEvent(ev) {
    if (!ev || ev.change == null || ev.change === '') return;
    const u = S.units[keyOf(ev.teamId, ev.heroId)];
    if (!u) return;
    const c = Number(ev.change) || 0;
    if (ev.eventId === 205 || c < 0) {
      u.troops = Math.min(u.maxTroops, u.troops + Math.abs(c));
    } else if (ev.result != null && ev.result !== '') {
      u.troops = Math.max(0, Number(ev.result));
    } else {
      u.troops = Math.max(0, u.troops - Math.abs(c));
    }
    if (u.troops <= 0) u.dead = true;
  }

  /** 静默应用一幕的最终状态（幂等：重复调用结果一致，供 seek / 单步使用） */
  function silentApply(a) {
    if (!a || a.t !== 'act') return;
    const finalTroops = {};
    for (const b of a.beats || []) {
      if (b.t === 'num' && b.result != null && b.result !== '') {
        finalTroops[b.key] = Number(b.result);      // 用事件里的精确剩余兵力
      }
      if (b.t === 'death') {
        const d = S.units[b.key];
        if (d) { d.dead = true; d.troops = 0; }
      }
    }
    for (const [k, v] of Object.entries(finalTroops)) {
      const u = S.units[k];
      if (!u) continue;
      u.troops = Math.max(0, v);
      if (u.troops <= 0) u.dead = true;
    }
    // 所有单位归位（幕间应该都在阵位上）
    for (const u of Object.values(S.units)) {
      u.mv = null; u.x = u.baseX; u.y = u.baseY; u._pressed = false;
    }
  }

  return {
    open, close, play, pause, stop, toggle, setSpeed, setRound, seek, stepOnce,
    setAutoNext,
    setSound(on) { SFX.setEnabled(on); if (on) { SFX.init(); SFX.resume(); } },
    unlockAudio() { SFX.init(); SFX.resume(); },
    /** 诊断：返回音频上下文状态与各类音效的最近触发时间 */
    sfxDebug() {
      return {
        ready: SFX.ready,
        enabled: SFX.on,
        state: SFX.ctx ? SFX.ctx.state : 'none',
        last: Object.assign({}, SFX.last),
      };
    },
    render, get state() { return S; },
    set onHighlight(fn) { S.onHighlight = fn; },
  };
})();

if (typeof window !== 'undefined') window.BattleAnim = BattleAnim;

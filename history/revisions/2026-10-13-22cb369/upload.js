/* =========================================================
 * 活动申请 · 上传活动表模式（正式版接入，源自已验证的 upload-proto）
 * 流程：上传/样例 → ②申请信息 → ③选择商品(匹配+二次修订+按颜色分配) → ④标准明细 → 提交审批/归档
 * 原则：数据准确性第一——解析不出来的绝不猜测，交弹窗人工确认；未匹配不生成明细
 * 依赖：window.APP_DATA / window.MKT_APP(app.js 导出) / window.MKT_SUBMIT_UPLOAD / XLSX / window.UPLOAD_SAMPLES
 * ========================================================= */
(function () {
  'use strict';
  const APP = window.MKT_APP;
  const D = window.APP_DATA;
  if (!APP || !D) { console.error('upload.js：未找到 MKT_APP/APP_DATA，请检查脚本加载顺序'); return; }

  /* ---------- 工具 ---------- */
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const norm = (s) => String(s ?? '').replace(/[\s\u3000\r\n（）()·、，,。.\-_/／]/g, '').toLowerCase();
  const num = (v) => { if (v == null || v === '') return null; const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  const fmt = (n) => (n == null || isNaN(n)) ? '' : (Math.round(n * 100) / 100).toString();

  /* 季节归一：25秋冬→25FW，25春夏→25SS，/ 或空→'' */
  function normSeason(v) {
    const s = String(v ?? '').trim();
    if (!s || s === '/') return '';
    const m = s.match(/(\d{2})\s*([秋冬春夏SSFW]+)/i);
    if (!m) return s;
    const y = m[1];
    const t = m[2].toUpperCase();
    if (t.startsWith('秋') || t.includes('FW')) return y + 'FW';
    if (t.startsWith('春') || t.includes('SS')) return y + 'SS';
    return s;
  }

  /* ---------- 产品底表索引（来自正式数据源 D.products：API 中间表 / 种子 / 演示） ---------- */
  let SPU = {};
  let SPU_LIST = [];
  function buildSpuIndex() {
    SPU = {}; SPU_LIST = [];
    for (const p of D.products) {
      if (!p.spuCode || SPU[p.spuCode]) continue;
      const skus = APP.skusOf(p).map((k) => ({ skuCode: k.code, color: k.color, size: k.size }));
      const genders = [...new Set((p.variants || []).flatMap((v) => v.colors.map((c) => c.gender || v.gender)).filter(Boolean))];
      const toNumber = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
      const retail = toNumber(p.retailPrice), minDiscount = toNumber(p.minDiscount);
      let suggestMin = minDiscount != null && retail != null ? Math.round(retail * minDiscount / 10 * 100) / 100 : toNumber(p.minPrice);
      const redlinePrice = toNumber(p.redlinePrice);
      if (redlinePrice != null && (suggestMin == null || redlinePrice > suggestMin)) suggestMin = redlinePrice;
      const s = {
        spuCode: p.spuCode, name: p.name, spuShort: p.spuShort || '', season: p.season || '',
        gender: genders.length === 1 ? genders[0] : '', genders, category: p.category || '',
        listPrice: p.listPrice, retailPrice: p.retailPrice, skus, suggestMin, redlinePrice,
      };
      SPU[p.spuCode] = s; SPU_LIST.push(s);
    }
  }
  buildSpuIndex();
  /* 数据源中间表变化时（拉取/重建/清缓存）重建索引 */
  const _prevOnData = window.MKT_ON_DATA;
  window.MKT_ON_DATA = function (usedApi) {
    if (typeof _prevOnData === 'function') { try { _prevOnData(usedApi); } catch (e) {} }
    buildSpuIndex();
  };

  /* ---------- 状态 ---------- */
  const state = {
    fileName: '', platform: '', sheets: {}, srcBase64: '',
    activity: { name: '', platform: '', stores: [], type: '', start: '', end: '', manzeng: '', gouwujin: '' },
    autoFields: {}, rows: [], gifts: [], skippedGifts: [], matched: [], unmatched: [], stdRows: [], errors: [],
    _matchedDone: false, _cancelAllMulti: false, _submitted: false, autoUnisexCount: 0,
  };
  function abToB64(buf) { const b = new Uint8Array(buf); let s = ''; const c = 0x8000; for (let i = 0; i < b.length; i += c) s += String.fromCharCode.apply(null, b.subarray(i, i + c)); return btoa(s); }

  /* ---------- 正式店铺清单（店铺资料20260924130715885.xlsx，17 店 / 8 平台） ---------- */
  const PLATFORM_STORES = {
    '淘宝天猫': ['天猫-flipbelt乐跑体育专卖店', '天猫-flipbelt运动户外旗舰店'],
    '京东': ['京东-Flipbelt运动旗舰店', '京东-京东自营旗舰店'],
    '抖音': ['抖音-FlipBelt飞比特', '抖音-飞比特官方旗舰店', '抖音-越野旗舰店', '抖音-运动旗舰店'],
    '私域': ['小程序-FlipBelt飞比特官方商城'],
    '拼多多': ['拼多多-Flipbelt运动旗舰店', '拼多多-飞比特官方旗舰店'],
    '微信视频号': ['视频号-FlipBelt飞比特运动', '视频号-FlipBelt户外运动', '视频号-FLIPBELT运动', '视频号-飞比特运动店'],
    '得物': ['得物-飞比特旗舰店'],
    '小红书': ['小红书-FlipBelt飞比特旗舰店'],
  };

  const stockNumber = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
  function spuStock(spu, colorFilter) {
    let sum = 0, any = false;
    (spu.skus || []).forEach((sku) => {
      if (colorFilter && sku.color !== colorFilter) return;
      const stock = stockNumber(APP.stockOf(sku.skuCode));
      if (stock != null) { sum += stock; any = true; }
    });
    return any ? sum : null;
  }
  const stockText = (v) => v == null ? '<span style="color:#b45309">缺数据</span>' : v.toLocaleString();

  /* =========================================================
   * UI 注入：模式切换 + 上传工作区 + 独立弹窗（umodal，避免与主系统 modal 冲突）
   * ========================================================= */
  function injectUI() {
    const view = $('#view-apply');
    if (!view || $('#up-mode')) return;
    const layout = view.querySelector('.layout');
    const modebar = document.createElement('div');
    modebar.id = 'up-mode';
    modebar.innerHTML = `
      <div class="up-mode-seg">
        <button class="up-mode-btn on" data-mode="manual">✎ 手工填价申请</button>
        <button class="up-mode-btn" data-mode="upload">⬆ 上传活动表申请</button>
      </div>
      <span class="up-mode-tip">上传各平台活动 Excel → 自动解析申请信息 → 匹配商品（支持二次修订 / 多值按颜色分配）→ 生成标准明细 → 提交审批归档</span>`;
    if (layout) layout.insertAdjacentElement('beforebegin', modebar);
    else view.appendChild(modebar);

    const wrap = document.createElement('div');
    wrap.id = 'up-wrap';
    wrap.className = 'hidden';
    wrap.innerHTML = `
      <div class="up-stepbar" id="up-stepbar"></div>
      <section class="up-card" id="up-sec-upload">
        <h2>① 上传活动原表</h2>
        <div class="up-drop" id="up-drop">
          <p class="big">拖拽 / 点击上传各平台活动 Excel（.xlsx）</p>
          <p class="tip">支持：天猫 / 京东 / 抖音 / 私域 / 拼多多 / 视频号 / 得物 / 小红书 手工活动表；解析后进入「申请信息」确认</p>
          <input type="file" id="up-file" accept=".xlsx,.xls" hidden>
          <button class="btn primary" id="up-btn-file">选择文件</button>
        </div>
        <div class="up-samples">
          <h3>离线样例（真实上传表转换，点击直接载入）</h3>
          <div class="up-chips" id="up-sample-chips"></div>
        </div>
        <div class="up-ref-bar">
          <button class="btn" id="up-btn-ref-csv">⬇ 下载标准商品信息表 XLSX（统一商品简称）</button>
          <span class="up-meta">制作活动上传原表时，请按「货号 / 商品简称（SPU 口径）」对齐此表；颜色价格不同会拆多行，避免按 SKU 逐行导致简称乱填、增加商品维护错误</span>
        </div>
      </section>
      <section class="up-card hidden" id="up-sec-apply">
        <h2>② 申请信息 <span class="up-tag" id="up-src-file"></span></h2>
        <p class="up-desc">从上传表自动解析活动级字段，可直接修改；必填项为空将标红并阻止进入下一步。</p>
        <div class="up-grid2" id="up-apply-form"></div>
        <div class="up-row-end">
          <button class="btn" id="up-btn-back-upload">← 返回上传（传错文件可重传）</button>
          <button class="btn primary" id="up-btn-to-pick">下一步：选择商品 →</button>
        </div>
      </section>
      <section class="up-card hidden" id="up-sec-pick">
        <h2>③ 选择商品（SPU→SKU 映射与校验）</h2>
        <p class="up-desc hidden" id="up-pick-tip">⚙ 本步骤支持<b>二次修订</b>：可直接改选/追加匹配 SPU、修订活动价与到手价（多值可「按颜色分配」）、删除错误行、对未匹配项重新匹配；修订完成后再生成标准明细。</p>
        <div class="up-metrics" id="up-pick-metrics"></div>
        <div id="up-unmatched-alert"></div>
        <div class="up-tbl-wrap"><table class="up-tbl" id="up-pick-tbl"></table></div>
        <div id="up-gift-bar"></div>
        <div class="up-row-end">
          <button class="btn" id="up-btn-back-apply">← 上一步</button>
          <button class="btn primary" id="up-btn-to-std">生成标准活动明细 →</button>
        </div>
      </section>
      <section class="up-card hidden" id="up-sec-std">
        <h2>④ 标准活动明细（SKU 级）<span class="up-confirm-badge">⚠ 请运营逐项核对并确认最终信息，确认无误后方可提交审批</span></h2>
        <div class="up-metrics" id="up-std-metrics"></div>
        <div class="up-row-end up-std-actions">
          <button class="btn" id="up-btn-back-pick">← 上一步</button>
          <button class="btn" id="up-btn-csv">下载标准表 CSV</button>
          <button class="btn warn" id="up-btn-csv-err">下载异常清单 CSV</button>
          <button class="btn primary" id="up-btn-submit">✓ 核对无误，提交审批</button>
        </div>
        <div class="up-tbl-wrap up-tall"><table class="up-tbl" id="up-std-tbl"></table></div>
      </section>`;
    view.appendChild(wrap);

    const mask = document.createElement('div');
    mask.id = 'umodal-mask';
    mask.className = 'hidden';
    mask.innerHTML = `<div class="umodal"><h3 id="umodal-title"></h3><div id="umodal-body"></div><div id="umodal-foot"></div></div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });

    modebar.querySelectorAll('.up-mode-btn').forEach((b) => b.addEventListener('click', () => {
      const upload = b.dataset.mode === 'upload';
      modebar.querySelectorAll('.up-mode-btn').forEach((x) => x.classList.toggle('on', x === b));
      if (layout) layout.classList.toggle('hidden', upload);
      wrap.classList.toggle('hidden', !upload);
      if (upload && !state.fileName) goStep(0);
    }));
  }

  /* ---------- 步骤条（可点选回退/前进） ---------- */
  const STEPS = ['上传', '申请信息', '选择商品', '标准明细'];
  let curStep = 0;
  function stepReachable(i) {
    if (i === 0) return true;
    if (i === 1) return !!state.fileName;
    if (i === 2) return state.rows && state.rows.length > 0;
    if (i === 3) return state.stdRows && state.stdRows.length > 0;
    return false;
  }
  function renderSteps() {
    $('#up-stepbar').innerHTML = STEPS.map((s, i) => {
      const ok = stepReachable(i);
      return `<span class="up-step ${i === curStep ? 'on' : i < curStep ? 'done' : ''} ${ok && i !== curStep ? 'clickable' : ''} ${ok ? '' : 'disabled'}" data-step="${i}" title="${ok ? '点击跳转' : '暂不可用'}">${i + 1} ${s}</span>`;
    }).join('');
    ['up-sec-upload', 'up-sec-apply', 'up-sec-pick', 'up-sec-std'].forEach((id, i) => $('#' + id).classList.toggle('hidden', i !== curStep));
  }
  async function goStep(i) { curStep = i; renderSteps(); }
  function bindStepbar() {
    $('#up-stepbar').addEventListener('click', async (e) => {
      const el = e.target.closest('.up-step[data-step]'); if (!el) return;
      const i = +el.dataset.step;
      if (i === curStep || !stepReachable(i)) return;
      if (i === 1) renderApplyForm();
      if (i === 2) {
        goStep(i);
        if (!state._matchedDone) { await runMatch(); await resolveGifts(); state._matchedDone = true; }
        else renderPick();
        return;
      }
      if (i === 3) renderStd();
      goStep(i);
    });
  }

  /* ---------- 独立弹窗 ---------- */
  let modalResolve = null;
  function openModal(title, bodyHtml, footBtns) {
    $('#umodal-title').textContent = title;
    $('#umodal-body').innerHTML = bodyHtml;
    $('#umodal-foot').innerHTML = '';
    (footBtns || []).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn' + (b.primary ? ' primary' : '');
      btn.textContent = b.label;
      btn.onclick = () => { if (b.onClick) { const r = b.onClick(); if (r === false) return; } closeModal(); };
      $('#umodal-foot').appendChild(btn);
    });
    $('#umodal-mask').classList.remove('hidden');
  }
  function closeModal() { $('#umodal-mask').classList.add('hidden'); if (modalResolve) { modalResolve(null); modalResolve = null; } }
  /* 弹窗内红字提示（不用原生 alert，避免阻塞） */
  function modalErr(msg) {
    let e = $('#umodal-err');
    if (!e) { e = document.createElement('p'); e.id = 'umodal-err'; e.className = 'umodal-err'; $('#umodal-body').prepend(e); }
    e.textContent = msg;
    e.style.display = '';
    clearTimeout(e._t); e._t = setTimeout(() => { e.style.display = 'none'; }, 2500);
  }

  /* =========================================================
   * 一、文件载入（上传 / 样例）
   * ========================================================= */
  function loadWorkbook(name, sheets, srcBase64) {
    state.fileName = name;
    state.srcBase64 = srcBase64 || '';
    state.sheets = sheets;
    state.platform = detectPlatform(name);
    state.matched = []; state.unmatched = []; state.stdRows = []; state.errors = [];
    state._matchedDone = false; state._submitted = false;
    parseActivity();
    parseRows();
    $('#up-src-file').textContent = name;
    $('#up-unmatched-alert').innerHTML = '';
    renderApplyForm();
    goStep(1);
  }

  /* 平台识别：返回与 PLATFORM_STORES 一致的规范平台名 */
  function detectPlatform(fn) {
    if (/天猫|淘宝|tmall|taobao/i.test(fn)) return '淘宝天猫';
    if (/京东|jd/i.test(fn)) return '京东';
    if (/抖音|douyin/i.test(fn)) return '抖音';
    if (/私域|小程序/.test(fn)) return '私域';
    if (/拼多多|pdd/i.test(fn)) return '拼多多';
    if (/视频号/.test(fn)) return '微信视频号';
    if (/得物|dewu/i.test(fn)) return '得物';
    if (/小红书|xhs/i.test(fn)) return '小红书';
    return '';
  }

  /* 全部 sheet 的单元格文本流（用于活动级信息检索） */
  function allCells() {
    const out = [];
    for (const sn of Object.keys(state.sheets)) {
      const rows = state.sheets[sn];
      rows.forEach((r, ri) => r.forEach((c, ci) => {
        if (c != null && c !== '') out.push({ sn, ri, ci, v: c, t: typeof c === 'object' && c.__d ? '' : String(c) });
      }));
    }
    return out;
  }

  /* ---------- 活动级解析 ---------- */
  function parseActivity() {
    const a = { name: '', platform: state.platform, stores: [], type: '', start: '', end: '', manzeng: '', gouwujin: '' };
    const auto = {};
    const cells = allCells();
    const firstSheet = state.sheets[Object.keys(state.sheets)[0]] || [];

    /* 活动名称：首行标题（去掉「价/款」等后缀）/ 文件名兜底 */
    const title = firstSheet.length && firstSheet[0][0] != null ? String(firstSheet[0][0]).trim() : '';
    const isHeaderTitle = title && !/产品名称|商品时期|年份季节/.test(title) && title.length <= 30;
    if (isHeaderTitle) { a.name = title.replace(/[价款]+$/, ''); auto.name = true; }
    else { a.name = state.fileName.replace(/\.xlsx?$/i, '').replace(/[\d.]+-[\d.]+$/, ''); auto.name = true; }

    /* 活动类型 */
    const typeMap = [['清仓', '清仓'], ['展会', '展会'], ['新势力', '平台大促'], ['超级88', '平台大促'], ['新风潮', '平台大促'], ['七夕', '平台大促'], ['春节', '平台大促'], ['不打烊', '平台大促'], ['秋冬', '季节促销']];
    for (const [kw, t] of typeMap) { if ((a.name + state.fileName).includes(kw)) { a.type = t; auto.type = true; break; } }

    /* 活动时间：多格式 */
    const timeStr = (() => {
      for (const c of cells) {
        const t = c.t;
        let m = t.match(/(\d{1,2})\/(\d{1,2})\s*\d{0,2}:?\d{0,2}[^-—]*[-—–]\s*(\d{1,2})\/(\d{1,2})/);
        if (m) return { m1: +m[1], d1: +m[2], m2: +m[3], d2: +m[4] };
        m = t.match(/(\d{1,2})\.(\d{1,2})\s*[-—–]\s*(\d{1,2})\.(\d{1,2})/);
        if (m && /活动时间|价格/.test(t + c.sn)) return { m1: +m[1], d1: +m[2], m2: +m[3], d2: +m[4] };
      }
      const fm = state.fileName.match(/(\d{1,2})\.(\d{1,2})\s*[-–]\s*(\d{1,2})\.(\d{1,2})/);
      if (fm) return { m1: +fm[1], d1: +fm[2], m2: +fm[3], d2: +fm[4] };
      for (const c of cells) { const m2 = c.t.match(/^(\d{1,2})\.(\d{1,2})-(\d{1,2})\.(\d{1,2})$/); if (m2) return { m1: +m2[1], d1: +m2[2], m2: +m2[3], d2: +m2[4] }; }
      return null;
    })();
    if (timeStr) {
      const Y = new Date().getFullYear();
      a.start = `${Y}-${String(timeStr.m1).padStart(2, '0')}-${String(timeStr.d1).padStart(2, '0')}`;
      a.end = `${Y}-${String(timeStr.m2).padStart(2, '0')}-${String(timeStr.d2).padStart(2, '0')}`;
      auto.start = auto.end = true;
    }

    /* 满赠 / 购物金：行标签匹配 */
    for (const sn of Object.keys(state.sheets)) {
      for (const r of state.sheets[sn]) {
        const j = (r || []).map((x) => x == null ? '' : String(x)).join('|');
        if (/^满赠/.test(j.trim()) || j.includes('满赠（')) {
          const v = r.slice(1).filter((x) => x != null && String(x).trim()).join('；').replace(/[\r\n]+/g, ' ');
          if (v && !a.manzeng) { a.manzeng = v; auto.manzeng = true; }
        }
        if (/^购物金/.test(j.trim())) {
          const v = r.slice(1).filter((x) => x != null && String(x).trim()).join('；').replace(/[\r\n]+/g, ' ');
          if (v && !a.gouwujin) { a.gouwujin = v; auto.gouwujin = true; }
        }
      }
    }
    /* 私域赠品策略：「实付金额满199 | | 洗衣袋」逐行 */
    if (!a.manzeng) {
      const gifts = [];
      for (const sn of Object.keys(state.sheets)) {
        for (const r of state.sheets[sn]) {
          if (!r) continue;
          const c0 = String(r[0] ?? '').trim();
          const m = c0.match(/^实付金额满\s*(\d+)/);
          if (!m) continue;
          const item = (r.slice(1).map((x) => String(x ?? '').trim()).filter(Boolean)[0] || '').replace(/[\r\n]+/g, '');
          if (item) gifts.push(`满${m[1]}送${item}`);
        }
      }
      if (gifts.length) { a.manzeng = gifts.join('；'); auto.manzeng = true; }
    }

    /* 店铺：文本块检索（解析值须能对应到店铺清单，可命中多家 → 多选；否则留空待人工勾选） */
    const storePool = PLATFORM_STORES[state.platform] || [];
    const hitStores = new Set();
    for (const c of cells) {
      storePool.forEach((st) => { if (c.t.includes(st)) hitStores.add(st); });
    }
    if (hitStores.size) { a.stores = [...hitStores]; auto.store = true; }
    state.autoFields = auto;
    state.activity = a;
  }

  /* ---------- 商品行解析 ---------- */
  const COLMAP = [
    ['name', /产品名称/],
    ['season', /商品时期|年份季节/],
    ['orig', /^原价$/],
    ['daily', /^日常价$/],
    ['act', /活动报名价格|报名价|申请展会价|展会价|私域活动申请价|申请价|京东价|^\d{1,2}\.\d{1,2}-\d{1,2}\.\d{1,2}$/],
    ['final', /活动到手价|到手价|京东到手价/],
    ['disc', /官方活动折扣|折扣率|折扣$/],
    ['diff', /日常价差额/],
    ['remark', /价格备注|^备注$|^ps/i],
    ['tm', /TM价格/],
  ];
  function mapHeader(hdr) {
    const map = {};
    hdr.forEach((cell, ci) => {
      const t = String(cell ?? '').trim(); if (!t) return;
      for (const [key, re] of COLMAP) {
        if (map[key] != null) continue;
        if (re.test(t)) { map[key] = ci; break; }
      }
    });
    return map;
  }
  function parseRows() {
    state.rows = []; state.gifts = []; state.skippedGifts = [];
    for (const sn of Object.keys(state.sheets)) {
      const rows = state.sheets[sn];
      const hi = rows.findIndex((r) => r && r.some((c) => c != null && (/产品名称/.test(String(c)) || /^商品时期$/.test(String(c).trim()))));
      if (hi < 0) continue;
      const map = mapHeader(rows[hi]);
      /* 无「产品名称」表头时（如京东 Sheet1），以时期列前一列作为名称列 */
      if (map.name == null && map.season != null && map.season > 0) map.name = map.season - 1;
      if (map.name == null) continue;
      for (let i = hi + 1; i < rows.length; i++) {
        const r = rows[i]; if (!r) continue;
        const gv = (k) => (map[k] != null ? r[map[k]] : null);
        const name = String(gv('name') ?? '').trim();
        if (!name || /产品名称|合计|总计/.test(name)) continue;
        if (/^(核心\d|ps:|活动时间|赠品策略|\*以上|以下商品|实付金额满|满赠|购物金)/.test(name)) continue;
        const seasonRaw = String(gv('season') ?? '').trim();
        state.rows.push({
          sheet: sn, rowIdx: i,
          name: name.replace(/[\r\n]+/g, ' '),
          season: normSeason(seasonRaw), seasonRaw,
          orig: gv('orig'), daily: gv('daily'), act: gv('act'), final: gv('final'),
          disc: gv('disc'), diff: gv('diff'),
          remark: gv('remark') != null ? String(gv('remark')).replace(/[\r\n]+/g, ' ') : '',
          tm: gv('tm'),
        });
      }
      break; /* 只取第一个含商品表头的 sheet（Sheet2 为重复底稿） */
    }
  }

  /* ---------- 多值价格解析 ---------- */
  function parsePriceCell(v) {
    if (v == null || v === '') return { kind: 'empty' };
    if (typeof v === 'number') return { kind: 'single', base: v };
    const s = String(v).trim();
    if (s === '/' || s === '-') return { kind: 'none' };
    const pm = s.match(/^(\d+(?:\.\d+)?)\s*[（(]([^）)]+)[）)]$/);
    if (pm) {
      const base = Number(pm[1]);
      const exceptions = [];
      const em = pm[2].match(/^(.*?)[，,]?\s*(\d+(?:\.\d+)?)$/);
      if (em) {
        const colors = em[1].split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
        exceptions.push({ colors, price: Number(em[2]) });
      }
      return { kind: 'exception', base, exceptions };
    }
    const parts = s.split(/[\/／]/).map((x) => x.trim()).filter(Boolean);
    const nums = parts.map(num);
    if (nums.length >= 2 && nums.every((n) => n != null)) return { kind: 'multi', values: nums };
    const n = num(s);
    return n != null ? { kind: 'single', base: n } : { kind: 'raw', text: s };
  }
  function parseRemarkSplit(remark) {
    const m = String(remark ?? '').match(/纯色\s*(\d+(?:\.\d+)?)\s*[，,]\s*其他\s*(\d+(?:\.\d+)?)/);
    return m ? { pure: Number(m[1]), other: Number(m[2]) } : null;
  }

  /* ---------- 匹配 ---------- */
  function stripGender(name) {
    return norm(String(name ?? '')
      .replace(/[（(]\s*(男士|女士|男|女|中性|通用)\s*[)）]/g, '')
      .replace(/^(男士|女士|男|女)/, '')
      .replace(/(男士|女士)$/, ''));
  }
  /* 男女同款：去性别词后名称基底唯一 且 候选覆盖不同性别 → 自动映射，不算匹配异常 */
  function isUnisexPairGroup(hits) {
    if (hits.length < 2) return false;
    const bases = new Set(hits.map((s) => stripGender(s.name)));
    if (bases.size !== 1) return false;
    const gs = new Set();
    hits.forEach((s) => { if (s.gender) gs.add(s.gender); });
    return gs.size >= 2;
  }
  /* 近似候选排序：按 简称/名称/货号 与关键词的相关度打分，供赠品与"重新匹配"用，避免全量列表 */
  function spuScore(s, nq) {
    if (!nq) return 0;
    const sn = norm(s.name), ss = norm(s.spuShort || ''), sc = norm(s.spuCode);
    let v = 0;
    if (ss && ss === nq) v += 100;
    if (sn && sn === nq) v += 96;
    if (ss && nq.includes(ss)) v += 62;
    if (ss && ss.includes(nq)) v += 58;
    if (sn && sn.includes(nq)) v += 40;
    if (sn && nq.includes(sn)) v += 34;
    if (sc && sc.startsWith(nq)) v += 30;
    if (sc && sc.includes(nq)) v += 12;
    return v;
  }
  function rankSpu(hint, limit) {
    const nq = norm(hint || '');
    const arr = [];
    for (const s of SPU_LIST) { const v = spuScore(s, nq); if (v > 0) arr.push({ s, v }); }
    arr.sort((a, b) => b.v - a.v);
    return arr.slice(0, limit || 25).map((x) => x.s);
  }
  function nearCands(hint, limit) { return rankSpu(hint, limit).map((s) => ({ s, sub: `${s.spuCode} · ${s.season} · ${s.name}` })); }

  function matchSpu(name, season) {
    const n = norm(name);
    let hits = SPU_LIST.filter((s) => norm(s.spuShort) === n && (!season || s.season === season));
    if (hits.length === 1) return { spu: hits[0], how: '简称+时期' };
    if (hits.length > 1) hits = SPU_LIST.filter((s) => norm(s.spuShort) === n);
    if (hits.length === 1) return { spu: hits[0], how: '商品简称' };
    if (hits.length > 1) {
      if (isUnisexPairGroup(hits)) return { multiSame: hits, how: '男女同款自动' };
      return { multi: hits, how: '简称多候选' };
    }
    hits = SPU_LIST.filter((s) => norm(s.name) === n && (!season || s.season === season));
    if (hits.length === 1) return { spu: hits[0], how: '名称+时期' };
    if (hits.length <= 1) hits = SPU_LIST.filter((s) => norm(s.name) === n);
    if (hits.length === 1) return { spu: hits[0], how: '产品名称' };
    if (hits.length > 1) {
      if (isUnisexPairGroup(hits)) return { multiSame: hits, how: '男女同款自动' };
      return { multi: hits, how: '名称多候选' };
    }
    const fuzzy = SPU_LIST.filter((s) => norm(s.name).includes(n) || n.includes(norm(s.name)) || norm(s.spuShort) === n).slice(0, 8);
    return { none: true, fuzzy };
  }

  /* =========================================================
   * 二、申请信息表单
   * ========================================================= */
  const APPLY_FIELDS = [
    ['name', '活动名称', 'text', true],
    ['platform', '平台', 'select_platform', true],
    ['store', '店铺（勾选参加活动的店铺，可多选；多店=平台活动，明细按店铺各展开一套）', 'check_store', true],
    ['type', '活动类型', 'select:平台大促,清仓,日常促销,展会,季节促销,私域活动', false],
    ['start', '活动开始时间', 'date', true],
    ['end', '活动结束时间', 'date', true],
    ['manzeng', '满赠规则', 'textarea', false],
    ['gouwujin', '购物金规则', 'textarea', false],
  ];
  function renderApplyForm() {
    $('#up-apply-form').innerHTML = APPLY_FIELDS.map(([k, label, type, req]) => {
      const v = state.activity[k] ?? '';
      const auto = state.autoFields[k] ? '<span class="auto">自动解析</span>' : (req ? '<span class="miss">需补录</span>' : '');
      let input;
      if (type === 'select_platform') {
        const opts = Object.keys(PLATFORM_STORES);
        input = `<select data-k="${k}"><option value="">— 请选择 —</option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else if (type === 'check_store') {
        const pool = PLATFORM_STORES[state.activity.platform] || [];
        const sel = state.activity.stores || [];
        input = pool.length
          ? `<div class="up-store-checks">${pool.map((o) => `<label class="up-chk"><input type="checkbox" data-store="${esc(o)}" ${sel.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>`
          : '<div class="up-pill">请先选择平台</div>';
      } else if (type.startsWith('select:')) {
        const opts = type.slice(7).split(',');
        input = `<select data-k="${k}"><option value="">— 请选择 —</option>${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      } else if (type === 'textarea') {
        input = `<textarea data-k="${k}">${esc(v)}</textarea>`;
      } else {
        input = `<input type="${type}" data-k="${k}" value="${esc(v)}">`;
      }
      return `<div class="up-fld${type === 'check_store' ? ' span2' : ''}" data-f="${k}"><label>${label}${req ? '<span class="req">*</span>' : ''}${auto}</label>${input}</div>`;
    }).join('');
    $('#up-apply-form').querySelectorAll('[data-k]').forEach((el) => {
      el.addEventListener('input', () => { state.activity[el.dataset.k] = el.value; });
      if (el.dataset.k === 'platform') el.addEventListener('change', () => {
        state.activity.platform = el.value;
        const pool = PLATFORM_STORES[el.value] || [];
        const kept = (state.activity.stores || []).filter((st) => pool.includes(st));
        if (kept.length !== (state.activity.stores || []).length) { state.activity.stores = kept; if (!kept.length) delete state.autoFields.store; }
        renderApplyForm();
      });
    });
    $('#up-apply-form').querySelectorAll('input[data-store]').forEach((el) => {
      el.addEventListener('change', () => {
        const cur = new Set(state.activity.stores || []);
        el.checked ? cur.add(el.dataset.store) : cur.delete(el.dataset.store);
        state.activity.stores = [...cur];
        delete state.autoFields.store;
        const fld = el.closest('.up-fld');
        if (fld) fld.classList.toggle('err', !state.activity.stores.length);
      });
    });
  }
  function validateApply() {
    let ok = true;
    $('#up-apply-form').querySelectorAll('.up-fld').forEach((f) => {
      const k = f.dataset.f;
      const req = APPLY_FIELDS.find((x) => x[0] === k)[3];
      const val = k === 'store' ? (state.activity.stores || []) : state.activity[k];
      const bad = req && !(Array.isArray(val) ? val.length : String(val ?? '').trim());
      f.classList.toggle('err', !!bad);
      if (bad) ok = false;
    });
    return ok;
  }

  /* =========================================================
   * 三、选择商品：匹配 + 弹窗交互
   * ========================================================= */
  async function runMatch() {
    state.matched = []; state.unmatched = [];
    const pendingMulti = [];
    const pendingNone = [];
    let autoUnisex = 0;
    for (const row of state.rows) {
      const m = matchSpu(row.name, row.season);
      if (m.spu) { state.matched.push({ row, spus: [m.spu], how: m.how }); continue; }
      if (m.multiSame) { state.matched.push({ row, spus: m.multiSame, how: m.how }); autoUnisex++; continue; }
      if (m.multi) { pendingMulti.push({ row, cands: m.multi }); continue; }
      pendingNone.push({ row, reason: '简称/名称均未命中', fuzzy: m.fuzzy });
    }
    state.autoUnisexCount = autoUnisex;
    if (pendingMulti.length) {
      const picked = await multiPickModal(pendingMulti);
      pendingMulti.forEach((p, i) => {
        if (picked[i] && picked[i].length) state.matched.push({ row: p.row, spus: picked[i], how: '人工多选' });
        else state.unmatched.push({ row: p.row, reason: '人工放弃' });
      });
    }
    if (pendingNone.length > 5) {
      state.unmatched = state.unmatched.concat(pendingNone);
      renderPick();
      showUnmatchedAlert();
      return;
    }
    for (const u of pendingNone) {
      const seed = (u.fuzzy || []).map((s) => ({ s, sub: `${s.spuCode} · ${s.season} · ${s.name}` }));
      const picked = await pickModal(`未匹配商品「${u.row.name}（${u.row.season || '无时期'}）」— 已按近似度列出候选，可搜索全部`, seed, true, u.row.name);
      if (picked) state.matched.push({ row: u.row, spus: [picked], how: '人工指定' });
      else state.unmatched.push(u);
    }
    renderPick();
  }

  function multiPickModal(items) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const body = `<p style="margin-bottom:12px">以下 <b>${items.length}</b> 个商品在底表匹配到多个候选，请勾选正确的 SPU（<b>可多选</b>，如男女同款价格一致请全部勾选，将同时写入明细；不勾选的项进未匹配清单）：</p>` +
        items.map((it, gi) => `
          <div style="margin-bottom:14px;padding:10px 12px;border:1px solid #e8edf4;border-radius:12px">
            <div style="margin-bottom:8px"><b>${esc(it.row.name)}</b> <span class="up-pill">时期：${esc(it.row.seasonRaw || '—')}</span></div>
            ${it.cands.map((s, ci) => `
              <label class="up-opt"><input type="checkbox" name="mp-${gi}" value="${ci}">
                <span><b>${esc(s.name)}</b>（${esc(s.spuCode)}）<span class="up-meta"> ${esc(s.season)} · ${esc(s.spuShort || '')} · ${(s.genders || []).join('/') || '—'} · ${s.skus.length} SKU</span></span>
              </label>`).join('')}
          </div>`).join('');
      openModal('多候选商品确认（可多选）', body, [
        { label: '全部放弃', onClick: () => resolve(items.map(() => [])) },
        { label: '确认全部', primary: true, onClick: () => {
            const out = items.map((it, gi) => {
              const sels = [...document.querySelectorAll(`#umodal-body input[name="mp-${gi}"]:checked`)];
              return sels.map((el) => it.cands[+el.value]);
            });
            resolve(out); modalResolve = null;
          } },
      ]);
    });
  }

  function pickModal(title, seed, searchable, hint) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const listHtml = (arr, q) => (arr.length ? arr.map((c) => `
          <label class="up-opt"><input type="radio" name="up-pk" value="${esc(c.s.spuCode)}">
            <span><b>${esc(c.s.name)}</b>（${esc(c.s.spuCode)}）<br><span class="up-meta">${esc(c.sub || (c.s.spuCode + ' · ' + c.s.season + ' · ' + c.s.name))}</span></span>
          </label>`).join('') : `<p class="up-pill">${q ? '无匹配候选，可换关键词或直接放弃。' : '底表无近似候选，请直接放弃并反馈产品底表维护。'}</p>`);
      const body = `
        ${searchable ? '<input class="up-cell" id="up-pk-search" placeholder="输入 款号/品名/简称 搜索（默认已按相似度列出最接近的候选）…" style="width:100%;margin-bottom:10px">' : ''}
        <div id="up-pk-list">${listHtml(seed.length ? seed : nearCands(hint), '')}</div>`;
      openModal(title, body, [
        { label: '放弃该项', onClick: () => resolve(null) },
        { label: '确认', primary: true, onClick: () => { const sel = $('#umodal-body').querySelector('input[name=up-pk]:checked'); if (!sel) { modalErr('请先勾选一项'); return false; } resolve(SPU[sel.value]); modalResolve = null; } },
      ]);
      const sp = $('#up-pk-search');
      if (sp) sp.addEventListener('input', () => { const q = norm(sp.value); $('#up-pk-list').innerHTML = listHtml(q ? rankSpu(sp.value, 40).map((s) => ({ s, sub: `${s.spuCode} · ${s.season} · ${s.name}` })) : (seed.length ? seed : nearCands(hint)), sp.value); });
    });
  }

  function showUnmatchedAlert() {
    const list = state.unmatched.map((u) => `<li>${esc(u.row.name)}（时期：${esc(u.row.seasonRaw || '—')}，原价 ${esc(u.row.orig)}，活动价 ${esc(u.row.act)}）</li>`).join('');
    $('#up-unmatched-alert').innerHTML = `
      <div class="up-alert err">
        <b>未匹配数量过多（${state.unmatched.length} 项 &gt; 5）</b>：未匹配项不生成明细。<br>
        未匹配数量过多，请自查产品信息表的标准商品简称是否正确。可能是手工制作的活动表中商品简称与产品底表不一致，建议重构活动表后重新上传。
        <details style="margin-top:8px"><summary>展开未匹配清单（${state.unmatched.length}）</summary><ul>${list}</ul></details>
      </div>`;
  }

  /* ---------- 多值价格确认 ---------- */
  async function resolvePrice(row, spu) {
    const p = parsePriceCell(row.act);
    const colors = [...new Set(spu.skus.map((k) => k.color))];
    if (p.kind === 'single') return { default: p.base, byColor: {} };
    if (p.kind === 'exception') {
      const byColor = {};
      for (const ex of p.exceptions) for (const c of ex.colors) {
        const hit = colors.find((cc) => norm(cc) === norm(c) || cc.includes(c) || c.includes(cc));
        if (hit) byColor[hit] = ex.price;
      }
      return { default: p.base, byColor };
    }
    if (p.kind === 'multi') {
      if (state._cancelAllMulti) return null;
      const rs = parseRemarkSplit(row.remark);
      return await priceAssignModal(row, spu, p.values, rs);
    }
    return { default: null, byColor: {}, raw: p.text || '' };
  }
  function priceAssignModal(row, spu, values, remarkSplit) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const colors = [...new Set(spu.skus.map((k) => k.color))];
      const body = `
        <p>商品「${esc(row.name)}」活动价为多值 <b>${values.join(' / ')}</b>${remarkSplit ? `，备注提示「纯色 ${remarkSplit.pure}，其他 ${remarkSplit.other}」` : ''}。<br>
        系统无法自动判定哪些颜色属于「纯色」，请为每个颜色指定价格（<b>已默认选第一个值 ${values[0]}，只需改动有差异的颜色</b>）：</p>
        <div style="margin-top:10px">${colors.map((c) => `
          <div class="up-opt" style="justify-content:space-between">
            <span><b>${esc(c)}</b> <span class="up-meta">×${spu.skus.filter((k) => k.color === c).length} 尺码</span></span>
            <span>${values.map((v, i) => `<label style="margin-left:12px"><input type="radio" name="pa-${esc(c)}" value="${v}" ${i === 0 ? 'checked' : ''}> ${v}</label>`).join('')}</span>
          </div>`).join('')}
        </div>
        <p class="up-pill" style="margin-top:8px">提示：${remarkSplit ? `参考备注——纯色=${remarkSplit.pure}，其他=${remarkSplit.other}（请核对颜色归类后确认）` : '请对照原表确认'}</p>`;
      openModal('多值价格确认', body, [
        { label: '取消全部（剩余多值行进异常）', onClick: () => { state._cancelAllMulti = true; resolve(null); modalResolve = null; } },
        { label: '取消（暂不分配）', onClick: () => resolve(null) },
        { label: '确认分配', primary: true, onClick: () => {
            const byColor = {};
            for (const c of colors) {
              const sel = $(`#umodal-body input[name="pa-${esc(c)}"]:checked`);
              if (!sel) { modalErr(`颜色「${c}」尚未指定价格`); return false; }
              byColor[c] = Number(sel.value);
            }
            resolve({ default: null, byColor }); modalResolve = null;
          } },
      ]);
    });
  }

  /* ---------- 赠品 ---------- */
  function extractGiftNames() {
    const text = state.activity.manzeng || '';
    return [...new Set([...text.matchAll(/送([\u4e00-\u9fa5A-Za-z0-9.·]+?)(?:[；;，,]|$)/g)].map((m) => m[1].trim()).filter(Boolean))];
  }
  async function resolveGifts() {
    /* 幂等：保留本次会话已匹配/已跳过的赠品，只对"新出现且未处理"的满赠名做匹配，避免重进丢失或重复弹 */
    const handled = new Set([...state.gifts.map((x) => x.name), ...state.skippedGifts.map((x) => x.name)]);
    const needPick = [];
    const before = state.gifts.length + state.skippedGifts.length;
    for (const gname of extractGiftNames()) {
      if (handled.has(gname)) continue;
      const m = matchSpu(gname, '');
      if (m.spu) { state.gifts.push({ name: gname, spu: m.spu, how: m.how }); continue; }
      const cands = (m.multi || []).length ? m.multi : rankSpu(gname, 12);
      needPick.push({ gname, cands });
    }
    if (needPick.length) {
      await giftBatchModal(needPick);
      /* 兜底：弹窗结束后，凡是提过名却没匹配成赠品的（含直接关掉弹窗），一律记为已跳过，避免静默丢失 */
      const inG = new Set(state.gifts.map((x) => x.name));
      for (const it of needPick) {
        if (!inG.has(it.gname) && !state.skippedGifts.some((s) => s.name === it.gname)) state.skippedGifts.push({ name: it.gname });
      }
    }
    /* 赠品数据变化后重渲染（含自动匹配与弹窗确认），否则底部/指标会停在旧值 */
    if (state.gifts.length + state.skippedGifts.length !== before) renderPick();
  }
  function giftBatchModal(items) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      const opts = (extra) => `<option value="">跳过（不生成赠品行）</option><option value="__name__">仅按名称记录（底表无此商品）</option>${(extra || []).map((s) => `<option value="${esc(s.spuCode)}">${esc(s.name)}（${esc(s.spuCode)} · ${esc(s.season)}）</option>`).join('')}`;
      const body = `<p style="margin-bottom:10px">以下 <b>${items.length}</b> 个赠品在底表未精确匹配。可：选近似底表商品；或"仅按名称记录"（赠品常是周边、不在商品底表，仍会生成赠品行）；不选=跳过（稍后可在底部赠品区重新匹配）：</p>` +
        items.map((it, gi) => `
          <div class="up-opt" style="justify-content:space-between;gap:12px">
            <span><b>${esc(it.gname)}</b> <span class="up-meta">近似候选 ${(it.cands || []).length}</span></span>
            <select class="up-cell" data-gi="${gi}" style="min-width:300px">${opts(it.cands)}</select>
          </div>`).join('');
      openModal('赠品匹配确认', body, [
        { label: '全部跳过', onClick: () => { items.forEach((it) => state.skippedGifts.push({ name: it.gname })); resolve(); modalResolve = null; } },
        { label: '确认', primary: true, onClick: () => {
            $('#umodal-body').querySelectorAll('select[data-gi]').forEach((sel) => {
              const gi = +sel.dataset.gi, it = items[gi], code = sel.value;
              if (!code) { state.skippedGifts.push({ name: it.gname }); return; }
              if (code === '__name__') { state.gifts.push({ name: it.gname, spu: null, how: '按名称' }); return; }
              const spu = SPU[code]; if (spu) state.gifts.push({ name: it.gname, spu, how: '人工指定' }); else state.skippedGifts.push({ name: it.gname });
            });
            resolve(); modalResolve = null;
          } },
      ]);
    });
  }
  function giftAddModal() {
    return new Promise((resolve) => {
      modalResolve = resolve;
      openModal('添加赠品', `<p class="up-meta" style="margin-bottom:10px">手动添加赠品：可只填名称（底表无此商品，按名称生成赠品行），或同时填货号以关联底表商品并按其 SKU 展开。</p>
        <div class="field" style="margin-bottom:8px"><label>赠品名称 *</label><input id="ga-name" class="up-cell" style="width:100%" placeholder="如 洗衣袋"></div>
        <div class="field"><label>货号（可选，关联底表商品）</label><input id="ga-code" class="up-cell" style="width:100%" placeholder="留空=仅按名称记录"></div>`,
        [
          { label: '取消', onClick: () => resolve() },
          { label: '添加', primary: true, onClick: () => {
              const nm = $('#ga-name').value.trim(); if (!nm) { modalErr('请输入赠品名称'); return false; }
              const cd = $('#ga-code').value.trim(); const spu = cd ? (SPU[cd] || null) : null;
              if (cd && !spu) { modalErr('该货号不在产品底表'); return false; }
              state.gifts.push({ name: nm, spu, how: spu ? '人工指定' : '按名称' });
              resolve(); modalResolve = null;
            } },
        ]);
    });
  }
  async function buildStd() {
    state.stdRows = []; state.errors = [];
    state._cancelAllMulti = false;
    const a = state.activity;
    const actId = 'ACT' + (a.start || '').replace(/-/g, '');
    let seq = 0;
    const priceCache = new Map();
    for (const m of state.matched) {
      const row = m.row, spus = m.spus;
      if (m.actByColor) priceCache.set(row, { default: null, byColor: m.actByColor });
      for (const spu of spus) {
        let pricePlan;
        if (priceCache.has(row)) pricePlan = priceCache.get(row);
        else { pricePlan = await resolvePrice(row, spu); priceCache.set(row, pricePlan); }
        /* ③ 三级填价结果优先：SPU/颜色/SKU 任一层级已填价，即可覆盖原表解析结果 */
        const plan = (m.plan && m.plan[spu.spuCode]) || null;
        const planCovered = plan ? spu.skus.every((k) => planPrice(plan, k.color, k.skuCode) != null) : false;
        if (!pricePlan && !planCovered) {
          state.errors.push({ where: `${spu.spuCode} ${row.name}`, what: `活动价无法确定（多值未确认，原表值：${row.act}）`, fix: '请在③选择商品的「按颜色分配」或展开 SPU 三级填价中明确活动价后重新生成' });
          continue;
        }
        if (!pricePlan) pricePlan = { default: null, byColor: {} };
        const orig = num(row.orig);
        const daily = num(row.daily) ?? orig;
        let remark = row.remark || '';
        let actDefault = pricePlan.default;
        let isEarlyBird = false;
        const eb = remark.match(/早鸟价\s*(\d+(?:\.\d+)?)/);
        if (eb) {
          const ebn = Number(eb[1]);
          if (actDefault != null && ebn < actDefault) { actDefault = ebn; isEarlyBird = true; }
          else if (actDefault == null) { actDefault = ebn; isEarlyBird = true; }
          if (!/早鸟价/.test(remark)) remark = (remark ? remark + '；' : '') + '早鸟价' + ebn;
        }
        /* 逐颜色例外（如到手价 "398（电光黄318）"）。sku 作参数传入 */
        const colorOverride = (rawVal, sku) => {
          const fp = parsePriceCell(rawVal);
          if (fp.kind === 'single') return fp.base;
          if (fp.kind === 'exception') {
            for (const ex of fp.exceptions) {
              const hit = ex.colors.some((c) => norm(sku.color) === norm(c) || sku.color.includes(c) || c.includes(sku.color));
              if (hit) return ex.price;
            }
            return fp.base;
          }
          /* 多值（到手价等）：不得复用活动价的 byColor。原表各列斜杠值顺序一致：
           * 若活动价同为多值且个数相同，按颜色分配结果的位置对应取价；否则取首值；行级告警进异常清单 */
          if (fp.kind === 'multi') {
            const ap = parsePriceCell(row.act);
            if (ap.kind === 'multi' && fp.values.length === ap.values.length) {
              const av = pricePlan.byColor[sku.color] != null ? pricePlan.byColor[sku.color] : pricePlan.default;
              const idx = av != null ? ap.values.indexOf(av) : -1;
              if (idx >= 0) return fp.values[idx];
            }
            return fp.values[0];
          }
          return null;
        };
        const fpFinal = parsePriceCell(row.final);
        if (fpFinal.kind === 'multi') {
          const apF = parsePriceCell(row.act);
          const mapped = apF.kind === 'multi' && fpFinal.values.length === apF.values.length;
          state.errors.push({ where: `${spu.spuCode} ${row.name}`, what: `到手价为多值（${row.final}），已${mapped ? '按与活动价多值的顺序对应取价' : '取首值'}，请核对`, fix: '在④明细中逐项确认到手价' });
        }
        for (const sku of spu.skus) {
          /* 就近覆盖：SKU > 颜色 > SPU（③ 三级填价）→ 回落原表解析结果 */
          let act = plan ? planPrice(plan, sku.color, sku.skuCode) : null;
          if (act == null) act = pricePlan.byColor[sku.color] != null ? pricePlan.byColor[sku.color] : actDefault;
          if (act == null) act = colorOverride(row.act, sku);
          if (act == null) {
            state.errors.push({ where: `${spu.spuCode} ${sku.color}${sku.size}`, what: `活动价无法确定（原表值：${pricePlan.raw ?? row.act}）`, fix: '请修正原表或重新确认' });
            continue;
          }
          let final = colorOverride(row.final, sku);
          if (final == null) final = act;
          const discRaw = String(row.disc ?? '').trim();
          const disc = (discRaw === '' || discRaw === '/' || discRaw === '-') ? null : num(discRaw);
          const origSku = sku.listPrice != null ? sku.listPrice : orig;
          const rec = {
            活动ID: actId, 活动名称: a.name, 平台: a.platform, 店铺: '',
            开始: a.start, 结束: a.end, 活动类型: a.type,
            产品名称: spu.name, 商品时期: spu.season || row.season, 货号: spu.spuCode,
            颜色: sku.color, 尺码: sku.size, SKU编码: sku.skuCode,
            '库存(SKU)': stockNumber(APP.stockOf(sku.skuCode)),
            原价: origSku, 日常价: daily, 活动价: act,
            折扣率: origSku ? Math.round(final / origSku * 100) / 100 : null,
            到手价: final, 优惠金额: origSku != null ? origSku - final : null,
            日常价差额: daily != null ? daily - final : null,
            赠品标记: '否', 满赠规则: a.manzeng, 购物金规则: a.gouwujin,
            备注: [remark, pricePlan.byColor[sku.color] != null && row.remark ? '' : ''].filter(Boolean).join('；'),
            数据来源: state.fileName, _seq: ++seq, _discSkipped: disc == null && discRaw === '/',
          };
          /* 校验（早鸟价属「活动价≥到手价」的特殊例外，不告警） */
          const probs = [];
          if (final > origSku) probs.push('到手价>原价');
          if (act < final && !isEarlyBird) probs.push('活动价<到手价');
          if (origSku == null) probs.push('缺原价');
          /* 主系统控价校验：低于建议最低价 → 复核（提交时计入低于控价数） */
          const prod = (D.products || []).find((x) => x.spuCode === spu.spuCode);
          if (prod) {
            const ref = APP.calcRef(prod);
            if (ref.suggestMin != null && act < ref.suggestMin) probs.push('低于控价');
          }
          if (probs.length) { rec._warn = probs.join('、'); state.errors.push({ where: `${spu.spuCode} ${sku.color}${sku.size}`, what: probs.join('、'), fix: '人工复核' }); }
          state.stdRows.push(rec);
        }
      }
    }
    /* 赠品行 */
    for (const g of state.gifts) {
      if (!g.spu) {
        state.stdRows.push({
          活动ID: actId, 活动名称: a.name, 平台: a.platform, 店铺: '', 开始: a.start, 结束: a.end, 活动类型: a.type,
          产品名称: g.name, 商品时期: '/', 货号: '', 颜色: '', 尺码: '', SKU编码: '',
          原价: 0, 日常价: null, 活动价: 0, 折扣率: null, 到手价: 0, 优惠金额: 0, 日常价差额: null,
          赠品标记: '是', 满赠规则: a.manzeng, 购物金规则: a.gouwujin, 备注: '赠品（按名称）', 数据来源: state.fileName, _seq: ++seq,
        });
        continue;
      }
      for (const sku of g.spu.skus) {
        state.stdRows.push({
          活动ID: actId, 活动名称: a.name, 平台: a.platform, 店铺: '', 开始: a.start, 结束: a.end, 活动类型: a.type,
          产品名称: g.spu.name, 商品时期: '/', 货号: g.spu.spuCode, 颜色: sku.color, 尺码: sku.size, SKU编码: sku.skuCode,
          '库存(SKU)': stockNumber(APP.stockOf(sku.skuCode)),
          原价: sku.listPrice != null ? sku.listPrice : 0, 日常价: null, 活动价: 0, 折扣率: null, 到手价: 0, 优惠金额: 0, 日常价差额: null,
          赠品标记: '是', 满赠规则: a.manzeng, 购物金规则: a.gouwujin, 备注: '赠品', 数据来源: state.fileName, _seq: ++seq,
        });
      }
    }
    /* 多店展开：每个勾选店铺各生成一套完整明细（提交时仍只生成 1 张申请单，明细以「店铺」列区分） */
    const stores = (a.stores && a.stores.length) ? a.stores : [''];
    const baseRows = state.stdRows;
    state.stdRows = [];
    for (const st of stores) {
      for (const r of baseRows) {
        const copy = Object.assign({}, r);
        copy.店铺 = st;
        copy._seq = ++seq;
        state.stdRows.push(copy);
      }
    }
    renderStd();
    goStep(3);
  }

  /* =========================================================
   * ③ 三级展开填价（SPU → 颜色 → SKU，参考手工填价「活动明细 · 填价」）
   *  · SPU 级改价：级联填充该 SPU 下全部颜色与 SKU
   *  · 颜色级改价：级联填充该颜色下全部 SKU（Excel 导入的活动价即落在颜色级）
   *  · SKU 级：点开颜色后才显示具体 SKU 的库存与申请价修改框
   *  · 就近覆盖：SKU > 颜色 > SPU；未填写时回落到原有解析结果
   * ========================================================= */
  const expSpu = new Map();    // 匹配行 → 已展开的 SPU 货号集合
  const expColor = new Map();  // 匹配行 → 已展开的 `${SPU货号}|${颜色}` 集合
  function expSet(map, m) { let s = map.get(m); if (!s) { s = new Set(); map.set(m, s); } return s; }

  function planFor(m, spu) {
    if (!m.plan) m.plan = {};
    if (!m.plan[spu.spuCode]) m.plan[spu.spuCode] = { spu: '', colors: {}, skus: {}, _seeded: false };
    return m.plan[spu.spuCode];
  }
  /* 用原表活动价预填：单值→SPU 统一价（含早鸟价下调）；颜色例外/已按颜色分配→颜色价 */
  function seedPlan(m, spu) {
    const p = planFor(m, spu);
    if (p._seeded) return p;
    p._seeded = true;
    const colors = [...new Set(spu.skus.map((k) => k.color))];
    const cell = parsePriceCell(m.row.act);
    const eb = String(m.row.remark || '').match(/早鸟价\s*(\d+(?:\.\d+)?)/);
    const ebn = eb ? Number(eb[1]) : null;
    const floor = (base) => (ebn != null && (base == null || ebn < base) ? ebn : base);
    const hitColor = (c) => colors.find((cc) => norm(cc) === norm(c) || cc.includes(c) || c.includes(cc));
    if (m.actByColor) {
      for (const c of Object.keys(m.actByColor)) { const h = hitColor(c); if (h) p.colors[h] = m.actByColor[c]; }
      return p;
    }
    if (cell.kind === 'single') p.spu = floor(cell.base);
    else if (cell.kind === 'exception') {
      p.spu = floor(cell.base);
      for (const ex of cell.exceptions) for (const c of ex.colors) { const h = hitColor(c); if (h) p.colors[h] = ex.price; }
    }
    return p;
  }
  const planNum = (v) => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
  /* 生效价：SKU > 颜色 > SPU */
  function planPrice(p, color, skuCode) {
    if (!p) return null;
    if (skuCode != null) { const v = planNum(p.skus[skuCode]); if (v != null) return v; }
    if (color != null) { const v = planNum(p.colors[color]); if (v != null) return v; }
    return planNum(p.spu);
  }
  /* 级联下发；返回是否有变化（无变化不重渲染，避免输入焦点丢失） */
  function planCascade(p, spu, lvl, color) {
    if (!p) return false;
    let changed = false;
    if (lvl === 'spu') {
      const v = planNum(p.spu);
      if (v == null) return false;
      for (const k of spu.skus) {
        if (planNum(p.colors[k.color]) !== v) { p.colors[k.color] = v; changed = true; }
        if (planNum(p.skus[k.skuCode]) !== v) { p.skus[k.skuCode] = v; changed = true; }
      }
    } else if (lvl === 'color') {
      const v = planNum(p.colors[color]);
      if (v == null) return false;
      for (const k of spu.skus) {
        if (k.color !== color) continue;
        if (planNum(p.skus[k.skuCode]) !== v) { p.skus[k.skuCode] = v; changed = true; }
      }
    }
    return changed;
  }
  const treeBase = (spu) => (spu.retailPrice != null ? spu.retailPrice : spu.listPrice);
  function treeDisc(spu, v) { const b = treeBase(spu); return v != null && b ? (v / b * 10).toFixed(1) + '折' : '—'; }
  function treeCheck(spu, v) {
    if (v == null) return '<span class="cell-sub">未填</span>';
    if (spu.suggestMin != null && v < spu.suggestMin) return '<span class="check-bad">✕ 低于控价</span>';
    const ceiling = Math.max(spu.listPrice || 0, spu.retailPrice || 0);
    if (ceiling && v > ceiling) return '<span class="check-bad">✕ 高于原价</span>';
    const low = APP.histLow ? APP.histLow(spu.spuCode) : null;
    if (low != null && v < low) return '<span class="check-warn">⚠ 破历史低价</span>';
    return '<span class="check-ok">✓ 正常</span>';
  }
  /* 单个 SPU 的三级明细（展开后整行全宽显示） */
  function pickTreeHtml(i, m, spu) {
    const si = m.spus.indexOf(spu);
    const p = planFor(m, spu);
    const spuVal = planNum(p.spu);
    const colors = [...new Set(spu.skus.map((k) => k.color))];
    const low = APP.histLow ? APP.histLow(spu.spuCode) : null;
    const out = [];
    out.push(`<tr class="tree-spu">
      <td><b>${esc(spu.name)}</b> <span class="cell-sub">${esc(spu.spuCode)} · ${spu.skus.length} SKU · SPU 统一价将级联填充下方全部 SKU</span></td>
      <td>${fmt(spu.listPrice)}</td><td>${fmt(spu.retailPrice)}</td>
      <td>${fmt(spu.suggestMin)}</td>
      <td>${low != null ? fmt(low) : '<span class="cell-sub">无记录</span>'}</td>
      <td>${stockText(spuStock(spu))}</td>
      <td><input class="price-input" data-act="pl-spu" data-i="${i}" data-si="${si}" type="number" placeholder="SPU 统一价" value="${esc(p.spu ?? '')}"></td>
      <td>${treeDisc(spu, spuVal)}</td><td>${treeCheck(spu, spuVal)}</td>
    </tr>`);
    for (const c of colors) {
      const cSkus = spu.skus.filter((k) => k.color === c);
      const cRaw = p.colors[c];
      const cVal = planNum(cRaw);
      const eff = cVal != null ? cVal : spuVal;
      const cOpen = expSet(expColor, m).has(`${spu.spuCode}|${c}`);
      out.push(`<tr class="tree-color">
        <td><button class="exp sm" data-act="exp-color" data-i="${i}" data-si="${si}" data-c="${esc(c)}" title="展开到 SKU 级（查看库存与申请价）">${cOpen ? '▾' : '▸'}</button><span class="lv-tag">颜色</span>${esc(c)} <span class="cell-sub">${cSkus.length} 尺码${cOpen ? '' : ' · 点箭头展开到 SKU'}</span></td>
        <td>${fmt(spu.listPrice)}</td><td>${fmt(spu.retailPrice)}</td>
        <td class="cell-sub">同 SPU</td><td class="cell-sub">同 SPU</td>
        <td>${stockText(spuStock(spu, c))}</td>
        <td><input class="price-input" data-act="pl-color" data-i="${i}" data-si="${si}" data-c="${esc(c)}" type="number" placeholder="${spuVal != null ? '继承 ' + spuVal : '颜色统一价'}" value="${esc(cRaw ?? '')}"></td>
        <td>${treeDisc(spu, eff)}</td><td>${treeCheck(spu, eff)}</td>
      </tr>`);
      if (!cOpen) continue;
      for (const k of cSkus) {
        const sRaw = p.skus[k.skuCode];
        const sVal = planNum(sRaw);
        const seff = sVal != null ? sVal : eff;
        out.push(`<tr class="tree-sku">
          <td><span class="lv-tag sku">SKU</span>${esc(k.skuCode)}</td>
          <td>${fmt(spu.listPrice)}</td><td>${fmt(spu.retailPrice)}</td>
          <td class="cell-sub">—</td><td class="cell-sub">—</td>
          <td>${stockText(APP.stockOf(k.skuCode))}</td>
          <td><input class="price-input" data-act="pl-sku" data-i="${i}" data-si="${si}" data-c="${esc(c)}" data-sc="${esc(k.skuCode)}" type="number" placeholder="${eff != null ? '继承 ' + eff : '填价'}" value="${esc(sRaw ?? '')}"></td>
          <td>${treeDisc(spu, seff)}</td><td>${treeCheck(spu, seff)}</td>
        </tr>`);
      }
    }
    return `<table class="up-tbl up-tree"><thead><tr><th>SPU / 颜色 / SKU</th><th>吊牌价</th><th>零售价</th><th>建议最低价</th><th>历史最低价</th><th>库存</th><th>申请价</th><th>折扣</th><th>校验</th></tr></thead><tbody>${out.join('')}</tbody></table>`;
  }

  /* ---------- ③ 表头列宽（支持拖拉调整，单位 px） ---------- */
  const PICK_COLS = ['原表产品名称', '商品时期', '匹配 SPU（可修订）', '匹配方式', '原价', '活动价（可修订）', '到手价（可修订）', '价格备注', 'SKU数', '操作'];
  const PICK_COL_W = [180, 96, 320, 104, 80, 180, 180, 150, 72, 84];
  function applyPickColWidths() {
    const tbl = $('#up-pick-tbl'); if (!tbl) return;
    tbl.classList.add('col-resizable');
    const cols = tbl.querySelectorAll('colgroup col');
    PICK_COL_W.forEach((w, idx) => { if (cols[idx]) cols[idx].style.width = w + 'px'; });
    tbl.style.width = PICK_COL_W.reduce((a, b) => a + b, 0) + 'px';
  }

  /* ---------- ③ 渲染（二次修订） ---------- */
  function renderPick() {
    state.matched = state.matched || []; state.unmatched = state.unmatched || [];
    const total = state.rows.length;
    const matched = state.matched.length;
    const rate = total ? Math.round(matched / total * 100) : 0;
    $('#up-pick-metrics').innerHTML = `
      <div class="up-metric">商品行<b>${total}</b></div>
      <div class="up-metric good">已匹配<b>${matched}</b></div>
      <div class="up-metric ${state.unmatched.length ? 'bad' : ''}">未匹配<b>${state.unmatched.length}</b></div>
      <div class="up-metric">匹配率<b>${rate}%</b></div>
      <div class="up-metric">赠品<b>${state.gifts.length}</b></div>
      ${state.autoUnisexCount ? `<div class="up-metric">男女同款自动映射<b>${state.autoUnisexCount}</b></div>` : ''}`;
    $('#up-pick-tip').classList.remove('hidden');
    /* 预填三级价格计划（Excel 活动价 → SPU/颜色价），供展开填价与生成明细共用 */
    state.matched.forEach((m) => { (m.spus || []).forEach((s) => seedPlan(m, s)); });
    const rowsHtml = state.matched.map((m, i) => {
      const p = parsePriceCell(m.row.act);
      let priceHint = p.kind === 'multi' ? `<span class="up-badge warn">多值 ${esc(String(m.row.act))}</span>` : p.kind === 'exception' ? '<span class="up-badge info">含颜色例外</span>' : '';
      if (m.actByColor) priceHint = `<span class="up-badge ok">已按颜色分配 ${Object.keys(m.actByColor).length} 色</span> <button class="btn sm" data-act="assign-act" data-i="${i}">修改</button>`;
      else if (p.kind === 'multi') priceHint += ` <button class="btn sm" data-act="assign-act" data-i="${i}">按颜色分配</button>`;
      const finalEmpty = m.row.final == null || String(m.row.final).trim() === '';
      const pf = parsePriceCell(m.row.final);
      const finalDisp = finalEmpty ? m.row.act : m.row.final;
      const finalHint = finalEmpty ? '<span class="up-badge info">原表无到手价，按活动价</span>' : (pf.kind === 'multi' ? `<span class="up-badge warn">多值 ${esc(String(m.row.final))}</span>` : pf.kind === 'exception' ? '<span class="up-badge info">含颜色例外</span>' : '');
      const eb = /早鸟价/.test(m.row.remark || '');
      /* SPU 单元格：左侧展开按钮 + SPU 信息占满空间，右侧固定放「改选/追加 SPU」 */
      const spuCell = `<div class="up-spu-cell"><div class="up-spu-lines">` +
        m.spus.map((s, si) => {
          const open = expSet(expSpu, m).has(s.spuCode);
          return `<div class="up-spu-line"><button class="exp lg" data-act="exp-spu" data-i="${i}" data-si="${si}" title="展开三级填价（SPU → 颜色 → SKU）">${open ? '▾' : '▸'}</button><b>${esc(s.name)}</b> <span class="up-pill mono">${esc(s.spuCode)} · ${esc(s.season)} · ${s.skus.length} SKU · 库存 ${stockText(spuStock(s))}</span>${m.spus.length > 1 ? ` <button class="btn sm link" data-act="rm-spu" data-i="${i}" data-si="${si}" title="从本行移除该 SPU">✕</button>` : ''}</div>`;
        }).join('') +
        `</div><button class="btn sm up-add-spu" data-act="add-spu" data-i="${i}">＋ 改选/追加 SPU</button></div>`;
      const skuTotal = m.spus.reduce((n, s) => n + s.skus.length, 0);
      /* 展开的 SPU 以整行全宽显示三级明细：SPU 统一价 → 颜色价 → 点开颜色后的 SKU 库存/申请价 */
      const treeRows = m.spus.map((s) => (expSet(expSpu, m).has(s.spuCode) ? `<tr class="up-tree-row"><td colspan="10">${pickTreeHtml(i, m, s)}</td></tr>` : '')).join('');
      return `<tr>
        <td>${esc(m.row.name)}</td><td>${esc(m.row.seasonRaw || '—')}</td>
        <td>${spuCell}</td>
        <td><span class="up-badge ${m.how === '商品简称' || m.how === '简称+时期' ? 'ok' : m.how === '产品名称' || m.how === '名称+时期' || m.how === '男女同款自动' ? 'info' : 'warn'}">${esc(m.how)}</span></td>
        <td class="num">${esc(m.row.orig)}</td>
        <td class="num">${priceHint}<input class="up-cell" data-act="edit-act" data-i="${i}" value="${esc(m.row.act)}"></td>
        <td class="num">${finalHint}<input class="up-cell" data-act="edit-final" data-i="${i}" value="${esc(finalDisp)}"></td>
        <td>${esc(m.row.remark || '')}${eb ? ' <span class="up-badge gift">早鸟价</span>' : ''}</td>
        <td class="num">${skuTotal}</td>
        <td><button class="btn sm warn" data-act="del-row" data-i="${i}">删除</button></td>
      </tr>${treeRows}`;
    }).join('');
    const unHtml = state.unmatched.map((u, ui) => {
      const fDisp = (u.row.final == null || String(u.row.final).trim() === '') ? '—' : esc(u.row.final);
      return `<tr><td class="up-errrow">${esc(u.row.name)}</td><td class="up-errrow">${esc(u.row.seasonRaw || '—')}</td><td class="up-errrow"><button class="btn sm" data-act="fix-un" data-ui="${ui}">重新匹配</button></td><td class="up-errrow">${esc(u.reason)}</td><td class="num up-errrow">${esc(u.row.orig ?? '—')}</td><td class="num up-errrow">${esc(u.row.act ?? '—')}</td><td class="num up-errrow">${fDisp}</td><td class="up-errrow">${esc(u.row.remark || '')}</td><td class="up-errrow">不生成明细</td><td><button class="btn sm warn" data-act="del-un" data-ui="${ui}">移除</button></td></tr>`;
    }).join('');
    $('#up-pick-tbl').innerHTML = `
      <colgroup>${PICK_COL_W.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>
      <thead><tr>${PICK_COLS.map((c, ci) => `<th>${c}<span class="col-resizer" data-col="${ci}" title="拖动调整列宽"></span></th>`).join('')}</tr></thead>
      <tbody>${rowsHtml}${unHtml}</tbody>`;
    applyPickColWidths();
    renderGiftBar();
  }

  function renderGiftBar() {
    const el = $('#up-gift-bar'); if (!el) return;
    const g = state.gifts, sk = state.skippedGifts;
    const okChips = g.map((x, gi) => `<span class="up-gift-chip ok">🎁 ${esc(x.name)} → ${x.spu ? `<b>${esc(x.spu.name)}</b>（${esc(x.spu.spuCode)} · 库存 ${stockText(spuStock(x.spu))}）` : '<i>按名称记录</i>'}<button class="btn sm link" data-act="rm-gift" data-gi="${gi}" title="移除该赠品">✕</button></span>`).join('');
    const skChips = sk.map((x, si) => `<span class="up-gift-chip skip">🎁 ${esc(x.name)}（已跳过）<button class="btn sm" data-act="readd-gift" data-si="${si}">重新匹配</button></span>`).join('');
    const has = g.length + sk.length;
    el.innerHTML = `<div class="up-gift-bar">
        <div class="up-gift-bar-h"><b>赠品</b> <span class="up-meta">已匹配 ${g.length}${sk.length ? ` · 已跳过 ${sk.length}` : ''}</span> <button class="btn sm" data-act="add-gift">＋ 添加赠品</button></div>
        ${has ? `<div class="up-gift-chips">${okChips}${skChips}</div>` : '<p class="up-pill">暂无赠品（满赠规则里的"送…"会自动匹配，跳过的也可在此重新添加）</p>'}
      </div>`;
  }

  /* ---------- ④ 渲染 ---------- */
  const STD_COLS = ['活动ID', '活动名称', '平台', '店铺', '开始', '结束', '活动类型', '产品名称', '商品时期', '货号', '颜色', '尺码', 'SKU编码', '库存(SKU)', '原价', '日常价', '活动价', '折扣率', '到手价', '优惠金额', '日常价差额', '赠品标记', '满赠规则', '购物金规则', '备注', '数据来源'];
  function renderStd() {
    const n = state.stdRows.length;
    const pass = n - state.stdRows.filter((r) => r._warn).length;
    $('#up-std-metrics').innerHTML = `
      <div class="up-metric">标准明细行<b>${n}</b></div>
      <div class="up-metric">店铺套数<b>${(state.activity.stores || []).length || 1}</b></div>
      <div class="up-metric good">校验通过<b>${pass}</b></div>
      <div class="up-metric ${n - pass ? 'warn' : ''}">需复核<b>${n - pass}</b></div>
      <div class="up-metric bad">异常<b>${state.errors.length}</b></div>
      <div class="up-metric">匹配率<b>${state.rows.length ? Math.round(state.matched.length / state.rows.length * 100) : 0}%</b></div>`;
    $('#up-std-tbl').innerHTML = `
      <thead><tr>${STD_COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${state.stdRows.map((r) => `<tr${r._warn ? ' style="background:#fff8f8"' : ''}>${STD_COLS.map((c) => {
        let v = r[c];
        if (c === '赠品标记') return `<td>${v === '是' ? '<span class="up-badge gift">是</span>' : '否'}</td>`;
        if (typeof v === 'number') return `<td class="num">${fmt(v)}</td>`;
        return `<td>${esc(v)}</td>`;
      }).join('')}${r._warn ? `<td><span class="up-badge err">${esc(r._warn)}</span></td>` : '<td></td>'}</tr>`).join('')}</tbody>`;
    const btn = $('#up-btn-submit');
    if (btn) { btn.disabled = false; btn.textContent = '✓ 核对无误，提交审批'; }
  }

  /* ---------- 提交（走正式归档/审批链路） ---------- */
  async function submitUpload() {
    if (!state.stdRows.length) return APP.toast('没有可提交的明细行');
    if (state._submitted) {
      openModal('已提交过', '<p>本明细已提交过申请单。如需再次提交，请返回修改后重新生成标准明细。</p>', [{ label: '知道了', primary: true }]);
      return;
    }
    const warnN = state.stdRows.filter((r) => r._warn).length;
    const errN = state.errors.length;
    const doIt = async () => {
      let created = [];
      try { created = await window.MKT_SUBMIT_UPLOAD({ activity: state.activity, stdRows: state.stdRows, sourceFile: state.fileName, sourceBase64: state.srcBase64 }); }
      catch (e) { openModal('提交失败', `<p>${esc(e.message)}</p>`, [{ label: '知道了', primary: true }]); return; }
      state._submitted = true;
      const btn = $('#up-btn-submit');
      if (btn) { btn.disabled = true; btn.textContent = '✓ 已提交'; }
      const ids = created.map((a) => `<b>${a.id}</b>（${esc(a.store)}，${a.status}${a.violations ? '，' + a.violations + ' 项低于控价' : ''}${a.oaErr ? '，⚠' + esc(a.oaErr) : ''}）`).join('<br>');
      openModal('提交成功', `<p>已生成 <b>${created.length}</b> 张申请单（所选平台/店铺合并为同一单据，明细以「店铺」列区分）：</p><div class="up-kv" style="line-height:2">${ids}</div><p class="up-pill" style="margin-top:8px">审批附件和在线协作表均为标准活动明细（SKU级），数据来源保留原始上传文件名；低于控价的申请单已推送钉钉审批。</p>`, [
        { label: '留在本页' },
        { label: '查看审批跟踪', primary: true, onClick: () => { window.switchTab('approval'); } },
      ]);
    };
    if (warnN || errN) {
      openModal('提交前确认', `<p>标准明细存在 <b style="color:var(--red,#e5484d)">${errN}</b> 条异常/复核项（含 ${warnN} 行标黄）。<br>异常行<b>不会</b>静默修正——请确认已在 ④ 表格逐项核对，再提交。</p>`, [
        { label: '返回检查' },
        { label: '已核对，确认提交', primary: true, onClick: doIt },
      ]);
    } else doIt();
  }

  /* ---------- XLSX ---------- */
  function dlXlsx(name, rows, cols, sheetName) {
    const aoa = [cols].concat(rows.map((r) => cols.map((c) => (r[c] ?? ''))));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map((c) => ({ wch: Math.max(10, Math.min(28, String(c).length * 2 + 4)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || 'Sheet1').slice(0, 31));
    XLSX.writeFile(wb, name);
  }

  /* ---------- CSV ---------- */
  function dlCsv(name, rows, cols) {
    const q = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const csv = '\uFEFF' + [cols.join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* =========================================================
   * 四、事件绑定
   * ========================================================= */
  function bindEvents() {
    /* ③ 表头列宽拖拉（按下 resizer → 跟随鼠标更新 colgroup 宽度） */
    let dragCol = -1, dragX = 0, dragW0 = 0;
    const pickTbl = $('#up-pick-tbl');
    pickTbl.addEventListener('mousedown', (e) => {
      const h = e.target.closest('.col-resizer'); if (!h) return;
      e.preventDefault();
      dragCol = +h.dataset.col; dragX = e.clientX; dragW0 = PICK_COL_W[dragCol];
      document.body.classList.add('col-dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (dragCol < 0) return;
      PICK_COL_W[dragCol] = Math.max(48, Math.round(dragW0 + (e.clientX - dragX)));
      applyPickColWidths();
    });
    document.addEventListener('mouseup', () => {
      if (dragCol < 0) return;
      dragCol = -1; document.body.classList.remove('col-dragging');
    });
    /* ③ 二次修订事件（委托） */
    $('#up-pick-tbl').addEventListener('change', (e) => {
      const el = e.target;
      const act = el.dataset.act, i = +el.dataset.i;
      /* 原表活动价被改写：作废按颜色分配与三级填价，按新值重新预填 */
      if (act === 'edit-act') { state.matched[i].row.act = el.value; delete state.matched[i].actByColor; delete state.matched[i].plan; renderPick(); }
      if (act === 'edit-final') { state.matched[i].row.final = el.value; renderPick(); }
    });
    /* ③ 三级填价：输入即存值（不重渲染，避免失焦）；失焦时级联下发 */
    const treePlan = (el) => {
      const m = state.matched[+el.dataset.i]; if (!m) return null;
      const spu = m.spus[+el.dataset.si]; if (!spu) return null;
      return { m, spu, p: planFor(m, spu) };
    };
    $('#up-pick-tbl').addEventListener('input', (e) => {
      const el = e.target, act = el.dataset && el.dataset.act;
      if (!act || act.indexOf('pl-') !== 0) return;
      const t = treePlan(el); if (!t) return;
      const v = el.value === '' ? '' : Number(el.value);
      if (act === 'pl-spu') t.p.spu = v;
      else if (act === 'pl-color') t.p.colors[el.dataset.c] = v;
      else if (act === 'pl-sku') t.p.skus[el.dataset.sc] = v;
    });
    $('#up-pick-tbl').addEventListener('focusout', (e) => {
      const el = e.target, act = el.dataset && el.dataset.act;
      if (!act || act.indexOf('pl-') !== 0) return;
      const t = treePlan(el); if (!t) return;
      const lvl = act === 'pl-spu' ? 'spu' : act === 'pl-color' ? 'color' : 'sku';
      if (planCascade(t.p, t.spu, lvl, el.dataset.c)) renderPick();
    });
    $('#up-pick-tbl').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const act = b.dataset.act;
      /* SPU 级展开 → 三级明细；颜色级展开 → SKU 级（库存与申请价修改框） */
      if (act === 'exp-spu' || act === 'exp-color') {
        const m = state.matched[+b.dataset.i]; if (!m) return;
        const spu = m.spus[+b.dataset.si]; if (!spu) return;
        if (act === 'exp-spu') {
          const s = expSet(expSpu, m); s.has(spu.spuCode) ? s.delete(spu.spuCode) : s.add(spu.spuCode);
        } else {
          const key = `${spu.spuCode}|${b.dataset.c}`;
          const s = expSet(expColor, m); s.has(key) ? s.delete(key) : s.add(key);
        }
        renderPick();
        return;
      }
      if (act === 'del-row') {
        const m = state.matched[+b.dataset.i];
        state.matched.splice(+b.dataset.i, 1);
        state.unmatched.push({ row: m.row, reason: '人工删除' });
        renderPick();
      }
      if (act === 'rm-spu') {
        const m = state.matched[+b.dataset.i];
        m.spus.splice(+b.dataset.si, 1);
        if (m.actByColor) delete m.actByColor;
        if (!m.spus.length) { state.matched.splice(+b.dataset.i, 1); state.unmatched.push({ row: m.row, reason: '人工移除全部 SPU' }); }
        renderPick();
      }
      if (act === 'add-spu') {
        const m = state.matched[+b.dataset.i];
        const picked = await pickModal(`改选/追加 SPU：「${m.row.name}」— 已按近似度列出，可搜索全部`, nearCands(m.row.name), true, m.row.name);
        if (picked) {
          if (m.spus.includes(picked)) { modalErr('该 SPU 已在列表中'); return; }
          m.spus.push(picked); m.how = '人工改选';
          if (m.actByColor) delete m.actByColor;
          renderPick();
        }
      }
      if (act === 'fix-un') {
        const u = state.unmatched[+b.dataset.ui];
        const seed = (u.fuzzy && u.fuzzy.length) ? u.fuzzy.map((s) => ({ s, sub: `${s.spuCode} · ${s.season} · ${s.name}` })) : nearCands(u.row.name);
        const picked = await pickModal(`重新匹配「${u.row.name}」— 已按近似度列出候选，可搜索全部`, seed, true, u.row.name);
        if (picked) {
          state.unmatched.splice(+b.dataset.ui, 1);
          state.matched.push({ row: u.row, spus: [picked], how: '人工指定' });
          renderPick();
        }
      }
      if (act === 'assign-act') {
        const m = state.matched[+b.dataset.i];
        const p = parsePriceCell(m.row.act);
        if (p.kind !== 'multi') { modalErr('该行活动价不是多值，无需分配'); return; }
        const rs = parseRemarkSplit(m.row.remark);
        const merged = { skus: m.spus.reduce((arr, s) => arr.concat(s.skus), []) };
        const assign = await priceAssignModal(m.row, merged, p.values, rs);
        if (assign && assign.byColor && Object.keys(assign.byColor).length) { m.actByColor = assign.byColor; delete m.plan; }
        renderPick();
      }
      if (act === 'del-un') {
        state.unmatched.splice(+b.dataset.ui, 1);
        renderPick();
      }
    });

    $('#up-gift-bar').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act;
      if (act === 'rm-gift') { state.gifts.splice(+b.dataset.gi, 1); renderPick(); }
      if (act === 'readd-gift') {
        const x = state.skippedGifts[+b.dataset.si]; if (!x) return;
        const picked = await pickModal(`赠品「${x.name}」— 按近似度选择商品（放弃=保持跳过）`, nearCands(x.name), true, x.name);
        if (picked) { state.skippedGifts.splice(+b.dataset.si, 1); state.gifts.push({ name: x.name, spu: picked, how: '人工指定' }); renderPick(); }
      }
      if (act === 'add-gift') {
        const inG = new Set(state.gifts.map((x) => x.name));
        const pend = extractGiftNames().filter((n) => !inG.has(n));
        if (pend.length) {
          state.skippedGifts = state.skippedGifts.filter((s) => !pend.includes(s.name));
          await giftBatchModal(pend.map((n) => ({ gname: n, cands: rankSpu(n, 12) })));
        } else {
          await giftAddModal();
        }
        renderPick();
      }
    });

    /* 步骤导航 */
    $('#up-btn-back-upload').onclick = () => goStep(0);
    $('#up-btn-to-pick').onclick = async () => {
      if (!validateApply()) { openModal('必填项未完成', '<p>标红字段为必填，请补录后再进入下一步。</p>', [{ label: '知道了', primary: true }]); return; }
      goStep(2);
      await runMatch();
      await resolveGifts();
      state._matchedDone = true;
    };
    $('#up-btn-back-apply').onclick = () => { renderApplyForm(); goStep(1); };
    $('#up-btn-to-std').onclick = async () => {
      if (!state.matched || !state.matched.length) { openModal('无法生成明细', '<p>没有已匹配商品，请先在③完成商品匹配。</p>', [{ label: '知道了', primary: true }]); return; }
      await buildStd();
    };
    $('#up-btn-back-pick').onclick = () => { renderPick(); goStep(2); };
    $('#up-btn-csv').onclick = () => dlCsv(`标准活动明细_${state.fileName.replace(/\.xlsx?$/i, '')}.csv`, state.stdRows, STD_COLS);
    $('#up-btn-csv-err').onclick = () => dlCsv(`异常清单_${state.fileName.replace(/\.xlsx?$/i, '')}.csv`,
      state.errors.map((e) => ({ 位置: e.where, 问题: e.what, 处理建议: e.fix })), ['位置', '问题', '处理建议']);
    $('#up-btn-submit').onclick = submitUpload;
    $('#up-btn-ref-csv').onclick = () => {
      if (!SPU_LIST.length) { APP.toast('底表商品索引为空，请先在「数据源」拉取/接入产品信息'); return; }
      const cols = ['产品名称(标准简称)', '商品时期', '货号', '性别', '类别', '颜色(尺码数)', '吊牌价', '零售价', '建议最低价', '历史最低价', '库存(SPU)', '申请价(填写)', '折扣(填写)', '多颜色填写说明'];
      const rows = SPU_LIST.slice().sort((a, b) => (a.spuShort || '').localeCompare(b.spuShort || '', 'zh') || (a.spuCode || '').localeCompare(b.spuCode || ''))
        .map((s) => {
          const counts = {}; (s.skus || []).forEach((sku) => { const color = sku.color || '均色'; counts[color] = (counts[color] || 0) + 1; });
          const colors = Object.keys(counts);
          return {
            '产品名称(标准简称)': s.spuShort || s.name, 商品时期: s.season, 货号: s.spuCode,
            性别: (s.genders || []).join('/') || s.gender || '', 类别: s.category,
            '颜色(尺码数)': colors.map((color) => `${color}(${counts[color]})`).join(' '),
            吊牌价: s.listPrice ?? '', 零售价: s.retailPrice ?? '',
            建议最低价: s.suggestMin ?? '', 历史最低价: APP.histLow(s.spuCode) ?? '', '库存(SPU)': spuStock(s) ?? '',
            '申请价(填写)': '', '折扣(填写)': '',
            多颜色填写说明: colors.length > 1 ? '活动价按颜色顺序填多值：' + colors.map(() => 'X').join('/') + '（或导入后在③按颜色分配）' : '单颜色：直接填活动价',
          };
        });
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      dlXlsx(`标准商品信息表_SPU模板_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.xlsx`, rows, cols, '标准商品信息表');
      APP.toast('已下载 SPU 模板（一行一 SPU，共 ' + rows.length + ' 行，列对齐手工填价模型）·「产品名称(标准简称)」照抄即可');
    };

    /* 样例 chips */
    const samples = window.UPLOAD_SAMPLES || {};
    $('#up-sample-chips').innerHTML = Object.keys(samples).map((f) => {
      const p = detectPlatform(f);
      return `<button class="up-chip" data-f="${esc(f)}">${esc(f.replace(/\.xlsx$/i, ''))}<small>${esc(p)}</small></button>`;
    }).join('');
    $('#up-sample-chips').addEventListener('click', (e) => {
      const b = e.target.closest('.up-chip'); if (!b) return;
      $('#up-sample-chips').querySelectorAll('.up-chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      loadWorkbook(b.dataset.f, samples[b.dataset.f]);
    });

    /* 文件上传 */
    const drop = $('#up-drop'), fileInput = $('#up-file');
    $('#up-btn-file').onclick = () => fileInput.click();
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) readFile(fileInput.files[0]); });
    function readFile(f) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const wb = XLSX.read(new Uint8Array(reader.result), { type: 'array', cellDates: true });
          const sheets = {};
          for (const sn of wb.SheetNames) {
            const ws = wb.Sheets[sn];
            if (!ws['!ref']) { sheets[sn] = []; continue; }
            const range = XLSX.utils.decode_range(ws['!ref']);
            const rows = [];
            for (let r = range.s.r; r <= range.e.r; r++) {
              const row = []; let any = false;
              for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = ws[XLSX.utils.encode_cell({ r, c })];
                let v = cell ? cell.v : null;
                if (cell && cell.t === 'd' && v instanceof Date) v = { __d: v.toISOString() };
                if (v != null && v !== '') any = true;
                row.push(v);
              }
              if (any || rows.length) rows.push(row);
            }
            while (rows.length && !rows[rows.length - 1].some((v) => v != null && v !== '')) rows.pop();
            sheets[sn] = rows;
          }
          loadWorkbook(f.name, sheets, abToB64(reader.result));
        } catch (err) { openModal('解析失败', `<p>文件解析失败：${esc(err.message)}</p>`, [{ label: '知道了', primary: true }]); }
      };
      reader.readAsArrayBuffer(f);
    }
  }

  /* ---------- 启动 ---------- */
  function boot() {
    injectUI();
    bindStepbar();
    bindEvents();
    renderSteps();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

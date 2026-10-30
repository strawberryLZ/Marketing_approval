/* ===== 营销活动管理系统原型逻辑 ===== */
const D = window.APP_DATA;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------- 工具 ---------- */
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}
function fmt(n) { return n == null || isNaN(n) ? '—' : '¥' + Number(n).toLocaleString('zh-CN'); }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* 库存：只读 API 返回并缓存的库存数据（stockMap 中间表）。无真实库存源、或该 SKU 缺数据一律返回 null，界面显示空；已彻底切断演示随机占位 */
function stockOf(skuCode) {
  const m = window.MKT_DS && window.MKT_DS.stockMap ? window.MKT_DS.stockMap() : null;
  if (!m) return null;
  return m[skuCode] != null ? m[skuCode] : null;
}

/* 库存求和：null 按 0 计；全部缺数据（无任何有效值）返回 null */
function stockSum(codes) {
  let has = false, sum = 0;
  for (const c of codes) { const v = stockOf(c); if (v != null) { sum += v; has = true; } }
  return has ? sum : null;
}

/* ---------- 参考价计算引擎 ----------
 * 新数据源（种子/API 中间表，与《单表处理》27 列一致）：折扣与价格已在聚合时按
 * 「零售价 × 行内最低/常规折扣」算好（含表内最低价兜底、红线价取 max 作地板），直接取行值；
 * 旧演示数据（data.js）：仍走等级规则表匹配。 */
function calcRef(p) {
  if (D.dataSourceKind !== 'demo') {
    /* 行值兜底后再现取红线价地板：即使中间表 minPrice 是旧逻辑缓存的，也会被红线价纠正 */
    const ruleMin = p.minPrice != null ? Number(p.minPrice) : null;
    const rl = p.redlinePrice != null ? Number(p.redlinePrice) : null;
    let suggestMin = ruleMin, redlineApplied = false;
    if (rl != null && (ruleMin == null || rl > ruleMin)) { suggestMin = rl; redlineApplied = true; }
    return {
      minD: p.minDiscount != null ? Number(p.minDiscount) : null,
      normD: p.normDiscount != null ? Number(p.normDiscount) : null,
      suggestMin,
      normPrice: p.normPrice != null ? p.normPrice : null,
      rule: null,
      redlineApplied,
      base: p.retailPrice != null ? p.retailPrice : p.listPrice,
    };
  }
  let minD = null, normD = null, rule = null;
  rule = D.gradeRules.find(
    (r) => r.type === p.productPos && r.offIdx === p.offSeasonIdx &&
      p.annualSales != null && p.annualSales >= r.salesMin && p.annualSales <= r.salesMax
  );
  if (rule) {
    minD = rule.minDiscount === '无' ? null : Number(rule.minDiscount);
    normD = rule.normDiscount;
  } else {
    minD = p.minDiscount && p.minDiscount !== '无' ? Number(p.minDiscount) : null;
    normD = p.normDiscount;
  }
  const list = p.listPrice;
  let suggestMin = minD != null && list ? Math.round(list * minD / 10) : null;
  if (suggestMin == null && p.minPrice) suggestMin = p.minPrice;
  let redlineApplied = false;
  /* 红线价=人工重算成本毛利后的最低可售价，作为地板：建议价不得低于红线价 → 取较高者 */
  if (p.redlinePrice != null) {
    const rb = p.redlinePrice;
    if (suggestMin == null || rb > suggestMin) { suggestMin = rb; redlineApplied = true; }
  }
  const normPrice = normD != null && list ? Math.round(list * normD / 10) : (p.normPrice || null);
  return { minD, normD, suggestMin, normPrice, rule, redlineApplied, base: list };
}

/* SKU 展开：SPU -> [{colorKey, gender, color, size, code}] */
function skusOf(p) {
  const out = [];
  for (const v of p.variants) {
    for (const c of v.colors) {
      for (const s of c.sizes) {
        out.push({ colorKey: v.code + '|' + c.name, gender: c.gender || v.gender, color: c.name, size: s.size, code: s.code });
      }
    }
  }
  return out;
}

/* 历史最低价仅来自服务器中已通过的真实申请快照。 */
function historyOf(spuCode) {
  return enterpriseHistory.filter((record) => record.spuCode === spuCode);
}
function histLow(spuCode) {
  const hs = historyOf(spuCode).filter((h) => h.price != null);
  return hs.length ? Math.min(...hs.map((h) => h.price)) : null;
}

/* ---------- 状态：企业记录由服务端保存，页面仅维护当前会话内存 ---------- */
let apps = [];
let enterpriseHistory = [];
let enterpriseCosts = [];
let enterprisePlays = [];
let resubmitParentId = null;
let selSpu = [];            // 已选 SPU id（保持顺序）
let priceMap = {};          // spuId -> { spu, colors:{key}, skus:{code} }
let expandedSpu = new Set();
let expandedColor = new Set();
let selActivities = new Set(); // 活动类型 key 多选
let costMap = {};              // '统一名|二级分类' -> 业务填写的费用承担
let scopeMap = {};             // '统一名|二级分类' -> 'sku'（按商品填价）| 'store'（全店玩法）
let playMap = {};              // '统一名|二级分类' -> { type, tier, floor }（全店玩法参数）
let standardMeta = { manzeng: '', remark: '' }; // 手工填价的标准明细活动级字段
let apFilter = 'all';
let auditRows = [];

function saveApps() { /* 企业申请由 /api/applications 持久化；页面不写浏览器存储。 */ }
async function loadEnterpriseApplications() {
  const r = await fetch('/api/applications', { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok || !j || !j.success) throw new Error((j && j.msg) || '读取企业申请记录失败');
  apps = Array.isArray(j.applications) ? j.applications : [];
  const refs = j.references || {};
  enterpriseHistory = Array.isArray(refs.history) ? refs.history : [];
  enterpriseCosts = Array.isArray(refs.costs) ? refs.costs : [];
  enterprisePlays = Array.isArray(refs.plays) ? refs.plays : [];
  try { D.historyRecords = []; } catch (e) {}
  updateBadge(); renderApprovals(); renderRuleHints(); renderCostForm();
  return apps;
}
async function persistApplication(app) {
  const r = await fetch('/api/applications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ application: app }) });
  const j = await r.json();
  if (!r.ok || !j || !j.success) throw new Error((j && j.msg) || '企业申请记录保存失败');
  return j;
}

/* ---------- 导航 ---------- */
function activateView(t) {
  if (!t || !t.dataset || !t.dataset.view) return;
  const view = $('#view-' + t.dataset.view);
  if (!view) return;
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.view').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  view.classList.add('active');
  if (t.dataset.view === 'approval') renderApprovals();
  if (t.dataset.view === 'audit') void loadApplicationAudit();
}
/* 数据源页签在登录鉴权完成后才动态插入，使用事件委托确保新页签也可切换。 */
document.addEventListener('click', (event) => {
  const tab = event.target.closest && event.target.closest('.tab');
  if (tab) activateView(tab);
});
window.MKT_ACTIVATE_VIEW = activateView;

/* 数据库核对只开放给既有信息部门白名单；页面只读取固定业务字段，不能执行任意 SQL。 */
async function ensureAuditTab() {
  let allowed = false;
  try {
    const r = await fetch('/api/datasource/access', { cache: 'no-store' });
    const j = await r.json();
    allowed = !!(r.ok && j && j.allowed);
  } catch (e) { /* 未登录或权限不足时不显示入口。 */ }
  const tab = document.querySelector('.tab[data-view="audit"]');
  const view = $('#view-audit');
  if (!allowed) { if (tab) tab.remove(); if (view) view.remove(); return; }
  if (tab) return;
  const nav = document.querySelector('nav.tabs');
  const main = document.querySelector('main.stage');
  if (!nav || !main) return;
  const button = document.createElement('button');
  button.className = 'tab'; button.dataset.view = 'audit';
  button.innerHTML = '<span class="tab-ico">▣</span>数据核对';
  nav.appendChild(button);
  const section = document.createElement('section');
  section.className = 'view'; section.id = 'view-audit';
  section.innerHTML = `<div class="panel">
    <div class="detail-head"><div><h2 class="panel-title">已入库数据核对</h2><div class="cell-sub">仅展示营销申请、审批同步与状态留痕；不提供数据库连接或写入能力。</div></div>
      <div class="detail-actions"><button class="btn ghost sm" id="audit-refresh">刷新</button></div></div>
    <div class="query-bar"><input id="audit-search" type="text" placeholder="筛选申请单号、审批实例、申请人、平台或店铺"></div>
    <div id="audit-summary" class="cell-sub" style="margin:10px 0"></div>
    <div class="table-wrap"><table class="grid"><thead><tr><th>申请单 / 审批实例</th><th>申请信息</th><th>活动与明细</th><th>系统状态</th><th>审批同步</th><th>状态留痕</th><th>操作</th></tr></thead><tbody id="audit-tbody"></tbody></table></div>
  </div>`;
  main.appendChild(section);
  $('#audit-refresh').addEventListener('click', () => void loadApplicationAudit(true));
  $('#audit-search').addEventListener('input', renderApplicationAudit);
}

function auditTime(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function renderApplicationAudit() {
  const body = $('#audit-tbody'); const search = String($('#audit-search')?.value || '').trim().toLowerCase();
  if (!body) return;
  const rows = auditRows.filter((row) => !search || [row.application_id, row.oa_instance_id, row.applicant, row.platform, row.store, row.activity_name]
    .some((value) => String(value || '').toLowerCase().includes(search)));
  const summary = $('#audit-summary');
  if (summary) summary.textContent = `当前显示 ${rows.length} / ${auditRows.length} 条已入库申请`;
  body.innerHTML = rows.length ? rows.map((row) => {
    const events = Array.isArray(row.status_events) ? row.status_events : [];
    const eventText = events.map((event) => `${esc(event.status || '—')} · ${esc(event.source || '—')} · ${esc(auditTime(event.createdAt))}`).join('<br>') || '—';
    return `<tr><td><b>${esc(row.application_id)}</b><div class="cell-sub">${esc(row.oa_instance_id || '—')}</div><div class="cell-sub">入库：${esc(auditTime(row.created_at))}</div></td>
      <td>${esc(row.applicant || '—')}<div class="cell-sub">${esc(row.platform || '—')} / ${esc(row.store || '—')}</div></td>
      <td>${esc(row.activity_name || row.activity_type || '—')}<div class="cell-sub">${esc(row.start_date || '—')} ~ ${esc(row.end_date || '—')}</div><div class="cell-sub">SKU：${Number(row.item_count || 0)}；标准明细：${Number(row.standard_row_count || 0)}</div></td>
      <td>${esc(row.application_status || '—')}<div class="cell-sub">更新：${esc(auditTime(row.updated_at))}</div></td>
      <td>${esc(row.sync_status || '缺少同步记录')}<div class="cell-sub">${esc(row.ding_status || '—')} / ${esc(row.ding_result || '—')}</div><div class="cell-sub">同步：${esc(auditTime(row.sync_updated_at))}</div></td>
      <td class="cell-sub">${eventText}</td>
      <td><button class="btn ghost sm" onclick="openAuditDetail('${esc(row.application_id)}')">查看明细</button></td></tr>`;
  }).join('') : '<tr class="empty-row"><td colspan="7">没有符合条件的已入库申请</td></tr>';
}

async function loadApplicationAudit(force) {
  if (!$('#view-audit')) return;
  if (auditRows.length && !force) { renderApplicationAudit(); return; }
  const r = await fetch('/api/application-audit', { cache: 'no-store' });
  const j = await r.json();
  if (!r.ok || !j || !j.success) { toast((j && j.msg) || '读取入库核对记录失败'); return; }
  auditRows = Array.isArray(j.rows) ? j.rows : [];
  renderApplicationAudit();
}

function auditValue(value) { return value == null || value === '' ? '—' : esc(value); }
function auditPrice(value) { return value == null || value === '' ? '—' : fmt(value); }
function auditRowsOf(detail, key) { return Array.isArray(detail && detail[key]) ? detail[key] : []; }

window.openAuditDetail = async function (applicationId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(applicationId || ''))) return toast('申请单号无效');
  $('#drawer-title').textContent = '入库申请明细';
  $('#drawer-body').innerHTML = '<p class="cell-sub">正在读取固定入库字段…</p>';
  $('#drawer').classList.add('show'); $('#drawer-mask').classList.add('show');
  try {
    const r = await fetch('/api/application-audit/detail?applicationId=' + encodeURIComponent(applicationId), { cache: 'no-store' });
    const j = await r.json();
    if (!r.ok || !j || !j.success || !j.detail) throw new Error((j && j.msg) || '读取入库申请明细失败');
    renderAuditDetail(j.detail);
  } catch (e) {
    $('#drawer-body').innerHTML = `<div class="oa-box"><h4>无法读取明细</h4><div class="cell-sub">${esc(e.message || '请稍后重试')}</div></div>`;
  }
};

function renderAuditDetail(detail) {
  const items = auditRowsOf(detail, 'items');
  const standardRows = auditRowsOf(detail, 'standard_rows');
  const activities = auditRowsOf(detail, 'activities');
  const events = auditRowsOf(detail, 'status_events');
  $('#drawer-title').textContent = '入库申请明细 · ' + String(detail.application_id || '');
  const activityText = activities.map((activity) => {
    const play = activity && activity.play ? [activity.play.type, activity.play.tier, activity.play.floor ? '到手价 ' + activity.play.floor : ''].filter(Boolean).join(' ') : '';
    return `${auditValue(activity && activity.cat2)}：${auditValue(activity && activity.scope === 'store' ? '全店玩法' : '按商品填价')}${play ? ' · ' + esc(play) : ''}${activity && activity.cost ? ' · 费用承担 ' + esc(activity.cost) : ''}`;
  }).join('<br>') || '—';
  const eventText = events.map((event) => `${auditValue(event && event.status)} · ${auditValue(event && event.source)} · ${esc(auditTime(event && event.createdAt))}`).join('<br>') || '—';
  $('#drawer-body').innerHTML = `
    <div class="oa-box"><h4>数据库入库快照（只读）</h4><div class="cell-sub">固定字段展示；不包含数据库地址、凭据、原始 JSON 或写入操作。</div></div>
    <div class="kv">
      <span class="k">申请单 / 审批实例</span><span>${auditValue(detail.application_id)}<div class="cell-sub">${auditValue(detail.oa_instance_id)}</div></span>
      <span class="k">申请人</span><span>${auditValue(detail.applicant)}</span>
      <span class="k">平台 / 店铺</span><span>${auditValue(detail.platform)} · ${auditValue(detail.store)}</span>
      <span class="k">活动 / 时间</span><span>${auditValue(detail.activity_name || detail.activity_type)}<div class="cell-sub">${auditValue(detail.start_date)} ~ ${auditValue(detail.end_date)}</div></span>
      <span class="k">系统状态</span><span>${auditValue(detail.application_status)}<div class="cell-sub">更新：${esc(auditTime(detail.updated_at))}</div></span>
      <span class="k">审批同步</span><span>${auditValue(detail.sync_status || '缺少同步记录')}<div class="cell-sub">${auditValue(detail.ding_status)} / ${auditValue(detail.ding_result)} · ${esc(auditTime(detail.sync_updated_at))}</div></span>
      <span class="k">入库时间</span><span>${esc(auditTime(detail.created_at))}</span>
      <span class="k">状态留痕</span><span class="cell-sub">${eventText}</span>
      <span class="k">活动配置</span><span class="cell-sub">${activityText}</span>
    </div>
    <h4 style="margin:22px 0 10px">SKU 明细（${items.length} 行）</h4>
    <div class="table-wrap"><table class="grid"><thead><tr><th>SKU / 商品</th><th>货号</th><th>颜色 / 尺码</th><th>原价</th><th>建议价</th><th>历史低价</th><th>申请价</th><th>控价结论</th><th>库存</th></tr></thead><tbody>${items.length ? items.map((item) => `<tr><td>${auditValue(item && item.skuCode)}<div class="cell-sub">${auditValue(item && item.name)}</div></td><td>${auditValue(item && item.spuCode)}</td><td>${auditValue(item && item.color)} / ${auditValue(item && item.size)}</td><td>${auditPrice(item && item.listPrice)}</td><td>${auditPrice(item && item.suggestMin)}</td><td>${auditPrice(item && item.histLow)}</td><td><b>${auditPrice(item && item.price)}</b></td><td>${auditValue(item && item.compliance)}</td><td>${auditValue(item && item.stock)}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="9">该申请没有 SKU 明细</td></tr>'}</tbody></table></div>
    <h4 style="margin:22px 0 10px">审批标准表行（${standardRows.length} 行）</h4>
    <div class="table-wrap"><table class="grid"><thead><tr><th>SKU</th><th>产品 / 货号</th><th>颜色 / 尺码</th><th>原价</th><th>日常价</th><th>活动价</th><th>折扣率</th><th>到手价</th><th>优惠金额</th><th>库存</th></tr></thead><tbody>${standardRows.length ? standardRows.map((row) => `<tr><td>${auditValue(row && row['SKU编码'])}</td><td>${auditValue(row && row['产品名称'])}<div class="cell-sub">${auditValue(row && row['货号'])}</div></td><td>${auditValue(row && row['颜色'])} / ${auditValue(row && row['尺码'])}</td><td>${auditPrice(row && row['原价'])}</td><td>${auditPrice(row && row['日常价'])}</td><td>${auditPrice(row && row['活动价'])}</td><td>${auditValue(row && row['折扣率'])}</td><td>${auditPrice(row && row['到手价'])}</td><td>${auditPrice(row && row['优惠金额'])}</td><td>${auditValue(row && row['库存(SKU)'])}</td></tr>`).join('') : '<tr class="empty-row"><td colspan="10">该申请没有标准表行</td></tr>'}</tbody></table></div>`;
}

/* ================= 视图一：活动申请 ================= */
/* 数据源不可用时的回退店铺清单；正常由数据源中的店铺 - 平台映射提供。 */
const FALLBACK_PLATFORM_STORES = {
  京东: ['京东官方旗舰店', '京东自营旗舰店', '京东奥莱店'],
  天猫: ['天猫官方旗舰店', '天猫outlet店'],
  抖音: ['抖音官方旗舰店', '抖音服饰旗舰店', '抖音奥莱店'],
};

function storePlatformRows() {
  if (window.MKT_DS && typeof window.MKT_DS.storePlatformRows === 'function') return window.MKT_DS.storePlatformRows();
  return Object.entries(FALLBACK_PLATFORM_STORES).flatMap(([platform, stores]) => stores.map((store) => ({ store, platform })));
}

function platformList() {
  return [...new Set(storePlatformRows().map((row) => row.platform).filter(Boolean))];
}

/* 仅复用已配置平台的活动规则；未配置的平台不能误用抖音规则。 */
function platformRuleInfo(rule, platform) {
  if (platform === '京东') return rule.jd || {};
  if (platform === '天猫' || platform === '淘宝天猫') return rule.tm || {};
  if (platform === '抖音') return rule.dy || {};
  return {};
}

/* 根据店铺 - 平台映射渲染平台下拉；保留当前平台，失效时优先回退京东。 */
function renderPlatformSelect(prevPlatform) {
  const sel = $('#f-platform');
  if (!sel || sel.tagName !== 'SELECT') return;
  const list = platformList();
  const requested = prevPlatform !== undefined ? prevPlatform : sel.value;
  const keep = requested === '天猫' && list.includes('淘宝天猫') ? '淘宝天猫' : requested;
  sel.innerHTML = list.map((platform) => `<option value="${esc(platform)}">${esc(platform)}</option>`).join('');
  sel.value = list.includes(keep) ? keep : (list.includes('京东') ? '京东' : (list[0] || ''));
}

/* 按平台渲染店铺下拉；prevStore 用于 reopen 回填（不在该平台清单内则回退第一项） */
function renderStoreSelect(prevStore) {
  ensureStoreSelect();
  const sel = $('#f-store');
  if (!sel || sel.tagName !== 'SELECT') return;
  const list = storePlatformRows().filter((row) => row.platform === $('#f-platform').value).map((row) => row.store);
  const keep = prevStore !== undefined ? prevStore : sel.value;
  sel.innerHTML = list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  sel.value = list.includes(keep) ? keep : list[0] || '';
}

window.MKT_ON_STORE_PLATFORM_MAP = () => {
  const currentStore = $('#f-store') && $('#f-store').value;
  renderPlatformSelect();
  renderStoreSelect(currentStore);
};

function activityOptions() {
  const seen = new Set();
  const opts = [];
  for (const r of D.activityRules) {
    const key = r.unified + '|' + r.cat2;
    if (seen.has(key)) continue;
    seen.add(key);
    opts.push({ key, r });
  }
  return opts;
}

function initApply() {
  ensureChipsHost();
  ensureExpandBtn();
  ensureCostFormHost();
  ensureStandardMetaHost();
  renderActivityChips();
  renderRuleHints();
  renderFilters();
  renderPickList();
  renderApplyTable();
  refreshStoreOnlyUi();
}

/* 若 index.html 中活动类型仍为 select，运行时替换为 chips 容器 */
function ensureChipsHost() {
  const el = $('#f-activity');
  if (!el || el.tagName === 'SELECT') {
    const div = document.createElement('div');
    div.className = 'act-chips';
    div.id = 'f-activity';
    if (el) el.replaceWith(div);
    const label = document.querySelector('.field label');
    const field = div.parentElement;
    if (field && field.tagName === 'DIV' && field.classList.contains('field')) {
      const lb = field.querySelector('label');
      if (lb && !lb.querySelector('small')) {
        lb.innerHTML = '活动类型 <small style="color:var(--txt2)">（可多选，支持多个活动同时开展）</small>';
      }
    }
  }
}

/* 若缺少「展开全部」按钮则动态插入 */
function ensureExpandBtn() {
  if (!$('#btn-expand')) {
    const actions = document.querySelector('.detail-actions');
    if (actions) {
      const b = document.createElement('button');
      b.className = 'btn ghost sm';
      b.id = 'btn-expand';
      b.textContent = '展开全部';
      actions.prepend(b);
      b.addEventListener('click', toggleExpandAll);
    }
  } else if (!$('#btn-expand')._bound) {
    $('#btn-expand')._bound = true;
    $('#btn-expand').addEventListener('click', toggleExpandAll);
  }
}

/* 若活动店铺仍为文本输入框则替换为下拉（index.html 可能被外部回退，运行时自愈） */
function ensureStoreSelect() {
  const el = $('#f-store');
  if (el && el.tagName !== 'SELECT') {
    const sel = document.createElement('select');
    sel.id = 'f-store';
    el.replaceWith(sel);
  }
}

/* 若缺少费用承担表单容器则动态插入（index.html 编辑可能被外部回退，运行时自愈） */
function ensureCostFormHost() {
  if (!$('#cost-form')) {
    const hint = $('#rule-hint');
    if (hint) {
      const div = document.createElement('div');
      div.className = 'cost-form';
      div.id = 'cost-form';
      hint.insertAdjacentElement('afterend', div);
    }
  }
}

/* 标准活动明细中的满赠规则、备注属于活动级字段；只在手工填价时采集，
 * 与 SKU 填价一起固化进审批附件和企业申请记录。 */
function ensureStandardMetaHost() {
  if ($('#standard-meta-form')) return;
  const host = $('#cost-form') || $('#rule-hint');
  if (!host) return;
  const box = document.createElement('div');
  box.id = 'standard-meta-form';
  box.className = 'cost-form';
  box.innerHTML = `<div class="cost-title">标准明细补充信息</div>
    <div class="cost-row"><label>满赠规则（可选）</label><input id="f-manzeng" class="cost-input" type="text" placeholder="如：满199送洗衣袋；满399送毛巾" value="${esc(standardMeta.manzeng)}"></div>
    <div class="cost-row"><label>备注（可选）</label><input id="f-standard-remark" class="cost-input" type="text" placeholder="如：早鸟价、特殊报名说明" value="${esc(standardMeta.remark)}"></div>`;
  host.insertAdjacentElement('afterend', box);
  $('#f-manzeng').addEventListener('input', () => { standardMeta.manzeng = $('#f-manzeng').value; });
  $('#f-standard-remark').addEventListener('input', () => { standardMeta.remark = $('#f-standard-remark').value; });
}

function syncStandardMetaFromDom() {
  const manzeng = $('#f-manzeng'); const remark = $('#f-standard-remark');
  if (manzeng) standardMeta.manzeng = manzeng.value.trim();
  if (remark) standardMeta.remark = remark.value.trim();
}

/* 活动类型：多选 chips */
function renderActivityChips() {
  const box = $('#f-activity');
  box.innerHTML = activityOptions().map(({ key, r }) =>
    `<button class="act-chip ${selActivities.has(key) ? 'on' : ''}" data-key="${esc(key)}">${esc(r.unified)}·${esc(r.cat2)}${scopeOfKey(key) === 'store' ? '<span class="chip-badge">全店</span>' : ''}</button>`
  ).join('');
  box.querySelectorAll('.act-chip').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.key;
    if (selActivities.has(k)) { selActivities.delete(k); }
    else {
      selActivities.add(k);
      /* 首次选中：带出上次归档的参与方式与玩法（记住上次），默认按商品填价 */
      if (scopeMap[k] === undefined) scopeMap[k] = lastScopeOf(k);
      if (!playMap[k]) { const lp = lastPlayOf(k); if (lp) playMap[k] = restorePlay(lp); }
    }
    renderActivityChips();
    _focusChipKey = k;
    renderRuleHints();
    refreshStoreOnlyUi();
  }));
}

let _focusChipKey = null;

function keyOf(r) { return r.unified + '|' + r.cat2; }
function scopeOfKey(key) { return scopeMap[key] === 'store' ? 'store' : 'sku'; }
function scopeOf(r) { return scopeOfKey(keyOf(r)); }

/* 上次归档的参与方式：成本库记录带 scope 字段；玩法库有记录则视为全店 */
function lastScopeOf(key) {
  const [unified, cat2] = key.split('|');
  const pf = $('#f-platform').value;
  const cost = enterpriseCosts.filter((c) => c.platform === pf && c.unified === unified && c.cat2 === cat2).slice(-1)[0];
  if (cost && cost.scope) return cost.scope;
  const play = enterprisePlays.filter((c) => c.platform === pf && c.unified === unified && c.cat2 === cat2).slice(-1)[0];
  if (play) return 'store';
  return 'sku';
}
function lastPlayOf(key) {
  const [unified, cat2] = key.split('|');
  const pf = $('#f-platform').value;
  return enterprisePlays.filter((c) => c.platform === pf && c.unified === unified && c.cat2 === cat2).slice(-1)[0];
}

/* 把归档记录恢复为结构化参数（优先 params；兼容旧文本格式，如「满300-50」「不低于9折」） */
function restorePlay(lp) {
  if (lp.params && lp.params.type) {
    const p = newPlay();
    Object.assign(p, lp.params);
    if (!Array.isArray(p.tiers) || !p.tiers.length) p.tiers = [{ th: '', off: '' }];
    return p;
  }
  const p = newPlay();
  p.type = lp.type || '';
  p.floor = lp.floor ? String(lp.floor).replace(/[^\d.]/g, '') : '';
  const s = lp.text || lp.tier || '';
  if (s) {
    const pairs = Array.from(s.matchAll(/满\s*(\d+(?:\.\d+)?)\s*[减\-]\s*(\d+(?:\.\d+)?)/g)).map((m) => ({ th: m[1], off: m[2] }));
    if (pairs.length) { p.tiers = pairs; return p; }
    const m2 = s.match(/满\s*(\d+(?:\.\d+)?)\s*打\s*(\d+(?:\.\d+)?)\s*折/);
    if (m2) { p.tiers = [{ th: m2[1], off: m2[2] }]; return p; }
    const m3 = s.match(/(\d+(?:\.\d+)?)\s*元券[，,]?\s*满\s*(\d+(?:\.\d+)?)\s*可用/);
    if (m3) { p.tiers = [{ th: m3[2], off: m3[1] }]; return p; }
    p.text = s;
  }
  return p;
}

/* 所选活动是否全部为全店玩法（此时无需选品填价） */
function isStoreOnly() {
  const rs = selectedRules();
  return rs.length > 0 && rs.every((r) => scopeOf(r) === 'store');
}

function selectedRules() {
  return activityOptions().filter(({ key }) => selActivities.has(key)).map(({ r }) => r);
}

const PLAY_TYPES = ['满减', '满折', '店铺券', '到手价折扣下限', '其他'];

function ruleRow(r) {
  const pf = $('#f-platform').value;
  const pfInfo = platformRuleInfo(r, pf);
  const riskCls = r.risk === '高' || r.risk === '极高' ? 'risk-high' : r.risk === '中' ? 'risk-mid' : 'risk-low';
  const key = keyOf(r);
  const scope = scopeOf(r);
  const lastCost = histCostList(pf, r.unified, r.cat2)[0];
  const costCell = lastCost
    ? esc(lastCost.cost)
    : '<i style="color:var(--amber)">需业务填写 ↓</i>';
  return `<div class="rule-row">
    <b>${esc(r.unified)} · ${esc(r.cat2)}</b>
    <span class="scope-seg">
      <button class="seg-btn ${scope === 'sku' ? 'on' : ''}" data-key="${esc(key)}" data-scope="sku">按商品填价</button>
      <button class="seg-btn ${scope === 'store' ? 'on' : ''}" data-key="${esc(key)}" data-scope="store">全店玩法</button>
    </span>
    <span>可参加：<b>${esc(r.joinable)}</b></span>
    <span>条件：${esc(r.condition)}</span>
    <span>风险：<span class="${riskCls}">${esc(r.risk)}</span></span>
    <span>OA：<b>${esc(r.needOA)}</b></span>
    <span>费用承担：${costCell}</span>
    ${pfInfo.name ? '' : '<span class="risk-mid">⚠ ' + esc(pf) + '名称待补充</span>'}
    ${scope === 'store' ? playForm(key) : ''}
  </div>`;
}

/* 全店玩法表单：按类型出结构化参数，自动生成规范描述文本归档 */
function newPlay() { return { type: '', tiers: [{ th: '', off: '' }], floor: '', text: '' }; }

function playDesc(p) {
  const n = (v) => { const x = parseFloat(v); return isNaN(x) ? null : x; };
  const tiers = (p.tiers || []).map((t) => ({ th: n(t.th), off: n(t.off) })).filter((t) => t.th != null || t.off != null);
  switch (p.type) {
    case '满减': return tiers.map((t) => `满${t.th ?? '—'}减${t.off ?? '—'}`).join('、');
    case '满折': return tiers.map((t) => `满${t.th ?? '—'}打${t.off ?? '—'}折`).join('、');
    case '店铺券': return tiers.map((t) => (t.off != null ? `${t.off}元券` : '—券') + (t.th != null ? `，满${t.th}可用` : '')).join('、');
    case '到手价折扣下限': return p.floor ? `到手价不低于${p.floor}折` : '';
    case '其他': return p.text || '';
    default: return '';
  }
}

/* 玩法是否完整可提交：类型已选 + 描述可生成且数字无缺 */
function playComplete(p) {
  const d = playDesc(p);
  if (!p.type || !d) return false;
  if (/—/.test(d)) return false;
  return true;
}

function playForm(key) {
  const [unified, cat2] = key.split('|');
  const p = playMap[key] || (playMap[key] = newPlay());
  const last = enterprisePlays
    .filter((c) => c.platform === $('#f-platform').value && c.unified === unified && c.cat2 === cat2).slice(-1)[0];
  const lastDesc = last ? (last.text || [last.type, last.tier].filter(Boolean).join(' ')) : '';
  const multi = p.type === '满减' || p.type === '满折' || p.type === '店铺券';
  const unit = p.type === '满折' ? '折' : p.type === '店铺券' ? '元' : '元';
  const label2 = p.type === '满减' ? '减' : p.type === '满折' ? '打' : p.type === '店铺券' ? '面额' : '';
  const label1 = p.type === '店铺券' ? '满' : '满';
  let body = '';
  if (!p.type) {
    body = '<div class="play-hint">选择玩法类型后填写具体参数</div>';
  } else if (p.type === '到手价折扣下限') {
    body = `<div class="play-row"><span class="play-lab">到手价不低于</span><input class="play-num play-floor" data-key="${esc(key)}" type="number" min="0" max="10" step="0.1" placeholder="9" value="${esc(p.floor)}"><span class="play-lab">折</span></div>`;
  } else if (p.type === '其他') {
    body = `<div class="play-row"><input class="play-text" data-key="${esc(key)}" type="text" placeholder="描述玩法，如：前1小时半价" value="${esc(p.text)}"></div>`;
  } else {
    body = (p.tiers || []).map((t, i) => `<div class="play-row">
      <span class="play-lab">${label1}</span><input class="play-num play-th" data-key="${esc(key)}" data-i="${i}" type="number" min="0" placeholder="300" value="${esc(t.th)}">
      <span class="play-lab">${label2}</span><input class="play-num play-off" data-key="${esc(key)}" data-i="${i}" type="number" min="0" step="0.1" placeholder="${p.type === '满折' ? '8.8' : '50'}" value="${esc(t.off)}"><span class="play-lab">${unit}</span>
      ${p.tiers.length > 1 ? `<button class="play-del" data-key="${esc(key)}" data-i="${i}" title="删除此档">✕</button>` : ''}
    </div>`).join('') + (multi ? `<button class="play-add" data-key="${esc(key)}">＋ 加一档</button>` : '');
  }
  const desc = playDesc(p);
  return `<div class="play-form">
    <div class="play-row">
      <select class="play-type" data-key="${esc(key)}">
        <option value="">玩法类型</option>
        ${PLAY_TYPES.map((t) => `<option ${p.type === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
    </div>
    ${body}
    <div class="play-preview">玩法：<b class="play-desc">${esc(desc) || '—'}</b></div>
    ${lastDesc ? `<div class="cost-ref">上次：${esc(lastDesc)}</div>` : ''}
  </div>`;
}

function syncPlayFromDom() {
  const box = $('#rule-hint');
  if (!box) return;
  box.querySelectorAll('.play-form').forEach((form) => {
    const key = form.querySelector('[data-key]')?.dataset.key;
    if (!key) return;
    const p = playMap[key] || (playMap[key] = newPlay());
    const type = form.querySelector('.play-type');
    if (type) p.type = type.value;
    const floor = form.querySelector('.play-floor');
    if (floor) p.floor = floor.value.trim();
    const text = form.querySelector('.play-text');
    if (text) p.text = text.value.trim();
    const ths = form.querySelectorAll('.play-th'), offs = form.querySelectorAll('.play-off');
    if (ths.length) {
      p.tiers = Array.from(ths).map((el, i) => ({ th: el.value.trim(), off: (offs[i] || {}).value ? offs[i].value.trim() : '' }));
    }
    const d = form.querySelector('.play-desc');
    if (d) d.textContent = playDesc(p) || '—';
  });
}

function bindPlayEvents() {
  $$('#rule-hint .play-form').forEach((form) => {
    form.querySelectorAll('.play-type, .play-num, .play-text').forEach((el) => {
      el.addEventListener('input', () => syncPlayFromDom());
      el.addEventListener('change', () => {
        const k = el.dataset.key;
        if (el.classList.contains('play-type') && playMap[k]) {
          /* 切换类型：重置参数并按新类型重渲染表单 */
          playMap[k] = newPlay(); playMap[k].type = el.value;
          renderRuleHints();
        } else syncPlayFromDom();
      });
    });
    const add = form.querySelector('.play-add');
    if (add) add.addEventListener('click', () => {
      const p = playMap[add.dataset.key]; p.tiers.push({ th: '', off: '' }); renderRuleHints();
    });
    form.querySelectorAll('.play-del').forEach((b) => b.addEventListener('click', () => {
      const p = playMap[b.dataset.key]; p.tiers.splice(Number(b.dataset.i), 1);
      if (!p.tiers.length) p.tiers = [{ th: '', off: '' }];
      renderRuleHints();
    }));
  });
}

function bindScopeSegs() {
  $$('#rule-hint .seg-btn').forEach((b) => b.addEventListener('click', () => {
    scopeMap[b.dataset.key] = b.dataset.scope;
    renderRuleHints();
    renderActivityChips();
    refreshStoreOnlyUi();
  }));
}

/* 全店玩法模式下置灰选品区与明细表 */
function refreshStoreOnlyUi() {
  const storeOnly = isStoreOnly();
  const pickSec = $$('.form-panel .divider, .form-panel #f-search, .form-panel .filter-grid, .form-panel .pick-toolbar, .form-panel .pick-list, .form-panel .pick-foot');
  pickSec.forEach((el) => el.classList.toggle('store-disabled', storeOnly));
  const tb = $('#apply-tbody');
  if (storeOnly) {
    $('#summary-bar').innerHTML = '';
    if (tb) tb.innerHTML = '<tr class="empty-row"><td colspan="9" style="padding:36px 12px;color:var(--txt2)">本单所选活动均为<b style="color:var(--blue)">全店玩法</b>（跨店满减 / 店铺券等），无需逐商品填价。<br>请在左侧「活动玩法」中记录具体档位即可提交。</td></tr>';
  } else {
    renderApplyTable();
  }
}

/* ---------- 费用承担（业务填写字段） ----------
 * 字典值与历史归档值仅作"参考"展示，不直接引用；
 * 填写值随审批通过后由服务端归档，供下次查询参考。
 */
function histCostList(pf, unified, cat2) {
  return enterpriseCosts.filter((c) => c.platform === pf && c.unified === unified && c.cat2 === cat2).slice(-3).reverse();
}

function renderCostForm() {
  const box = $('#cost-form');
  const rs = selectedRules();
  if (!rs.length) { box.innerHTML = ''; return; }
  const pf = $('#f-platform').value;
  box.innerHTML = `<div class="cost-title">费用承担（本次申请填写，归档后供下次参考）</div>` + rs.map((r) => {
    const key = r.unified + '|' + r.cat2;
    const last = histCostList(pf, r.unified, r.cat2)[0];
    const cur = costMap[key] || '';
    return `<div class="cost-row">
      <label>${esc(r.unified)} · ${esc(r.cat2)}</label>
      <input class="cost-input" data-key="${esc(key)}" type="text" placeholder="请填写本次费用承担方式" value="${esc(cur)}">
      ${last ? `<div class="cost-ref">上次：${esc(last.cost)}</div>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('.cost-input').forEach((inp) => inp.addEventListener('input', () => {
    costMap[inp.dataset.key] = inp.value;
  }));
}

/* 提交前从 DOM 直接读取费用承担值（自动化填值可能不触发 input 事件） */
function syncCostFromDom() {
  const box = $('#cost-form');
  if (!box) return;
  box.querySelectorAll('.cost-input').forEach((inp) => {
    if (inp.value.trim()) costMap[inp.dataset.key] = inp.value.trim();
  });
}

function renderRuleHints() {
  const rs = selectedRules();
  $('#rule-hint').innerHTML = rs.length
    ? rs.map(ruleRow).join('')
    : '<span style="color:var(--txt2)">请选择活动类型（可多选，多个活动同时开展时逐一核对规则）</span>';
  bindScopeSegs();
  bindPlayEvents();
  renderCostForm();
  const active = document.activeElement;
  const inChips = (active && $('#f-activity').contains(active)) || _focusChipKey;
  if (inChips) {
    const target = _focusChipKey ? $(`#f-activity .act-chip[data-key="${CSS.escape(_focusChipKey)}"]`) : null;
    const on = $$('#f-activity .act-chip.on');
    const chip = target || on[on.length - 1] || $('#f-activity .act-chip');
    if (chip) chip.focus();
    _focusChipKey = null;
  }
}

/* 选品筛选器（季节/定位/等级/性别，选项从数据动态收集） */
function uniqVals(key) {
  return Array.from(new Set(D.products.map((p) => p[key]).filter(Boolean))).sort();
}
/* 性别在 SKU 颜色维度上，SPU 行无 gender 字段，需展开收集 */
function uniqGenders() {
  const set = new Set();
  for (const p of D.products) {
    for (const v of (p.variants || [])) for (const c of (v.colors || [])) { const g = c.gender || v.gender; if (g && g !== '通用' && g !== '混款') set.add(g); }
  }
  return [...set].sort();
}
function renderFilters() {
  const seasons = uniqVals('season');
  const grades = uniqVals('grade');
  const fill = (id, vals, allLabel) => {
    const el = $(id);
    if (!el) return;
    if (el.options.length) return; // 只初始化一次
    el.innerHTML = `<option value="">${allLabel}</option>` + vals.map((v) => `<option>${esc(v)}</option>`).join('');
  };
  fill('#fl-season', seasons, '季节：全部');
  fill('#fl-pos', uniqVals('productPos'), '定位：全部');
  fill('#fl-grade', grades, '等级：全部');
  fill('#fl-gender', uniqGenders(), '性别：全部');
  ['#fl-season', '#fl-pos', '#fl-grade', '#fl-gender'].forEach((id) => {
    const el = $(id);
    if (el) el.onchange = renderPickList;
  });
}

function filteredProducts() {
  const k = $('#f-search').value.trim().toLowerCase();
  const season = $('#fl-season').value, pos = $('#fl-pos').value, grade = $('#fl-grade').value, gender = $('#fl-gender').value;
  const out = [];
  const seen = new Set();
  for (const p of D.products) {
    if (!(p.listPrice || p.retailPrice) || !p.spuCode) continue;
    if (seen.has(p.spuCode)) continue;
    if (season && p.season !== season) continue;
    if (pos && p.productPos !== pos) continue;
    if (grade && p.grade !== grade) continue;
    if (gender && !p.variants.some((v) => v.colors.some((c) => (c.gender || v.gender) === gender))) continue;
    if (k && !(p.name + (p.spuShort || '') + (p.styleShort || '') + p.spuCode + (p.category || '')).toLowerCase().includes(k)) continue;
    seen.add(p.spuCode);
    out.push(p);
  }
  return out;
}

function renderPickList() {
  const list = $('#pick-list');
  const filtered = filteredProducts();
  list.innerHTML = filtered.slice(0, 150).map((p) => `
    <label class="pick-item">
      <input type="checkbox" data-sid="${p.id}" ${selSpu.includes(p.id) ? 'checked' : ''}>
      <div class="pick-info">
        <div class="pick-name">${esc(p.name)}${p.spuShort ? ' <span class="cell-sub">' + esc(p.spuShort) + '</span>' : ''} <span class="tag ${p.grade || 'plain'}">${esc(p.grade || '—')}</span></div>
        <div class="pick-sub">${esc(p.spuCode)}｜${esc(p.category || '—')}｜${esc(p.productPos)}｜${esc(p.season || '—')}</div>
      </div>
      <div class="pick-price">${fmt(p.retailPrice != null ? p.retailPrice : p.listPrice)}${p.listPrice != null && p.retailPrice != null && p.listPrice !== p.retailPrice ? '<div class="cell-sub" style="text-align:right">吊牌 ' + fmt(p.listPrice) + '</div>' : ''}</div>
    </label>`).join('') || '<div class="empty-row" style="padding:24px;text-align:center;color:var(--txt2)">无匹配商品</div>';
  list.querySelectorAll('input').forEach((cb) => cb.addEventListener('change', () => {
    toggleSpu(cb.dataset.sid, cb.checked);
  }));
  updatePickCount(filtered.length);
}

function toggleSpu(sid, on) {
  if (on) {
    if (!selSpu.includes(sid)) selSpu.push(sid);
    if (!priceMap[sid]) priceMap[sid] = { spu: '', colors: {}, skus: {} };
  } else {
    selSpu = selSpu.filter((x) => x !== sid);
    delete priceMap[sid];
  }
  renderApplyTable();
  updatePickCount(filteredProducts().length);
}

function updatePickCount(shown) {
  $('#pick-count').textContent = `已选 ${selSpu.length} 个 SPU（当前筛选 ${shown} 个）`;
}

/* ---------- 数据源中间表 → 活动申请 联动刷新 ---------- */
/* datasource.js 拉取/重建中间表后调用：D.products 已被覆盖，
 * 重建筛选器、按新数据清理已选 SPU、重渲染选品列表与明细表（库存列经 stockOf 自动读中间库存表） */
window.MKT_ON_DATA = function (usedApi) {
  const ids = new Set(D.products.map((p) => p.id));
  selSpu = selSpu.filter((id) => ids.has(id));
  priceMap = Object.fromEntries(Object.entries(priceMap).filter(([k]) => ids.has(k)));
  $$('.filter-grid select').forEach((s) => { s.innerHTML = ''; }); // 清「只初始化一次」守卫，按新数据重建选项
  renderFilters();
  renderPickList();
  renderApplyTable();
  updateDsTag(usedApi);
};

/* 选品区数据来源角标 */
function updateDsTag(usedApi) {
  let tag = $('#ds-source-tag');
  const title = Array.from(document.querySelectorAll('.panel-title')).find((h) => h.textContent.includes('选择商品'));
  if (!title) return;
  if (!tag) { tag = document.createElement('small'); tag.id = 'ds-source-tag'; title.appendChild(tag); }
  const kind = D.dataSourceKind || 'demo';
  tag.textContent = ' ' + (kind === 'api' ? D.dataSourceLabel : kind === 'seed' ? '种子数据（单表处理 27 列）' : '演示数据');
  tag.style.cssText = 'font-weight:400;font-size:12px;margin-left:8px;color:' + (kind === 'api' ? 'var(--green)' : kind === 'seed' ? 'var(--blue)' : 'var(--txt2)');
}

$('#btn-sel-all').addEventListener('click', () => {
  const list = filteredProducts();
  const allOn = list.length && list.every((p) => selSpu.includes(p.id));
  list.forEach((p) => toggleSpu(p.id, !allOn));
  renderPickList();
  toast(allOn ? '已取消全选' : '已全选当前筛选的 ' + list.length + ' 个 SPU');
});

/* ---------- 三级明细表 ---------- */
/* 级联下发：SPU 填价 → 填充该 SPU 全部颜色/SKU；颜色填价 → 填充该颜色全部尺码 */
function cascade(sid, fromLvl, fromKey) {
  const s = priceMap[sid];
  if (!s) return;
  const p = D.products.find((x) => x.id === sid);
  if (!p) return;
  if (fromLvl === 'spu' && s.spu !== '' && s.spu != null) {
    skusOf(p).forEach((sk) => { s.colors[sk.colorKey] = s.spu; s.skus[sk.code] = s.spu; });
  } else if (fromLvl === 'color' && fromKey && s.colors[fromKey] !== '' && s.colors[fromKey] != null) {
    skusOf(p).filter((sk) => sk.colorKey === fromKey).forEach((sk) => { s.skus[sk.code] = s.colors[fromKey]; });
  }
}

function effPrice(sid, colorKey, skuCode) {
  const s = priceMap[sid] || {};
  const v = (s.skus && s.skus[skuCode] !== '' && s.skus[skuCode] != null) ? s.skus[skuCode]
    : (s.colors && s.colors[colorKey] !== '' && s.colors[colorKey] != null) ? s.colors[colorKey]
    : (s.spu !== '' && s.spu != null ? s.spu : null);
  return v == null || isNaN(Number(v)) ? null : Number(v);
}

function checkCell(p, val) {
  if (val == null) return '<span class="cell-sub">未填</span>';
  const ref = calcRef(p);
  const low = histLow(p.spuCode);
  if (ref.suggestMin != null && val < ref.suggestMin) return '<span class="check-bad">✕ 低于控价</span>';
  const ceiling = Math.max(p.listPrice || 0, p.retailPrice || 0);
  if (ceiling && val > ceiling) return '<span class="check-bad">✕ 高于原价</span>';
  if (low != null && val < low) return '<span class="check-warn">⚠ 破历史低价</span>';
  return '<span class="check-ok">✓ 正常</span>';
}
function discOf(list, val) { return val != null && list ? (val / list * 10).toFixed(1) + '折' : '—'; }

/* 明细表列（与《单表处理》字段一致）；表头运行时渲染，防 index.html 回退 */
const APPLY_COLS = ['SPU / 颜色 / SKU', '吊牌价', '零售价', '建议最低价', '历史最低价', '库存', '申请价', '折扣', '校验'];

function renderApplyTable() {
  const tb = $('#apply-tbody');
  const thead = $('#apply-table thead tr');
  if (thead && thead.children.length !== APPLY_COLS.length) {
    thead.innerHTML = APPLY_COLS.map((c) => `<th>${c}</th>`).join('');
  }
  if (!selSpu.length) {
    tb.innerHTML = '<tr class="empty-row"><td colspan="9">从左侧筛选并勾选 SPU 后，此处按 SPU → 颜色 → SKU 三级展开填价</td></tr>';
    $('#summary-bar').innerHTML = '';
    return;
  }
  const html = [];
  for (const sid of selSpu) {
    const p = D.products.find((x) => x.id === sid);
    if (!p) continue;
    const ref = calcRef(p);
    const low = histLow(p.spuCode);
    const skus = skusOf(p);
    const spuStock = stockSum(skus.map((s) => s.code));
    const spuEff = priceMap[sid].spu === '' ? null : Number(priceMap[sid].spu);
    const openS = expandedSpu.has(sid);
    // SPU 行
    html.push(`<tr class="tree-spu">
      <td><button class="exp" data-sid="${sid}">${openS ? '▾' : '▸'}</button>
        <div class="cell-name" style="display:inline-block;vertical-align:top">${esc(p.name)}</div>
        <div class="cell-sub">${esc(p.spuCode)}｜<span class="tag ${p.grade}">${esc(p.grade)}</span>｜${skus.length} SKU</div></td>
      <td>${fmt(p.listPrice)}</td>
      <td>${fmt(p.retailPrice)}</td>
      <td><a class="trace" data-tr="suggest" data-sid="${sid}">${fmt(ref.suggestMin)}</a><div class="cell-sub">点击查看计算过程</div></td>
      <td>${low != null ? '<a class="trace" data-tr="hist" data-sid="' + sid + '">' + fmt(low) + '</a><div class="cell-sub">点击查看来源</div>' : '<span class="cell-sub">无记录</span>'}</td>
      <td>${spuStock != null ? '<b>' + spuStock.toLocaleString() + '</b><div class="cell-sub">SKU 合计</div>' : ''}</td>
      <td><input class="price-input" data-lvl="spu" data-sid="${sid}" type="number" placeholder="SPU 统一价" value="${priceMap[sid].spu}"></td>
      <td>${discOf(ref.base, spuEff)}</td>
      <td>${checkCell(p, spuEff)}</td>
    </tr>`);
    if (!openS) continue;
    // 颜色行
    for (const v of p.variants) {
      for (const c of v.colors) {
        const cKey = v.code + '|' + c.name;
        const cOpen = expandedColor.has(sid + '|' + cKey);
        const cSkus = skus.filter((s) => s.colorKey === cKey);
        const cStock = stockSum(cSkus.map((s) => s.code));
        const cVal = priceMap[sid].colors[cKey] === '' || priceMap[sid].colors[cKey] == null ? null : Number(priceMap[sid].colors[cKey]);
        const eff = cVal != null ? cVal : spuEff;
        html.push(`<tr class="tree-color">
          <td><button class="exp sm" data-sid="${sid}" data-ck="${esc(cKey)}">${cOpen ? '▾' : '▸'}</button>
            <span class="lv-tag">颜色</span>${esc(c.name)} <span class="cell-sub">${esc(c.gender || v.gender)}款</span></td>
          <td>${fmt(p.listPrice)}</td>
          <td>${fmt(p.retailPrice)}</td>
          <td class="cell-sub">同 SPU</td>
          <td class="cell-sub">同 SPU</td>
          <td>${cStock != null ? '<b>' + cStock.toLocaleString() + '</b><div class="cell-sub">' + cSkus.length + ' 尺码合计</div>' : ''}</td>
          <td><input class="price-input" data-lvl="color" data-sid="${sid}" data-ck="${esc(cKey)}" type="number" placeholder="${spuEff != null ? '继承 ' + spuEff : '颜色统一价'}" value="${priceMap[sid].colors[cKey] ?? ''}"></td>
          <td>${discOf(ref.base, eff)}</td>
          <td>${checkCell(p, eff)}</td>
        </tr>`);
        if (!cOpen) continue;
        // SKU 行
        for (const s of c.sizes) {
          const sv = priceMap[sid].skus[s.code] === '' || priceMap[sid].skus[s.code] == null ? null : Number(priceMap[sid].skus[s.code]);
          const seff = effPrice(sid, cKey, s.code);
          html.push(`<tr class="tree-sku">
            <td><span class="lv-tag sku">SKU</span>${esc(s.code)}</td>
            <td>${fmt(p.listPrice)}</td>
            <td>${fmt(p.retailPrice)}</td>
            <td class="cell-sub">—</td>
            <td class="cell-sub">—</td>
            <td>${(() => { const sv2 = stockOf(s.code); return sv2 != null ? sv2.toLocaleString() + '<div class="cell-sub">实际库存数</div>' : ''; })()}</td>
            <td><input class="price-input" data-lvl="sku" data-sid="${sid}" data-ck="${esc(cKey)}" data-sc="${esc(s.code)}" type="number" placeholder="${eff != null ? '继承 ' + eff : '填价'}" value="${priceMap[sid].skus[s.code] ?? ''}"></td>
            <td>${discOf(ref.base, seff)}</td>
            <td>${checkCell(p, seff)}</td>
          </tr>`);
        }
      }
    }
  }
  tb.innerHTML = html.join('');

  // 展开/收起
  tb.querySelectorAll('button.exp').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();
    if (b.dataset.ck) {
      const k = b.dataset.sid + '|' + b.dataset.ck;
      if (expandedColor.has(k)) expandedColor.delete(k); else expandedColor.add(k);
    } else {
      const sid = b.dataset.sid;
      if (expandedSpu.has(sid)) expandedSpu.delete(sid); else expandedSpu.add(sid);
    }
    renderApplyTable();
  }));
  // 价格输入：input 仅存值（避免整表重渲染导致失焦），blur 时从 DOM 同步+级联下发
  tb.querySelectorAll('.price-input').forEach((inp) => {
    const sync = () => {
      const s = priceMap[inp.dataset.sid];
      const v = inp.value === '' ? '' : Number(inp.value);
      if (inp.dataset.lvl === 'spu') s.spu = v;
      else if (inp.dataset.lvl === 'color') s.colors[inp.dataset.ck] = v;
      else s.skus[inp.dataset.sc] = v;
    };
    inp.addEventListener('input', sync);
    inp.addEventListener('blur', () => { sync(); cascade(inp.dataset.sid, inp.dataset.lvl, inp.dataset.ck); renderApplyTable(); });
  });
  // 溯源
  tb.querySelectorAll('.trace').forEach((a) => a.addEventListener('click', () => {
    const p = D.products.find((x) => x.id === a.dataset.sid);
    a.dataset.tr === 'suggest' ? traceSuggest(p) : traceHist(p);
  }));
  renderSummary();
}

/* 溯源弹窗：建议最低价计算过程 */
function traceSuggest(p) {
  const ref = calcRef(p);
  const isNew = D.dataSourceKind !== 'demo';
  openModal(`
    <h3>建议最低价 · 计算过程</h3>
    <p style="color:var(--txt)">${esc(p.name)}（${esc(p.spuCode)}）</p>
    <div class="oa-preview">
      ${isNew ? `① 数据来源：《单表处理》商品表行内字段（等级规则已内嵌每行）<br>
      商品定位 <b>${esc(p.productPos)}</b> · 等级 <b>${esc(p.grade || '—')}</b> · 过季指数 <b>${p.offSeasonIdx ?? '—'}</b> · 款年实销额 <b>${p.annualSales != null ? p.annualSales.toLocaleString() : '—'}</b>（门槛 ${p.salesMin != null ? p.salesMin.toLocaleString() : '—'} ~ ${p.salesMax != null ? p.salesMax.toLocaleString() : '—'}）<br>
      ② 最低折扣 <b>${ref.minD != null ? ref.minD + ' 折' : '无下限'}</b>${ref.minD != null && ref.base ? ` × 零售价 ${fmt(ref.base)} = <b>${fmt(Math.round(ref.base * ref.minD / 10 * 100) / 100)}</b>` : ''}<br>
      ③ ${p.redlinePrice != null ? `页面红线价 <b>${fmt(p.redlinePrice)}</b>${ref.redlineApplied ? '（高于规则价，以人工红线价为准·地板）' : '（不高于规则价，取规则价）'}` : '无页面红线价'}<br>`
      : `① 匹配等级规则：商品类型 <b>${esc(p.productPos)}</b> × 过季指数 <b>${p.offSeasonIdx ?? '—'}</b> × 年实销额 <b>${p.annualSales != null ? p.annualSales.toLocaleString() : '—'}</b><br>
      ${ref.rule ? `→ 命中规则：等级 <b>${ref.rule.grade}</b>（门槛 ${ref.rule.salesMin.toLocaleString()} ~ ${ref.rule.salesMax.toLocaleString()}）<br>` : '→ 未命中规则，使用营销价计算表既有折扣<br>'}
      ② 最低折扣 <b>${ref.minD != null ? ref.minD + ' 折' : '无下限'}</b>${ref.minD != null && p.listPrice ? ` × 原价 ${fmt(p.listPrice)} = <b>${fmt(Math.round(p.listPrice * ref.minD / 10))}</b>` : ''}<br>
      ③ ${p.redlinePrice != null ? `页面红线价 <b>${fmt(p.redlinePrice)}</b>${ref.redlineApplied ? '（高于规则价，以人工红线价为准·地板）' : '（不高于规则价，取规则价）'}` : '无页面红线价'}<br>`}
      ⇒ 建议最低价：<b style="color:var(--blue)">${fmt(ref.suggestMin)}</b>
      ${p.remark ? '<br>备注：' + esc(p.remark) : ''}
    </div>
    <div class="modal-actions"><button class="btn primary" onclick="closeModal()">知道了</button></div>`);
}

/* 溯源弹窗：历史最低价来源 */
function traceHist(p) {
  const hs = historyOf(p.spuCode).sort((a, b) => a.price - b.price);
  openModal(`
    <h3>历史最低价 · 来源记录</h3>
    <p style="color:var(--txt)">${esc(p.name)}（${esc(p.spuCode)}）· 共 ${hs.length} 条</p>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>平台</th><th>店铺</th><th>活动类型</th><th>活动</th><th>价格</th><th>时间</th><th>提交人</th><th>来源</th></tr></thead>
      <tbody>${hs.map((h, i) => `<tr>
        <td>${esc(h.platform)}</td><td>${esc(h.store)}</td><td>${esc(h.activityType)}</td><td>${esc(h.activityName)}</td>
        <td><b style="color:${i === 0 ? 'var(--red)' : 'inherit'}">${fmt(h.price)}</b></td>
        <td class="cell-sub">${esc(h.startDate)}</td>
        <td>${esc(h.applicant || '—')}</td><td>${esc(h.sourceLabel || (h.archived ? '审批归档（真实）' : '演示数据'))}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="modal-actions"><button class="btn primary" onclick="closeModal()">关闭</button></div>`);
}

function renderSummary() {
  let total = 0, filled = 0, bad = 0;
  for (const sid of selSpu) {
    const p = D.products.find((x) => x.id === sid);
    const ref = calcRef(p);
    for (const sk of skusOf(p)) {
      total++;
      const v = effPrice(sid, sk.colorKey, sk.code);
      if (v != null) {
        filled++;
        if (ref.suggestMin != null && v < ref.suggestMin) bad++;
      }
    }
  }
  $('#summary-bar').innerHTML = total ? `
    <span>SPU <b>${selSpu.length}</b></span>
    <span>SKU 总数 <b>${total}</b></span>
    <span>已填价 <b>${filled}</b></span>
    <span>低于控价 <b style="color:${bad ? 'var(--red)' : 'var(--green)'}">${bad}</b></span>
    <span>已选活动 <b>${selActivities.size}</b> 个</span>` : '';
}

/* 提交审批 */
function syncAllFromDom() {
  $$('#apply-tbody .price-input').forEach((inp) => {
    const s = priceMap[inp.dataset.sid];
    if (!s) return;
    const v = inp.value === '' ? '' : Number(inp.value);
    if (inp.dataset.lvl === 'spu') s.spu = v;
    else if (inp.dataset.lvl === 'color') s.colors[inp.dataset.ck] = v;
    else s.skus[inp.dataset.sc] = v;
  });
}

$('#btn-submit').addEventListener('click', async () => {
  const currentUser = await resolveCurrentUser();
  if (!currentUser || !currentUser.userId) { toast('请先点击右上角「立即登录」完成钉钉身份验证'); return; }
  syncAllFromDom();
  syncCostFromDom();
  syncPlayFromDom();
  syncStandardMetaFromDom();
  const rules = selectedRules();
  if (!rules.length) return toast('请至少选择一个活动类型');

  /* 参与方式分流：全店玩法活动记录一条玩法即可，不逐商品填价 */
  const skuRules = rules.filter((r) => scopeOf(r) === 'sku');
  const storeRules = rules.filter((r) => scopeOf(r) === 'store');

  const missingPlay = storeRules.filter((r) => !playComplete(playMap[keyOf(r)] || newPlay()));
  if (missingPlay.length) {
    toast('请填写活动玩法参数：' + missingPlay.map((r) => r.unified + '·' + r.cat2).join('、'));
    const el = $('#rule-hint .play-type');
    if (el) el.focus();
    return;
  }

  const items = [];
  const unfilled = [];
  if (skuRules.length) {
    if (!selSpu.length) return toast('存在按商品填价的活动，请先勾选商品');
    for (const sid of selSpu) {
      const p = D.products.find((x) => x.id === sid);
      const ref = calcRef(p);
      const low = histLow(p.spuCode);
      for (const sk of skusOf(p)) {
        const v = effPrice(sid, sk.colorKey, sk.code);
        if (v == null) { unfilled.push(sk.code); continue; }
        items.push({
          spuCode: p.spuCode, skuCode: sk.code, name: p.name, spuShort: p.spuShort || '', category: p.category || '',
          season: p.season || '', color: sk.color, size: sk.size, gender: sk.gender,
          listPrice: p.listPrice, retailPrice: p.retailPrice, suggestMin: ref.suggestMin, histLow: low,
          price: v, stock: stockOf(sk.code), grade: p.grade,
          compliance: ref.suggestMin != null && v < ref.suggestMin ? '不符合控价' : '符合控价',
          level: (priceMap[sid].skus[sk.code] !== '' && priceMap[sid].skus[sk.code] != null) ? 'SKU'
            : (priceMap[sid].colors[sk.colorKey] !== '' && priceMap[sid].colors[sk.colorKey] != null) ? '颜色' : 'SPU',
        });
      }
    }
    if (unfilled.length) return toast(`还有 ${unfilled.length} 个 SKU 未填价（可在 SPU/颜色层级统一填价）`);
  }
  const violations = items.filter((it) => it.suggestMin != null && it.price < it.suggestMin).length;
  const pf = $('#f-platform').value;
  /* 每一笔营销活动都必须形成真实钉钉审批；控价结论仅供审批决策，不改变提交路径。 */
  const needOA = true;
  const actLabel = rules.map((r) => r.unified + '·' + r.cat2).join('、');

  /* 费用承担：业务必填，未填写则阻止提交 */
  const missingCost = rules.filter((r) => !(costMap[keyOf(r)] || '').trim());
  if (missingCost.length) {
    toast('请填写费用承担：' + missingCost.map((r) => r.unified + '·' + r.cat2).join('、'));
    const box = $('#cost-form');
    if (box) {
      box.querySelectorAll('.cost-input').forEach((inp) => {
        inp.classList.toggle('cost-missing', !(inp.value.trim()));
      });
      const first = box.querySelector('.cost-missing');
      if (first) first.focus();
    }
    return;
  }

  const requestId = 'REQ' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + uid();
  const app = {
    id: requestId,
    applicant: currentUser.name || '当前登录人', dept: currentUser.dept || '',
    platform: pf, store: $('#f-store').value,
    activities: rules.map((r) => {
      const pfInfo = platformRuleInfo(r, pf);
      const sc = scopeOf(r);
      const pl = playMap[keyOf(r)] || newPlay();
      return {
        unified: r.unified, cat2: r.cat2, name: pfInfo.name || r.cat2,
        cost: costMap[keyOf(r)] || '',
        scope: sc,
        play: sc === 'store' ? { type: pl.type || '', text: playDesc(pl) || '', params: JSON.parse(JSON.stringify(pl)) } : null,
      };
    }),
    activityType: rules[0].unified, activityCat: rules.map((r) => r.cat2).join('、'),
    activityName: actLabel,
    parentApplicationId: resubmitParentId,
    start: $('#f-start').value, end: $('#f-end').value,
    status: '审批中', oaNo: null,
    createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    items, violations,
    standardMeta: { manzeng: standardMeta.manzeng, remark: standardMeta.remark },
  };
  app.activityId = standardActivityId(app);
  app.standardRows = buildStandardRowsForApp(app);
  openOaPreview(app, true);
});

$('#btn-clear').addEventListener('click', () => {
  selSpu = []; priceMap = {}; expandedSpu.clear(); expandedColor.clear(); costMap = {}; standardMeta = { manzeng: '', remark: '' }; resubmitParentId = null;
  const manzeng = $('#f-manzeng'); const remark = $('#f-standard-remark');
  if (manzeng) manzeng.value = ''; if (remark) remark.value = '';
  renderPickList(); renderApplyTable(); renderCostForm();
});

function toggleExpandAll() {
  const allOpen = selSpu.length > 0 && selSpu.every((sid) => expandedSpu.has(sid));
  if (allOpen) { expandedSpu.clear(); expandedColor.clear(); $('#btn-expand').textContent = '展开全部'; }
  else {
    selSpu.forEach((sid) => {
      expandedSpu.add(sid);
      const p = D.products.find((x) => x.id === sid);
      if (p) p.variants.forEach((v) => v.colors.forEach((c) => expandedColor.add(sid + '|' + v.code + '|' + c.name)));
    });
    $('#btn-expand').textContent = '收起全部';
  }
  renderApplyTable();
}

function showSubmitModal(app, needOA, oaRes) {
  const storeActs = app.activities.filter((a) => a.scope === 'store');
  const skuActs = app.activities.filter((a) => a.scope !== 'store');
  openModal(`
    <h3>已推送钉钉审批 ✓</h3>
    <p>申请单 <b>${app.id}</b>${skuActs.length ? ' 共 ' + app.items.length + ' 个 SKU' : ''}${storeActs.length ? (skuActs.length ? '，' : ' 共 ') + storeActs.length + ' 个全店玩法活动' : ''}${app.violations ? '，其中 ' + app.violations + ' 个低于控价' : ''}。</p>
    <div class="oa-preview">
      <b>钉钉审批单（已真实发起）</b><br>
      钉钉单号：<b>${esc(app.oaNo || '—')}</b><br>
      发起人：${app.applicant}<br>
      平台：${app.platform} · ${esc(app.store)}<br>
      活动（${app.activities.length} 个）：${esc(app.activityName)}<br>
      ${app.oaAttach ? '附件：<b>' + esc(app.oaAttach.fileName || '') + '</b>（已上传审批钉盘）<br>' : ''}
      ${app.oaTableUrl ? '在线协作明细表：<a href="' + esc(app.oaTableUrl) + '" target="_blank">' + esc(app.oaTableUrl) + '</a>' + (app.oaCommentOk ? '（已附评论）' : (app.oaTableErr ? '（' + esc(app.oaTableErr) + '）' : '')) + '<br>' : ''}
      ${storeActs.length ? '全店玩法：' + storeActs.map((a) => esc(a.cat2) + '：' + esc(a.play.type) + ' ' + esc(a.play.tier) + (a.play.floor ? '（到手价' + esc(a.play.floor) + '）' : '')).join('；') + '<br>' : ''}
      费用承担：${app.activities.map((a) => esc(a.cat2) + '：' + esc(a.cost || '—')).join('；')}<br>
      时间：${app.start || '—'} ~ ${app.end || '—'}<br>
      ${app.violations ? '<span style="color:var(--red)">⚠ 含低于控价申请，需主管审批</span>' : '全部价格在控价范围内'}
    </div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal()">留在本页</button>
      <button class="btn primary" onclick="closeModal();switchTab('approval')">查看审批跟踪</button>
    </div>`);
}

/* ================= 真实钉钉 OA 提交（选品→生成Excel附件→上传→预览确认→发起→回写） ================= */
let OA_SCHEMA = null;
async function oaEnsureSchema() {
  if (OA_SCHEMA) return OA_SCHEMA;
  try {
    const r = await fetch('/api/ding/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    if (j && j.success && j.data && j.data.result && j.data.result.schemaContent) OA_SCHEMA = j.data.result.schemaContent.items || [];
  } catch (e) { /* 由提交入口提示错误，绝不转为模拟审批。 */ }
  return OA_SCHEMA;
}
const oaFindCtl = (items, test) => (items || []).find((it) => test(it.componentName, String((it.props || {}).label || '')));
function oaCompose(app) {
  const 事项 = [app.platform, app.activityName, app.store].filter(Boolean).join(' · ');
  const lines = ['活动：' + (app.activityName || '—') + '｜店铺：' + (app.store || '—')];
  (app.activities || []).forEach((a) => {
    let s = '· ' + a.cat2 + '：费用承担 ' + (a.cost || '—');
    if (a.scope === 'store' && a.play) s += '｜玩法 ' + (a.play.type || '') + ' ' + (a.play.text || '');
    lines.push(s);
  });
  lines.push('商品明细：' + (app.items ? app.items.length : 0) + ' 个 SKU（详见附件 Excel）');
  if (app.violations) lines.push('⚠ 含 ' + app.violations + ' 项低于控价，需主管审批');
  return { 事项, 方案: lines.join('\n'), 备注: '申请单 ' + app.id + ' · ' + (app.applicant || '') + ' · 营销系统自动提交' };
}
/* 审批附件和在线表统一采用这份 SKU 级标准活动明细。上传路径保留其
 * 已解析出的标准行；手工路径按已确认的字段映射即时生成相同行结构。 */
const STANDARD_ACTIVITY_COLUMNS = ['活动ID', '活动名称', '平台', '店铺', '开始', '结束', '活动类型', '产品名称', '商品时期', '货号', '颜色', '尺码', 'SKU编码', '库存(SKU)', '原价', '日常价', '活动价', '折扣率', '到手价', '优惠金额', '日常价差额', '赠品标记', '满赠规则', '购物金规则', '备注', '数据来源'];

function standardNumber(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function standardActivityId(app) {
  if (app && app.activityId) return String(app.activityId);
  const date = String((app && app.start) || '').replace(/\D/g, '').slice(0, 8);
  const requestCode = String((app && app.id) || '').replace(/^REQ(?:\d{8})?-?/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return date ? ('ACT' + date + (requestCode ? '-' + requestCode : '')) : '';
}
function standardizeRow(row) {
  const clean = {};
  STANDARD_ACTIVITY_COLUMNS.forEach((column) => { clean[column] = row && row[column] != null ? row[column] : ''; });
  return clean;
}
function buildStandardRowsForApp(app) {
  if (Array.isArray(app && app.standardRows) && app.standardRows.length) return app.standardRows.map(standardizeRow);
  const activityTypes = app.activityCat || app.activityType || app.activityName || '';
  const shoppingRules = (app.activities || []).filter((activity) => activity && activity.cost)
    .map((activity) => (activity.cat2 ? activity.cat2 + '：' : '') + activity.cost).join('；');
  const meta = (app && app.standardMeta) || {};
  return (app && app.items || []).map((item) => {
    /* 映射规则：原价、日常价均取产品底表零售价；手工申请价就是活动价，
     * 未另填到手价时，以活动价作为到手价。 */
    const original = standardNumber(item.retailPrice != null ? item.retailPrice : item.listPrice);
    const activityPrice = standardNumber(item.price);
    const finalPrice = activityPrice;
    return standardizeRow({
      活动ID: standardActivityId(app), 活动名称: app.activityName || '', 平台: app.platform || '', 店铺: app.store || '',
      开始: app.start || '', 结束: app.end || '', 活动类型: activityTypes,
      产品名称: item.name || '', 商品时期: item.season || '', 货号: item.spuCode || '',
      颜色: item.color || '', 尺码: item.size || '', SKU编码: item.skuCode || '', '库存(SKU)': item.stock == null ? '' : item.stock,
      原价: original == null ? '' : original, 日常价: original == null ? '' : original, 活动价: activityPrice == null ? '' : activityPrice,
      折扣率: original && finalPrice != null ? Math.round(finalPrice / original * 100) / 100 : '',
      到手价: finalPrice == null ? '' : finalPrice,
      优惠金额: original != null && finalPrice != null ? original - finalPrice : '',
      日常价差额: original != null && finalPrice != null ? original - finalPrice : '',
      赠品标记: '否', 满赠规则: meta.manzeng || '', 购物金规则: shoppingRules,
      备注: meta.remark || '', 数据来源: '手工填报',
    });
  });
}
function oaItemsAoa(app) {
  const rows = buildStandardRowsForApp(app);
  return [STANDARD_ACTIVITY_COLUMNS, ...rows.map((row) => STANDARD_ACTIVITY_COLUMNS.map((column) => row[column]))];
}
function oaSpuSummaryAoa(app) {
  const head = ['店铺', '款号', '品名', 'SKU数', '吊牌价', '零售价', '建议最低价', '历史最低价', '申请价', '控价结论'];
  const bySpu = new Map();
  const distinct = (items, key) => [...new Set(items.map((it) => it[key]).filter((value) => value !== '' && value != null))];
  const display = (values) => values.length <= 1 ? (values[0] == null ? '' : values[0]) : values.join(' / ');
  (app.items || []).forEach((item) => {
    const store = item.store || app.store || '';
    const key = store + '\u0000' + (item.spuCode || item.name || '未识别SPU');
    if (!bySpu.has(key)) bySpu.set(key, []);
    bySpu.get(key).push(item);
  });
  const rows = [...bySpu.entries()].map(([key, items]) => {
    const [store, spuCode] = key.split('\u0000');
    const compliance = distinct(items, 'compliance');
    const conclusion = compliance.includes('不符合控价')
      ? (compliance.length > 1 ? '部分不符合控价' : '不符合控价')
      : (compliance[0] || '符合控价');
    return [
      store,
      spuCode,
      display(distinct(items, 'name')),
      items.length,
      display(distinct(items, 'listPrice')),
      display(distinct(items, 'retailPrice')),
      display(distinct(items, 'suggestMin')),
      display(distinct(items, 'histLow')),
      display(distinct(items, 'price')),
      conclusion,
    ];
  });
  return [head, ...rows];
}
function oaGenXlsx(app) {
  const summary = oaSpuSummaryAoa(app);
  const detail = oaItemsAoa(app);
  const summaryWs = XLSX.utils.aoa_to_sheet(summary);
  const detailWs = XLSX.utils.aoa_to_sheet(detail);
  summaryWs['!cols'] = summary[0].map(() => ({ wch: 14 }));
  detailWs['!cols'] = detail[0].map(() => ({ wch: 12 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, summaryWs, 'SPU汇总');
  XLSX.utils.book_append_sheet(wb, detailWs, 'SKU明细');
  return { base64: XLSX.write(wb, { bookType: 'xlsx', type: 'base64' }), fileName: '活动申请商品明细_' + app.id + '.xlsx', fileType: 'xlsx' };
}
function oaTableFailureMessage(action, status, detail) {
  const message = String(detail || '');
  if (Number(status) === 403 || /forbidden\.accessDenied|accessDenied/i.test(message)) {
    return '无法' + action + '在线协作表：钉钉拒绝访问。当前钉钉账号没有目标知识库文件夹的编辑权限，或应用未获文档创建/写入权限。请联系管理员授权后重试。';
  }
  return '无法' + action + '在线协作表' + (status ? '（HTTP ' + status + '）' : '') + (message ? '：' + message : '');
}
async function createOaTable(app) {
  const nr = await fetch('/api/ding/newdoc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '活动申请明细_' + app.id }) });
  const nj = await nr.json();
  if (!nj || !nj.success) {
    const detail = (nj && nj.data && (nj.data.message || nj.data.code)) || (nj && nj.msg) || '未配置归档知识库';
    throw new Error(oaTableFailureMessage('创建', nj && (nj.httpStatus || nj.status), detail));
  }
  const dentryUuid = nj.workbookId || (nj.data && (nj.data.dentryUuid || nj.data.nodeId)) || nj.nodeId || '';
  if (!dentryUuid) throw new Error(oaTableFailureMessage('创建', 0, '未返回表格标识'));
  const url = nj.url || ('https://alidocs.dingtalk.com/i/nodes/' + dentryUuid);
  let fj = null;
  try {
    const fr = await fetch('/api/ding/docfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      workbookId: dentryUuid,
      sheets: [
        { values: oaSpuSummaryAoa(app) },
        { name: 'SKU明细', values: oaItemsAoa(app) },
      ],
    }) });
    fj = await fr.json();
  } catch (e) { throw new Error(oaTableFailureMessage('写入', 0, e.message)); }
  if (!fj || !fj.ok) {
    const detail = fj && ((fj.error && (fj.error.message || fj.error.code)) || fj.msg);
    throw new Error(oaTableFailureMessage('写入', fj && fj.status, detail));
  }
  return { url, dentryUuid, fillOk: true };
}
async function oaSubmit(app, v, attachOn, linkMode) {
  linkMode = linkMode || 'comment';
  const currentUser = await resolveCurrentUser();
  if (!currentUser || !currentUser.userId) throw new Error('请先完成钉钉登录，再提交审批');
  app.applicant = currentUser.name || '当前登录人';
  if (currentUser.dept != null) app.dept = currentUser.dept;
  const items = OA_SCHEMA;
  const ctl = {
    事项: oaFindCtl(items, (c, l) => c === 'TextField' && l.indexOf('申请事项') >= 0),
    方案: oaFindCtl(items, (c, l) => l.indexOf('申请方案') >= 0),
    日期: oaFindCtl(items, (c) => c === 'DDDateRangeField'),
    附件: attachOn ? oaFindCtl(items, (c) => c === 'DDAttachment') : null,
    备注: oaFindCtl(items, (c, l) => c === 'TextField' && l.indexOf('备注') >= 0),
  };
  let attachMeta = null, attVal = null;
  if (ctl.附件) {
    const x = oaGenXlsx(app);
    const up = await fetch('/api/ding/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileName: x.fileName, fileType: x.fileType, base64: x.base64 }) });
    const uj = await up.json();
    if (!uj || !uj.ok) throw new Error('附件上传失败' + (uj && uj.stage ? '（' + uj.stage + '）' : ''));
    attachMeta = { fileName: uj.fileName, fileId: uj.fileId, spaceId: uj.spaceId }; attVal = uj.value;
  }
  let table = null, tableErr = '';
  if (linkMode !== 'none' && (app.items || []).length) table = await createOaTable(app);
  let 备注Val = v.备注;
  if (linkMode === 'remark' && table) 备注Val = (备注Val || '') + '\n在线协作明细表：' + table.url;
  const mk = (c, val) => c ? { componentType: c.componentName, id: (c.props || {}).id, name: String((c.props || {}).label || ''), value: val } : null;
  const fcv = [mk(ctl.事项, v.事项), mk(ctl.方案, v.方案), mk(ctl.日期, JSON.stringify([v.start, v.end])), ctl.附件 ? mk(ctl.附件, attVal) : null, mk(ctl.备注, 备注Val)].filter(Boolean);
  const cr = await fetch('/api/ding/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: app.id, formComponentValues: fcv }) });
  const cj = await cr.json();
  if (!cj || !cj.success) throw new Error((cj && ((cj.data && (cj.data.message || cj.data.code)) || cj.msg)) || '发起审批失败');
  let commentOk = false;
  if (linkMode === 'comment' && table) {
    try { const qr = await fetch('/api/ding/comment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ processInstanceId: cj.instanceId, text: '本次选品在线协作明细表：' + table.url }) }); const qj = await qr.json(); commentOk = !!(qj && qj.success); } catch (e) {}
  }
  return { instanceId: cj.instanceId, attach: attachMeta, tableUrl: table && table.url, tableFillOk: table && table.fillOk, commentOk, tableErr };
}
function openOaPreview(app, needOA) {
  oaEnsureSchema().then((items) => {
    if (!items || !items.length) { toast('未取到 OA 表单结构（processCode、凭证或登录状态异常）；未创建申请单，请修复后重试'); return; }
    const c = oaCompose(app);
    const attCount = (app.items || []).length;
    openModal(`
      <h3>提交审批预览 <span class="cell-sub" style="font-weight:400">核对/修订后推送钉钉</span></h3>
      <div class="oa-form">
        <div class="field"><label>申请事项</label><input id="oa-f-事项" type="text" value="${esc(c.事项)}"></div>
        <div class="field"><label>申请方案</label><textarea id="oa-f-方案" rows="7">${esc(c.方案)}</textarea></div>
        <div class="ds-cfg-grid" style="margin:8px 0">
          <div class="field"><label>开始时间</label><input id="oa-f-start" type="date" value="${esc(app.start || '')}"></div>
          <div class="field"><label>结束时间</label><input id="oa-f-end" type="date" value="${esc(app.end || '')}"></div>
        </div>
        <div class="field"><label><input id="oa-f-att" type="checkbox" ${attCount ? 'checked' : 'disabled'}> 附商品明细 Excel（${attCount} 个 SKU，提交时自动生成并上传）</label></div>
        <div class="field"><label>备注</label><input id="oa-f-备注" type="text" value="${esc(c.备注)}"></div>
      </div>
      <div id="oa-submit-err" class="ds-warn" style="display:none"></div>
      <div class="modal-actions">
        <button class="btn ghost" id="oa-cancel">取消（留在编辑）</button>
        <button class="btn primary" id="oa-confirm">确认并推送钉钉</button>
      </div>`);
    const showErr = (m) => { const e = $('#oa-submit-err'); if (e) { e.textContent = m; e.style.display = ''; } else toast(m); };
    $('#oa-cancel') && $('#oa-cancel').addEventListener('click', () => closeModal());
    const btn = $('#oa-confirm');
    let pendingOaResult = null;
    btn && btn.addEventListener('click', async () => {
      const v = { 事项: $('#oa-f-事项').value.trim(), 方案: $('#oa-f-方案').value, start: $('#oa-f-start').value, end: $('#oa-f-end').value, 备注: $('#oa-f-备注').value.trim() };
      if (!v.事项) return showErr('申请事项不能为空');
      if (!v.start || !v.end) return showErr('开始/结束时间必填');
      const attachOn = $('#oa-f-att') && $('#oa-f-att').checked;
      const old = btn.textContent; btn.disabled = true; btn.textContent = '正在上传附件并推送…';
      const ebox = $('#oa-submit-err'); if (ebox) ebox.style.display = 'none';
      try {
        pendingOaResult = pendingOaResult || await oaSubmit(app, v, attachOn);
        await finishSubmit(app, true, pendingOaResult);
        pendingOaResult = null;
      } catch (err) {
        btn.disabled = false; btn.textContent = pendingOaResult ? '重试保存企业记录' : old;
        showErr((pendingOaResult ? '钉钉审批已创建，但企业记录保存失败：' : '推送失败：') + (err && err.message || err));
      }
    });
  });
}
async function finishSubmit(app, needOA, oaRes) {
  if (!needOA || !oaRes || !oaRes.instanceId) throw new Error('未获得真实钉钉审批实例，申请记录未保存');
  app.status = '审批中'; app.oaNo = oaRes.instanceId; app.oaReal = true;
  if (oaRes.attach) app.oaAttach = oaRes.attach;
  app.oaTableUrl = oaRes.tableUrl || ''; app.oaCommentOk = !!oaRes.commentOk; app.oaTableErr = oaRes.tableErr || '';
  await persistApplication(app);
  resubmitParentId = null;
  apps.unshift(app); saveApps(); updateBadge();
  selSpu = []; priceMap = {}; expandedSpu.clear(); expandedColor.clear(); costMap = {};
  renderPickList(); renderApplyTable();
  showSubmitModal(app, needOA, oaRes);
}

/* ================= 视图二：价格查询 ================= */
function doQuery() {
  const k = $('#q-input').value.trim().toLowerCase();
  if (!k) { $('#q-result').innerHTML = '<p style="color:var(--txt2);margin-top:20px">请输入商品名或款号</p>'; return; }
  const uniq = []; const seen = new Set();
  for (const p of D.products) {
    if (!p.spuCode || seen.has(p.spuCode)) continue;
    if ((p.name + (p.spuShort || '') + (p.styleShort || '') + p.spuCode + (p.category || '')).toLowerCase().includes(k)) { seen.add(p.spuCode); uniq.push(p); }
  }
  if (!uniq.length) { $('#q-result').innerHTML = '<p style="color:var(--txt2);margin-top:20px">未找到匹配商品，试试「袋鼠裤」「FBSG01」</p>'; return; }
  $('#q-result').innerHTML = uniq.slice(0, 8).map((p) => qCard(p)).join('') +
    (uniq.length > 8 ? `<p style="color:var(--txt2);margin-top:12px">另有 ${uniq.length - 8} 个匹配结果，请缩小关键词</p>` : '');
}

function qCard(p) {
  const ref = calcRef(p);
  const hs = historyOf(p.spuCode).sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const low = hs.length ? Math.min(...hs.map((h) => h.price)) : null;
  const pfAgg = ['京东', '天猫', '抖音'].map((pf) => {
    const rs = hs.filter((h) => h.platform === pf);
    return { pf, cnt: rs.length, low: rs.length ? Math.min(...rs.map((h) => h.price)) : null, last: rs[0] };
  });
  return `<div class="panel q-card">
    <div class="q-head">
      <h3>${esc(p.name)}${p.spuShort ? ' <span class="cell-sub" style="font-weight:400">' + esc(p.spuShort) + '</span>' : ''}</h3>
      <span class="tag ${p.grade}">${esc(p.grade)}级</span>
      <span class="tag plain">${esc(p.category || '—')}｜${esc(p.productPos)}｜${esc(p.season || '—')}｜${esc(p.spuCode)}</span>
      <span style="color:var(--txt2);font-size:13px">吊牌 ${fmt(p.listPrice)}${p.retailPrice != null ? '｜零售 ' + fmt(p.retailPrice) : ''}</span>
    </div>
    <div class="q-suggest">
      参考价引擎：${D.dataSourceKind !== 'demo' ? '表内等级规则（行内字段）' : '等级规则表匹配'} <b>${ref.minD != null ? '最低 ' + ref.minD + ' 折 → 建议最低价 ' + fmt(ref.suggestMin) : '控价无下限'}</b>；
      常规折扣 <b>${ref.normD != null ? ref.normD + ' 折 → ' + fmt(ref.normPrice) : '—'}</b>
      ${p.redlinePrice != null ? '｜页面红线价 <b>' + fmt(p.redlinePrice) + '</b>' + (ref.redlineApplied ? '（地板·已生效，不低于红线）' : '（不高于规则价，未抬升）') : ''}
      ${p.remark ? '<br>备注：' + esc(p.remark) : ''}
    </div>
    <div class="q-stats">
      <div class="stat"><div class="lbl">历史最低价</div><div class="val red">${low != null ? fmt(low) : '—'}</div><div class="sub">跨平台全部记录</div></div>
      <div class="stat"><div class="lbl">建议最低价</div><div class="val blue">${fmt(ref.suggestMin)}</div><div class="sub">等级规则计算</div></div>
      <div class="stat"><div class="lbl">SKU 数</div><div class="val">${skusOf(p).length}</div><div class="sub">${p.demoSku ? '颜色×尺码（演示）' : '颜色×尺码（真实）'}</div></div>
      <div class="stat"><div class="lbl">历史活动数</div><div class="val green">${hs.length}</div><div class="sub">含归档记录</div></div>
    </div>
    <div class="pf-grid">
      ${pfAgg.map((a) => `<div class="pf-card">
        <h4><span>${a.pf}</span><span class="cnt">${a.cnt} 次活动</span></h4>
        <div class="low">${a.low != null ? fmt(a.low) : '—'}</div>
        <div class="cnt">${a.last ? '最近：' + esc(a.last.activityName) + ' ' + esc(a.last.startDate) : '无记录'}</div>
      </div>`).join('')}
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>平台</th><th>店铺</th><th>活动类型</th><th>活动名称</th><th>活动价</th><th>时间</th><th>提交人</th><th>来源</th></tr></thead>
      <tbody>${hs.length ? hs.map((h) => `<tr>
        <td>${esc(h.platform)}</td><td>${esc(h.store)}</td>
        <td>${esc(h.activityType)}</td><td>${esc(h.activityName)}</td>
        <td><b style="color:${h.price === low ? 'var(--red)' : 'inherit'}">${fmt(h.price)}</b></td>
        <td>${esc(h.startDate)} ~ ${esc(h.endDate)}</td>
        <td>${esc(h.applicant || '—')}</td>
        <td><span class="tag plain">${esc(h.sourceLabel || (h.archived ? '审批归档（真实）' : '演示数据'))}</span></td>
      </tr>`).join('') : '<tr class="empty-row"><td colspan="8">暂无历史活动记录</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

/* ================= 视图三：审批跟踪 ================= */
function updateBadge() {
  const n = apps.filter((a) => a.status === '审批中').length;
  const b = $('#approval-badge');
  b.textContent = n; b.classList.toggle('hidden', n === 0);
}

let approvalStatusSyncing = false;
let historyRefreshPending = false;
/* 仅轮询本系统已回填的状态，不直接请求钉钉接口。 */
const APPROVAL_STATUS_REFRESH_MS = 20 * 1000;
async function syncApprovalStatuses() {
  if (approvalStatusSyncing) return;
  const instanceIds = apps.map((app) => app.oaNo).filter(Boolean);
  if (!instanceIds.length) return;
  approvalStatusSyncing = true;
  try {
    const r = await fetch('/api/ding/approval-statuses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instanceIds }) });
    const j = await r.json(); const statuses = (j && j.success && j.statuses) || {};
    let changed = false;
    apps.forEach((app) => {
      const next = statuses[app.oaNo];
      if (next && next.status && app.status !== next.status) {
        app.status = next.status; app.oaStatusUpdatedAt = next.updatedAt || ''; changed = true;
        if (next.status === '已通过') historyRefreshPending = true;
      }
    });
    if (changed) { saveApps(); renderApprovals(); }
    // 已通过申请的价格历史由服务端审批快照生成；仅重新读取，不会重复写入审批或活动记录。
    if (historyRefreshPending) {
      try {
        await loadEnterpriseApplications();
        historyRefreshPending = false;
      } catch (e) { /* 保留标记，下一轮继续读取已入库的历史快照。 */ }
    }
  } catch (e) { /* 状态同步失败不覆盖本地已展示状态 */ }
  finally { approvalStatusSyncing = false; }
}

function renderApprovals() {
  const tb = $('#ap-tbody');
  const list = apFilter === 'all' ? apps.filter((a) => a.status !== '草稿') : apps.filter((a) => a.status === apFilter);
  tb.innerHTML = list.length ? list.map((a) => `<tr>
    <td><b>${a.id}</b><div class="cell-sub">${a.createdAt}</div></td>
    <td>${a.platform}<div class="cell-sub">${esc(a.store)}</div></td>
    <td>${esc(a.activityCat)}<div class="cell-sub">${a.activities.length} 个活动同时开展${a.activities.some((x) => x.scope === 'store') ? '（含全店玩法）' : ''}</div></td>
    <td>${a.items.length || (a.activities.some((x) => x.scope === 'store') ? '全店玩法' : 0)}</td>
    <td class="cell-sub">${a.start || '—'} ~ ${a.end || '—'}</td>
    <td><span class="st ${a.status}">${a.status}</span>${a.violations ? '<div class="cell-sub" style="color:var(--red)">' + a.violations + ' 项低于控价</div>' : ''}</td>
    <td><button class="btn ghost sm" onclick="openDetail('${a.id}')">详情</button></td>
  </tr>`).join('') : '<tr class="empty-row"><td colspan="7">暂无申请单，去「活动申请」创建第一单</td></tr>';
  updateBadge();
  if (!approvalStatusSyncing) void syncApprovalStatuses();
}

$$('#ap-filter .chip').forEach((c) => c.addEventListener('click', () => {
  $$('#ap-filter .chip').forEach((x) => x.classList.remove('active'));
  c.classList.add('active');
  apFilter = c.dataset.st;
  renderApprovals();
}));

window.openDetail = function (id) {
  const a = apps.find((x) => x.id === id);
  if (!a) return;
  const steps = [
    { t: '提交申请', s: 'done', d: a.createdAt },
    { t: '钉钉审批' + (a.oaNo ? '（' + a.oaNo + '）' : '（免审）'), s: a.status === '审批中' ? 'cur' : a.status === '未通过' ? 'rej' : 'done', d: a.status === '审批中' ? '等待主管审批' : a.status === '未通过' ? '已驳回' : '已完成' },
    { t: '记录归档', s: a.status === '已通过' ? 'done' : 'todo', d: a.status === '已通过' ? '已写入活动记录表' : '待审批通过' },
  ];
  $('#drawer-title').textContent = '申请单 ' + a.id;
  $('#drawer-body').innerHTML = `
    ${a.status === '未通过' ? `<div class="oa-box reject-action"><h4>驳回处理</h4>
      <div class="cell-sub">此申请已驳回，可先修改价格或活动信息，再基于原申请重新提交。</div>
      <div class="oa-actions"><button class="btn primary sm" onclick="reopen('${a.id}')">修改后重新提交</button></div></div>` : ''}
    <div class="kv">
      <span class="k">申请人</span><span>${a.applicant}（${a.dept}）</span>
      <span class="k">平台/店铺</span><span>${a.platform} · ${esc(a.store)}</span>
      <span class="k">活动类型</span><span>${esc(a.activityName)}</span>
      <span class="k">参与方式</span><span>${(a.activities || []).map((x) => esc(x.cat2) + '：' + (x.scope === 'store' ? '全店玩法' : '按商品填价')).join('；') || '—'}</span>
      ${(a.activities || []).some((x) => x.scope === 'store') ? `<span class="k">全店玩法</span><span>${a.activities.filter((x) => x.scope === 'store').map((x) => esc(x.cat2) + '：' + esc(x.play?.type || '') + ' ' + esc(x.play?.text || '')).join('；')}</span>` : ''}
      <span class="k">费用承担</span><span>${(a.activities || []).map((x) => esc(x.cat2) + '：' + esc(x.cost || '—')).join('；') || '—'}</span>
      <span class="k">活动时间</span><span>${a.start || '—'} ~ ${a.end || '—'}</span>
      <span class="k">状态</span><span class="st ${a.status}">${a.status}</span>
      ${a.oaStatusUpdatedAt ? `<span class="k">状态同步时间</span><span>${esc(String(a.oaStatusUpdatedAt))}</span>` : ''}
    </div>
    <div class="flow">${steps.map((s) => `<div class="flow-step ${s.s}">
      <div class="flow-dot">${s.s === 'done' ? '✓' : s.s === 'rej' ? '✕' : s.s === 'cur' ? '…' : ''}</div>
      <div class="flow-txt"><b>${s.t}</b><small>${s.d}</small></div></div>`).join('')}
    </div>
    <div class="table-wrap"><table class="grid">
      <thead><tr><th>SKU</th><th>颜色/尺码</th><th>原价</th><th>建议价</th><th>历史低</th><th>申请价</th><th>控价结论</th><th>层级</th></tr></thead>
      <tbody>${a.items.map((it) => `<tr>
        <td><div class="cell-name">${esc(it.name)}</div><div class="cell-sub">${esc(it.skuCode)}</div></td>
        <td>${esc(it.color)} ${esc(it.size)}</td>
        <td>${fmt(it.listPrice)}</td><td>${fmt(it.suggestMin)}</td><td>${fmt(it.histLow)}</td>
        <td><b style="color:${it.suggestMin != null && it.price < it.suggestMin ? 'var(--red)' : 'inherit'}">${fmt(it.price)}</b></td>
        <td><span class="tag plain" style="color:${it.compliance === '不符合控价' ? 'var(--red)' : 'var(--green)'}">${esc(it.compliance || (it.suggestMin != null && it.price < it.suggestMin ? '不符合控价' : '符合控价'))}</span></td>
        <td><span class="tag plain">${it.level || 'SKU'}</span></td></tr>`).join('')}</tbody>
    </table></div>
    ${a.status === '审批中' ? `<div class="oa-box"><h4>状态由钉钉审批同步</h4><div class="cell-sub">请在钉钉审批单处理；本系统仅读取并回填状态。</div></div>` : ''}`;
  $('#drawer').classList.add('show');
  $('#drawer-mask').classList.add('show');
};

window.reopen = function (id) {
  const a = apps.find((x) => x.id === id);
  if (!a) return;
  resubmitParentId = a.id;
  selSpu = []; priceMap = {}; expandedSpu.clear(); expandedColor.clear();
  a.items.forEach((it) => {
    const p = D.products.find((x) => x.spuCode === it.spuCode);
    if (!p) return;
    if (!selSpu.includes(p.id)) selSpu.push(p.id);
    const s = priceMap[p.id] || (priceMap[p.id] = { spu: '', colors: {}, skus: {} });
    const sk = skusOf(p).find((x) => x.code === it.skuCode);
    if (sk) s.skus[sk.code] = it.price;
  });
  renderPlatformSelect(a.platform);
  renderStoreSelect(a.store);
  selActivities = new Set(a.activities.map((x) => x.unified + '|' + x.cat2));
  costMap = {};
  a.activities.forEach((x) => { if (x.cost) costMap[x.unified + '|' + x.cat2] = x.cost; });
  standardMeta = Object.assign({ manzeng: '', remark: '' }, a.standardMeta || {});
  initApply();
  if ($('#f-manzeng')) $('#f-manzeng').value = standardMeta.manzeng;
  if ($('#f-standard-remark')) $('#f-standard-remark').value = standardMeta.remark;
  $('#f-start').value = a.start; $('#f-end').value = a.end;
  closeDrawer();
  switchTab('apply');
  toast('已回填申请单，修改后可重新提交');
};

/* =========================================================
 * 上传活动表模式桥接（供 upload.js 调用）
 * ========================================================= */
window.MKT_APP = { skusOf, calcRef, histLow, stockOf, toast };

/* 提交上传明细：按店铺分组 → 每店一张申请单（与手工单同构，走正式审批/归档链路）。
 * 赠品行（活动价=0）不进入 items，避免污染价格查询与历史最低价，仅计数记录。 */
window.MKT_SUBMIT_UPLOAD = async function ({ activity, stdRows, sourceFile, sourceBase64 }) {
  const currentUser = await resolveCurrentUser();
  if (!currentUser || !currentUser.userId) throw new Error('请先点击右上角「立即登录」完成钉钉身份验证');
  const groups = {};
  const order = [];
  stdRows.forEach((r) => {
    const st = r.店铺 || (activity.stores && activity.stores[0]) || '未指定店铺';
    if (!groups[st]) { groups[st] = []; order.push(st); }
    groups[st].push(r);
  });
  const created = [];
  for (const st of order) {
    const rows = groups[st];
    const giftRows = rows.filter((r) => r.赠品标记 === '是');
    const items = rows.filter((r) => r.赠品标记 !== '是').map((r) => {
      const prod = D.products.find((x) => x.spuCode === r.货号);
      const ref = prod ? calcRef(prod) : { suggestMin: null };
      return {
        spuCode: r.货号, skuCode: r.SKU编码, name: r.产品名称,
        spuShort: prod ? (prod.spuShort || '') : '', category: prod ? (prod.category || '') : '',
        season: r.商品时期 || '', color: r.颜色, size: r.尺码, gender: '',
        listPrice: r.原价, retailPrice: prod ? prod.retailPrice : null,
        suggestMin: ref.suggestMin, histLow: histLow(r.货号),
        price: r.活动价, stock: stockOf(r.SKU编码),
        grade: prod ? prod.grade : null,
        compliance: ref.suggestMin != null && r.活动价 < ref.suggestMin ? '不符合控价' : '符合控价', level: 'SKU',
      };
    });
    const violations = items.filter((it) => it.suggestMin != null && it.price < it.suggestMin).length;
    const needOA = true;
    const requestId = 'REQ' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + uid();
    const app = {
      id: requestId,
      applicant: currentUser.name || '当前登录人', dept: currentUser.dept || '',
      platform: activity.platform || '', store: st,
      activities: [{ unified: activity.type || '上传活动', cat2: '上传活动表', name: activity.name || '上传活动表', cost: '', scope: 'sku', play: null }],
      activityType: activity.type || '上传活动', activityCat: '上传活动表',
      activityName: activity.name || '上传活动表',
      start: activity.start || '', end: activity.end || '',
      status: '审批中', oaNo: null,
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      items, violations,
      upload: { sourceFile: sourceFile || '', giftSkus: giftRows.length, warnRows: rows.filter((r) => r._warn).length },
    };
    app.activityId = standardActivityId(app);
    app.standardRows = rows.map((row) => standardizeRow(Object.assign({}, row, { 活动ID: app.activityId })));
    app._uploadXlsx = sourceBase64 || '';
    app._uploadName = sourceFile || '';
    try {
      const schema = await oaEnsureSchema();
      if (!schema || !schema.length) throw new Error('未取到 OA 表单结构，未创建申请单');
      const c = oaCompose(app);
      const t0 = new Date().toISOString().slice(0, 10);
      const v = { 事项: c.事项, 方案: c.方案, start: app.start || t0, end: app.end || t0, 备注: c.备注 };
      const res = await oaSubmit(app, v, true, 'remark');
      app.status = '审批中'; app.oaNo = res.instanceId; app.oaReal = true;
      if (res.attach) app.oaAttach = res.attach;
      app.oaTableUrl = res.tableUrl || ''; app.oaTableErr = res.tableErr || '';
      await persistApplication(app);
    } catch (e) { throw new Error('店铺「' + st + '」提交失败：' + e.message); }
    apps.unshift(app);
    created.push(app);
  }
  updateBadge();
  renderApprovals();
  return created;
};

/* ---------- 抽屉 / 弹窗 ---------- */
function closeDrawer() { $('#drawer').classList.remove('show'); $('#drawer-mask').classList.remove('show'); }
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-mask').addEventListener('click', closeDrawer);
function openModal(html) { $('#modal').innerHTML = html; $('#modal-mask').classList.add('show'); }
window.closeModal = () => $('#modal-mask').classList.remove('show');
$('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) closeModal(); });
window.switchTab = (v) => $$('.tab').find((t) => t.dataset.view === v).click();

/* ---------- 当前操作人：服务器会话优先；钉钉内免登作为补充，手工绑定仅管理员可见 ---------- */
window.MKT_WHOAMI = null;
function saveWhoami(u) { /* 登录身份由服务端签名会话保存，页面不写浏览器持久化存储。 */ }
async function serverWhoami() {
  try { const r = await fetch('/api/ding/me', { cache: 'no-store' }); const j = await r.json(); return (j && j.success && j.user && j.user.userId) ? j.user : null; }
  catch (e) { return null; }
}
function getDingTalkCorpId() {
  const corpId = String(new URLSearchParams(location.search).get('corpId') || new URLSearchParams(location.search).get('corpid') || '').trim();
  return /^ding[a-z0-9]+$/i.test(corpId) ? corpId : '';
}
async function ddWhoami() {
  const corpId = getDingTalkCorpId();
  if (!corpId) return null;
  if (!window.dd) await new Promise((res) => { const s = document.createElement('script'); s.src = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js'; s.onload = () => res(); s.onerror = () => res(); document.head.appendChild(s); });
  if (!window.dd || !dd.runtime || !dd.runtime.permission) return null;
  const cfg = { corpId };
  try {
    const code = await new Promise((res, rej) => dd.runtime.permission.requestAuthCode({ corpId: cfg.corpId, onSuccess: (o) => res(o.code), onFail: rej }));
    const r = await fetch('/api/ding/whoami', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    return (j && j.success && j.userId) ? { userId: j.userId, name: j.name || '', source: '钉钉免登', allowManualBind: !!j.allowManualBind } : null;
  } catch (e) { return null; }
}
async function resolveCurrentUser(force) {
  if (!force && window.MKT_WHOAMI && window.MKT_WHOAMI.userId) return window.MKT_WHOAMI;
  // 已验证的服务端会话可快速复用；只有会话缺失或用户主动“重新登录”时才向钉钉申请免登码。
  let u = !force ? await serverWhoami() : null;
  if (!u && getDingTalkCorpId()) u = await ddWhoami();
  if (u) { saveWhoami(u); window.MKT_WHOAMI = u; } else window.MKT_WHOAMI = null;
  renderWhoami();
  if (u && window.MKT_DS) {
    try {
      await window.MKT_DS.loadEnterpriseSnapshot();
      await window.MKT_DS.refreshAccess();
    } catch (e) { /* 企业正式数据未就绪时保留当前只读展示，不影响登录。 */ }
  }
  if (u) await ensureAuditTab();
  if (u) {
    try { await loadEnterpriseApplications(); }
    catch (e) { toast('企业申请记录暂不可用：' + e.message); }
  }
  return window.MKT_WHOAMI;
}
async function startDingLogin() {
  if (getDingTalkCorpId()) {
    const button = document.querySelector('.whoami-login');
    if (button) { button.disabled = true; button.textContent = '正在重新识别…'; }
    const u = await resolveCurrentUser(true);
    if (u) { toast('已按当前钉钉账号重新识别'); return; }
    if (button) { button.disabled = false; button.textContent = '重新登录'; }
    toast('钉钉免登未完成，请关闭当前应用页后重新进入');
    return;
  }
  toast('网页登录已关闭，请从钉钉应用打开');
}
function renderWhoami() {
  const u = window.MKT_WHOAMI;
  const b = document.querySelector('.topbar .user-meta b'), sm = document.querySelector('.topbar .user-meta small'), chip = document.querySelector('.topbar .user-chip'), avatar = document.querySelector('.topbar .avatar');
  if (b) b.textContent = (u && u.name) || (u ? '操作人' : '未识别操作人');
  if (sm) sm.textContent = u ? (u.source + (u.name ? '' : ' · ' + String(u.userId).slice(-6))) : '未识别';
  if (avatar) avatar.textContent = u && u.name ? String(u.name).slice(0, 1) : '?';
  if (chip) chip.title = u ? ('当前操作人 userId=' + u.userId + '（' + u.source + '）') : '未识别当前操作人';
  let login = document.querySelector('.whoami-login');
  if (!login && chip) { login = document.createElement('button'); login.className = 'btn ghost sm whoami-login'; login.addEventListener('click', startDingLogin); chip.after(login); }
  if (login) login.textContent = u ? '重新登录' : '立即登录';
  let rb = document.querySelector('.whoami-rebind');
  if (u && u.allowManualBind && !rb && chip) { rb = document.createElement('button'); rb.className = 'btn ghost sm whoami-rebind'; rb.textContent = '手动绑定'; rb.addEventListener('click', openWhoamiBind); login && login.after(rb); }
  if (rb && (!u || !u.allowManualBind)) rb.remove();
}
function openWhoamiBind() {
  const cur = window.MKT_WHOAMI || {};
  openModal(`<h3>当前操作人</h3>
    <p class="ds-sub">管理员排障入口。普通用户必须通过钉钉免登或网页登录确认身份，不能手动指定发起人。</p>
    <div class="field"><label>钉钉 userId</label><input id="wb-uid" type="text" value="${esc(cur.userId || '')}" placeholder="绑定为提交发起人"></div>
    <div id="wb-msg" class="ds-muted" style="margin:4px 0"></div>
    <div class="modal-actions">
      <button class="btn ghost" id="wb-refresh">重新免登识别</button>
      <button class="btn ghost" onclick="closeModal()">关闭</button>
      <button class="btn primary" id="wb-ok">校验并绑定</button>
    </div>`);
  const m = $('#wb-msg');
  $('#wb-refresh') && $('#wb-refresh').addEventListener('click', async () => { const r = await resolveCurrentUser(true); m.textContent = r ? ('已识别：' + (r.name || r.userId) + '（' + r.source + '）') : '未识别到（非钉钉环境或免登失败），可手动输入绑定'; });
  $('#wb-ok') && $('#wb-ok').addEventListener('click', async () => {
    const uid = $('#wb-uid').value.trim(); if (!uid) { m.textContent = '请输入 userId'; return; }
    m.textContent = '校验中…';
    try {
      const r = await fetch('/api/ding/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: uid }) }); const j = await r.json();
      if (j && j.success) { const u = { userId: uid, name: j.name || '', dept: (j.dept_id_list || [])[0], source: '手动绑定' }; saveWhoami(u); window.MKT_WHOAMI = u; renderWhoami(); closeModal(); toast('已绑定操作人：' + (u.name || uid)); }
      else m.textContent = '该 userId 应用内查不到：' + ((j && (j.errmsg || j.errcode)) || '');
    } catch (e) { m.textContent = '校验失败：' + e.message; }
  });
}
/* ---------- 初始化 ---------- */
$('#f-platform').addEventListener('change', () => {
  renderStoreSelect();
  renderRuleHints();
  refreshStoreOnlyUi();
});
$('#f-search').addEventListener('input', renderPickList);
$('#q-btn').addEventListener('click', doQuery);
$('#q-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doQuery(); });
const today = new Date().toISOString().slice(0, 10);
$('#f-start').value = today;
$('#f-end').value = today.slice(0, 8) + '28';
renderPlatformSelect();
renderStoreSelect();
initApply();
updateDsTag(D.dataSourceKind === 'api');
renderApprovals();
setInterval(() => {
  if (apps.some((app) => app.status === '审批中') || historyRefreshPending) void syncApprovalStatuses();
}, APPROVAL_STATUS_REFRESH_MS);
const loginError = new URLSearchParams(window.location.search).get('login_error');
if (loginError) {
  const loginMessages = { expired: '登录请求已失效，请点击“立即登录”重试', denied: '钉钉登录已取消，请重新登录', missing_code: '钉钉未返回授权信息，请重新登录', failed: '钉钉登录失败，请重新登录' };
  toast(loginMessages[loginError] || '钉钉登录失败，请重新登录');
  const cleanUrl = new URL(window.location.href); cleanUrl.searchParams.delete('login_error');
  window.history.replaceState({}, '', cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
}
resolveCurrentUser();

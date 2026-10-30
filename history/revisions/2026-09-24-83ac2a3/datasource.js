/* ===== 数据源模块（三层架构） =====
 * 1. 源表：数据魔方 API 原始行 + fetchedAt，localStorage 存档（不可变）
 * 2. 中间表：源表 + 字段映射 + 算法/配置（等级规则、红线价、SKU 展开）→ 应用层全部取中间表
 * 3. 应用层：app.js 初始化时若存在中间表则覆盖演示数据
 * 凭证只维护 4 个值：APP Key / APP Secret / 接口ID(apiId) / 数据表ID(tableId)，
 * 字段名由接口返回值自动发现并按同义词表映射，可在面板中手工修正。 */
(function () {
  const LS_SRC_P = 'mkt_src_products_v1';
  const LS_SRC_S = 'mkt_src_stock_v1';
  const LS_MID_P = 'mkt_mid_products_v2'; /* v2：字段体系按《单表处理》27 列重构，旧中间表作废 */
  const LS_MID_S = 'mkt_mid_stock_v1';
  const LS_MID_SP = 'mkt_mid_stock_from_products_v2'; /* v2：库存引用源改为「实际库存数 actual_stock」，旧 public 口径索引作废 */
  const LS_FMAP = 'mkt_fieldmap_v3'; /* v3：stock 目标改指向 actual_stock，旧映射作废重匹配 */
  const PAGE_SIZE = 200;

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => {
    if (v == null || v === '') return null;
    const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const fmtTime = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const lsGet = (k, dft) => { try { return JSON.parse(localStorage.getItem(k) || 'null') || dft; } catch (e) { return dft; } };

  /* ---------- IndexedDB 持久层（源表/中间表可能很大，localStorage 仅 ~5MB 会溢出丢失） ---------- */
  const ALL_KEYS = [LS_SRC_P, LS_SRC_S, LS_MID_P, LS_MID_S, LS_MID_SP, LS_FMAP];
  const MEM = {}; /* 全部键的内存副本：同步读走这里；启动时先用 localStorage 预填，再用 IndexedDB 覆盖 */
  ALL_KEYS.forEach((k) => { MEM[k] = lsGet(k, null); });

  let _dbP = null;
  function idb() {
    if (_dbP) return _dbP;
    _dbP = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB 不可用'));
      const req = indexedDB.open('mkt_ds', 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv'); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbP;
  }
  async function idbGet(key) {
    try { const db = await idb(); return await new Promise((res, rej) => { const rq = db.transaction('kv').objectStore('kv').get(key); rq.onsuccess = () => res(rq.result !== undefined ? rq.result : null); rq.onerror = () => rej(rq.error); }); }
    catch (e) { return null; }
  }
  async function idbSet(key, val) {
    try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; }
    catch (e) { return false; }
  }
  async function idbDel(key) {
    try { const db = await idb(); await new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); return true; }
    catch (e) { return false; }
  }

  /* 同步读内存副本；异步写 IndexedDB（权威）+ 尽力写 localStorage（镜像，溢出忽略） */
  const memGet = (k, dft) => { const v = MEM[k]; return v == null ? (dft === undefined ? null : dft) : v; };
  function memSet(k, v) {
    MEM[k] = v;
    idbSet(k, v);
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 超配额：localStorage 镜像失败，IndexedDB 仍持久化 */ }
  }
  function memDel(k) { MEM[k] = null; idbDel(k); try { localStorage.removeItem(k); } catch (e) {} }

  /* 启动：用 IndexedDB 覆盖内存副本（localStorage 因配额丢失时由此恢复），再刷新应用层 */
  async function hydrateFromIdb() {
    let changed = false;
    for (const k of ALL_KEYS) {
      const v = await idbGet(k);
      if (v) {
        if (JSON.stringify(v) !== JSON.stringify(MEM[k])) { MEM[k] = v; changed = true; }
      } else if (MEM[k]) {
        /* 升级迁移：IndexedDB 尚无此键而 localStorage 有 → 补写入 IndexedDB */
        idbSet(k, MEM[k]);
      }
    }
    if (changed) notifyApp();
    return changed;
  }

  /* ---------- 目标字段与同义词（自动映射用；按《单表处理》27 列新表头重构） ----------
   * 注意：对象键顺序即匹配优先级——更具体的字段放前面，避免包含匹配误占列
   * （如「常规折扣价」须先于「常规折扣」、「吊牌价」先于「零售价」）。 */
  const TARGETS_P = {
    spuCode: ['货号', '款号', '商品编码', 'spu编码', 'spu', '商品款号', 'hh', 'kh', 'spucode', 'spu_code', 'itemno'],
    name: ['品名', '商品名称', '名称', 'pm', 'spmc'],
    spuShort: ['商品简称', 'spjc', 'spjcdbcl'],
    styleShort: ['款式简称', 'kssjc', 'ksjc'],
    category: ['类别', '品类', '类目', 'lb'],
    productPos: ['商品定位', '定位', 'spdw'],
    season: ['季节', '商品时期', '款年', '时期', 'jh', 'jj', 'season'],
    grade: ['商品等级', '等级', 'spdj'],
    offSeasonIdx: ['过季指数', 'gjzs'],
    annualSales: ['款年实销额', '年实销额', '款年销售额', '销售额', 'xsje', 'xse', 'knsxe'],
    gender: ['性别', 'xb', 'sex'],
    color: ['颜色', 'ys', 'colour', 'color', 'ysdbcl'],
    size: ['尺码', 'cm', 'chima', 'size'],
    sysSize: ['系统尺寸', 'xtcc', '系统规格'],
    skuCode: ['规格编码', 'sku编码', 'erp识别码', 'skucode', 'sku_code', 'ggbmesbm'],
    upc: ['upc条码', 'upc', '仓库发货码', '条码', 'upctm', 'utmckfhm'],
    listPrice: ['吊牌价', '建议零售价', '吊牌价建议零售价', '标价', 'dpj', 'dpjjylsj', 'yuanjia'],
    retailPrice: ['零售价', 'lsj', '实际零售价'],
    normPrice: ['常规折扣价', 'cgzkj'],
    normDiscount: ['常规折扣', '常规折扣2商品等级划分策略规则', 'cgzk', 'cgzk2spdjhfclgz'],
    minPrice: ['最低价', '建议最低价', 'zdj'],
    minDiscount: ['最低折扣', '最低折扣2商品等级划分策略规则', 'zjdk', 'zdzk2spdjhfclgz'],
    redlinePrice: ['页面红线价', '红线价', 'hxx', 'redline', 'ymhxj'],
    salesMin: ['年销售额门槛', '销售额门槛', '门槛', 'nxsemj'],
    salesMax: ['年销售额max', '年销售额上限', '销售额上限', 'max', 'nxsem'],
    remarkPos: ['备注3商品定位', '定位备注', 'bz3spdw'],
    remark: ['备注', 'bz', 'bzdbcl'],
    stock: ['实际库存数', 'actual_stock', '实际库存', '在库数量', '在库数', '可用库存数', 'public_available_inventory', '公有可用数'],
  };
  const TARGETS_S = {
    code: ['sku编码', '规格编码', '编码', '款号', '商品编码', '货号', 'hh', 'skucode', 'sku', 'itemno'],
    color: ['颜色', 'ys'],
    size: ['尺码', 'cm'],
    qty: ['库存数量', '可用库存', '在库数量', '库存', '数量', 'kc', 'kcs', 'sl', 'stock', 'qty'],
    date: ['日期', '统计日期', '快照日期', '库存日期', '数据日期', '业务日期', '盘点日期', 'rq', 'date', 'dt'],
  };
  const norm = (s) => String(s ?? '').replace(/[\s_\-()（）.]/g, '').toLowerCase();

  /* 目标字段中文名（字段映射面板展示用） */
  const LABEL_P = {
    spuCode: '货号（SPU 编码）', name: '品名', spuShort: '商品简称', styleShort: '款式简称（可选）',
    category: '类别', productPos: '商品定位（标品/非标）', season: '季节（款年）', grade: '商品等级（S/A/B/C）',
    offSeasonIdx: '过季指数（0-4）', annualSales: '款年实销额（匹配等级）', gender: '性别（男/女/中性）',
    color: '颜色（真实 SKU 维度）', size: '尺码（真实 SKU 维度）', sysSize: '系统尺寸（可选）',
    skuCode: '规格编码 / SKU 编码（与库存表匹配）', upc: 'UPC 条码 / 仓库发货码',
    listPrice: '吊牌价（建议零售价）', retailPrice: '零售价（折扣计算基数）',
    normPrice: '常规折扣价（表内已算）', normDiscount: '常规折扣（等级规则内嵌）',
    minPrice: '最低价（表内已算，兜底）', minDiscount: '最低折扣（等级规则内嵌，空=无下限）',
    redlinePrice: '页面红线价（人工控价）', salesMin: '年销售额门槛', salesMax: '年销售额上限',
    remarkPos: '备注·商品定位', remark: '备注',
    stock: '实际库存数（商品表聚合，活动申请库存引用源）',
  };
  const LABEL_S = {
    code: '款号 / SKU 编码', color: '颜色', size: '尺码', qty: '库存数量', date: '日期（按日存档依据）',
  };

  /* 库存按日维度存档：只保留近 N 天 */
  const STOCK_DAYS = 1;

  /* 日期解析：兼容 "2026-09-21" / "2026/9/21" / "20260921" / 毫秒时间戳；失败返回 null */
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number' || /^\d{12,}$/.test(String(v))) {
      const n = Number(v);
      return n > 1e11 ? n : null; /* 毫秒级时间戳 */
    }
    const s = String(v).trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-');
    if (/^\d{8}$/.test(s)) return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime();
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }

  /* 列名并集（取前 50 行样本） */
  function columnsOf(rows) {
    const seen = new Set(), out = [];
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r || {})) if (!seen.has(k)) { seen.add(k); out.push(k); }
    return out;
  }

  /* 自动映射：先精确（规范化后相等），再包含（列名包含同义词）；一列只允许映射一个目标；优先非空列 */
  function autoMap(columns, targets, sample) {
    const map = {}, used = new Set();
    const isEmpty = (c) => sample ? !sample(c) : false;
    for (const t in targets) {
      let hit = null;
      for (const pass of [0, 1]) { /* 0=精确 1=包含 */
        for (const prefer of [false, true]) { /* 先选非空列 */
          for (const syn of targets[t]) {
            const cand = columns.find((c) => !used.has(c) &&
              (pass === 0 ? norm(c) === norm(syn) : norm(c).includes(norm(syn))) &&
              (prefer ? isEmpty(c) : !isEmpty(c)));
            if (cand) { hit = cand; break; }
          }
          if (hit) break;
        }
        if (hit) break;
      }
      map[t] = hit || '';
      if (hit) used.add(hit);
    }
    return map;
  }

  /* 列是否有非空样本值 */
  function colSample(rows) {
    return (c) => rows.slice(0, 50).some((r) => r[c] != null && String(r[c]).trim() !== '');
  }

  /* ---------- 本地代理（server.ps1）通信 ---------- */
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('json')) throw new Error('非 JSON 响应（请确认通过 server.ps1 访问 http://localhost:8766）');
    return r.json();
  }

  let PROXY_OK = null; // null=未检测
  async function checkProxy() {
    if (PROXY_OK !== null) return PROXY_OK;
    try { await api('/api/config'); PROXY_OK = true; } catch (e) { PROXY_OK = false; }
    return PROXY_OK;
  }

  async function loadConfig() {
    try { const j = await api('/api/config'); return j.config; } catch (e) { return null; }
  }
  async function saveConfig(cfg) {
    return api('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
  }

  /* 分页拉全量 → 源表存档 {fetchedAt, count, hash, rows}
   * 库存表：拉取后按日期列过滤，仅存档近 STOCK_DAYS 天（日维度）；
   * 与上次存档 hash 相同 → 跳过写入；localStorage 超配额 → 降级为内存缓存完整行
   * 产品信息表：接口排序不稳定（同一页多次请求返回不同行），OFFSET 分页会重复+漏行，
   *   故采用「多轮累积去重」直到无新增（数据准确性优先，绝不遗漏 SKU）。 */
  async function fetchTable(name, onProgress) {
    /* 单轮全分页拉取 */
    const pullOnce = async () => {
      const acc = [];
      let page = 1, total = null, prevSig = '';
      while (true) {
        const resp = await api('/api/datacube', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ table: name, pageIndex: page, pageSize: PAGE_SIZE }),
        });
        /* 接口业务失败（success=false 或 code 非 0/200）→ 抛出 msg */
        const okCode = !resp.code || String(resp.code) === '0' || String(resp.code) === '200';
        if (resp.success === false || !okCode) {
          throw new Error('接口返回异常' + (resp.code ? ' code=' + resp.code : '') + (resp.msg ? '：' + resp.msg : ''));
        }
        const rows = Array.isArray(resp.data) ? resp.data : (resp.data && Array.isArray(resp.data.records) ? resp.data.records : []);
        total = resp.total != null ? Number(resp.total) : (resp.data && resp.data.total != null ? Number(resp.data.total) : null);

        /* 重复页检测：接口可能忽略 pageIndex 反复返回同一页 → 终止，避免死循环 */
        const sig = rows.length ? JSON.stringify(rows[0]).slice(0, 400) + '#' + rows.length : 'empty';
        if (sig === prevSig) break;
        prevSig = sig;
        acc.push(...rows);
        if (onProgress && name !== 'products') onProgress(acc.length, total);
        if (rows.length < PAGE_SIZE) break;
        if (total != null && acc.length >= total) break;
        page++;
        if (page > 40) { throw new Error('分页超过 40 页，已中止（请检查接口分页参数）'); }
      }
      return acc;
    };

    let all, rounds = 1;
    if (name === 'products') {
      /* 去重键：优先用映射的 SKU 编码列（如 ggbmesbm），无则整行 JSON */
      const fmap = memGet(LS_FMAP, {}) || {};
      let skuCol = fmap.products && fmap.products.skuCode;
      const first = await pullOnce();
      if (!skuCol) skuCol = autoMap(columnsOf(first), TARGETS_P, colSample(first)).skuCode;
      const keyOf = (r) => { const c = skuCol ? String(r[skuCol] ?? '').trim() : ''; return c || JSON.stringify(r); };
      const uniq = new Map();
      const addRows = (rows) => { let added = 0; for (const r of rows) { const k = keyOf(r); if (!uniq.has(k)) { uniq.set(k, r); added++; } } return added; };
      let added = addRows(first);
      if (onProgress) onProgress(uniq.size, null, '去重累积 ' + uniq.size + ' 个 SKU（第 1 轮）');
      while (added > 0 && rounds < 6) {
        const more = await pullOnce();
        added = addRows(more);
        rounds++;
        if (onProgress) onProgress(uniq.size, null, '去重累积 ' + uniq.size + ' 个 SKU（第 ' + rounds + ' 轮，新增 ' + added + '）');
      }
      all = [...uniq.values()];
    } else {
      all = await pullOnce();
    }

    let rows2 = all, dropped = 0;
    if (name === 'stock') {
      const filtered = filterRecentStock(all);
      rows2 = filtered.rows; dropped = filtered.dropped;
    }
    const hash = rowsHash(rows2);
    const prev = memGet(name === 'products' ? LS_SRC_P : LS_SRC_S, null);
    if (prev && prev.hash === hash) {
      /* 与上次存档数据一致 → 不写入，保留原拉取时间 */
      const src = Object.assign({}, prev, { rows: rows2, unchanged: true });
      return src;
    }
    const src = { fetchedAt: new Date().toISOString(), count: rows2.length, dropped, hash, rows: rows2 };
    if (name === 'products') src.rounds = rounds;
    saveSrc(name, src);
    /* 新源表自动映射（若尚无手工映射） */
    const fmap = memGet(LS_FMAP, {});
    const key = name === 'products' ? 'products' : 'stock';
    if (!fmap[key]) {
      fmap[key] = autoMap(columnsOf(rows2), name === 'products' ? TARGETS_P : TARGETS_S, colSample(rows2));
      memSet(LS_FMAP, fmap);
    }
    return src;
  }

  /* ---------- 源表存档：IndexedDB 权威持久化（localStorage 仅作尽力镜像，超配额不丢数据） ---------- */

  /* 轻量 hash（djb2 流式，避免拼接超大字符串） */
  function rowsHash(rows) {
    let h = 5381;
    const feed = (str) => { for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; };
    feed('n' + rows.length);
    for (const r of rows) feed(JSON.stringify(r));
    return (h >>> 0).toString(36) + '_' + rows.length;
  }

  function saveSrc(name, src) {
    memSet(name === 'products' ? LS_SRC_P : LS_SRC_S, src);
  }

  function getSrc(name) {
    return memGet(name === 'products' ? LS_SRC_P : LS_SRC_S, null);
  }

  /* CSV 下载（带 BOM，Excel 直接打开不乱码） */
  function downloadCsv(rows, fname) {
    if (!rows || !rows.length) { toast('暂无数据可下载'); return; }
    const cols = columnsOf(rows);
    const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.map(cell).join(',')];
    for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  /* 库存近 N 天过滤：定位日期列（优先已保存映射，其次自动发现），按日维度保留 >= 今天-(N-1) 的行 */
  function filterRecentStock(rows) {
    if (!rows.length) return { rows, dropped: 0 };
    const saved = (memGet(LS_FMAP, {}) || {}).stock;
    let dateCol = saved && saved.date ? saved.date : null;
    if (!dateCol) {
      const cols = columnsOf(rows);
      dateCol = autoMap(cols, TARGETS_S).date || null;
    }
    if (!dateCol) return { rows, dropped: 0 }; /* 无日期列 → 不过滤 */
    /* 以数据中的最新日期为基准（快照常滞后），保留 >= maxDate-(N-1) 的行 */
    let maxT = 0;
    for (const r of rows) { const t = parseDate(r[dateCol]); if (t != null && t > maxT) maxT = t; }
    if (!maxT) return { rows, dropped: 0 };
    const cutoff = startOfDay(maxT) - (STOCK_DAYS - 1) * 86400000;
    const kept = [];
    let dropped = 0;
    for (const r of rows) {
      const t = parseDate(r[dateCol]);
      if (t == null || t >= cutoff) kept.push(r); else dropped++;
    }
    return { rows: kept.length ? kept : rows, dropped: kept.length ? dropped : 0, dateCol };
  }
  function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

  /* ---------- 中间表构建：源表 + 字段映射 + 算法/配置 ---------- */
  /* 取映射：已保存映射中为空的字段自动重新匹配（兼容旧版同义词表缺失导致的空映射） */
  function resolveMap(name, rows) {
    const targets = name === 'products' ? TARGETS_P : TARGETS_S;
    const saved = (memGet(LS_FMAP, {}) || {})[name] || {};
    const auto = autoMap(columnsOf(rows), targets, colSample(rows));
    const merged = {};
    for (const t in targets) merged[t] = saved[t] || auto[t] || '';
    return merged;
  }

  /* ---------- SKU 行（camel 字段）→ SPU 商品聚合（种子数据与 API 源表共用） ----------
   * 字段体系与《单表处理》27 列一致：
   * 折扣计算基数 = 零售价 retailPrice；吊牌价 listPrice 仅作展示；
   * 建议最低价 = min(零售价×最低折扣, 表内最低价) 再与页面红线价取 min。 */
  function aggregateSkuRows(rows) {
    const groups = new Map();
    for (const r of rows) {
      const spuCode = String(r.spuCode ?? '').trim();
      if (!spuCode) continue;
      if (!groups.has(spuCode)) groups.set(spuCode, []);
      groups.get(spuCode).push(r);
    }
    const products = [];
    for (const [spuCode, rs] of groups) {
      const r0 = rs[0];
      const pick = (k) => { for (const r of rs) { const v = r[k]; if (v != null && v !== '') return v; } return null; };
      const retail = num(pick('retailPrice'));
      const minD = num(pick('minDiscount'));
      const normD = num(pick('normDiscount'));
      let suggestMin = minD != null && retail != null ? Math.round(retail * minD / 10 * 100) / 100 : num(pick('minPrice'));
      const redline = num(pick('redlinePrice'));
      let redlineApplied = false;
      if (redline != null && suggestMin != null && redline < suggestMin) { suggestMin = redline; redlineApplied = true; }
      const normPrice = normD != null && retail != null ? Math.round(retail * normD / 10 * 100) / 100 : num(pick('normPrice'));

      /* 真实 SKU 聚合：颜色 → 尺码；skuCode 用规格编码，缺失则 货号-颜色-尺码 拼接 */
      const colorMap = new Map();
      for (const r of rs) {
        const color = String(r.color ?? '').trim() || '默认';
        const size = String(r.size ?? '').trim() || '均码';
        const gender = String(r.gender ?? '').trim() || '通用';
        if (!colorMap.has(color)) colorMap.set(color, { gender, sizes: [] });
        const code = String(r.skuCode ?? '').trim() || `${spuCode}-${color}-${size}`;
        if (!colorMap.get(color).sizes.some((s) => s.size === size)) {
          const st = num(r.stock);
          colorMap.get(color).sizes.push({ size, code, color, stock: st });
        }
      }
      const colors = [...colorMap.entries()].map(([name, v]) => ({ name, gender: v.gender, sizes: v.sizes }));
      const genders = [...new Set(colors.map((c) => colorMap.get(c.name).gender))];
      products.push({
        id: spuCode, spuCode,
        name: String(r0.name ?? spuCode),
        spuShort: String(r0.spuShort ?? ''),
        styleShort: String(r0.styleShort ?? ''),
        category: String(r0.category ?? ''),
        productPos: String(r0.productPos ?? ''),
        season: String(r0.season ?? ''),
        grade: String(r0.grade ?? ''),
        offSeasonIdx: num(pick('offSeasonIdx')),
        annualSales: num(pick('annualSales')),
        listPrice: num(pick('listPrice')),
        retailPrice: retail,
        minDiscount: minD, normDiscount: normD,
        minPrice: suggestMin, normPrice,
        redlinePrice: redline, redlineApplied,
        salesMin: num(pick('salesMin')), salesMax: num(pick('salesMax')),
        remark: String(r0.remark ?? ''),
        remarkPos: String(r0.remarkPos ?? ''),
        demoSku: false,
        variants: [{ code: spuCode, gender: genders.length === 1 ? genders[0] : '混款', colors }],
      });
    }
    return products;
  }

  /* API 源表行 → camel 字段（按字段映射取值） */
  function srcRowsToCamel(rows, map) {
    const g = (r, t) => (map[t] ? r[map[t]] : null);
    return rows.map((r) => {
      const o = {};
      for (const t in TARGETS_P) o[t] = g(r, t);
      return o;
    });
  }

  function buildMidProducts() {
    const src = getSrc('products');
    if (!src || !src.rows.length) return null;
    const map = resolveMap('products', src.rows);
    const camel = srcRowsToCamel(src.rows, map);
    const products = aggregateSkuRows(camel);
    const mid = { builtAt: new Date().toISOString(), count: products.length, rows: products };
    memSet(LS_MID_P, mid);
    /* 商品表已聚合库存：把「可用库存数」（公有可用数）写入库存索引，供活动申请库存列引用。
     * 独立库存引用表（若配置）优先级更高，见 stockMap()。 */
    if (map.stock) {
      const idx = {};
      for (const r of camel) {
        const code = String(r.skuCode ?? '').trim() || `${String(r.spuCode ?? '').trim()}-${String(r.color ?? '').trim()}-${String(r.size ?? '').trim()}`;
        const qty = num(r.stock);
        if (code && qty != null) idx[code] = qty;
      }
      memSet(LS_MID_SP, { builtAt: new Date().toISOString(), count: Object.keys(idx).length, map: idx });
    }
    return mid;
  }

  function buildMidStock() {
    const src = getSrc('stock');
    if (!src || !src.rows.length) return null;
    const map = resolveMap('stock', src.rows);
    const g = (r, t) => (map[t] ? r[map[t]] : null);
    const idx = {};
    /* 同一 SKU 可能有多天记录：按日期列取最新一天的库存 */
    const best = {};
    for (const r of src.rows) {
      const base = String(g(r, 'code') ?? '').trim();
      if (!base) continue;
      const color = map.color ? String(g(r, 'color') ?? '') : '';
      const size = map.size ? String(g(r, 'size') ?? '') : '';
      const code = color && size ? `${base}-${color}-${size}` : base;
      const t = map.date ? (parseDate(r[map.date]) ?? 0) : 0;
      const qty = num(g(r, 'qty'));
      if (!best[code] || t >= best[code].t) best[code] = { code, color, size, qty, t };
    }
    const rows = Object.values(best);
    for (const r of rows) if (r.qty != null) idx[r.code] = r.qty;
    const mid = { builtAt: new Date().toISOString(), count: rows.length, map: idx, rows: rows.slice(0, 500) };
    memSet(LS_MID_S, mid);
    return mid;
  }

  /* ---------- 应用层接入 ---------- */
  /* 回退链：API 中间表 → 种子数据（products_seed.js，与《单表处理》27 列一致）→ data.js 演示数据 */
  let DEMO_PRODUCTS = null; /* data.js 原始演示数据引用 */
  let SEED_PRODUCTS = null; /* 种子数据聚合后的 SPU 列表（只算一次） */
  function seedProducts() {
    if (SEED_PRODUCTS) return SEED_PRODUCTS;
    const rows = window.PRODUCTS_SEED;
    if (rows && rows.length) SEED_PRODUCTS = aggregateSkuRows(rows);
    return SEED_PRODUCTS;
  }
  function applyToApp() {
    const D = window.APP_DATA;
    if (!DEMO_PRODUCTS) DEMO_PRODUCTS = D.products;
    const midP = memGet(LS_MID_P, null);
    if (midP && midP.rows && midP.rows.length) {
      D.products = midP.rows;
      D.dataSourceKind = 'api';
      D.dataSourceLabel = 'API 中间表 · 构建于 ' + fmtTime(midP.builtAt);
      return true;
    }
    const seed = seedProducts();
    if (seed && seed.length) {
      D.products = seed;
      D.dataSourceKind = 'seed';
      D.dataSourceLabel = '种子数据（单表处理表头）';
      return false;
    }
    D.products = DEMO_PRODUCTS;
    D.dataSourceKind = 'demo';
    D.dataSourceLabel = null;
    return false;
  }
  function stockMap() {
    /* 合并库存来源：商品表聚合的「可用库存数」为基底，独立库存引用表（若已配置拉取）覆盖之 */
    const fromP = memGet(LS_MID_SP, null);
    const fromS = memGet(LS_MID_S, null);
    const a = fromP && fromP.map ? fromP.map : null;
    const b = fromS && fromS.map ? fromS.map : null;
    if (!a && !b) return null;
    if (!b) return a;
    if (!a) return b;
    return Object.assign({}, a, b);
  }

  /* 中间表变更后重新接入应用层并通知刷新（app.js 注册 window.MKT_ON_DATA） */
  function notifyApp() {
    const used = applyToApp();
    if (typeof window.MKT_ON_DATA === 'function') { try { window.MKT_ON_DATA(used); } catch (e) {} }
  }

  window.MKT_DS = { applyToApp, stockMap, buildMidProducts, buildMidStock, fetchTable, loadConfig, saveConfig, checkProxy, fmtTime, columnsOf, autoMap, TARGETS_P, TARGETS_S, notifyApp,
    srcOf: (n) => memGet(n === 'products' ? LS_SRC_P : LS_SRC_S, null),
    midOf: (n) => memGet(n === 'products' ? LS_MID_P : LS_MID_S, null),
    mapOf: () => memGet(LS_FMAP, {}),
    setMap: (m) => memSet(LS_FMAP, m) };

  /* ---------- 「数据源」Tab UI（运行时注入，防 index.html 回退） ---------- */
  function ensureTab() {
    if (document.querySelector('.tab[data-view="datasource"]')) return;
    const nav = document.querySelector('nav.tabs');
    if (!nav) return;
    const btn = document.createElement('button');
    btn.className = 'tab';
    btn.dataset.view = 'datasource';
    btn.innerHTML = '<span class="tab-ico">⇄</span>数据源';
    nav.appendChild(btn);
    const sec = document.createElement('section');
    sec.className = 'view';
    sec.id = 'view-datasource';
    sec.innerHTML = '<div id="ds-root"><p style="color:var(--txt2)">数据源面板加载中…</p></div>';
    const main = document.querySelector('main.stage');
    if (main) main.appendChild(sec);
    /* 导航点击事件由 app.js 统一绑定（本脚本先于 app.js 加载） */
  }

  function miniTable(rows, cols, limit) {
    if (!rows || !rows.length) return '<p class="ds-empty">（暂无数据）</p>';
    const cs = cols || columnsOf(rows);
    return `<div class="table-wrap ds-table"><table class="grid"><thead><tr>${cs.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, limit || 10).map((r) => `<tr>${cs.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderDs() {
    const root = $('#ds-root');
    if (!root) return;
    const srcP = getSrc('products'), srcS = getSrc('stock');
    const midP = memGet(LS_MID_P, null), midS = memGet(LS_MID_S, null), midSP = memGet(LS_MID_SP, null);
    const fmap = memGet(LS_FMAP, {});
    const csvBtn = (name) => `<button class="btn ghost sm" data-csv="${name}">下载 CSV</button>`;

    const proxyBanner = PROXY_OK === false
      ? '<div class="ds-warn">未检测到本地代理（server.ps1）。API 同步不可用，仅可查看本地已缓存的源表 / 中间表。请在项目目录运行：<code>powershell -ExecutionPolicy Bypass -File server.ps1</code>，然后访问 <code>http://localhost:8766</code>。</div>'
      : (PROXY_OK === true ? '<div class="ds-ok">本地代理已连接（/api/datacube 可用）</div>' : '<div class="ds-muted">正在检测本地代理…</div>');

    root.innerHTML = `
      <div class="panel ds-panel">
        <h2 class="panel-title">接口配置 <small class="ds-sub">只需维护 4 个值，凭证保存在服务端 config.json，不进入页面</small></h2>
        ${proxyBanner}
        <div class="ds-cfg-grid">
          <div class="field"><label>接口地址 baseUrl</label><input id="ds-base" type="text" placeholder="http://114.215.182.158:18182"></div>
          <div class="field"><label>APP Key</label><input id="ds-key" type="text"></div>
          <div class="field"><label>APP Secret</label><input id="ds-secret" type="password" placeholder="已保存则留空不修改"></div>
        </div>
        <div class="ds-cfg-grid">
          <div class="field"><label>产品信息表 · 接口ID</label><input id="ds-p-api" type="text"></div>
          <div class="field"><label>产品信息表 · 数据表ID</label><input id="ds-p-tbl" type="text"></div>
          <div class="field"><label>库存引用表 · 接口ID</label><input id="ds-s-api" type="text"></div>
          <div class="field"><label>库存引用表 · 数据表ID</label><input id="ds-s-tbl" type="text"></div>
        </div>
        <div class="ds-actions"><button class="btn primary" id="ds-save">保存配置</button><span id="ds-save-msg" class="ds-muted"></span></div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">数据同步 <small class="ds-sub">拉取后先存档源表（原始数据 + 拉取时间），再应用算法构建中间表</small></h2>
        <div class="ds-sync-grid">
          <div class="ds-sync-card">
            <h3>产品信息表</h3>
            <div class="ds-kv"><span>源表存档</span><b id="ds-src-p-info">${srcP ? fmtTime(srcP.fetchedAt) + ' · ' + srcP.count + ' 行' : '未拉取'}</b></div>
            <div class="ds-kv"><span>中间表</span><b>${midP ? fmtTime(midP.builtAt) + ' · ' + midP.count + ' 个 SPU' : '未构建'}</b></div>
            <div class="ds-kv"><span>应用层</span><b>${midP && midP.rows.length ? '取中间表 ✓' : '取种子数据（单表处理）'}</b></div>
            <div class="ds-actions">
              <button class="btn primary sm" data-sync="products">拉取源表</button>
              <button class="btn ghost sm" data-build="products">重建中间表</button>
            </div>
            <div class="ds-progress" id="ds-prog-products"></div>
          </div>
          <div class="ds-sync-card">
            <h3>库存引用表 <small class="ds-sub">按日维度，仅存档近 ${STOCK_DAYS} 天</small></h3>
            <div class="ds-kv"><span>源表存档</span><b>${srcS ? fmtTime(srcS.fetchedAt) + ' · ' + srcS.count + ' 行' + (srcS.dropped ? '（过滤 ' + srcS.dropped + ' 行超期）' : '') : '未拉取'}</b></div>
            <div class="ds-kv"><span>商品表聚合库存</span><b>${midSP ? '实际库存数 · ' + midSP.count + ' 个 SKU · ' + fmtTime(midSP.builtAt) : '未构建（拉取商品表后自动生成）'}</b></div>
            <div class="ds-kv"><span>中间表</span><b>${midS ? fmtTime(midS.builtAt) + ' · ' + midS.count + ' 个 SKU（取最新日）' : '未构建'}</b></div>
            <div class="ds-kv"><span>应用层</span><b>${(midSP && midSP.count) || (midS && midS.count) ? '取 API 库存 ✓（商品表实际库存数 + 库存引用表）' : '演示随机库存'}</b></div>
            <div class="ds-actions">
              <button class="btn primary sm" data-sync="stock">拉取源表</button>
              <button class="btn ghost sm" data-build="stock">重建中间表</button>
            </div>
            <div class="ds-progress" id="ds-prog-stock"></div>
          </div>
        </div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">字段映射 <small class="ds-sub">根据接口返回的列名自动匹配，可手工修正后保存</small></h2>
        <div class="ds-map-grid">
          ${mapEditor('products', '产品信息表', srcP ? resolveMap('products', srcP.rows) : null, srcP)}
          ${mapEditor('stock', '库存引用表', srcS ? resolveMap('stock', srcS.rows) : null, srcS)}
        </div>
        <div class="ds-actions"><button class="btn primary" id="ds-save-map">保存映射</button><span id="ds-map-msg" class="ds-muted"></span></div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">源表存档（原始数据，不可变）</h2>
        <h4 class="ds-h4">产品信息表 ${srcP ? '· ' + srcP.count + ' 行 · ' + fmtTime(srcP.fetchedAt) : ''} ${srcP ? csvBtn('products') : ''}</h4>
        ${srcP ? miniTable(srcP.rows) : '<p class="ds-empty">（尚未拉取）</p>'}
        <h4 class="ds-h4">库存引用表 ${srcS ? '· ' + srcS.count + ' 行 · ' + fmtTime(srcS.fetchedAt) : ''} ${srcS ? csvBtn('stock') : ''}</h4>
        ${srcS ? miniTable(srcS.rows) : '<p class="ds-empty">（尚未拉取）</p>'}
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">中间表（源表 + 算法/配置） <small class="ds-sub">应用层全部读取此表</small></h2>
        <h4 class="ds-h4">商品中间表 ${midP ? '· ' + midP.count + ' 个 SPU · 构建于 ' + fmtTime(midP.builtAt) : ''} ${midP ? csvBtn('mid-products') : ''}</h4>
        ${midP ? miniTable(midP.rows.map((p) => ({
          货号: p.spuCode, 品名: p.name, 商品简称: p.spuShort, 类别: p.category, 定位: p.productPos, 等级: p.grade,
          季节: p.season, 过季指数: p.offSeasonIdx, 年实销额: p.annualSales, 吊牌价: p.listPrice, 零售价: p.retailPrice,
          最低折扣: p.minDiscount, 建议最低价: p.minPrice, 红线价: p.redlinePrice, SKU数: p.variants.reduce((a, v) => a + v.colors.reduce((b, c) => b + c.sizes.length, 0), 0),
        })), ['货号', '品名', '商品简称', '类别', '定位', '等级', '季节', '过季指数', '年实销额', '吊牌价', '零售价', '最低折扣', '建议最低价', '红线价', 'SKU数'], 10) : '<p class="ds-empty">（尚未构建）</p>'}
        <h4 class="ds-h4">库存中间表 ${midS ? '· ' + midS.count + ' 条 · 构建于 ' + fmtTime(midS.builtAt) : ''} ${midS ? csvBtn('mid-stock') : ''}</h4>
        ${midS ? miniTable(midS.rows.map((r) => ({ SKU编码: r.code, 颜色: r.color, 尺码: r.size, 库存: r.qty })), ['SKU编码', '颜色', '尺码', '库存'], 10) : '<p class="ds-empty">（尚未构建）</p>'}
        <div class="ds-actions"><button class="btn ghost sm" id="ds-reset">清除全部数据缓存（源表+中间表+映射）</button></div>
      </div>`;

    bindDs();
  }

  function mapEditor(name, label, map, src) {
    const targets = name === 'products' ? TARGETS_P : TARGETS_S;
    const labels = name === 'products' ? LABEL_P : LABEL_S;
    const cols = src ? columnsOf(src.rows) : [];
    const sample = (c) => {
      if (!src || !src.rows) return '';
      for (const r of src.rows.slice(0, 20)) { const v = r[c]; if (v != null && v !== '') return String(v).slice(0, 12); }
      return '';
    };
    if (!map) return `<div class="ds-map-card"><h3>${label}</h3><p class="ds-empty">拉取源表后自动发现字段</p></div>`;
    return `<div class="ds-map-card"><h3>${label}</h3>${Object.keys(targets).map((t) => `
      <div class="ds-map-row"><span class="ds-map-t"><b>${esc(labels[t] || t)}</b><i>${t}</i></span>
        <select data-map-table="${name}" data-map-target="${t}">
          <option value="">（不映射）</option>
          ${cols.map((c) => { const s = sample(c); return `<option value="${esc(c)}" ${map[t] === c ? 'selected' : ''}>${esc(c)}${s ? ' — 例：' + esc(s) : ''}</option>`; }).join('')}
        </select></div>`).join('')}
    </div>`;
  }

  async function bindDs() {
    /* 回填配置 */
    const cfg = await loadConfig();
    if (cfg) {
      $('#ds-base').value = cfg.baseUrl || '';
      $('#ds-key').value = cfg.appKey || '';
      $('#ds-p-api').value = (cfg.tables && cfg.tables.products && cfg.tables.products.apiId) || '';
      $('#ds-p-tbl').value = (cfg.tables && cfg.tables.products && cfg.tables.products.tableId) || '';
      $('#ds-s-api').value = (cfg.tables && cfg.tables.stock && cfg.tables.stock.apiId) || '';
      $('#ds-s-tbl').value = (cfg.tables && cfg.tables.stock && cfg.tables.stock.tableId) || '';
      $('#ds-secret').placeholder = cfg.appSecretSet ? '已保存（留空不修改）' : '未设置';
    }

    $('#ds-save').addEventListener('click', async () => {
      const body = {
        baseUrl: $('#ds-base').value.trim(),
        appKey: $('#ds-key').value.trim(),
        tables: {
          products: { apiId: $('#ds-p-api').value.trim(), tableId: $('#ds-p-tbl').value.trim() },
          stock: { apiId: $('#ds-s-api').value.trim(), tableId: $('#ds-s-tbl').value.trim() },
        },
      };
      if ($('#ds-secret').value.trim()) body.appSecret = $('#ds-secret').value.trim();
      try {
        const j = await saveConfig(body);
        $('#ds-save-msg').textContent = j.success ? '已保存到 config.json' : ('保存失败：' + j.msg);
        toast(j.success ? '配置已保存' : '配置保存失败');
      } catch (e) { $('#ds-save-msg').textContent = '保存失败：' + e.message; }
    });

    $$('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.sync;
      const prog = $('#ds-prog-' + name);
      b.disabled = true;
      prog.textContent = '拉取中…';
      try {
        const src = await fetchTable(name, (n, total, note) => {
          prog.textContent = note ? note : `已拉取 ${n}${total ? ' / ' + total : ''} 行…`;
        });
        const dropTxt = src.dropped ? `（过滤 ${src.dropped} 行超 ${STOCK_DAYS} 天）` : '';
        const mid = name === 'products' ? buildMidProducts() : buildMidStock();
        if (src.unchanged) {
          prog.textContent = `数据未变化（${src.count} 行），跳过同步`;
          toast('数据未变化，无需更新');
        } else {
          prog.textContent = `完成：源表 ${src.count} 行${dropTxt} → 中间表 ${mid ? mid.count : 0} ${name === 'products' ? '个 SPU' : '个 SKU'}`;
          toast(name === 'products' ? '产品数据已更新，已同步到活动申请' : '库存数据已更新，已同步到活动申请');
        }
        notifyApp();
        renderDs();
      } catch (e) {
        prog.textContent = '拉取失败：' + e.message;
        toast('拉取失败：' + e.message);
      } finally { b.disabled = false; }
    }));

    $$('[data-csv]').forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.csv;
      const d = new Date(), p = (x) => String(x).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
      if (kind === 'products') { const s = getSrc('products'); downloadCsv(s && s.rows, `产品信息表_源表_${stamp}.csv`); }
      else if (kind === 'stock') { const s = getSrc('stock'); downloadCsv(s && s.rows, `库存引用表_源表_${stamp}.csv`); }
      else if (kind === 'mid-products') { const m = memGet(LS_MID_P, null); downloadCsv(m && m.rows, `商品中间表_${stamp}.csv`); }
      else if (kind === 'mid-stock') { const m = memGet(LS_MID_S, null); downloadCsv(m && m.rows, `库存中间表_${stamp}.csv`); }
    }));

    $$('[data-build]').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.build;
      const mid = name === 'products' ? buildMidProducts() : buildMidStock();
      if (!mid) { toast('请先拉取源表'); return; }
      toast('中间表已重建：' + mid.count + ' 条，已同步到活动申请');
      notifyApp();
      renderDs();
    }));

    $('#ds-save-map') && $('#ds-save-map').addEventListener('click', () => {
      const fmap = memGet(LS_FMAP, {});
      $$('[data-map-table]').forEach((sel) => {
        const t = sel.dataset.mapTable, k = sel.dataset.mapTarget;
        (fmap[t] = fmap[t] || {})[k] = sel.value;
      });
      memSet(LS_FMAP, fmap);
      /* 立即按新映射重建中间表并同步应用层 */
      const midP = buildMidProducts(), midS = buildMidStock();
      const parts = [];
      if (midP) parts.push('商品 ' + midP.count + ' SPU');
      if (midS) parts.push('库存 ' + midS.count + ' SKU');
      notifyApp();
      $('#ds-map-msg').textContent = parts.length ? '映射已保存，中间表已重建：' + parts.join('，') : '映射已保存（尚无源表，拉取后生效）';
      toast('字段映射已保存');
      renderDs();
    });

    $('#ds-reset') && $('#ds-reset').addEventListener('click', () => {
      if (!confirm('确认清除全部源表 / 中间表 / 字段映射缓存？（不影响申请与归档数据）')) return;
      ALL_KEYS.forEach((k) => memDel(k));
      toast('数据缓存已清除，已恢复种子数据');
      notifyApp();
      renderDs();
    });
  }

  /* ---------- 启动 ---------- */
  ensureTab();
  applyToApp();
  hydrateFromIdb().then(() => {
    /* 库存引用源口径变更（public→actual）后，旧库存索引/映射键已作废；
     * 若已有产品源表则按新映射自动重建中间表+库存索引，无需用户重拉 */
    try {
      const srcP = getSrc('products');
      if (srcP && srcP.rows && srcP.rows.length) {
        const sp = memGet(LS_MID_SP, null);
        const stale = !sp || !sp.map || !Object.keys(sp.map).length ||
          (srcP.fetchedAt && sp.builtAt && new Date(srcP.fetchedAt) > new Date(sp.builtAt));
        if (stale) { buildMidProducts(); notifyApp(); }
      }
    } catch (e) {}
    /* 清理被取代的旧键 */
    ['mkt_fieldmap_v2', 'mkt_mid_stock_from_products_v1'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} idbDel(k); });
    if ($('#ds-root')) renderDs();
  });
  checkProxy().then(() => { if ($('#ds-root')) renderDs(); });

  /* 切到数据源 tab 时渲染 */
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.tab');
    if (t && t.dataset.view === 'datasource' && $('#ds-root')) renderDs();
  });
})();

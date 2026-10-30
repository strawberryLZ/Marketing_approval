/* ===== 数据源模块（三层架构） =====
 * 1. 源表：服务端 PostgreSQL 正式快照；浏览器仅保存当前页面内存副本
 * 2. 中间表：源表 + 字段映射 + 算法/配置（等级规则、红线价、SKU 展开）→ 应用层全部取中间表
 * 3. 应用层：app.js 初始化时若存在中间表则覆盖演示数据
 * 凭证只维护 4 个值：APP Key / APP Secret / 接口ID(apiId) / 数据表ID(tableId)，
 * 产品源表字段按同义词自动识别；店铺 - 平台关系在面板中维护。 */
(function () {
  const LS_SRC_P = 'mkt_src_products_v1';
  const LS_SRC_S = 'mkt_src_stock_v1';
  const LS_MID_P = 'mkt_mid_products_v2'; /* v2：字段体系按《单表处理》27 列重构，旧中间表作废 */
  const LS_MID_S = 'mkt_mid_stock_v1';
  const LS_MID_SP = 'mkt_mid_stock_from_products_v2'; /* v2：库存引用源改为「实际库存数 actual_stock」，旧 public 口径索引作废 */
  const LS_FMAP = 'mkt_fieldmap_v3'; /* v3：stock 目标改指向 actual_stock，旧映射作废重匹配 */
  const LS_STORE_PLATFORM_MAP = 'mkt_store_platform_map_v1';
  const PAGE_SIZE = 200;

  /* 店铺资料（店铺名称 / 所属平台）初始值；在数据源「字段映射」中可维护。 */
  const DEFAULT_STORE_PLATFORM_MAP = [
    { store: '得物-飞比特旗舰店', platform: '得物' },
    { store: '抖音-FlipBelt飞比特', platform: '抖音' },
    { store: '抖音-飞比特官方旗舰店', platform: '抖音' },
    { store: '抖音-越野旗舰店', platform: '抖音' },
    { store: '抖音-运动旗舰店', platform: '抖音' },
    { store: '京东-Flipbelt运动旗舰店', platform: '京东' },
    { store: '京东-京东自营旗舰店', platform: '京东' },
    { store: '拼多多-Flipbelt运动旗舰店', platform: '拼多多' },
    { store: '拼多多-飞比特官方旗舰店', platform: '拼多多' },
    { store: '视频号-FlipBelt飞比特运动', platform: '微信视频号' },
    { store: '视频号-FlipBelt户外运动', platform: '微信视频号' },
    { store: '视频号-FLIPBELT运动', platform: '微信视频号' },
    { store: '视频号-飞比特运动店', platform: '微信视频号' },
    { store: '天猫-flipbelt乐跑体育专卖店', platform: '淘宝天猫' },
    { store: '天猫-flipbelt运动户外旗舰店', platform: '淘宝天猫' },
    { store: '小程序-FlipBelt飞比特官方商城', platform: '私域' },
    { store: '小红书-FlipBelt飞比特旗舰店', platform: '小红书' },
  ];

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
  /* ---------- 页面内存层：数据源持久化只在服务端，刷新页面后必须重新读取正式快照。 ---------- */
  const ALL_KEYS = [LS_SRC_P, LS_SRC_S, LS_MID_P, LS_MID_S, LS_MID_SP, LS_FMAP, LS_STORE_PLATFORM_MAP];
  const MEM = {};
  ALL_KEYS.forEach((k) => { MEM[k] = null; });

  /* 同步读写只限当前页内存；不得写入或读取浏览器持久化存储。 */
  const memGet = (k, dft) => { const v = MEM[k]; return v == null ? (dft === undefined ? null : dft) : v; };
  function memSet(k, v) { MEM[k] = v; }
  function memDel(k) { MEM[k] = null; }

  function cleanStorePlatformRows(rows) {
    const seen = new Set();
    return (Array.isArray(rows) ? rows : []).reduce((out, row) => {
      const store = String((row && row.store) || '').trim();
      const platform = String((row && row.platform) || '').trim();
      const key = platform + '\u0000' + store;
      if (store && platform && !seen.has(key)) { seen.add(key); out.push({ store, platform }); }
      return out;
    }, []);
  }

  function storePlatformRows() {
    const saved = cleanStorePlatformRows(memGet(LS_STORE_PLATFORM_MAP, null));
    return saved.length ? saved : DEFAULT_STORE_PLATFORM_MAP.map((row) => ({ ...row }));
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
    if (!ct.includes('json')) throw new Error('非 JSON 响应：请用 node serve.js（http://localhost:8760）或 server.ps1（http://localhost:8766）打开页面后再操作接口；直接双击 file:// 打开无法调用 /api');
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

  /* 企业正式快照是唯一跨设备数据来源；浏览器 IndexedDB 仅保留离线展示副本。 */
  async function loadEnterpriseSnapshot() {
    let j;
    try { j = await api('/api/datasource/current', { cache: 'no-store' }); } catch (e) { return false; }
    if (!j || !j.success || !j.snapshot || !Array.isArray(j.snapshot.products)) return false;
    const snap = j.snapshot, settings = j.settings || {};
    const products = { fetchedAt: snap.createdAt, count: snap.products.length, hash: snap.productsHash || '', rows: snap.products };
    const stock = Array.isArray(snap.stock) ? { fetchedAt: snap.createdAt, count: snap.stock.length, hash: snap.stockHash || '', rows: snap.stock } : null;
    memSet(LS_SRC_P, products);
    memSet(LS_SRC_S, stock);
    if (settings.fieldMap && typeof settings.fieldMap === 'object') memSet(LS_FMAP, settings.fieldMap);
    if (Array.isArray(settings.storePlatformMap)) memSet(LS_STORE_PLATFORM_MAP, cleanStorePlatformRows(settings.storePlatformMap));
    buildMidProducts();
    if (stock) buildMidStock();
    notifyApp();
    return true;
  }

  /* 分页拉全量 → 源表存档 {fetchedAt, count, hash, rows}
   * 库存表：拉取后按日期列过滤，仅存档近 STOCK_DAYS 天（日维度）；
   * 与上次内容一致 → 不改变当前页面数据；企业正式版本由服务端内容指纹决定。
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

  /* ---------- 源表当前页副本：正式持久化由服务端 PostgreSQL 负责 ---------- */

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
   * 建议最低价 = 规则价/表内最低价 兜底后，再与页面红线价取 max（红线价=人工重算成本毛利的地板价，不得低于）。 */
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
      let baseSuggest = minD != null && retail != null ? Math.round(retail * minD / 10 * 100) / 100 : num(pick('minPrice'));
      const redline = num(pick('redlinePrice'));
      let redlineApplied = false;
      let suggestMin = baseSuggest;
      /* 红线价=人工重算成本毛利后的最低可售价，作为地板：建议价不得低于红线价 → 取较高者 */
      if (redline != null) { if (suggestMin == null || redline > suggestMin) { suggestMin = redline; redlineApplied = true; } }
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

  window.MKT_DS = { applyToApp, stockMap, buildMidProducts, buildMidStock, fetchTable, loadConfig, saveConfig, loadEnterpriseSnapshot, refreshAccess: ensureTab, checkProxy, fmtTime, columnsOf, autoMap, TARGETS_P, TARGETS_S, notifyApp,
    srcOf: (n) => memGet(n === 'products' ? LS_SRC_P : LS_SRC_S, null),
    midOf: (n) => memGet(n === 'products' ? LS_MID_P : LS_MID_S, null),
    mapOf: () => memGet(LS_FMAP, {}),
    setMap: (m) => memSet(LS_FMAP, m),
    storePlatformRows };

  /* ---------- 「数据源」Tab UI（运行时注入，防 index.html 回退） ---------- */
  async function canAccessDataSource() {
    try {
      const r = await fetch('/api/datasource/access', { cache: 'no-store' });
      const j = await r.json();
      return !!(r.ok && j && j.allowed);
    } catch (e) { return false; }
  }

  async function ensureTab() {
    const allowed = await canAccessDataSource();
    if (!allowed) {
      const existingTab = document.querySelector('.tab[data-view="datasource"]');
      const existingView = document.querySelector('#view-datasource');
      if (existingTab) existingTab.remove();
      if (existingView) existingView.remove();
      return;
    }
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

  let DING_SCHEMA = null; /* 最近一次拉取的审批表单结构，用于字段映射预览 */
  function dingSchemaPanelHtml() {
    if (!DING_SCHEMA) {
      return '<h2 class="panel-title">审批表单字段 <small class="ds-sub">点上方「测试连通 · 拉取表单结构」按 processCode 拉取钉钉表单控件，用于后续字段映射</small></h2><p class="ds-empty">（尚未拉取表单结构）</p>';
    }
    const rows = [];
    const flat = (arr, depth) => (arr || []).forEach((it) => {
      const p = it.props || {};
      const label = Array.isArray(p.label) ? p.label.join(' ~ ') : (p.label || '');
      rows.push(`<tr><td style="padding-left:${6 + depth * 16}px">${'· '.repeat(depth)}${esc(it.componentName || '')}</td><td>${esc(label)}</td><td class="cell-sub">${esc(p.id || '')}</td><td class="cell-sub">${esc(p.bizAlias || '—')}</td><td>${p.required === true ? '<b style="color:var(--red)">必填</b>' : (p.required === false ? '选填' : '—')}</td></tr>`);
      if (Array.isArray(it.children)) flat(it.children, depth + 1);
    });
    flat(DING_SCHEMA.items, 0);
    const tree = rows.length
      ? `<div class="table-wrap ds-table"><table class="grid"><thead><tr><th>控件类型 componentName</th><th>标题 label</th><th>字段ID id</th><th>bizAlias</th><th>必填</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<p class="ds-empty">（该表单无控件）</p>';
    return `<h2 class="panel-title">审批表单字段 <small class="ds-sub">processCode：${esc(DING_SCHEMA.processCode || '')}　表单名：${esc(DING_SCHEMA.title || '')}　共 ${(DING_SCHEMA.items || []).length} 个顶层控件　拉取于 ${fmtTime(DING_SCHEMA.at)}</small></h2>${tree}`;
  }

  function renderDs() {
    const root = $('#ds-root');
    if (!root) return;
    const srcP = getSrc('products'), srcS = getSrc('stock');
    const midP = memGet(LS_MID_P, null), midS = memGet(LS_MID_S, null), midSP = memGet(LS_MID_SP, null);
    const fmap = memGet(LS_FMAP, {});
    const csvBtn = (name) => `<button class="btn ghost sm" data-csv="${name}">下载 CSV</button>`;

    const proxyBanner = PROXY_OK === false
      ? '<div class="ds-warn">未检测到接口服务，API 配置与拉取不可用，仅可查看本地已缓存的源表 / 中间表。请在项目目录运行 <code>node serve.js</code> 后访问 <code>http://localhost:8760</code>（或运行 <code>powershell -ExecutionPolicy Bypass -File server.ps1</code> 访问 <code>http://localhost:8766</code>）。</div>'
      : (PROXY_OK === true ? '<div class="ds-ok">接口服务已连接（/api/config、/api/datacube 可用）</div>' : '<div class="ds-muted">正在检测接口服务…</div>');

    root.innerHTML = `
      <div class="panel ds-panel">
        <h2 class="panel-title">接口配置 <small class="ds-sub">数据魔方 + OA审批 两套凭证；凭证只保存在服务端 config.json，不进入页面（Secret 提交后不回显，留空即不修改）</small></h2>
        ${proxyBanner}
        <div class="ds-cfg-grid">
          <div class="field"><label>数据魔方 · 接口地址 baseUrl</label><input id="ds-base" type="text" placeholder="http://114.215.182.158:18182"></div>
          <div class="field"><label>数据魔方 · APP Key</label><input id="ds-key" type="text"></div>
          <div class="field"><label>数据魔方 · APP Secret</label><input id="ds-secret" type="password" placeholder="已保存则留空不修改"></div>
        </div>
        <div class="ds-cfg-grid">
          <div class="field"><label>产品信息表 · 接口ID</label><input id="ds-p-api" type="text"></div>
          <div class="field"><label>产品信息表 · 数据表ID</label><input id="ds-p-tbl" type="text"></div>
        </div>
        <div class="ds-cfg-grid">
          <div class="field"><label>独立库存表 · 接口ID（可选）</label><input id="ds-s-api" type="text" placeholder="未设置时使用产品表内实际库存数"></div>
          <div class="field"><label>独立库存表 · 数据表ID（可选）</label><input id="ds-s-tbl" type="text"></div>
        </div>
        <div class="ds-cfg-grid">
          <div class="field"><label>OA审批 · APP Key</label><input id="ds-oa-key" type="text"></div>
          <div class="field"><label>OA审批 · APP Secret</label><input id="ds-oa-secret" type="password" placeholder="已保存则留空不修改"></div>
          <div class="field"><label>OA审批 · 表单ID（processCode）</label><input id="ds-oa-code" type="text" placeholder="PROC-XXXXXXXX-XXXX-..."></div>
          <div class="field"><label>OA审批 · 免登 corpId</label><input id="ds-oa-corp" type="text" placeholder="钉钉企业 corpId（免登用）"></div>
          <div class="field"><label>默认发起人 UserId</label><input id="ds-oa-uid" type="text" placeholder="仅浏览器无免登身份时回退用；真实提交以当前登录人为准"></div>
        </div>
        <div class="ds-cfg-grid">
          <div class="field"><label>在线表归档 · 知识库 workspaceId</label><input id="ds-arch-ws" type="text" placeholder="团队知识库真实ID（非个人空间），如 l2Amo…"></div>
          <div class="field"><label>在线表归档 · 文件夹 dentryUuid</label><input id="ds-arch-did" type="text" placeholder="归档文件夹的 dentryUuid 字符串（create-doc 只认它，数字会落根目录）"></div>
        </div>
        <div class="ds-actions"><button class="btn primary" id="ds-save">保存配置</button><button class="btn ghost" id="ds-ding-test">测试连通 · 拉取表单结构</button><span id="ds-ding-msg" class="ds-muted"></span><span id="ds-save-msg" class="ds-muted"></span></div>
      </div>

      <div class="panel ds-panel">
        ${dingSchemaPanelHtml()}
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">数据同步 <small class="ds-sub">服务端定时拉取；仅完整校验通过时发布企业正式快照</small></h2>
        <div id="ds-sync-server-status" class="ds-muted">正在读取服务端同步状态…</div>
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
        </div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">字段映射 <small class="ds-sub">根据产品信息接口返回的列名自动匹配，可手工修正后保存</small></h2>
        <div class="ds-map-grid">
          ${mapEditor('products', '产品信息表', srcP ? resolveMap('products', srcP.rows) : null, srcP)}
        </div>
        <div class="ds-actions"><button class="btn primary" id="ds-save-field-map">保存字段映射</button><span id="ds-field-map-msg" class="ds-muted"></span></div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">店铺·平台映射 <small class="ds-sub">店铺资料中的店铺与平台关系，可手工修正后保存</small></h2>
        <div class="ds-map-grid">
          ${storePlatformMapEditor()}
        </div>
        <div class="ds-actions"><button class="btn ghost" id="ds-add-store-map">新增关系</button><button class="btn primary" id="ds-save-map">保存店铺·平台映射</button><span id="ds-map-msg" class="ds-muted"></span></div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">源表存档（原始数据，不可变）</h2>
        <h4 class="ds-h4">产品信息表 ${srcP ? '· ' + srcP.count + ' 行 · ' + fmtTime(srcP.fetchedAt) : ''} ${srcP ? csvBtn('products') : ''}</h4>
        ${srcP ? miniTable(srcP.rows) : '<p class="ds-empty">（尚未拉取）</p>'}
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">中间表（源表 + 算法/配置） <small class="ds-sub">应用层全部读取此表</small></h2>
        <h4 class="ds-h4">商品中间表 ${midP ? '· ' + midP.count + ' 个 SPU · 构建于 ' + fmtTime(midP.builtAt) : ''} ${midP ? csvBtn('mid-products') : ''}</h4>
        ${midP ? miniTable(midP.rows.map((p) => ({
          货号: p.spuCode, 品名: p.name, 商品简称: p.spuShort, 类别: p.category, 定位: p.productPos, 等级: p.grade,
          季节: p.season, 过季指数: p.offSeasonIdx, 年实销额: p.annualSales, 吊牌价: p.listPrice, 零售价: p.retailPrice,
          最低折扣: p.minDiscount, 建议最低价: p.minPrice, 红线价: p.redlinePrice, SKU数: p.variants.reduce((a, v) => a + v.colors.reduce((b, c) => b + c.sizes.length, 0), 0),
        })), ['货号', '品名', '商品简称', '类别', '定位', '等级', '季节', '过季指数', '年实销额', '吊牌价', '零售价', '最低折扣', '建议最低价', '红线价', 'SKU数'], 10) : '<p class="ds-empty">（尚未构建）</p>'}
        <div class="ds-actions"><button class="btn ghost sm" id="ds-reset">清除全部数据缓存（源表+中间表+映射）</button></div>
      </div>

      <div class="panel ds-panel">
        <h2 class="panel-title">正式数据版本</h2>
        <p class="ds-muted">商品、库存快照及同步记录均由服务器保存。当前页面关闭或刷新后不会使用浏览器本地数据，登录后将重新读取服务器正式版本。</p>
      </div>

      `;

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

  function storePlatformMapRow(row) {
    return `<div class="ds-map-row" data-store-map-row>
      <input data-store-map-store type="text" value="${esc(row.store || '')}" placeholder="店铺名称">
      <input data-store-map-platform type="text" value="${esc(row.platform || '')}" placeholder="所属平台">
      <button class="btn ghost sm" type="button" data-store-map-remove>删除</button>
    </div>`;
  }

  function storePlatformMapEditor() {
    const rows = storePlatformRows();
    return `<div class="ds-map-card ds-store-platform-map"><h3>店铺 - 平台关系 <small class="ds-sub">共 ${rows.length} 条</small></h3>
      <div class="ds-map-row ds-map-head"><span>店铺</span><span>平台</span><span></span></div>
      <div id="ds-store-map-rows">${rows.map(storePlatformMapRow).join('')}</div>
    </div>`;
  }

  async function fillServerSyncStatus() {
    const host = $('#ds-sync-server-status');
    if (!host) return;
    try {
      const r = await api('/api/datasource/status', { cache: 'no-store' });
      if (!r.success) throw new Error(r.msg || '读取失败');
      const state = r.state || {}, latest = (r.runs || [])[0];
      const current = state.running ? '正在同步' : (state.lastResult || '尚未执行');
      const who = latest && latest.actor_name ? ('，操作人：' + latest.actor_name) : (latest && latest.trigger === 'scheduled' ? '，操作人：系统计划任务' : '');
      const detail = latest ? `；最近一次：${latest.status}，${latest.finished_at ? fmtTime(latest.finished_at) : '—'}${who}${latest.error_message ? '（' + latest.error_message + '）' : ''}` : '';
      host.textContent = `数据库：${state.database || '—'}；当前：${current}${detail}`;
    } catch (e) { host.textContent = '同步状态暂不可读：' + e.message; }
  }

  async function bindDs() {
    /* 回填配置 */
    const cfg = await loadConfig();
    if (cfg) {
      $('#ds-base').value = cfg.baseUrl || '';
      $('#ds-key').value = '';
      $('#ds-key').placeholder = cfg.appKeyConfigured ? '已保存（留空不修改）' : '未设置';
      $('#ds-p-api').value = (cfg.tables && cfg.tables.products && cfg.tables.products.apiId) || '';
      $('#ds-p-tbl').value = (cfg.tables && cfg.tables.products && cfg.tables.products.tableId) || '';
      $('#ds-s-api').value = (cfg.tables && cfg.tables.stock && cfg.tables.stock.apiId) || '';
      $('#ds-s-tbl').value = (cfg.tables && cfg.tables.stock && cfg.tables.stock.tableId) || '';
      $('#ds-secret').placeholder = cfg.appSecretSet ? '已保存（留空不修改）' : '未设置';
      const oa = cfg.oa || {};
      $('#ds-oa-key').value = '';
      $('#ds-oa-key').placeholder = oa.appKeyConfigured ? '已保存（留空不修改）' : '未设置';
      $('#ds-oa-code').value = oa.processCode || '';
      $('#ds-oa-corp').value = oa.corpId || '';
      $('#ds-oa-uid').value = oa.originatorUserId || '';
      $('#ds-arch-ws').value = oa.archiveWorkspaceId || '';
      $('#ds-arch-did').value = oa.archiveParentNodeId || '';
      $('#ds-oa-secret').placeholder = oa.appSecretSet ? '已保存（留空不修改）' : '未设置';
      const settings = cfg.dataSource || {};
      if (settings.fieldMap && typeof settings.fieldMap === 'object') memSet(LS_FMAP, settings.fieldMap);
      if (Array.isArray(settings.storePlatformMap)) memSet(LS_STORE_PLATFORM_MAP, cleanStorePlatformRows(settings.storePlatformMap));
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
      const oaKey = $('#ds-oa-key').value.trim();
      const oaSecret = $('#ds-oa-secret').value.trim();
      const oaCode = $('#ds-oa-code').value.trim();
      const oaUid = $('#ds-oa-uid').value.trim();
      const oaCorp = $('#ds-oa-corp').value.trim();
      const archWs = $('#ds-arch-ws').value.trim();
      const archDid = $('#ds-arch-did').value.trim();
      if (oaKey || oaSecret || oaCode || oaUid || oaCorp || archWs || archDid) { body.oa = {}; if (oaKey) body.oa.appKey = oaKey; if (oaSecret) body.oa.appSecret = oaSecret; if (oaCode) body.oa.processCode = oaCode; if (oaUid) body.oa.originatorUserId = oaUid; if (oaCorp) body.oa.corpId = oaCorp; if (archWs) body.oa.archiveWorkspaceId = archWs; if (archDid) body.oa.archiveParentNodeId = archDid; }
      try {
        const j = await saveConfig(body);
        $('#ds-save-msg').textContent = j.success ? '已保存到服务端配置' : ('保存失败：' + j.msg);
        toast(j.success ? '配置已保存' : '配置保存失败');
        renderDs();
      } catch (e) { $('#ds-save-msg').textContent = '保存失败：' + e.message; }
    });

    $('#ds-ding-test') && $('#ds-ding-test').addEventListener('click', async () => {
      const msg = $('#ds-ding-msg');
      if (msg) msg.textContent = '正在连通钉钉并拉取表单结构…';
      try {
        const code = ($('#ds-oa-code') && $('#ds-oa-code').value.trim()) || '';
        const r = await fetch('/api/ding/schema', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ processCode: code }) });
        const j = await r.json();
        if (!j.success) {
          if (msg) msg.textContent = '失败：' + (j.msg || ('HTTP ' + j.httpStatus + (j.raw ? ' · ' + j.raw : '')));
          toast('拉取表单结构失败'); renderDs(); return;
        }
        const res = (j.data && j.data.result) || {};
        const sc = res.schemaContent || {};
        DING_SCHEMA = { processCode: j.processCode, title: sc.title || res.name || '', items: sc.items || [], at: new Date().toISOString(), raw: j.data };
        if (msg) msg.textContent = '已连接 · 顶层控件 ' + DING_SCHEMA.items.length + ' 个';
        toast('已拉取审批表单结构');
      } catch (e) { if (msg) msg.textContent = '请求失败：' + e.message; toast('拉取失败'); }
      renderDs();
    });

    $$('[data-sync]').forEach((b) => b.addEventListener('click', async () => {
      const name = b.dataset.sync;
      const prog = $('#ds-prog-' + name);
      b.disabled = true;
      prog.textContent = '已提交服务端同步任务…';
      try {
        const result = await api('/api/datasource/sync', { method: 'POST' });
        if (!result.success) throw new Error(result.msg || result.error || '服务端同步未启动');
        prog.textContent = result.msg || '服务端同步进行中…';
        toast(result.accepted ? '已启动服务端同步' : '已有同步任务正在执行');
        setTimeout(async () => { await loadEnterpriseSnapshot(); await fillServerSyncStatus(); if ($('#ds-root')) renderDs(); }, 5000);
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
      else if (kind === 'mid-products') { const m = memGet(LS_MID_P, null); downloadCsv(m && m.rows, `商品中间表_${stamp}.csv`); }
    }));

    $$('[data-build]').forEach((b) => b.addEventListener('click', () => {
      const name = b.dataset.build;
      const mid = name === 'products' ? buildMidProducts() : buildMidStock();
      if (!mid) { toast('请先拉取源表'); return; }
      toast('中间表已重建：' + mid.count + ' 条，已同步到活动申请');
      notifyApp();
      renderDs();
    }));

    $('#ds-save-field-map') && $('#ds-save-field-map').addEventListener('click', async () => {
      const next = { ...(memGet(LS_FMAP, {}) || {}) };
      const tables = new Set();
      $$('[data-map-table]').forEach((select) => tables.add(select.dataset.mapTable));
      if (!tables.size) {
        $('#ds-field-map-msg').textContent = '请先拉取产品信息表，再调整字段映射';
        toast('暂无可保存的字段映射');
        return;
      }
      tables.forEach((name) => {
        const map = {};
        $$(`[data-map-table="${name}"]`).forEach((select) => { map[select.dataset.mapTarget] = select.value; });
        next[name] = map;
      });
      try {
        const saved = await saveConfig({ dataSource: { fieldMap: next } });
        if (!saved.success) throw new Error(saved.msg || '服务端保存失败');
      } catch (e) {
        $('#ds-field-map-msg').textContent = '字段映射保存失败：' + e.message;
        toast('字段映射未保存');
        return;
      }
      memSet(LS_FMAP, next);
      const products = getSrc('products');
      if (tables.has('products') && products && products.rows && products.rows.length) buildMidProducts();
      notifyApp();
      $('#ds-field-map-msg').textContent = '字段映射已保存，产品中间表已按新映射更新';
      toast('字段映射已保存');
      renderDs();
    });

    $('#ds-add-store-map') && $('#ds-add-store-map').addEventListener('click', () => {
      const rows = $('#ds-store-map-rows');
      if (rows) rows.insertAdjacentHTML('beforeend', storePlatformMapRow({ store: '', platform: '' }));
    });

    $('#ds-store-map-rows') && $('#ds-store-map-rows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-store-map-remove]');
      if (button) button.closest('[data-store-map-row]').remove();
    });

    $('#ds-save-map') && $('#ds-save-map').addEventListener('click', async () => {
      const rows = cleanStorePlatformRows($$('[data-store-map-row]').map((row) => ({
        store: row.querySelector('[data-store-map-store]').value,
        platform: row.querySelector('[data-store-map-platform]').value,
      })));
      if (!rows.length) {
        $('#ds-map-msg').textContent = '请至少保留一条完整的店铺 - 平台关系';
        toast('店铺 - 平台关系不能为空');
        return;
      }
      try {
        const saved = await saveConfig({ dataSource: { storePlatformMap: rows } });
        if (!saved.success) throw new Error(saved.msg || '服务端保存失败');
      } catch (e) {
        $('#ds-map-msg').textContent = '店铺·平台映射保存失败：' + e.message;
        toast('店铺·平台映射未保存');
        return;
      }
      memSet(LS_STORE_PLATFORM_MAP, rows);
      if (typeof window.MKT_ON_STORE_PLATFORM_MAP === 'function') window.MKT_ON_STORE_PLATFORM_MAP();
      $('#ds-map-msg').textContent = `已保存 ${rows.length} 条店铺 - 平台关系，手工填价申请已更新`;
      toast('店铺 - 平台关系已保存');
      renderDs();
    });

    $('#ds-reset') && $('#ds-reset').addEventListener('click', async () => {
      if (!confirm('确认仅清除当前页面内存中的数据源副本？不会删除服务器正式数据。刷新页面后将重新读取服务器数据。')) return;
      ALL_KEYS.forEach((k) => memDel(k));
      toast('当前页面数据已清除；服务器正式数据未受影响');
      notifyApp();
      renderDs();
    });

    void fillServerSyncStatus();
  }

  /* ---------- 启动 ---------- */
  void ensureTab();
  applyToApp();
  Promise.resolve().then(() => {
    /* 计算逻辑版本升级（红线价地板等）→ 作废旧中间表缓存并按新逻辑重建，无需手点重建 */
    try {
      const MID_LOGIC_VER = 'redline-floor-v2', LS_MIDVER = 'mkt_mid_logic_v';
      if (memGet(LS_MIDVER, null) !== MID_LOGIC_VER) {
        memDel(LS_MID_P); memDel(LS_MID_S); memDel(LS_MID_SP);
        memSet(LS_MIDVER, MID_LOGIC_VER);
        const sp0 = getSrc('products');
        if (sp0 && sp0.rows && sp0.rows.length) { buildMidProducts(); notifyApp(); }
      }
    } catch (e) {}
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
    if ($('#ds-root')) renderDs();
  });
  checkProxy().then(() => { if ($('#ds-root')) renderDs(); });

  /* 切到数据源 tab 时渲染 */
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('.tab');
    if (t && t.dataset.view === 'datasource' && $('#ds-root')) renderDs();
  });
})();

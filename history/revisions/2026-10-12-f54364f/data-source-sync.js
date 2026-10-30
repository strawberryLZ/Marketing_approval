/* 企业数据源同步：服务端拉取、内容校验、版本化发布。凭证始终由调用方的 config.json 提供。 */
const crypto = require('crypto');

const PAGE_SIZE = 200;
const MAX_PAGES = 40;
const PRODUCT_ROUNDS = 6;
const MIN_ROW_RATIO = 0.5;

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  if (typeof value === 'string') return value.normalize('NFC').trim();
  return value;
}

function stableRowsHash(rows) {
  const lines = (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(canonical(row))).sort();
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

function validateSnapshot(next, previous) {
  const products = Array.isArray(next.products) ? next.products : [];
  const stock = next.stock;
  if (!products.length) throw new Error('商品表返回 0 行，已拒绝发布以保护现有正式数据');
  const priorProducts = previous && Number(previous.products_count != null ? previous.products_count : previous.productsCount || 0);
  if (priorProducts && products.length < Math.ceil(priorProducts * MIN_ROW_RATIO)) {
    throw new Error(`商品表行数异常下降：${products.length} 行，上一正式版本 ${priorProducts} 行`);
  }
  if (next.stockEnabled) {
    if (!Array.isArray(stock) || !stock.length) throw new Error('库存表返回 0 行，已拒绝发布以保护现有正式数据');
    const priorStock = previous && Number(previous.stock_count != null ? previous.stock_count : previous.stockCount || 0);
    if (priorStock && stock.length < Math.ceil(priorStock * MIN_ROW_RATIO)) {
      throw new Error(`库存表行数异常下降：${stock.length} 行，上一正式版本 ${priorStock} 行`);
    }
  }
}

function dataCubeConfigured(cfg, name) {
  const table = cfg && cfg.tables && cfg.tables[name];
  return !!(cfg && cfg.baseUrl && cfg.appKey && cfg.appSecret && table && table.apiId);
}

function dataCubeSign(params, secret) {
  const raw = Object.keys(params).sort().map((key) => key + params[key]).join('') + secret;
  return crypto.createHash('md5').update(Buffer.from(raw, 'utf8')).digest('hex').toUpperCase();
}

async function requestPage(cfg, name, pageIndex) {
  const table = cfg.tables[name];
  const timestamp = Date.now().toString();
  const payload = { apiId: table.apiId, pageIndex, pageSize: PAGE_SIZE };
  if (table.tableId) payload.tableId = table.tableId;
  const response = await fetch(String(cfg.baseUrl).replace(/\/+$/, '') + '/api/assetOpenApi/queryData', {
    method: 'POST',
    headers: { appKey: cfg.appKey, timestamp, sign: dataCubeSign({ timestamp }, cfg.appSecret), 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('上游返回非 JSON（HTTP ' + response.status + '）'); }
  const okCode = !json.code || String(json.code) === '0' || String(json.code) === '200';
  if (!response.ok || json.success === false || !okCode) throw new Error('接口返回异常' + (json.code ? ' code=' + json.code : '') + (json.msg ? '：' + json.msg : ''));
  const rows = Array.isArray(json.data) ? json.data : (json.data && Array.isArray(json.data.records) ? json.data.records : []);
  const total = json.total != null ? Number(json.total) : (json.data && json.data.total != null ? Number(json.data.total) : null);
  return { rows, total };
}

async function pullOnce(cfg, name) {
  const all = [];
  let previousSignature = '';
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await requestPage(cfg, name, page);
    const signature = result.rows.length ? JSON.stringify(canonical(result.rows[0])).slice(0, 400) + '#' + result.rows.length : 'empty';
    if (signature === previousSignature) break; // 上游忽略 pageIndex 时防止死循环
    previousSignature = signature;
    all.push(...result.rows);
    if (result.rows.length < PAGE_SIZE || (result.total != null && all.length >= result.total)) return all;
  }
  if (all.length && previousSignature !== 'empty') throw new Error(name + ' 分页超过 ' + MAX_PAGES + ' 页，已中止');
  return all;
}

async function pullTable(cfg, name) {
  if (name !== 'products') return pullOnce(cfg, name);
  const unique = new Map();
  let added = 0;
  for (let round = 0; round < PRODUCT_ROUNDS; round++) {
    const rows = await pullOnce(cfg, name);
    added = 0;
    for (const row of rows) {
      const key = JSON.stringify(canonical(row));
      if (!unique.has(key)) { unique.set(key, row); added++; }
    }
    if (!added) break;
  }
  return [...unique.values()];
}

class DataSourceStore {
  constructor(connectionString) { this.connectionString = connectionString || ''; this.pool = null; this.ready = false; }
  async init() {
    if (!this.connectionString) return false;
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_datasource_snapshots (
      id BIGSERIAL PRIMARY KEY,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      products JSONB NOT NULL,
      stock JSONB,
      products_hash TEXT NOT NULL,
      stock_hash TEXT,
      products_count INTEGER NOT NULL,
      stock_count INTEGER NOT NULL DEFAULT 0,
      stock_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query('CREATE UNIQUE INDEX IF NOT EXISTS marketing_datasource_one_active_idx ON marketing_datasource_snapshots ((active)) WHERE active');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_datasource_sync_runs (
      id BIGSERIAL PRIMARY KEY,
      trigger TEXT NOT NULL,
      actor_user_id TEXT,
      actor_name TEXT,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      products_count INTEGER,
      stock_count INTEGER,
      products_hash TEXT,
      stock_hash TEXT,
      error_message TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query('ALTER TABLE marketing_datasource_sync_runs ADD COLUMN IF NOT EXISTS actor_user_id TEXT');
    await this.pool.query('ALTER TABLE marketing_datasource_sync_runs ADD COLUMN IF NOT EXISTS actor_name TEXT');
    await this.pool.query('CREATE INDEX IF NOT EXISTS marketing_datasource_sync_runs_finished_idx ON marketing_datasource_sync_runs (finished_at DESC)');
    this.ready = true;
    return true;
  }
  enabled() { return this.ready && !!this.pool; }
  async active() {
    if (!this.enabled()) return null;
    const result = await this.pool.query(`SELECT id, products, stock, products_hash, stock_hash, products_count, stock_count, stock_enabled, created_at
      FROM marketing_datasource_snapshots WHERE active = TRUE LIMIT 1`);
    return result.rows[0] || null;
  }
  async publish(snapshot) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE marketing_datasource_snapshots SET active = FALSE WHERE active = TRUE');
      const inserted = await client.query(`INSERT INTO marketing_datasource_snapshots
        (active, products, stock, products_hash, stock_hash, products_count, stock_count, stock_enabled)
        VALUES (TRUE, $1::jsonb, $2::jsonb, $3, $4, $5, $6, $7) RETURNING id, created_at`,
      [JSON.stringify(snapshot.products), snapshot.stock == null ? null : JSON.stringify(snapshot.stock), snapshot.productsHash, snapshot.stockHash || null, snapshot.products.length, snapshot.stock ? snapshot.stock.length : 0, snapshot.stockEnabled]);
      await client.query('COMMIT');
      return inserted.rows[0];
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async recordRun(run) {
    if (!this.enabled()) return;
    await this.pool.query(`INSERT INTO marketing_datasource_sync_runs
      (trigger, actor_user_id, actor_name, status, attempt, products_count, stock_count, products_hash, stock_hash, error_message, started_at, finished_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [run.trigger, run.actorUserId || null, run.actorName || null, run.status, run.attempt || 1, run.productsCount == null ? null : run.productsCount, run.stockCount == null ? null : run.stockCount,
      run.productsHash || null, run.stockHash || null, run.error || null, run.startedAt || new Date(), new Date()]);
  }
  async recentRuns(limit) {
    if (!this.enabled()) return [];
    const result = await this.pool.query(`SELECT trigger, actor_user_id, actor_name, status, attempt, products_count, stock_count, error_message, started_at, finished_at
      FROM marketing_datasource_sync_runs ORDER BY id DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 20, 1), 100)]);
    return result.rows;
  }
}

/* 失败后分别在第 3、10、30 分钟重试；数组是相邻两次尝试的增量等待。 */
const retryDelays = [0, 3 * 60 * 1000, 7 * 60 * 1000, 20 * 60 * 1000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DataSourceSynchronizer {
  constructor(store, readConfig, state) { this.store = store; this.readConfig = readConfig; this.state = state; this.running = null; }
  async run(trigger, actor) {
    if (!this.store || !this.store.enabled()) throw new Error('企业数据源数据库未连接');
    if (this.running) return { skipped: true, reason: '已有同步任务正在执行' };
    this.running = this.runWithRetries(trigger || 'manual', actor).finally(() => { this.running = null; });
    return this.running;
  }
  async runWithRetries(trigger, actor) {
    const startedAt = new Date();
    this.state.running = true; this.state.lastError = null; this.state.lastStartedAt = startedAt.toISOString();
    let lastError = null;
    try {
      for (let i = 0; i < retryDelays.length; i++) {
        if (retryDelays[i]) await sleep(retryDelays[i]);
        try {
          const outcome = await this.syncOnce();
          await this.store.recordRun({ trigger, actorUserId: actor && actor.userId, actorName: actor && actor.name, status: outcome.changed ? 'published' : 'unchanged', attempt: i + 1, startedAt,
            productsCount: outcome.productsCount, stockCount: outcome.stockCount, productsHash: outcome.productsHash, stockHash: outcome.stockHash });
          this.state.lastFinishedAt = new Date().toISOString(); this.state.lastResult = outcome.changed ? '已发布新版本' : '数据无变化';
          return Object.assign({ success: true, attempt: i + 1 }, outcome);
        } catch (error) {
          lastError = error;
          await this.store.recordRun({ trigger, actorUserId: actor && actor.userId, actorName: actor && actor.name, status: i === retryDelays.length - 1 ? 'failed' : 'retrying', attempt: i + 1, startedAt, error: String(error.message || error).slice(0, 1000) });
        }
      }
      this.state.lastError = lastError ? lastError.message : '数据源同步失败'; this.state.lastFinishedAt = new Date().toISOString(); this.state.lastResult = '失败（保留上一正式版本）';
      return { success: false, error: this.state.lastError };
    } finally { this.state.running = false; }
  }
  async syncOnce() {
    const cfg = this.readConfig() || {};
    if (!dataCubeConfigured(cfg, 'products')) throw new Error('未配置完整的产品信息表数据源');
    const stockEnabled = dataCubeConfigured(cfg, 'stock');
    const [products, stock] = await Promise.all([pullTable(cfg, 'products'), stockEnabled ? pullTable(cfg, 'stock') : Promise.resolve(null)]);
    const previous = await this.store.active();
    validateSnapshot({ products, stock, stockEnabled }, previous);
    const productsHash = stableRowsHash(products);
    const stockHash = stockEnabled ? stableRowsHash(stock) : null;
    if (previous && previous.products_hash === productsHash && previous.stock_hash === stockHash && !!previous.stock_enabled === stockEnabled) {
      return { changed: false, productsCount: products.length, stockCount: stock ? stock.length : 0, productsHash, stockHash };
    }
    const published = await this.store.publish({ products, stock, stockEnabled, productsHash, stockHash });
    return { changed: true, snapshotId: published.id, publishedAt: published.created_at, productsCount: products.length, stockCount: stock ? stock.length : 0, productsHash, stockHash };
  }
}

function chinaParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}
function scheduledChinaSlot(date) {
  const p = chinaParts(date);
  const hour = Number(p.hour), minute = Number(p.minute);
  if (minute !== 0 || hour < 7 || hour > 23 || (hour - 7) % 2 !== 0) return '';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00+08:00`;
}
function startDataSourceSchedule(synchronizer, state) {
  let lastSlot = '';
  const check = () => {
    const slot = scheduledChinaSlot(new Date());
    if (!slot || slot === lastSlot) return;
    lastSlot = slot; state.lastScheduledAt = new Date().toISOString();
    synchronizer.run('scheduled').catch((error) => { state.lastError = error.message; });
  };
  const delay = 60000 - (Date.now() % 60000) + 100;
  const first = setTimeout(() => { check(); const timer = setInterval(check, 60000); timer.unref(); }, delay);
  first.unref();
  return check;
}

module.exports = { DataSourceStore, DataSourceSynchronizer, stableRowsHash, validateSnapshot, scheduledChinaSlot, startDataSourceSchedule, dataCubeConfigured, retryDelays };

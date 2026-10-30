// 本地一体化服务：静态预览 + /api/config + /api/datacube（数据魔方签名转发）
// 用法：node serve.js  →  打开 http://localhost:8760
// 说明：与 server.ps1 等价地支持接口配置读写与数据魔方拉取，凭证与拉取都落在本副本目录内。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ApprovalStore, extractProcessInstanceId, normalizeApprovalEvent, normalizeWorkflowInstanceStatus, startApprovalStream } = require('./approval-sync');
const { DataSourceStore, DataSourceSynchronizer, startDataSourceSchedule } = require('./data-source-sync');
const { BusinessStore } = require('./business-store');

const ROOT = __dirname;
const CONFIG_PATH = path.resolve(process.env.MARKETING_CONFIG_PATH || path.join(ROOT, '..', 'runtime', 'config.json'));
const RUNTIME_DIR = path.resolve(process.env.MARKETING_RUNTIME_DIR || path.join(path.dirname(CONFIG_PATH), 'logs'));
const OA_LOG_PATH = path.resolve(process.env.MARKETING_OA_LOG_PATH || path.join(RUNTIME_DIR, 'oa-call.log'));
const AUDIT_LOG_PATH = path.resolve(process.env.MARKETING_AUDIT_LOG_PATH || path.join(RUNTIME_DIR, 'security-audit.log'));
const PORT = Number(process.env.PORT || 8760);
const BIND_HOST = process.env.MARKETING_BIND_HOST || '127.0.0.1';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
/* 钉钉 JSAPI 是不含业务凭据的固定官方版本；从本站加载，避免首次打开受第三方 CDN 慢速影响。 */
const DING_JSAPI_ASSET = '/dingtalk.open-3.0.41.js';
const STATIC_PUBLIC_FILES = new Set(['/login.html', DING_JSAPI_ASSET]);
const STATIC_AUTHENTICATED_FILES = new Set(['/', '/index.html', '/app.js', '/data.js', '/datasource.js', '/products_seed.js', '/sample-data.js', '/styles.css', '/upload.js', '/xlsx.full.min.js']);
const PUBLIC_API_PATHS = new Set(['/api/ding/events', '/api/ding/whoami', '/api/ding/login', '/api/ding/login/callback', '/api/ding/login-context']);

const PLACEHOLDER = /^(<|YOUR_|\s*$)/; // 未替换的占位符视为未配置
const MID_TABLE_TEXT_FIELDS = new Set(['name', 'spuShort', 'styleShort', 'category', 'productPos', 'season', 'grade', 'gender', 'color', 'size', 'remark', 'remarkPos']);
const MID_TABLE_NUMBER_FIELDS = new Set(['offSeasonIdx', 'annualSales', 'listPrice', 'retailPrice', 'normPrice', 'normDiscount', 'minPrice', 'minDiscount', 'redlinePrice', 'salesMin', 'salesMax', 'stock']);
/* 已确认的调价同步目标；运行配置可覆盖，避免部署时遗漏新配置项导致审批通过后无法写入。 */
const PRICE_ADJUSTMENT_DEFAULT_BASE_ID = 'vy20BglGWOAyZRoBHgyOBojpJA7depqY';
const PRICE_ADJUSTMENT_DEFAULT_TABLE_ID = 'bMjkiPR';
const PRICE_ADJUSTMENT_WRITE_BATCH_SIZE = 100;
const PRICE_ADJUSTMENT_MAX_RECORDS = 5000;
function normalizeMidTableOverrides(value) {
  if (!Array.isArray(value)) throw new Error('中间表覆盖配置必须是数组');
  if (value.length > 500) throw new Error('中间表覆盖配置最多保存 500 条');
  const code = (input, label) => {
    const out = String(input == null ? '' : input).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,79}$/.test(out)) throw new Error(label + '格式不正确');
    return out;
  };
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('中间表覆盖项格式不正确');
    const mode = entry.mode === 'add' ? 'add' : entry.mode === 'update' ? 'update' : '';
    if (!mode) throw new Error('中间表覆盖项类型不正确');
    const rawValues = entry.values && typeof entry.values === 'object' && !Array.isArray(entry.values) ? entry.values : {};
    const values = {};
    for (const [key, raw] of Object.entries(rawValues)) {
      if (MID_TABLE_TEXT_FIELDS.has(key)) {
        const text = String(raw == null ? '' : raw).trim();
        if (text.length > 200) throw new Error('中间表文本字段过长');
        values[key] = text;
      } else if (MID_TABLE_NUMBER_FIELDS.has(key)) {
        if (raw === '' || raw == null) { values[key] = null; continue; }
        const number = Number(raw);
        if (!Number.isFinite(number) || Math.abs(number) > 999999999) throw new Error('中间表数值字段不正确');
        values[key] = number;
      }
    }
    if (mode === 'update') {
      const spuCode = code(entry.spuCode, '货号');
      if (!Object.keys(values).length) throw new Error('请至少填写一个要修改的字段');
      return { mode, spuCode, values };
    }
    const spuCode = code(entry.spuCode, '货号');
    const skuCode = code(entry.skuCode, 'SKU编码');
    if (!values.name) throw new Error('新增商品必须填写品名');
    return { mode, spuCode, skuCode, values };
  });
  const seenSpu = new Set();
  for (const entry of normalized) {
    if (seenSpu.has(entry.spuCode)) throw new Error('同一货号只能保存一条中间表覆盖配置');
    seenSpu.add(entry.spuCode);
  }
  return normalized;
}

const STORE_ACTIVITY_PLAY_TYPES = new Set(['满减', '满折', '店铺券', '到手价折扣下限', '其他']);
function cleanStoreActivityText(value, label, max, required) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) throw new Error(label + '不能为空');
  if (text.length > max) throw new Error(label + '过长');
  return text;
}
const STORE_MID_TABLE_COLUMNS = ['货号', '品名', '商品简称', '类别', '定位', '等级', '季节', '性别', '零售价', '建议最低价', '红线价', 'SKU数'];
function normalizeStoreActivityMidTableSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.rows)) throw new Error('缺少商品中间表快照');
  if (!value.rows.length || value.rows.length > 1000) throw new Error('商品中间表快照行数不正确');
  const sourceHash = String(value.sourceHash || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(sourceHash)) throw new Error('商品中间表数据版本不正确，请刷新页面后重试');
  const number = (input, label) => {
    if (input === '' || input == null) return null;
    const out = Number(input);
    if (!Number.isFinite(out) || Math.abs(out) > 999999999) throw new Error(label + '不正确');
    return out;
  };
  const seen = new Set();
  const rows = value.rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('商品中间表快照行不正确');
    const spuCode = cleanStoreActivityText(row.spuCode, '中间表货号', 80, true);
    if (seen.has(spuCode)) throw new Error('商品中间表快照存在重复货号');
    seen.add(spuCode);
    return {
      spuCode,
      name: cleanStoreActivityText(row.name, '中间表品名', 200, true),
      spuShort: cleanStoreActivityText(row.spuShort, '中间表商品简称', 200, false),
      category: cleanStoreActivityText(row.category, '中间表类别', 100, false),
      productPos: cleanStoreActivityText(row.productPos, '中间表定位', 100, false),
      grade: cleanStoreActivityText(row.grade, '中间表等级', 50, false),
      season: cleanStoreActivityText(row.season, '中间表季节', 50, false),
      gender: cleanStoreActivityText(row.gender, '中间表性别', 30, false),
      retailPrice: number(row.retailPrice, '中间表零售价'), minPrice: number(row.minPrice, '中间表建议最低价'),
      redlinePrice: number(row.redlinePrice, '中间表红线价'), skuCount: number(row.skuCount, '中间表SKU数'),
    };
  });
  return { builtAt: cleanStoreActivityText(value.builtAt, '中间表构建时间', 50, false), sourceHash: sourceHash.toLowerCase(), columns: STORE_MID_TABLE_COLUMNS, rows };
}
function normalizeExemptStoreActivity(value, actor) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('全店活动参数不正确');
  const id = String(value.id || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('全店活动申请编号不正确');
  const start = cleanStoreActivityText(value.start, '开始日期', 10, true);
  const end = cleanStoreActivityText(value.end, '结束日期', 10, true);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) throw new Error('活动日期不正确');
  const activities = Array.isArray(value.activities) ? value.activities : [];
  if (activities.length !== 1 || !activities[0] || activities[0].scope !== 'store') throw new Error('免审批仅支持单个全店玩法活动');
  const activity = activities[0];
  const play = activity.play || {};
  const playType = cleanStoreActivityText(play.type, '玩法类型', 30, true);
  if (!STORE_ACTIVITY_PLAY_TYPES.has(playType)) throw new Error('玩法类型不支持');
  const playText = cleanStoreActivityText(play.text, '玩法规则', 500, true);
  const gifts = (Array.isArray(value.gifts) ? value.gifts : []).slice(0, 100).map((gift) => ({
    spuCode: cleanStoreActivityText(gift && gift.spuCode, '赠品货号', 80, false),
    name: cleanStoreActivityText(gift && gift.name, '赠品名称', 200, true),
    season: cleanStoreActivityText(gift && gift.season, '赠品季节', 50, false),
    gender: cleanStoreActivityText(gift && gift.gender, '赠品性别', 30, false),
  }));
  const seenGift = new Set();
  for (const gift of gifts) {
    const key = gift.spuCode || gift.name;
    if (seenGift.has(key)) throw new Error('赠品不能重复选择');
    seenGift.add(key);
  }
  const hasGift = value.hasGift === true || gifts.length > 0;
  if (hasGift && !gifts.length) throw new Error('含实物赠品时请至少选择一个赠品');
  const midTableSnapshot = normalizeStoreActivityMidTableSnapshot(value.midTableSnapshot);
  const manzeng = playType === '满减' ? playText : '';
  return {
    id, applicant: String(actor.name || '当前登录人'), dept: actor.dept || '',
    platform: cleanStoreActivityText(value.platform, '活动平台', 80, true),
    store: cleanStoreActivityText(value.store, '活动店铺', 200, true),
    activityType: cleanStoreActivityText(value.activityType || activity.unified, '活动类型', 100, true),
    activityCat: cleanStoreActivityText(value.activityCat || activity.cat2, '活动分类', 100, true),
    activityName: cleanStoreActivityText(value.activityName, '活动名称', 200, true),
    start, end, isStoreActivity: true, approvalMode: 'exempt', status: '已通过', hasGift, gifts,
    approvalRecord: { mode: '免人工审批', status: '已通过', source: 'store-activity-auto-approved' }, midTableSnapshot,
    activities: [{ unified: cleanStoreActivityText(activity.unified, '活动统一类型', 100, true), cat2: cleanStoreActivityText(activity.cat2, '活动分类', 100, true), name: cleanStoreActivityText(activity.name || activity.cat2, '活动名称', 200, true), cost: cleanStoreActivityText(activity.cost, '费用承担', 300, true), scope: 'store', play: { type: playType, text: playText, params: {} } }],
    standardMeta: { manzeng, gouwujin: cleanStoreActivityText(value.standardMeta && value.standardMeta.gouwujin, '购物金 / PLUS券规则', 300, false), remark: cleanStoreActivityText(value.standardMeta && value.standardMeta.remark, '备注', 300, false) },
    items: [],
  };
}
function readConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    while (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去除全部前置 UTF-8 BOM
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch (e) { /* Windows 本地开发环境不支持 POSIX 权限。 */ }
}
function sendJson(res, obj, status, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(body);
}
function sendRedirect(res, location, headers) {
  res.writeHead(302, Object.assign({ Location: location, 'Cache-Control': 'no-store' }, headers || {}));
  res.end();
}
function appendSecureLog(filePath, record) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o640 });
    try { fs.chmodSync(filePath, 0o640); } catch (e) { /* 同上。 */ }
  } catch (e) { /* 审计写入不得中断业务响应。 */ }
}
function requestIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket && req.socket.remoteAddress || '');
}
function attachApiAudit(req, res, requestPath) {
  if (!String(requestPath || '').startsWith('/api/')) return;
  const startedAt = Date.now();
  res.once('finish', () => {
    const status = Number(res.statusCode || 0);
    const event = status === 401 ? 'auth_failed' : status === 403 ? 'access_denied' : status >= 500 ? 'api_exception' : 'api_access';
    const actor = currentDingUser(req);
    appendSecureLog(AUDIT_LOG_PATH, { t: new Date().toISOString(), ev: 'audit-api', event, method: req.method, path: requestPath, status, durationMs: Date.now() - startedAt, ip: requestIp(req), actorUserId: actor ? actor.userId : null });
  });
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}
/* 数据魔方签名：参数按 key 排序拼接「键+值」再追加 appSecret，取 MD5 大写（与 server.ps1 一致） */
function datacubeSign(params, appSecret) {
  const s = Object.keys(params).sort().map((k) => k + params[k]).join('') + appSecret;
  return crypto.createHash('md5').update(Buffer.from(s, 'utf8')).digest('hex').toUpperCase();
}

/* ---------- 钉钉 OA 代理（token 缓存于服务端；secret/token 绝不下发页面） ---------- */
let _dt = { token: '', expireAt: 0, pending: null };
let _approvalStore = null;
let _approvalSyncState = { stream: '未启动', database: '未配置', lastEventAt: null, lastError: null, lastReconciledAt: null, lastReconcileError: null };
let _approvalReconcileTimer = null;
/* Stream 未送达时才使用的单一低频补偿，不叠加多套定时查询。 */
const APPROVAL_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
const MANUAL_APPROVAL_REFRESH_COOLDOWN_MS = 30 * 1000;
const _manualApprovalRefreshAt = new Map();
let _dataSourceStore = null;
let _dataSourceSync = null;
let _dataSourceSyncState = { database: '未配置', running: false, lastStartedAt: null, lastFinishedAt: null, lastScheduledAt: null, lastResult: null, lastError: null };
let _businessStore = null;
let _businessStoreState = { database: '未配置', lastError: null };
/* 与钉钉应用内的常用工作周期对齐：有效会话直接复用，避免每次打开应用都重复免登。 */
const DING_LOGIN_TTL = 7 * 24 * 60 * 60 * 1000;
const DING_LOGIN_STATE_TTL = 10 * 60 * 1000;
const DING_HANDOFF_TTL = 30 * 1000;
const DING_SESSION_COOKIE = 'mkt_ding_session';
const DING_STATE_COOKIE = 'mkt_ding_oauth_state';
const _dingSessions = new Map();
const _dingLoginStates = new Map();
const _dingAuthHandoffs = new Map();
function randomId() { return crypto.randomBytes(32).toString('base64url'); }
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const at = part.indexOf('=');
    if (at > 0) { try { out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim()); } catch (e) {} }
  });
  return out;
}
function expireDingLoginMemory() {
  const now = Date.now();
  for (const [id, v] of _dingSessions) if (!v || v.expiresAt <= now) _dingSessions.delete(id);
  for (const [id, v] of _dingLoginStates) if (!v || v.expiresAt <= now) _dingLoginStates.delete(id);
  for (const [id, v] of _dingAuthHandoffs) if (!v || v.expiresAt <= now) _dingAuthHandoffs.delete(id);
}
function cookieHeader(name, value, maxAge, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}${secure ? '; Secure' : ''}`;
}
function loginConfig(cfg) {
  const oa = (cfg && cfg.oa) || {};
  const appKey = oa.loginAppKey || oa.appKey;
  const appSecret = oa.loginAppSecret || oa.appSecret;
  if (!appKey || !appSecret || PLACEHOLDER.test(appKey) || PLACEHOLDER.test(appSecret)) throw new Error('未配置有效的钉钉网页登录凭证');
  return { appKey, appSecret };
}
/* 钉钉 HTTP 事件订阅：签名与消息体均需服务端校验，Token/AESKey 绝不下发。 */
function dingEventConfig(cfg) {
  const oa = (cfg && cfg.oa) || {};
  const token = String(oa.eventCallbackToken || '');
  const aesKey = String(oa.eventCallbackAesKey || '');
  const receiveId = String(oa.eventCallbackReceiveId || oa.corpId || oa.appKey || '');
  if (!token || !aesKey || PLACEHOLDER.test(token) || PLACEHOLDER.test(aesKey)) throw new Error('未配置钉钉事件回调 Token/AESKey');
  const key = Buffer.from(aesKey + '=', 'base64');
  if (key.length !== 32) throw new Error('钉钉事件回调 AESKey 格式无效');
  return { token, key, receiveId };
}
function dingEventSignature(token, timestamp, nonce, encrypt) {
  return crypto.createHash('sha1').update([token, String(timestamp), String(nonce), String(encrypt)].sort().join(''), 'utf8').digest('hex');
}
function safeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8'); const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function dingEventDecrypt(encrypt, eventCfg) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', eventCfg.key, eventCfg.key.subarray(0, 16));
  const plain = Buffer.concat([decipher.update(Buffer.from(String(encrypt || ''), 'base64')), decipher.final()]);
  if (plain.length < 20) throw new Error('钉钉事件密文长度无效');
  const msgLen = plain.readUInt32BE(16);
  if (msgLen < 0 || 20 + msgLen > plain.length) throw new Error('钉钉事件明文长度无效');
  const message = plain.subarray(20, 20 + msgLen).toString('utf8');
  const receiveId = plain.subarray(20 + msgLen).toString('utf8');
  if (eventCfg.receiveId && receiveId && receiveId !== eventCfg.receiveId) throw new Error('钉钉事件接收方不匹配');
  return { message, receiveId };
}
function dingEventEncrypt(message, eventCfg) {
  const content = Buffer.from(String(message), 'utf8'); const receiveId = Buffer.from(eventCfg.receiveId, 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(content.length, 0);
  const plain = Buffer.concat([crypto.randomBytes(16), len, content, receiveId]);
  const cipher = crypto.createCipheriv('aes-256-cbc', eventCfg.key, eventCfg.key.subarray(0, 16));
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}
function dingEventAck(eventCfg) {
  const timestamp = String(Date.now()); const nonce = randomId(); const encrypt = dingEventEncrypt('success', eventCfg);
  return { encrypt, msg_signature: dingEventSignature(eventCfg.token, timestamp, nonce, encrypt), timeStamp: timestamp, nonce };
}
function loginRedirectUri(req, cfg) {
  const oa = (cfg && cfg.oa) || {};
  if (oa.loginRedirectUri && /^https:\/\//i.test(oa.loginRedirectUri)) return oa.loginRedirectUri;
  const host = String(req.headers.host || '').trim();
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) throw new Error('登录回调域名无效');
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' ? 'https' : 'http';
  return `${protocol}://${host}/api/ding/login/callback`;
}
function loginPageForRequest(req) {
  try {
    const query = new URL(req.url, 'http://localhost').searchParams;
    const corpId = String(query.get('corpId') || query.get('corpid') || '').trim();
    return /^ding[a-z0-9]+$/i.test(corpId) ? '/login.html?corpId=' + encodeURIComponent(corpId) : '/login.html';
  } catch (e) { return '/login.html'; }
}
function canonicalLoginPage(cfg) {
  const redirectUri = String(((cfg && cfg.oa) || {}).loginRedirectUri || '');
  try {
    const url = new URL(redirectUri);
    return url.protocol === 'https:' ? url.origin + '/login.html' : '';
  } catch (e) { return ''; }
}
function redirectToCanonicalLogin(req, res, cfg) {
  const target = canonicalLoginPage(cfg);
  if (!target) return false;
  const host = String(req.headers.host || '').trim().toLowerCase();
  const canonicalHost = new URL(target).host.toLowerCase();
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' ? 'https' : 'http';
  if (host === canonicalHost && protocol === 'https') return false;
  sendRedirect(res, target);
  return true;
}
function currentDingUser(req) {
  expireDingLoginMemory();
  const sid = parseCookies(req)[DING_SESSION_COOKIE];
  if (!sid) return null;
  const remembered = _dingSessions.get(sid);
  if (remembered) return remembered;
  const persisted = decodeDingSession(sid, readConfig());
  if (persisted) _dingSessions.set(sid, persisted);
  return persisted;
}
function canManualBind(cfg, userId) {
  const raw = ((cfg && cfg.oa && cfg.oa.manualBindAdminUserIds) || []);
  const ids = Array.isArray(raw) ? raw : String(raw).split(',');
  return ids.map((id) => String(id).trim()).filter(Boolean).includes(String(userId || ''));
}
/* 数据源属于管理配置：仅服务端 config.json 中白名单内的钉钉成员可访问。 */
function canAccessDataSource(cfg, userId) {
  const raw = ((cfg && cfg.oa && cfg.oa.dataSourceViewerUserIds) || []);
  const ids = Array.isArray(raw) ? raw : String(raw).split(',');
  return ids.map((id) => String(id).trim()).filter(Boolean).includes(String(userId || ''));
}
function requireDataSourceAccess(req, res, cfg) {
  const actor = currentDingUser(req);
  if (!actor) {
    sendJson(res, { success: false, msg: '请先完成钉钉登录后再访问数据源' }, 401);
    return false;
  }
  if (!canAccessDataSource(cfg, actor.userId)) {
    sendJson(res, { success: false, msg: '当前账号没有数据源访问权限' }, 403);
    return false;
  }
  return true;
}
function sessionSigningKey(cfg) {
  const signingSecret = String(((cfg && cfg.security) || {}).sessionSigningSecret || '');
  if (!signingSecret || PLACEHOLDER.test(signingSecret)) return null;
  return crypto.createHmac('sha256', signingSecret).update('marketing-activity/ding-session/v1', 'utf8').digest();
}
function encodeDingSession(user, cfg) {
  const key = sessionSigningKey(cfg); if (!key || !user || !user.userId) return '';
  const payload = Buffer.from(JSON.stringify({
    userId: String(user.userId), name: String(user.name || ''), dept: user.dept || null,
    source: String(user.source || '钉钉登录'), expiresAt: Date.now() + DING_LOGIN_TTL,
  }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  return payload + '.' + signature;
}
function decodeDingSession(value, cfg) {
  const [payload, signature, extra] = String(value || '').split('.');
  const key = sessionSigningKey(cfg);
  if (!payload || !signature || extra || !key) return null;
  const expected = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  if (!safeEqualText(signature, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.userId || !Number.isFinite(Number(parsed.expiresAt)) || Number(parsed.expiresAt) <= Date.now()) return null;
    return { userId: String(parsed.userId), name: String(parsed.name || ''), dept: parsed.dept || null, source: String(parsed.source || '钉钉登录'), expiresAt: Number(parsed.expiresAt) };
  } catch (e) { return null; }
}
function sessionHeaders(user, secure, cfg) {
  const sid = encodeDingSession(user, cfg);
  if (!sid) throw new Error('未配置有效的会话签名密钥');
  const session = decodeDingSession(sid, cfg);
  if (!session) throw new Error('生成登录会话失败');
  _dingSessions.set(sid, session);
  return { headers: { 'Set-Cookie': cookieHeader(DING_SESSION_COOKIE, sid, DING_LOGIN_TTL, secure) }, sid };
}
function createDingAuthHandoff(sid, user) {
  expireDingLoginMemory();
  const token = randomId();
  _dingAuthHandoffs.set(token, { sid, userId: String(user.userId), name: String(user.name || ''), expiresAt: Date.now() + DING_HANDOFF_TTL });
  return token;
}
function consumeDingAuthHandoff(req, token) {
  expireDingLoginMemory();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(token || ''))) return null;
  const handoff = _dingAuthHandoffs.get(token);
  _dingAuthHandoffs.delete(token);
  if (!handoff || handoff.expiresAt <= Date.now()) return null;
  const sid = parseCookies(req)[DING_SESSION_COOKIE];
  if (!sid || sid !== handoff.sid) return null;
  const user = currentDingUser(req);
  return user && user.userId === handoff.userId ? { userId: user.userId, name: user.name || handoff.name, dept: user.dept || null, source: user.source || '钉钉免登' } : null;
}
/* 留痕：每次 OA 调用的映射与钉钉返回写入 oa-call.log，便于运营提交后回传校验（不记录 base64/secret） */
function logDing(ev, info) {
  appendSecureLog(OA_LOG_PATH, Object.assign({ t: new Date().toISOString(), ev }, info));
}
async function dtToken(cfg) {
  const oa = cfg && cfg.oa;
  if (!oa || !oa.appKey || !oa.appSecret || PLACEHOLDER.test(oa.appKey) || PLACEHOLDER.test(oa.appSecret))
    throw new Error('未配置有效的 OA 审批 APP Key / APP Secret');
  if (_dt.token && Date.now() < _dt.expireAt) return _dt.token;
  if (_dt.pending) return _dt.pending;
  _dt.pending = (async () => {
    const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: oa.appKey, appSecret: oa.appSecret }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.accessToken) throw new Error('获取 access_token 失败：' + (j.message || j.errmsg || JSON.stringify(j)));
    _dt.token = j.accessToken;
    _dt.expireAt = Date.now() + (j.expireIn || 7200) * 1000 - 120000;
    return _dt.token;
  })();
  try { return await _dt.pending; }
  finally { _dt.pending = null; }
}
async function dtSchema(cfg, processCode) {
  const token = await dtToken(cfg);
  const url = 'https://api.dingtalk.com/v1.0/workflow/forms/schemas/processCodes?processCode=' + encodeURIComponent(processCode);
  const r = await fetch(url, { method: 'GET', headers: { 'x-acs-dingtalk-access-token': token } });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* 保留原文 */ }
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
}
/* Stream 事件与新版工作流查询共用写回保护，审批终态不可被后到事件逆转。 */
async function applyApprovalStatus(processInstanceId, mapped, source) {
  if (!_approvalStore || !_approvalStore.enabled()) return null;
  const recorded = await _approvalStore.recordStatus(processInstanceId, mapped);
  if (!recorded.applied) {
    logDing('approval-status-event-ignored', { instanceId: processInstanceId, status: mapped.status, reason: recorded.reason });
    return Object.assign({ ignored: true }, mapped);
  }
  if (_businessStore && _businessStore.enabled()) await _businessStore.recordStatus(processInstanceId, mapped.status, source || 'approval-stream');
  logDing('approval-status-event', { instanceId: processInstanceId, status: mapped.status, dingStatus: mapped.rawStatus, dingResult: mapped.rawResult, source: source || 'approval-stream' });
  /* 审批通过 → 统一调价写入调价同步表；活动申请继续按原有规则创建日历。 */
  if (mapped.status === '已通过') {
    triggerPriceAdjustmentForPassed(processInstanceId).catch((e) => logDing('price-adjustment-auto-error', { instanceId: processInstanceId, msg: e.message }));
    triggerCalendarForPassed(processInstanceId).catch((e) => logDing('calendar-auto-error', { instanceId: processInstanceId, msg: e.message }));
  }
  return mapped;
}
/* ---------- 审批通过 → 订阅日历日程（对齐同事历史样板：一活动时间/二价格策略/三赠品策略/四活动文档） ---------- */
function fmtCalendarDay(d) { const s = String(d || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[2])}.${Number(m[3])}` : s; }
function nextDay(d) { const s = String(d || ''); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return s; const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); dt.setUTCDate(dt.getUTCDate() + 1); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`; }
/* 标准明细行含全部列；手工 items 缺「备注/满赠规则」等列，故标准明细优先。 */
function calendarRowsAll(a) {
  const std = Array.isArray(a && a.standardRows) ? a.standardRows : [];
  const items = Array.isArray(a && a.items) ? a.items : [];
  return std.length ? std : items;
}
/* 满赠规则在活动级 standardMeta.manzeng，回退到标准明细行的「满赠规则」列。 */
function calendarManzengOf(a, rows) {
  const direct = a && a.standardMeta && String(a.standardMeta.manzeng || '').trim();
  if (direct) return direct;
  for (const it of rows) { const v = it && String(it['满赠规则'] || '').trim(); if (v) return v; }
  return '';
}
/* 购物金/PLUS 券规则与满赠规则一样：优先活动级字段，再兼容早期标准明细。 */
function calendarShoppingRulesOf(a, rows) {
  const direct = a && a.standardMeta && String(a.standardMeta.gouwujin || '').trim();
  if (direct) return direct;
  for (const it of rows) { const v = it && String(it['购物金规则'] || '').trim(); if (v) return v; }
  return '';
}
function calendarDescFromApplication(a) {
  const app = a || {};
  const rows = calendarRowsAll(app);
  const nameOf = (it) => String((it && (it['产品名称'] || it.name)) || '').trim();
  const L = [];
  L.push('一、活动时间');
  L.push(`${fmtCalendarDay(app.start)}-${fmtCalendarDay(app.end)}`);
  L.push('二、价格策略');
  /* 从备注中提取早鸟价/拼团价，同价位的商品合并为一行（贴合样板：早鸟价：A、B日常价-60） */
  const priceGroups = []; const priceIdx = new Map();
  const addPrice = (label, amount, nm) => {
    if (!amount || !nm) return;
    const key = label + '\u0000' + amount;
    let g = priceIdx.get(key);
    if (!g) { g = { label, amount, names: [], seen: new Set() }; priceIdx.set(key, g); priceGroups.push(g); }
    if (!g.seen.has(nm)) { g.seen.add(nm); g.names.push(nm); }
  };
  for (const it of rows) {
    if (!it) continue;
    const nm = nameOf(it); const rm = String(it['备注'] || it.remark || '');
    let m = rm.match(/早鸟价\s*([\d.]+)/);
    if (m) addPrice('早鸟价', m[1], nm);
    m = rm.match(/拼团价\s*([\d.]+)/);
    if (m) addPrice('拼团价', m[1], nm);
  }
  let pi = 0;
  for (const g of priceGroups) {
    pi++;
    L.push(g.label === '早鸟价' ? `${pi}.早鸟价：${g.names.join('、')}日常价-${g.amount}` : `${pi}.拼团价：${g.names.join('、')} ${g.amount}`);
  }
  pi++; L.push(`${pi}.其他请看价格表`);
  L.push('三、赠品策略');
  const gifts = []; const giftSeen = new Set();
  for (const it of rows) {
    if (!it || it['赠品标记'] !== '是') continue;
    const nm = nameOf(it);
    if (nm && !giftSeen.has(nm)) { giftSeen.add(nm); gifts.push(nm); }
  }
  let gi = 0;
  if (gifts.length) { gi++; L.push(`${gi}.单品买赠：${gifts.join('、')}`); }
  const manzeng = calendarManzengOf(app, rows);
  if (manzeng) { gi++; L.push(`${gi}.三档满赠：${manzeng}，全店商品参与`); }
  gi++; L.push(`${gi}.单品买赠和三档满赠不叠加`);
  L.push('四、购物金 / PLUS券规则');
  L.push(calendarShoppingRulesOf(app, rows) || '无');
  L.push('五、活动文档');
  L.push(app.oaTableUrl || '详见审批单附件');
  if (app.midTableSnapshot && Array.isArray(app.midTableSnapshot.rows)) L.push('商品中间表快照已同步至活动文档');
  return L.join('\n');
}
/* 日历写入复用策略审批应用凭证；该应用必须在钉钉后台具备 Calendar.Event.Write 权限。 */
let _calTok = { token: '', expireAt: 0 };
async function dtCalToken(cfg) {
  const oa = cfg.oa || {};
  const appKey = oa.appKey;
  const appSecret = oa.appSecret;
  if (!appKey || !appSecret || PLACEHOLDER.test(appKey) || PLACEHOLDER.test(appSecret)) throw new Error('未配置策略审批应用凭证');
  if (_calTok.token && Date.now() < _calTok.expireAt) return _calTok.token;
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.accessToken) throw new Error('日历应用 access_token 获取失败：' + (j.message || JSON.stringify(j)));
  _calTok = { token: j.accessToken, expireAt: Date.now() + (j.expireIn || 7200) * 1000 - 120000 };
  return j.accessToken;
}
async function dtCalendarEventCreate(cfg, ev) {
  const token = await dtCalToken(cfg);
  const owner = ev.operatorUserId || (cfg.oa || {}).calendarOwnerUserId || (cfg.oa || {}).originatorUserId;
  const ju = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: owner }) })).json();
  const unionId = ju && ju.result && ju.result.unionid;
  if (!unionId) throw new Error('日历操作人 unionId 获取失败');
  const body = { calendarId: ev.calendarId, summary: ev.title, isAllDay: true, description: ev.description, start: { date: ev.startDate }, end: { date: ev.endDate } };
  const r = await fetch(`https://api.dingtalk.com/v1.0/calendar/users/${encodeURIComponent(unionId)}/calendars/${encodeURIComponent(ev.calendarId)}/events`, {
    method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!(r.status >= 200 && r.status < 300)) throw new Error((j && (j.message || j.code)) || '日历日程创建失败');
  return j;
}
function calendarRequestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
async function createCalendarForApprovedApplication(processInstanceId, actor) {
  const cfg = readConfig() || {}; const oa = cfg.oa || {};
  if (!_businessStore || !_businessStore.enabled()) throw calendarRequestError(503, '企业申请数据库未就绪');
  const row = await _businessStore.getByInstanceId(processInstanceId);
  if (!row) throw calendarRequestError(404, '未找到对应的已入库审批申请');
  if (actor && String(row.originator_user_id || '') !== String(actor.userId || '') && !canAccessDataSource(cfg, actor.userId)) throw calendarRequestError(403, '只能创建本人审批对应的活动日程');
  if (row.status !== '已通过') throw calendarRequestError(409, '审批通过后才会创建活动日程');
  if (row.calendar_event_id) return { eventId: row.calendar_event_id, existing: true };
  const a = Object.assign({}, row.payload || {}, { id: row.id });
  if (a.isPriceAdjustment === true) return { skipped: 'price-adjustment-no-calendar' };
  const calId = String(oa.calendarId || '');
  if (!calId) return { skipped: 'calendar-not-configured' };
  if (!a.start || !a.end) throw calendarRequestError(422, '申请缺少活动日期');
  let eventId = null;
  try {
    const out = await dtCalendarEventCreate(cfg, {
      calendarId: calId,
      title: `${a.activityName || a.name || '电商活动'}`,
      description: calendarDescFromApplication(a),
      startDate: String(a.start).slice(0, 10),
      endDate: nextDay(String(a.end).slice(0, 10)),
      operatorUserId: oa.calendarOwnerUserId || oa.originatorUserId,
    });
    eventId = out && (out.id || out.iCalUID);
  } catch (e) {
    await _businessStore.markCalendarResult(processInstanceId, { status: 'failed', err: e.message });
    throw e;
  }
  if (eventId) {
    await _businessStore.markCalendarResult(processInstanceId, { status: 'created', eventId });
    return { eventId };
  }
  await _businessStore.markCalendarResult(processInstanceId, { status: 'failed', err: '未返回 eventId' });
  throw new Error('日历服务未返回 eventId');
}
async function triggerCalendarForPassed(processInstanceId) {
  try {
    const result = await createCalendarForApprovedApplication(processInstanceId);
    if (result && result.skipped) logDing('calendar-auto-skip', { instanceId: processInstanceId, reason: result.skipped });
    else if (result && result.eventId) logDing('calendar-auto-created', { instanceId: processInstanceId, eventId: result.eventId, existing: !!result.existing });
    return result;
  } catch (e) {
    logDing('calendar-auto-error', { instanceId: processInstanceId, msg: e.message });
    return null;
  }
}
async function syncApprovalEvent(event) {
  const processInstanceId = extractProcessInstanceId(event);
  const mapped = normalizeApprovalEvent(event);
  if (!processInstanceId || !mapped) return null;
  return applyApprovalStatus(processInstanceId, mapped, 'approval-stream');
}
/* 仅查询仍在审批中的实例；查询结果不是终态时不改变本地状态。 */
async function dtWorkflowInstance(cfg, processInstanceId) {
  const token = await dtToken(cfg);
  const url = 'https://api.dingtalk.com/v1.0/workflow/processInstances?processInstanceId=' + encodeURIComponent(processInstanceId);
  const r = await fetch(url, { method: 'GET', headers: { 'x-acs-dingtalk-access-token': token } });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { /* 记录受限原文 */ }
  return { status: r.status, json, raw: json ? null : text.slice(0, 400) };
}
async function reconcilePendingApprovalStatuses(scope) {
  if (!_approvalStore || !_approvalStore.enabled() || !_businessStore || !_businessStore.enabled()) return { skipped: true };
  const cfg = readConfig() || {};
  const viewer = scope && scope.userId ? scope : null;
  const pending = viewer
    ? await _approvalStore.pendingForViewer(viewer.userId, !!viewer.canViewAll, 100)
    : await _approvalStore.pending(100);
  const source = viewer ? 'approval-manual-refresh' : 'approval-workflow-reconcile';
  let updated = 0;
  let failed = false;
  for (const item of pending) {
    try {
      const out = await dtWorkflowInstance(cfg, item.instanceId);
      if (out.status < 200 || out.status >= 300) throw new Error('workflow instance query HTTP ' + out.status);
      const mapped = normalizeWorkflowInstanceStatus(out.json && out.json.result);
      if (!mapped) continue;
      const result = await applyApprovalStatus(item.instanceId, mapped, source);
      if (result && !result.ignored) updated += 1;
    } catch (e) {
      failed = true;
      _approvalSyncState.lastReconcileError = e.message;
      logDing('approval-workflow-reconcile-error', { instanceId: item.instanceId, msg: e.message });
    }
  }
  _approvalSyncState.lastReconciledAt = new Date().toISOString();
  if (!failed) _approvalSyncState.lastReconcileError = null;
  logDing('approval-workflow-reconcile', { checked: pending.length, updated, source });
  return { checked: pending.length, updated };
}
function startApprovalReconciliation() {
  if (_approvalReconcileTimer) return;
  const run = () => reconcilePendingApprovalStatuses().catch((e) => {
    _approvalSyncState.lastReconcileError = e.message;
    logDing('approval-workflow-reconcile-error', { msg: e.message });
  });
  setTimeout(run, 5000);
  _approvalReconcileTimer = setInterval(run, APPROVAL_RECONCILE_INTERVAL_MS);
}
async function startBusinessStore() {
  const cfg = readConfig() || {}; const storage = cfg.storage || {};
  const postgresUrl = storage.postgresUrl || '';
  if (!postgresUrl) { _businessStoreState.database = '未配置 PostgreSQL'; return; }
  try {
    _businessStore = new BusinessStore(postgresUrl);
    await _businessStore.init();
    _businessStoreState.database = '已连接';
  } catch (e) {
    _businessStore = null; _businessStoreState.database = '连接失败'; _businessStoreState.lastError = e.message;
    logDing('business-store-start-error', { msg: e.message });
  }
}
async function startApprovalSync() {
  const cfg = readConfig() || {}; const storage = cfg.storage || {};
  const postgresUrl = storage.postgresUrl || '';
  if (!postgresUrl) { _approvalSyncState.database = '未配置 PostgreSQL'; return; }
  try {
    _approvalStore = new ApprovalStore(postgresUrl);
    await _approvalStore.init();
    _approvalSyncState.database = '已连接';
  } catch (e) {
    _approvalSyncState.database = '连接失败'; _approvalSyncState.lastError = e.message; logDing('approval-sync-start-error', { stage: 'database', msg: e.message }); return;
  }
  try {
    const out = startApprovalStream({
      cfg,
      onEvent: async (event) => {
        _approvalSyncState.lastEventAt = new Date().toISOString();
        await syncApprovalEvent(event);
      },
      onError: (error) => { _approvalSyncState.lastError = error.message; logDing('approval-stream-event-error', { msg: error.message }); },
    });
    _approvalSyncState.stream = out.started ? '已启动' : (out.reason || '未启动');
  } catch (e) {
    _approvalSyncState.stream = '启动失败'; _approvalSyncState.lastError = e.message; logDing('approval-sync-start-error', { stage: 'stream', msg: e.message });
  }
  startApprovalReconciliation();
}

/* 企业数据源：固定时段由服务端拉取，成功后才原子替换正式快照。 */
async function startDataSourceSync() {
  const cfg = readConfig() || {}; const storage = cfg.storage || {};
  const postgresUrl = storage.postgresUrl || '';
  if (!postgresUrl) { _dataSourceSyncState.database = '未配置 PostgreSQL'; return; }
  try {
    _dataSourceStore = new DataSourceStore(postgresUrl);
    await _dataSourceStore.init();
    _dataSourceSync = new DataSourceSynchronizer(_dataSourceStore, readConfig, _dataSourceSyncState);
    startDataSourceSchedule(_dataSourceSync, _dataSourceSyncState);
    _dataSourceSyncState.database = '已连接';
  } catch (e) {
    _dataSourceStore = null; _dataSourceSync = null;
    _dataSourceSyncState.database = '连接失败'; _dataSourceSyncState.lastError = e.message;
    logDing('datasource-sync-start-error', { msg: e.message });
  }
}
/* 发起审批实例：processCode/originatorUserId 缺省取配置，formComponentValues 由调用方组装 */
/* 诊断用：走旧版 topapi（错误信息更具体），camel→snake */
async function dtCreateLegacy(cfg, payload) {
  const oa = (cfg && cfg.oa) || {};
  const token = await dtToken(cfg);
  const fcv = (payload.formComponentValues || []).map((x) => ({ name: x.name, value: x.value, component_type: x.componentType, id: x.id, biz_alias: x.bizAlias }));
  const body = {
    process_code: payload.processCode || oa.processCode || '',
    originator_user_id: payload.originatorUserId || oa.originatorUserId || '',
    dept_id: payload.deptId != null ? payload.deptId : -1,
    form_component_values: fcv,
  };
  const r = await fetch('https://oapi.dingtalk.com/topapi/processinstance/create?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
}

async function dtUserGet(cfg, userid) {
  const token = await dtToken(cfg);
  const r = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userid, language: 'zh_CN' }),
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* 保留原文 */ }
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
}

/* 钉钉免登：用前端 JSAPI 拿到的 authCode 换当前登录人 userId */
async function dtWhoami(cfg, code) {
  const token = await dtToken(cfg);
  const r = await fetch('https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const j = await r.json().catch(() => ({}));
  return { errcode: j.errcode, errmsg: j.errmsg, userId: j.result && j.result.userid, name: j.result && j.result.name };
}

/* 网页 OAuth：授权码 → userAccessToken → unionId → 企业 userId / 成员资料。 */
async function dtOAuthCurrentUser(cfg, code) {
  const login = loginConfig(cfg);
  const rt = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: login.appKey, clientSecret: login.appSecret, code, refreshToken: '', grantType: 'authorization_code' }),
  });
  const tj = await rt.json().catch(() => ({}));
  if (!rt.ok || !tj.accessToken) throw new Error('获取用户授权失败：' + (tj.message || tj.code || rt.status));
  const rm = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', { headers: { 'x-acs-dingtalk-access-token': tj.accessToken } });
  const me = await rm.json().catch(() => ({}));
  const unionId = me.unionId || me.unionid || (me.result && (me.result.unionId || me.result.unionid));
  if (!rm.ok || !unionId) throw new Error('读取当前登录人失败：' + (me.message || me.code || rm.status));
  const appToken = await dtToken(cfg);
  const ru = await fetch('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=' + encodeURIComponent(appToken), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unionid: unionId }),
  });
  const uj = await ru.json().catch(() => ({}));
  const userId = uj && uj.result && uj.result.userid;
  if (!userId) throw new Error('未在当前企业中找到登录成员：' + (uj.errmsg || uj.code || ru.status));
  const detail = await dtUserGet(cfg, userId);
  const result = (detail.json && detail.json.result) || {};
  return { userId, name: result.name || me.nick || '', dept: (result.dept_id_list || [])[0] || null, source: '钉钉网页登录' };
}

/* 在知识库文件夹内创建在线表格(WORKBOOK)，返回 nodeId + 链接；operatorId 用发起人 unionId */
async function dtNewDoc(cfg, p) {
  const token = await dtToken(cfg);
  /* 归档位置只能来自服务端配置，不能把应用凭证变成任意知识库写入代理。 */
  const workspaceId = (cfg.oa || {}).archiveWorkspaceId;
  const parentNodeId = (cfg.oa || {}).archiveParentNodeId;
  if (!workspaceId || !parentNodeId) return { status: 0, json: { code: 'NO_TARGET', message: '缺少知识库 workspaceId/parentNodeId' } };
  const body = { name: String(p.name || '在线表格').slice(0, 120), docType: 'WORKBOOK', operatorId: p.operatorId };
  if (parentNodeId) body.parentNodeId = parentNodeId;
  const r = await fetch(`https://api.dingtalk.com/v1.0/doc/workspaces/${encodeURIComponent(workspaceId)}/docs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
}

/* 向已建的在线表格(WORKBOOK)写入二维数据：取默认工作表→PUT 更新 A1 起区域 */
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function normalizeSheetValues(values) {
  if (!Array.isArray(values) || !values.length || !Array.isArray(values[0]) || !values[0].length) return { error: '缺少二维表格数据' };
  const width = values[0].length;
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    if (!Array.isArray(values[i]) || values[i].length !== width) return { error: '第 ' + (i + 1) + ' 行列数不一致' };
    rows.push(values[i].map((value) => {
      if (value === null || value === undefined) return '';
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
      if (typeof value === 'boolean') return value ? 'true' : 'false';
      return String(value);
    }));
  }
  return { values: rows };
}

/* 钉钉在线表格单次写入有请求体上限。按实际 UTF-8 JSON 字节切分，
 * 首批包含表头，后续批次连续写入数据行，避免中文内容按字符数低估而触发 413。 */
const DOC_FILL_MAX_ROWS = 200;
const DOC_FILL_MAX_BYTES = 240 * 1024;
function docFillBodyBytes(values) {
  return Buffer.byteLength(JSON.stringify({ values }), 'utf8');
}
function chunkRowsForWrite(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('缺少待写入行');
  const batches = [];
  let current = [values[0]];
  if (docFillBodyBytes(current) > DOC_FILL_MAX_BYTES) throw new Error('表头超过在线表格单次写入大小上限');
  for (const row of values.slice(1)) {
    const candidate = current.concat([row]);
    if (candidate.length <= DOC_FILL_MAX_ROWS && docFillBodyBytes(candidate) <= DOC_FILL_MAX_BYTES) {
      current = candidate;
      continue;
    }
    batches.push(current);
    current = [row];
    if (docFillBodyBytes(current) > DOC_FILL_MAX_BYTES) throw new Error('单行超过在线表格单次写入大小上限');
  }
  batches.push(current);
  return batches;
}
async function dtDocFill(cfg, p) {
  const token = await dtToken(cfg);
  const wid = p.workbookId; const op = p.operatorId;
  if (!wid || !op) return { ok: false, stage: 'param', msg: '缺 workbookId/operatorId' };
  const requestedSheets = Array.isArray(p.sheets) && p.sheets.length ? p.sheets : [{ values: p.values }];
  const normalizedSheets = requestedSheets.map((sheet) => ({ name: sheet && sheet.name, normalized: normalizeSheetValues(sheet && sheet.values) }));
  const invalid = normalizedSheets.find((sheet) => !sheet.normalized.values);
  if (invalid) return { ok: false, stage: 'param', msg: invalid.normalized.error };
  const H = { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token };
  const rs = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets?operatorId=${encodeURIComponent(op)}`, { method: 'GET', headers: H });
  const js = await rs.json().catch(() => null); const existingSheets = js && Array.isArray(js.value) ? js.value : [];
  if (!existingSheets[0]) return { ok: false, stage: 'sheets', status: rs.status, body: js };
  const results = [];
  for (let index = 0; index < normalizedSheets.length; index += 1) {
    const entry = normalizedSheets[index];
    let sheet = index === 0 ? existingSheets[0] : null;
    if (!sheet) {
      const create = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets?operatorId=${encodeURIComponent(op)}`, { method: 'POST', headers: H, body: JSON.stringify({ name: entry.name || ('Sheet' + (index + 1)) }) });
      const created = await create.json().catch(() => null);
      if (create.status < 200 || create.status >= 300 || !created || !created.id) return { ok: false, stage: 'create-sheet', status: create.status, error: created || { message: '创建工作表失败' } };
      sheet = created;
    }
    const values = entry.normalized.values;
    let batches;
    try { batches = chunkRowsForWrite(values); }
    catch (e) { return { ok: false, stage: 'chunk-sheet', msg: e.message, sheetId: sheet.id, sheetName: sheet.name }; }
    const ranges = [];
    let rowStart = 1;
    for (const rowsToWrite of batches) {
      const range = `A${rowStart}:${colLetter(values[0].length)}${rowStart + rowsToWrite.length - 1}`;
      const rp = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets/${encodeURIComponent(sheet.id)}/ranges/${range}?operatorId=${encodeURIComponent(op)}`, { method: 'PUT', headers: H, body: JSON.stringify({ values: rowsToWrite }) });
      const txt = await rp.text(); let jp = null; try { jp = JSON.parse(txt); } catch (e) {}
      const detail = jp && typeof jp === 'object' ? {
        code: jp.code || jp.errorCode || jp.errcode || '',
        message: jp.message || jp.errorMessage || jp.errmsg || '',
      } : { message: txt.slice(0, 300) };
      if (rp.status < 200 || rp.status >= 300) return { ok: false, stage: 'write-sheet', status: rp.status, error: detail, sheetId: sheet.id, sheetName: sheet.name, range, ranges };
      ranges.push(range);
      rowStart += rowsToWrite.length;
    }
    results.push({ sheetId: sheet.id, sheetName: sheet.name, range: ranges[0], ranges, status: 200 });
  }
  return { ok: true, sheets: results, sheetId: results[0].sheetId, sheetName: results[0].sheetName, range: results[0].range, status: results[0].status };
}

async function dingUnionId(cfg, userId) {
  const token = await dtToken(cfg);
  const response = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: userId }),
  });
  const json = await response.json().catch(() => ({}));
  const unionId = json && json.result && json.result.unionid;
  if (!unionId) throw new Error('无法获取当前申请人的钉钉 unionId');
  return unionId;
}

function priceAdjustmentSyncSettings(cfg) {
  const oa = cfg && cfg.oa || {};
  const sync = oa.priceAdjustmentSync && typeof oa.priceAdjustmentSync === 'object' ? oa.priceAdjustmentSync : {};
  const baseId = String(sync.baseId || PRICE_ADJUSTMENT_DEFAULT_BASE_ID).trim();
  const tableId = String(sync.tableId || PRICE_ADJUSTMENT_DEFAULT_TABLE_ID).trim();
  const operatorUserId = String(sync.operatorUserId || oa.originatorUserId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(baseId) || !/^[A-Za-z0-9_-]{4,128}$/.test(tableId) || !/^[A-Za-z0-9_-]{4,128}$/.test(operatorUserId)) {
    throw new Error('统一调价同步表配置不正确');
  }
  return { baseId, tableId, operatorUserId };
}
function priceAdjustmentRecordFields(application, row, approvedAt) {
  const detail = application && application.priceAdjustment || {};
  const submitter = String(row.originator_name || application.applicant || '');
  const department = String(application.dept || '');
  const approvalNo = String(row.oa_instance_id || application.oaNo || '');
  const detailUrl = String(application.oaTableUrl || '');
  const approver = String((application.approvalRecord && application.approvalRecord.approverName) || application.actualApprover || '');
  return (Array.isArray(detail.lines) ? detail.lines : []).flatMap((line) => {
    /* 兼容旧 SPU 级审批；新审批一定携带 SKU 明细。 */
    const skus = Array.isArray(line.skus) && line.skus.length ? line.skus : [{ skuCode: '', color: '', size: '', originalRetail: line.originalRetail, targetRetail: line.targetRetail }];
    const mode = line.pricingMode === 'spu-uniform' ? 'SPU同价' : line.pricingMode === 'sku-specific' ? 'SKU分别调价' : 'SPU同价';
    return skus.map((sku) => ({
      '调价记录': `${application.id} · ${line.spuCode} · ${sku.skuCode || 'SPU'}`,
      '系统申请编号': String(application.id || ''),
      '调价方式': mode,
      '货号（SPU）': String(line.spuCode || ''),
      'SKU编码': String(sku.skuCode || ''),
      '颜色': String(sku.color || ''),
      '尺码': String(sku.size || ''),
      '品名': String(line.name || ''),
      '调价原价': Number(sku.originalRetail),
      '目标零售价': Number(sku.targetRetail),
      '统一调价原因': String(detail.reason || ''),
      '提交人': submitter,
      '所属部门': department,
      '钉钉审批单号': approvalNo,
      '实际审批人': approver,
      '审批通过时间': approvedAt,
      '审批明细链接': detailUrl,
    }));
  });
}
function validatePriceAdjustmentRecords(records) {
  if (!Array.isArray(records) || !records.length || records.length > PRICE_ADJUSTMENT_MAX_RECORDS) throw new Error('统一调价明细行数不正确');
  const seen = new Set();
  for (const fields of records) {
    const spu = String(fields['货号（SPU）'] || '').trim();
    const sku = String(fields['SKU编码'] || '').trim();
    const key = `${spu}::${sku}`;
    if (!spu || seen.has(key)) throw new Error('统一调价存在空或重复 SKU');
    seen.add(key);
    if (!Number.isFinite(fields['调价原价']) || fields['调价原价'] <= 0 || !Number.isFinite(fields['目标零售价']) || fields['目标零售价'] <= 0 || fields['调价原价'] === fields['目标零售价']) {
      throw new Error('统一调价价格不正确');
    }
    if (fields['调价方式'] !== 'SPU同价' && fields['调价方式'] !== 'SKU分别调价') throw new Error('统一调价方式不正确');
    if (!String(fields['统一调价原因'] || '').trim()) throw new Error('统一调价原因不能为空');
  }
}
async function dtAitableCreateRecords(cfg, settings, operatorId, records) {
  const token = await dtToken(cfg);
  const url = `https://api.dingtalk.com/v1.0/notable/bases/${encodeURIComponent(settings.baseId)}/sheets/${encodeURIComponent(settings.tableId)}/records?operatorId=${encodeURIComponent(operatorId)}`;
  const ids = [];
  for (let offset = 0; offset < records.length; offset += PRICE_ADJUSTMENT_WRITE_BATCH_SIZE) {
    const batch = records.slice(offset, offset + PRICE_ADJUSTMENT_WRITE_BATCH_SIZE);
    const response = await fetch(url, { method: 'POST', headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' }, body: JSON.stringify({ records: batch.map((fields) => ({ fields })) }) });
    const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* 保留简短错误信息 */ }
    if (response.status < 200 || response.status >= 300) throw new Error((json && (json.message || json.code)) || ('调价同步表写入失败（HTTP ' + response.status + '）'));
    const batchIds = Array.isArray(json && json.value) ? json.value.map((item) => item && item.id).filter(Boolean) : [];
    if (batchIds.length !== batch.length) throw new Error('调价同步表未返回完整写入结果');
    ids.push(...batchIds);
  }
  return { ids };
}
function priceAdjustmentSourceValue(product, fieldMap, name) {
  const sourceField = fieldMap && fieldMap[name];
  if (sourceField && product && product[sourceField] != null) return product[sourceField];
  return product && product[name];
}
async function verifyPriceAdjustmentSource(application) {
  const snapshot = _dataSourceStore && _dataSourceStore.enabled() ? await _dataSourceStore.active() : null;
  if (!snapshot || !Array.isArray(snapshot.products)) throw new Error('正式商品中间表未就绪，无法确认调价原价');
  const fieldMap = ((readConfig() || {}).dataSource || {}).fieldMap || {};
  const productMap = fieldMap.products || {};
  const products = new Map(snapshot.products.map((product) => [String(priceAdjustmentSourceValue(product, productMap, 'spuCode') || '').trim(), product]));
  for (const line of (application.priceAdjustment && application.priceAdjustment.lines) || []) {
    const lineSkus = Array.isArray(line.skus) && line.skus.length ? line.skus : [{ skuCode: '', originalRetail: line.originalRetail }];
    for (const lineSku of lineSkus) {
      const product = products.get(String(line.spuCode || '').trim());
      const skuCode = String(lineSku.skuCode || '').trim();
      const matching = skuCode ? snapshot.products.find((item) => String(priceAdjustmentSourceValue(item, productMap, 'spuCode') || '').trim() === String(line.spuCode || '').trim() && String(priceAdjustmentSourceValue(item, productMap, 'skuCode') || '').trim() === skuCode) : product;
      const retail = priceAdjustmentSourceValue(matching, productMap, 'retailPrice');
      let current = Number(retail);
      if (retail == null || retail === '' || !Number.isFinite(current) || current <= 0) {
        const fallbackRetail = snapshot.products
          .filter((item) => String(priceAdjustmentSourceValue(item, productMap, 'spuCode') || '').trim() === String(line.spuCode || '').trim())
          .map((item) => priceAdjustmentSourceValue(item, productMap, 'retailPrice'))
          .find((value) => value != null && value !== '');
        current = Number(fallbackRetail);
      }
      if (!Number.isFinite(current) || current !== Number(lineSku.originalRetail)) throw new Error(`${skuCode ? 'SKU ' + skuCode : '货号 ' + line.spuCode} 的当前零售价已变化，请重新确认后提交`);
    }
  }
}
async function createPriceAdjustmentSyncForApprovedApplication(processInstanceId) {
  const cfg = readConfig() || {};
  if (!_businessStore || !_businessStore.enabled()) throw new Error('企业申请数据库未就绪');
  const row = await _businessStore.getByInstanceId(processInstanceId);
  if (!row) throw new Error('未找到对应的已入库审批申请');
  const application = Object.assign({}, row.payload || {}, { id: row.id, oaNo: row.oa_instance_id || '' });
  if (application.isPriceAdjustment !== true) return { skipped: 'not-price-adjustment' };
  if (row.status !== '已通过') return { skipped: 'not-approved' };
  if (application.priceAdjustmentSyncAt && !application.priceAdjustmentSyncError) return { existing: true, recordCount: Number(application.priceAdjustmentSyncRecordCount || 0) };
  const settings = priceAdjustmentSyncSettings(cfg);
  const records = priceAdjustmentRecordFields(application, row, new Date().toISOString());
  validatePriceAdjustmentRecords(records);
  await verifyPriceAdjustmentSource(application);
  const operatorId = await dingUnionId(cfg, settings.operatorUserId);
  const created = await dtAitableCreateRecords(cfg, settings, operatorId, records);
  await _businessStore.markPriceAdjustmentSyncResult(processInstanceId, { status: 'created', recordIds: created.ids });
  return { recordCount: created.ids.length, recordIds: created.ids };
}
async function triggerPriceAdjustmentForPassed(processInstanceId) {
  try {
    const result = await createPriceAdjustmentSyncForApprovedApplication(processInstanceId);
    if (result && result.skipped) logDing('price-adjustment-auto-skip', { instanceId: processInstanceId, reason: result.skipped });
    else if (result && result.existing) logDing('price-adjustment-auto-existing', { instanceId: processInstanceId, recordCount: result.recordCount });
    else logDing('price-adjustment-auto-created', { instanceId: processInstanceId, recordCount: result && result.recordCount || 0 });
    return result;
  } catch (error) {
    if (_businessStore && _businessStore.enabled()) await _businessStore.markPriceAdjustmentSyncResult(processInstanceId, { status: 'failed', err: error.message });
    throw error;
  }
}
function storeActivityDetailSheets(app) {
  const activity = (app.activities || [])[0] || {};
  const summary = [
    ['字段', '内容'], ['申请编号', app.id], ['状态', '已通过（全店免审批）'], ['活动名称', app.activityName],
    ['平台', app.platform], ['店铺', app.store], ['开始日期', app.start], ['结束日期', app.end],
    ['玩法类型', activity.play && activity.play.type || ''], ['玩法规则', activity.play && activity.play.text || ''],
    ['费用承担', activity.cost || ''], ['满赠规则', app.standardMeta && app.standardMeta.manzeng || ''], ['购物金 / PLUS券规则', app.standardMeta && app.standardMeta.gouwujin || ''], ['数据来源', '商品中间表'],
  ];
  const gifts = [['赠品货号', '赠品名称', '商品时期', '性别', '赠品标记']];
  for (const gift of app.gifts || []) gifts.push([gift.spuCode || '', gift.name || '', gift.season || '', gift.gender || '', '是']);
  if (gifts.length === 1) gifts.push(['', '未设置赠品', '', '', '否']);
  const snapshot = app.midTableSnapshot || {};
  const midRows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const midTable = [STORE_MID_TABLE_COLUMNS].concat(midRows.map((row) => [row.spuCode, row.name, row.spuShort, row.category, row.productPos, row.grade, row.season, row.gender, row.retailPrice, row.minPrice, row.redlinePrice, row.skuCount]));
  return [{ values: summary }, { name: '赠品明细', values: gifts }, { name: '商品中间表快照', values: midTable }];
}
function storeActivityStandardRows(app) {
  const common = { 活动ID: app.id, 活动名称: app.activityName, 平台: app.platform, 店铺: app.store, 开始: app.start, 结束: app.end, 活动类型: app.activityCat, 满赠规则: app.standardMeta && app.standardMeta.manzeng || '', 购物金规则: app.standardMeta && app.standardMeta.gouwujin || '', 数据来源: '商品中间表' };
  const gifts = Array.isArray(app.gifts) ? app.gifts : [];
  if (!gifts.length) return [Object.assign({}, common, { 产品名称: '全店商品', '赠品标记': '否', 备注: '全店玩法' })];
  return gifts.map((gift) => Object.assign({}, common, { 产品名称: gift.name, 商品时期: gift.season || '', 货号: gift.spuCode || '', '赠品标记': '是', 备注: '满减赠品' }));
}
async function createStoreActivityDetail(cfg, app, actor) {
  const operatorId = await dingUnionId(cfg, actor.userId);
  const doc = await dtNewDoc(cfg, { name: '全店活动明细_' + app.id, operatorId });
  const nodeId = doc.json && (doc.json.nodeId || doc.json.docKey || doc.json.id || (doc.json.result && (doc.json.result.nodeId || doc.json.result.dentryUuid)));
  if (!(doc.status >= 200 && doc.status < 300 && nodeId)) throw new Error('创建活动明细失败：' + ((doc.json && (doc.json.message || doc.json.code)) || doc.raw || '未返回表格标识'));
  const url = doc.json.url || ('https://alidocs.dingtalk.com/i/nodes/' + nodeId);
  const urlNode = typeof url === 'string' && (url.match(/\/i\/nodes\/([^/?#]+)/) || [])[1];
  const written = await dtDocFill(cfg, { workbookId: urlNode || nodeId, operatorId, sheets: storeActivityDetailSheets(app) });
  if (!written.ok) throw new Error('写入活动明细失败：' + (written.msg || (written.error && (written.error.message || written.error.code)) || written.stage || '未知错误'));
  return { url, workbookId: urlNode || nodeId };
}

/* 给审批实例追加评论（text 可含在线协作表链接） */
async function dtComment(cfg, p) {
  const token = await dtToken(cfg);
  const r = await fetch('https://oapi.dingtalk.com/topapi/process/instance/comment/add?access_token=' + encodeURIComponent(token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request: { process_instance_id: p.processInstanceId, text: p.text, comment_userid: p.commentUserid } }),
  });
  const j = await r.json().catch(() => ({}));
  return { errcode: j.errcode, errmsg: j.errmsg };
}

async function dtCreate(cfg, payload) {
  const oa = (cfg && cfg.oa) || {};
  const token = await dtToken(cfg);
  const body = {
    processCode: payload.processCode || oa.processCode || '',
    originatorUserId: payload.originatorUserId || oa.originatorUserId || '',
    formComponentValues: payload.formComponentValues || [],
    requestSessionId: payload.requestSessionId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)),
  };
  if (payload.deptId !== undefined && payload.deptId !== null && payload.deptId !== '') body.deptId = payload.deptId;
  if (body.deptId === undefined) {
    try { const ju = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: body.originatorUserId }) })).json(); const dl = ju && ju.result && ju.result.dept_id_list; if (dl && dl.length) body.deptId = dl[0]; } catch (e) {}
  }
  if (payload.approvers) body.approvers = payload.approvers;
  if (payload.approversV2) body.approversV2 = payload.approversV2;
  const r = await fetch('https://api.dingtalk.com/v1.0/workflow/processInstances', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* 保留原文 */ }
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
}

/* 裸 PUT：只用钉钉返回的签名头，绝不额外加 Content-Type（否则 OSS SignatureDoesNotMatch） */
function rawPut(urlStr, headers, buf) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ status: 0, text: 'bad url' }); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({ method: 'PUT', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, headers: Object.assign({ 'Content-Length': buf.length }, headers) },
      (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
    req.on('error', (e) => resolve({ status: 0, text: e.message }));
    req.end(buf);
  });
}

/* ---------- 审批附件上传编排（钉盘 3 步：取空间→申请上传信息+PUT→commit 拿 fileId）----------
 * 返回 { ok, spaceId, fileId, fileName, fileSize, fileType, value, trace }
 * base64: 文件内容 base64；fileType 扩展名；每步留 trace 便于按真实响应校正 */
async function dtUpload(cfg, p) {
  const oa = (cfg && cfg.oa) || {};
  const uid = p.userId || oa.originatorUserId || '';
  const fileName = p.fileName || '附件.xlsx';
  const fileType = (p.fileType || 'xlsx');
  const buf = Buffer.from(p.base64 || '', 'base64');
  const fileSize = p.fileSize != null ? p.fileSize : buf.length;
  const token = await dtToken(cfg);
  const H = () => ({ 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token });
  const trace = {};
  try {
    /* 1) 发起人 unionId */
    const ru = await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: uid, language: 'zh_CN' }) });
    const ju = await ru.json().catch(() => ({})); trace.user = { errcode: ju.errcode, unionid: ju.result && ju.result.unionid, errmsg: ju.errmsg };
    const unionId = ju.result && ju.result.unionid; if (!unionId) return { ok: false, stage: 'unionId', trace };
    /* 2) 空间：给了 spaceId 就传到该钉盘空间（如存档文件夹），否则用审批临时空间 */
    const parentId = p.parentId || '0';
    let spaceId = p.spaceId;
    if (!spaceId) {
      const sb = { userId: uid }; if (oa.agentId) sb.agentId = Number(oa.agentId);
      const rs = await fetch('https://api.dingtalk.com/v1.0/workflow/processInstances/spaces/infos/query', { method: 'POST', headers: H(), body: JSON.stringify(sb) });
      const js = await rs.json().catch(() => null); const stxt = js ? null : await rs.text(); trace.space = { status: rs.status, body: js || (stxt || '').slice(0, 300) };
      spaceId = (js && (js.spaceId || (js.result && js.result.spaceId) || (js.result && js.result.spaceVO && js.result.spaceVO.spaceId)));
      if (!spaceId) return { ok: false, stage: 'space', trace };
    } else { trace.space = { target: 'given', spaceId: String(spaceId), parentId }; }
    /* 3) 申请上传信息 */
    const ri = await fetch(`https://api.dingtalk.com/v1.0/storage/spaces/${spaceId}/files/uploadInfos/query?unionId=${encodeURIComponent(unionId)}`, { method: 'POST', headers: H(), body: JSON.stringify({ protocol: 'HEADER_SIGNATURE', multipart: false }) });
    const ji = await ri.json().catch(() => null); const itxt = ji ? null : await ri.text(); trace.uploadInfo = { status: ri.status, body: ji || (itxt || '').slice(0, 400) };
    const uploadKey = ji && ji.uploadKey; const hsi = ji && ji.headerSignatureInfo; const resUrl = hsi && Array.isArray(hsi.resourceUrls) ? hsi.resourceUrls[0] : (hsi && hsi.resourceUrl);
    if (!uploadKey || !resUrl) return { ok: false, stage: 'uploadInfo', trace };
    /* 4) PUT 文件到 OSS（只用签名头，不加 Content-Type） */
    const putRes = await rawPut(resUrl, Object.assign({}, hsi.headers || {}), buf);
    trace.put = { status: putRes.status, ok: putRes.status >= 200 && putRes.status < 300, body: putRes.status >= 300 ? (putRes.text || '').slice(0, 300) : '' };
    if (!(putRes.status >= 200 && putRes.status < 300)) return { ok: false, stage: 'put', trace };
    /* 5) commit 拿 dentry(fileId) */
    const rc = await fetch(`https://api.dingtalk.com/v1.0/storage/spaces/${spaceId}/files/commit?unionId=${encodeURIComponent(unionId)}`, { method: 'POST', headers: H(), body: JSON.stringify({ uploadKey, name: fileName, parentId }) });
    const jc = await rc.json().catch(() => null); const ctxt = jc ? null : await rc.text(); trace.commit = { status: rc.status, body: jc || (ctxt || '').slice(0, 400) };
    const dn = jc && (jc.dentry || (jc.result && jc.result.dentry)); if (!dn || !dn.id) return { ok: false, stage: 'commit', trace };
    const att = { spaceId: String(dn.spaceId != null ? dn.spaceId : spaceId), fileName: dn.name || fileName, fileSize: String(dn.size != null ? dn.size : fileSize), fileType: (dn.extension || fileType), fileId: String(dn.id) };
    return { ok: true, spaceId: att.spaceId, fileId: att.fileId, fileName: att.fileName, fileSize: att.fileSize, fileType: att.fileType, value: JSON.stringify([att]), trace };
  } catch (e) { return { ok: false, stage: 'exception', error: e.message, trace }; }
}

const server = http.createServer(async (req, res) => {
  let u = '';
  try { u = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { return sendJson(res, { success: false, msg: '请求路径无效' }, 400); }
  attachApiAudit(req, res, u);
  /* 已永久关闭的旧入口不处理任何业务数据，直接返回不可用状态。 */
  if (u === '/api/ding/create_legacy' && req.method === 'POST') {
    return sendJson(res, { success: false, msg: '旧版审批诊断入口已关闭' }, 410);
  }
  if (u.startsWith('/api/') && !PUBLIC_API_PATHS.has(u) && !currentDingUser(req)) {
    return sendJson(res, { success: false, msg: '请先完成钉钉登录' }, 401);
  }

  /* ---- GET /api/datasource/access：仅告知当前登录人是否可见，不返回白名单 ---- */
  if (u === '/api/datasource/access' && req.method === 'GET') {
    const cfg = readConfig(); const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再访问数据源' }, 401);
    if (!canAccessDataSource(cfg, actor.userId)) return sendJson(res, { success: false, msg: '当前账号没有数据源访问权限' }, 403);
    return sendJson(res, { success: true, allowed: true });
  }

  /* ---- 企业申请记录：普通成员仅本人；数据源白名单兼任信息部门全量查看角色。 ---- */
  if (u === '/api/applications' && req.method === 'GET') {
    const cfg = readConfig(); const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再读取申请记录' }, 401);
    if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪：' + _businessStoreState.database }, 503);
    try {
      const canViewAll = canAccessDataSource(cfg, actor.userId);
      const [applications, references] = await Promise.all([_businessStore.list(actor, canViewAll), _businessStore.references(actor, canViewAll)]);
      return sendJson(res, { success: true, canViewAll, applications, references }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) { return sendJson(res, { success: false, msg: '读取企业申请记录失败' }, 502); }
  }
  if (u === '/api/applications' && req.method === 'POST') {
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再保存申请记录' }, 401);
    if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪：' + _businessStoreState.database }, 503);
    const body = await readBody(req);
    try {
      const application = body && body.application;
      /* 不信任浏览器传来的 oaReal/oaNo：归档必须绑定服务端刚记录的真实审批实例。 */
      if (!_approvalStore || !_approvalStore.enabled()) return sendJson(res, { success: false, msg: '审批状态数据库未就绪，暂不能归档申请' }, 503);
      const instanceId = String(application && application.oaNo || '').trim();
      const requestId = String(application && application.id || '').trim();
      const bound = await _approvalStore.submittedFor({ instanceId, requestId, originatorUserId: actor.userId });
      if (!bound) return sendJson(res, { success: false, msg: '审批实例与当前申请或发起人不匹配，拒绝归档' }, 409);
      const saved = await _businessStore.create(body.application, actor);
      return sendJson(res, { success: true, id: saved.id, createdAt: saved.created_at }, 201);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 400); }
  }

  /* ---- 全店活动免审批：服务端创建活动明细、入库为已通过，并立即创建日历。 ---- */
  if (u === '/api/store-activities/complete' && req.method === 'POST') {
    const cfg = readConfig() || {}; const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再提交全店活动' }, 401);
    if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪：' + _businessStoreState.database }, 503);
    try {
      const body = await readBody(req);
      const application = normalizeExemptStoreActivity(body && body.application, actor);
      const sourceSnapshot = _dataSourceStore && _dataSourceStore.enabled() ? await _dataSourceStore.active() : null;
      if (!sourceSnapshot) return sendJson(res, { success: false, msg: '正式商品中间表未就绪，请刷新数据后重试' }, 503);
      if (String(sourceSnapshot.products_hash || '').toLowerCase() !== application.midTableSnapshot.sourceHash) {
        return sendJson(res, { success: false, msg: '商品中间表已更新，请刷新页面后重新提交，避免活动留存错误版本的数据' }, 409);
      }
      application.midTableSnapshot.sourceSnapshotId = String(sourceSnapshot.id || '');
      application.oaNo = 'EXEMPT_' + application.id;
      application.standardRows = storeActivityStandardRows(application);
      const detail = await createStoreActivityDetail(cfg, application, actor);
      application.oaTableUrl = detail.url;
      application.oaDetailWorkbookId = detail.workbookId;
      await _businessStore.createExemptStoreActivity(application, actor);
      let calendar = null;
      try { calendar = await createCalendarForApprovedApplication(application.oaNo, actor); }
      catch (e) { calendar = { failed: true, msg: e.message }; }
      logDing('store-activity-exempt', { id: application.id, actorUserId: actor.userId, giftCount: application.gifts.length, calendar: calendar && (calendar.eventId || calendar.skipped || calendar.failed || null) });
      return sendJson(res, { success: true, application, detail, calendar }, 201);
    } catch (e) {
      logDing('store-activity-exempt-error', { actorUserId: actor.userId, msg: e.message });
      return sendJson(res, { success: false, msg: e.message }, 400);
    }
  }

  /* ---- 已入库核对：仅信息部门白名单可读，固定字段查询，不提供数据库地址、凭据或任意 SQL。 ---- */
  if (u === '/api/application-audit' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪：' + _businessStoreState.database }, 503);
    try {
      const rows = await _businessStore.auditRows(200);
      return sendJson(res, { success: true, rows }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) { return sendJson(res, { success: false, msg: '读取入库核对记录失败' }, 502); }
  }
  /* ---- 已入库申请明细：固定字段、精确按申请单读取，不提供原始 JSON 或任意 SQL。 ---- */
  if (u === '/api/application-audit/detail' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪：' + _businessStoreState.database }, 503);
    const applicationId = new URL(req.url, 'http://localhost').searchParams.get('applicationId') || '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(applicationId)) return sendJson(res, { success: false, msg: '申请单号无效' }, 400);
    try {
      const detail = await _businessStore.auditDetail(applicationId);
      if (!detail) return sendJson(res, { success: false, msg: '未找到该入库申请' }, 404);
      return sendJson(res, { success: true, detail }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) { return sendJson(res, { success: false, msg: '读取入库申请明细失败' }, 502); }
  }

  /* ---- GET /api/config：返回当前配置（appSecret 仅返回是否已设置） ---- */
  if (u === '/api/config' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    if (!cfg) return sendJson(res, { success: true, config: null });
    const oa = cfg.oa || {};
    const secretOk = !!cfg.appSecret && !PLACEHOLDER.test(cfg.appSecret);
    const keyOk = !!cfg.appKey && !PLACEHOLDER.test(cfg.appKey);
    const oaKeyOk = !!oa.appKey && !PLACEHOLDER.test(oa.appKey);
    const oaSecretOk = !!oa.appSecret && !PLACEHOLDER.test(oa.appSecret);
    const ds = cfg.dataSource || {};
    return sendJson(res, { success: true, config: { baseUrl: cfg.baseUrl || '', appKeyConfigured: keyOk, appSecretSet: secretOk, tables: cfg.tables || {}, dataSource: { fieldMap: ds.fieldMap || {}, storePlatformMap: ds.storePlatformMap || [], midTableOverrides: ds.midTableOverrides || [] }, oa: { appKeyConfigured: oaKeyOk, appSecretSet: oaSecretOk, processCode: oa.processCode || '', originatorUserId: oa.originatorUserId || '', corpId: oa.corpId || '', archiveWorkspaceId: oa.archiveWorkspaceId || '', archiveParentNodeId: oa.archiveParentNodeId || '', loginConfigured: !!((oa.loginAppKey || oa.appKey) && (oa.loginAppSecret || oa.appSecret)), loginRedirectUri: oa.loginRedirectUri || '', calendarConfigured: !!(oa.calendarId && oa.appKey && oa.appSecret) } } });
  }

  /* ---- POST /api/config：仅覆盖提交的字段；appSecret 留空则保留原值 ---- */
  if (u === '/api/config' && req.method === 'POST') {
    let cfg = readConfig() || { baseUrl: '', appKey: '', appSecret: '', tables: { products: { apiId: '', tableId: '' }, stock: { apiId: '', tableId: '' } } };
    if (!requireDataSourceAccess(req, res, cfg)) return;
    const body = await readBody(req);
    cfg.tables = cfg.tables || {};
    if (body.baseUrl) cfg.baseUrl = body.baseUrl;
    if (body.appKey) cfg.appKey = body.appKey;
    if (body.appSecret) cfg.appSecret = body.appSecret;
    if (body.tables) {
      for (const name of ['products', 'stock']) {
        const t = body.tables[name];
        if (t) {
          cfg.tables[name] = cfg.tables[name] || { apiId: '', tableId: '' };
          if (t.apiId) cfg.tables[name].apiId = t.apiId;
          if (t.tableId) cfg.tables[name].tableId = t.tableId;
        }
      }
    }
    if (body.dataSource && typeof body.dataSource === 'object') {
      cfg.dataSource = cfg.dataSource || {};
      if (body.dataSource.fieldMap && typeof body.dataSource.fieldMap === 'object') cfg.dataSource.fieldMap = body.dataSource.fieldMap;
      if (Array.isArray(body.dataSource.storePlatformMap)) cfg.dataSource.storePlatformMap = body.dataSource.storePlatformMap;
      if (Object.prototype.hasOwnProperty.call(body.dataSource, 'midTableOverrides')) {
        try { cfg.dataSource.midTableOverrides = normalizeMidTableOverrides(body.dataSource.midTableOverrides); }
        catch (e) { return sendJson(res, { success: false, msg: e.message }, 400); }
      }
    }
    if (body.oa) {
      cfg.oa = cfg.oa || { appKey: '', appSecret: '', processCode: '', originatorUserId: '', corpId: '', archiveWorkspaceId: '', archiveParentNodeId: '' };
      if (body.oa.appKey) cfg.oa.appKey = body.oa.appKey;
      if (body.oa.appSecret) cfg.oa.appSecret = body.oa.appSecret;
      if (body.oa.processCode) cfg.oa.processCode = body.oa.processCode;
      if (body.oa.originatorUserId) cfg.oa.originatorUserId = body.oa.originatorUserId;
      if (body.oa.corpId) cfg.oa.corpId = body.oa.corpId;
      if (body.oa.archiveWorkspaceId) cfg.oa.archiveWorkspaceId = body.oa.archiveWorkspaceId;
      if (body.oa.archiveParentNodeId) cfg.oa.archiveParentNodeId = body.oa.archiveParentNodeId;
      if (body.oa.loginAppKey) cfg.oa.loginAppKey = body.oa.loginAppKey;
      if (body.oa.loginAppSecret) cfg.oa.loginAppSecret = body.oa.loginAppSecret;
      if (body.oa.loginRedirectUri) cfg.oa.loginRedirectUri = body.oa.loginRedirectUri;
    }
    try { writeConfig(cfg); return sendJson(res, { success: true, msg: '配置已保存' }); }
    catch (e) { return sendJson(res, { success: false, msg: e.message }, 500); }
  }

  /* ---- 企业正式数据快照：业务页面只读；配置和同步仍由数据源白名单控制。 ---- */
  if (u === '/api/datasource/current' && req.method === 'GET') {
    if (!currentDingUser(req)) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再读取正式数据' }, 401);
    try {
      const snapshot = _dataSourceStore ? await _dataSourceStore.active() : null;
      const ds = ((readConfig() || {}).dataSource) || {};
      return sendJson(res, { success: true, configured: !!(_dataSourceStore && _dataSourceStore.enabled()), snapshot: snapshot ? {
        id: snapshot.id, createdAt: snapshot.created_at, products: snapshot.products, stock: snapshot.stock,
        productsHash: snapshot.products_hash, stockHash: snapshot.stock_hash, productsCount: snapshot.products_count,
        stockCount: snapshot.stock_count, stockEnabled: snapshot.stock_enabled,
      } : null, settings: { fieldMap: ds.fieldMap || {}, storePlatformMap: ds.storePlatformMap || [], midTableOverrides: ds.midTableOverrides || [] } }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) { return sendJson(res, { success: false, msg: '读取企业正式数据失败' }, 502); }
  }

  /* ---- 手工同步：与定时任务共用同一把锁、同一校验和同一发布事务。 ---- */
  if (u === '/api/datasource/sync' && req.method === 'POST') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    const actor = currentDingUser(req);
    if (!_dataSourceSync) return sendJson(res, { success: false, msg: '企业数据源同步服务未就绪：' + _dataSourceSyncState.database }, 503);
    if (_dataSourceSync.running) return sendJson(res, { success: true, accepted: false, msg: '已有同步任务正在执行，请在同步记录中查看结果' }, 202);
    _dataSourceSync.run('manual', actor ? { userId: actor.userId, name: actor.name || '' } : null).catch((e) => { _dataSourceSyncState.lastError = e.message; });
    return sendJson(res, { success: true, accepted: true, msg: '已启动服务端同步任务；失败会自动重试，正式数据仅在完整校验后发布' }, 202);
  }

  /* ---- 同步运行情况只提供给数据源管理人员，不返回凭证或原始错误栈。 ---- */
  if (u === '/api/datasource/status' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    try {
      const runs = _dataSourceStore ? await _dataSourceStore.recentRuns(20) : [];
      return sendJson(res, { success: true, state: _dataSourceSyncState, runs }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) { return sendJson(res, { success: false, msg: '读取同步记录失败' }, 502); }
  }

  /* ---- POST /api/ding/events：钉钉 HTTP 事件订阅回调（验签、解密、加密确认） ---- */
  if (u === '/api/ding/events' && req.method === 'POST') {
    const cfg = readConfig(); const q = new URL(req.url, 'http://localhost').searchParams;
    const timestamp = q.get('timestamp') || ''; const nonce = q.get('nonce') || '';
    const signature = q.get('msg_signature') || q.get('signature') || '';
    const body = await readBody(req); const encrypt = body && body.encrypt;
    try {
      const eventCfg = dingEventConfig(cfg);
      const expected = dingEventSignature(eventCfg.token, timestamp, nonce, encrypt);
      if (!timestamp || !nonce || !encrypt || !safeEqualText(signature, expected)) {
        logDing('event-rejected', { reason: 'signature' });
        return sendJson(res, { success: false, msg: '钉钉事件签名校验失败' }, 401);
      }
      const decoded = dingEventDecrypt(encrypt, eventCfg);
      let event = null; try { event = JSON.parse(decoded.message); } catch (e) { throw new Error('钉钉事件内容不是有效 JSON'); }
      /* HTTP 回调与 Stream 共用同一状态机。先落状态再确认，让写入失败触发钉钉重试。 */
      try { await syncApprovalEvent(event); }
      catch (e) {
        logDing('event-sync-error', { msg: e.message });
        return sendJson(res, { success: false, msg: '审批事件暂无法写入，请稍后重试' }, 503);
      }
      logDing('event-received', { eventType: event.EventType || event.eventType || '', processInstanceId: event.processInstanceId || event.process_instance_id || '' });
      return sendJson(res, dingEventAck(eventCfg));
    } catch (e) {
      logDing('event-rejected', { reason: e.message });
      return sendJson(res, { success: false, msg: '钉钉事件回调校验失败' }, 400);
    }
  }

  /* ---- 钉钉网页登录：开始 OAuth / 回调 / 当前会话 ---- */
  /* 登录页在钉钉偶发未替换 $CORPID$ 时，只读取免登所需的非敏感企业标识。 */
  if (u === '/api/ding/login-context' && req.method === 'GET') {
    const corpId = String(((readConfig() || {}).oa || {}).corpId || '').trim();
    if (!/^ding[a-z0-9]+$/i.test(corpId)) return sendJson(res, { success: false, msg: '未配置有效的钉钉企业标识' }, 503, { 'Cache-Control': 'no-store' });
    return sendJson(res, { success: true, corpId }, 200, { 'Cache-Control': 'no-store' });
  }
  if (u === '/api/ding/login' && req.method === 'GET') {
    return sendJson(res, { success: false, msg: '网页登录已关闭，请从钉钉应用打开' }, 410);
  }
  if (u === '/api/ding/login/callback' && req.method === 'GET') {
    return sendJson(res, { success: false, msg: '网页登录已关闭，请从钉钉应用打开' }, 410);
  }
  if (u === '/api/ding/me' && req.method === 'GET') {
    const user = currentDingUser(req);
    const cfg = readConfig();
    if (!user) return sendJson(res, { success: false, msg: '请先完成钉钉登录' }, 401);
    return sendJson(res, { success: true, user: { userId: user.userId, name: user.name || '', dept: user.dept || null, source: user.source || '钉钉登录', allowManualBind: canManualBind(cfg, user.userId) } });
  }
  /* 刚完成免登后，主页只可一次性领取同一份已核验身份，避免登录页和主页重复向钉钉申请 authCode。 */
  if (u === '/api/ding/handoff' && req.method === 'GET') {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const user = consumeDingAuthHandoff(req, token);
    if (!user) return sendJson(res, { success: false, msg: '本次登录衔接已失效，请重新核验' }, 401);
    const cfg = readConfig();
    return sendJson(res, { success: true, user: { userId: user.userId, name: user.name || '', dept: user.dept || null, source: user.source, allowManualBind: canManualBind(cfg, user.userId) } }, 200, { 'Cache-Control': 'no-store' });
  }

  /* ---- POST /api/datacube：按 table 取 apiId/tableId，签名后转发数据魔方 ---- */
  if (u === '/api/datacube' && req.method === 'POST') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    if (!cfg || !cfg.appKey || !cfg.appSecret || PLACEHOLDER.test(cfg.appKey) || PLACEHOLDER.test(cfg.appSecret))
      return sendJson(res, { code: 'NO_CONFIG', msg: '请先在「数据源」面板配置有效的 APP Key / APP Secret' }, 400);
    const body = await readBody(req);
    const tableName = body.table || 'products';
    const t = (cfg.tables || {})[tableName];
    if (!t || !t.apiId) return sendJson(res, { code: 'NO_TABLE', msg: '未配置数据表 [' + tableName + '] 的接口ID' }, 400);
    const pageIndex = body.pageIndex ? Number(body.pageIndex) : 1;
    let pageSize = body.pageSize ? Number(body.pageSize) : 200; if (pageSize > 200) pageSize = 200;
    const timestamp = Date.now().toString();
    const sign = datacubeSign({ timestamp }, cfg.appSecret);
    const forwardBody = { apiId: t.apiId, pageIndex, pageSize };
    if (t.tableId) forwardBody.tableId = t.tableId;
    const target = String(cfg.baseUrl || '').replace(/\/+$/, '') + '/api/assetOpenApi/queryData';
    try {
      const r = await fetch(target, {
        method: 'POST',
        headers: { appKey: cfg.appKey, timestamp, sign, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(forwardBody),
      });
      const txt = await r.text();
      try { return sendJson(res, JSON.parse(txt)); }
      catch (e) { return sendJson(res, { code: 'BAD_UPSTREAM', msg: '上游返回非 JSON：' + txt.slice(0, 200) }, 502); }
    } catch (e) {
      return sendJson(res, { code: 'PROXY_ERROR', msg: e.message }, 502);
    }
  }

  /* ---- GET /api/ding/health：探测 OA 凭证能否换到 token（不回显 token/secret） ---- */
  if (u === '/api/ding/health' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    try { await dtToken(cfg); return sendJson(res, { success: true, tokenOk: true }); }
    catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- GET /api/ding/approval-sync/health：仅返回 Stream/补查/数据库状态，不返回凭证 ---- */
  if (u === '/api/ding/approval-sync/health' && req.method === 'GET') {
    const cfg = readConfig();
    if (!requireDataSourceAccess(req, res, cfg)) return;
    return sendJson(res, { success: true, stream: _approvalSyncState.stream, database: _approvalSyncState.database, lastEventAt: _approvalSyncState.lastEventAt, lastError: _approvalSyncState.lastError, lastReconciledAt: _approvalSyncState.lastReconciledAt, lastReconcileError: _approvalSyncState.lastReconcileError });
  }

  /* ---- POST /api/ding/approval-refresh：成员主动补查自己待终态审批，避免高频全量轮询 ---- */
  if (u === '/api/ding/approval-refresh' && req.method === 'POST') {
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再刷新审批状态' }, 401);
    const now = Date.now(); const key = String(actor.userId || ''); const last = _manualApprovalRefreshAt.get(key) || 0;
    const remain = MANUAL_APPROVAL_REFRESH_COOLDOWN_MS - (now - last);
    if (remain > 0) return sendJson(res, { success: false, msg: `请在 ${Math.ceil(remain / 1000)} 秒后再刷新` }, 429);
    _manualApprovalRefreshAt.set(key, now);
    try {
      const cfg = readConfig();
      const result = await reconcilePendingApprovalStatuses({ userId: actor.userId, canViewAll: canAccessDataSource(cfg, actor.userId) });
      if (result && result.skipped) return sendJson(res, { success: false, msg: '审批状态服务未就绪，请稍后重试' }, 503);
      return sendJson(res, { success: true, checked: result.checked || 0, updated: result.updated || 0 });
    } catch (e) {
      logDing('approval-manual-refresh-error', { userId: actor.userId, msg: e.message });
      return sendJson(res, { success: false, msg: '刷新审批状态失败，请稍后重试' }, 502);
    }
  }

  /* ---- POST /api/ding/approval-statuses：页面按审批实例 ID 读取服务端回填状态 ---- */
  if (u === '/api/ding/approval-statuses' && req.method === 'POST') {
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再读取审批状态' }, 401);
    const body = await readBody(req); const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100) : [];
    try {
      const cfg = readConfig();
      const statuses = _businessStore ? await _businessStore.statuses(instanceIds, actor, canAccessDataSource(cfg, actor.userId)) : {};
      return sendJson(res, { success: true, configured: !!(_businessStore && _businessStore.enabled()), statuses });
    } catch (e) { return sendJson(res, { success: false, msg: '读取审批状态失败' }, 502); }
  }

  /* ---- POST /api/ding/schema：按 processCode 拉取审批表单结构（默认取配置里的 processCode） ---- */
  if (u === '/api/ding/schema' && req.method === 'POST') {
    if (!currentDingUser(req)) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再读取审批表单结构' }, 401);
    const cfg = readConfig();
    const body = await readBody(req);
    const code = (body.processCode || '').trim() || ((cfg && cfg.oa && cfg.oa.processCode) || '');
    if (!code) return sendJson(res, { success: false, code: 'NO_PROCESS_CODE', msg: '缺少表单 processCode（可在接口配置填写，或本次传入）' }, 400);
    try {
      const out = await dtSchema(cfg, code);
      return sendJson(res, { success: out.status >= 200 && out.status < 300, httpStatus: out.status, processCode: code, data: out.json, raw: out.raw }, out.status >= 400 ? 502 : 200);
    } catch (e) {
      return sendJson(res, { success: false, msg: e.message }, 502);
    }
  }

  /* ---- POST /api/ding/upload：上传文件到审批钉盘，返回 DDAttachment 用的 value ---- */
  if (u === '/api/ding/upload' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    if (!body.base64) return sendJson(res, { success: false, msg: '缺少 base64 文件内容' }, 400);
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再上传附件' }, 401);
    try { const out = await dtUpload(cfg, Object.assign({}, body, { userId: actor.userId })); logDing('upload', { fileName: body.fileName, fileSize: body.fileSize, ok: out.ok, stage: out.stage, fileId: out.fileId }); return sendJson(res, out, out.ok ? 200 : 502); }
    catch (e) { return sendJson(res, { ok: false, stage: 'exception', error: e.message }, 502); }
  }

  /* ---- POST /api/ding/whoami：用钉钉免登 authCode 换当前登录人 userId ---- */
  if (u === '/api/ding/whoami' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    if (!body.code) return sendJson(res, { success: false, msg: '缺少免登 code' }, 400);
    try {
      const out = await dtWhoami(cfg, body.code);
      const ok = out.errcode === 0 && !!out.userId;
      logDing('whoami', { ok, errcode: out.errcode, userId: ok ? out.userId : null });
      const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
      const session = ok ? sessionHeaders({ userId: out.userId, name: out.name || '', dept: null, source: '钉钉免登' }, secure, cfg) : null;
      const handoff = session ? createDingAuthHandoff(session.sid, { userId: out.userId, name: out.name || '' }) : null;
      return sendJson(res, { success: ok, userId: ok ? out.userId : null, name: ok ? out.name : null, allowManualBind: ok ? canManualBind(cfg, out.userId) : false, handoff, errmsg: out.errmsg }, 200, session && session.headers);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/newdoc：在知识库文件夹内创建在线表格(WORKBOOK)，用于审批链接 ---- */
  if (u === '/api/ding/newdoc' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    try {
      const actor = currentDingUser(req); if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再创建协作表' }, 401);
      const uid = actor.userId;
      const token = await dtToken(cfg);
      const ju = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: uid }) })).json();
      const unionId = ju && ju.result && ju.result.unionid;
      const out = await dtNewDoc(cfg, { name: body.name, workspaceId: body.workspaceId, parentNodeId: body.parentNodeId, operatorId: unionId });
      const nid = out.json && (out.json.nodeId || out.json.docKey || out.json.id || (out.json.result && (out.json.result.nodeId || out.json.result.dentryUuid)));
      const ok = out.status >= 200 && out.status < 300 && !!nid;
      const url = ok ? (out.json.url || ('https://alidocs.dingtalk.com/i/nodes/' + nid)) : null;
      const urlNode = typeof url === 'string' && (url.match(/\/i\/nodes\/([^/?#]+)/) || [])[1];
      logDing('newdoc', { ok, status: out.status, err: (out.json && (out.json.code || out.json.message)) || out.raw });
      return sendJson(res, { success: ok, httpStatus: out.status, nodeId: ok ? nid : null, workbookId: ok ? (urlNode || nid) : null, url, data: out.json, raw: out.raw }, out.status >= 400 ? 502 : 200);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/docfill：向在线表格(WORKBOOK)写入选品二维数据 ---- */
  if (u === '/api/ding/docfill' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    try {
      const actor = currentDingUser(req); if (!actor) return sendJson(res, { ok: false, msg: '请先完成钉钉登录后再写入协作表' }, 401);
      const uid = actor.userId;
      const token = await dtToken(cfg);
      const ju = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: uid }) })).json();
      const unionId = ju && ju.result && ju.result.unionid;
      const out = await dtDocFill(cfg, { workbookId: body.workbookId, operatorId: unionId, values: body.values, sheets: body.sheets });
      logDing('docfill', { ok: out.ok, stage: out.stage, status: out.status, code: out.error && out.error.code, message: out.error && out.error.message });
      return sendJson(res, out, out.ok ? 200 : 502);
    } catch (e) { return sendJson(res, { ok: false, stage: 'exception', msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/calendar/create：在订阅日历创建活动日程（测试/手动用，审批通过自动触发走钩子） ---- */
  if (u === '/api/ding/calendar/create' && req.method === 'POST') {
    const body = await readBody(req);
    const processInstanceId = String(body.processInstanceId || '').trim();
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再创建活动日程' }, 401);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(processInstanceId)) return sendJson(res, { success: false, msg: '缺少有效的审批实例编号' }, 400);
    try {
      const out = await createCalendarForApprovedApplication(processInstanceId, actor);
      if (out && out.skipped) return sendJson(res, { success: false, msg: '未配置活动日历' }, 503);
      logDing('calendar-create', { ok: !!(out && out.eventId), eventId: out && out.eventId || null, instanceId: processInstanceId, actorUserId: actor.userId, existing: !!(out && out.existing) });
      return sendJson(res, { success: true, eventId: out.eventId, existing: !!out.existing, url: 'https://alidocs.dingtalk.com/calendar/event/' + out.eventId });
    } catch (e) { logDing('calendar-create-error', { msg: e.message }); return sendJson(res, { success: false, msg: e.message }, Number(e.status) || 502); }
  }

  /* ---- POST /api/ding/comment：给审批实例追加评论（在线协作表链接等） ---- */
  if (u === '/api/ding/comment' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    if (!body.processInstanceId || !body.text) return sendJson(res, { success: false, msg: '缺少 processInstanceId/text' }, 400);
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再追加审批评论' }, 401);
    try {
      if (!_businessStore || !_businessStore.enabled()) return sendJson(res, { success: false, msg: '企业申请数据库未就绪，不能追加审批评论' }, 503);
      const row = await _businessStore.getByInstanceId(body.processInstanceId);
      if (!row) return sendJson(res, { success: false, msg: '未找到对应企业申请，不能追加审批评论' }, 404);
      if (String(row.originator_user_id || '') !== String(actor.userId || '') && !canAccessDataSource(cfg, actor.userId)) {
        return sendJson(res, { success: false, msg: '只能评论本人审批对应的协作表链接' }, 403);
      }
      const tableUrl = String((row.payload || {}).oaTableUrl || '');
      if (!tableUrl || body.text !== '本次选品在线协作明细表：' + tableUrl) {
        return sendJson(res, { success: false, msg: '审批评论内容与已归档协作表不匹配' }, 403);
      }
      const out = await dtComment(cfg, { processInstanceId: body.processInstanceId, text: body.text, commentUserid: actor.userId });
      logDing('comment', { ok: out.errcode === 0, errcode: out.errcode, errmsg: out.errmsg });
      return sendJson(res, { success: out.errcode === 0, errcode: out.errcode, errmsg: out.errmsg }, out.errcode === 0 ? 200 : 502);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/create：发起审批实例（processCode/originatorUserId 缺省取配置） ---- */
  if (u === '/api/ding/create' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再发起审批' }, 401);
    const configuredProcessCode = String((cfg.oa && cfg.oa.processCode) || '').trim();
    if (!configuredProcessCode) return sendJson(res, { success: false, msg: '未配置营销活动审批流程' }, 503);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(body.requestId || ''))) return sendJson(res, { success: false, msg: '缺少有效申请编号' }, 400);
    /* 不接受浏览器指定其它流程、审批人或发起人，避免成为通用 OA 代理。 */
    body.processCode = configuredProcessCode;
    delete body.approvers;
    delete body.approversV2;
    body.originatorUserId = actor.userId;
    try {
      const out = await dtCreate(cfg, body);
      const iid = out.json && (out.json.instanceId || out.json.processInstanceId);
      const ok = out.status >= 200 && out.status < 300 && !!iid;
      if (ok && _approvalStore && _approvalStore.enabled()) {
        try { await _approvalStore.recordSubmitted({ instanceId: iid, requestId: body.requestId, originatorUserId: actor.userId }); }
        catch (e) { logDing('approval-status-record-error', { instanceId: iid, msg: e.message }); }
      }
      logDing('create', {
        processCode: body.processCode || (cfg.oa && cfg.oa.processCode), deptId: body.deptId,
        fields: (body.formComponentValues || []).map((f) => ({ type: f.componentType, name: f.name, value: typeof f.value === 'string' ? f.value.slice(0, 120) : f.value })),
        httpStatus: out.status, ok, instanceId: ok ? iid : null, err: out.json && (out.json.code || out.json.message || out.json.errmsg) || out.raw || null,
      });
      return sendJson(res, { success: ok, httpStatus: out.status, instanceId: ok ? iid : null, statusSyncConfigured: !!(_approvalStore && _approvalStore.enabled()), data: out.json, raw: out.raw }, out.status >= 400 ? 502 : 200);
    } catch (e) { logDing('create-error', { msg: e.message }); return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/user：按 userId 查用户（诊断可见性/所在部门，errcode 0 为可见） ---- */
  if (u === '/api/ding/user' && req.method === 'POST') {
    const cfg = readConfig();
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再使用诊断入口' }, 401);
    if (!canManualBind(cfg, actor.userId)) return sendJson(res, { success: false, msg: '当前账号没有成员诊断权限' }, 403);
    const body = await readBody(req);
    const uid = (body.userid || '').trim();
    if (!uid) return sendJson(res, { success: false, msg: '缺少 userid' }, 400);
    try {
      const out = await dtUserGet(cfg, uid);
      const j = out.json || {};
      return sendJson(res, { success: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg, userid: uid, dept_id_list: j.result && j.result.dept_id_list, name: j.result && j.result.name, active: j.result && j.result.active, raw: out.raw });
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- 静态文件服务：只允许必要前端资源，配置、源码、日志和测试永不经 Web 下发。 ---- */
  const cfg = readConfig();
  if ((u === '/' || u === '/index.html' || u === '/login.html') && redirectToCanonicalLogin(req, res, cfg)) return;
  const isPublicFile = STATIC_PUBLIC_FILES.has(u);
  const isAuthenticatedFile = STATIC_AUTHENTICATED_FILES.has(u);
  if (!isPublicFile && !isAuthenticatedFile) { res.writeHead(404); return res.end('not found'); }
  const currentUser = isAuthenticatedFile ? currentDingUser(req) : null;
  if (isAuthenticatedFile && !currentUser) {
    if (u === '/' || u === '/index.html') return sendRedirect(res, loginPageForRequest(req));
    return sendJson(res, { success: false, msg: '请先完成钉钉登录' }, 401);
  }
  const p = u === '/' ? '/index.html' : u;
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const staticHeaders = { 'Cache-Control': u === DING_JSAPI_ASSET ? 'public, max-age=31536000, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff' };
    res.writeHead(200, Object.assign({ 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }, staticHeaders));
    res.end(buf);
  });
});

if (require.main === module) server.listen(PORT, BIND_HOST, () => {
  console.log('一体化服务已启动：http://' + BIND_HOST + ':' + PORT + '（静态 + 受保护 API）');
  dtToken(readConfig()).catch((e) => { logDing('ding-token-warm-error', { msg: e.message }); });
  startBusinessStore().catch((e) => { _businessStoreState.lastError = e.message; logDing('business-store-start-error', { stage: 'bootstrap', msg: e.message }); });
  startApprovalSync().catch((e) => { _approvalSyncState.lastError = e.message; logDing('approval-sync-start-error', { stage: 'bootstrap', msg: e.message }); });
  startDataSourceSync().catch((e) => { _dataSourceSyncState.lastError = e.message; logDing('datasource-sync-start-error', { stage: 'bootstrap', msg: e.message }); });
});
module.exports = { server, dingEventSignature, dingEventDecrypt, dingEventEncrypt, dingEventAck, safeEqualText, loginRedirectUri, loginPageForRequest, canonicalLoginPage, canAccessDataSource, encodeDingSession, decodeDingSession, createDingAuthHandoff, consumeDingAuthHandoff, normalizeMidTableOverrides, normalizeExemptStoreActivity, storeActivityDetailSheets, startDataSourceSync, startBusinessStore, calendarDescFromApplication, chunkRowsForWrite, DOC_FILL_MAX_ROWS, DOC_FILL_MAX_BYTES };

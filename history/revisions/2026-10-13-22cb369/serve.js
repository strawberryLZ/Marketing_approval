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
const STATIC_PUBLIC_FILES = new Set(['/login.html']);
const STATIC_AUTHENTICATED_FILES = new Set(['/', '/index.html', '/app.js', '/data.js', '/datasource.js', '/products_seed.js', '/sample-data.js', '/styles.css', '/upload.js', '/xlsx.full.min.js']);
const PUBLIC_API_PATHS = new Set(['/api/ding/events', '/api/ding/whoami', '/api/ding/login', '/api/ding/login/callback']);

const PLACEHOLDER = /^(<|YOUR_|\s*$)/; // 未替换的占位符视为未配置
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
const APPROVAL_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
let _dataSourceStore = null;
let _dataSourceSync = null;
let _dataSourceSyncState = { database: '未配置', running: false, lastStartedAt: null, lastFinishedAt: null, lastScheduledAt: null, lastResult: null, lastError: null };
let _businessStore = null;
let _businessStoreState = { database: '未配置', lastError: null };
const DING_LOGIN_TTL = 8 * 60 * 60 * 1000;
const DING_LOGIN_STATE_TTL = 10 * 60 * 1000;
const DING_SESSION_COOKIE = 'mkt_ding_session';
const DING_STATE_COOKIE = 'mkt_ding_oauth_state';
const _dingSessions = new Map();
const _dingLoginStates = new Map();
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
  return { 'Set-Cookie': cookieHeader(DING_SESSION_COOKIE, sid, DING_LOGIN_TTL, secure) };
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
  /* 审批通过 → 自动在订阅日历「电商活动日历」创建活动日程（异步、不阻塞审批同步） */
  if (mapped.status === '已通过') {
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
  return std.length ? std.concat(items) : items;
}
/* 满赠规则在活动级 standardMeta.manzeng，回退到标准明细行的「满赠规则」列。 */
function calendarManzengOf(a, rows) {
  const direct = a && a.standardMeta && String(a.standardMeta.manzeng || '').trim();
  if (direct) return direct;
  for (const it of rows) { const v = it && String(it['满赠规则'] || '').trim(); if (v) return v; }
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
  L.push('四、活动文档');
  L.push(app.oaTableUrl || '详见审批单附件');
  return L.join('\n');
}
/* 日历写入仅使用独立的开放平台日历应用凭证（calendarAppKey/calendarAppSecret，已开 Calendar.Event.Write），
 * 不复用策略审批应用（oa.appKey/oa.appSecret），避免越权借用审批应用后台权限。 */
let _calTok = { token: '', expireAt: 0 };
async function dtCalToken(cfg) {
  const oa = cfg.oa || {};
  const appKey = oa.calendarAppKey;
  const appSecret = oa.calendarAppSecret;
  if (!appKey || !appSecret || PLACEHOLDER.test(appKey) || PLACEHOLDER.test(appSecret)) throw new Error('未配置日历写入凭证（calendarAppKey/Secret）');
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
async function triggerCalendarForPassed(processInstanceId) {
  const cfg = readConfig() || {}; const oa = cfg.oa || {};
  const calId = String(oa.calendarId || '');
  if (!calId) { logDing('calendar-auto-skip', { instanceId: processInstanceId, reason: '未配置 oa.calendarId' }); return null; }
  if (!_businessStore || !_businessStore.enabled()) return null;
  const row = await _businessStore.getByInstanceId(processInstanceId);
  if (!row) { logDing('calendar-auto-skip', { instanceId: processInstanceId, reason: 'application-not-found' }); return null; }
  if (row.calendar_event_id) return row.calendar_event_id;
  const a = Object.assign({}, row.payload || {}, { id: row.id });
  if (!a.start || !a.end) { logDing('calendar-auto-skip', { instanceId: processInstanceId, reason: 'missing-dates' }); return null; }
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
    logDing('calendar-auto-error', { instanceId: processInstanceId, msg: e.message });
    return null;
  }
  if (eventId) {
    await _businessStore.markCalendarResult(processInstanceId, { status: 'created', eventId });
    logDing('calendar-auto-created', { instanceId: processInstanceId, eventId });
    return { eventId };
  }
  await _businessStore.markCalendarResult(processInstanceId, { status: 'failed', err: '未返回 eventId' });
  logDing('calendar-auto-error', { instanceId: processInstanceId, msg: 'no-event-id' });
  return null;
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
async function reconcilePendingApprovalStatuses() {
  if (!_approvalStore || !_approvalStore.enabled() || !_businessStore || !_businessStore.enabled()) return { skipped: true };
  const cfg = readConfig() || {};
  const pending = await _approvalStore.pending(100);
  let updated = 0;
  let failed = false;
  for (const item of pending) {
    try {
      const out = await dtWorkflowInstance(cfg, item.instanceId);
      if (out.status < 200 || out.status >= 300) throw new Error('workflow instance query HTTP ' + out.status);
      const mapped = normalizeWorkflowInstanceStatus(out.json && out.json.result);
      if (!mapped) continue;
      const result = await applyApprovalStatus(item.instanceId, mapped, 'approval-workflow-reconcile');
      if (result && !result.ignored) updated += 1;
    } catch (e) {
      failed = true;
      _approvalSyncState.lastReconcileError = e.message;
      logDing('approval-workflow-reconcile-error', { instanceId: item.instanceId, msg: e.message });
    }
  }
  _approvalSyncState.lastReconciledAt = new Date().toISOString();
  if (!failed) _approvalSyncState.lastReconcileError = null;
  logDing('approval-workflow-reconcile', { checked: pending.length, updated });
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
  const workspaceId = p.workspaceId || ((cfg.oa || {}).archiveWorkspaceId);
  const parentNodeId = p.parentNodeId || ((cfg.oa || {}).archiveParentNodeId);
  if (!workspaceId || !parentNodeId) return { status: 0, json: { code: 'NO_TARGET', message: '缺少知识库 workspaceId/parentNodeId' } };
  const body = { name: p.name || '在线表格', docType: 'WORKBOOK', operatorId: p.operatorId };
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
    const range = `A1:${colLetter(values[0].length)}${values.length}`;
    const rp = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets/${encodeURIComponent(sheet.id)}/ranges/${range}?operatorId=${encodeURIComponent(op)}`, { method: 'PUT', headers: H, body: JSON.stringify({ values }) });
    const txt = await rp.text(); let jp = null; try { jp = JSON.parse(txt); } catch (e) {}
    const detail = jp && typeof jp === 'object' ? {
      code: jp.code || jp.errorCode || jp.errcode || '',
      message: jp.message || jp.errorMessage || jp.errmsg || '',
    } : { message: txt.slice(0, 300) };
    if (rp.status < 200 || rp.status >= 300) return { ok: false, stage: 'write-sheet', status: rp.status, error: detail, sheetId: sheet.id, sheetName: sheet.name, range };
    results.push({ sheetId: sheet.id, sheetName: sheet.name, range, status: rp.status });
  }
  return { ok: true, sheets: results, sheetId: results[0].sheetId, sheetName: results[0].sheetName, range: results[0].range, status: results[0].status };
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
      const saved = await _businessStore.create(body.application, actor);
      return sendJson(res, { success: true, id: saved.id, createdAt: saved.created_at }, 201);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 400); }
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
    return sendJson(res, { success: true, config: { baseUrl: cfg.baseUrl || '', appKeyConfigured: keyOk, appSecretSet: secretOk, tables: cfg.tables || {}, dataSource: { fieldMap: ds.fieldMap || {}, storePlatformMap: ds.storePlatformMap || [] }, oa: { appKeyConfigured: oaKeyOk, appSecretSet: oaSecretOk, processCode: oa.processCode || '', originatorUserId: oa.originatorUserId || '', corpId: oa.corpId || '', archiveWorkspaceId: oa.archiveWorkspaceId || '', archiveParentNodeId: oa.archiveParentNodeId || '', loginConfigured: !!((oa.loginAppKey || oa.appKey) && (oa.loginAppSecret || oa.appSecret)), loginRedirectUri: oa.loginRedirectUri || '' } } });
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
      } : null, settings: { fieldMap: ds.fieldMap || {}, storePlatformMap: ds.storePlatformMap || [] } }, 200, { 'Cache-Control': 'no-store' });
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
      logDing('event-received', { eventType: event.EventType || event.eventType || '', processInstanceId: event.processInstanceId || event.process_instance_id || '' });
      return sendJson(res, dingEventAck(eventCfg));
    } catch (e) {
      logDing('event-rejected', { reason: e.message });
      return sendJson(res, { success: false, msg: '钉钉事件回调校验失败' }, 400);
    }
  }

  /* ---- 钉钉网页登录：开始 OAuth / 回调 / 当前会话 ---- */
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
      const headers = ok ? sessionHeaders({ userId: out.userId, name: out.name || '', dept: null, source: '钉钉免登' }, secure, cfg) : null;
      return sendJson(res, { success: ok, userId: ok ? out.userId : null, name: ok ? out.name : null, allowManualBind: ok ? canManualBind(cfg, out.userId) : false, errmsg: out.errmsg }, 200, headers);
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
    const cfg = readConfig(); const body = await readBody(req);
    if (!body.title || !body.startDate || !body.endDate) return sendJson(res, { success: false, msg: '缺少 title/startDate/endDate' }, 400);
    try {
      const out = await dtCalendarEventCreate(cfg, Object.assign({}, body, { calendarId: body.calendarId || (cfg.oa && cfg.oa.calendarId) }));
      const eventId = out && (out.id || out.iCalUID);
      logDing('calendar-create', { ok: !!eventId, eventId: eventId || null, title: body.title });
      return sendJson(res, { success: !!eventId, eventId: eventId || null, url: eventId ? 'https://alidocs.dingtalk.com/calendar/event/' + eventId : null, data: out }, eventId ? 200 : 502);
    } catch (e) { logDing('calendar-create-error', { msg: e.message }); return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/comment：给审批实例追加评论（在线协作表链接等） ---- */
  if (u === '/api/ding/comment' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    if (!body.processInstanceId || !body.text) return sendJson(res, { success: false, msg: '缺少 processInstanceId/text' }, 400);
    const actor = currentDingUser(req);
    if (!actor) return sendJson(res, { success: false, msg: '请先完成钉钉登录后再追加审批评论' }, 401);
    try {
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
  if (isAuthenticatedFile && !currentDingUser(req)) {
    if (u === '/' || u === '/index.html') return sendRedirect(res, loginPageForRequest(req));
    return sendJson(res, { success: false, msg: '请先完成钉钉登录' }, 401);
  }
  const p = u === '/' ? '/index.html' : u;
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const staticHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
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
module.exports = { server, dingEventSignature, dingEventDecrypt, dingEventEncrypt, dingEventAck, safeEqualText, loginRedirectUri, loginPageForRequest, canonicalLoginPage, canAccessDataSource, encodeDingSession, decodeDingSession, startDataSourceSync, startBusinessStore, calendarDescFromApplication };

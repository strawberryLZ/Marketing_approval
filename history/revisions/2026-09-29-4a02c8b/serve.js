// 本地一体化服务：静态预览 + /api/config + /api/datacube（数据魔方签名转发）
// 用法：node serve.js  →  打开 http://localhost:8760
// 说明：与 server.ps1 等价地支持接口配置读写与数据魔方拉取，凭证与拉取都落在本副本目录内。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PORT = 8760;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

const PLACEHOLDER = /^(<|YOUR_|\s*$)/; // 未替换的占位符视为未配置
function readConfig() {
  try {
    let raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    while (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 去除全部前置 UTF-8 BOM
    return JSON.parse(raw);
  } catch (e) { return null; }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}
function sendJson(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
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
let _dt = { token: '', expireAt: 0 };
/* 留痕：每次 OA 调用的映射与钉钉返回写入 oa-call.log，便于运营提交后回传校验（不记录 base64/secret） */
function logDing(ev, info) {
  try { const line = JSON.stringify(Object.assign({ t: new Date().toISOString(), ev }, info)) + '\n'; fs.appendFileSync(path.join(ROOT, 'oa-call.log'), line, 'utf8'); } catch (e) { /* 忽略写日志失败 */ }
}
async function dtToken(cfg) {
  const oa = cfg && cfg.oa;
  if (!oa || !oa.appKey || !oa.appSecret || PLACEHOLDER.test(oa.appKey) || PLACEHOLDER.test(oa.appSecret))
    throw new Error('未配置有效的 OA 审批 APP Key / APP Secret');
  if (_dt.token && Date.now() < _dt.expireAt) return _dt.token;
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: oa.appKey, appSecret: oa.appSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.accessToken) throw new Error('获取 access_token 失败：' + (j.message || j.errmsg || JSON.stringify(j)));
  _dt = { token: j.accessToken, expireAt: Date.now() + (j.expireIn || 7200) * 1000 - 120000 };
  return j.accessToken;
}
async function dtSchema(cfg, processCode) {
  const token = await dtToken(cfg);
  const url = 'https://api.dingtalk.com/v1.0/workflow/forms/schemas/processCodes?processCode=' + encodeURIComponent(processCode);
  const r = await fetch(url, { method: 'GET', headers: { 'x-acs-dingtalk-access-token': token } });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) { /* 保留原文 */ }
  return { status: r.status, json: j, raw: j ? null : txt.slice(0, 400) };
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
  const wid = p.workbookId; const op = p.operatorId; const normalized = normalizeSheetValues(p.values);
  if (!wid || !op || !normalized.values) return { ok: false, stage: 'param', msg: !wid || !op ? '缺 workbookId/operatorId' : normalized.error };
  const values = normalized.values;
  const H = { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token };
  const rs = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets?operatorId=${encodeURIComponent(op)}`, { method: 'GET', headers: H });
  const js = await rs.json().catch(() => null); const sheet = js && Array.isArray(js.value) && js.value[0];
  if (!sheet) return { ok: false, stage: 'sheets', status: rs.status, body: js };
  const range = `A1:${colLetter(values[0].length)}${values.length}`;
  const rp = await fetch(`https://api.dingtalk.com/v1.0/doc/workbooks/${encodeURIComponent(wid)}/sheets/${encodeURIComponent(sheet.id)}/ranges/${range}?operatorId=${encodeURIComponent(op)}`, { method: 'PUT', headers: H, body: JSON.stringify({ values }) });
  const txt = await rp.text(); let jp = null; try { jp = JSON.parse(txt); } catch (e) {}
  const detail = jp && typeof jp === 'object' ? {
    code: jp.code || jp.errorCode || jp.errcode || '',
    message: jp.message || jp.errorMessage || jp.errmsg || '',
  } : { message: txt.slice(0, 300) };
  return { ok: rp.status >= 200 && rp.status < 300, sheetId: sheet.id, sheetName: sheet.name, range, status: rp.status, error: detail };
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
  const u = decodeURIComponent(req.url.split('?')[0]);

  /* ---- GET /api/config：返回当前配置（appSecret 仅返回是否已设置） ---- */
  if (u === '/api/config' && req.method === 'GET') {
    const cfg = readConfig();
    if (!cfg) return sendJson(res, { success: true, config: null });
    const secretOk = !!cfg.appSecret && !PLACEHOLDER.test(cfg.appSecret);
    const keyOk = !!cfg.appKey && !PLACEHOLDER.test(cfg.appKey);
    const oa = cfg.oa || {};
    const oaKeyOk = !!oa.appKey && !PLACEHOLDER.test(oa.appKey);
    const oaSecretOk = !!oa.appSecret && !PLACEHOLDER.test(oa.appSecret);
    return sendJson(res, { success: true, config: { baseUrl: cfg.baseUrl || '', appKey: keyOk ? cfg.appKey : '', appSecretSet: secretOk, tables: cfg.tables || {}, oa: { appKey: oaKeyOk ? oa.appKey : '', appSecretSet: oaSecretOk, processCode: oa.processCode || '', originatorUserId: oa.originatorUserId || '', corpId: oa.corpId || '', archiveWorkspaceId: oa.archiveWorkspaceId || '', archiveParentNodeId: oa.archiveParentNodeId || '' } } });
  }

  /* ---- POST /api/config：仅覆盖提交的字段；appSecret 留空则保留原值 ---- */
  if (u === '/api/config' && req.method === 'POST') {
    const body = await readBody(req);
    let cfg = readConfig() || { baseUrl: '', appKey: '', appSecret: '', tables: { products: { apiId: '', tableId: '' }, stock: { apiId: '', tableId: '' } } };
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
    if (body.oa) {
      cfg.oa = cfg.oa || { appKey: '', appSecret: '', processCode: '', originatorUserId: '', corpId: '', archiveWorkspaceId: '', archiveParentNodeId: '' };
      if (body.oa.appKey) cfg.oa.appKey = body.oa.appKey;
      if (body.oa.appSecret) cfg.oa.appSecret = body.oa.appSecret;
      if (body.oa.processCode) cfg.oa.processCode = body.oa.processCode;
      if (body.oa.originatorUserId) cfg.oa.originatorUserId = body.oa.originatorUserId;
      if (body.oa.corpId) cfg.oa.corpId = body.oa.corpId;
      if (body.oa.archiveWorkspaceId) cfg.oa.archiveWorkspaceId = body.oa.archiveWorkspaceId;
      if (body.oa.archiveParentNodeId) cfg.oa.archiveParentNodeId = body.oa.archiveParentNodeId;
    }
    try { writeConfig(cfg); return sendJson(res, { success: true, msg: '配置已保存' }); }
    catch (e) { return sendJson(res, { success: false, msg: e.message }, 500); }
  }

  /* ---- POST /api/datacube：按 table 取 apiId/tableId，签名后转发数据魔方 ---- */
  if (u === '/api/datacube' && req.method === 'POST') {
    const cfg = readConfig();
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
    try { await dtToken(cfg); return sendJson(res, { success: true, tokenOk: true }); }
    catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/schema：按 processCode 拉取审批表单结构（默认取配置里的 processCode） ---- */
  if (u === '/api/ding/schema' && req.method === 'POST') {
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
    try { const out = await dtUpload(cfg, body); logDing('upload', { fileName: body.fileName, fileSize: body.fileSize, ok: out.ok, stage: out.stage, fileId: out.fileId }); return sendJson(res, out, out.ok ? 200 : 502); }
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
      return sendJson(res, { success: ok, userId: ok ? out.userId : null, name: ok ? out.name : null, errmsg: out.errmsg });
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/newdoc：在知识库文件夹内创建在线表格(WORKBOOK)，用于审批链接 ---- */
  if (u === '/api/ding/newdoc' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    try {
      const uid = body.operatorUserId || (cfg.oa && cfg.oa.originatorUserId);
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
      const uid = body.operatorUserId || (cfg.oa && cfg.oa.originatorUserId);
      const token = await dtToken(cfg);
      const ju = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + encodeURIComponent(token), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userid: uid }) })).json();
      const unionId = ju && ju.result && ju.result.unionid;
      const out = await dtDocFill(cfg, { workbookId: body.workbookId, operatorId: unionId, values: body.values });
      logDing('docfill', { ok: out.ok, stage: out.stage, status: out.status, code: out.error && out.error.code, message: out.error && out.error.message });
      return sendJson(res, out, out.ok ? 200 : 502);
    } catch (e) { return sendJson(res, { ok: false, stage: 'exception', msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/comment：给审批实例追加评论（在线协作表链接等） ---- */
  if (u === '/api/ding/comment' && req.method === 'POST') {
    const cfg = readConfig(); const body = await readBody(req);
    if (!body.processInstanceId || !body.text) return sendJson(res, { success: false, msg: '缺少 processInstanceId/text' }, 400);
    try {
      const out = await dtComment(cfg, { processInstanceId: body.processInstanceId, text: body.text, commentUserid: body.commentUserid || (cfg.oa && cfg.oa.originatorUserId) });
      logDing('comment', { ok: out.errcode === 0, errcode: out.errcode, errmsg: out.errmsg });
      return sendJson(res, { success: out.errcode === 0, errcode: out.errcode, errmsg: out.errmsg }, out.errcode === 0 ? 200 : 502);
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/create：发起审批实例（processCode/originatorUserId 缺省取配置） ---- */
  if (u === '/api/ding/create' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    try {
      const out = await dtCreate(cfg, body);
      const iid = out.json && (out.json.instanceId || out.json.processInstanceId);
      const ok = out.status >= 200 && out.status < 300 && !!iid;
      logDing('create', {
        processCode: body.processCode || (cfg.oa && cfg.oa.processCode), deptId: body.deptId,
        fields: (body.formComponentValues || []).map((f) => ({ type: f.componentType, name: f.name, value: typeof f.value === 'string' ? f.value.slice(0, 120) : f.value })),
        httpStatus: out.status, ok, instanceId: ok ? iid : null, err: out.json && (out.json.code || out.json.message || out.json.errmsg) || out.raw || null,
      });
      return sendJson(res, { success: ok, httpStatus: out.status, instanceId: ok ? iid : null, data: out.json, raw: out.raw }, out.status >= 400 ? 502 : 200);
    } catch (e) { logDing('create-error', { msg: e.message }); return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/create_legacy：诊断用（旧版 topapi，错误信息更具体） ---- */
  if (u === '/api/ding/create_legacy' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    try { const out = await dtCreateLegacy(cfg, body); return sendJson(res, { success: out.json && out.json.errcode === 0, httpStatus: out.status, errcode: out.json && out.json.errcode, errmsg: out.json && out.json.errmsg, result: out.json, raw: out.raw }); }
    catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- POST /api/ding/user：按 userId 查用户（诊断可见性/所在部门，errcode 0 为可见） ---- */
  if (u === '/api/ding/user' && req.method === 'POST') {
    const cfg = readConfig();
    const body = await readBody(req);
    const uid = (body.userid || '').trim() || ((cfg && cfg.oa && cfg.oa.originatorUserId) || '');
    if (!uid) return sendJson(res, { success: false, msg: '缺少 userid（可在接口配置填发起人，或本次传入）' }, 400);
    try {
      const out = await dtUserGet(cfg, uid);
      const j = out.json || {};
      return sendJson(res, { success: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg, userid: uid, dept_id_list: j.result && j.result.dept_id_list, name: j.result && j.result.name, active: j.result && j.result.active, raw: out.raw });
    } catch (e) { return sendJson(res, { success: false, msg: e.message }, 502); }
  }

  /* ---- 静态文件服务 ---- */
  let p = u; if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log('一体化服务已启动：http://localhost:' + PORT + '（静态 + /api/config + /api/datacube）'));

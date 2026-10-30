const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

async function main() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-bootstrap-user-'));
  const configPath = path.join(runtimeDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    security: { sessionSigningSecret: 'test-bootstrap-signing-secret' },
    oa: { appKey: 'ding-test', appSecret: 'test-oa-secret' },
  }), { mode: 0o600 });
  process.env.MARKETING_CONFIG_PATH = configPath;
  process.env.MARKETING_RUNTIME_DIR = runtimeDir;

  const { server, encodeDingSession, createDingAuthHandoff, consumeDingAuthHandoff } = require('../serve');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const loginHtml = await (await fetch(baseUrl + '/login.html')).text();
    assert.match(loginHtml, /<header class="topbar">[\s\S]*?<nav class="tabs"/, '首次免登时也必须先显示同一页面框架');
    const sdk = await fetch(baseUrl + '/dingtalk.open-3.0.41.js');
    assert.equal(sdk.status, 200, '钉钉 SDK 必须由本站提供，避免首屏依赖第三方 CDN');
    assert.match(String(sdk.headers.get('cache-control')), /immutable/, '固定 SDK 版本必须允许客户端复用缓存');
    const session = encodeDingSession({ userId: 'old-member', name: '上次登录人', source: '钉钉免登' }, { security: { sessionSigningSecret: 'test-bootstrap-signing-secret' } });
    const response = await fetch(baseUrl + '/', { headers: { Cookie: `mkt_ding_session=${session}` } });
    const html = await response.text();
    assert.equal(response.status, 200, '持有有效会话时可以直接取得首页框架');
    assert(!html.includes('上次登录人') && !html.includes('old-member'), '上次会话身份不得在本次核验前展示或注入首页');
    assert.match(html, /<body class="auth-pending">[\s\S]*?<div id="auth-gate"/, '核验期间只展示框架和加载状态');
    assert.doesNotMatch(html, /<script defer src="products_seed\.js/, '首页不得加载可能过期的商品种子表');
    assert.doesNotMatch(html, /<script defer src="xlsx\.full\.min\.js/, '首页不得加载仅在 Excel 操作时使用的库');
    assert.match(html, /window\.MKT_LOAD_XLSX/, '首页必须提供 Excel 按需加载器');
    assert(!html.includes('test-bootstrap-signing-secret') && !html.includes('test-oa-secret'), '首页不得包含服务端密钥');

    const script = (Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map((m) => m[1]).find((s) => s.includes('MKT_AUTH_PROMISE')) || '');
    assert(script, '首页必须在业务脚本前启动钉钉核验');
    const calls = [];
    const window = { dd: {
      ready: (fn) => fn(),
      runtime: { permission: { requestAuthCode: ({ corpId, onSuccess }) => {
        calls.push(['requestAuthCode', corpId]);
        onSuccess({ code: 'fresh-code' });
      } } },
    } };
    const context = { window, location: { search: '?corpId=dingtestcorp' }, URLSearchParams,
      document: {}, Promise, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        calls.push([url, options && JSON.parse(options.body).code]);
        assert.equal(url, '/api/ding/whoami');
        return { ok: true, json: async () => ({ success: true, userId: 'current-member', name: '当前登录人' }) };
      },
    };
    vm.runInNewContext(script, context);
    const user = await window.MKT_AUTH_PROMISE;
    assert.equal(user.userId, 'current-member', '页面身份必须来自本次钉钉核验');
    assert.deepEqual(calls, [['requestAuthCode', 'dingtestcorp'], ['/api/ding/whoami', 'fresh-code']]);

    const handoffSession = encodeDingSession({ userId: 'current-member', name: '当前登录人', source: '钉钉免登' }, { security: { sessionSigningSecret: 'test-bootstrap-signing-secret' } });
    const handoffToken = createDingAuthHandoff(handoffSession, { userId: 'current-member', name: '当前登录人' });
    const handedOff = consumeDingAuthHandoff({ headers: { cookie: `mkt_ding_session=${encodeURIComponent(handoffSession)}` } }, handoffToken);
    assert.equal(handedOff.userId, 'current-member', '仅同一签名会话可领取一次性已核验身份');
    assert.equal(consumeDingAuthHandoff({ headers: { cookie: `mkt_ding_session=${encodeURIComponent(handoffSession)}` } }, handoffToken), null, '一次性衔接令牌不得重复使用');

    const handoffCalls = [];
    const handoffWindow = {};
    const browserHandoffToken = createDingAuthHandoff(handoffSession, { userId: 'current-member', name: '当前登录人' });
    vm.runInNewContext(script, {
      window: handoffWindow, location: { search: `?handoff=${browserHandoffToken}`, pathname: '/' }, URLSearchParams,
      history: { replaceState: () => handoffCalls.push(['replaceState']) }, document: {}, Promise, setTimeout, clearTimeout,
      fetch: async (url) => {
        handoffCalls.push([url]);
        return { ok: true, json: async () => ({ success: true, user: { userId: 'current-member', name: '当前登录人', source: '钉钉免登' } }) };
      },
    });
    assert.equal((await handoffWindow.MKT_AUTH_PROMISE).userId, 'current-member', '刚完成登录的主页必须直接使用一次性衔接身份');
    assert.equal(handoffCalls.filter(([entry]) => String(entry).startsWith('/api/ding/handoff?token=')).length, 1, '主页必须只领取一次性衔接身份');
    assert.equal(handoffCalls.some(([entry]) => String(entry).includes('requestAuthCode')), false, '衔接成功时不得再次请求钉钉免登码');

    const failedWindow = { dd: { ready: (fn) => fn(), runtime: { permission: {
      requestAuthCode: ({ onFail }) => onFail(new Error('auth failed')),
    } } } };
    vm.runInNewContext(script, { ...context, window: failedWindow, fetch: () => { throw new Error('失败时不得读取业务数据'); } });
    assert.equal(await failedWindow.MKT_AUTH_PROMISE, null, '钉钉核验失败时不得沿用上次身份');
    assert(failedWindow.MKT_AUTH_ERROR, '失败时必须保留可展示的错误原因');
    console.log('ding current-user bootstrap checks passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require('assert');
const fs = require('fs');

const login = fs.readFileSync(require.resolve('../login.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');

assert.match(login, /async function resolveDingTalkCorpId\(\)[\s\S]*?fetch\('\/api\/ding\/login-context'/, '登录页缺少 URL corpId 时必须读取无敏感信息的登录上下文');
assert.match(login, /async function waitForDingTalkAuthCode\(sdkReady\)/, '登录页必须等待钉钉 JS 桥接就绪，避免首次打开过早判定失败');
assert.match(login, /if \(!corpId\) \{[\s\S]*?企业识别配置缺失/, '登录页仅在 URL 和服务端都无法提供企业标识时才显示配置错误');
assert.doesNotMatch(login, /isDingTalkClient/, '登录页不得用 User-Agent 判断钉钉桌面端，以免误拦截免登');
assert.match(
  app,
  /function getDingTalkCorpId\(\)[\s\S]*?location\.search/,
  '钉钉应用首页必须优先读取地址中的 corpId，避免为免登额外请求一次配置接口',
);
assert.match(app, /async function ddWhoami\(\) \{\s*const corpId = getDingTalkCorpId\(\);\s*if \(!corpId\) return null;[\s\S]*?const cfg = \{ corpId \};/, '钉钉应用必须使用地址中的 corpId，不能退回匿名配置接口');
assert.doesNotMatch(app, /async function loadOaCfg/, '应用首页不得保留匿名配置读取回退');
assert.match(
  login,
  /loginButton\.addEventListener\('click', async \(\) => \{[\s\S]*?const corpId = await resolveDingTalkCorpId\(\);[\s\S]*?loginFromDingTalk\(loadDingTalkSdk\(\), corpId\)/,
  '钉钉客户端手动重试必须继续使用免登',
);
const loginStart = (login.match(/async function start\(\)[\s\S]*?(?=\n    start\(\);)/) || [])[0] || '';
assert.match(loginStart, /const existing = await fetch\('\/api\/ding\/me', \{ cache: 'no-store' \}\)/, '有效的服务端会话必须在加载钉钉 SDK 前被快速复用');
const existingSessionAt = loginStart.indexOf("fetch('/api/ding/me'");
assert.ok(
  existingSessionAt >= 0 && existingSessionAt < loginStart.indexOf('resolveDingTalkCorpId()', existingSessionAt),
  '有效会话必须在读取 corpId 前优先复用，避免钉钉偶发参数注入失败阻塞已登录成员',
);
assert.match(loginStart, /if \(existing\.ok && existingBody\.success && existingBody\.user && existingBody\.user\.userId\) \{\s*location\.replace\('\/'\);\s*return;/, '存在独立有效会话时必须直接进入应用，不重复免登');
assert.match(loginStart, /await loginFromDingTalk\(loadDingTalkSdk\(\), corpId\);/, '无会话时仍必须执行钉钉免登，不能用本地身份替代');
assert.match(server, /const DING_LOGIN_TTL = 7 \* 24 \* 60 \* 60 \* 1000;/, '钉钉登录会话应保持七天，避免成员每天重复免登');
assert.match(
  app,
  /if \(!force && window\.MKT_WHOAMI && window\.MKT_WHOAMI\.userId\) return window\.MKT_WHOAMI;/,
  '同一页面已完成身份校验后必须复用内存身份，避免每个操作重复免登',
);
assert.match(
  app,
  /let u = !force \? await serverWhoami\(\) : null;\s*if \(!u && getDingTalkCorpId\(\)\) u = await ddWhoami\(\);/,
  '页面进入必须优先复用已验证的服务端会话，仅在钉钉应用地址存在企业标识时免登',
);
assert.match(
  server,
  /const staticHeaders = \{ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' \};/,
  '登录页和应用资源必须禁止缓存，避免钉钉内嵌浏览器继续执行旧登录逻辑',
);
const relogin = (app.match(/async function startDingLogin\(\)[\s\S]*?(?=function renderWhoami)/) || [])[0] || '';
assert.match(relogin, /if \(getDingTalkCorpId\(\)\)/, '钉钉应用内必须有独立的重新免登分支');
assert.match(relogin, /const u = await resolveCurrentUser\(true\);\s*if \(u\) \{[\s\S]*?return;\s*\}/, '钉钉应用内的重新登录必须直接重新免登');
assert.doesNotMatch(relogin, /\/api\/ding\/login/, '重新登录不得跳转网页 OAuth');
assert.doesNotMatch(relogin, /location\.assign\('\/login\.html'\)/, '钉钉应用内重新登录不得跳转登录页');
assert.doesNotMatch(login, /location\.assign\('\/api\/ding\/login'\)/, '登录页不得跳转网页 OAuth');
assert.match(server, /网页登录已关闭，请从钉钉应用打开/, '旧网页 OAuth 入口必须关闭并提示钉钉应用打开');
console.log('ding login cold-start performance checks passed');

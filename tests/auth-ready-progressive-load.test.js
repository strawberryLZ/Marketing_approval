const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = source.indexOf('async function resolveCurrentUser(force)');
const end = source.indexOf('\nasync function startDingLogin()', start);
assert.ok(start >= 0 && end > start, '未找到首页身份和数据加载流程');

const never = new Promise(() => {});
const classOps = [];
const context = {
  Promise, console,
  window: {
    MKT_AUTH_PROMISE: Promise.resolve({ userId: 'u-1', name: '测试成员' }),
    MKT_DS: { loadEnterpriseSnapshot: () => never, refreshAccess: () => never },
  },
  document: { body: { classList: { add: (name) => classOps.push(`add:${name}`), remove: (name) => classOps.push(`remove:${name}`) } } },
  saveWhoami: () => {}, renderWhoami: () => {},
  setTabDataStatus: () => {},
  ensureAuditTab: () => never, loadEnterpriseApplications: () => never,
  toast: () => {}, isOfficialDataReady: () => false,
  $: () => ({ style: {}, textContent: '', }),
};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.resolveCurrentUser = resolveCurrentUser;`, context);

/* 身份已确认时，即使非关键后台数据仍慢，用户也应先看到可用页面骨架。 */
context.resolveCurrentUser();
setImmediate(() => {
  assert.ok(classOps.includes('add:auth-ready'), '数据加载未完成时不应继续遮住整个页面');
  console.log('auth-ready progressive-load checks passed');
});

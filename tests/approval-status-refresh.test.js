const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');
const store = fs.readFileSync(require.resolve('../approval-sync.js'), 'utf8');

assert.doesNotMatch(app, /APPROVAL_STATUS_REFRESH_MS|setInterval\(/, '审批状态页面不得持续轮询接口');
assert.match(app, /api\/ding\/approval-refresh/, '审批页面必须提供成员主动刷新入口');
assert.match(app, /manualApprovalRefreshing/, '主动刷新必须防止浏览器重复提交');
assert.match(server, /u === '\/api\/ding\/approval-refresh' && req\.method === 'POST'/, '服务端必须提供受保护的主动刷新接口');
assert.match(server, /MANUAL_APPROVAL_REFRESH_COOLDOWN_MS = 30 \* 1000/, '主动刷新必须有每位成员的短暂冷却');
assert.match(server, /pendingForViewer\(viewer\.userId, !!viewer\.canViewAll, 100\)/, '主动刷新只能查询当前成员权限范围内的待审批实例');
assert.match(store, /async pendingForViewer\(userId, canViewAll, limit\)/, '审批存储必须按查看范围筛选待审批实例');
assert.match(app, /if \(historyRefreshPending\) \{\s*try \{\s*await loadEnterpriseApplications\(\);\s*historyRefreshPending = false;/, '审批转为已通过后必须重新读取服务端审批快照，刷新价格历史');
const applicationDetail = app.slice(app.indexOf('window.openDetail = function'), app.indexOf('window.reopen = function'));
assert(applicationDetail.indexOf('class="oa-box reject-action"') < applicationDetail.indexOf('<div class="kv">'), '驳回后的重新提交入口必须位于详情信息和长明细表之前');
assert.doesNotMatch(app, /api\.dingtalk\.com/, '前端状态刷新不得直接调用钉钉接口');
assert.match(index, /id="ap-refresh"/, '审批跟踪页必须展示主动刷新按钮');
assert.match(index, /<script defer src="app\.js\?v=31"><\/script>/, '状态刷新发布时必须更新 app.js 缓存版本');

console.log('approval status display refresh checks passed');

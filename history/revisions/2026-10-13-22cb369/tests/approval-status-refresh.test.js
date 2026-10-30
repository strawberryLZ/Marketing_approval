const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');

assert.match(app, /const APPROVAL_STATUS_REFRESH_MS = 20 \* 1000;/, '审批状态页面必须以 20 秒为周期刷新服务端回填结果');
assert.match(app, /if \(historyRefreshPending\) \{\s*try \{\s*await loadEnterpriseApplications\(\);\s*historyRefreshPending = false;/, '审批转为已通过后必须重新读取服务端审批快照，刷新价格历史');
assert.match(app, /if \(apps\.some\(\(app\) => app\.status === '审批中'\) \|\| historyRefreshPending\) void syncApprovalStatuses\(\);/, '历史快照读取暂时失败时必须仅重试读取，不重复写入申请');
const applicationDetail = app.slice(app.indexOf('window.openDetail = function'), app.indexOf('window.reopen = function'));
assert(applicationDetail.indexOf('class="oa-box reject-action"') < applicationDetail.indexOf('<div class="kv">'), '驳回后的重新提交入口必须位于详情信息和长明细表之前');
assert.doesNotMatch(app, /api\.dingtalk\.com/, '前端状态刷新不得直接调用钉钉接口');
assert.match(index, /<script src="app\.js\?v=28"><\/script>/, '状态刷新发布时必须更新 app.js 缓存版本');

console.log('approval status display refresh checks passed');

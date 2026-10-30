const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = fs.readFileSync(require.resolve('../datasource.js'), 'utf8');

assert.match(index, /data-tab-status="source"/, '活动申请和价格查询必须展示正式数据加载状态');
assert.match(index, /data-tab-status="applications"/, '审批跟踪必须展示申请记录加载状态');
assert.match(app, /function setTabDataStatus\(/, '页面必须能统一更新 Tab 的数据加载状态');
assert.match(app, /setTabDataStatus\('source', loaded \? 'ready' : 'failed'\)/, '正式快照完成后必须明确标记成功或未就绪');
assert.match(app, /setTabDataStatus\('applications', loaded \? 'ready' : 'failed'\)/, '申请记录完成后必须明确标记成功或未就绪');
assert.match(source, /data-tab-status="source"/, '动态插入的数据源 Tab 也必须展示加载状态');
assert.match(source, /!j\.snapshot\.products\.length/, '空商品快照不得被标记为数据已就绪');

console.log('tab data load status tests passed');

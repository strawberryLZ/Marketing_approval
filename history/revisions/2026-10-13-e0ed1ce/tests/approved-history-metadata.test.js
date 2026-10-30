const assert = require('assert');
const fs = require('fs');

const store = fs.readFileSync(require.resolve('../business-store.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

assert.match(store, /price: entry\.prices\.length \? Math\.min\(\.\.\.entry\.prices\) : null/, '同一 SPU 的历史价必须取真实 SKU 活动价最低值');
assert.match(store, /platform: app\.platform.*store: app\.store/s, '审批归档历史必须携带平台和店铺');
assert.match(store, /activityType: app\.activityType.*activityName: app\.activityName/s, '审批归档历史必须携带活动信息');
assert.match(store, /applicant: row\.originator_name.*sourceLabel: '审批归档（真实）'/s, '审批归档历史必须携带提交人和明确来源');
assert.match(app, /<th>提交人<\/th><th>来源<\/th>/, '价格查询必须展示提交人与来源');
assert.match(app, /审批归档（真实）/, '真实审批快照不得显示为演示数据');

console.log('approved history metadata checks passed');

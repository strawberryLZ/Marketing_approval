const assert = require('assert');
const fs = require('fs');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');
const store = fs.readFileSync(require.resolve('../business-store.js'), 'utf8');

assert.doesNotMatch(app, /localStorage/, '业务申请页面不得将申请、历史价、费用或玩法写入浏览器持久化存储');
assert.match(app, /const needOA = true;/, '所有营销活动必须进入真实审批路径');
assert.match(app, /await persistApplication\(app\)/, '真实审批实例必须登记到企业数据库');
assert.match(store, /originator_user_id = \$2/, '审批状态查询必须按当前申请人过滤');
assert.match(server, /当前账号没有成员诊断权限/, '成员查询接口必须限制管理员');
assert.match(store, /parent_application_id/, '驳回重提必须保留原申请关联字段');
console.log('enterprise application persistence tests passed');

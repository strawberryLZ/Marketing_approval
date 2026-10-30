const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');
const store = fs.readFileSync(require.resolve('../business-store.js'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');

assert.match(server, /u === '\/api\/application-audit' && req\.method === 'GET'/, '必须提供固定的只读核对接口');
assert.match(server, /u === '\/api\/application-audit\/detail' && req\.method === 'GET'/, '必须提供固定的只读明细接口');
assert.match(server, /requireDataSourceAccess\(req, res, cfg\)/, '核对接口必须复用信息部门白名单校验');
assert.match(store, /async auditRows\(limit\)/, '核对查询必须封装在企业申请存储层');
assert.match(store, /async auditDetail\(applicationId\)/, '明细查询必须封装在企业申请存储层');
assert.match(store, /LIMIT \$1/, '核对记录必须有服务端上限');
assert.doesNotMatch(store, /auditRows[\s\S]*?(?:INSERT|UPDATE|DELETE)/, '核对查询不得写入业务数据');
assert.doesNotMatch(store, /auditDetail[\s\S]*?(?:INSERT|UPDATE|DELETE)/, '明细查询不得写入业务数据');
assert.match(app, /dataset\.view = 'audit'/, '白名单成员必须有数据核对入口');
assert.match(app, /\/api\/application-audit/, '页面必须只调用固定核对接口');
assert.match(app, /openAuditDetail/, '核对页面必须提供明细查看入口');
assert.match(index, /app\.js\?v=31/, '核对页面发布时必须更新 app.js 缓存版本');

console.log('application audit checks passed');

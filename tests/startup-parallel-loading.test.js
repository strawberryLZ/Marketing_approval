const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const resolve = (app.match(/async function resolveCurrentUser\(force\)[\s\S]*?(?=\nasync function startDingLogin)/) || [])[0] || '';

assert.ok(
  resolve.indexOf('renderWhoami();') >= 0 && resolve.indexOf('renderWhoami();') < resolve.indexOf('const startupTasks = [];'),
  '本次身份核验成功后，应先渲染当前成员，再启动首页数据加载',
);
assert.match(
  resolve,
  /startupTasks\.push\(window\.MKT_DS\.loadEnterpriseSnapshot\(\)\.catch\(/,
  '企业数据源快照必须加入首页并行加载队列',
);
assert.match(
  resolve,
  /startupTasks\.push\(loadEnterpriseApplications\(\)\.catch\(/,
  '企业申请记录必须与数据源快照同时开始读取',
);
assert.match(
  resolve,
  /await Promise\.all\(startupTasks\);/,
  '首页启动必须等待同一批并行任务完成，不能将数据读取串行化',
);
assert.doesNotMatch(
  resolve,
  /await window\.MKT_DS\.loadEnterpriseSnapshot\(\);\s*await window\.MKT_DS\.refreshAccess\(\);/,
  '数据源快照与页签权限不得串行等待',
);

console.log('startup parallel loading checks passed');

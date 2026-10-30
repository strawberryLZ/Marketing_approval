const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const upload = fs.readFileSync(path.join(root, 'upload.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

for (const id of ['q-season', 'q-pos', 'q-grade', 'q-gender']) {
  assert(page.includes(`id="${id}"`), `价格查询缺少 ${id} 筛选控件`);
}
assert.match(app, /function renderQueryFilters\(\)/, '价格查询必须初始化统一筛选条件');
assert.match(app, /function queryFilteredProducts\(\)/, '价格查询必须按筛选条件取候选商品');
assert.match(app, /renderQueryCandidates/, '价格查询必须支持点选候选商品');

for (const prefix of ['up-pk', 'up-mp', 'up-gift', 'up-ga']) {
  assert(upload.includes(`pickerFiltersHtml('${prefix}')`), `${prefix} 缺少统一商品筛选控件`);
}
assert.match(upload, /function pickerMatches\(spu, filter\)/, '上传流程必须使用统一筛选匹配函数');

console.log('product picker filter consistency tests passed');

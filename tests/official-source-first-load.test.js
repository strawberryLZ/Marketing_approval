const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = fs.readFileSync(require.resolve('../datasource.js'), 'utf8');
const upload = fs.readFileSync(require.resolve('../upload.js'), 'utf8');

assert.doesNotMatch(index, /<script defer src="products_seed\.js/, '首屏不得加载历史商品种子表');
assert.doesNotMatch(index, /<script defer src="xlsx\.full\.min\.js/, '首屏不得加载仅供 Excel 操作使用的库');
assert.match(index, /window\.MKT_LOAD_XLSX/, 'Excel 库必须提供按需加载器');
assert.doesNotMatch(source, /const seed = seedProducts\(\);[\s\S]*?D\.dataSourceKind = 'seed';/, '正式快照不可用时不得回退到旧商品种子表');
assert.match(source, /D\.dataSourceKind = 'unavailable';/, '正式快照不可用时必须显式标记为不可用');
assert.match(app, /function isOfficialDataReady\(\)/, '手工申请必须判断正式数据源是否已就绪');
assert.match(app, /if \(!isOfficialDataReady\(\)\) return toast\('正式数据源未就绪，暂不能提交审批'\);/, '手工申请必须在正式数据源未就绪时阻止提交');
assert.match(app, /if \(!isOfficialDataReady\(\)\) throw new Error\('正式数据源未就绪，暂不能提交审批'\);/, 'Excel 导入必须在正式数据源未就绪时阻止提交');
assert.match(upload, /await ensureXlsx\(\);/, 'Excel 导入和导出操作前必须按需加载 Excel 库');

console.log('official source first-load checks passed');

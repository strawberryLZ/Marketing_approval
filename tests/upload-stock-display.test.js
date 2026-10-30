const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../upload.js'), 'utf8');
const start = source.indexOf('const stockNumber =');
const end = source.indexOf('/* =========================================================\n   * UI 注入', start);
assert.ok(start >= 0 && end > start, '未找到上传库存数值解析逻辑');

const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.stockNumber = stockNumber;`, context);

assert.strictEqual(context.stockNumber(null), null, '缺失库存不能显示为 0');
assert.strictEqual(context.stockNumber(undefined), null, '未返回库存不能显示为 0');
assert.strictEqual(context.stockNumber(''), null, '空库存不能显示为 0');
assert.strictEqual(context.stockNumber(0), 0, '明确的零库存必须保留为 0');
assert.strictEqual(context.stockNumber('12'), 12, '有效库存必须保持原数值');

console.log('upload stock display checks passed');

const assert = require('assert');
const { stableRowsHash, validateSnapshot, scheduledChinaSlot, retryDelays } = require('../data-source-sync');

const left = [{ sku: ' A ', price: 10, attrs: { color: '蓝', size: 'M' } }, { sku: 'B', price: 20 }];
const right = [{ price: 20, sku: 'B' }, { attrs: { size: 'M', color: '蓝' }, price: 10, sku: 'A' }];
assert.strictEqual(stableRowsHash(left), stableRowsHash(right), '同一业务内容的行顺序、对象键顺序和首尾空格不应产生新版本');

assert.throws(() => validateSnapshot({ products: [], stock: null, stockEnabled: false }, null), /0 行/);
assert.throws(() => validateSnapshot({ products: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], stock: null, stockEnabled: false }, { products_count: 10 }), /异常下降/);
assert.doesNotThrow(() => validateSnapshot({ products: Array.from({ length: 5 }, (_, id) => ({ id })), stock: [{ id: 1 }], stockEnabled: true }, { products_count: 10, stock_count: 1 }));

assert.match(scheduledChinaSlot(new Date('2026-09-30T23:00:00.000Z')), /T07:00\+08:00$/, '北京时间 07:00 应触发计划任务');
assert.strictEqual(scheduledChinaSlot(new Date('2026-10-01T00:00:00.000Z')), '', '北京时间 08:00 不应触发计划任务');
assert.deepStrictEqual(retryDelays, [0, 3 * 60 * 1000, 7 * 60 * 1000, 20 * 60 * 1000], '重试必须发生在首次失败后的第 3、10、30 分钟');
console.log('data-source-sync tests passed');

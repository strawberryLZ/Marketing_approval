const assert = require('assert');
const { normalizeMidTableOverrides } = require('../serve');

const normalized = normalizeMidTableOverrides([
  { mode: 'update', spuCode: 'FBWFS1', values: { name: '女式秋冬长袖', retailPrice: '258', ignored: 'x' } },
  { mode: 'add', spuCode: 'FBNEW1', skuCode: 'FBNEW1-BLK-M', values: { name: '新增商品', color: '黑色', stock: '12' } },
]);

assert.deepEqual(normalized[0], { mode: 'update', spuCode: 'FBWFS1', values: { name: '女式秋冬长袖', retailPrice: 258 } });
assert.deepEqual(normalized[1], { mode: 'add', spuCode: 'FBNEW1', skuCode: 'FBNEW1-BLK-M', values: { name: '新增商品', color: '黑色', stock: 12 } });
assert.throws(() => normalizeMidTableOverrides([{ mode: 'add', spuCode: 'FBNEW2', skuCode: 'FBNEW2-01', values: {} }]), /品名/);
assert.throws(() => normalizeMidTableOverrides([{ mode: 'update', spuCode: '错误 空格', values: { name: 'x' } }]), /货号/);
assert.throws(() => normalizeMidTableOverrides([
  { mode: 'update', spuCode: 'FBONE', values: { name: 'x' } },
  { mode: 'add', spuCode: 'FBONE', skuCode: 'FBONE-01', values: { name: 'y' } },
]), /同一货号/);

console.log('mid-table override validation tests passed');

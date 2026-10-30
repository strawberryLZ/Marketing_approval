const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

let source = fs.readFileSync(require.resolve('../datasource.js'), 'utf8');
source = source.replace('window.MKT_DS = { applyToApp,', 'window.MKT_DS = { __aggregateSkuRows: aggregateSkuRows, applyToApp,');

const window = { APP_DATA: {} };
const document = { querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {} };
vm.runInNewContext(source, {
  window, document, Promise, Date, Map, Set, String, Number, Array, Object, JSON, RegExp,
  fetch: () => Promise.reject(new Error('unexpected fetch')),
});

const [product] = window.MKT_DS.__aggregateSkuRows([
  { spuCode: 'SPU-1', skuCode: 'SKU-1', color: '黑', size: 'M', listPrice: 199, retailPrice: 100 },
  { spuCode: 'SPU-1', skuCode: 'SKU-2', color: '黑', size: 'L', listPrice: 219, retailPrice: 120 },
]);
const skus = product.variants.flatMap((variant) => variant.colors).flatMap((color) => color.sizes);

assert.deepStrictEqual(
  JSON.parse(JSON.stringify(skus.map((sku) => ({ code: sku.code, listPrice: sku.listPrice, retailPrice: sku.retailPrice })))),
  [
    { code: 'SKU-1', listPrice: 199, retailPrice: 100 },
    { code: 'SKU-2', listPrice: 219, retailPrice: 120 },
  ],
  '中间表必须保留每个 SKU 的吊牌价和零售价，不能仅保留 SPU 价格',
);

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const upload = fs.readFileSync(require.resolve('../upload.js'), 'utf8');
assert.match(app, /listPrice: s\.listPrice, retailPrice: s\.retailPrice/, 'SKU 展开必须携带 SKU 基础价格');
assert.match(upload, /const currentBase = standardBasePrices\(sku\);/, '上传活动明细必须按 SKU 读取基础价格');

console.log('sku retail preservation tests passed');

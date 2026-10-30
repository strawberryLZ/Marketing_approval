const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../datasource.js'), 'utf8');
const demoProduct = { id: 'P001', spuCode: 'P001', name: '演示商品' };
const context = {
  Promise,
  fetch: async () => ({ headers: { get: () => 'application/json' }, json: async () => ({ success: true, snapshot: null }) }),
  setTimeout,
  clearTimeout,
  console,
  window: { APP_DATA: { products: [demoProduct], dataSourceKind: 'demo' }, MKT_AUTH_PROMISE: Promise.resolve(null) },
  document: { querySelector: () => null, addEventListener: () => {} },
};
context.window.window = context.window;
vm.createContext(context);
vm.runInContext(source, context);

assert.ok(Array.isArray(context.window.APP_DATA.products) && context.window.APP_DATA.products.length === 0, '正式快照未就绪时不得展示演示商品或伪造货号');
assert.strictEqual(context.window.APP_DATA.dataSourceKind, 'unavailable', '正式快照未就绪必须显式标记为不可用');

console.log('official source no demo fallback tests passed');

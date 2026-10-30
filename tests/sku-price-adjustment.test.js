const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');

assert.match(app, /function priceAdjustSkuLines\(product, previous\)/, '统一调价必须由 SKU 行建立明细');
assert.match(app, /originalRetail: hasSkuRetail \? skuRetail : hasSpuRetail \? spuRetail : null/, '统一调价必须优先取 SKU 价，仅缺失时回退 SPU 价');
assert.match(app, /originalRetailSource: hasSkuRetail \? 'SKU' : hasSpuRetail \? 'SPU' : 'missing'/, '每条 SKU 必须保留原价来源或缺失状态');
assert.match(app, /SPU 兜底.*SKU 价/, 'SKU 明细必须标注自身价格、SPU 兜底或缺失');
assert.match(app, /存在原零售价缺失的 SKU，无法提交调价审批/, '原价缺失的 SKU 不得提交调价审批');
assert.match(app, /if \(item\.pricingMode === 'spu-uniform'\) return item\.skus\.map/, 'SPU 同价必须明确展开为每个 SKU 的目标价');
assert.match(app, /function priceAdjustEffective\(item, sku\)/, 'SKU 分别调价必须支持颜色统一价与 SKU 覆盖价的层级计算');
assert.match(app, /data-pa-color-target/, 'SKU 分别调价必须支持颜色统一价');
assert.match(app, /data-pa-expand-spu/, '调价明细必须按手工活动方式支持 SPU 展开');
assert.match(app, /data-pa-expand-color/, '调价明细必须按手工活动方式支持颜色展开');
assert.match(app, /APPLY_COLS\.map/, '调价明细必须复用手工活动的价格列结构');
assert.match(app, /filter\(\(sku\) => sku\.targetRetail != null && Number\(sku\.targetRetail\) !== Number\(sku\.originalRetail\)\)/, 'SKU 分别调价必须只提交实际发生变化的 SKU');
assert.match(app, /const head = \['调价方式', '货号（SPU）', 'SKU编码'/, '审批附件必须按 SKU 展示调价方式和编码');
assert.match(server, /const key = `\$\{spu\}::\$\{sku\}`/, '服务端必须以 SPU 和 SKU 共同识别一条调价记录');
assert.match(server, /const matching = skuCode \? snapshot\.products\.find/, '服务端必须以 SPU 和 SKU 定位源表行');
assert.match(server, /const fallbackRetail = snapshot\.products/, '服务端原价校验必须与 SPU 兜底规则一致');

console.log('sku price adjustment checks passed');

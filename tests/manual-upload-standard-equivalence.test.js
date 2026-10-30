const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = source.indexOf('const STANDARD_ACTIVITY_COLUMNS =');
const end = source.indexOf('function oaGenXlsx(app)');
assert.ok(start >= 0 && end > start, '未找到标准活动明细生成器');

const context = {};
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}\nglobalThis.standard = { STANDARD_ACTIVITY_COLUMNS, standardActivityId, standardizeRow, buildStandardRowsForApp, oaItemsAoa, oaSpuSummaryAoa };`, context);
const standard = context.standard;
const columns = Array.from(standard.STANDARD_ACTIVITY_COLUMNS);

const manualApp = {
  id: 'REQ-test', platform: '京东', store: '京东-Flipbelt运动旗舰店',
  activityName: '平台大促·官方立减', activityCat: '平台大促·官方立减',
  start: '2026-04-10', end: '2026-04-14',
  activities: [{ cat2: '官方立减', cost: '品牌承担' }],
  standardMeta: { manzeng: '满199送洗衣袋', remark: '早鸟价' },
  items: [{ name: '秋冬跑步薄绒导汗手套3.0', season: '25FW', spuCode: 'FBRG03', color: '经典黑', size: 'M', skuCode: 'FBRG03-BLK-M', stock: 63, retailPrice: 128, listPrice: 128, suggestMin: 88, histLow: 85, price: 98 }],
};
const manualRows = standard.buildStandardRowsForApp(manualApp);
const manualDetailSheet = standard.oaItemsAoa(manualApp);

assert.strictEqual(JSON.stringify(Array.from(manualDetailSheet[0])), JSON.stringify(columns), '手工 SKU 明细表头必须是统一标准字段');
assert.strictEqual(JSON.stringify(manualRows[0]), JSON.stringify({
  活动ID: 'ACT20260410-TEST', 活动名称: '平台大促·官方立减', 平台: '京东', 店铺: '京东-Flipbelt运动旗舰店',
  开始: '2026-04-10', 结束: '2026-04-14', 活动类型: '平台大促·官方立减',
  产品名称: '秋冬跑步薄绒导汗手套3.0', 商品时期: '25FW', 货号: 'FBRG03', 颜色: '经典黑', 尺码: 'M', SKU编码: 'FBRG03-BLK-M', '库存(SKU)': 63,
  原价: 128, 日常价: 128, 建议最低价: 88, 历史最低价: 85, 活动价: 98, 折扣率: 0.77, 到手价: 98, 优惠金额: 30, 日常价差额: 30,
  赠品标记: '否', 满赠规则: '满199送洗衣袋', 购物金规则: '官方立减：品牌承担', 备注: '早鸟价', 数据来源: '手工填报',
}), '手工填价的标准字段或价格计算不符合映射');

const uploadRow = standard.standardizeRow({ ...manualRows[0], 数据来源: '京东活动原表.xlsx' });
const uploadDetailSheet = standard.oaItemsAoa({ standardRows: [uploadRow] });
assert.strictEqual(JSON.stringify(Array.from(uploadDetailSheet[0])), JSON.stringify(columns), '上传 SKU 明细表头必须是同一份标准字段');
assert.strictEqual(JSON.stringify(Array.from(uploadDetailSheet[1]).slice(0, -1)), JSON.stringify(Array.from(manualDetailSheet[1]).slice(0, -1)), '除数据来源外，手工与上传的标准 SKU 行必须一致');
assert.strictEqual(uploadDetailSheet[1][columns.indexOf('数据来源')], '京东活动原表.xlsx', '上传明细必须保留原始上传文件名');

assert.notStrictEqual(
  standard.standardActivityId({ id: 'REQ20260410-first', start: '2026-04-10' }),
  standard.standardActivityId({ id: 'REQ20260410-second', start: '2026-04-10' }),
  '同日不同申请必须生成不同的活动 ID',
);
const summary = standard.oaSpuSummaryAoa({
  store: '默认店铺',
  items: [
    { store: '店铺A', spuCode: 'FBRG03', name: '跑步手套', listPrice: 128, retailPrice: 128, price: 98, compliance: '符合控价' },
    { store: '店铺A', spuCode: 'FBRG03', name: '跑步手套', listPrice: 128, retailPrice: 128, price: 98, compliance: '符合控价' },
    { store: '店铺B', spuCode: 'FBRG03', name: '跑步手套', listPrice: 128, retailPrice: 128, price: 95, compliance: '不符合控价' },
  ],
});
assert.deepStrictEqual(Array.from(summary[0]).slice(0, 4), ['店铺', '款号', '品名', 'SKU数'], 'SPU 汇总必须含店铺并按款号统计');
assert.strictEqual(summary.length, 3, '同一款号在不同店铺必须分别汇总');
assert.deepStrictEqual(Array.from(summary[1]).slice(0, 4), ['店铺A', 'FBRG03', '跑步手套', 2]);
assert.deepStrictEqual(Array.from(summary[2]).slice(0, 4), ['店铺B', 'FBRG03', '跑步手套', 1]);

console.log('manual/upload standard Excel equivalence checks passed');

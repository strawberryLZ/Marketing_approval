const assert = require('assert');
const { calendarDescFromApplication } = require('../serve');

/* 场景一：标准明细活动（含早鸟价/拼团价/单品买赠/三档满赠），对齐同事历史样板四段式 */
const full = calendarDescFromApplication({
  start: '2026-09-25',
  end: '2026-09-29',
  standardMeta: { manzeng: '满299洗衣袋；满499鞋袋；满699头带' },
  oaTableUrl: 'https://alidocs.dingtalk.com/i/nodes/XXX',
  standardRows: [
    { 产品名称: '连帽长袖面罩款', 备注: '早鸟价 60', 赠品标记: '否', 满赠规则: '' },
    { 产品名称: '暖壳长裤', 备注: '早鸟价 60', 赠品标记: '否', 满赠规则: '' },
    { 产品名称: '袋鼠裤3.0', 备注: '拼团价 199', 赠品标记: '否', 满赠规则: '' },
    { 产品名称: '袋鼠公仔', 备注: '', 赠品标记: '是', 满赠规则: '' },
    { 产品名称: '袋鼠公仔', 备注: '', 赠品标记: '是', 满赠规则: '' },
  ],
});
assert.deepStrictEqual(full.split('\n'), [
  '一、活动时间',
  '9.25-9.29',
  '二、价格策略',
  '1.早鸟价：连帽长袖面罩款、暖壳长裤日常价-60',
  '2.拼团价：袋鼠裤3.0 199',
  '3.其他请看价格表',
  '三、赠品策略',
  '1.单品买赠：袋鼠公仔',
  '2.三档满赠：满299洗衣袋；满499鞋袋；满699头带，全店商品参与',
  '3.单品买赠和三档满赠不叠加',
  '四、活动文档',
  'https://alidocs.dingtalk.com/i/nodes/XXX',
]);

/* 场景二：无 standardMeta 时，满赠规则回退取标准明细行的「满赠规则」列 */
const fallbackManzeng = calendarDescFromApplication({
  start: '2026-10-01',
  end: '2026-10-01',
  standardRows: [{ 产品名称: 'A', 满赠规则: '满199送毛巾', 赠品标记: '否' }],
});
assert.ok(fallbackManzeng.includes('1.三档满赠：满199送毛巾，全店商品参与'), '应回退读取行内满赠规则');
assert.ok(fallbackManzeng.includes('一、活动时间\n10.1-10.1'), '同日活动的日期格式应为 M.D-M.D');

/* 场景三：无任何可解析内容时，仍保持四段式与兜底文案 */
assert.deepStrictEqual(calendarDescFromApplication({}).split('\n'), [
  '一、活动时间',
  '-',
  '二、价格策略',
  '1.其他请看价格表',
  '三、赠品策略',
  '1.单品买赠和三档满赠不叠加',
  '四、活动文档',
  '详见审批单附件',
]);

/* 场景四：手工填报（仅 items，无 standardRows）同样可抽取价格策略 */
const manual = calendarDescFromApplication({
  start: '2026-11-01',
  end: '2026-11-03',
  items: [{ name: '商品甲', remark: '早鸟价 30' }, { name: '商品乙', remark: '拼团价 88' }],
});
assert.ok(manual.includes('1.早鸟价：商品甲日常价-30'), '手工 items 应能抽取早鸟价');
assert.ok(manual.includes('2.拼团价：商品乙 88'), '手工 items 应能抽取拼团价');

console.log('calendar description checks passed');
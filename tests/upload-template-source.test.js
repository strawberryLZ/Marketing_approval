const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync(require.resolve('../upload.js'), 'utf8');

const headerStart = source.indexOf('const COLMAP =');
const headerEnd = source.indexOf('function parseRows()', headerStart);
assert.ok(headerStart >= 0 && headerEnd > headerStart, '未找到 Excel 表头映射逻辑');
const headerContext = {};
vm.createContext(headerContext);
vm.runInContext(`${source.slice(headerStart, headerEnd)}; globalThis.mapHeader = mapHeader;`, headerContext);
const headers = headerContext.mapHeader(['产品名称(标准简称)', '商品时期', '货号', '吊牌价', '零售价', '申请价(填写)', '折扣(填写)']);
assert.strictEqual(headers.spuCode, 2, '标准模板必须按货号精确匹配');
assert.strictEqual(headers.orig, 3, '标准模板的吊牌价必须被识别');
assert.strictEqual(headers.daily, 4, '标准模板的零售价必须被识别');
assert.strictEqual(headers.act, 5, '申请价必须作为活动价读取');
assert.strictEqual(headers.final, 6, '折扣价必须作为到手价读取');

const customHeader = headerContext.mapHeader(['商品名称', '货号', '活动价']);
assert.strictEqual(customHeader.name, 0, '自有表的商品名称列必须被识别');
assert.strictEqual(customHeader.spuCode, 1, '自有表的货号列必须被识别');
assert.strictEqual(customHeader.act, 2, '自有表的活动价列必须被识别');

const parseEnd = source.indexOf('/* ---------- 多值价格解析', headerStart);
assert.ok(parseEnd > headerEnd, '未找到 Excel 商品行解析逻辑');
const parseContext = {
  state: { sheets: { Sheet1: [['商品名称', '活动价'], ['测试商品', 29]] }, rows: [], gifts: [], skippedGifts: [] },
  normSeason: (value) => String(value ?? ''),
};
vm.createContext(parseContext);
vm.runInContext(`${source.slice(headerStart, parseEnd)}; globalThis.parseRows = parseRows;`, parseContext);
parseContext.parseRows();
assert.strictEqual(parseContext.state.rows.length, 1, '自有表的商品名称表头必须解析出商品行');
assert.strictEqual(parseContext.state.rows[0].name, '测试商品', '自有表的商品名称必须保留');

const samplesContext = { window: {} };
vm.createContext(samplesContext);
vm.runInContext(fs.readFileSync(require.resolve('../sample-data.js'), 'utf8'), samplesContext);
for (const [fileName, sheets] of Object.entries(samplesContext.window.UPLOAD_SAMPLES)) {
  parseContext.state.sheets = sheets;
  parseContext.parseRows();
  assert.ok(parseContext.state.rows.length > 0, `${fileName} 必须能解析出商品行`);
}
parseContext.state.sheets = samplesContext.window.UPLOAD_SAMPLES['示例活动.xlsx'];
parseContext.parseRows();
assert.ok(parseContext.state.rows.some((row) => row.name === '示例商品B'), '同一 Sheet 的第二段商品表必须被解析');
assert.ok(parseContext.state.rows.every((row) => row.name !== '夏季款'), '商品分组标题不得被当成商品行');

const matchStart = source.indexOf('function matchSpu(');
const matchEnd = source.indexOf('/* =========================================================\n   * 二、申请信息表单', matchStart);
assert.ok(matchStart >= 0 && matchEnd > matchStart, '未找到商品匹配逻辑');
const expectedSpu = { spuCode: 'FB0116', name: '2.0款水壶壶嘴绿盖', season: '', skus: [] };
const matchContext = {
  SPU: { FB0116: expectedSpu }, SPU_LIST: [expectedSpu],
  norm: (value) => String(value ?? '').replace(/[\s\u3000\r\n（）()·、，,。.\-_/／]/g, '').toLowerCase(),
  isUnisexPairGroup: () => false,
  nearCands: () => [],
};
vm.createContext(matchContext);
vm.runInContext(`${source.slice(matchStart, matchEnd)}; globalThis.matchSpu = matchSpu;`, matchContext);
const matched = matchContext.matchSpu({ spuCode: 'FB0116', name: '任意旧名称', season: '25FW' });
assert.strictEqual(matched.spu, expectedSpu, '货号命中时不得受 Excel 名称或时期影响');
assert.strictEqual(matched.how, '货号', '货号命中必须标记为货号匹配');
const missingCode = matchContext.matchSpu({ spuCode: 'FB9999', name: '2.0款水壶壶嘴绿盖', season: '' });
assert.ok(missingCode.none && missingCode.codeMiss, '货号未命中时不得退回名称猜测而造成误匹配');
assert.match(source, /if \(m\.codeMiss\) \{ state\.unmatched\.push\(/, '货号未命中必须直接阻断，不得进入人工重新匹配');
assert.match(source, /u\.codeMiss \? '<span class="up-meta">请同步数据源或重新导出模板<\/span>'/, '货号未命中不得展示人工重新匹配按钮');

const giftMatched = matchContext.matchSpu({ name: '2.0款水壶壶嘴绿盖', season: '' });
assert.strictEqual(giftMatched.spu, expectedSpu, '赠品名称应进入与主商品相同的自动匹配逻辑');
assert.match(source, /matchSpu\(\{ name: gname, season: '' \}\)/, '赠品必须以名称对象调用匹配函数');

const priceStart = source.indexOf('function standardBasePrices(');
const priceEnd = source.indexOf('/* ---------- 产品底表索引', priceStart);
assert.ok(priceStart >= 0 && priceEnd > priceStart, '未找到标准明细基础价格逻辑');
const priceContext = { num: (value) => { const n = Number(value); return Number.isFinite(n) ? n : null; } };
vm.createContext(priceContext);
vm.runInContext(`${source.slice(priceStart, priceEnd)}; globalThis.standardBasePrices = standardBasePrices;`, priceContext);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(priceContext.standardBasePrices({ listPrice: 39, retailPrice: 19 }))),
  { original: 39, daily: 19 },
  '标准明细必须优先使用当前数据源的吊牌价和零售价',
);
assert.match(source, /const origSku = currentBase\.original;/, 'Excel 吊牌价不得补写标准明细原价');
assert.match(source, /const daily = currentBase\.daily;/, 'Excel 零售价不得补写标准明细日常价');
assert.match(source, /建议最低价: ref\.suggestMin, 历史最低价: APP\.histLow\(spu\.spuCode\)/, '上传标准明细必须写入建议最低价和公司历史最低价');
assert.match(source, /\^\(购物金\|PLUS\\s\*券\?\)/, '上传解析必须识别购物金和 PLUS 券行');
assert.match(source, /window\.setTimeout\(\(\) => window\.location\.reload\(\), 900\)/, '上传成功后必须自动刷新并清空草稿');

console.log('upload template source-of-truth checks passed');

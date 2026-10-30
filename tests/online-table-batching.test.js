const assert = require('assert');
const { chunkRowsForWrite, DOC_FILL_MAX_ROWS, DOC_FILL_MAX_BYTES } = require('../serve');

const bodyBytes = (values) => Buffer.byteLength(JSON.stringify({ values }), 'utf8');

const rows = [['列A', '列B']];
for (let index = 0; index < 450; index += 1) rows.push([String(index), 'x']);
const batches = chunkRowsForWrite(rows);

assert.equal(batches.length, 3, '450 条数据应按 200 行上限分为 3 批');
assert.deepStrictEqual(batches.map((batch) => batch.length), [200, 200, 51], '首批必须包含表头，后续批次只包含连续数据行');
assert.deepStrictEqual(batches.flat(), rows, '分批前后行顺序和内容必须一致');
for (const batch of batches) {
  assert(batch.length <= DOC_FILL_MAX_ROWS, '每批不得超过行数上限');
  assert(bodyBytes(batch) <= DOC_FILL_MAX_BYTES, '每批必须按实际 UTF-8 JSON 字节限制');
}

const chineseRows = [['列A', '列B']];
for (let index = 0; index < 100; index += 1) chineseRows.push([String(index), '库存明细'.repeat(1000)]);
const chineseBatches = chunkRowsForWrite(chineseRows);
assert(chineseBatches.length > 1, '中文大字段必须按 UTF-8 字节数提前切分');
assert.deepStrictEqual(chineseBatches.flat(), chineseRows, '中文数据分批后不得丢行或变序');
for (const batch of chineseBatches) assert(bodyBytes(batch) <= DOC_FILL_MAX_BYTES, '中文批次不得超过字节上限');

const chineseWide = [['列'], ['中文'.repeat(100000)]];
assert.throws(() => chunkRowsForWrite(chineseWide), /单行超过/, '单行超过上限必须在请求前明确失败');

console.log('online table batching checks passed');

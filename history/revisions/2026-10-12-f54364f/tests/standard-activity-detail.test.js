const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

assert.match(app, /const STANDARD_ACTIVITY_COLUMNS = \['活动ID'.*'数据来源'\]/, '标准活动明细必须包含完整的业务字段');
assert.match(app, /function buildStandardRowsForApp\(app\)/, '手工填价必须生成标准活动明细');
assert.match(app, /商品时期: item\.season/, '手工明细必须写入产品底表的商品时期');
assert.match(app, /原价: original == null \? '' : original, 日常价: original == null \? '' : original/, '手工原价和日常价必须映射到零售价');
assert.match(app, /折扣率: original && finalPrice != null \? Math\.round\(finalPrice \/ original \* 100\) \/ 100 : ''/, '折扣率必须由到手价除以原价计算');
assert.match(app, /standardRows = rows\.map\(\(row\) => standardizeRow\(Object\.assign\(\{\}, row, \{ 活动ID: app\.activityId \}\)\)\)/, '上传路径必须保留标准活动明细，仅补写本申请唯一活动 ID');
assert.match(app, /const x = oaGenXlsx\(app\)/, '审批附件必须从统一标准明细生成');
assert.match(app, /\{ name: 'SKU明细', values: oaItemsAoa\(app\) \}/, '在线表的 SKU 明细必须使用统一标准格式');

console.log('standard activity detail checks passed');

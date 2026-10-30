const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');

assert.match(app, /function oaSpuSummaryAoa\(app\)/, '审批工作簿必须生成按 SPU 汇总的数据');
assert.match(app, /XLSX\.utils\.book_append_sheet\(wb, summaryWs, 'SPU汇总'\)/, '审批 Excel 的第一个工作表必须是 SPU 汇总');
assert.match(app, /XLSX\.utils\.book_append_sheet\(wb, detailWs, 'SKU明细'\)/, '审批 Excel 的第二个工作表必须是 SKU 明细');
assert.match(app, /sheets:\s*\[\s*\{ values: oaSpuSummaryAoa\(app\) \},\s*\{ name: 'SKU明细', values: oaItemsAoa\(app\) \}/, '在线表必须先写 SPU 汇总、再写 SKU 明细');
assert.match(server, /method: 'POST', headers: H, body: JSON\.stringify\(\{ name: entry\.name \|\| \('Sheet' \+ \(index \+ 1\)\) \}\)/, '服务端必须在写入明细前创建第二个工作表');
console.log('approval workbook layout checks passed');

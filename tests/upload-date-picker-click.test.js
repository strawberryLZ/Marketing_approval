const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../upload.js'), 'utf8');

/* 点击日期框的文字区也应主动打开原生日历；不能只依赖右侧图标。 */
assert.match(source, /el\.type === 'date'/, '日期输入框必须有专门的点击处理');
assert.match(source, /el\.addEventListener\('click',[\s\S]{0,260}el\.showPicker\(\)/, '点击日期输入框任意区域必须调用原生日历弹层');

console.log('upload date picker click checks passed');

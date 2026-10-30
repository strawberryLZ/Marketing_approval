const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const css = fs.readFileSync(require.resolve('../styles.css'), 'utf8');

assert.match(app, /application-form-grid store-apply-form-grid/, '全店活动申请信息必须使用专用紧凑布局');
assert.match(app, /application-span-3"><label>活动名称/, '活动名称必须独占整行');
assert.match(app, /application-span-2"><label>费用承担/, '费用承担必须保留较宽输入空间');
assert.match(app, /application-span-3"><label>玩法 \/ 优惠规则/, '玩法规则必须独占整行');
assert.match(css, /\.store-apply-form-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, '宽屏必须使用三列布局');
assert.match(css, /\.store-apply-form-grid textarea \{ min-height: 92px/, '规则文本框必须有可读的高度');

console.log('store activity layout checks passed');

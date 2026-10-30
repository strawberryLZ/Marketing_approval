const assert = require('assert');
const fs = require('fs');

const index = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const firstBusinessScript = index.indexOf('<script defer src="data.js');
const authUiBootstrap = index.indexOf('data-auth-ui-bootstrap');

assert.ok(firstBusinessScript >= 0, '页面必须保留业务脚本入口');
assert.ok(authUiBootstrap >= 0, '身份核验结果必须有首屏 UI 反馈');
assert.ok(authUiBootstrap < firstBusinessScript, '首屏身份反馈必须先于商品与 Excel 大脚本执行');
assert.match(index, /MKT_AUTH_PROMISE\.then\(\(user\) => \{[\s\S]*?已识别当前成员，正在加载页面数据/, '免登成功后必须立即更新首屏状态');
assert.doesNotMatch(app, /https:\/\/g\.alicdn\.com\/dingding\/dingtalk-jsapi/, '重新登录不得额外回退加载第三方钉钉 SDK');

console.log('fast auth UI checks passed');

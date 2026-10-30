const assert = require('assert');
const fs = require('fs');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const source = fs.readFileSync(require.resolve('../datasource.js'), 'utf8');

assert.match(app, /document\.addEventListener\('click', \(event\) => \{\s*const tab = event\.target\.closest/, '页签必须使用事件委托，以支持登录后异步插入的数据源页签');
assert.match(source, /refreshAccess:\s*ensureTab/, '免登完成后必须能够重新检查并插入数据源页签');
assert.doesNotMatch(source, /localStorage|indexedDB|idbGet|idbSet|idbDel/, '数据源页面不得读写浏览器持久化存储');
console.log('datasource tab delegation tests passed');

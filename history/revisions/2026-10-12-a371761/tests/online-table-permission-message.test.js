const assert = require('assert');
const fs = require('fs');

const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');

assert.match(app, /function oaTableFailureMessage\(action, status, detail\)/, '在线表失败必须统一生成人类可读提示');
assert.match(app, /forbidden\\\.accessDenied\|accessDenied/, '必须识别钉钉的访问拒绝错误码');
assert.match(app, /目标知识库文件夹的编辑权限/, '权限拒绝必须提示需要检查目标文件夹编辑权限');
assert.match(app, /应用未获文档创建\/写入权限/, '权限拒绝必须提示需要检查应用文档权限');
assert.match(app, /oaTableFailureMessage\('创建', nj && \(nj\.httpStatus \|\| nj\.status\), detail\)/, '建表失败必须使用统一提示');
assert.match(app, /oaTableFailureMessage\('写入', fj && fj\.status, detail\)/, '写表失败必须使用统一提示');

console.log('online table permission message checks passed');

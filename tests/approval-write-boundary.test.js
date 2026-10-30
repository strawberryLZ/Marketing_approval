const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync(require.resolve('../serve'), 'utf8');
const approval = fs.readFileSync(require.resolve('../approval-sync'), 'utf8');
const app = fs.readFileSync(require.resolve('../app'), 'utf8');

assert.match(approval, /async submittedFor\(/, '审批同步库必须提供实例归属校验');
assert.match(server, /_approvalStore\.submittedFor\(\{ instanceId, requestId, originatorUserId: actor\.userId \}\)/, '申请归档必须校验服务端已记录的审批实例归属');
assert.match(server, /body\.processCode = configuredProcessCode;/, '审批创建不得接受浏览器指定其它流程');
assert.match(server, /审批评论内容与已归档协作表不匹配/, '审批评论必须绑定已归档协作表链接');
assert.match(app, /await persistApplication\(app\);\s*if \(oaRes\.commentPending\) app\.oaCommentOk = await postOaTableComment\(app\);/, '审批评论必须在申请归档后发送');

console.log('approval write boundary checks passed');

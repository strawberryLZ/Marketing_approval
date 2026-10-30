const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync(require.resolve('../serve'), 'utf8');
const callback = (server.match(/if \(u === '\/api\/ding\/events'[\s\S]*?(?=\n  \/\* ---- 钉钉网页登录)/) || [])[0] || '';

assert.match(callback, /await syncApprovalEvent\(event\);/, '验签后的 HTTP 审批回调必须进入状态同步，不能只记录日志后 ACK');
assert.ok(callback.indexOf('await syncApprovalEvent(event);') < callback.indexOf('return sendJson(res, dingEventAck(eventCfg));'), '必须先处理状态再确认事件');
assert.match(callback, /审批事件暂无法写入，请稍后重试/, '状态写入失败必须返回可重试响应');

console.log('approval HTTP callback dispatch checks passed');

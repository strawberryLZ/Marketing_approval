const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');
const createHelper = server.slice(server.indexOf('async function createCalendarForApprovedApplication'), server.indexOf('async function triggerCalendarForPassed'));
const endpoint = server.slice(server.indexOf("if (u === '/api/ding/calendar/create'"), server.indexOf("if (u === '/api/ding/comment'"));

assert.match(createHelper, /row\.originator_user_id[\s\S]*?actor\.userId[\s\S]*?canAccessDataSource/, '成员只能为本人审批创建日历，管理员可代处理');
assert.match(createHelper, /row\.status !== '已通过'/, '未通过审批不得创建活动日历');
assert.match(endpoint, /createCalendarForApprovedApplication\(processInstanceId, actor\)/, '手工入口必须按审批实例和当前钉钉身份创建日历');
assert.doesNotMatch(endpoint, /body\.calendarId|body\.title|body\.startDate|body\.endDate/, '手工入口不得接受前端指定日历、标题或日期');

console.log('calendar authorization checks passed');

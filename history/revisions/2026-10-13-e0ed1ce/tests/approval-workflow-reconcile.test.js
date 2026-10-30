const assert = require('assert');
const { normalizeWorkflowInstanceStatus } = require('../approval-sync');

assert.deepStrictEqual(normalizeWorkflowInstanceStatus({ status: 'COMPLETED', result: 'agree' }), {
  status: '已通过', rawStatus: 'COMPLETED', rawResult: 'AGREE', terminal: true,
});
assert.deepStrictEqual(normalizeWorkflowInstanceStatus({ status: 'COMPLETED', result: 'refuse' }), {
  status: '未通过', rawStatus: 'COMPLETED', rawResult: 'REFUSE', terminal: true,
});
assert.deepStrictEqual(normalizeWorkflowInstanceStatus({ status: 'TERMINATED' }), {
  status: '已撤销', rawStatus: 'TERMINATED', rawResult: '', terminal: true,
});
assert.strictEqual(normalizeWorkflowInstanceStatus({ status: 'RUNNING' }), null, '审批中的实例不得被补查任务写成终态');

console.log('approval workflow reconciliation status checks passed');

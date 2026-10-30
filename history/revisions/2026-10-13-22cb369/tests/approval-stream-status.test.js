const assert = require('assert');
const { normalizeApprovalEvent, canApplyApprovalStatus } = require('../approval-sync');

const instance = 'instance-1';
assert.deepStrictEqual(normalizeApprovalEvent({ EventType: 'bpms_instance_change', processInstanceId: instance, type: 'finish', result: 'agree' }), {
  status: '已通过', rawStatus: 'COMPLETED', rawResult: 'AGREE', terminal: true,
});
assert.deepStrictEqual(normalizeApprovalEvent({ EventType: 'bpms_instance_change', processInstanceId: instance, type: 'finish', result: 'refuse' }), {
  status: '未通过', rawStatus: 'COMPLETED', rawResult: 'REFUSE', terminal: true,
});
assert.deepStrictEqual(normalizeApprovalEvent({ EventType: 'bpms_instance_change', processInstanceId: instance, type: 'terminate' }), {
  status: '已撤销', rawStatus: 'TERMINATED', rawResult: '', terminal: true,
});
assert.strictEqual(normalizeApprovalEvent({ EventType: 'bpms_task_change', type: 'finish', result: 'agree' }), null, '任务事件不能提前覆盖实例最终状态');
assert.strictEqual(canApplyApprovalStatus('审批中', '已通过'), true, '审批中的实例必须可以进入终态');
assert.strictEqual(canApplyApprovalStatus('已通过', '审批中'), false, '终态不得被延迟的开始事件回退');
assert.strictEqual(canApplyApprovalStatus('未通过', '已通过'), false, '终态之间不得被后到事件覆盖');
assert.strictEqual(canApplyApprovalStatus('已撤销', '已撤销'), true, '相同终态事件应当幂等');
console.log('approval stream status checks passed');

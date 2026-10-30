/* 审批状态同步：仅查询和记录状态，绝不调用同意、拒绝或转交审批接口。 */
function extractProcessInstanceId(event) {
  const candidates = [
    event && event.processInstanceId,
    event && event.process_instance_id,
    event && event.processInstanceID,
    event && event.bizData && event.bizData.processInstanceId,
    event && event.data && event.data.processInstanceId,
  ];
  return candidates.map((value) => String(value || '').trim()).find(Boolean) || '';
}

/* Stream 是实时状态来源；待审批实例可由新版工作流查询接口补查终态。
 * 禁止使用旧版 topapi 查询接口，避免新版实例被读成空结果。 */
function normalizeApprovalEvent(event) {
  const eventType = String(event && (event.EventType || event.eventType) || '').toLowerCase();
  if (eventType !== 'bpms_instance_change') return null;
  const type = String(event && event.type || '').toLowerCase();
  const result = String(event && event.result || '').toUpperCase();
  if (type === 'finish' && ['AGREE', 'APPROVED', 'PASS'].includes(result)) return { status: '已通过', rawStatus: 'COMPLETED', rawResult: result, terminal: true };
  if (type === 'finish' && ['REFUSE', 'REJECTED', 'DISAGREE'].includes(result)) return { status: '未通过', rawStatus: 'COMPLETED', rawResult: result, terminal: true };
  if (type === 'terminate') return { status: '已撤销', rawStatus: 'TERMINATED', rawResult: result, terminal: true };
  if (type === 'start') return { status: '审批中', rawStatus: 'RUNNING', rawResult: result, terminal: false };
  return null;
}
/* 新版工作流实例查询的终态映射。只返回终态，绝不把补查结果写回“审批中”。 */
function normalizeWorkflowInstanceStatus(instance) {
  const rawStatus = String(instance && instance.status || '').toUpperCase();
  const rawResult = String(instance && instance.result || '').toUpperCase();
  if (rawStatus === 'COMPLETED' && ['AGREE', 'APPROVED', 'PASS'].includes(rawResult)) return { status: '已通过', rawStatus, rawResult, terminal: true };
  if (rawStatus === 'COMPLETED' && ['REFUSE', 'REJECTED', 'DISAGREE'].includes(rawResult)) return { status: '未通过', rawStatus, rawResult, terminal: true };
  if (['TERMINATED', 'CANCELED', 'CANCELLED'].includes(rawStatus)) return { status: '已撤销', rawStatus, rawResult, terminal: true };
  return null;
}
const TERMINAL_APPROVAL_STATUSES = new Set(['已通过', '未通过', '已撤销']);
function canApplyApprovalStatus(currentStatus, nextStatus) {
  return !TERMINAL_APPROVAL_STATUSES.has(String(currentStatus || '')) || String(currentStatus) === String(nextStatus);
}

class ApprovalStore {
  constructor(connectionString) {
    this.connectionString = connectionString || '';
    this.pool = null;
    this.ready = false;
  }
  async init() {
    if (!this.connectionString) return false;
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_approval_sync (
      instance_id TEXT PRIMARY KEY,
      request_id TEXT,
      originator_user_id TEXT,
      status TEXT NOT NULL DEFAULT '审批中',
      ding_status TEXT,
      ding_result TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS marketing_approval_sync_status_idx ON marketing_approval_sync (status, updated_at DESC)');
    this.ready = true;
    return true;
  }
  enabled() { return this.ready && !!this.pool; }
  async recordSubmitted({ instanceId, requestId, originatorUserId }) {
    if (!this.enabled()) return false;
    await this.pool.query(`INSERT INTO marketing_approval_sync (instance_id, request_id, originator_user_id, status)
      VALUES ($1, $2, $3, '审批中')
      ON CONFLICT (instance_id) DO UPDATE SET request_id = EXCLUDED.request_id, originator_user_id = EXCLUDED.originator_user_id, updated_at = NOW()`,
    [instanceId, requestId || null, originatorUserId || null]);
    return true;
  }
  /* 企业申请归档前，确认该审批实例确由本服务为该申请人和申请编号创建。 */
  async submittedFor({ instanceId, requestId, originatorUserId }) {
    if (!this.enabled() || !instanceId || !requestId || !originatorUserId) return false;
    const result = await this.pool.query(`SELECT 1 FROM marketing_approval_sync
      WHERE instance_id = $1 AND request_id = $2 AND originator_user_id = $3 LIMIT 1`,
    [String(instanceId), String(requestId), String(originatorUserId)]);
    return !!result.rows[0];
  }
  async recordStatus(instanceId, mapped) {
    if (!this.enabled()) return { applied: false, reason: 'disabled' };
    const result = await this.pool.query(`UPDATE marketing_approval_sync
      SET status = $2, ding_status = $3, ding_result = $4, updated_at = NOW()
      WHERE instance_id = $1
        /* 相同终态也只允许第一个消费者生效，避免 Stream 与补偿查询并发时
         * 重复触发审批通过后的副作用（例如创建日历）。 */
        AND status NOT IN ('已通过', '未通过', '已撤销')
      RETURNING status`, [instanceId, mapped.status, mapped.rawStatus || null, mapped.rawResult || null]);
    return { applied: result.rowCount > 0, reason: result.rowCount ? '' : 'terminal-or-missing' };
  }
  async pending(limit) {
    if (!this.enabled()) return [];
    const out = await this.pool.query(`SELECT instance_id, originator_user_id FROM marketing_approval_sync
      WHERE status = '审批中' ORDER BY updated_at ASC LIMIT $1`, [limit || 100]);
    return out.rows.map((row) => ({ instanceId: row.instance_id, originatorUserId: row.originator_user_id }));
  }
  /* 手动刷新只允许查询当前成员的待审批实例；数据源白名单成员可按既有全量查看权限刷新。 */
  async pendingForViewer(userId, canViewAll, limit) {
    if (!this.enabled()) return [];
    const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const out = canViewAll
      ? await this.pool.query(`SELECT instance_id, originator_user_id FROM marketing_approval_sync
          WHERE status = '审批中' ORDER BY updated_at ASC LIMIT $1`, [max])
      : await this.pool.query(`SELECT instance_id, originator_user_id FROM marketing_approval_sync
          WHERE status = '审批中' AND originator_user_id = $1 ORDER BY updated_at ASC LIMIT $2`, [String(userId || ''), max]);
    return out.rows.map((row) => ({ instanceId: row.instance_id, originatorUserId: row.originator_user_id }));
  }
  async statuses(instanceIds) {
    if (!this.enabled() || !instanceIds.length) return {};
    const out = await this.pool.query(`SELECT instance_id, status, updated_at FROM marketing_approval_sync WHERE instance_id = ANY($1::text[])`, [instanceIds]);
    return Object.fromEntries(out.rows.map((row) => [row.instance_id, { status: row.status, updatedAt: row.updated_at }]));
  }
}

function streamCredentials(cfg) {
  const oa = (cfg && cfg.oa) || {};
  const clientId = String(oa.streamAppKey || oa.appKey || '');
  const clientSecret = String(oa.streamAppSecret || oa.appSecret || '');
  return { clientId, clientSecret, configured: !!(clientId && clientSecret) };
}

function startApprovalStream({ cfg, onEvent, onError }) {
  const credentials = streamCredentials(cfg);
  if (!credentials.configured) return { started: false, reason: '未配置 Stream Client ID/Secret' };
  const { DWClient, EventAck } = require('dingtalk-stream');
  const client = new DWClient({ clientId: credentials.clientId, clientSecret: credentials.clientSecret, maxPendingEventHandlers: 10 });
  client.registerAllEventListener(async (message) => {
    try {
      const event = JSON.parse(message.data || '{}');
      await onEvent(event, message.headers || {});
      return { status: EventAck.SUCCESS };
    } catch (error) {
      if (onError) onError(error);
      return { status: EventAck.LATER };
    }
  });
  client.connect();
  return { started: true, client };
}

module.exports = { ApprovalStore, extractProcessInstanceId, normalizeApprovalEvent, normalizeWorkflowInstanceStatus, canApplyApprovalStatus, startApprovalStream, streamCredentials };

/* 企业申请记录：审批快照和最终状态均保存于 PostgreSQL，前端不作为权威存储。 */
class BusinessStore {
  constructor(connectionString) { this.connectionString = connectionString || ''; this.pool = null; this.ready = false; }
  async init() {
    if (!this.connectionString) return false;
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_applications (
      id TEXT PRIMARY KEY,
      parent_application_id TEXT,
      originator_user_id TEXT NOT NULL,
      originator_name TEXT,
      status TEXT NOT NULL DEFAULT '审批中',
      oa_instance_id TEXT UNIQUE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_application_status_events (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES marketing_applications(id),
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS marketing_applications_originator_idx ON marketing_applications (originator_user_id, updated_at DESC)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS marketing_applications_status_idx ON marketing_applications (status, updated_at DESC)');
    this.ready = true;
    return true;
  }
  enabled() { return this.ready && !!this.pool; }
  async create(application, actor) {
    if (!this.enabled()) throw new Error('企业申请数据库未连接');
    if (!application || !application.id || !application.oaNo || application.oaReal !== true) throw new Error('仅允许保存已真实发起钉钉审批的申请');
    const payload = JSON.parse(JSON.stringify(application));
    delete payload._uploadXlsx;
    delete payload._uploadName;
    payload.applicant = String(actor.name || payload.applicant || '当前登录人');
    payload.originatorUserId = String(actor.userId);
    payload.status = '审批中';
    const result = await this.pool.query(`INSERT INTO marketing_applications
      (id, parent_application_id, originator_user_id, originator_name, status, oa_instance_id, payload)
      VALUES ($1,$2,$3,$4,'审批中',$5,$6::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING id, created_at`,
    [String(payload.id), payload.parentApplicationId || null, String(actor.userId), String(actor.name || ''), String(payload.oaNo), JSON.stringify(payload)]);
    if (result.rows[0]) {
      await this.pool.query(`INSERT INTO marketing_application_status_events (application_id, status, source) VALUES ($1,'审批中','submit')`, [String(payload.id)]);
      return result.rows[0];
    }
    const existing = await this.pool.query(`SELECT id, created_at FROM marketing_applications WHERE id = $1 AND originator_user_id = $2 AND oa_instance_id = $3`, [String(payload.id), String(actor.userId), String(payload.oaNo)]);
    if (existing.rows[0]) return existing.rows[0];
    throw new Error('申请编号冲突，未覆盖已有申请');
  }
  async recordStatus(instanceId, status, source) {
    if (!this.enabled() || !instanceId) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(`UPDATE marketing_applications SET status = $2, updated_at = NOW()
        WHERE oa_instance_id = $1 AND status IS DISTINCT FROM $2
          AND status NOT IN ('已通过', '未通过', '已撤销') RETURNING id`, [String(instanceId), String(status)]);
      for (const row of changed.rows) await client.query(`INSERT INTO marketing_application_status_events (application_id, status, source) VALUES ($1,$2,$3)`, [row.id, String(status), source || 'approval-sync']);
      await client.query('COMMIT');
      return changed.rowCount > 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  /* 按钉钉实例号取整份申请（含 payload 与已建日历事件标记），供审批通过后的自动化使用 */
  async getByInstanceId(instanceId) {
    if (!this.enabled() || !instanceId) return null;
    const result = await this.pool.query(`SELECT id, originator_user_id, originator_name, status, oa_instance_id,
      payload, payload->>'oaCalendarEventId' AS calendar_event_id, created_at, updated_at
      FROM marketing_applications WHERE oa_instance_id = $1 LIMIT 1`, [String(instanceId)]);
    return result.rows[0] || null;
  }
  /* 记录自动创建日历事件的结果（只记创建结果 created/failed），供前端 tip 标签跟踪 */
  async markCalendarResult(instanceId, result) {
    if (!this.enabled() || !instanceId) return false;
    const r = result || {};
    const patch = {
      oaCalendarStatus: r.status === 'created' ? 'created' : 'failed',
      oaCalendarAt: new Date().toISOString(),
    };
    if (r.eventId) patch.oaCalendarEventId = String(r.eventId);
    if (r.err) patch.oaCalendarErr = String(r.err).slice(0, 300);
    const res = await this.pool.query(`UPDATE marketing_applications
      SET payload = COALESCE(payload,'{}'::jsonb) || $2::jsonb, updated_at = NOW()
      WHERE oa_instance_id = $1 RETURNING id`, [String(instanceId), JSON.stringify(patch)]);
    return res.rowCount > 0;
  }
  async list(actor, canViewAll) {
    if (!this.enabled()) return [];
    const result = await this.pool.query(`SELECT id, originator_user_id, originator_name, status, oa_instance_id, payload, created_at, updated_at
      FROM marketing_applications ${canViewAll ? '' : 'WHERE originator_user_id = $1'} ORDER BY created_at DESC`, canViewAll ? [] : [String(actor.userId)]);
    return result.rows.map((row) => Object.assign({}, row.payload || {}, {
      id: row.id, applicant: row.originator_name || (row.payload && row.payload.applicant) || '', originatorUserId: row.originator_user_id,
      status: row.status, oaNo: row.oa_instance_id || (row.payload && row.payload.oaNo) || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }
  async statuses(instanceIds, actor, canViewAll) {
    if (!this.enabled() || !instanceIds.length) return {};
    const result = await this.pool.query(`SELECT oa_instance_id, status, updated_at FROM marketing_applications
      WHERE oa_instance_id = ANY($1::text[]) ${canViewAll ? '' : 'AND originator_user_id = $2'}`,
    canViewAll ? [instanceIds] : [instanceIds, String(actor.userId)]);
    return Object.fromEntries(result.rows.map((row) => [row.oa_instance_id, { status: row.status, updatedAt: row.updated_at }]));
  }
  /* 仅供信息部门在系统内核对已入库申请；不接受任意 SQL，也不返回数据库配置或凭据。 */
  async auditRows(limit) {
    if (!this.enabled()) return [];
    const result = await this.pool.query(`SELECT
      a.id AS application_id, a.oa_instance_id, a.status AS application_status,
      a.originator_name AS applicant, a.created_at, a.updated_at,
      a.payload->>'platform' AS platform, a.payload->>'store' AS store,
      a.payload->>'activityType' AS activity_type, a.payload->>'activityName' AS activity_name,
      a.payload->>'start' AS start_date, a.payload->>'end' AS end_date,
      COALESCE(jsonb_array_length(a.payload->'items'), 0) AS item_count,
      COALESCE(jsonb_array_length(a.payload->'standardRows'), 0) AS standard_row_count,
      s.status AS sync_status, s.ding_status, s.ding_result, s.updated_at AS sync_updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('status', e.status, 'source', e.source, 'createdAt', e.created_at) ORDER BY e.created_at DESC)
        FROM marketing_application_status_events e WHERE e.application_id = a.id), '[]'::jsonb) AS status_events
      FROM marketing_applications a
      LEFT JOIN marketing_approval_sync s ON s.instance_id = a.oa_instance_id
      ORDER BY a.created_at DESC LIMIT $1`, [Math.min(Math.max(Number(limit) || 100, 1), 200)]);
    return result.rows;
  }
  /* 核对明细仅返回一笔已入库申请的固定快照字段；调用方仍必须先完成信息部门白名单校验。 */
  async auditDetail(applicationId) {
    if (!this.enabled()) return null;
    const id = String(applicationId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    const result = await this.pool.query(`SELECT
      a.id AS application_id, a.oa_instance_id, a.status AS application_status,
      a.originator_name AS applicant, a.created_at, a.updated_at,
      a.payload->>'platform' AS platform, a.payload->>'store' AS store,
      a.payload->>'activityType' AS activity_type, a.payload->>'activityName' AS activity_name,
      a.payload->>'activityCat' AS activity_category, a.payload->>'start' AS start_date, a.payload->>'end' AS end_date,
      COALESCE(a.payload->'activities', '[]'::jsonb) AS activities,
      COALESCE(a.payload->'items', '[]'::jsonb) AS items,
      COALESCE(a.payload->'standardRows', '[]'::jsonb) AS standard_rows,
      s.status AS sync_status, s.ding_status, s.ding_result, s.updated_at AS sync_updated_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('status', e.status, 'source', e.source, 'createdAt', e.created_at) ORDER BY e.created_at DESC)
        FROM marketing_application_status_events e WHERE e.application_id = a.id), '[]'::jsonb) AS status_events
      FROM marketing_applications a
      LEFT JOIN marketing_approval_sync s ON s.instance_id = a.oa_instance_id
      WHERE a.id = $1
      LIMIT 1`, [id]);
    return result.rows[0] || null;
  }
  async references(actor, canViewAll) {
    if (!this.enabled()) return { history: [], costs: [], plays: [] };
    const result = await this.pool.query(`SELECT id, payload FROM marketing_applications
      WHERE status = '已通过' ${canViewAll ? '' : 'AND originator_user_id = $1'} ORDER BY updated_at DESC`, canViewAll ? [] : [String(actor.userId)]);
    const history = [], costs = [], plays = [];
    for (const row of result.rows) {
      const app = row.payload || {};
      const perSpu = new Map();
      for (const item of Array.isArray(app.items) ? app.items : []) {
        if (!item || !item.spuCode) continue;
        const entry = perSpu.get(item.spuCode) || { prices: [] };
        const price = Number(item.price);
        if (Number.isFinite(price)) entry.prices.push(price);
        perSpu.set(item.spuCode, entry);
      }
      for (const [spuCode, entry] of perSpu) {
        const firstActivity = Array.isArray(app.activities) ? app.activities[0] || {} : {};
        history.push({
          spuCode,
          // 同一 SPU 的不同 SKU 可有不同审批价；历史价格固定取该审批单的最低真实 SKU 活动价。
          price: entry.prices.length ? Math.min(...entry.prices) : null,
          startDate: app.start || '', endDate: app.end || '', applicationId: row.id,
          platform: app.platform || '', store: app.store || '',
          activityType: app.activityType || firstActivity.unified || '',
          activityName: app.activityName || firstActivity.name || firstActivity.cat2 || '',
          applicant: row.originator_name || app.applicant || '',
          archived: true, sourceLabel: '审批归档（真实）', sourceType: 'approval_snapshot',
        });
      }
      for (const activity of Array.isArray(app.activities) ? app.activities : []) {
        if (!activity) continue;
        if (activity.cost) costs.push({ platform: app.platform || '', unified: activity.unified || '', cat2: activity.cat2 || '', cost: activity.cost, scope: activity.scope || 'sku', appNo: row.id });
        if (activity.scope === 'store' && activity.play && activity.play.text) plays.push({ platform: app.platform || '', unified: activity.unified || '', cat2: activity.cat2 || '', type: activity.play.type || '', text: activity.play.text || '', params: activity.play.params || {}, appNo: row.id });
      }
    }
    return { history, costs, plays };
  }
}

module.exports = { BusinessStore };

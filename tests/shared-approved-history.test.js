const assert = require('assert');
const fs = require('fs');
const { BusinessStore } = require('../business-store');

async function main() {
  const calls = [];
  const store = new BusinessStore('test');
  store.ready = true;
  store.pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/originator_user_id\s*=/.test(sql)) return { rows: [] };
      return {
        rows: [{
          id: 'REQ-other-user',
          originator_name: '其他运营',
          payload: {
            platform: '京东', store: '京东旗舰店', activityName: '大促', start: '2026-10-01',
            items: [{ spuCode: 'FB0116', price: 29 }, { spuCode: 'FB0116', price: 31 }],
            /* 早期上传单没有活动级满赠字段时，仍必须从标准明细兼容读取。 */
            standardMeta: { gouwujin: 'PLUS券：200-25；480-60' },
            standardRows: [{ 满赠规则: '满199送洗衣袋', 购物金规则: '' }],
            activities: [{
              unified: '平台大促', cat2: '官方立减', cost: '品牌承担', scope: 'store',
              play: { type: '满减', text: '满300减50', params: { threshold: 300, off: 50 } },
            }],
          },
        }],
      };
    },
  };

  const refs = await store.references({ userId: 'ordinary-user' }, false);
  assert.deepStrictEqual(calls[0].params, [], '普通成员读取历史最低价不得再按本人 userId 过滤');
  assert.ok(!/originator_user_id\s*=/.test(calls[0].sql), '历史最低价查询不得带发起人过滤条件');
  assert.equal(refs.history.length, 1, '普通成员必须能获得其他成员已通过的审批历史');
  assert.equal(refs.history[0].price, 29, '共享历史仍须取同一审批单内真实 SKU 的最低价');
  assert.equal(refs.history[0].applicant, '其他运营', '共享历史必须保留来源提交人，供运营追溯');
  assert.equal(calls.length, 1, '共享历史、费用与玩法应一次读取全部已通过审批');
  assert.equal(refs.costs[0].cost, '品牌承担', '普通成员必须能查询其他成员已通过审批的费用承担');
  assert.equal(refs.costs[0].applicant, '其他运营', '费用承担必须保留来源提交人');
  assert.equal(refs.plays[0].text, '满300减50', '普通成员必须能查询其他成员已通过审批的店铺玩法');
  assert.equal(refs.plays[0].applicant, '其他运营', '店铺玩法必须保留来源提交人');
  assert.equal(refs.rules[0].text, '满199送洗衣袋', '普通成员必须能查询其他成员已通过审批的满赠规则');
  assert.equal(refs.rules[1].text, 'PLUS券：200-25；480-60', '普通成员必须能查询其他成员已通过审批的购物金或 PLUS 券规则');

  const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
  assert.match(app, /const sharedCosts = enterpriseCosts\.filter/, '价格查询必须读取公开费用承担参考');
  assert.match(app, /const sharedPlays = enterprisePlays\.filter/, '价格查询必须读取公开店铺玩法参考');
  assert.match(app, /const sharedRules = enterpriseRules\.filter/, '价格查询必须读取公开满赠和购物金规则参考');
  assert.match(app, /费用承担、店铺玩法与活动规则（已通过审批 · 公开参考）/, '价格查询必须展示公开费用、玩法与活动规则区块');

  console.log('shared approved history checks passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

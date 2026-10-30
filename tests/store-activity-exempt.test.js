const assert = require('assert');
const { normalizeExemptStoreActivity, storeActivityDetailSheets } = require('../serve');

const actor = { userId: 'ding-user', name: '测试用户', dept: 'marketing' };
const midTableSnapshot = {
  builtAt: '2026-10-27T12:00:00.000Z', sourceHash: 'a'.repeat(64),
  rows: [{ spuCode: 'FBWFS1', name: '女式秋冬长袖', spuShort: '长袖1.0', category: '服饰', productPos: '非标', grade: 'S', season: '24FW', gender: '女', retailPrice: 258, minPrice: 181, redlinePrice: 181, skuCount: 31 }],
};
const application = normalizeExemptStoreActivity({
  id: 'STORE20261026-ABC', platform: '京东', store: '京东旗舰店', activityType: '营销', activityCat: '满减', activityName: '双11全店满减',
  start: '2026-11-01', end: '2026-11-11', isStoreActivity: true, approvalMode: 'exempt',
  activities: [{ unified: '营销', cat2: '满减', name: '满减', cost: '品牌承担', scope: 'store', play: { type: '满减', text: '满199减30' } }],
  gifts: [{ spuCode: 'FBWFS1', name: '女式秋冬长袖', season: '24FW', gender: '女' }], midTableSnapshot, standardMeta: { remark: '大促' },
}, actor);

assert.equal(application.status, '已通过');
assert.equal(application.standardMeta.manzeng, '满199减30');
assert.equal(application.gifts[0].spuCode, 'FBWFS1');
assert.equal(application.hasGift, true);
const sheets = storeActivityDetailSheets(application);
assert.equal(sheets.length, 3);
assert.equal(sheets[1].values[1][1], '女式秋冬长袖');
assert.equal(sheets[2].name, '商品中间表快照');
assert.equal(sheets[2].values[1][0], 'FBWFS1');
const noGiftApplication = normalizeExemptStoreActivity({ ...application, id: 'STORE20261026-NOGIFT', hasGift: false, gifts: [] }, actor);
assert.equal(noGiftApplication.hasGift, false);
assert.equal(noGiftApplication.gifts.length, 0);
assert.throws(() => normalizeExemptStoreActivity({ ...application, id: 'STORE20261026-GIFTMISSING', hasGift: true, gifts: [] }, actor), /赠品/);
const noSnapshot = { ...application, id: 'STORE20261026-NOSNAPSHOT' }; delete noSnapshot.midTableSnapshot;
assert.throws(() => normalizeExemptStoreActivity(noSnapshot, actor), /中间表快照/);
assert.throws(() => normalizeExemptStoreActivity({ ...application, id: 'STORE20261026-BAD', activities: [{ ...application.activities[0], scope: 'sku' }] }, actor), /全店玩法/);

console.log('store activity exempt validation tests passed');

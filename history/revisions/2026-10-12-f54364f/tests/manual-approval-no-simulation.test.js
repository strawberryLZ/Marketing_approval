const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const fallback = source.match(/if \(!items \|\| !items\.length\) \{([^}]+)\}/);

assert.ok(fallback, 'missing manual approval schema fallback');
assert.ok(!fallback[1].includes('finishSubmit'), 'manual approval fallback must not create a simulated approval');
assert.ok(fallback[1].includes('未创建申请单'), 'manual approval fallback must explain that no application was created');
console.log('manual approval schema failure does not create a simulated application');

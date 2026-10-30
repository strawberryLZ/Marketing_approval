const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

assert.match(source, /mk\(ctl\.是否审批, app && app\.approvalMode === 'exempt' \? '不审批' : '审批'\)/, 'required approval field must use the exact configured radio values');
assert.match(source, /不审批（全店活动默认）/, 'store activity entry should display the fixed no-approval mode');
assert.match(source, /approvalMode: 'exempt'/, 'store activity submission should pass the fixed no-approval mode');
assert.doesNotMatch(source, /id="sa-approval"/, 'store activity entry should not require users to choose approval mode');

console.log('approval required choice tests passed');

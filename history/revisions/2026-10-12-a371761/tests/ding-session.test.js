const assert = require('assert');
const { encodeDingSession, decodeDingSession } = require('../serve');

const cfg = { security: { sessionSigningSecret: 'test-only-signing-secret' } };
const session = encodeDingSession({ userId: 'user-1', name: '测试成员', source: '钉钉免登' }, cfg);
const decoded = decodeDingSession(session, cfg);

assert.equal(decoded.userId, 'user-1');
assert.equal(decoded.name, '测试成员');
assert.equal(decoded.source, '钉钉免登');
assert.equal(decodeDingSession(session + 'x', cfg), null);
console.log('ding-session persistence checks passed');

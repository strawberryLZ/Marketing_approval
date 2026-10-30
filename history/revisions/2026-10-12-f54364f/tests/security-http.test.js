const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function request(baseUrl, pathname, cookie) {
  return fetch(baseUrl + pathname, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function main() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-security-test-'));
  const configPath = path.join(runtimeDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    security: { sessionSigningSecret: 'test-session-signing-secret' },
    oa: { appKey: 'ding-test', appSecret: 'test-oa-secret', dataSourceViewerUserIds: ['admin'] },
  }), { mode: 0o600 });
  process.env.MARKETING_CONFIG_PATH = configPath;
  process.env.MARKETING_RUNTIME_DIR = runtimeDir;

  const { server, encodeDingSession } = require('../serve');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (const file of ['/config.json', '/serve.js', '/oa-call.log', '/package.json', '/PROJECT_HANDOFF_2026-09-30.md', '/tests/security-http.test.js', '/.git/HEAD']) {
      assert.equal((await request(baseUrl, file)).status, 404, `${file} must not be downloadable`);
    }
    assert.equal((await request(baseUrl, '/')).status, 302, 'anonymous application entry must redirect to DingTalk login');
    assert.equal((await request(baseUrl, '/app.js')).status, 401, 'anonymous front-end resource must be denied');
    for (const api of ['/api/config', '/api/datasource/access', '/api/ding/me', '/api/ding/health', '/api/ding/approval-sync/health']) {
      assert.equal((await request(baseUrl, api)).status, 401, `${api} must require a valid session`);
    }

    const member = encodeDingSession({ userId: 'member', name: '普通成员' }, { security: { sessionSigningSecret: 'test-session-signing-secret' } });
    assert.equal((await request(baseUrl, '/api/config', `mkt_ding_session=${member}`)).status, 403, 'ordinary member must not access administrator configuration');

    const admin = encodeDingSession({ userId: 'admin', name: '信息部门成员' }, { security: { sessionSigningSecret: 'test-session-signing-secret' } });
    const configResponse = await request(baseUrl, '/api/config', `mkt_ding_session=${admin}`);
    assert.equal(configResponse.status, 200, 'authorized administrator must still access configuration');
    const body = await configResponse.text();
    assert(!body.includes('test-session-signing-secret') && !body.includes('test-oa-secret'), 'API response must not contain signing or OA secrets');
    for (const resource of ['/', '/index.html', '/app.js', '/data.js', '/datasource.js', '/products_seed.js', '/sample-data.js', '/styles.css', '/upload.js', '/xlsx.full.min.js']) {
      assert.equal((await request(baseUrl, resource, `mkt_ding_session=${admin}`)).status, 200, `authorized DingTalk user must load ${resource}`);
    }
    console.log('security HTTP boundary checks passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

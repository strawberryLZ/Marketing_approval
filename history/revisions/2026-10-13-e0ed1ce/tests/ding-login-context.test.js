const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-login-context-test-'));
  const configPath = path.join(runtimeDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    security: { sessionSigningSecret: 'test-session-signing-secret' },
    oa: { corpId: 'dingloginfallback', appKey: 'test-key', appSecret: 'test-secret' },
  }), { mode: 0o600 });
  process.env.MARKETING_CONFIG_PATH = configPath;
  process.env.MARKETING_RUNTIME_DIR = runtimeDir;
  const { server } = require('../serve');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(baseUrl + '/api/ding/login-context');
    assert.equal(response.status, 200, '匿名登录页必须可读取免登所需的企业标识');
    assert.deepEqual(await response.json(), { success: true, corpId: 'dingloginfallback' }, '登录上下文不得返回任何密钥或其他配置');
    console.log('ding login context fallback checks passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

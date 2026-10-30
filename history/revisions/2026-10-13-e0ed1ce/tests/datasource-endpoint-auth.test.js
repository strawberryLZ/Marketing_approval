const assert = require('assert');
const http = require('http');
const { server } = require('../serve');

function request(port, path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: method || 'GET' }, (res) => {
      let text = ''; res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text), headers: res.headers }));
    });
    req.on('error', reject); req.end();
  });
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const current = await request(port, '/api/datasource/current');
    assert.strictEqual(current.status, 401, '未登录不得读取企业正式数据');
    const status = await request(port, '/api/datasource/status');
    assert.strictEqual(status.status, 401, '未登录不得读取同步日志');
    const applications = await request(port, '/api/applications');
    assert.strictEqual(applications.status, 401, '未登录不得读取企业申请记录');
    const member = await request(port, '/api/ding/user', 'POST');
    assert.strictEqual(member.status, 401, '未登录不得查询企业成员资料');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log('datasource endpoint authentication tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });

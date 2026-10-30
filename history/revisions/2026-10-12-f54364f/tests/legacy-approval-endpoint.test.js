const assert = require('assert');
const http = require('http');
const { server } = require('../serve');

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const req = http.request({ hostname: '127.0.0.1', port, path: '/api/ding/create_legacy', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        assert.equal(res.statusCode, 410);
        assert.equal(JSON.parse(body).success, false);
        console.log('legacy approval endpoint is closed');
      } finally { server.close(); }
    });
  });
  req.on('error', (error) => { server.close(); throw error; });
  req.end('{}');
});

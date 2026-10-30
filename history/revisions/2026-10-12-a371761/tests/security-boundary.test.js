const assert = require('assert');
const fs = require('fs');

const server = fs.readFileSync(require.resolve('../serve.js'), 'utf8');
const login = fs.readFileSync(require.resolve('../login.html'), 'utf8');
const app = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const nginx = fs.readFileSync(require.resolve('../deploy/nginx/clsp.flipbeltchina.com.conf'), 'utf8');
const rateLimit = fs.readFileSync(require.resolve('../deploy/nginx/marketing-security.conf'), 'utf8');
const logrotate = fs.readFileSync(require.resolve('../deploy/logrotate/marketing-activity'), 'utf8');

assert.match(server, /MARKETING_CONFIG_PATH/, '生产配置必须由 Web 根目录之外的环境路径提供');
assert.match(server, /MARKETING_BIND_HOST \|\| '127\.0\.0\.1'/, '应用必须默认仅监听本机回环地址');
assert.match(server, /STATIC_AUTHENTICATED_FILES/, '静态文件必须使用允许清单，而不是按任意路径读取');
assert.match(server, /PUBLIC_API_PATHS/, '接口必须采用显式公开例外清单');
assert.match(server, /security\) \|\| \{\}\)\.sessionSigningSecret/, '登录会话必须使用独立签名密钥，不能复用钉钉 AppSecret');
assert.match(server, /audit-api/, '认证、授权和异常 API 调用必须写入审计日志');
assert.match(server, /server\.listen\(PORT, BIND_HOST/, '服务监听必须显式绑定内网地址');
assert.doesNotMatch(login, /fetch\('\/api\/config'/, '登录页不得通过匿名配置接口读取企业配置');
assert.match(app, /if \(!corpId\) return null;/, '钉钉应用首页缺少 corpId 时不得退回匿名配置接口');
assert.match(nginx, /Strict-Transport-Security/, '反代必须下发 HSTS');
assert.match(nginx, /location ~\* \^\/\(\?:config/, '反代必须拒绝敏感文件路径');
assert.match(rateLimit, /limit_req_zone/, 'Nginx 必须配置接口限流区');
assert.match(logrotate, /rotate 180/, '审计日志必须至少保留 180 份日轮转记录');

console.log('security boundary checks passed');

/**
 * 假飞书（测试夹具）：只在 127.0.0.1 上监听，不是任何真实系统。照飞书开放平台网页应用授权码流程的三个端点：
 *   GET  /open-apis/authen/v1/authorize   授权页：「用户同意」由测试预先选好的人决定，直接 302 回 redirect_uri?code=&state=
 *   POST /open-apis/authen/v2/oauth/token 用 code 换 user_access_token（code 一次性、5 分钟内有效，要对上应用凭证和 redirect_uri）
 *   GET  /open-apis/authen/v1/user_info   用 user_access_token 取用户信息（union_id、名字、企业邮箱、tenant_key）
 *
 * 测试用的把手：as(人) 选下一次授权页上「同意」的是谁；mode(名) 让某一步出错（见 MODES）；calls 记下每个请求，用来核对密钥只发给了换令牌那一步。
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export const APP = { id: 'cli_synthetic0000001', secret: 'synthetic-app-secret-do-not-log', tenant: 'tenant_synthetic' };

const hex32 = (seed) => [...Buffer.from(seed.padEnd(16, '.').slice(0, 16))].map((b) => b.toString(16).padStart(2, '0')).join('');
/** 合成的人。union_id 照飞书的形状：on_ 加 32 位十六进制 */
export const PEOPLE = {
  alice: { name: 'Synthetic Alice', union_id: `on_${hex32('alice')}`, enterprise_email: 'alice@synthetic.invalid' },
  bob: { name: 'Synthetic Bob', union_id: `on_${hex32('bob')}`, enterprise_email: 'bob@synthetic.invalid' },
  carol: { name: 'Synthetic Carol', union_id: `on_${hex32('carol')}`, enterprise_email: '' },
  dave: { name: 'Synthetic Dave', union_id: `on_${hex32('dave')}`, enterprise_email: 'dave@synthetic.invalid' },
};

/** 让某一步出错 */
export const MODES = {
  normal: '正常',
  deny: '用户在授权页上拒绝（回调带 error）',
  tokenFail: '换令牌失败（飞书回错误码）',
  tokenHang: '换令牌永远不回答',
  tokenNotJson: '换令牌回的不是 JSON',
  userinfoFail: '取用户信息失败（飞书回错误码）',
  unionMissing: '用户信息里没有 union_id',
  unionTampered: '用户信息里的 union_id 形状不对（被篡改）',
  unionInjected: 'union_id 里塞了别的东西',
  otherTenant: '别的租户的人',
};

/** fixedCodes：预先登记的授权码（录制回放用：它没法走一遍授权页）。这些码不核对 redirect_uri，一样一次性 */
export async function startFakeFeishu({ fixedCodes = {} } = {}) {
  let who = 'alice', mode = 'normal';
  const codes = new Map(Object.entries(fixedCodes).map(([code, person]) => [code, { person, redirect: null, at: Date.now() + 365 * 86_400_000 }])), tokens = new Map(), calls = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...req.headers }, body });
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.pathname === '/open-apis/authen/v1/authorize') {
        const redirect = u.searchParams.get('redirect_uri'), state = u.searchParams.get('state');
        if (u.searchParams.get('client_id') !== APP.id || !redirect || !state) return send(400, { code: 20001, msg: 'invalid request (synthetic)' });
        const back = new URL(redirect);
        if (mode === 'deny') { back.searchParams.set('error', 'access_denied'); back.searchParams.set('state', state); }
        else {
          const code = randomBytes(16).toString('hex');
          codes.set(code, { person: who, redirect, at: Date.now() });
          back.searchParams.set('code', code); back.searchParams.set('state', state);
        }
        res.writeHead(302, { location: back.href }); return res.end();
      }
      if (req.method === 'POST' && u.pathname === '/open-apis/authen/v2/oauth/token') {
        if (mode === 'tokenHang') return; // 永远不回答
        if (mode === 'tokenNotJson') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>not json</html>'); }
        let b; try { b = JSON.parse(body); } catch { return send(400, { code: 20002, error: 'invalid_request' }); }
        const c = codes.get(b.code);
        codes.delete(b.code); // 一次性
        if (mode === 'tokenFail' || b.grant_type !== 'authorization_code' || b.client_id !== APP.id || b.client_secret !== APP.secret || !c || (c.redirect !== null && c.redirect !== b.redirect_uri) || Date.now() - c.at > 300_000) {
          return send(400, { code: 20003, error: 'invalid_grant', error_description: 'synthetic' });
        }
        const token = `u-${randomBytes(16).toString('hex')}`;
        tokens.set(token, c.person);
        return send(200, { code: 0, access_token: token, expires_in: 7200, token_type: 'Bearer', scope: '' });
      }
      if (req.method === 'GET' && u.pathname === '/open-apis/authen/v1/user_info') {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        const person = tokens.get(token);
        if (mode === 'userinfoFail' || !person) return send(400, { code: 99991663, msg: 'invalid access token (synthetic)' });
        const p = PEOPLE[person];
        const data = { name: p.name, en_name: p.name, open_id: `ou_${p.union_id.slice(3)}`, union_id: p.union_id, user_id: person, email: '', enterprise_email: p.enterprise_email, tenant_key: APP.tenant };
        if (mode === 'unionMissing') delete data.union_id;
        if (mode === 'unionTampered') data.union_id = 'on_' + p.union_id.slice(3, 20);
        if (mode === 'unionInjected') data.union_id = `${p.union_id}\u0000admin`;
        if (mode === 'otherTenant') data.tenant_key = 'tenant_other';
        return send(200, { code: 0, msg: 'success', data });
      }
      send(404, { code: 404, msg: 'not found (synthetic)' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    env: { WM_FEISHU_LOGIN: 'on', WM_FEISHU_AUTHORIZE_URL: `${url}/open-apis/authen/v1/authorize`, WM_FEISHU_TOKEN_URL: `${url}/open-apis/authen/v2/oauth/token`, WM_FEISHU_USERINFO_URL: `${url}/open-apis/authen/v1/user_info` },
    as(person) { who = person; },
    mode(name) { if (!(name in MODES)) throw new Error(`没有这种模式：${name}`); mode = name; },
    calls,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

#!/usr/bin/env node
/** layerfs 服务替身（契约 v0·#94 P0）。市场侧真调用闸的对手方——按 docs/layerfs-service-contract-v0.md
 *  实现全端点，供 sandbox/layerfs 冒烟验证「市场这一侧」。真服务=P0 Dockerfile 构建物（钉 9f97a7ec）。 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

export function startSubstitute(opts = {}) {
  const token = opts.token ?? 'lfs-test-token';
  const state = new Map(); // project → { commits:[{id, files}], head }
  const hits = []; // 全请求记录（判据用）
  let failNextPublish = false; // 测 L4/L7 用（可外部置位）

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(s)) });
    res.end(s);
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
  const auth = (req) => String(req.headers.authorization ?? '') === `Bearer ${token}`;

  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    hits.push({ method: req.method, url, authorized: auth(req) });
    if (!auth(req)) return json(res, 401, { error: 'unauthorized' });
    // POST /v0/projects/{project}/publish
    const pubM = /^\/v0\/projects\/([^/]+)\/publish$/.exec(url);
    if (req.method === 'POST' && pubM) {
      const project = decodeURIComponent(pubM[1]);
      if (failNextPublish) { failNextPublish = false; return json(res, 500, { error: 'boom' }); }
      const body = await readBody(req);
      const files = Array.isArray(body.files) ? body.files : [];
      const st = state.get(project) ?? { commits: [], head: null };
      const key = JSON.stringify(files);
      const last = st.head ? st.commits.find((c) => c.id === st.head) : null;
      if (last && JSON.stringify(last.files) === key) return json(res, 200, { commit_id: st.head, changed: false });
      const id = 'c' + randomBytes(6).toString('hex');
      st.commits.push({ id, files, message: String(body.message ?? '') });
      st.head = id;
      state.set(project, st);
      return json(res, 200, { commit_id: id, changed: true });
    }
    // GET /v0/projects/{project}/commits/{id}/files
    const cfM = /^\/v0\/projects\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (req.method === 'GET' && cfM) {
      const st = state.get(decodeURIComponent(cfM[1]));
      const c = st?.commits.find((x) => x.id === cfM[2]);
      if (!c) return json(res, 404, { error: 'no such commit' });
      return json(res, 200, { files: c.files });
    }
    // drafts 面（简化：draft=id+from；apply 直接新 commit；merge 同路径冲突 409）
    const drM = /^\/v0\/projects\/([^/]+)\/drafts$/.exec(url);
    if (req.method === 'POST' && drM) {
      const body = await readBody(req);
      return json(res, 200, { draft: 'd' + randomBytes(4).toString('hex'), from: String(body.from ?? '') });
    }
    const apM = /^\/v0\/projects\/([^/]+)\/drafts\/([^/]+)\/apply$/.exec(url);
    if (req.method === 'POST' && apM) {
      const project = decodeURIComponent(apM[1]);
      const body = await readBody(req);
      const st = state.get(project) ?? { commits: [], head: null };
      const id = 'c' + randomBytes(6).toString('hex');
      const prev = st.head ? st.commits.find((c) => c.id === st.head) : null;
      const files = (prev?.files ?? []).slice();
      st.commits.push({ id, files, message: String(body.message ?? '') });
      st.head = id;
      state.set(project, st);
      return json(res, 200, { commit_id: id });
    }
    const mgM = /^\/v0\/projects\/([^/]+)\/drafts\/([^/]+)\/merge$/.exec(url);
    if (req.method === 'POST' && mgM) {
      // 简化冲突：第二次 merge 同项目 → 409（冒烟按序造冲突）
      const project = decodeURIComponent(mgM[1]);
      const st = state.get(project);
      const merged = (st?.commits ?? []).filter((c) => c.message.startsWith('draft-merge-'));
      if (merged.length >= 1) return json(res, 409, { kind: 'Conflict', conflicts: ['index.html'] });
      const id = 'c' + randomBytes(6).toString('hex');
      (st ?? (state.set(project, { commits: [], head: null }), state.get(project))).commits.push({ id, files: [], message: 'draft-merge-1' });
      state.get(project).head = id;
      return json(res, 200, { commit_id: id });
    }
    // DELETE /v0/projects/{project}
    const delM = /^\/v0\/projects\/([^/]+)$/.exec(url);
    if (req.method === 'DELETE' && delM) {
      state.delete(decodeURIComponent(delM[1]));
      return json(res, 200, { removed: true });
    }
    // POST /v0/dispatch
    if (req.method === 'POST' && url === '/v0/dispatch') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, commit_hash: 'c0ffee' + randomBytes(3).toString('hex'), exit_code: 0, stdout_tail: 'ok', stderr_tail: '', duration_ms: 5, run_id: body.run_id });
    }
    return json(res, 404, { error: 'not found', url });
  });

  return {
    state, hits,
    setFailNextPublish(v) { failNextPublish = v; },
    listen(port = 0) { return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))); },
    close() { return new Promise((r) => server.close(() => r())); },
    url() { return `http://127.0.0.1:${server.address().port}`; },
  };
}

// 直接运行时：独立起服务（默认 9867）
if (process.argv[1] && process.argv[1].endsWith('layerfs-substitute.mjs')) {
  const port = Number(process.env.LAYERFS_SUBSTITUTE_PORT ?? 9867);
  const s = startSubstitute({ token: process.env.LAYERFS_SERVICE_TOKEN ?? 'lfs-test-token' });
  await s.listen(port);
  console.log('[layerfs-substitute] 契约 v0 全端点:', s.url());
}

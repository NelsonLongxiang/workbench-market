/** 测试替身：本机假 GitHub API（只实现市场同步用到的三个读端点）+ 发布助手。
 *  属主 2026-11-02 来源收敛后，自产台/SOP 台只能从 GitHub 仓库 main 同步；测试把文件放进替身仓库，再调 /api/apps/<slug>/sync。
 *  用法：const gh = await startFakeGithub(); 起服务时 env.WM_GITHUB_API = gh.api；
 *        await ghPublish(base, gh, { slug, title, files, kind?, ... }, headers?) —— 返回 fetch Response，形状同原 POST /api/apps。 */
import http from 'node:http';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

export async function startFakeGithub() {
  const repos = new Map(); // repo -> { commit, files: Map<path, content> }
  const blobs = new Map(); // sha -> content
  const commits = new Map(); // commit -> repo
  let seq = 0;
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: u.pathname, auth: req.headers.authorization ?? '' });
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    // 测试写口（非 GitHub 接口）：PUT /__fixture/repos/<owner>/<repo>?dir=<子目录> body {files}——给 Python E2E 等外部进程提交文件
    let m = u.pathname.match(/^\/__fixture\/repos\/([^/]+\/[^/]+)$/);
    if (m && req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { send(200, { commit: commit(decodeURIComponent(m[1]), JSON.parse(raw).files ?? [], u.searchParams.get('dir') ?? '') }); }
        catch (e) { send(400, { message: String(e) }); }
      });
      return;
    }
    m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)$/);
    if (m) {
      const r = repos.get(decodeURIComponent(m[1]));
      if (!r || m[2] !== 'main') return send(404, { message: 'Not Found' });
      return send(200, { sha: r.commit });
    }
    m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/trees\/([0-9a-f]{40})$/);
    if (m) {
      const repo = decodeURIComponent(m[1]);
      const r = repos.get(repo);
      if (!r || commits.get(m[2]) !== repo) return send(404, { message: 'Not Found' });
      const snap = r.history.get(m[2]);
      return send(200, { sha: m[2], truncated: false, tree: [...snap.entries()].map(([path, content]) => ({ path, type: 'blob', sha: sha1('blob:' + content), size: Buffer.byteLength(content) })) });
    }
    m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([0-9a-f]{40})$/);
    if (m) {
      const c = blobs.get(m[2]);
      if (c === undefined) return send(404, { message: 'Not Found' });
      return send(200, { sha: m[2], encoding: 'base64', content: Buffer.from(c, 'utf8').toString('base64') });
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  /** 在 repo 的 main 上提交一版：files=[{path,content}]，dir 为子目录（集中仓库每台一个目录）；同仓库其它目录保留 */
  function commit(repo, files, dir = '') {
    const prev = repos.get(repo);
    const tree = new Map(prev ? prev.files : []);
    const prefix = dir ? dir.replace(/^\/+|\/+$/g, '') + '/' : '';
    for (const k of [...tree.keys()]) if (prefix ? k.startsWith(prefix) : true) tree.delete(k);
    for (const f of files) { const p = prefix + f.path; tree.set(p, f.content); blobs.set(sha1('blob:' + f.content), f.content); }
    const c = sha1(`${repo}:${++seq}:${Date.now()}`);
    const history = prev ? prev.history : new Map();
    history.set(c, new Map(tree));
    repos.set(repo, { commit: c, files: tree, history });
    commits.set(c, repo);
    return c;
  }
  return { api, commit, requests, close: () => new Promise((r) => server.close(r)) };
}

/** 原 POST /api/apps 的替代：文件进替身仓库 fixture/<slug> 的 main，再同步。body 的 files 之外的字段原样转给 sync。 */
export async function ghPublish(base, gh, body, headers = {}) {
  const { files, slug, source_repo, source_path, ...rest } = body;
  const repo = source_repo ?? `fixture/${slug}`;
  if (Array.isArray(files)) gh.commit(repo, files, source_path ?? '');
  return fetch(`${base}/api/apps/${encodeURIComponent(slug)}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ ...rest, source_repo: repo, ...(source_path ? { source_path } : {}) }),
  });
}

/**
 * 录制回放用的夹具（--import 预加载）：在市场进程里起一个假的 LayerFS 服务（只听 127.0.0.1），把 LAYERFS_SERVICE_URL、LAYERFS_SERVICE_TOKEN 指过去。
 * 只实现市场的台这一侧用到的三个端点（契约 v1）：
 *   POST   /v1/projects/<项目>/branches/<分支>/publish            → { commit_id, changed }
 *   GET    /v1/projects/<项目>/branches/<分支>/commits/<id>/files  → { files }
 *   DELETE /v1/projects/<项目>                                    → 200；没有这个项目 404
 * commit_id 由「项目、分支、文件」算出来，每次都一样（scripts/layerfs-substitute.mjs 用随机数，录不下来）。
 * 项目名里带 lfs-fail 的，发布和删除都回 500（录「远端失败、本地不动」）；带 lfs-drift 的，按 commit 取回的文件每个内容后面多一个换行
 * （录「对账不一致」）。令牌不对回 401。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把 LayerFS 指到假的上。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

if (process.env.NODE_ENV !== 'test') {
  console.error('[layerfs-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const TOKEN = 'replay-synthetic-layerfs-token-0123456789';
const projects = new Map(); // 项目 → Map(commit_id → files)
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });
    const url = req.url ?? '';
    let m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/publish$/.exec(url);
    if (m && req.method === 'POST') {
      const project = decodeURIComponent(m[1]);
      if (project.includes('lfs-fail')) return send(res, 500, { error: 'boom' });
      let files;
      try { files = JSON.parse(raw).files; } catch { return send(res, 400, { error: 'bad json' }); }
      const id = 'c' + createHash('sha256').update(`${project}\n${decodeURIComponent(m[2])}\n${JSON.stringify(files)}`).digest('hex').slice(0, 16);
      const commits = projects.get(project) ?? new Map();
      const changed = !commits.has(id);
      commits.set(id, files);
      projects.set(project, commits);
      return send(res, 200, { commit_id: id, changed });
    }
    m = /^\/v1\/projects\/([^/]+)\/branches\/([^/]+)\/commits\/([^/]+)\/files$/.exec(url);
    if (m && req.method === 'GET') {
      const files = projects.get(decodeURIComponent(m[1]))?.get(decodeURIComponent(m[3]));
      if (!files) return send(res, 404, { error: 'no such commit' });
      const drift = decodeURIComponent(m[1]).includes('lfs-drift');
      return send(res, 200, { files: drift ? files.map((f) => ({ ...f, content: `${f.content}\n` })) : files });
    }
    m = /^\/v1\/projects\/([^/]+)$/.exec(url);
    if (m && req.method === 'DELETE') {
      const project = decodeURIComponent(m[1]);
      if (project.includes('lfs-fail')) return send(res, 500, { error: 'boom' });
      return projects.delete(project) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such project' });
    }
    send(res, 404, { error: 'not found' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
process.env.LAYERFS_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
process.env.LAYERFS_SERVICE_TOKEN = TOKEN;

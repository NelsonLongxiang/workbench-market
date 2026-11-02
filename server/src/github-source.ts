/** 自产台来源收敛（属主 2026-11-02）：非挂载类工作台（market-app 自产台与 SOP 台）只接受 GitHub 仓库 main 分支。
 *  - 来源 = owner/repo + 可选子目录（集中仓库每台一个目录，或每台一个独立仓库）；分支写死 main，不收参数。
 *  - 市场主动拉：commits/main 取头 sha → git/trees 递归列文件 → git/blobs 取内容；版本记下 commit sha。
 *  - WM_GITHUB_TOKEN（可选）读私有仓库；WM_GITHUB_API 只给测试指向本机替身，缺省 https://api.github.com。 */
import { posix } from 'node:path';

export const SOURCE_BRANCH = 'main';
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class SourceError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** 规范化来源；非法一律 400。path 为空串表示仓库根。 */
export function normalizeSource(repo: unknown, path: unknown): { repo: string; path: string } {
  const r = String(repo ?? '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_RE.test(r) || r.endsWith('/.') || r.endsWith('/..')) throw new SourceError(400, `source_repo 必须是 GitHub 仓库 owner/repo（得: ${String(repo ?? '')}）`);
  const raw = String(path ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (raw === '') return { repo: r, path: '' };
  const p = posix.normalize(raw);
  if (p === '.' || p.startsWith('..') || p.includes('/../') || p.length > 200) throw new SourceError(400, `source_path 非法: ${String(path)}`);
  return { repo: r, path: p };
}

function apiBase(): string {
  return (process.env.WM_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}

async function gh(url: string): Promise<any> {
  const token = process.env.WM_GITHUB_TOKEN || '';
  let res: Response;
  try {
    res = await fetch(apiBase() + url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'workbench-market', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
    });
  } catch (e) {
    throw new SourceError(502, `GitHub 不可达：${String((e as Error)?.message ?? e)}`);
  }
  if (res.status === 404) throw new SourceError(404, 'GitHub 仓库或 main 分支不存在（私有仓库需配置 WM_GITHUB_TOKEN）');
  if (!res.ok) throw new SourceError(502, `GitHub HTTP ${res.status}`);
  return res.json();
}

/** 取 main 头的文件集（只取 source_path 目录下的文件，路径相对该目录）。 */
export async function fetchMainFiles(repo: string, path: string): Promise<{ commit: string; files: { path: string; content: string }[] }> {
  const enc = repo.split('/').map(encodeURIComponent).join('/');
  const head = await gh(`/repos/${enc}/commits/${SOURCE_BRANCH}`);
  const commit = String(head?.sha ?? '');
  if (!SHA_RE.test(commit)) throw new SourceError(502, 'GitHub 未返回 main 头 commit');
  const tree = await gh(`/repos/${enc}/git/trees/${commit}?recursive=1`);
  if (tree?.truncated) throw new SourceError(400, '仓库文件树过大（GitHub 截断）——请把台放进更小的仓库或子目录');
  const prefix = path ? path + '/' : '';
  const blobs = (Array.isArray(tree?.tree) ? tree.tree : []).filter((e: any) => e?.type === 'blob' && typeof e.path === 'string' && e.path.startsWith(prefix));
  if (!blobs.length) throw new SourceError(400, `main@${commit.slice(0, 7)} 的 ${path || '仓库根'} 下没有文件`);
  if (blobs.length > MAX_FILES) throw new SourceError(400, `文件数 ${blobs.length} 超过上限 ${MAX_FILES}`);
  const files: { path: string; content: string }[] = [];
  for (const e of blobs) {
    if (typeof e.size === 'number' && e.size > MAX_FILE_BYTES) throw new SourceError(400, `${e.path} 超过单文件 2MB 上限`);
    const b = await gh(`/repos/${enc}/git/blobs/${encodeURIComponent(String(e.sha))}`);
    if (b?.encoding !== 'base64' || typeof b.content !== 'string') throw new SourceError(502, `${e.path} blob 编码异常`);
    const buf = Buffer.from(b.content, 'base64');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { throw new SourceError(400, `${e.path} 不是 UTF-8 文本（自产台只收文本文件）`); }
    files.push({ path: e.path.slice(prefix.length), content });
  }
  return { commit, files };
}

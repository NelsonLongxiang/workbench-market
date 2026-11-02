"""测试替身助手（Python 侧）：自产台 / SOP 台只接受 GitHub 仓库 main（属主 2026-11-02 来源收敛）。

原来 POST /api/apps 带 files 的测试发布，改为两步：
  1) PUT <E2E_FAKE_GITHUB>/__fixture/repos/fixture/<slug>  把文件提交进替身仓库 main（scripts/github-fixture.mjs 的写口）；
  2) POST /api/apps/<slug>/sync  {source_repo: 'fixture/<slug>', ...其余字段}。
E2E_FAKE_GITHUB 由跑器（scripts/e2e-full-run.mjs）起替身后注入；只认本机回环地址——没有替身就报清楚的错，绝不向别处写。
用法：path, payload = sync_request(body)  —— 先提交 body['files'] 进替身，再返回 sync 的路径与请求体，调用方用自己的 HTTP 客户端发。
"""
import json
import os
import re
import urllib.request
from urllib.parse import quote

_LOOPBACK = re.compile(r'^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}$')


class FakeGithubMissing(RuntimeError):
    pass


def fake_github_api():
    api = os.environ.get('E2E_FAKE_GITHUB', '').strip().rstrip('/')
    if not api:
        raise FakeGithubMissing('缺 E2E_FAKE_GITHUB：自产台/SOP 台只能从 GitHub main 同步，测试须由跑器起本机替身（scripts/github-fixture.mjs）并注入地址')
    if not _LOOPBACK.match(api):
        raise FakeGithubMissing(f'E2E_FAKE_GITHUB 必须是本机回环替身地址（得: {api}）')
    return api


def commit(repo, files, dir=''):
    """把 files=[{path,content}] 提交到替身仓库 repo 的 main，返回 commit sha。"""
    api = fake_github_api()
    url = f"{api}/__fixture/repos/{quote(repo, safe='/')}" + (f"?dir={quote(dir)}" if dir else '')
    req = urllib.request.Request(url, method='PUT', data=json.dumps({'files': files}).encode(),
                                 headers={'Content-Type': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=10) as r:
        return json.loads(r.read().decode())['commit']


def sync_request(body):
    """原 POST /api/apps body → (sync 路径, sync 请求体)。files 先进替身仓库 fixture/<slug>（或 body 给的 source_repo）。"""
    body = dict(body)
    files = body.pop('files', None)
    slug = str(body.pop('slug', ''))
    repo = body.pop('source_repo', None) or f'fixture/{slug}'
    src_path = body.pop('source_path', '') or ''
    if files is not None:
        commit(repo, files, src_path)
    payload = {**body, 'source_repo': repo}
    if src_path:
        payload['source_path'] = src_path
    return f'/api/apps/{quote(slug, safe="")}/sync', payload

#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""演示 SOP 常驻发布（幂等）：demo-rack-sop 发布+上架。"""
import json
import sys
import urllib.error
import urllib.request

import os
import argparse
import re
from urllib.parse import urlsplit

# Validate before constructing an opener or sending any HTTP request.
parser = argparse.ArgumentParser(description='Publish demo SOP to an explicitly selected target', allow_abbrev=False)
parser.add_argument('--target-mode', required=True, choices=('isolated', 'production'))
parser.add_argument('--ack-production-target', action='store_true')
args = parser.parse_args()
raw = os.environ.get('SEED_BASE', '')
match = re.fullmatch(r'(https?)://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})/?', raw)
if not match:
    parser.error('SEED_BASE must be an explicit http(s) origin with port; no credentials/path/query/fragment')
try:
    target = urlsplit(raw)
    port = target.port
    if not port or port > 65535:
        raise ValueError('invalid port')
except ValueError:
    parser.error('invalid target origin')
if args.target_mode == 'isolated':
    if match.group(2).lower() not in ('127.0.0.1', 'localhost', '[::1]') or port in (3080, 9800, 9801):
        parser.error('isolated target must use canonical loopback and a non-production port')
elif not args.ack_production_target:
    parser.error('production target requires --ack-production-target; this flag is not owner authorization')
BASE = raw.rstrip('/')

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
sop_yaml = """title: 服务器上架标准流程（演示）
code: SOP-DEMO-001
description: 演示用 SOP：开箱检查 → 上架固定 → 通电自检，展示 Runner 执行与分层持久化
steps:
  - key: prepare
    title: 开箱检查
    body: |
      <p>核对配件清单与外观：</p>
      <p>配件数：<input data-field="配件数" placeholder="如 6"></p>
      <p>外观异常：<select data-field="外观"><option value="无">无</option><option value="有">有</option></select></p>
  - key: rack
    title: 上架固定
    body: |
      <p>机位编号与固定方式：</p>
      <p>机位：<input data-field="机位" placeholder="如 A-12"></p>
      <p>螺丝扭矩复核：<select data-field="扭矩复核"><option value="已复核">已复核</option><option value="未复核">未复核</option></select></p>
  - key: power
    title: 通电自检
    body: |
      <p>上电后确认指示灯与风扇：</p>
      <p>自检结果：<select data-field="自检"><option value="通过">通过</option><option value="不通过">不通过</option></select></p>
      <p>备注：<input data-field="备注" placeholder="可选"></p>
"""


def call(method: str, path: str, body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json'})
    try:
        with opener.open(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise RuntimeError('target_redirect_refused') from None
        return e.code, json.loads(e.read().decode() or '{}')


s, b = call('POST', '/api/apps', {
    'slug': 'demo-rack-sop', 'kind': 'sop', 'title': '服务器上架标准流程（演示）',
    'code': 'SOP-DEMO-001', 'created_by': 'seed', 'changelog': '演示 SOP 常驻：三步上架流程样例',
    'files': [{'path': 'sop.yaml', 'content': sop_yaml}],
})
print('publish:', s, 'v', b.get('version'), b.get('status'))
if s not in (200, 201):
    print(json.dumps(b, ensure_ascii=False)); sys.exit(1)

s2, b2 = call('POST', '/api/sops/demo-rack-sop/publish', {'note': '演示常驻'})
if s2 == 409:
    print('already published (409 ok)')
else:
    print('publish-state:', s2, b2.get('status'), 'wid=', b2.get('workbench_id'))

s3, b3 = call('GET', '/api/apps/demo-rack-sop')
print('final:', b3.get('status'), 'v', b3.get('active_version'), 'wid', b3.get('workbench_id'))
assert b3.get('status') == 'published', 'demo sop not published'
print('OK demo-rack-sop published')

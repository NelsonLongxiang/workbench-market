"""本地预览：/new|old/apps/<slug>/<path> 用本地改前/改后文件，其余只读转发生产（POST 一律拒绝）。"""
import http.server, mimetypes, re, sys, urllib.request
from pathlib import Path
ROOT, UP = Path(sys.argv[1]), 'http://100.75.181.127:9800'

def local(mode, slug, rel):
    rel = rel or 'index.html'
    if mode == 'new': p = ROOT / 'out' / slug / rel
    else: p = ROOT / 'apps' / (slug + '.html') if rel == 'index.html' else ROOT / 'extra' / slug / rel
    return p if p.is_file() else None

class H(http.server.BaseHTTPRequestHandler):
    def send(self, code, ctype, body):
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/__audit.js': return self.send(200, 'text/javascript', (ROOT / 'audit.js').read_bytes())
        m = re.match(r'^/(new|old)/apps/([\w-]+)/(.*)$', path)
        if m:
            mode, slug, rel = m.groups()
            p = local(mode, slug, rel)
            if p is None: return self.proxy('/apps/' + slug + '/' + rel + (('?' + self.path.split('?', 1)[1]) if '?' in self.path else ''))
            body = p.read_bytes()
            if p.suffix == '.html':
                inj = re.search(rb'<meta name="wm-app-token".*?</script>', (ROOT / 'apps' / (slug + '.html')).read_bytes(), re.S)
                head = (inj.group(0) if inj else b'') + b'<script src="/__audit.js"></script>'
                body = re.sub(rb'<head[^>]*>', lambda h: h.group(0) + head, body, count=1) if mode == 'new' else re.sub(rb'<head[^>]*>', lambda h: h.group(0) + b'<script src="/__audit.js"></script>', body, count=1)
            return self.send(200, (mimetypes.guess_type(p.name)[0] or 'text/plain') + '; charset=utf-8', body)
        self.proxy(self.path)
    def proxy(self, path):
        try:
            r = urllib.request.urlopen(UP + path, timeout=20)
            self.send(r.status, r.headers.get('Content-Type', 'application/octet-stream'), r.read())
        except urllib.error.HTTPError as e: self.send(e.code, 'text/plain', e.read())
        except Exception: self.send(502, 'text/plain', b'bad gateway')
    def do_POST(self): self.send(403, 'text/plain', b'preview is read-only')
    def log_message(self, *a): pass

http.server.ThreadingHTTPServer(('127.0.0.1', 8791), H).serve_forever()

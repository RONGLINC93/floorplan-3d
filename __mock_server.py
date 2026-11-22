"""临时 mock 服务：serve app/www + /api/plans，端口 8932。"""
import http.server
import json
import os
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app', 'www')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path == '/api/plans':
            body = json.dumps([{'name': 'T6', 'mtime': 0}]).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if p.path.startswith('/api/plans/'):
            name = urllib.parse.unquote(p.path[len('/api/plans/'):])
            if name.endswith('/thumbnail'):
                self.send_response(404); self.end_headers(); return
            fn = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'plans', name + '.json')
            if not os.path.isfile(fn):
                self.send_response(404); self.end_headers(); return
            with open(fn, 'rb') as f:
                body = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 8932), Handler).serve_forever()

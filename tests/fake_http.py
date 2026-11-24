"""A fake service over real HTTP, for the clients' tests: handle(method, path, headers, body) answers
(status, JSON answer), (status, text, content type), or (status, text, content type, extra headers)."""
import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


@contextmanager
def serving(handle):
    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            status, answer, *kind = handle(self.command, self.path, dict(self.headers), body)
            data = answer.encode() if kind else json.dumps(answer).encode()
            self.send_response(status)
            for key, value in (kind[1] if len(kind) > 1 else {}).items():
                self.send_header(key, value)
            self.send_header("Content-Type", kind[0] if kind else "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()

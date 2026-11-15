"""Local preview: copies the app into _site/ (next to the data built by build_data.py) and serves it.
   python tools/build_data.py --out _site/data     (once, or to refresh prices)
   python tools/preview.py                          -> http://127.0.0.1:8090
"""
import functools
import http.server
import os
import shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SITE = os.path.join(ROOT, "_site")
SKIP = {"tools", "seed", "_site", ".github", ".git", "README.md", "deploy.bat", ".gitignore"}

os.makedirs(SITE, exist_ok=True)
for name in os.listdir(ROOT):
    if name in SKIP:
        continue
    src, dst = os.path.join(ROOT, name), os.path.join(SITE, name)
    if os.path.isdir(src):
        shutil.copytree(src, dst, dirs_exist_ok=True)
    else:
        shutil.copy2(src, dst)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


Handler.extensions_map[".webmanifest"] = "application/manifest+json"
Handler.extensions_map[".js"] = "text/javascript"
print("Preview at http://127.0.0.1:8090")
http.server.ThreadingHTTPServer(("127.0.0.1", 8090), functools.partial(Handler, directory=SITE)).serve_forever()

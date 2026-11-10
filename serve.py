#!/usr/bin/env python3
"""
serve.py — 本地开发用静态服务器

与 `python -m http.server` 的区别只有一点：**强制禁用 HTTP 缓存**。

原因：本站是免构建的原生 ES Module + importmap，浏览器（尤其 Chrome）
会对 `js/*.js` 做启发式缓存。改完代码后如果不硬刷新，Chrome 可能继续跑
旧模块；一旦旧模块 import 了已被删除/改名的文件，整个模块图会在解析阶段
就断掉，页面表现为「启动画面一直停在 INITIALIZING…」，且只有 Console 有报错。

用法：
    python serve.py            # 127.0.0.1:8123
    python serve.py 9000       # 指定端口
"""
import sys
import http.server

DEFAULT_PORT = 8123


class Handler(http.server.SimpleHTTPRequestHandler):
    # 补齐 MIME，避免 .wasm / .glb 被当成 octet-stream（Draco 与 GLTFLoader 依赖）
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
        '.glb': 'model/gltf-binary',
        '.gltf': 'model/gltf+json',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):  # 静音，避免刷屏
        pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler) as httpd:
        print(f'serving http://127.0.0.1:{port}/ (no-cache)')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()

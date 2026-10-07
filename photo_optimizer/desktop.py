"""PC 프로그램: 내 컴퓨터에서만 접근 가능한 서버를 띄우고 창으로 연다.

사진은 외부로 전송되지 않는다. pywebview가 있으면 독립 창, 없으면 기본 브라우저로 연다.
"""
from __future__ import annotations

import socket
import threading
import time
import webbrowser

import uvicorn

from photo_optimizer.app import app


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> None:
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()
    while not server.started:
        time.sleep(0.05)
    url = f"http://127.0.0.1:{port}/"

    try:
        import webview
    except ImportError:
        webbrowser.open(url)
        print(f"Photo Optimizer 실행 중: {url}  (종료하려면 Ctrl+C)")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        webview.create_window("Photo Optimizer", url, width=860, height=760)
        webview.start()
    server.should_exit = True


if __name__ == "__main__":
    main()

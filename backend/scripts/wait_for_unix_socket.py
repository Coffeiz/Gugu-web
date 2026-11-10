"""等待本地 Unix socket 开始接受连接，供 systemd sidecar 启动依赖使用。"""
from __future__ import annotations

import argparse
import socket
import time


def wait_for_unix_socket(path: str, timeout_seconds: float = 5.0) -> None:
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while True:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(0.2)
        try:
            client.connect(path)
            return
        except OSError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Unix socket 在启动时限内未就绪") from None
            time.sleep(min(0.1, remaining))
        finally:
            client.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()
    wait_for_unix_socket(args.path, args.timeout)


if __name__ == "__main__":
    main()

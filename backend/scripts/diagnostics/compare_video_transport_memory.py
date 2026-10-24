"""合成视频旧内联/新文件引用内存对照；不连接真实模型、数据库或存储。"""
from __future__ import annotations

import argparse
import asyncio
import base64
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import resource
import struct
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import patch


async def measure(mode: str, paths: list[str]) -> dict:
    import httpx
    from agent.context.canonical_context import digest
    from agent.media import gates, video
    from agent.media.video_source import prepare_video_path
    from agent.providers.minimax.media import M3_MEDIA_LIMITS

    config = SimpleNamespace(provider="minimax", model="MiniMax-M3", api_format="anthropic",
                             base_url="https://example.invalid/anthropic", api_key="synthetic", video=True)
    streamed = 0
    largest_chunk = 0

    class StreamingReceiver(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            nonlocal streamed, largest_chunk
            async for chunk in request.stream:
                streamed += len(chunk)
                largest_chunk = max(largest_chunk, len(chunk))
            return httpx.Response(200, json={"file": {"file_id": "synthetic-file"}})

    client = httpx.AsyncClient

    def local_client(**kwargs):
        return client(transport=StreamingReceiver(), **kwargs)

    start = time.monotonic()
    if mode == "inline":
        limits = replace(M3_MEDIA_LIMITS, base64_max=45 * 1024 * 1024, prefer_file_upload=False)
        with patch.object(gates, "media_limits_for", return_value=limits):
            media = [await video.prepare_video_media(Path(p).read_bytes(), "video/mp4", "synthetic.mp4",
                     config, probe={"duration": 1}, duration=1) for p in paths]
        hashes = [hashlib.sha256(base64.b64decode(item["b64"])).hexdigest() for item in media]
    else:
        with patch.object(httpx, "AsyncClient", local_client):
            media = await asyncio.gather(*[
                prepare_video_path(p, "video/mp4", "synthetic.mp4", config, probe={"duration": 1})
                for p in paths
            ])
        hashes = []
    payload = {"messages": [{"role": "user", "content": media}]}
    fingerprint = digest(payload)
    # 模拟 trace/请求 JSON 的全量编码；不向真实 Collector 提交合成内容。
    encoded = json.dumps(payload, ensure_ascii=False).encode()
    return {"mode": mode, "files": len(paths), "rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 2),
            "seconds": round(time.monotonic() - start, 3), "json_bytes": len(encoded),
            "upload_bytes": streamed, "max_upload_chunk": largest_chunk,
            "digest": fingerprint, "inline_source_hashes": hashes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--child", choices=["inline", "reference"])
    parser.add_argument("--paths", nargs="*")
    parser.add_argument("--rounds", type=int, default=3)
    args = parser.parse_args()
    if args.child:
        print(json.dumps(asyncio.run(measure(args.child, args.paths))))
        return
    with tempfile.TemporaryDirectory(prefix="gugu-video-ab-") as directory:
        root = Path(directory)
        seed = root / "seed.mp4"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                        "color=c=red:s=64x64:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(seed)], check=True)
        paths = []
        for size in (40, 44):
            path = root / f"synthetic-{size}.mp4"
            original = seed.read_bytes()
            with path.open("wb") as target:
                target.write(original)
                remaining = size * 1024 * 1024 - len(original)
                # 合法 MP4 free box，增加体积而不改变视频画面与时长。
                target.write(struct.pack(">I4s", remaining, b"free"))
                target.truncate(size * 1024 * 1024)
            subprocess.run(["ffprobe", "-v", "error", str(path)], check=True)
            paths.append(str(path))
        for count, selected in ((1, paths[:1]), (2, paths), (4, paths * 2)):
            for iteration in range(args.rounds):
                for mode in (("inline", "reference") if iteration % 2 == 0 else ("reference", "inline")):
                    proc = subprocess.Popen([sys.executable, __file__, "--child", mode, "--paths", *selected],
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    started = time.monotonic()
                    safety_stop = False
                    while proc.poll() is None:
                        try:
                            status = Path(f"/proc/{proc.pid}/status").read_text()
                            rss_kib = next((int(line.split()[1]) for line in status.splitlines()
                                            if line.startswith("VmRSS:")), 0)
                            if rss_kib > 768 * 1024 or time.monotonic() - started > 60:
                                safety_stop = True
                                proc.kill()
                                break
                        except FileNotFoundError:
                            break
                        time.sleep(0.02)
                    output, error = proc.communicate()
                    if safety_stop:
                        result = {"mode": mode, "files": count, "safety_stop": True}
                    elif proc.returncode:
                        raise RuntimeError(f"合成对照子进程失败：{error}")
                    else:
                        result = json.loads(output)
                    result["round"] = iteration + 1
                    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()

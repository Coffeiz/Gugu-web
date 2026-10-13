"""IM 回复中的 Mermaid PNG 渲染与有界子进程管理。"""
from __future__ import annotations

import asyncio
import ctypes
import ctypes.util
import json
import os
import re
import resource
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

_FENCE_RE = re.compile(r"```mermaid[ \t]*\r?\n[\s\S]*?```", re.IGNORECASE)
_OPEN_RE = re.compile(r"```mermaid[ \t]*\r?\n", re.IGNORECASE)
_SOURCE_RE = re.compile(r"^```mermaid[ \t]*\r?\n([\s\S]*?)```$", re.IGNORECASE)
_RENDER_LIMIT = asyncio.Semaphore(1)
MAX_DIAGRAMS = 3
MAX_SOURCE_CHARS = 20_000
MAX_PNG_BYTES = 3 * 1024 * 1024
RENDER_TIMEOUT_SECONDS = 10
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class ReplyPart:
    text: str = ""
    png: bytes | None = None
    source: str = ""
    placeholder_emitted: bool = False


def _apply_network_seccomp() -> None:
    """拒绝 socket 系统调用；过滤器由 exec 后的 Node worker 继承。"""
    library = ctypes.util.find_library("seccomp")
    if not library:
        raise RuntimeError("seccomp_unavailable")
    seccomp = ctypes.CDLL(library, use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_rule_add.restype = ctypes.c_int
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_load.restype = ctypes.c_int
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.restype = None

    context = seccomp.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError("seccomp_init_failed")
    try:
        denied = 0x00050000 | 1  # SCMP_ACT_ERRNO(EPERM)
        for name in (
            b"socket", b"socketpair", b"connect", b"bind", b"listen", b"accept",
            b"accept4", b"sendto", b"recvfrom", b"sendmsg", b"recvmsg",
        ):
            syscall = seccomp.seccomp_syscall_resolve_name(name)
            if syscall >= 0 and seccomp.seccomp_rule_add(context, denied, syscall, 0) != 0:
                raise RuntimeError("seccomp_rule_failed")
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError("seccomp_load_failed")
    finally:
        seccomp.seccomp_release(context)


def _sandbox_exec(worker: str) -> None:
    """在 Python 启动器内设资源上限和禁网过滤，再替换成 Node。"""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node_unavailable")
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PNG_BYTES, MAX_PNG_BYTES))
    _apply_network_seccomp()
    os.execv(node, [node, "--max-old-space-size=192", worker])


async def render_pngs(sources: list[str]) -> list[bytes | None]:
    """在一个受限 Node 子进程中批量渲染单轮图表，避免重复冷启动。"""
    from app.core.redaction import diag_log_raw

    if not sources:
        return []
    if len(sources) > MAX_DIAGRAMS:
        return [None] * len(sources)
    results: list[bytes | None] = [None] * len(sources)
    valid = [
        (index, source) for index, source in enumerate(sources)
        if source and len(source) <= MAX_SOURCE_CHARS
    ]
    if not valid:
        return results
    backend_root = Path(__file__).resolve().parents[2]
    worker = backend_root / "ts" / "workers" / "mermaid-renderer" / "worker.mjs"
    if not worker.is_file():
        worker = backend_root / "bin" / "gugu-mermaid-worker.mjs"
    if not worker.is_file():
        return results
    try:
        input_bytes = json.dumps(
            [source for _index, source in valid], ensure_ascii=False
        ).encode("utf-8")
    except UnicodeEncodeError:
        return results
    async with _RENDER_LIMIT:
        started = time.monotonic()
        process = None
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(Path(__file__).resolve()),
                "--sandbox-exec",
                str(worker),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            stdout, _ = await asyncio.wait_for(
                process.communicate(input_bytes),
                timeout=RENDER_TIMEOUT_SECONDS,
            )
            if process.returncode != 0:
                diag_log_raw("agent.im.mermaid.render", "status=worker_failed")
                return results
            rendered: list[bytes | None] = []
            offset = 0
            for _index, _source in valid:
                if len(stdout) - offset < 4:
                    raise ValueError("invalid_worker_frame")
                size = int.from_bytes(stdout[offset:offset + 4], "big")
                offset += 4
                if size == 0:
                    rendered.append(None)
                    continue
                if size > MAX_PNG_BYTES or len(stdout) - offset < size:
                    raise ValueError("invalid_worker_png_size")
                png = stdout[offset:offset + size]
                offset += size
                if not png.startswith(PNG_SIGNATURE):
                    raise ValueError("invalid_worker_png")
                rendered.append(png)
            if offset != len(stdout):
                raise ValueError("invalid_worker_trailing_data")
            diag_log_raw(
                "agent.im.mermaid.render",
                f"status=ok diagrams={len(valid)} bytes={len(stdout)} "
                f"elapsed_ms={int((time.monotonic() - started) * 1000)}",
            )
            for (index, _source), png in zip(valid, rendered):
                results[index] = png
            return results
        except asyncio.TimeoutError:
            if process and process.returncode is None:
                try:
                    os.killpg(process.pid, 9)
                except ProcessLookupError:
                    pass
                await process.wait()
            diag_log_raw("agent.im.mermaid.render", "status=timeout")
            return results
        except asyncio.CancelledError:
            if process and process.returncode is None:
                try:
                    os.killpg(process.pid, 9)
                except ProcessLookupError:
                    pass
                await process.wait()
            raise
        except Exception as exc:
            diag_log_raw(
                "agent.im.mermaid.render",
                f"status=unavailable error={type(exc).__name__}",
            )
            return results


async def render_png(source: str) -> bytes | None:
    """单图便捷入口；内部仍复用批量 renderer。"""
    return (await render_pngs([source]))[0]


async def render_reply(text: str) -> list[ReplyPart]:
    """解析完整 Mermaid fence，成功时用 PNG part 替换源码，失败时保留源码。"""
    value = text or ""
    matches = [match for match in _FENCE_RE.finditer(value) if _SOURCE_RE.match(match.group(0))]
    sources = [
        _SOURCE_RE.match(match.group(0)).group(1)
        for match in matches[:MAX_DIAGRAMS]
    ]
    pngs = await render_pngs(sources)
    parts: list[ReplyPart] = []
    cursor = 0
    for index, match in enumerate(matches):
        source_block = match.group(0)
        parts.append(ReplyPart(text=value[cursor:match.start()]))
        png = pngs[index] if index < len(pngs) else None
        parts.append(ReplyPart(png=png, source=source_block) if png else ReplyPart(text=source_block))
        cursor = match.end()
    parts.append(ReplyPart(text=value[cursor:]))
    return [part for part in parts if part.text or part.png]


class StreamingRenderer:
    """只暂存 Mermaid fence；普通文本继续流式发送，完整 fence 转为图片事件。"""

    def __init__(self, max_diagrams: int = MAX_DIAGRAMS) -> None:
        self._pending = ""
        self._opening = ""
        self._in_diagram = False
        self._diagram_count = 0
        self._max_diagrams = max(0, min(max_diagrams, MAX_DIAGRAMS))
        self._diagrams: list[tuple[str, str]] = []

    async def feed(self, chunk: str) -> list[ReplyPart]:
        self._pending += chunk or ""
        return await self._drain()

    async def finish_round(self) -> list[ReplyPart]:
        parts = await self._drain(final=True)
        diagrams, self._diagrams = self._diagrams, []
        if diagrams:
            pngs = await render_pngs([body for _source, body in diagrams])
            for (source, _body), png in zip(diagrams, pngs):
                if png:
                    parts.append(ReplyPart(png=png, source=source, placeholder_emitted=True))
                else:
                    parts.append(ReplyPart(text=source))
        self._in_diagram = False
        self._opening = ""
        self._pending = ""
        return parts

    async def _drain(self, *, final: bool = False) -> list[ReplyPart]:
        parts: list[ReplyPart] = []
        while self._pending:
            if not self._in_diagram:
                match = _OPEN_RE.search(self._pending)
                if match:
                    if match.start():
                        parts.append(ReplyPart(text=self._pending[:match.start()]))
                    self._opening = match.group(0)
                    self._pending = self._pending[match.end():]
                    self._in_diagram = True
                    continue
                if final:
                    parts.append(ReplyPart(text=self._pending))
                    self._pending = ""
                    break
                # 保留可能跨 token 边界的 fence 前缀，安全发出其余普通文本。
                hold = min(len(self._pending), len("```mermaid\n") - 1)
                safe_end = len(self._pending) - hold
                if safe_end:
                    parts.append(ReplyPart(text=self._pending[:safe_end]))
                    self._pending = self._pending[safe_end:]
                break

            closing = self._pending.find("```")
            if closing < 0:
                if len(self._pending) + len(self._opening) > MAX_SOURCE_CHARS:
                    parts.append(ReplyPart(text=self._opening + self._pending))
                    self._pending = ""
                    self._opening = ""
                    self._in_diagram = False
                    continue
                if final:
                    parts.append(ReplyPart(text=self._opening + self._pending))
                    self._pending = ""
                    break
                break

            source = self._opening + self._pending[:closing + 3]
            self._pending = self._pending[closing + 3:]
            self._opening = ""
            self._in_diagram = False
            self._diagram_count += 1
            opening = _OPEN_RE.match(source)
            body = source[len(opening.group(0)):-3] if opening else ""
            if self._diagram_count <= self._max_diagrams and len(source) <= MAX_SOURCE_CHARS:
                self._diagrams.append((source, body))
                parts.append(ReplyPart(
                    text=f"\n\n（图表 {self._diagram_count} 见后续图片）\n\n",
                    source=source,
                    placeholder_emitted=True,
                ))
            else:
                parts.append(ReplyPart(text=source))
        return [part for part in parts if part.text or part.png]


class MermaidTokenFilter:
    """把流式 Mermaid fence 转成文本占位，并在卡片收尾后暴露待发 PNG。"""

    def __init__(self) -> None:
        self.images: list[tuple[bytes, str]] = []
        self._renderer = StreamingRenderer()
        self._raw_text = ""
        self._visible_text = ""

    async def events(self, source_iter, round_end):
        from dataclasses import replace

        async for kind, value in source_iter:
            if kind == "token":
                chunk = str(value or "")
                self._raw_text += chunk
                displayed = await self._display_parts(await self._renderer.feed(chunk))
                if displayed:
                    yield ("token", displayed)
                continue
            if kind == round_end:
                displayed = await self._display_parts(await self._renderer.finish_round())
                if displayed:
                    yield ("token", displayed)
                continue
            if kind == "final" and value is not None:
                displayed = await self._display_parts(await self._renderer.finish_round())
                if displayed:
                    yield ("token", displayed)
                final_text = str(getattr(value, "text", "") or "")
                if final_text and final_text != self._raw_text:
                    self.images.clear()
                    self._visible_text = ""
                    final_display = await self._display_parts(await render_reply(final_text))
                else:
                    final_display = self._visible_text
                if hasattr(value, "text"):
                    value = replace(value, text=final_display or final_text)
            yield (kind, value)

    async def _display_parts(self, parts: list[ReplyPart]) -> str:
        output: list[str] = []
        for part in parts:
            if part.png is not None:
                self.images.append((part.png, part.source))
                if not part.placeholder_emitted:
                    output.append(f"\n\n（图表 {len(self.images)} 见后续图片）\n\n")
            elif part.text:
                output.append(part.text)
        displayed = "".join(output)
        self._visible_text += displayed
        return displayed


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--sandbox-exec":
    _sandbox_exec(sys.argv[2])

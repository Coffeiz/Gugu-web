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
_WORKER_FAILURE_RE = re.compile(
    r"^MERMAID_RENDER_FAILURE index=(\d+) type=([a-z0-9-]+) reason=([a-z0-9_]+)$"
)
_RENDER_LIMIT = asyncio.Semaphore(1)
# 单个 worker 请求的批大小上限；不是每轮/每次回复的图表上限。
MAX_DIAGRAMS = 4
DEFERRED_RENDER_BATCH_SIZE = 1
# 兼容旧调用方的显式限制值；新流式路径默认不设置 run 级上限。
MAX_RUN_DIAGRAMS = 4
DEFAULT_MAX_DIAGRAMS = None
MAX_SOURCE_CHARS = 20_000
MAX_PNG_BYTES = 3 * 1024 * 1024
RENDER_TIMEOUT_SECONDS = 20
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
    resource.setrlimit(resource.RLIMIT_CPU, (16, 16))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_PNG_BYTES, MAX_PNG_BYTES))
    _apply_network_seccomp()
    os.execv(node, [node, "--max-old-space-size=256", worker])


async def render_pngs(
    sources: list[str], *, theme_preferences: dict | None = None,
) -> list[bytes | None]:
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
            {
                "sources": [source for _index, source in valid],
                "theme": theme_preferences or {},
            },
            ensure_ascii=False,
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
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            stdout, stderr = await asyncio.wait_for(
                process.communicate(input_bytes),
                timeout=RENDER_TIMEOUT_SECONDS,
            )
            if process.returncode != 0:
                diag_log_raw("agent.im.mermaid.render", "status=worker_failed")
                return results
            for line in stderr.decode("utf-8", errors="ignore").splitlines():
                match = _WORKER_FAILURE_RE.fullmatch(line)
                if match:
                    diag_log_raw(
                        "agent.im.mermaid.render",
                        f"status=diagram_failed index={match.group(1)} "
                        f"diagram_type={match.group(2)} reason={match.group(3)}",
                    )
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
            failed = sum(png is None for png in rendered)
            diag_log_raw(
                "agent.im.mermaid.render",
                f"status={'partial' if failed else 'ok'} diagrams={len(valid)} "
                f"failed={failed} bytes={len(stdout)} "
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


async def render_png(
    source: str, *, theme_preferences: dict | None = None,
) -> bytes | None:
    """单图便捷入口；内部仍复用批量 renderer。"""
    if theme_preferences is None:
        return (await render_pngs([source]))[0]
    return (await render_pngs([source], theme_preferences=theme_preferences))[0]


async def _render_sources(
    sources: list[str], *, theme_preferences: dict | None = None,
) -> list[bytes | None]:
    """按 worker 支持的批大小渲染完整列表，不限制整轮图表数。"""
    results: list[bytes | None] = []
    for offset in range(0, len(sources), MAX_DIAGRAMS):
        batch = sources[offset:offset + MAX_DIAGRAMS]
        rendered = (
            await render_pngs(batch)
            if theme_preferences is None
            else await render_pngs(batch, theme_preferences=theme_preferences)
        )
        results.extend(rendered)
    return results


async def render_reply(
    text: str, *, max_diagrams: int | None = DEFAULT_MAX_DIAGRAMS,
    theme_preferences: dict | None = None,
) -> list[ReplyPart]:
    """解析完整 Mermaid fence，成功时用 PNG part 替换源码，失败时保留源码。"""
    value = text or ""
    matches = [match for match in _FENCE_RE.finditer(value) if _SOURCE_RE.match(match.group(0))]
    if max_diagrams is not None:
        matches = matches[:max(0, max_diagrams)]
    sources = [
        _SOURCE_RE.match(match.group(0)).group(1)
        for match in matches
    ]
    pngs = await _render_sources(sources, theme_preferences=theme_preferences)
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
    """暂存 Mermaid fence；按需把图片结果放回其在回复中的原始位置。"""

    def __init__(
        self,
        max_diagrams: int | None = DEFAULT_MAX_DIAGRAMS,
        *,
        inline_images: bool = False,
        defer_until_run_end: bool = False,
        theme_preferences: dict | None = None,
    ) -> None:
        self._pending = ""
        self._opening = ""
        self._in_diagram = False
        self._diagram_count = 0
        self._max_diagrams = max_diagrams
        self._diagrams: list[tuple[str, str]] = []
        self._deferred_diagrams: list[tuple[str, str]] = []
        self._inline_images = inline_images
        self._defer_until_run_end = defer_until_run_end
        self._theme_preferences = theme_preferences
        self._inline_deferred = False
        self._deferred_parts: list[ReplyPart] = []

    async def feed(self, chunk: str) -> list[ReplyPart]:
        self._pending += chunk or ""
        return await self._drain()

    @property
    def has_pending_diagrams(self) -> bool:
        return bool(self._diagrams)

    @property
    def has_deferred_diagrams(self) -> bool:
        return bool(self._deferred_diagrams)

    async def finish_round(
        self, *, max_images: int | None = None, defer_images: bool = False,
    ) -> list[ReplyPart]:
        parts = await self._drain(final=True)
        diagrams, self._diagrams = self._diagrams, []
        if diagrams:
            if defer_images:
                self._deferred_diagrams.extend(diagrams)
                diagrams = []
        if diagrams:
            render_count = len(diagrams) if max_images is None else max(0, min(max_images, len(diagrams)))
            sources = [body for _source, body in diagrams[:render_count]]
            pngs = await _render_sources(
                sources, theme_preferences=self._theme_preferences,
            )
            if self._inline_images:
                diagram_index = 0
                for part in self._deferred_parts:
                    if part.placeholder_emitted:
                        png = pngs[diagram_index] if diagram_index < len(pngs) else None
                        diagram_index += 1
                        parts.append(
                            ReplyPart(png=png, source=part.source)
                            if png else ReplyPart(text=part.source)
                        )
                    else:
                        parts.append(part)
            else:
                for index, (source, _body) in enumerate(diagrams):
                    png = pngs[index] if index < len(pngs) else None
                    if png:
                        parts.append(ReplyPart(png=png, source=source, placeholder_emitted=True))
                    else:
                        parts.append(ReplyPart(text=source))
        self._in_diagram = False
        self._opening = ""
        self._pending = ""
        if not defer_images:
            self._inline_deferred = False
            self._deferred_parts = []
        return parts

    async def render_deferred_diagrams(self) -> list[ReplyPart]:
        """在整次 run 完成后分批渲染此前排队的 Mermaid 图。"""
        diagrams, self._deferred_diagrams = self._deferred_diagrams, []
        parts: list[ReplyPart] = []
        for offset in range(0, len(diagrams), DEFERRED_RENDER_BATCH_SIZE):
            batch = diagrams[offset:offset + DEFERRED_RENDER_BATCH_SIZE]
            sources = [body for _source, body in batch]
            pngs = (
                await render_pngs(sources)
                if self._theme_preferences is None
                else await render_pngs(sources, theme_preferences=self._theme_preferences)
            )
            for index, (source, _body) in enumerate(batch):
                png = pngs[index] if index < len(pngs) else None
                parts.append(ReplyPart(png=png, source=source) if png else ReplyPart(text=source))
        if self._inline_images:
            ordered_parts: list[ReplyPart] = []
            diagram_index = 0
            for part in self._deferred_parts:
                if part.placeholder_emitted:
                    rendered = parts[diagram_index] if diagram_index < len(parts) else None
                    diagram_index += 1
                    ordered_parts.append(
                        rendered if rendered and rendered.png
                        else ReplyPart(text=part.source)
                    )
                else:
                    ordered_parts.append(part)
            self._deferred_parts = []
            self._inline_deferred = False
            return ordered_parts
        return parts

    async def _drain(self, *, final: bool = False) -> list[ReplyPart]:
        parts: list[ReplyPart] = []
        while self._pending:
            if not self._in_diagram:
                match = _OPEN_RE.search(self._pending)
                if match:
                    if match.start():
                        text_part = ReplyPart(text=self._pending[:match.start()])
                        if self._inline_deferred:
                            self._deferred_parts.append(text_part)
                        else:
                            parts.append(text_part)
                    self._opening = match.group(0)
                    self._pending = self._pending[match.end():]
                    self._in_diagram = True
                    continue
                if final:
                    text_part = ReplyPart(text=self._pending)
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
                    self._pending = ""
                    break
                # 保留可能跨 token 边界的 fence 前缀，安全发出其余普通文本。
                hold = min(len(self._pending), len("```mermaid\n") - 1)
                safe_end = len(self._pending) - hold
                if safe_end:
                    text_part = ReplyPart(text=self._pending[:safe_end])
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
                    self._pending = self._pending[safe_end:]
                break

            closing = self._pending.find("```")
            if closing < 0:
                if len(self._pending) + len(self._opening) > MAX_SOURCE_CHARS:
                    text_part = ReplyPart(text=self._opening + self._pending)
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
                    self._pending = ""
                    self._opening = ""
                    self._in_diagram = False
                    continue
                if final:
                    text_part = ReplyPart(text=self._opening + self._pending)
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
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
            if (self._max_diagrams is None or self._diagram_count <= self._max_diagrams) and len(source) <= MAX_SOURCE_CHARS:
                self._diagrams.append((source, body))
                placeholder = ReplyPart(source=source, placeholder_emitted=True)
                if self._inline_images:
                    self._inline_deferred = True
                    self._deferred_parts.append(placeholder)
                    if self._defer_until_run_end:
                        parts.append(placeholder)
                else:
                    parts.append(ReplyPart(
                        text=f"\n\n（图表 {self._diagram_count} 见后续图片）\n\n",
                        source=source,
                        placeholder_emitted=True,
                    ))
            else:
                text_part = ReplyPart(text=source)
                if self._inline_deferred:
                    self._deferred_parts.append(text_part)
                else:
                    parts.append(text_part)
        return [
            part for part in parts
            if part.text or part.png or (self._defer_until_run_end and part.placeholder_emitted)
        ]


class ProgressiveMermaidTokenFilter:
    """跨 IM 共用的流式 Mermaid 解析器与背压调度器。

    普通文本立即透传。完整图表源码暂存并等待渲染；图片事件（或失败时的
    源码回退）交付后，才继续释放同一 token 块中的后续文本。
    """

    def __init__(
        self,
        max_diagrams: int | None = DEFAULT_MAX_DIAGRAMS,
        *,
        theme_preferences: dict | None = None,
        preserve_source: bool = False,
    ) -> None:
        self.images: list[tuple[bytes, str]] = []
        self._max_diagrams = max_diagrams
        self._preserve_source = preserve_source
        self._theme_preferences = theme_preferences
        self._diagram_index = 0
        self._in_diagram = False
        self._opening = ""
        self._pending = ""

    async def events(self, source_iter):
        async for kind, value in source_iter:
            if kind == "token":
                async for event in self._feed(str(value or "")):
                    yield event
            elif kind == "final":
                async for event in self._feed("", final=True):
                    yield event
                yield (kind, value)
            elif kind == "round_end" and not self._in_diagram:
                if self._pending:
                    yield ("token", self._pending)
                    self._pending = ""
                yield (kind, value)
            else:
                yield (kind, value)
        async for event in self._feed("", final=True):
            yield event

    async def _feed(self, chunk: str, *, final: bool = False):
        self._pending += chunk
        while self._pending:
            if not self._in_diagram:
                opening = _OPEN_RE.search(self._pending)
                if opening is not None:
                    if opening.start():
                        yield ("token", self._pending[:opening.start()])
                    self._opening = self._pending[opening.start():opening.end()]
                    self._pending = self._pending[opening.end():]
                    self._in_diagram = True
                    continue
                if final:
                    if self._pending:
                        yield ("token", self._pending)
                    self._pending = ""
                    return
                hold = len("```mermaid\n") - 1
                safe_end = max(0, len(self._pending) - hold)
                if safe_end:
                    yield ("token", self._pending[:safe_end])
                    self._pending = self._pending[safe_end:]
                return

            closing = self._pending.find("```")
            if closing < 0:
                source_size = len(self._opening) + len(self._pending)
                if source_size > MAX_SOURCE_CHARS or final:
                    yield ("token", self._opening + self._pending)
                    self._opening = ""
                    self._pending = ""
                    self._in_diagram = False
                    return
                return

            source = self._opening + self._pending[:closing + 3]
            body = self._pending[:closing]
            self._pending = self._pending[closing + 3:]
            self._opening = ""
            self._in_diagram = False
            self._diagram_index += 1
            diagram_index = self._diagram_index
            if len(source) > MAX_SOURCE_CHARS or (
                self._max_diagrams is not None and diagram_index > self._max_diagrams
            ):
                yield ("token", source)
                continue
            try:
                png = (
                    await render_png(body)
                    if self._theme_preferences is None
                    else await render_png(body, theme_preferences=self._theme_preferences)
                )
            except Exception as exc:
                from app.core.redaction import diag_log
                diag_log("agent.im.mermaid.stream_render", exc)
                png = None
            if png:
                self.images.append((png, source))
                if self._preserve_source:
                    yield ("token", source)
                yield ("mermaid_image", (diagram_index, len(self.images), source, png))
            else:
                yield ("token", source)


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--sandbox-exec":
    _sandbox_exec(sys.argv[2])

"""IM 回复中的图表渲染与有界子进程管理。"""
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

_OPEN_RE = re.compile(r"(?m)^ {0,3}```mermaid[ \t]*\r?\n", re.IGNORECASE)
_PROGRESSIVE_CHART_OPEN_RE = re.compile(
    r"(?m)^ {0,3}```(mermaid|tex|latex)[ \t]*\r?\n", re.IGNORECASE,
)
_FENCE_LINE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\r\n]*)$")
_WORKER_FAILURE_RE = re.compile(
    r"^CHART_RENDER_FAILURE index=(\d+) type=([a-z0-9-]+) reason=([a-z0-9_]+)$"
)
_RENDER_LIMIT = asyncio.Semaphore(1)
# 单个 worker 请求的批大小上限；不是每轮/每次回复的图表上限。
MAX_CHARTS = 4
DEFERRED_RENDER_BATCH_SIZE = 1
# 总图表数不设上限；单批大小与全局并发分别由 MAX_CHARTS 和 _RENDER_LIMIT 控制。
DEFAULT_MAX_CHARTS: int | None = None
MAX_SOURCE_CHARS = 20_000
MAX_PNG_BYTES = 3 * 1024 * 1024
RENDER_TIMEOUT_SECONDS = 20
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _top_level_chart_fences(text: str):
    """只找 Markdown 顶层 Mermaid 与 TeX 围栏，跳过其他代码围栏内部的示例。"""
    lines = text.splitlines(keepends=True)
    offsets = []
    offset = 0
    for line in lines:
        offsets.append(offset)
        offset += len(line)

    index = 0
    outer_fence: tuple[str, int] | None = None
    while index < len(lines):
        line = lines[index].rstrip("\r\n")
        match = _FENCE_LINE_RE.fullmatch(line)
        if not match:
            index += 1
            continue

        marker, info = match.groups()
        char = marker[0]
        size = len(marker)
        if outer_fence is not None:
            if (
                char == outer_fence[0]
                and size >= outer_fence[1]
                and not info.strip()
            ):
                outer_fence = None
            index += 1
            continue

        language = info.strip().split(maxsplit=1)[0].lower() if info.strip() else ""
        if language in {"mermaid", "tex", "latex"} and char == "`" and size == 3:
            closing = index + 1
            while closing < len(lines):
                close_line = lines[closing].rstrip("\r\n")
                close_match = _FENCE_LINE_RE.fullmatch(close_line)
                if (
                    close_match
                    and close_match.group(1)[0] == char
                    and len(close_match.group(1)) >= size
                    and not close_match.group(2).strip()
                ):
                    start = offsets[index]
                    body_start = start + len(lines[index])
                    close_start = offsets[closing]
                    end = close_start + len(close_line)
                    chart_type = "mermaid" if language == "mermaid" else "math"
                    yield start, end, chart_type, text[body_start:close_start], text[start:end]
                    index = closing + 1
                    break
                closing += 1
            else:
                # 没有闭合的围栏由普通 Markdown 继续展示，不做图表替换。
                return
            continue

        outer_fence = (char, size)
        index += 1


def _top_level_chart_sources(text: str):
    """按正文顺序返回顶层 Mermaid 图表和 TeX 代码块的源码范围。"""
    return [
        match for match in _top_level_chart_fences(text)
        if match[3] and len(match[3]) <= MAX_SOURCE_CHARS
    ]


class _MarkdownFenceTracker:
    """流式追踪已透传文本中的围栏，避免识别代码示例里的 Mermaid。"""

    def __init__(self) -> None:
        self.open_fence: tuple[str, int] | None = None
        self._line_probe = ""
        self._line_start = True

    def feed(self, text: str) -> None:
        for char in text:
            if char == "\n":
                match = _FENCE_LINE_RE.fullmatch(self._line_probe.rstrip("\r"))
                if match:
                    marker, rest = match.groups()
                    fence_char = marker[0]
                    fence_size = len(marker)
                    if self.open_fence is None:
                        self.open_fence = (fence_char, fence_size)
                    elif (
                        fence_char == self.open_fence[0]
                        and fence_size >= self.open_fence[1]
                        and not rest.strip()
                    ):
                        self.open_fence = None
                self._line_probe = ""
                self._line_start = True
                continue
            if not self._line_start:
                continue
            self._line_probe += char
            prefix = self._line_probe
            spaces = len(prefix) - len(prefix.lstrip(" "))
            remainder = prefix[spaces:]
            possible = spaces <= 3 and (
                not remainder or remainder[0] in "`~"
            )
            if remainder and remainder[0] in "`~":
                marker_char = remainder[0]
                marker_run = len(remainder) - len(remainder.lstrip(marker_char))
                possible = spaces <= 3 and (marker_run < 3 or len(prefix) <= 256)
            if not possible or len(prefix) > 256:
                self._line_probe = ""
                self._line_start = False


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


async def render_chart_pngs(
    charts: list[tuple[str, str]], *, theme_preferences: dict | None = None,
) -> list[bytes | None]:
    """在一个受限 Node 子进程中批量渲染单轮图表，避免重复冷启动。"""
    from app.core.redaction import diag_log_raw

    if not charts:
        return []
    if len(charts) > MAX_CHARTS:
        return [None] * len(charts)
    results: list[bytes | None] = [None] * len(charts)
    valid = [
        (index, chart_type, source)
        for index, (chart_type, source) in enumerate(charts)
        if chart_type in {"mermaid", "math"} and source and len(source) <= MAX_SOURCE_CHARS
    ]
    if not valid:
        return results
    backend_root = Path(__file__).resolve().parents[2]
    worker = backend_root / "ts" / "workers" / "chart-renderer" / "worker.mjs"
    if not worker.is_file():
        worker = backend_root / "bin" / "gugu-chart-worker.mjs"
    if not worker.is_file():
        return results
    try:
        input_bytes = json.dumps(
            {
                "charts": [
                    {"type": chart_type, "source": source}
                    for _index, chart_type, source in valid
                ],
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
                diag_log_raw("agent.im.chart.render", "status=worker_failed")
                return results
            for line in stderr.decode("utf-8", errors="ignore").splitlines():
                match = _WORKER_FAILURE_RE.fullmatch(line)
                if match:
                    diag_log_raw(
                        "agent.im.chart.render",
                        f"status=diagram_failed index={match.group(1)} "
                        f"chart_type={match.group(2)} reason={match.group(3)}",
                    )
            rendered: list[bytes | None] = []
            offset = 0
            for _index, _chart_type, _source in valid:
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
                "agent.im.chart.render",
                f"status={'partial' if failed else 'ok'} charts={len(valid)} "
                f"failed={failed} bytes={len(stdout)} "
                f"elapsed_ms={int((time.monotonic() - started) * 1000)}",
            )
            for (index, _chart_type, _source), png in zip(valid, rendered):
                results[index] = png
            return results
        except asyncio.TimeoutError:
            if process and process.returncode is None:
                try:
                    os.killpg(process.pid, 9)
                except ProcessLookupError:
                    pass
                await process.wait()
            diag_log_raw("agent.im.chart.render", "status=timeout")
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
                "agent.im.chart.render",
                f"status=unavailable error={type(exc).__name__}",
            )
            return results


async def render_chart_png(
    chart_type: str, source: str, *, theme_preferences: dict | None = None,
) -> bytes | None:
    """单图便捷入口；内部仍复用批量 renderer。"""
    if theme_preferences is None:
        return (await render_chart_pngs([(chart_type, source)]))[0]
    return (await render_chart_pngs([(chart_type, source)], theme_preferences=theme_preferences))[0]


async def _render_sources(
    charts: list[tuple[str, str]], *, theme_preferences: dict | None = None,
) -> list[bytes | None]:
    """按 worker 支持的批大小渲染完整列表，不限制整轮图表数。"""
    results: list[bytes | None] = []
    for offset in range(0, len(charts), MAX_CHARTS):
        batch = charts[offset:offset + MAX_CHARTS]
        rendered = (
            await render_chart_pngs(batch)
            if theme_preferences is None
            else await render_chart_pngs(batch, theme_preferences=theme_preferences)
        )
        results.extend(rendered)
    return results


async def render_chart_reply(
    text: str, *, max_charts: int | None = DEFAULT_MAX_CHARTS,
    theme_preferences: dict | None = None,
) -> list[ReplyPart]:
    """解析完整图表与块公式，成功时用 PNG part 替换源码，失败时保留源码。"""
    value = text or ""
    matches = list(_top_level_chart_sources(value))
    if max_charts is not None:
        matches = matches[:max(0, max_charts)]
    charts = [(chart_type, body) for _start, _end, chart_type, body, _source in matches]
    pngs = await _render_sources(charts, theme_preferences=theme_preferences)
    parts: list[ReplyPart] = []
    cursor = 0
    for index, (start, end, _chart_type, _body, source_block) in enumerate(matches):
        parts.append(ReplyPart(text=value[cursor:start]))
        png = pngs[index] if index < len(pngs) else None
        parts.append(ReplyPart(png=png, source=source_block) if png else ReplyPart(text=source_block))
        cursor = end
    parts.append(ReplyPart(text=value[cursor:]))
    return [part for part in parts if part.text or part.png]


class StreamingChartRenderer:
    """暂存 Mermaid fence；按需把图片结果放回其在回复中的原始位置。"""

    def __init__(
        self,
        max_charts: int | None = DEFAULT_MAX_CHARTS,
        *,
        inline_images: bool = False,
        defer_until_run_end: bool = False,
        theme_preferences: dict | None = None,
    ) -> None:
        self._pending = ""
        self._opening = ""
        self._in_diagram = False
        self._chart_count = 0
        self._max_charts = max_charts
        self._charts: list[tuple[str, str]] = []
        self._deferred_charts: list[tuple[str, str]] = []
        self._inline_images = inline_images
        self._defer_until_run_end = defer_until_run_end
        self._theme_preferences = theme_preferences
        self._inline_deferred = False
        self._deferred_parts: list[ReplyPart] = []
        self._fence_tracker = _MarkdownFenceTracker()

    async def feed(self, chunk: str) -> list[ReplyPart]:
        self._pending += chunk or ""
        return await self._drain()

    @property
    def has_pending_charts(self) -> bool:
        return bool(self._charts)

    @property
    def has_deferred_charts(self) -> bool:
        return bool(self._deferred_charts)

    async def finish_round(
        self, *, max_images: int | None = None, defer_images: bool = False,
    ) -> list[ReplyPart]:
        parts = await self._drain(final=True)
        charts, self._charts = self._charts, []
        if charts:
            if defer_images:
                self._deferred_charts.extend(charts)
                charts = []
        if charts:
            render_count = len(charts) if max_images is None else max(0, min(max_images, len(charts)))
            sources = [("mermaid", body) for _source, body in charts[:render_count]]
            pngs = await _render_sources(
                sources, theme_preferences=self._theme_preferences,
            )
            if self._inline_images:
                chart_index = 0
                for part in self._deferred_parts:
                    if part.placeholder_emitted:
                        png = pngs[chart_index] if chart_index < len(pngs) else None
                        chart_index += 1
                        parts.append(
                            ReplyPart(png=png, source=part.source)
                            if png else ReplyPart(text=part.source)
                        )
                    else:
                        parts.append(part)
            else:
                for index, (source, _body) in enumerate(charts):
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

    async def render_deferred_charts(self) -> list[ReplyPart]:
        """在整次 run 完成后分批渲染此前排队的 Mermaid 图。"""
        charts, self._deferred_charts = self._deferred_charts, []
        parts: list[ReplyPart] = []
        for offset in range(0, len(charts), DEFERRED_RENDER_BATCH_SIZE):
            batch = charts[offset:offset + DEFERRED_RENDER_BATCH_SIZE]
            sources = [("mermaid", body) for _source, body in batch]
            pngs = (
                await render_chart_pngs(sources)
                if self._theme_preferences is None
                else await render_chart_pngs(sources, theme_preferences=self._theme_preferences)
            )
            for index, (source, _body) in enumerate(batch):
                png = pngs[index] if index < len(pngs) else None
                parts.append(ReplyPart(png=png, source=source) if png else ReplyPart(text=source))
        if self._inline_images:
            ordered_parts: list[ReplyPart] = []
            chart_index = 0
            for part in self._deferred_parts:
                if part.placeholder_emitted:
                    rendered = parts[chart_index] if chart_index < len(parts) else None
                    chart_index += 1
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
                        prefix = self._pending[:match.start()]
                        self._fence_tracker.feed(prefix)
                        text_part = ReplyPart(text=prefix)
                        if self._inline_deferred:
                            self._deferred_parts.append(text_part)
                        else:
                            parts.append(text_part)
                    if self._fence_tracker.open_fence is not None:
                        literal = self._pending[match.start():match.end()]
                        self._fence_tracker.feed(literal)
                        text_part = ReplyPart(text=literal)
                        if self._inline_deferred:
                            self._deferred_parts.append(text_part)
                        else:
                            parts.append(text_part)
                        self._pending = self._pending[match.end():]
                        continue
                    self._opening = match.group(0)
                    self._pending = self._pending[match.end():]
                    self._in_diagram = True
                    continue
                if final:
                    self._fence_tracker.feed(self._pending)
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
                    safe_text = self._pending[:safe_end]
                    self._fence_tracker.feed(safe_text)
                    text_part = ReplyPart(text=safe_text)
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
                    self._pending = self._pending[safe_end:]
                break

            closing = self._pending.find("```")
            if closing < 0:
                if len(self._pending) + len(self._opening) > MAX_SOURCE_CHARS:
                    literal = self._opening + self._pending
                    self._fence_tracker.feed(literal)
                    text_part = ReplyPart(text=literal)
                    if self._inline_deferred:
                        self._deferred_parts.append(text_part)
                    else:
                        parts.append(text_part)
                    self._pending = ""
                    self._opening = ""
                    self._in_diagram = False
                    continue
                if final:
                    literal = self._opening + self._pending
                    self._fence_tracker.feed(literal)
                    text_part = ReplyPart(text=literal)
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
            self._chart_count += 1
            opening = _OPEN_RE.match(source)
            body = source[len(opening.group(0)):-3] if opening else ""
            if (self._max_charts is None or self._chart_count <= self._max_charts) and len(source) <= MAX_SOURCE_CHARS:
                self._charts.append((source, body))
                placeholder = ReplyPart(source=source, placeholder_emitted=True)
                if self._inline_images:
                    self._inline_deferred = True
                    self._deferred_parts.append(placeholder)
                    if self._defer_until_run_end:
                        parts.append(placeholder)
                else:
                    parts.append(ReplyPart(
                        text=f"\n\n（图表 {self._chart_count} 见后续图片）\n\n",
                        source=source,
                        placeholder_emitted=True,
                    ))
            else:
                self._fence_tracker.feed(source)
                text_part = ReplyPart(text=source)
                if self._inline_deferred:
                    self._deferred_parts.append(text_part)
                else:
                    parts.append(text_part)
        return [
            part for part in parts
            if part.text or part.png or (self._defer_until_run_end and part.placeholder_emitted)
        ]


class ProgressiveChartTokenFilter:
    """跨 IM 共用的 Mermaid 与 TeX 代码块解析器、背压调度器。

    普通文本和 IM 原生公式立即透传。完整图表/TeX 代码块进入后台渲染队列，解析器继续消费后续
    token；图片完成事件携带图表序号，调用方可选择流式占位替换或有序交付。
    """

    def __init__(
        self,
        max_charts: int | None = DEFAULT_MAX_CHARTS,
        *,
        theme_preferences: dict | None = None,
        preserve_source: bool = False,
    ) -> None:
        self.images: list[tuple[bytes, str]] = []
        self._max_charts = max_charts
        self._preserve_source = preserve_source
        self._theme_preferences = theme_preferences
        self._chart_index = 0
        self._in_chart = False
        self._chart_type = "mermaid"
        self._closing = "```"
        self._opening = ""
        self._pending = ""
        self._render_tasks: dict[int, asyncio.Task] = {}
        self._fence_tracker = _MarkdownFenceTracker()

    async def ordered_events(self, source_iter):
        """缓冲图表后的文本，按源码顺序交付图片与文本。"""
        slots: list[tuple[str, object]] = []
        resolved: dict[int, tuple[str, object]] = {}

        async for kind, value in self.events(source_iter):
            if kind == "chart_pending":
                slots.append((kind, value))
            elif kind in {"chart_image", "chart_error"}:
                index = value[0] if kind == "chart_image" else value
                resolved[index] = (kind, value)
            elif slots and kind not in {"final"}:
                slots.append((kind, value))
            else:
                yield kind, value

            while slots:
                slot_kind, slot_value = slots[0]
                if slot_kind == "chart_pending":
                    index, source = slot_value
                    completion = resolved.pop(index, None)
                    if completion is None:
                        break
                    slots.pop(0)
                    if completion[0] == "chart_image":
                        yield completion
                    elif not self._preserve_source:
                        yield "token", source
                else:
                    slots.pop(0)
                    yield slot_kind, slot_value

        # events() 收尾时会等待所有渲染任务，因此槽位此时都应已解决。
        while slots:
            slot_kind, slot_value = slots.pop(0)
            if slot_kind == "chart_pending":
                index, source = slot_value
                completion = resolved.pop(index, None)
                if completion and completion[0] == "chart_image":
                    yield completion
                elif not self._preserve_source:
                    yield "token", source
            else:
                yield slot_kind, slot_value

    async def _render(self, chart_index: int, chart_type: str, body: str, source: str):
        try:
            png = (
                await render_chart_png(chart_type, body)
                if self._theme_preferences is None
                else await render_chart_png(
                    chart_type, body, theme_preferences=self._theme_preferences,
                )
            )
        except Exception as exc:
            from app.core.redaction import diag_log
            diag_log("agent.im.chart.stream_render", exc)
            png = None
        if png:
            self.images.append((png, source))
            return "chart_image", (chart_index, len(self.images), source, png)
        return "chart_error", chart_index

    async def _completed_render_events(self, *, wait: bool = False):
        if wait and self._render_tasks:
            await asyncio.gather(*self._render_tasks.values(), return_exceptions=True)
        for index, task in list(self._render_tasks.items()):
            if not task.done():
                continue
            self._render_tasks.pop(index, None)
            try:
                yield task.result()
            except Exception as exc:
                from app.core.redaction import diag_log
                diag_log("agent.im.chart.stream_render_task", exc)
                yield "chart_error", index

    async def events(self, source_iter):
        async for kind, value in source_iter:
            # 让刚启动的渲染任务先运行；已完成的图按完成顺序交付。
            await asyncio.sleep(0)
            if kind != "final":
                async for event in self._completed_render_events():
                    yield event
            if kind == "token":
                async for event in self._feed(str(value or "")):
                    yield event
            elif kind == "final":
                async for event in self._feed("", final=True):
                    yield event
                async for event in self._completed_render_events(wait=True):
                    yield event
                yield (kind, value)
            elif kind == "round_end" and not self._in_chart:
                if self._pending:
                    self._fence_tracker.feed(self._pending)
                    yield ("token", self._pending)
                    self._pending = ""
                yield (kind, value)
            else:
                yield (kind, value)
        async for event in self._feed("", final=True):
            yield event
        async for event in self._completed_render_events(wait=True):
            yield event

    async def _feed(self, chunk: str, *, final: bool = False):
        self._pending += chunk
        while self._pending:
            if not self._in_chart:
                opening = (
                    None if self._fence_tracker.open_fence
                    else _PROGRESSIVE_CHART_OPEN_RE.search(self._pending)
                )
                if opening is not None:
                    if opening.start():
                        prefix = self._pending[:opening.start()]
                        self._fence_tracker.feed(prefix)
                        yield ("token", prefix)
                    if self._fence_tracker.open_fence is not None:
                        literal = self._pending[opening.start():opening.end()]
                        self._fence_tracker.feed(literal)
                        yield ("token", literal)
                        self._pending = self._pending[opening.end():]
                        continue
                    self._opening = self._pending[opening.start():opening.end()]
                    self._pending = self._pending[opening.end():]
                    language = opening.group(1).lower()
                    self._chart_type = "mermaid" if language == "mermaid" else "math"
                    self._closing = "```"
                    self._in_chart = True
                    continue
                if final:
                    if self._pending:
                        self._fence_tracker.feed(self._pending)
                        yield ("token", self._pending)
                    self._pending = ""
                    return
                hold = len("```mermaid\n") - 1
                safe_end = max(0, len(self._pending) - hold)
                if safe_end:
                    safe_text = self._pending[:safe_end]
                    self._fence_tracker.feed(safe_text)
                    yield ("token", safe_text)
                    self._pending = self._pending[safe_end:]
                return

            closing_match = re.search(r"(?<!\\)" + re.escape(self._closing), self._pending)
            closing = closing_match.start() if closing_match else -1
            if closing < 0:
                source_size = len(self._opening) + len(self._pending)
                if source_size > MAX_SOURCE_CHARS or final:
                    literal = self._opening + self._pending
                    self._fence_tracker.feed(literal)
                    yield ("token", literal)
                    self._opening = ""
                    self._pending = ""
                    self._in_chart = False
                    return
                return

            closing_end = closing + len(self._closing)
            source = self._opening + self._pending[:closing_end]
            body = self._pending[:closing]
            chart_type = self._chart_type
            self._pending = self._pending[closing_end:]
            self._opening = ""
            self._in_chart = False
            self._chart_index += 1
            chart_index = self._chart_index
            if len(source) > MAX_SOURCE_CHARS or (
                self._max_charts is not None and chart_index > self._max_charts
            ):
                self._fence_tracker.feed(source)
                yield ("token", source)
                continue
            self._render_tasks[chart_index] = asyncio.create_task(
                self._render(chart_index, chart_type, body, source)
            )
            yield "chart_pending", (chart_index, source)
            if self._preserve_source:
                self._fence_tracker.feed(source)
                yield "token", source


if __name__ == "__main__" and len(sys.argv) == 3 and sys.argv[1] == "--sandbox-exec":
    _sandbox_exec(sys.argv[2])

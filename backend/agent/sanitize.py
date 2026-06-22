"""流式文本清洗：过滤 MiniMax 漏进 token 流的 tool-call 标记。

MiniMax-M3 经 Anthropic 兼容端点流式输出时，偶发把内部 tool-call 序列化
（以 `]<]minimax...` 为分隔标记）当作正文吐出。一旦出现该标记，其后全是
泄漏垃圾，正文在标记之前。

改为前缀感知匹配：只在 buffer 末尾确实是标记前缀时才保留最少字节，
正常文本（不含标记前缀）立即透传，避免因保留 9 字节缓冲导致输出卡顿。
"""
from __future__ import annotations

TRUNCATE_MARKERS = ["]<]minimax"]


def _longest_suffix_prefix(s: str, marker: str) -> int:
    """返回 s 末尾与 marker 前缀重叠的最大长度（0 = 无重叠）。"""
    max_overlap = min(len(s), len(marker) - 1)
    for length in range(max_overlap, 0, -1):
        if s.endswith(marker[:length]):
            return length
    return 0


class StreamSanitizer:
    def __init__(self):
        self._buf = ""
        self._cut = False

    def feed(self, delta: str) -> str:
        """喂入一个流式增量，返回可安全输出的已清洗文本（可能为空）。"""
        if self._cut:
            return ""
        self._buf += delta

        # 检查是否出现完整标记
        for marker in TRUNCATE_MARKERS:
            idx = self._buf.find(marker)
            if idx != -1:
                out = self._buf[:idx]
                self._buf = ""
                self._cut = True
                return out

        # 未出现完整标记：检查末尾是否是某个标记的前缀
        # 只保留最长前缀匹配部分，其余立即透传
        hold = 0
        for marker in TRUNCATE_MARKERS:
            hold = max(hold, _longest_suffix_prefix(self._buf, marker))

        if hold > 0:
            emit = self._buf[:-hold]
            self._buf = self._buf[-hold:]
        else:
            emit = self._buf
            self._buf = ""

        return emit

    def flush(self) -> str:
        """流结束时输出残留缓冲（未触发截断时）。"""
        if self._cut:
            return ""
        out = self._buf
        self._buf = ""
        return out

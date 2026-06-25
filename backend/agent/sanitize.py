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


# ── 历史消息清洗（Anthropic / MiniMax）──────────────────────────────────────
# token 预算窗口「整条进出」裁剪，但不守 tool_use/tool_result 配对：窗口可能从一个
# 带 tool_result 的 user 消息开头（对应的 assistant tool_use 被裁掉）→ 孤儿 tool_result，
# MiniMax 直接报 `invalid params, tool result's...`（有时返回畸形流让 SDK 抛 IndexError）。
# 这里在发送前清洗：去孤儿 tool_use/tool_result、去空消息、保证首条 user、合并连续同角色。

def _to_blocks(content) -> list:
    """把消息 content 规整成 block 列表（字符串 → 单个 text block）。"""
    if isinstance(content, list):
        return content
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []
    return []


def _block_keep(b, use_ids: set, result_ids: set) -> bool:
    """该 block 是否保留：孤儿 tool_result / 孤儿 tool_use / 空 text 都丢。"""
    if not isinstance(b, dict):
        return bool(b)
    t = b.get("type")
    if t == "tool_result":
        return b.get("tool_use_id") in use_ids
    if t == "tool_use":
        return b.get("id") in result_ids
    if t == "text":
        return bool((b.get("text") or "").strip())
    return True  # image / thinking 等保留


def sanitize_messages(messages: list) -> list:
    """清洗发给 Anthropic/MiniMax 的消息序列，确保合法可发送。

    1) 丢孤儿 tool_result（无对应 tool_use）与孤儿 tool_use（无对应 tool_result）——窗口截断所致；
    2) 丢空 text block / 整条空内容的消息；
    3) 开头必须是 user（去掉前导 assistant / 残留）；
    4) 合并相邻同角色消息（Anthropic 要求 user/assistant 严格交替）。
    """
    # 1) 窗口内出现的 tool_use id 与被 tool_result 引用的 id
    use_ids, result_ids = set(), set()
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict):
                    if b.get("type") == "tool_use":
                        use_ids.add(b.get("id"))
                    elif b.get("type") == "tool_result":
                        result_ids.add(b.get("tool_use_id"))

    # 2) 逐条清块；块清空的整条丢弃
    cleaned = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, list):
            nc = [b for b in c if _block_keep(b, use_ids, result_ids)]
            if nc:
                cleaned.append({**m, "content": nc})
        elif isinstance(c, str):
            if c.strip():
                cleaned.append(m)
        elif c:
            cleaned.append(m)

    # 3) 开头必须是 user
    while cleaned and cleaned[0].get("role") != "user":
        cleaned.pop(0)

    # 4) 合并相邻同角色
    merged: list = []
    for m in cleaned:
        if merged and merged[-1].get("role") == m.get("role"):
            merged[-1] = {"role": m["role"],
                          "content": _to_blocks(merged[-1]["content"]) + _to_blocks(m.get("content"))}
        else:
            merged.append({"role": m.get("role"), "content": m.get("content")})
    return merged

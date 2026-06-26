"""流式文本清洗：过滤 MiniMax 漏进 token 流的 tool-call 标记。

MiniMax-M3 经 Anthropic 兼容端点流式输出时，偶发把内部 tool-call 序列化
（以 `]<]minimax...` 为分隔标记）当作正文吐出。一旦出现该标记，其后全是
泄漏垃圾，正文在标记之前。

改为前缀感知匹配：只在 buffer 末尾确实是标记前缀时才保留最少字节，
正常文本（不含标记前缀）立即透传，避免因保留 9 字节缓冲导致输出卡顿。
"""
from __future__ import annotations

import re

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


# ── 输出 emoji 白名单过滤 ────────────────────────────────────────────────────
# persona 要求表情极简、只标内容类别、坚决不用阴阳/情绪/暧昧表情，但 prompt 压不住模型在
# 「活泼」语气下的 emoji 习惯（实测三层声明无效——emoji 是 token 级低层习惯，非高层语义行为）。
# 这里在输出出口确定性兜底：白名单（功能/内容类别）外的 emoji 一律删——宁可误删一个无害图标，
# 也不放过一个会被读成阴阳/敷衍/暧昧的脸或手势。base char 判定，连带的 VS16/ZWJ 一起处理。
_KEEP_EMOJI = set("✅✔☑💡📌📎📝📄📅📆🗓⏰⏳⌛🔍🔎🎉🎊📂📁🗂📊📈📉🔔💬🗨")
# 前导可选空格一起匹配：删违规 emoji 时连它前面的空格一起吃掉，不留难看的双空格 / 行尾空格
_EMOJI_RE = re.compile(
    "[ 　]?([\U0001F300-\U0001FAFF\U00002600-\U000027BF\U00002B00-\U00002BFF"
    "\U00002300-\U000023FF\U0001F1E6-\U0001F1FF])[\U0000FE00-\U0000FE0F\U0000200D]*"
)


def strip_disallowed_emoji(text: str) -> str:
    """删掉「内容类别白名单」外的所有 emoji（脸 / 手势 / 情绪 / 暧昧等高阴阳风险表情）。"""
    if not text:
        return text
    return _EMOJI_RE.sub(lambda m: m.group(0) if m.group(1) in _KEEP_EMOJI else "", text)


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


def _nonempty_block(b) -> bool:
    """空 text block 丢；其余（tool_use/tool_result/thinking/image…）先留，配对合法性后续再判。"""
    if not isinstance(b, dict):
        return bool(b)
    if b.get("type") == "text":
        return bool((b.get("text") or "").strip())
    return True


def _to_norm(m) -> dict:
    """把一条消息规整成 {role, content: [blocks]}（字符串 → text block；丢空 text block）。"""
    c = m.get("content")
    if isinstance(c, str):
        blocks = [{"type": "text", "text": c}] if c.strip() else []
    elif isinstance(c, list):
        blocks = [b for b in c if _nonempty_block(b)]
    elif c:
        blocks = [c]
    else:
        blocks = []
    return {"role": m.get("role"), "content": blocks}


def _uses(blocks) -> set:
    return {b["id"] for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id")}


def _results(blocks) -> set:
    return {b["tool_use_id"] for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"}


def sanitize_messages(messages: list) -> list:
    """清洗发给 Anthropic/MiniMax 的消息序列，确保合法可发送。

    核心是 **tool_use/tool_result 必须严格相邻配对**（MiniMax 要求 tool_result 紧跟在
    含对应 tool_use 的 assistant 之后），而 token 窗口截断 / 删空消息 / 合并同角色都会破坏它。
    做法（基于相邻性，而非全局 id 是否存在）：
    1) 规整成 block 列表、丢空 text block；
    2) 只认「assistant(tool_use X) 紧接 user(tool_result X)」的合法对，其余 tool 块全剥掉；
    3) 丢空消息；
    4) 开头必须是 user——丢前导 assistant 时，同步剥掉它在新表头遗留的孤儿 tool_result；
    5) 合并相邻同角色。
    """
    norm = [_to_norm(m) for m in messages]

    # 2) 合法对**按位置标记**（不能用全局 id：同一 id 跨位置复用时，会放过领头的孤儿 result）：
    #    仅当 assistant[i] 的 tool_use 与紧邻 user[i+1] 的 tool_result id 相交，才把这两处的对应块标合法。
    valid_use: dict = {}   # 消息下标 → 该 assistant 处合法的 tool_use id
    valid_res: dict = {}   # 消息下标 → 该 user 处合法的 tool_result id
    for i in range(len(norm) - 1):
        if norm[i]["role"] == "assistant" and norm[i + 1]["role"] == "user":
            common = _uses(norm[i]["content"]) & _results(norm[i + 1]["content"])
            if common:
                valid_use.setdefault(i, set()).update(common)
                valid_res.setdefault(i + 1, set()).update(common)

    for idx, m in enumerate(norm):
        kept = []
        for b in m["content"]:
            if isinstance(b, dict) and b.get("type") == "tool_use":
                if b.get("id") in valid_use.get(idx, ()):
                    kept.append(b)
            elif isinstance(b, dict) and b.get("type") == "tool_result":
                if b.get("tool_use_id") in valid_res.get(idx, ()):
                    kept.append(b)
            else:
                kept.append(b)
        m["content"] = kept

    # 3) 丢空消息
    norm = [m for m in norm if m["content"]]

    # 4) 开头必须是 user；丢前导 assistant 时剥掉新表头的孤儿 tool_result
    while norm and norm[0]["role"] != "user":
        dropped_uses = _uses(norm.pop(0)["content"])
        if dropped_uses and norm and norm[0]["role"] == "user":
            norm[0]["content"] = [
                b for b in norm[0]["content"]
                if not (isinstance(b, dict) and b.get("type") == "tool_result"
                        and b.get("tool_use_id") in dropped_uses)
            ]
            if not norm[0]["content"]:
                norm.pop(0)

    # 5) 合并相邻同角色
    merged: list = []
    for m in norm:
        if merged and merged[-1]["role"] == m["role"]:
            merged[-1]["content"] = merged[-1]["content"] + m["content"]
        else:
            merged.append({"role": m["role"], "content": m["content"]})
    return merged

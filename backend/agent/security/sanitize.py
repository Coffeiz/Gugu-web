"""流式文本清洗：过滤上游模型漏进 token 流的内部尾标记。

MiniMax-M3 经 Anthropic 兼容端点流式输出时，偶发把内部 tool-call 序列化
（以 `]<]minimax...` 为分隔标记）当作正文吐出。一旦出现该标记，其后全是
泄漏垃圾，正文在标记之前。另有已确认的 `[e~[` 尾标记，会紧跟代码围栏泄漏。

改为前缀感知匹配：只在 buffer 末尾确实是标记前缀时才保留最少字节，
正常文本（不含标记前缀）立即透传，避免因保留 9 字节缓冲导致输出卡顿。
"""
from __future__ import annotations

import re

# `[e~[` 已由生产流日志的 hex 确认是字面泄漏（常见形态为 "```[e~["），不是前端渲染问题。
# 它对用户没有语义，后续内容也属于同一段泄漏，和 MiniMax tool-call 标记一样从此处截断。
class StreamSanitizer:
    def __init__(self, adapter=None):
        """按 provider adapter 提供的规则清洗；没有 adapter 时保持纯文本直通。"""
        self._markers = list(adapter.stream_sanitize_markers()) if adapter is not None else []
        self._buf = ""
        self._cut = False

    def feed(self, delta: str) -> str:
        """喂入一个流式增量，返回可安全输出的已清洗文本（可能为空）。"""
        if self._cut:
            return ""
        self._buf += delta

        # 检查是否出现完整标记
        for marker in self._markers:
            idx = self._buf.find(marker)
            if idx != -1:
                out = self._buf[:idx]
                self._buf = ""
                self._cut = True
                return out

        # 未出现完整标记：检查末尾是否是某个标记的前缀
        # 只保留最长前缀匹配部分，其余立即透传
        hold = 0
        for marker in self._markers:
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
def _longest_suffix_prefix(s: str, marker: str) -> int:
    """返回 s 末尾与 marker 前缀重叠的最大长度（0 = 无重叠）。"""
    max_overlap = min(len(s), len(marker) - 1)
    for length in range(max_overlap, 0, -1):
        if s.endswith(marker[:length]):
            return length
    return 0


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


def _is_time_reminder_block(block: dict) -> bool:
    """识别可与同一轮用户消息合并的时间块，保留其他 reminder 的边界。"""
    if not isinstance(block, dict) or block.get("type") != "text":
        return False
    text = str(block.get("text") or "").strip()
    if not text.startswith("[system-reminder]") or not text.endswith("[/system-reminder]"):
        return False
    body = text[len("[system-reminder]"):-len("[/system-reminder]")].strip()
    return bool(re.fullmatch(r"(?:\d{1,2}-\d{1,2} \d{1,2}:\d{2}|当前时间：.+)", body))


_CANONICAL_BOUNDARY_TYPES = frozenset({
    "tool_call",
    "tool_use",
    "tool_result",
    "tool-schema",
    "skill-schema",
    "tool-discovery",
    "knowledge-context",
    "stance-context",
    "time-context",
    "runtime-context",
})


def _contains_canonical_boundary(blocks: list) -> bool:
    """识别不能与相邻消息合并的 canonical event。"""
    return any(
        isinstance(block, dict) and block.get("type") in _CANONICAL_BOUNDARY_TYPES
        for block in blocks
    )


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


def _clean_block(b):
    """去掉 block 里值为 None 的字段。MiniMax SDK 响应对象序列化进历史时常带 `caller`/`citations`/
    `parsed_output`=None 等**非请求字段**，回发给 API 时严格校验可能拒（如 `text is not set`）。
    只删 None 值（真实字段 text/thinking/signature/id/input… 都非 None，保留）。"""
    return {k: v for k, v in b.items() if v is not None} if isinstance(b, dict) else b


def _to_norm(m) -> dict:
    """把一条消息规整成 {role, content: [blocks]}（字符串 → text block；丢空 text block；清 None 字段）。"""
    c = m.get("content")
    if isinstance(c, str):
        blocks = [{"type": "text", "text": c}] if c.strip() else []
    elif isinstance(c, list):
        blocks = [_clean_block(b) for b in c if _nonempty_block(b)]
    elif c:
        blocks = [_clean_block(c)]
    else:
        blocks = []
    return {"role": m.get("role"), "content": blocks}


def _uses(blocks) -> set:
    return {b["id"] for b in blocks if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("id")}


def _results(blocks) -> set:
    # 旧历史或异常 provider 响应可能留下没有 id 的 tool_result。它不是可配对的
    # 工具结果，不能让发送前清洗本身因 KeyError 中断 worker。
    return {
        tool_id
        for b in blocks
        if isinstance(b, dict)
        and b.get("type") == "tool_result"
        and (tool_id := b.get("tool_use_id") or b.get("tool_call_id"))
    }


def sanitize_messages(messages: list) -> list:
    """清洗发给 Anthropic/MiniMax 的消息序列，确保合法可发送。

    核心是 **tool_use/tool_result 必须严格相邻配对**（MiniMax 要求 tool_result 紧跟在
    含对应 tool_use 的 assistant 之后），而 token 窗口截断 / 删空消息 / 合并同角色都会破坏它。
    做法（基于相邻性，而非全局 id 是否存在）：
    1) 规整成 block 列表、丢空 text block；
    2) 只认「assistant(tool_use X) 紧接 user(tool_result X)」的合法对，其余 tool 块全剥掉；
    3) 丢空消息；
    4) 开头允许稳定的 system snapshot；其后的对话区必须从 user 开始。丢前导
       assistant 时，同步剥掉它在新表头遗留的孤儿 tool_result；
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
                tool_id = b.get("tool_use_id") or b.get("tool_call_id")
                if tool_id in valid_res.get(idx, ()):
                    kept.append(b)
            else:
                kept.append(b)
        m["content"] = kept

    # 3) 丢空消息
    norm = [m for m in norm if m["content"]]

    # 4) 保留前导 system snapshot。旧规则要求第一条必须是 user，会把新的
    # role=system snapshot 直接删掉，最终请求只剩 system_param + history/tail。
    # system 之后仍要求对话区从 user 开始，并继续清理前导 assistant 及其孤儿 result。
    leading_system = []
    while norm and norm[0]["role"] == "system":
        leading_system.append(norm.pop(0))
    while norm and norm[0]["role"] != "user":
        dropped_uses = _uses(norm.pop(0)["content"])
        if dropped_uses and norm and norm[0]["role"] == "user":
            norm[0]["content"] = [
                b for b in norm[0]["content"]
                if not (isinstance(b, dict) and b.get("type") == "tool_result"
                        and (b.get("tool_use_id") or b.get("tool_call_id")) in dropped_uses)
            ]
            if not norm[0]["content"]:
                norm.pop(0)
    norm = leading_system + norm

    # 5) 合并相邻同角色，但保留 reminder 与 canonical event 的独立边界。
    # reminder 现在使用 user role；如果无条件合并，当前用户消息会和时间/快照
    # reminder 粘成一条，下一轮从历史恢复时会再次改变消息形状并破坏缓存前缀。
    merged: list = []
    for m in norm:
        previous_is_reminder = bool(
            merged
            and isinstance(merged[-1].get("content"), list)
            and any(
                (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and str(block.get("text") or "").startswith("[system-reminder]")
                    and not _is_time_reminder_block(block)
                )
                or (isinstance(block, dict) and block.get("type") == "time-context")
                for block in merged[-1]["content"]
            )
        )
        current_is_reminder = any(
            (
                isinstance(block, dict)
                and block.get("type") == "text"
                and str(block.get("text") or "").startswith("[system-reminder]")
                and not _is_time_reminder_block(block)
            )
            or (isinstance(block, dict) and block.get("type") == "time-context")
            for block in m["content"]
        )
        previous_has_canonical_boundary = (
            _contains_canonical_boundary(merged[-1]["content"])
            if merged else False
        )
        current_has_canonical_boundary = _contains_canonical_boundary(m["content"])
        if merged and merged[-1]["role"] == m["role"] and not (
            previous_is_reminder
            or current_is_reminder
            or previous_has_canonical_boundary
            or current_has_canonical_boundary
        ):
            merged[-1]["content"] = merged[-1]["content"] + m["content"]
        else:
            merged.append({"role": m["role"], "content": m["content"]})
    return merged


def tool_rounds_only(messages: list) -> list:
    """从「工具循环 delta」里只留真正的工具往返（assistant 的工具调用 / 工具结果），
    丢弃 core 里守卫注入的合成控制消息和核实轮被 UI 隐藏的内心戏——它们是控制信令、不是对话：

    - `_VERIFY_PROMPT` / `_VERIFY_FORCE_PROMPT` / `_NARRATION_NUDGE` / `_INTENT_NUDGE` /
      `_DECISION_NUDGE` 这些合成 user 消息（纯字符串 content，无工具块）；
    - 核实/narration/intent/decision 守卫那几轮的 assistant 文字（纯文本、无 tool_use，UI 已丢弃）。

    这些若落进 ConversationMessage.content_json，下一轮会从 content_json 重建进 LLM 上下文、
    还被压缩/反思吃进去——每轮重复灌「【系统自检】…」白烧 token 且污染行为。最终回复另存为
    assistant text，不在此 delta 里，所以「只留带工具块的消息」不会漏掉真答复。
    判据基于工具块存在性，兼容 provider wire 格式和 canonical tool_call/tool_result。
    """
    out = []
    for m in messages:
        c = m.get("content")
        has_blocks = isinstance(c, list) and any(
            isinstance(b, dict) and b.get("type") in ("tool_use", "tool_call", "tool_result")
            for b in c
        )
        has_openai_call = m.get("role") == "assistant" and bool(m.get("tool_calls"))
        if has_blocks or has_openai_call or m.get("role") == "tool":
            out.append(m)
    return out

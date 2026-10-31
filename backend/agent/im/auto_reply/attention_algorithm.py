"""IM-17 v3.0.6 长消息 ASK、能力操作与延迟介入判定。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from math import exp

import re
import unicodedata

from agent.im.auto_reply.attention import (
    ATTENTION_ALGORITHM_VERSION,
    AttentionDecision,
    AttentionKind,
    AttentionMessage,
    AttentionMode,
    AttentionSnapshot,
    BotReplyFact,
    DEFAULT_ACTIVE_THRESHOLD,
    DEFAULT_NATURAL_THRESHOLD,
    DEFAULT_QUIET_THRESHOLD,
    MEMBER_ACTIVE_TTL_MS,
)

_ACTION_ROOTS = frozenset(
    "看 瞧 望 读 听 闻 摸 尝 观 察 说 讲 聊 问 答 回 述 写 画 唱 演 评 夸 查 找 搜 寻 想 猜 算 数 比 选 判 认 知 记 学 做 弄 搞 改 修 测 试 验 检 排 整 理 分 合 拆 装 设 调 换 转 翻 拍 录 发 传 贴 交 给 送 拿 取 放 存 删 加 减 开 关 启 停 连 接 来 去 走 跑 跳 坐 站 进 出 上 下 带 陪 帮 教".split()
)
# CAPABILITY_ACTION 是独立准入通道；以下词表不参与 v3.0.2 CALL/ASK 评分。
_CAPABILITY_REGISTRY = {
    "project": {
        "aliases": ("待办事项", "项目任务", "任务项", "待办", "项目", "阶段", "任务"),
        "tools": ("list_projects", "create_project", "update_project", "archive_project", "delete_project", "add_stage", "remove_stage", "rename_stage", "update_stage", "get_upcoming"),
    },
    "scheduled_task": {
        "aliases": ("定时任务", "周期任务", "提醒", "闹钟"),
        "tools": ("create_scheduled_task", "update_scheduled_task", "delete_scheduled_task"),
    },
    "calendar": {
        "aliases": ("日历事件", "日程安排", "日历", "日程"),
        "tools": ("create_event", "list_events", "update_event", "delete_event"),
    },
    "note": {
        "aliases": ("思维笔记", "笔记", "记录"),
        "tools": ("note_search", "note_get", "note_create", "note_update", "note_delete", "note_restore", "note_undo"),
    },
    "canvas": {
        "aliases": ("思维画布", "画布"),
        "tools": ("canvas_list", "canvas_get", "canvas_search", "canvas_create", "canvas_delete", "canvas_add_node", "canvas_update_node", "canvas_remove_node"),
    },
    "file": {
        "aliases": ("文件夹", "附件", "文档", "文件"),
        "tools": ("list_dir", "read_file", "grep", "edit_file", "create_file", "rename_file", "copy_file", "delete_file", "move_items", "create_folder", "delete_folder", "save_uploaded_file"),
    },
    "skill": {"aliases": ("技能", "skill"), "tools": ("use_skill",)},
    "contact": {
        "aliases": ("联系人", "通讯录"),
        "tools": ("list_clients", "create_client", "update_client", "delete_client"),
    },
    "email": {"aliases": ("邮件", "电子邮件", "邮箱"), "tools": ("send_email",)},
    "terminal": {"aliases": ("终端", "shell", "命令行"), "tools": ("shell",)},
    "web_search": {
        "aliases": ("网页搜索", "联网搜索", "网页"),
        "tools": ("web_search", "xng_search", "deep_research"),
    },
}
_CAPABILITY_NOUNS = tuple(sorted(
    {alias for capability in _CAPABILITY_REGISTRY.values() for alias in capability["aliases"]},
    key=lambda value: (-len(value), value),
))
_CAPABILITY_ACTION_VERBS = tuple(sorted({
    "创建", "新建", "建立", "设置", "完成", "添加", "生成", "记录", "保存", "整理", "修改", "更新", "调整",
    "搜索", "查找", "查看", "绘制", "删除", "取消", "停止", "关闭", "归档", "分类", "移动",
    "复制", "上传", "下载", "打开", "分析", "总结", "补充", "编辑", "读取", "查询", "获取",
    "执行", "运行", "使用", "调用", "安装", "压缩", "解压", "发送", "展示", "浏览", "连接", "断开", "定", "设", "记", "写",
    "画", "建", "加", "改", "删", "查", "找", "存", "排", "看", "搜", "录", "启", "停", "关", "移",
    "传", "发", "读", "做", "弄", "搞", "处理",
}, key=lambda value: (-len(value), value)))
_CAPABILITY_REQUEST_PREFIXES = (
    "请帮我", "帮我", "帮忙", "帮大家", "麻烦", "给我", "给大家", "替我", "替大家", "请大家", "大家帮忙", "请",
    "能不能帮我", "能帮我", "可以帮我", "帮我们", "需要", "想要", "我想", "我希望",
)
_CAPABILITY_LEADING_FILLERS = tuple(sorted({
    "那就", "然后", "顺便", "那么", "对了", "另外", "还有", "接下来", "接着", "随后",
    "好吧", "好的", "行吧", "那好", "嗯", "那", "就", "再", "请",
}, key=lambda value: (-len(value), value)))
_CAPABILITY_FILLER_CHARS = frozenset("个一这那此该新旧些条张份下来一下的里上中内我你请帮替给快先再")
_CAPABILITY_LOCATION_GAPS = frozenset({"里", "里面", "上", "上面", "中", "内"})
_CAPABILITY_NEGATION = re.compile(r"(?:别|不要|不必|不用|不需要|不想|不愿|无需|勿|莫)(?:再|去|帮我|给我)?$")
_CAPABILITY_NEGATIVE_INTENT = re.compile(r"(?:我|咱们|我们)?(?:不想|不愿|不希望|不要|不需要|不打算).{0,8}$")
_CAPABILITY_PLAN = re.compile(r"^(?:(?:我|咱们|我们)?(?:准备|打算|计划|预备|将要)|我想自己|准备自己|打算自己)")
_CAPABILITY_COMPLETED = re.compile(r"^(?:(?:我|咱们|我们)?(?:已经|已|刚才|刚刚|早就|此前|曾经|完成了|做完了))")
_CAPABILITY_REPORTED = re.compile(r"^(?:(?:他|她|它|别人|某人|有人|群友)(?:们)?(?:刚才|之前|曾经)?(?:让我|叫我|请我|要我|要求我|建议我|说要|说让我|提到|表示)|(?:有)?用户(?:反馈|表示|提到)|(?:文档|原文)(?:中|里)?(?:写道|提到|说明|表示))")
_CAPABILITY_INDIRECT_REPORT = re.compile(r"(?:让我|叫我|请我|要我|要求我|建议我|吩咐我)$")
_CAPABILITY_EVALUATION = re.compile(r"(?:这个功能|该功能|功能不错|功能很好|功能很棒|真的方便|真的好用|很方便|挺方便|挺好|很好|挺好用|很好用|不错|很棒|值得推荐|不容易|很简单|很难|很重要|很麻烦|很复杂|很有用|是好事)")
_CAPABILITY_COMPLETED_SUFFIX = re.compile(r"(?:了|完成|结束|搞定)$")
_CAPABILITY_BARE_REQUEST_TAIL = re.compile(r"(?:(?:一下|一个|一份|个)?(?:吧|啊|呀|呢|嘛|啦|哟|呐)?|就行|即可|就好)?$")
# 正向规则只维护 v3.0.2 定义的单字语素；复合问句由组合规则识别。
# 「咋」是「怎」的口语单字变体，保留其单字形态，不收录「这咋回事」等短语。
_QUESTION_MORPHEMES = frozenset("什么怎何为谁哪几多少否可能是还或与样吗么呢咋")
_QUESTION_OPERATOR_CHARS = frozenset("谁哪几怎咋啥何")
_REPORTING_ROOTS = frozenset("说讲问答回听知懂想觉得称提写引述记报")
_PERSON_REFERENCE_CHARS = frozenset("我你您他她它咱俺吾人谁各众全群")
_REFERENCE_CHARS = frozenset("我你您他她它咱俺吾们人谁各众全群这那此该其某哪啥个些种样事物前后上下里外内旁边左右近远")
_PURE_REACTIONS = frozenset(
    "好 好的 收到 谢谢 嗯 嗯嗯 哦 哦哦 是的 对 对的 没错 懂了 可以 行 ok 好滴 嗯呢 了解 明白 明白了 知道了 "
    "哈哈 哈哈哈 哈哈哈哈 666 草 笑死 笑死了 👍 👌 😂 🤣 好家伙 绷不住了 我笑了".split()
)
_AMBIGUOUS_REACTIONS = frozenset({"确实", "离谱", "太好了", "这也行", "怎么这么离谱"})
_QUESTION_NEGATED_SUGGESTION = re.compile(r"(?:别|不要|不必|不用|不需要|无需|勿|莫).{0,12}吧$")
_GRAMMAR_CHARS = frozenset("我你您他她它咱俺吾们人谁各众全群这那此该其某哪啥个些种样事物前后上下里外内旁边左右近远什么怎何为几多少否可能是还或与吗呢吧啊呀哦嘛请帮替给让使叫快先再试务必不没无别勿莫非未要想愿会应得需肯敢了过着正在已曾将刚又起来去的地得把被对向跟同但而就才因所既并及如")
_SPECIFICITY_NEUTRAL_CHARS = _GRAMMAR_CHARS | _REFERENCE_CHARS | _REPORTING_ROOTS | frozenset("咋")
_CODE_FENCE = re.compile(r"```[^\n]*\n.*?(?:```|\Z)|~~~[^\n]*\n.*?(?:~~~|\Z)", re.S)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_MARKDOWN_QUOTE = re.compile(r"(?m)^\s*>.*(?:\n|$)")
_QUOTED_TEXT = re.compile(r"[“「『\"'][^”」』\"']*[”」』\"']")
_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?；;，,\n])")
_TOPIC_UNIT_MAX_CHARS = 64
_TOPIC_UNITS_PER_MESSAGE = 4
_TOPIC_PAIRS_PER_CANDIDATE = 4


def normalize_text(text: str) -> str:
    """相似度视图：NFKC/casefold，去掉空白和标点。"""
    value = unicodedata.normalize("NFKC", str(text or "")).casefold()
    return "".join(ch for ch in value if ch.isalnum() or "\u4e00" <= ch <= "\u9fff")


def _scene_view(text: str) -> str:
    return re.sub(r"[\t\r\f\v ]+", " ", unicodedata.normalize("NFKC", str(text or ""))).strip()


def _top_level_units(text: str) -> tuple[list[str], bool]:
    """剔除代码、引用及引语后分句；未闭合代码围栏采用保守截断。"""
    source = _scene_view(text)
    uncertain = source.count("```") % 2 == 1 or source.count("~~~") % 2 == 1
    source = _CODE_FENCE.sub(" ", source)
    if uncertain:
        fence_positions = [position for position in (source.find("```"), source.find("~~~")) if position >= 0]
        if fence_positions:
            source = source[:min(fence_positions)]
    source = _INLINE_CODE.sub(" ", source)
    source = _MARKDOWN_QUOTE.sub(" ", source)
    source = _QUOTED_TEXT.sub(" ", source)
    # 保留句末问号给 ASK 判定；其他边界符号不影响场景或话题内容。
    units = [part.strip(" ，,。.!！;；:：\n\t") for part in _SENTENCE_SPLIT.split(source)]
    return [part for part in units if part], uncertain


@dataclass(frozen=True, slots=True)
class _CapabilityMatch:
    strength: str
    start: int
    end: int


def _normalize_text_with_offsets(text: str) -> tuple[str, list[int]]:
    """返回规范化文本及每个字符在输入字符串中的起始位置。"""
    normalized: list[str] = []
    offsets: list[int] = []
    for index, char in enumerate(text):
        for item in unicodedata.normalize("NFKC", char).casefold():
            if item.isalnum() or "\u4e00" <= item <= "\u9fff":
                normalized.append(item)
                offsets.append(index)
    return "".join(normalized), offsets


def _top_level_units_with_offsets(text: str) -> tuple[list[tuple[str, int, int, str | None]], bool, list[int]]:
    """屏蔽代码与引用，保留子句原文区间、结束标点和可见字符前缀计数。"""
    source = str(text or "")
    masked = list(source)
    uncertain = source.count("```") % 2 == 1 or source.count("~~~") % 2 == 1
    for pattern in (_CODE_FENCE, _INLINE_CODE, _MARKDOWN_QUOTE, _QUOTED_TEXT):
        view = "".join(masked)
        for match in pattern.finditer(view):
            for index in range(match.start(), match.end()):
                if masked[index] not in "\r\n":
                    masked[index] = " "
    visible = "".join(masked)
    visible_prefix = [0]
    for char in visible:
        visible_prefix.append(visible_prefix[-1] + (not char.isspace()))

    trim_chars = " \t\r\n，,。.!！;；:："
    units: list[tuple[str, int, int, str | None]] = []
    start = 0
    boundaries = [match.start() for match in _SENTENCE_SPLIT.finditer(visible)]
    for end in (*boundaries, len(visible)):
        left, right = start, end
        terminator = next(
            (visible[index] for index in range(end - 1, start - 1, -1) if not visible[index].isspace()),
            None,
        )
        while left < right and visible[left] in trim_chars:
            left += 1
        while right > left and visible[right - 1] in trim_chars:
            right -= 1
        if left < right and visible[left:right].strip():
            units.append((visible[left:right], left, right, terminator))
        start = end
    return units, uncertain, visible_prefix


def _position_weight(position: float, visible_length: int) -> float:
    alpha = min(1.0, max(0.0, (visible_length - 200) / 600))
    edge_weight = 0.55 + 0.45 * abs(2 * position - 1)
    return 1 - alpha * (1 - edge_weight)


def build_logical_candidates(messages: tuple[AttentionMessage, ...]) -> tuple[AttentionMessage, ...]:
    """只去重并排序，不把附件邻近消息拼接成虚构的文本候选。"""
    ordered = sorted(
        {message.event_id: message for message in messages}.values(),
        key=lambda message: (message.event_received_ms, message.event_id),
    )
    return tuple(replace(message, candidate_text=message.raw_text) for message in ordered)


def _decay(age_seconds: float) -> float:
    if age_seconds < 0 or age_seconds >= 600:
        return 0.0
    end = 2 ** (-600 / 360)
    return max(0.0, min(1.0, (2 ** (-age_seconds / 360) - end) / (1 - end)))


def _is_reported(unit: str) -> bool:
    compact = normalize_text(unit)
    if not compact:
        return False
    # 「我+想+知/问」是信息请求框架，不按嵌入转述排除。
    if compact.startswith("我想知") or compact.startswith("我想问"):
        return False
    group_subject = compact.startswith(("有人", "别人", "群友"))
    if compact[0] in _PERSON_REFERENCE_CHARS or group_subject:
        position = 1
        if position < len(compact) and compact[position] == "们":
            position += 1
        if group_subject:
            position = 2
        while position < min(len(compact), 6) and compact[position] in "刚才之前":
            position += 1
        if position < len(compact) and compact[position] in _REPORTING_ROOTS:
            return True
        if (
            position + 1 < len(compact)
            and compact[position] in "不没无"
            and compact[position + 1] in _REPORTING_ROOTS
        ):
            return True
    # 「听+说」是两个转述词根的组合，不是独立短语词条。
    return len(compact) >= 2 and compact[0] == "听" and compact[1] in _REPORTING_ROOTS


def _lexicon_spans(text: str, lexicon: tuple[str, ...]) -> list[tuple[int, int, str]]:
    """按最长优先取得不重叠词项区间。"""
    candidates = sorted(
        ((match.start(), match.end(), value)
         for value in lexicon
         for match in re.finditer(re.escape(value.casefold()), text.casefold())),
        key=lambda item: (-(item[1] - item[0]), item[0], item[2]),
    )
    selected: list[tuple[int, int, str]] = []
    for candidate in candidates:
        start, end, _value = candidate
        if any(start < other_end and other_start < end for other_start, other_end, _ in selected):
            continue
        selected.append(candidate)
    return sorted(selected)


def _strip_capability_leading_fillers(prefix: str) -> str:
    remainder = prefix
    while remainder:
        filler = next((item for item in _CAPABILITY_LEADING_FILLERS if remainder.startswith(item)), None)
        if filler is None:
            break
        remainder = remainder[len(filler):]
    return remainder


def _has_capability_request_prefix(prefix: str) -> bool:
    for marker in _CAPABILITY_REQUEST_PREFIXES:
        if marker != "请" and prefix.endswith(marker):
            return True
    # 单独的“请”只在句首（可带句首承接词）作为请求框架，不能从叙述前缀中借用。
    return prefix.endswith("请") and not _strip_capability_leading_fillers(prefix[:-1])


def _capability_request_unit(unit: str) -> _CapabilityMatch | None:
    """识别子句内的动作-对象请求，返回类型及其在原子句中的索引。"""
    compact, source_offsets = _normalize_text_with_offsets(unit)
    first_person_want = compact.startswith(("我想", "咱们想", "我们想"))
    if not compact or (_is_reported(unit) and not first_person_want):
        return None
    if _CAPABILITY_REPORTED.search(compact) or _CAPABILITY_PLAN.search(compact):
        return None
    if _CAPABILITY_COMPLETED.search(compact) or _CAPABILITY_EVALUATION.search(compact):
        return None

    object_spans = _lexicon_spans(compact, _CAPABILITY_NOUNS)
    if not object_spans:
        return None
    action_spans = []
    for span in _lexicon_spans(compact, _CAPABILITY_ACTION_VERBS):
        overlaps = [
            item for item in object_spans
            if span[0] < item[1] and item[0] < span[1]
        ]
        exact_ambiguous_alias = (
            len(overlaps) == 1
            and span[:2] == overlaps[0][:2]
            and any(item[:2] != span[:2] for item in object_spans)
        )
        if not overlaps or exact_ambiguous_alias:
            action_spans.append(span)

    # 「不要再提醒我」是停止提醒的当前请求；「提醒」在此是能力对象，
    # 不与自身重叠地充当普通动作词。
    if re.search(r"不要再$", compact[:object_spans[0][0]]) and any(
        noun in {"提醒", "闹钟", "定时任务", "周期任务"}
        for _start, _end, noun in object_spans
    ):
        start, end, _noun = object_spans[0]
        return _CapabilityMatch("strong", source_offsets[start], source_offsets[end - 1] + 1)
    if not action_spans:
        return None

    def matched(action_start: int, action_end: int, object_start: int, object_end: int, strength: str) -> _CapabilityMatch:
        start = min(action_start, object_start)
        end = max(action_end, object_end)
        return _CapabilityMatch(strength, source_offsets[start], source_offsets[end - 1] + 1)

    for action_start, action_end, _action in action_spans:
        prefix = compact[:action_start]
        if _CAPABILITY_INDIRECT_REPORT.search(prefix):
            continue
        if _CAPABILITY_NEGATION.search(prefix) or _CAPABILITY_NEGATIVE_INTENT.search(prefix):
            continue
        for object_start, object_end, _noun in object_spans:
            if action_end <= object_start:
                gap = compact[action_end:object_start]
                if len(gap) > 10 or any(char not in _CAPABILITY_FILLER_CHARS for char in gap):
                    continue
                if _has_capability_request_prefix(prefix):
                    return matched(action_start, action_end, object_start, object_end, "strong")
                bare_prefix = _strip_capability_leading_fillers(prefix)
                if not bare_prefix and action_start <= 4:
                    tail = compact[object_end:]
                    # 裸动作仅接受命令语气尾缀；“创建项目需要注意权限”属于陈述谓语。
                    if (
                        not any(char in compact[:action_start] for char in "不别勿莫")
                        and not _CAPABILITY_COMPLETED_SUFFIX.search(compact[object_end:])
                        and _CAPABILITY_BARE_REQUEST_TAIL.fullmatch(tail)
                    ):
                        return matched(action_start, action_end, object_start, object_end, "weak")
            elif object_end <= action_start:
                gap = compact[object_end:action_start]
                prefix_before_object = compact[:object_start]
                has_object_fronting = (
                    prefix_before_object.startswith(("把", "将", "给"))
                    or gap in _CAPABILITY_LOCATION_GAPS
                )
                has_request_prefix = _has_capability_request_prefix(prefix_before_object)
                if len(gap) <= 5 and (has_object_fronting or has_request_prefix):
                    # “文档中创建项目需要注意权限”不能把“文档中”误当作
                    # 创建动作的前置对象；带位置词且后面另有动作对象时，
                    # 必须由明确祈使尾缀或请求前缀证明这是当前操作请求。
                    later_objects = [
                        item for item in object_spans if item[0] >= action_end
                    ]
                    if (
                        gap in _CAPABILITY_LOCATION_GAPS
                        and later_objects
                        and not has_request_prefix
                        and not prefix_before_object.startswith(("把", "将", "给"))
                    ):
                        final_object_end = max(item[1] for item in later_objects)
                        tail = compact[final_object_end:]
                        if not _CAPABILITY_BARE_REQUEST_TAIL.fullmatch(tail):
                            continue
                    return matched(action_start, action_end, object_start, object_end, "strong")
    return None


def _capability_action_evidence(message: AttentionMessage) -> tuple[_CapabilityMatch, float, float] | None:
    source = message.candidate_text or message.raw_text
    units, _uncertain, visible_prefix = _top_level_units_with_offsets(source)
    visible_length = visible_prefix[-1]
    for unit, unit_start, unit_end, _terminator in units:
        match = _capability_request_unit(unit)
        if match is None:
            continue
        start, end = unit_start + match.start, unit_start + match.end
        if visible_length:
            visible_start = visible_prefix[start]
            visible_end = visible_prefix[end]
            position = (visible_start + visible_end) / (2 * visible_length)
        else:
            position = 0.5
        weight = _position_weight(position, visible_length)
        return _CapabilityMatch(match.strength, start, end), position, weight
    return None


def _has_question_operator(compact: str) -> bool:
    """按 v3.0.2 的单字疑问语素与组合句法识别问句。"""
    for index, char in enumerate(compact):
        following = compact[index + 1] if index + 1 < len(compact) else ""
        previous = compact[index - 1] if index else ""
        if char == "哪" and following == "会":
            # 「哪+会」在「他哪会……」中是反问式否定，不是对当前发送者的提问。
            continue
        if char in _QUESTION_OPERATOR_CHARS:
            return True
        if char == "什" and following == "么":
            return True
        if char == "怎" and following and following in "么样":
            return True
        if char == "为" and following and following in "什何啥":
            return True
        if char == "多" and following == "少":
            return True
        if char == "否" and previous and previous in "是能可":
            return True
        if char in "不没" and previous and following == previous:
            return True
        if char == "还" and following == "是":
            return True
    return False


def _action_occurrence(unit: str) -> tuple[str, int, int] | None:
    compact = normalize_text(unit)
    matches = [
        (position, -len(root), root)
        for root in _ACTION_ROOTS
        if (position := compact.find(root)) >= 0
    ]
    if not matches:
        return None
    position, _length, root = min(matches)
    return root, position, position + len(root)


def _call_score(unit: str, aliases: tuple[str, ...]) -> float:
    compact = normalize_text(unit)
    if not compact or _is_reported(unit):
        return 0.0
    normalized_aliases = tuple(sorted({normalize_text(alias) for alias in aliases if normalize_text(alias)}, key=len, reverse=True))
    alias = next((item for item in normalized_aliases if compact.startswith(item)), None)
    addressee = bool(alias)
    remainder = compact[len(alias):] if alias else compact
    # 泛用“请/帮我/麻烦”请求默认以当前 Bot 为执行者；多人/群体主语不满足此规则。
    if not addressee:
        addressee = bool(re.match(r"^(?:请|麻烦|帮我|帮忙|能否|可以)(?!大家|各位|你们)", compact))
        remainder = re.sub(r"^(?:请|麻烦|帮我|帮忙|能否|可以)", "", compact, count=1) if addressee else compact
    if not addressee or not remainder:
        return 0.0

    # 句首别名可能是陈述主语；先排除显式状态、完成体、趋向补语和转述。
    if re.search(r"(?:起来|过了|到了|走了|来了|说了|讲了|看着|正在|已经|想起了|知道了)", remainder):
        return 0.0
    occurrence = _action_occurrence(remainder)
    if not occurrence:
        return 0.0
    root, start, end = occurrence
    tail = remainder[end:]
    if not tail and root in {"说", "讲", "问", "想", "知", "懂", "觉", "得"}:
        return 0.0
    if re.search(r"(?:了|过|着|在|已|曾|将|起来|起来了|出来了)$", tail):
        return 0.0

    # N×V×K: 强祈使、明确任务对象、裸动作三档。
    imperative = bool(
        re.search(r"(?:吧|快|赶快|快点|别|请|一下|帮我|帮忙|给我|替我|为我)$", remainder[:end + 1] + tail)
        or re.search(r"(.)\1(?:这个|一下|一遍|看看|说说|读读|查查|试试|想想)?", remainder)
        or re.match(r"^(?:别|勿|莫|快|赶快|快点)", remainder)
        or re.match(r"^(?:帮|替|给|让|叫)", remainder)
    )
    if imperative:
        return 0.92
    # 具体宾语：动作后出现指示词或未限定的内容成分。
    has_object = bool(tail and not re.fullmatch(r"(?:吗|呢|吧|啊|呀|哦|嘛|哈|哇|呐|啦|哟|了|过|着)?", tail))
    if has_object:
        return 0.92 * 0.9
    return 0.92 * 0.8


def _question_strength(unit: str) -> float:
    return _question_evidence(unit)[0]


def _question_evidence(unit: str) -> tuple[float, bool]:
    raw = unicodedata.normalize("NFKC", unit).strip()
    compact = normalize_text(raw)
    if not compact or compact in {"?", "？"} or _is_reported(raw):
        return 0.0, False
    has_mark = "?" in raw or "？" in raw
    if has_mark and compact in _AMBIGUOUS_REACTIONS:
        return 0.85, False
    # 这些是语法框架（我/想/知、请/问），不是正向短语词条。
    request_scaffold = False
    if compact.startswith("我") and len(compact) >= 3 and compact[1] in "想要" and compact[2] in "知问":
        compact = compact[3:]
        request_scaffold = True
    elif compact.startswith("想") and len(compact) >= 2 and compact[1] in "知问":
        compact = compact[2:]
        request_scaffold = True
    elif compact.startswith("请问"):
        compact = compact[2:]
        request_scaffold = True

    has_operator = _has_question_operator(compact)
    has_final_marker = compact.endswith(tuple("吗么呢"))
    if not (request_scaffold or has_operator or has_final_marker or has_mark):
        return 0.0, request_scaffold

    # 句末问号不能把否定劝告升级为提问；如“不要出来玩了吧？”。
    # 这类结构没有独立疑问算子时按非提问处理。
    if has_mark and not (has_operator or request_scaffold) and _QUESTION_NEGATED_SUGGESTION.search(compact):
        return 0.0, request_scaffold

    payload = "".join(char for char in compact if char not in _SPECIFICITY_NEUTRAL_CHARS)
    if has_operator or request_scaffold:
        return (1.0 if payload else 0.85), request_scaffold
    if has_final_marker:
        return (1.0 if len(payload) > 1 else 0.85), request_scaffold
    if has_mark:
        # 问号只证明有疑问语气，不能单独证明是明确、具体的提问。
        return 0.85, request_scaffold
    return 0.0, request_scaffold


def _scene_score_details(message: AttentionMessage, aliases: tuple[str, ...]):
    raw_text = message.candidate_text or message.raw_text
    units, uncertain = _top_level_units(raw_text)
    ask_units, _ask_uncertain, visible_prefix = _top_level_units_with_offsets(raw_text)
    visible_length = visible_prefix[-1]
    normalized_aliases = {normalize_text(alias) for alias in aliases if normalize_text(alias)}
    expanded_units = []
    for index, unit in enumerate(units):
        if normalize_text(unit) in normalized_aliases and index + 1 < len(units):
            expanded_units.append(unit + units[index + 1])
        else:
            expanded_units.append(unit)
    best, kind = 0.0, None
    ask_raw_score, ask_position_weight, ask_adjusted_score = 0.0, 1.0, 0.0
    ask_span_start = ask_span_end = None
    for unit in expanded_units:
        call = _call_score(unit, aliases)
        if call > best:
            best, kind = call, "CALL"
    ask_punctuation_weight = 1.0
    for index, (unit, start, end, terminator) in enumerate(ask_units):
        expanded = unit
        expanded_end = end
        if normalize_text(unit) in normalized_aliases and index + 1 < len(ask_units):
            expanded += ask_units[index + 1][0]
            expanded_end = ask_units[index + 1][2]
        strength, request_scaffold = _question_evidence(expanded)
        if not strength:
            continue
        raw_ask = 0.90 * strength
        visible_start = visible_prefix[start]
        visible_end = visible_prefix[expanded_end]
        position = (visible_start + visible_end) / (2 * visible_length) if visible_length else 0.5
        explicit_target = any(normalize_text(expanded).startswith(alias) for alias in normalized_aliases)
        weight = 1.0 if explicit_target else _position_weight(position, visible_length)
        punctuation_weight = (
            0.65 if terminator == "。" and not request_scaffold and not explicit_target else 1.0
        )
        adjusted_ask = raw_ask * weight * punctuation_weight
        if adjusted_ask > ask_adjusted_score:
            ask_raw_score = raw_ask
            ask_position_weight = weight
            ask_punctuation_weight = punctuation_weight
            ask_adjusted_score = adjusted_ask
            ask_span_start, ask_span_end = start, expanded_end
        if adjusted_ask > best:
            best, kind = adjusted_ask, "ASK"
    return (
        best, kind, uncertain, ask_raw_score, ask_position_weight, ask_punctuation_weight,
        ask_adjusted_score, ask_span_start, ask_span_end,
    )


def _scene_score(message: AttentionMessage, aliases: tuple[str, ...]) -> tuple[float, str | None, bool]:
    score, kind, uncertain, *_diagnostics = _scene_score_details(message, aliases)
    return score, kind, uncertain


def _pure_reaction(message: AttentionMessage) -> bool:
    units, _ = _top_level_units(message.candidate_text or message.raw_text)
    if len(units) != 1:
        return False
    value = unicodedata.normalize("NFKC", units[0]).casefold().strip(" \t\r\n，,。.!！~～")
    return value in _PURE_REACTIONS


def _ambiguous_pure_reaction(message: AttentionMessage) -> bool:
    raw = unicodedata.normalize("NFKC", message.candidate_text or message.raw_text).strip()
    value = raw.casefold().strip(" \t\r\n，,。.!！~～")
    return value in _AMBIGUOUS_REACTIONS and "?" not in raw and "？" not in raw


def _definitively_other_recipient(message: AttentionMessage) -> bool:
    if message.mentioned_current_bot is True:
        return False
    if message.mentioned_other_bot is True or message.mentioned_other_member is True:
        return True
    return message.reply_to_platform_message_id is not None and message.reply_target_is_bot is False


def _verified_substantive_reply(message: AttentionMessage, snapshot: AttentionSnapshot) -> bool:
    if message.reply_target_is_bot is not True or not message.reply_to_platform_message_id or not message.sender_id:
        return False
    fact = snapshot.bot_replies.get(message.reply_to_platform_message_id)
    if not fact or not fact.accepted or fact.recipient_sender_id != message.sender_id:
        return False
    if _pure_reaction(message):
        return False
    units, _ = _top_level_units(message.candidate_text or message.raw_text)
    return any(len(normalize_text(unit)) >= 3 for unit in units)


def _member_active_reply(message: AttentionMessage, snapshot: AttentionSnapshot) -> BotReplyFact | None:
    """返回当前发送者 180 秒成员激活窗口内的已接受最终回复。"""
    if not message.sender_id:
        return None
    qualifying_sources = {
        "DIRECT", "member_CONTINUE", "CAPABILITY_ACTION",
        "proactive", "autonomous", "member_ACTIVE",
    }
    for fact in snapshot.accepted_outbound_facts:
        age_ms = message.event_received_ms - fact.sent_at_ms
        if (
            fact.accepted
            and fact.recipient_sender_id == message.sender_id
            and fact.source_attention_kind in qualifying_sources
            and 0 < age_ms < MEMBER_ACTIVE_TTL_MS
        ):
            return fact
    return None


def _longest_common_substring(left: str, right: str) -> int:
    previous = [0] * (len(right) + 1)
    best = 0
    for i, char_left in enumerate(left, 1):
        current = [0] * (len(right) + 1)
        for j, char_right in enumerate(right, 1):
            if char_left == char_right:
                current[j] = previous[j - 1] + 1
                best = max(best, current[j])
        previous = current
    return best


def _cp_similarity(current: str, candidate: str) -> tuple[float, float, int]:
    left, right = normalize_text(current), normalize_text(candidate)
    if not left or not right:
        return 0.0, 0.0, 0
    if right in left:
        coverage = len(right) / len(left)
        phrase = 1 - exp(-max(0, len(right) - 3) / 4)
        return 0.5 * coverage + 0.5 * phrase, coverage, len(right)
    if left.isascii() and right.isascii() and not (set(left) & set(right)):
        return 0.0, 0.0, 0
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    common = sum(block.size for block in matcher.get_matching_blocks())
    coverage = common / len(left)
    longest = _longest_common_substring(left, right)
    phrase = 1 - exp(-max(0, longest - 3) / 4)
    return 0.5 * coverage + 0.5 * phrase, coverage, longest


def _levenshtein(left: str, right: str) -> int:
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, char_left in enumerate(left, 1):
        current = [i]
        for j, char_right in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (char_left != char_right)))
        previous = current
    return previous[-1]


def _effective_edit_text(text: str) -> str:
    value = normalize_text(text)
    value = re.sub(r"(?:啊|呀|呢|吧)+$", "", value)
    # 只按 v3.0.2 去掉可确认的句末语气助词，不裁掉整段问句/代词模板。
    return value or normalize_text(text)


def _edit_similarity(current: str, candidate: str) -> tuple[float, tuple[int, int] | None]:
    left, right = normalize_text(current), normalize_text(candidate)
    if not left or not right:
        return 0.0, None
    if left in right or right in left:
        return 0.0, None
    effective = _effective_edit_text(current)
    if not effective:
        return 0.0, None
    ngrams: dict[str, list[int]] = defaultdict(list)
    for j in range(len(right) - 1):
        ngrams[right[j:j + 2]].append(j)
    anchors: list[tuple[int, int]] = []
    for i in range(len(left) - 1):
        matches = ngrams.get(left[i:i + 2], ())
        if not matches:
            continue
        # Repeated n-grams are sampled across the candidate so a long repeated
        # document cannot make anchor discovery quadratic.
        sample_count = min(3, len(matches))
        sampled = sorted({matches[round(k * (len(matches) - 1) / max(1, sample_count - 1))] for k in range(sample_count)})
        anchors.extend((i, j) for j in sampled)
        if len(anchors) >= 24:
            break
    pairs: set[tuple[int, int, int, int]] = set()
    for i, j in anchors:
        # Try short local fragments first, extending independently around the
        # shared 2-gram. Both candidate count and fragment length are bounded.
        for left_length in range(3, 13):
            if left_length / max(1, len(effective)) < 0.5:
                continue
            for right_length in range(max(3, left_length - 2), min(12, left_length + 2) + 1):
                left_starts = range(max(0, i - left_length + 2), min(i, len(left) - left_length) + 1)
                right_starts = range(max(0, j - right_length + 2), min(j, len(right) - right_length) + 1)
                for left_start in left_starts:
                    for right_start in right_starts:
                        pairs.add((left_start, left_start + left_length, right_start, right_start + right_length))
                        if len(pairs) >= 256:
                            break
                    if len(pairs) >= 256:
                        break
                if len(pairs) >= 256:
                    break
            if len(pairs) >= 256:
                break
        if len(pairs) >= 256:
            break

    best, best_lengths = 0.0, None
    for left_start, left_end, right_start, right_end in sorted(pairs):
        a, b = left[left_start:left_end], right[right_start:right_end]
        distance = _levenshtein(a, b)
        if not 1 <= distance <= 2 or max(len(a), len(b)) > 12:
            continue
        if a in b or b in a or a.startswith(b) or b.startswith(a) or a.endswith(b) or b.endswith(a):
            continue
        common = set(a) & set(b)
        if common and all(char in _GRAMMAR_CHARS for char in common):
            continue
        score = 1 - distance / max(len(a), len(b))
        if score > best:
            best, best_lengths = score, (len(a), len(b))
    return best, best_lengths


def _topic_units(text: str) -> list[str]:
    units, _ = _top_level_units(text)
    fragments = []
    for unit in units:
        normalized = normalize_text(unit)
        if not normalized:
            continue
        fragments.extend(
            normalized[offset:offset + _TOPIC_UNIT_MAX_CHARS]
            for offset in range(0, len(normalized), _TOPIC_UNIT_MAX_CHARS)
        )
    if len(fragments) <= _TOPIC_UNITS_PER_MESSAGE:
        return fragments
    last = len(fragments) - 1
    indices = sorted({round(index * last / (_TOPIC_UNITS_PER_MESSAGE - 1)) for index in range(_TOPIC_UNITS_PER_MESSAGE)})
    return [fragments[index] for index in indices]


def _topic_unit_pair_rank(current: str, candidate: str) -> tuple[int, int]:
    current_bigrams = {current[index:index + 2] for index in range(len(current) - 1)}
    candidate_bigrams = {candidate[index:index + 2] for index in range(len(candidate) - 1)}
    overlap = len(current_bigrams & candidate_bigrams)
    character_overlap = len(set(current) & set(candidate))
    return overlap, character_overlap


def _has_valid_topic_anchor(message: AttentionMessage, snapshot: AttentionSnapshot) -> bool:
    anchor = snapshot.latest_accepted_final
    if not snapshot.complete or not anchor or not anchor.accepted or not anchor.final_text:
        return False
    age = (message.event_received_ms - anchor.sent_at_ms) / 1000
    return 0 <= age < 600


def _topic_evidence(message: AttentionMessage, snapshot: AttentionSnapshot) -> tuple[float, float, str | None, tuple[int, int] | None]:
    anchor = snapshot.latest_accepted_final
    if not _has_valid_topic_anchor(message, snapshot):
        return 0.0, 0.0, None, None
    age = (message.event_received_ms - anchor.sent_at_ms) / 1000
    decay = _decay(age)
    if decay <= 0:
        return 0.0, 0.0, None, None

    timeline: dict[str, AttentionMessage] = {}
    for item in snapshot.messages:
        if (item.platform, item.bot_id, item.group_id) != (message.platform, message.bot_id, message.group_id):
            continue
        if item.event_id == message.event_id or item.sender_is_bot is True:
            continue
        if item.event_received_ms >= message.event_received_ms:
            continue
        timeline[item.event_id] = item
    anchor_msg = None
    accepted_facts = snapshot.accepted_outbound_facts or (anchor,)
    for fact in accepted_facts:
        if not fact.accepted or not fact.final_text or fact.sent_at_ms > message.event_received_ms:
            continue
        outbound = AttentionMessage(
            event_id=fact.delivery_id or fact.platform_message_id or f"outbound-{fact.sent_at_ms}",
            platform=message.platform, bot_id=message.bot_id, group_id=message.group_id,
            platform_message_id=fact.platform_message_id or None, sender_id=None,
            event_received_ms=fact.sent_at_ms, platform_sent_ms=fact.sent_at_ms,
            raw_text=fact.final_text, media_only=False, media_kinds=(), processable_media=None,
            mentioned_current_bot=False, mentioned_other_bot=False, mentioned_other_member=False,
            has_unresolved_mention=False, reply_to_platform_message_id=None,
            reply_target_sender_id=None, reply_target_is_bot=None, quote_text=None,
            sender_is_bot=True, candidate_text=fact.final_text,
        )
        timeline[outbound.event_id] = outbound
        if fact.delivery_id == anchor.delivery_id or fact.platform_message_id == anchor.platform_message_id:
            anchor_msg = outbound
    if anchor_msg is None:
        return 0.0, 0.0, None, None
    ordered = sorted(timeline.values(), key=lambda item: (item.event_received_ms, item.event_id))
    anchor_index = next((i for i, item in enumerate(ordered) if item.event_id == anchor_msg.event_id), None)
    if anchor_index is None:
        return 0.0, 0.0, None, None
    candidates = ordered[max(0, anchor_index - 5):anchor_index] + [anchor_msg] + ordered[anchor_index + 1:anchor_index + 6]
    current_units = _topic_units(message.candidate_text or message.raw_text)
    best_r, best_id, best_lengths = 0.0, None, None
    for candidate in candidates:
        candidate_units = _topic_units(candidate.candidate_text or candidate.raw_text)
        ranked_pairs = sorted(
            (
                (*_topic_unit_pair_rank(current_unit, candidate_unit), -current_index, -candidate_index, current_unit, candidate_unit)
                for current_index, current_unit in enumerate(current_units)
                for candidate_index, candidate_unit in enumerate(candidate_units)
            ),
            reverse=True,
        )
        for _bigram_overlap, _character_overlap, _current_order, _candidate_order, current_unit, candidate_unit in ranked_pairs[:_TOPIC_PAIRS_PER_CANDIDATE]:
            cp, _, _ = _cp_similarity(current_unit, candidate_unit)
            edit, lengths = _edit_similarity(current_unit, candidate_unit)
            score = max(cp, edit)
            if score > best_r:
                best_r, best_id, best_lengths = score, candidate.event_id, lengths
    topic_score = best_r * decay ** 0.25
    return topic_score, best_r, best_id, best_lengths


def score_attention(message: AttentionMessage, snapshot: AttentionSnapshot, *, bot_aliases: tuple[str, ...] = ()) -> AttentionDecision:
    """返回不经过模式阈值的 v3.0.6 情景、话题及实验诊断。"""
    if message.sender_is_bot is True or not message.event_id:
        return AttentionDecision(AttentionKind.PASSIVE, 0.0, None, ("invalid_or_bot_echo",), state="COLD")
    if message.mentioned_current_bot is True:
        return AttentionDecision(AttentionKind.DIRECT, 100.0, 0, ("native_mention",), state="COLD")
    if _definitively_other_recipient(message):
        return AttentionDecision(AttentionKind.EXCLUDED, 0.0, None, ("other_recipient",), state="COLD")
    if _verified_substantive_reply(message, snapshot):
        return AttentionDecision(AttentionKind.CONTINUE, 100.0, 0, ("verified_substantive_reply",), state="TOPIC")
    raw_text = message.candidate_text or message.raw_text
    if not raw_text.strip():
        return AttentionDecision(AttentionKind.PASSIVE, 0.0, None, ("empty_message",), state="COLD")
    if _pure_reaction(message) or _ambiguous_pure_reaction(message):
        return AttentionDecision(AttentionKind.PASSIVE, 0.0, None, ("pure_short_reaction",), state="COLD")
    if raw_text.strip() in {"?", "？"}:
        return AttentionDecision(AttentionKind.PASSIVE, 0.0, None, ("bare_question_mark",), state="COLD")

    capability_evidence = _capability_action_evidence(message)
    if capability_evidence is not None:
        capability_match, _capability_position, capability_weight = capability_evidence
        return AttentionDecision(
            AttentionKind.CAPABILITY_ACTION,
            None,
            None,
            ("capability_action",),
            state="CAPABILITY_ACTION",
            capability_strength=capability_match.strength,
            capability_span_start=capability_match.start,
            capability_span_end=capability_match.end,
            capability_position_weight=capability_weight,
        )

    if _member_active_reply(message, snapshot) is not None:
        return AttentionDecision(
            AttentionKind.MEMBER_ACTIVE,
            100.0,
            None,
            ("member_active_window",),
            score_breakdown=(("member_active", 1.0),),
            state="MEMBER_ACTIVE",
        )

    (
        scene, scene_type, segmentation_uncertain, ask_raw_score,
        ask_position_weight, ask_punctuation_weight, ask_adjusted_score,
        ask_span_start, ask_span_end,
    ) = _scene_score_details(message, bot_aliases or ("咕咕",))
    topic, raw_topic, match_id, match_lengths = _topic_evidence(message, snapshot)
    state = "TOPIC" if _has_valid_topic_anchor(message, snapshot) else "COLD"
    score = 100 * (scene + topic - scene * topic) if state == "TOPIC" else 100 * scene
    reasons = [f"state_{state.lower()}"]
    if scene_type:
        reasons.append(f"scene_{scene_type.lower()}")
    if topic:
        reasons.append("topic_match")
    if segmentation_uncertain:
        reasons.append("segmentation_uncertain")
    return AttentionDecision(
        AttentionKind.PROACTIVE if score > 0 else AttentionKind.PASSIVE,
        score,
        None,
        tuple(reasons),
        score_breakdown=(
            ("scene", scene), ("topic", topic),
            ("ask_raw", ask_raw_score),
            ("ask_position_weight", ask_position_weight),
            ("ask_punctuation_weight", ask_punctuation_weight),
            ("ask_adjusted", ask_adjusted_score),
        ),
        state=state,
        scene_type=scene_type,
        scene_score=scene,
        topic_score=topic,
        topic_raw_score=raw_topic,
        anchor_event_id=(
            snapshot.latest_accepted_final.delivery_id
            if state == "TOPIC" and snapshot.latest_accepted_final else None
        ),
        topic_match_event_id=match_id,
        matched_span_lengths=match_lengths,
        ask_raw_score=ask_raw_score,
        ask_position_weight=ask_position_weight,
        ask_punctuation_weight=ask_punctuation_weight,
        ask_adjusted_score=ask_adjusted_score,
        ask_span_start=ask_span_start,
        ask_span_end=ask_span_end,
    )


def decide_attention(
    message: AttentionMessage,
    snapshot: AttentionSnapshot,
    mode: AttentionMode,
    *,
    bot_aliases: tuple[str, ...] = (),
    natural_threshold: int = DEFAULT_NATURAL_THRESHOLD,
    active_threshold: int = DEFAULT_ACTIVE_THRESHOLD,
    quiet_threshold: int = DEFAULT_QUIET_THRESHOLD,
) -> AttentionDecision:
    """唯一生产决策入口。"""
    result = score_attention(message, snapshot, bot_aliases=bot_aliases)
    if result.kind in {
        AttentionKind.DIRECT, AttentionKind.CONTINUE,
        AttentionKind.CAPABILITY_ACTION, AttentionKind.MEMBER_ACTIVE,
        AttentionKind.EXCLUDED,
    }:
        return result
    if mode is AttentionMode.AUTONOMOUS:
        if any(reason in result.reasons for reason in ("invalid_or_bot_echo", "empty_message", "pure_short_reaction", "bare_question_mark")):
            return result
        return replace(result, kind=AttentionKind.ALLOW_RUN, threshold=None, reasons=(*result.reasons, "autonomous_mode"))
    if result.kind is AttentionKind.PASSIVE and result.score == 0:
        return result
    threshold = {
        AttentionMode.QUIET: quiet_threshold,
        AttentionMode.NATURAL: natural_threshold,
        AttentionMode.ACTIVE: active_threshold,
    }[mode]
    if (result.score or 0) < threshold:
        return replace(result, kind=AttentionKind.PASSIVE, threshold=threshold, reasons=(*result.reasons, "below_threshold"))
    return replace(result, kind=AttentionKind.PROACTIVE, threshold=threshold, reasons=(*result.reasons, "threshold_reached"))


__all__ = ["build_logical_candidates", "decide_attention", "normalize_text", "score_attention"]

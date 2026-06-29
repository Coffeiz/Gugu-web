"""轻量 Intent Router（精简版）。

网关在**入队前**调用 `decide(text, state)`。**刻意只保留两件确定性的短路**，其余一律进主模型：
- 斜杠命令 `/stop` `/status` `/help`（显式、确定）。
- 咕咕**正忙时**回答「是否在思考」类进度追问（还在吗 / 查了吗 / 好了吗 / 进度）→ 回一句状态、不打断。

**去掉了原先的关键词短路**（嗯/好/谢谢、催、算了…）：它会把『好/嗯』这类确认 / 真实意图当闲聊吞掉、
又把带话题的句子误判（如「法拉利怎么这么慢」当成催咕咕）。现在这些一律交主模型，由它据上下文回应。
取消改走显式 `/stop`（不再靠「算了」关键词猜）。`classify()` 仅历史保留、decide 不再用。
"""
from agent import runtime_state as st

# intent
PROGRESS = "progress"
CANCEL   = "cancel"
EMOTION  = "emotion"
ACK      = "ack"
AGENT    = "agent"

_STRIP = " \t\n　。，、！？!?.~～…"

# 纯标点/语气的进度追问（strip 前先判，否则会被去标点成空）
_PUNCT_PROGRESS = {"?", "？", "??", "？？", "...", "。。。", "…", "在?", "在？"}

# 整条命中（去标点后）才算闲聊确认
_ACK = {
    "嗯", "嗯嗯", "嗯呢", "好", "好的", "好滴", "好哒", "行", "行吧", "成", "中",
    "哦", "哦哦", "噢", "ok", "okay", "okk", "k", "收到", "了解", "明白", "懂了",
    "谢谢", "谢了", "多谢", "thanks", "thx", "哈哈", "哈哈哈", "嘿嘿", "赞", "👍", "👌", "🙏",
}

# 整条命中（去标点后）才算「是否在思考」的进度追问（仅咕咕在忙时短路回状态）
_PROGRESS = {
    "还在吗", "在吗", "在不在", "好了吗", "好了没", "弄好了吗", "完成了吗", "做完了吗",
    "查了吗", "查到了吗", "查好了吗", "搜到了吗", "搜好了吗", "找到了吗", "找到没",
    "怎么没反应", "怎么没回", "怎么没动静", "咋还没好", "进度", "进度呢", "怎么样了", "咋样了", "到哪了",
    "进度怎么样了", "进度怎么样", "进度如何", "现在怎么样了", "做到哪了", "弄到哪了",
}

# 短消息内包含即判（≤12 字，长句多半是真任务）
_CANCEL_KW  = ["算了", "不用了", "不弄了", "别弄了", "别分析了", "先别弄", "先别", "停一下",
               "停下", "先停", "不做了", "取消", "别搞了", "先不弄", "不想弄了"]
_EMOTION_KW = ["急", "快点", "快快", "怎么还没", "怎么这么慢", "太慢", "等不及"]
# 催词只在「整句基本就是这句催」时才判——句首，或仅「你/咕咕」指向咕咕的前缀。
# 否则子串匹配会把带话题主语的「法拉利怎么这么慢」「这电脑太慢」也当成催咕咕而误短路。
_EMOTION_LEAD = ("", "你", "咕咕", "你这", "咕咕你", "你怎么", "咕咕怎么")
def _is_emotion(t: str) -> bool:
    return any(t.startswith(lead + k) for lead in _EMOTION_LEAD for k in _EMOTION_KW)

# ── 斜杠强制命令（确定性，绕过关键词分类——最可靠的中断/控制手段）──
# body（去掉前导 /）小写后查表 → 命令名；非命令（如粘贴的路径 /Users/..）返回 None 走正常对话
_CMD = {
    "stop": "stop", "s": "stop", "cancel": "stop", "x": "stop",
    "停": "stop", "停止": "stop", "取消": "stop", "停下": "stop",
    "status": "status", "状态": "status", "进度": "status",
    "help": "help", "h": "help", "帮助": "help", "菜单": "help", "命令": "help",
}
_HELP_TEXT = (
    "🤖 可用命令（确定性、立即生效）：\n"
    "/stop　停止当前任务\n"
    "/status　看当前进度\n"
    "/help　这份帮助"
)


def parse_command(text: str) -> str | None:
    """识别 `/stop` 这类斜杠命令；半角/全角斜杠都认。非命令返回 None。"""
    t = (text or "").strip()
    if t[:1] not in ("/", "／"):
        return None
    return _CMD.get(t[1:].strip().lower())


def classify(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return AGENT
    if raw in _PUNCT_PROGRESS:
        return PROGRESS
    t = raw.strip(_STRIP)
    if not t:
        return AGENT
    if t in _ACK:
        return ACK
    if t in _PROGRESS:
        return PROGRESS
    if len(t) <= 12:
        if any(k in t for k in _CANCEL_KW):
            return CANCEL
        if _is_emotion(t):
            return EMOTION
    return AGENT


# 状态 → 进度话术
_PROGRESS_REPLY = {
    st.THINKING:        "还在想哦，稍等一下下～",
    st.SEARCHING:       "正在查资料，可能还要几秒～",
    st.GENERATING:      "正在整理内容，马上就好～",
    st.WAITING_CONFIRM: "在等你确认那一步哦～",
    st.IDLE:            "在的，你说～",
}
_EMOTION_BUSY = "马上好啦，我加把劲儿～"
_ACK_REPLY    = "嗯嗯～"
_CANCEL_REPLY = "好的，那这个先不继续啦～"


# 咕咕上一条回复以「问句 / 征询确认」收尾 → worker 置 awaiting 标志，网关读到后让这轮的
# 「嗯 / 好 / 算了」放行进 agent（否则确认被当闲聊 drop/秒回吞掉，主模型永远收不到）。
_AWAIT_MARKERS = ("要不要", "需要我", "要我", "好不好", "好吗", "行吗", "可以吗", "对吗",
                  "是不是", "确认一下", "要吗", "成不成", "好不")


def reply_awaits_answer(text: str) -> bool:
    """咕咕这条回复是否在『等用户回答』——以问句/确认收尾。worker 据此置 awaiting 标志。"""
    t = (text or "").strip()
    if not t:
        return False
    if "？" in t[-16:] or "?" in t[-16:]:   # 结尾带问号（容忍后面跟 emoji/引号）
        return True
    return any(m in t[-24:] for m in _AWAIT_MARKERS)


def _is_progress(text: str) -> bool:
    """整条是『还在吗 / 查了吗 / 好了吗 / 进度』这类「是否在思考」的进度追问。"""
    raw = (text or "").strip()
    if raw in _PUNCT_PROGRESS:
        return True
    t = raw.strip(_STRIP)
    return bool(t) and t in _PROGRESS


def decide(text: str, state: str, awaiting: bool = False) -> dict:
    """返回 {action, reply?}。action：'reply'(短路直接回) / 'cancel'(置取消标志+回) / 'agent'(入队给主 Agent)。

    **精简版**：只做两件确定性短路，其余一律 'agent' 交主模型——
      ① 斜杠命令 /stop /status /help；
      ② 咕咕**正忙时**的进度追问（还在吗/查了吗/好了吗/进度）→ 回一句状态、不打断、不重复入队。
    **不再用关键词把「嗯/好/谢谢/催/算了」短路掉**（曾把确认吞掉、把带话题的句子误判）。
    `awaiting` 保留兼容、当前不参与路由；取消走显式 `/stop`。
    """
    busy = bool(state and state != st.IDLE)

    cmd = parse_command(text)
    if cmd == "stop":
        return ({"action": "cancel", "reply": "🛑 已停止当前任务"} if busy
                else {"action": "reply", "reply": "现在没有在跑的任务哦～"})
    if cmd == "status":
        return {"action": "reply", "reply": _PROGRESS_REPLY.get(state, _PROGRESS_REPLY[st.IDLE])}
    if cmd == "help":
        return {"action": "reply", "reply": _HELP_TEXT}

    # 只保留「是否在思考」的进度追问：咕咕在忙、且整条是进度问询 → 回状态、别打断；其余全进 agent
    if busy and _is_progress(text):
        return {"action": "reply", "reply": _PROGRESS_REPLY.get(state, _PROGRESS_REPLY[st.IDLE])}
    return {"action": "agent"}

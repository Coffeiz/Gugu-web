"""轻量 Intent Router（关键词 + 状态机）。

网关在**入队前**调用 `decide(text, state)`：据当前 State Manager 状态决定——
- 状态查询（还在吗）/ 情绪（急、快点）/ 闲聊确认（嗯、好的）→ 短路，网关直接回话术、不进主模型、不入队
- 取消（算了、停一下）→ 置取消标志 + 回话术（core 工具循环协作中断）
- 其余 → 正常入队给主 Agent

关键词版（P0）。将来换小模型分类（输出 `{intent, confidence}`）时 `decide()` 接口不变。
原则：**短词歧义大，宁可漏判进主模型、不误判短路**——整条消息匹配，取消/情绪只在短消息上判。
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

# 整条命中（去标点后）才算状态查询
_PROGRESS = {
    "还在吗", "在吗", "在不在", "好了吗", "好了没", "弄好了吗", "完成了吗", "做完了吗",
    "怎么没反应", "怎么没回", "怎么没动静", "咋还没好", "进度", "进度呢", "怎么样了", "咋样了", "到哪了",
    "进度怎么样了", "进度怎么样", "进度如何", "现在怎么样了", "做到哪了", "弄到哪了",
}

# 短消息内包含即判（≤12 字，长句多半是真任务）
_CANCEL_KW  = ["算了", "不用了", "不弄了", "别弄了", "别分析了", "先别弄", "先别", "停一下",
               "停下", "先停", "不做了", "取消", "别搞了", "先不弄", "不想弄了"]
_EMOTION_KW = ["急", "快点", "快快", "怎么还没", "怎么这么慢", "太慢", "等不及"]

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
        if any(k in t for k in _EMOTION_KW):
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


def decide(text: str, state: str) -> dict:
    """返回 {action, reply?}。
    action：
      'reply'  网关直接回 reply（短路，不入队）
      'cancel' 置取消标志 + 回 reply（不入队）
      'drop'   忽略（不回不入队）
      'agent'  正常入队给主 Agent
    """
    busy = state and state != st.IDLE

    # 斜杠强制命令优先：确定性、绕过关键词分类。/stop 无条件置取消标志（不靠"是否判定为忙"）
    cmd = parse_command(text)
    if cmd == "stop":
        return ({"action": "cancel", "reply": "🛑 已停止当前任务"} if busy
                else {"action": "reply", "reply": "现在没有在跑的任务哦～"})
    if cmd == "status":
        return {"action": "reply", "reply": _PROGRESS_REPLY.get(state, _PROGRESS_REPLY[st.IDLE])}
    if cmd == "help":
        return {"action": "reply", "reply": _HELP_TEXT}

    intent = classify(text)

    if intent == PROGRESS:
        return {"action": "reply", "reply": _PROGRESS_REPLY.get(state, _PROGRESS_REPLY[st.IDLE])}
    if intent == EMOTION:
        return {"action": "reply", "reply": _EMOTION_BUSY if busy else _PROGRESS_REPLY[st.IDLE]}
    if intent == ACK:
        # 任务进行中的「嗯/好」多半是搭话——别打断也别喂主模型；空闲时轻量回一句
        return {"action": "drop"} if busy else {"action": "reply", "reply": _ACK_REPLY}
    if intent == CANCEL:
        # 只有真在忙才当取消；空闲时「算了」可能是「算了换个想法」→ 交主模型
        return {"action": "cancel", "reply": _CANCEL_REPLY} if busy else {"action": "agent"}
    return {"action": "agent"}

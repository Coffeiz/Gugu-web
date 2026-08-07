"""轻量 Intent Router（关键词 + 状态机）。

网关在**入队前**调用 `decide(text, state, *, current_puid, active_puid)`，据当前状态决定：
- 斜杠命令 `/stop` `/status` `/help`。
- 进度追问（还在吗/查了吗/好了吗/进度）→ **仅咕咕真在忙时**回当前状态话术，别打断；空闲交主 Agent。
- 催促（急/快点）→ 咕咕真在忙时回一句状态安抚；空闲交主 Agent。
- 取消（算了/停一下）→ 真在忙时置取消标志中断；空闲时没有任务可取消，交主 Agent、不触发 ACK。
- 其余（含 **「嗯/好/谢谢」这类 ACK**）→ 交主 Agent。

⚠️ **ACK 不再短路**：原先把『好/嗯』回「嗯嗋～」或 drop，会吞掉用户真实意图（如咕咕说「我去查」
后用户回「好」被吞、搜索没接上），故去掉。
⚠️ **进度追问空闲时也不再短路**：同一类问题——`state` 只跟踪当前这一轮请求内的忙闲，不记得
「咕咕上一轮口头承诺了要去查/待会补」这种跨轮次的隐性任务。空闲时无脑回「在的，你说～」会把
「查到了吗」这种追问真实意图整个吞掉（实测案例：咕咕报错 F1 数据后说「马上重新查一下」，用户
之后问「查到了吗」，因 state 已回 IDLE 被路由拦成一句「在的，你说～」，压根没触发真的去查）。
空闲时交主 Agent，让它看着对话历史自己判断该不该真去查。
以上两处是相对原版的改动。其余（催促/取消）保留。
原则：**短词歧义大，宁可漏判进主模型、不误判短路**——整条消息匹配，取消/催促只在短消息上判。
例外：**「取消」无条件识别**——只要消息包含「取消」即判 CANCEL（不受长度限制，解决「@咕咕 取消」
这类带前缀长消息漏判）；其余取消词（算了/不用）仍只在短消息上判。
**取消权限隔离**：`current_puid`（当前用户）+ `active_puid`（当前会话活跃 loop 的发起者集合）——
咕咕在跑别人的 loop 时，当前用户发「取消」返回 `no_permission`（「这个不是你的任务哦，咕咕还在忙～」），
不真的取消；发起者本人取消则正常中断。
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
    # 「取消」无条件识别：用户要求「只要输入取消就取消」，不管消息多长
    # （如「@咕咕 取消」这类带前缀的长消息，len>12 时原逻辑会漏判成普通消息）。
    if "取消" in t:
        return CANCEL
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


def decide(text: str, state: str, awaiting: bool = False,
           *, current_puid: str | None = None, active_puid: set | None = None) -> dict:
    """返回 {action, reply?}。action：'reply'(短路直接回) / 'cancel'(置取消标志+回) /
    'no_permission'(无权取消，回一句提示) / 'agent'(入队给主 Agent)。

    `current_puid`：当前发消息的用户；`active_puid`：当前会话活跃 loop 的发起者 puid 集合
    （来自 runtime_state.get_active）。两者用于判断「其他用户取消」的权限：咕咕在跑 A 的
    loop 时，B 发「取消」→ B 不在 active_puid 里 → 返回 no_permission（提示无权取消），
    而不是真的取消 A 的任务。

    **去掉了两类短路**：① 「嗯/好/谢谢」这类 ACK——曾被回「嗯嗋～」或 drop、吞掉用户真实意图
    （如咕咕说「我去查」后用户回「好」被吞、搜索没接上）；② 空闲时的进度追问（查到了吗/还在吗）
    ——state 只跟踪当前这一轮的忙闲，不记得跨轮次的口头承诺，空闲时无脑回「在的，你说～」同样会
    吞掉「查到了吗」这类追问的真实意图（用户想问的是"之前说要查的那件事查了没"，不是随口搭话）。
    现在 ACK 与「空闲时的进度追问」都一律交主模型。
    **保留**：斜杠命令；咕咕**在忙（思考/搜索/生成/等确认）时**的进度追问与催促 → 回一句状态、不打断；
    在忙时的取消（算了/停）→ 置取消标志中断。`awaiting`：咕咕以提问/确认收尾时「算了/不用」是回答 → 交 agent。
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

    intent = classify(text)

    # 进度追问（还在吗/查了吗/好了吗/进度）：只在真在忙时回状态话术、别打断；空闲时不代表
    # "没什么好问的"——可能是在追问上一轮口头承诺的事，交主 Agent 看历史自己判断
    if intent == PROGRESS:
        return ({"action": "reply", "reply": _PROGRESS_REPLY.get(state, _PROGRESS_REPLY[st.IDLE])} if busy
                else {"action": "agent"})
    # 催促（急/快点）只在咕咕真在忙时回一句状态安抚；空闲时交主 Agent 正常回应
    if intent == EMOTION:
        return ({"action": "reply", "reply": _PROGRESS_REPLY.get(state, _EMOTION_BUSY)} if busy
                else {"action": "agent"})
    # ACK（嗯/好/谢谢）：**不再短路**，一律交主模型（这就是本次唯一去掉的）
    if intent == CANCEL:
        # 「取消」无条件识别（不管消息多长，如「@咕咕 取消」），但只在真在忙时取消任务；
        # 空闲时没有任务可取消，不触发「好的，那先不继续啦～」的 ACK（否则用户 B 空闲时
        # 发「取消」会莫名收到一句确认，体验很怪）。
        if "取消" in text:
            # 咕咕在跑别人的 loop（当前会话有活跃 loop，但当前用户不是发起者）→ 无权取消，
            # 回一句提示，不真的取消（也不触发「好的，那先不继续啦～」）。
            if active_puid and current_puid and current_puid not in active_puid:
                return {"action": "no_permission", "reply": "这个不是你的任务哦，咕咕还在忙～"}
            return {"action": "cancel", "reply": _CANCEL_REPLY} if busy else {"action": "agent"}
        # 其他取消词（算了/不用）：咕咕在等确认时「算了/不用」是回答（否）→ 交 agent 收场；
        # 只有真在忙才当取消任务
        if awaiting and not busy:
            return {"action": "agent"}
        return {"action": "cancel", "reply": _CANCEL_REPLY} if busy else {"action": "agent"}
    return {"action": "agent"}

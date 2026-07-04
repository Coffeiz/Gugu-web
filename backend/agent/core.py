"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

Anthropic 路：单次流式调用（带 tools）—— 实时流式输出文本的同时，结束后从
get_final_message 取 tool_use；有工具则执行（走 skills.registry）回填后继续，
无工具则收尾。一次调用兼顾流式与工具检测，既保留真流式、又无"双调用敷衍"。
OpenAI 路：非流式探测工具 → 无工具时分块输出已生成文本。工具 schema 由 profile
启用的工具名从 registry 派生，消除手写双格式。temperature 已加到调用上保证离散度生效。
"""
import asyncio
import json
import random
import re as _re_mod
from typing import AsyncGenerator

from agent import genstream
from agent.tools import registry

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


async def _stream_round(client, kwargs):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试。
    yield ('token', delta) 逐字；结束 yield ('final', message)。重试用尽 / 不可重试 → 抛出。"""
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError,
                 # MiniMax 偶发返回空/异常的流式响应 → anthropic SDK 解析时 IndexError/KeyError 越界。
                 # 视为瞬时：出 token 前退避重试（emitted 守卫保证不会重复输出），多半重试即成。
                 IndexError, KeyError)
    last = None
    for i in range(len(_RETRY_BACKOFF) + 1):
        emitted = False
        try:
            async with client.messages.stream(**kwargs) as stream:
                async for delta in stream.text_stream:
                    emitted = True
                    yield ("token", delta)
                yield ("final", await stream.get_final_message())
                return
        except transient as e:
            last = e
            if emitted or i >= len(_RETRY_BACKOFF):
                raise              # 已吐 token（重试会重复）或重试用尽 → 抛给上层降级
            print(f"[core] LLM 瞬时错误 {type(e).__name__}，{_RETRY_BACKOFF[i]}s 后重试({i+1})", flush=True)
            await asyncio.sleep(_RETRY_BACKOFF[i])
    if last:
        raise last

# 工具循环最大轮次。配合「工具使用准则」(skills.md，先规划后执行、别重复验证) + 强工具
# (create_project 带 stages/todos、set_stages 整体替换、move_items/批量 rename/edit 一次处理多个)，
# 多步任务通常 2~3 轮就完成。设 6 给复杂任务留余量、同时收紧慢尾（封顶单条耗时）；真撞上限会友好提示「前面已生效，要不要接着做」。
MAX_ROUNDS = 6
_CANCEL_CHECK_EVERY = 24   # 流式途中每 N 个 token 协作检查一次取消（单轮长回答只能在这里掐断）

# ── 自我核实：做了增删改后，模型说"完成"时强制再跑一轮核实（用查询工具查证真生效/完整），
# 没做成/不完整就补做；最多 MAX_VERIFY 轮（每次对话回合计，非整 session）。防"嘴上说建好了、实际没建全"。
MAX_VERIFY = 5
_VERIFY_PROMPT = (
    "【系统自检 · 请认真执行，勿跳过】你刚才执行了增删改操作。现在**用对应的查询工具把刚改的东西查出来、核对真生效且完整**："
    "查询工具一般是 `list_*` / `get_*` / `read_*`（建项目用 `get_project` 看阶段待办、定时任务用 `list_scheduled_tasks` 看 cron/内容……照此类推，不管什么资源都先查后认，别凭印象说完成）。"
    "**尤其改了文件正文（`edit_file`/`create_document`）：必须用 `read_file` 把内容读回来逐字比对——`list_files` 只能看文件在不在、读不到正文，光看那个不算核实。**"
    "**发现没做成或不完整 → 立刻补做，并简要说明补了什么**。"
    "若核实一切正常，简单确认即可、别重复刚才说过的话（系统会自动略过这条，用户不会看到重复确认）。"
)

# 核实轮只嘴上说"确认/没问题"、却没真调查询工具时，强制再追一轮真查（防"凭印象说做完了"）
_VERIFY_FORCE_PROMPT = (
    "【系统自检 · 你还没真正核实】你上一条只是嘴上说\"确认/没问题\"，**没有调用任何查询工具去查证**——"
    "光凭印象不算核实。现在**立刻调 `read_file`（改了文件正文）/ `get_project` / `list_*` 等查询工具，把刚改的东西真查出来**，"
    "对照确认：真生效、内容完整、**没把别的内容覆盖丢**（尤其 `edit_file` replace_all 容易冲掉其它段落）。查完再回报。"
)

# 查询工具命名前缀：核实轮必须真调这类工具，不许凭印象说"确认了"
_READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")

# 特殊状态显示名默认值（非工具，无法从 registry 派生）。后台「状态命名」面板可覆盖：
#   _preparing      openai 流式收参数阶段的占位
#   _verify_prefix  复查轮工具标签前缀，后端拼到 label 前再下发
#   _thinking       「思考中」状态的文字（默认空＝显示三个点；填了才显示成文字气泡）
# 任一命名都可填多个（用 | 分隔），显示时随机取一个 —— 见 _pick_label。
SPECIAL_STATE_LABELS = {
    "_preparing":     "咕咕正在整理…",
    "_verify_prefix": "复查 · ",
    "_thinking":      "",
}


def _pick_label(raw: str) -> str:
    """命名值可含多个候选（| 或换行分隔）→ 随机取一个；单个/空原样返回。"""
    if not raw or ("|" not in raw and "\n" not in raw):
        return raw
    parts = [p.strip() for p in _re_mod.split(r"[|\n]", raw) if p.strip()]
    return random.choice(parts) if parts else raw

# narration 兜底：模型有时不真调工具，改用文字"假装"在读/改文件（「让我读一下…读到了…改好了」并
# 编造内容），这段叙述进历史后还会自我强化。检测这类话术——若本轮整段生成一个工具都没真调，多半在演。
_NARRATION_RE = __import__("re").compile(
    # ① 读/改文件的过程叙述（「让我读…读到了…」）
    r"让我(先|再|现在)?(读|看|查|改|滚动|翻)"
    r"|我(来|先)?(读|看|查|改)一?下"
    r"|读到了|看到了|改好了|改成了"
    r"|文件里(是|有|写)"
    # ② 完成断言（P2a）：**只收强 CRUD 动词**（建/创建/保存/删/发/移/归档/重命名）——
    #    「记/整理/安排/确认/设置/修改」等口语高发词剔除（既能是工具、也常用于普通对话，单凭文字判不准 → 误触发）
    r"|已经?(建好|建了|创建|新建|保存|存好|存进|删除|删了|删掉|发送|发出|发了|移好|移到|移了|归档|重命名|改名)"
    #    「帮你/给你/这就」是邀约/意图高发区，必须跟完成信号才算，避免误伤「要不要帮你建一个？」
    r"|(帮你|给你|这就)(建|创建|新建|保存|存|删除?|删掉|发送|发出|移|归档|重命名|改名)(了|啦|好了?|成功|完成)"
    #    无前缀时要动词+完成信号，避免误伤「你想改成什么样」「都保存了吗？」
    r"|(建好|创建好|新建好|保存好|存好|删掉|删除|发出去|移好|归档好)了"
    r"|(保存|创建|新建|删除|发送|移动|归档)(成功|完成)"
    # ③ 假装「已是目标态」（实测漏网「已经是每行一个的格式了」）：只收「已经是…格式/样子/状态/结构…了」
    r"|已经?是.{0,12}(格式|样子|状态|结构)了"
)


def _looks_like_narration(text: str) -> bool:
    """文本宣称在读/改/查文件，却（由调用方判断）本轮没真调工具 → 多半用嘴假装。"""
    return bool(text) and bool(_NARRATION_RE.search(text))


_NARRATION_NUDGE = (
    "【系统提醒 · 你在用嘴假装操作】你刚才声称做了某个操作（读/改/建/删/发/存等），但本轮**没有真的调用任何工具**。"
    "这是绝不允许的——不能凭空说出结果、不能说\"读到了/改好了/已创建/已保存/已发送\"。"
    "现在**立刻发出真正的工具调用**去真正执行；"
    "若确实不需要动手或缺信息，就如实说清楚，别再叙述虚构的操作过程或结果。"
)

# P3 · 决策守卫：用户明确命令改动（动词），但模型零工具 + 回复带「不用改/已合理」驳回语 → 「自作主张不做」。
# 三信号齐备才拦（高精度优先），避免误伤「问句/已动手/在问清楚要改成什么」。
_re = __import__("re")
_ACTION_REQ_RE = _re.compile(
    r"排序|重排|排个?序|重新排|置顶|归档|"
    r"改成|改为|改一?下|调整|换成|换个|改名|重命名|设为|设成|标记为?|标为|分类|"
    r"删掉|删除|加上|加个|添加|移到|移动|整理一?下|重新(排|命名|整理)"
)
_REFUSAL_RE = _re.compile(
    r"不需要|不用(改|调|动|排|加|删|整理)|没必要|无需(调整|改动|改|整理)|不必(改|调)?|"
    r"已经(很|挺|够|蛮)?(合理|好了?|不错|可以|没问题|对了?|清晰|清楚)|"
    r"保持(现状|原样|不变)|维持原样|现状.{0,4}(挺好|够好|合理|可以)|没什么(好|要)改|不建议(改|动)"
)


def _is_decision_dodge(user_req: str, reply: str) -> bool:
    """用户明确要改、模型却用「不用改/已合理」驳回（调用方再确认本轮零工具）→ 自作主张不做。"""
    return bool(user_req and reply) and bool(_ACTION_REQ_RE.search(user_req)) and bool(_REFUSAL_RE.search(reply))


_DECISION_NUDGE = (
    "【系统提醒 · 不许擅自替用户决定不做】用户明确要求你做这个改动（排序/调整/改/删/加等），"
    "你却判断「不用改/已经合理」并**没有调用任何工具**——这是不允许的，别替用户决定「不必做」。"
    "现在要么**真去执行**（调对应工具完成它），要么**问清楚他想改成什么样**再做；"
    "哪怕你觉得现状已合理，也先按他说的动手、或确认需求，而不是直接驳回。"
)


# 意图守卫（B · 防「说了要做却没动手」）：宣告"我这就去查/建/改…"的**将来式**，区别于 narration 的"假装已做完"。
# 要求一个明确的"将要"引导词（我去 / 我来 / 这就 / 马上 / 稍等我 / 让我 / 接下来 / 那我…）+ 动作词，避免裸
# "我+动词"误伤（如「我改天再看」）。命中即"宣告了要做"。
# 实测漏网案例（2026-07-04，F1 战报纠错场景）：「马上重新查一下」——① 中文口语常见主语省略（"我"隐含在
# 上一句里），"马上/现在/稍后"当时只在带"我"的分支里出现，裸着开头的"马上重新查一下"整句测不中；
# ② 时间副词和动词之间常插「重新/再」这类修饰词，原正则只留了"帮你/帮您/给你"这几个空当，卡住了匹配。
# 现在把"这就/马上/现在/稍后"都放开成可以不带"我"（前面不是"你"就行，避免误伤"你现在查一下"这种让用户
# 自己去做的建议句），并把"重新/再"也纳入动词前的可选修饰词。
_INTENT_RE = _re.compile(
    r"("
    r"我(这就|马上|现在|先|稍后)?(去|来)"          # 我去 / 我来 / 我先去 / 我马上来
    r"|我(先|这就|马上|现在|稍后)"                  # 我先 / 我这就 / 我现在（无去/来）
    r"|(?<!你)(这就|马上|现在|稍后)(去|帮你|帮您|给你|来)?"   # 这就/马上/现在/稍后（可以不带"我"，前面不是"你"）
    r"|稍等[，,]?\s*我?(去|来)?"                     # 稍等我去 / 稍等，我 / 稍等，去
    r"|让我(去|来|先)?"                            # 让我 / 让我去
    r"|接下来我?(去|来)?"                          # 接下来 / 接下来我去
    r"|那我(去|来|就)"                             # 那我去 / 那我就
    r")"
    r"(帮你|帮您|给你|重新|再)?\s*"
    r"(查|搜索?|找|看|读|翻|问|建|创建|新建|做|改|修改|删除?|发送?|存|保存|记录?|整理|安排|设置?|调取?|生成|算|统计)"
)
# 问句/征询硬排除：「要我去查吗?」是在等用户拍板，绝不能逼它执行（误逼=替用户做没同意的事，比卡住还糟）。
_QUESTION_RE = _re.compile(r"[?？]|吗|呢|要不要|需不需要|好不好|可不可以|行不行|是否|要我帮|需要我")


def _announces_intent(text: str) -> bool:
    """文字宣告"我这就去做某动作"（将来式），却（由调用方确认本轮零工具）没真动手 → 多半说完就停。
    先排除问句/征询（要我去查吗?）——那是在等用户拍板，命中即返回 False、绝不逼。"""
    if not text or _QUESTION_RE.search(text):
        return False
    return bool(_INTENT_RE.search(text))


_INTENT_NUDGE = (
    "【系统提醒 · 你说了要做却没动手】你刚表示要去做某件事（查/搜/找/建/改/记/整理等），"
    "但本轮**没有真的调用任何工具**。别只宣告意图就停下——**现在就这一轮发出真正的工具调用**去把它做了。"
    "若其实需要先问用户确认或缺少信息，就直接把问题问清楚，而不是说一句『我去做』然后停住。"
)


def _user_text(content) -> str:
    """从 user 消息 content 取纯文本（content 可能是 str，或带图时的 [{text}, {image}] 列表）。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


# 增删改工具的命名约定：写动词前缀。新功能的工具照此命名（create_/update_/delete_/...），
# 就自动纳入自我核实——这是「新功能直接适配复查」的关键，不用再来这里登记。
_WRITE_PREFIXES = (
    "create_", "update_", "delete_", "add_", "remove_", "edit_", "rename_",
    "move_", "copy_", "set_", "archive_", "restore_", "permanent_delete", "save_",
)


def _mutating_tools(tool_names) -> set:
    """本次可用工具里的「增删改」集合：① 命名约定（写动词前缀，自动覆盖新工具）
    ② 并上 RESOURCE_BY_TOOL 里人工登记的（双保险，防约定外的特例漏判）。"""
    from app.core.events import RESOURCE_BY_TOOL
    by_name = {n for n in tool_names if n.startswith(_WRITE_PREFIXES)}
    return by_name | set(RESOURCE_BY_TOOL)


def _with_history_cache(messages: list) -> list:
    """给「发给 API 的 messages」打一个滚动 prompt 缓存断点：在最后一条 message 的最后一个内容块上加
    cache_control。多轮工具循环里历史越滚越长，这样能缓存住已发生的几轮、下一轮只重算新增的块。
    返回浅拷贝、**不改原 messages**（原列表要持久化，绝不能混入 cache_control，否则下次加载历史会带着
    旧断点、累积超过 4 个上限）。只在最后一块是 list[dict]（assistant 块 / tool_result 块）时打；
    首轮 user 的纯字符串 content 跳过（那轮的静态部分已由 system 缓存覆盖）。"""
    if not messages:
        return messages
    last = messages[-1]
    c = last.get("content")
    if not isinstance(c, list) or not c or not isinstance(c[-1], dict) or not c[-1].get("type"):
        return messages
    new_block = {**c[-1], "cache_control": {"type": "ephemeral"}}
    return [*messages[:-1], {**last, "content": [*c[:-1], new_block]}]


async def _im_cancelled() -> bool:
    """IM 路：用户中途发「算了」→ 网关置了取消标志。web 路无 imctx，恒 False。"""
    from agent import imctx
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return False
    from agent import runtime_state as rt
    return await rt.is_cancelled(im["platform"], im["puid"])


async def _im_set_tool_state(tool_name: str) -> None:
    """据工具名打细粒度状态（web_search→SEARCHING、create_document→GENERATING），
    让网关「还在吗」答得更准。web 路无 imctx 时 no-op。"""
    from agent import imctx
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return
    from agent import runtime_state as rt
    fine = rt.TOOL_STATE.get(tool_name)
    if fine:
        await rt.set_state(im["platform"], im["puid"], fine)


class LLMRunner:
    """provider 无关的工具循环执行器。"""

    def __init__(self, tool_names: list[str], settings):
        self.tool_names = tool_names
        self.settings = settings
        # 状态显示名 = 特殊状态默认 ← 各工具 label ← 用户在后台「状态命名」面板的覆盖（热读）。
        # 未覆盖的 key 自动回退默认，所以「保留默认」天然成立。
        _ov = getattr(getattr(settings, "state_labels", None), "overrides", None) or {}
        self.labels = {**SPECIAL_STATE_LABELS, **registry.labels(), **{str(k): str(v) for k, v in _ov.items() if v}}

    def _label(self, name: str, default: str | None = None) -> str:
        """取状态显示名：命名含多个候选时随机取一（后端在发 tool_call 时调用）。"""
        return _pick_label(self.labels.get(name, name if default is None else default))

    def run(self, user_id, system_text: str, messages: list,
            use_anthropic: bool, model_cfg=None) -> AsyncGenerator[str, None]:
        # model_cfg：pick_model 解析出的模型配置（预设或 settings.ai）；None 时退回 settings.ai
        ai = model_cfg if model_cfg is not None else self.settings.ai
        if use_anthropic:
            return self._run_anthropic(user_id, system_text, messages, ai)
        return self._run_openai(user_id, messages, ai)

    # ── Anthropic（MiniMax / Anthropic）─────────────────────────────────────
    async def _run_anthropic(self, user_id, system_text: str,
                             messages: list, ai=None) -> AsyncGenerator[str, None]:
        import httpx
        from anthropic import AsyncAnthropic

        settings = self.settings
        ai = ai if ai is not None else settings.ai
        tools = registry.anthropic_schemas(self.tool_names)
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        from agent.llm_select import anthropic_default_headers, _is_mimo
        is_mimo = _is_mimo(ai)
        client = AsyncAnthropic(
            api_key=ai.api_key or "dummy",
            base_url=ai.base_url,
            http_client=httpx.AsyncClient(timeout=_timeout),
            default_headers=anthropic_default_headers(ai),
        )

        total_in = total_out = total_cache_read = 0
        max_tokens  = ai.max_tokens
        temperature = ai.temperature
        thinking_val = getattr(ai, "thinking", "disabled")
        if is_mimo:
            # mimo 的 thinking 取值用文档确认的 disabled；想开就不传、用其默认（避免猜它的 enable 取值）
            thinking_param = {"thinking": {"type": "disabled"}} if thinking_val != "adaptive" else {}
        else:
            thinking_param = {"thinking": {"type": thinking_val}} if thinking_val == "adaptive" else {}

        # prompt 缓存：system 由 builder 拆成「稳定前缀（人格/政策/技能索引，session 内不变）┃ 动态后缀
        # （记忆/分钟级时间/项目日历文件，每轮变）」，断点（CACHE_BREAK）在边界。缓存块只含稳定前缀 →
        # 命中读取便宜 ~90%；动态后缀不缓存，避免整块每分钟失效。两块顺序拼接与单段逐字一致。
        # Anthropic 顺序 tools→system→messages，故缓存块实含 tools+稳定前缀。
        # 例外：mimo 的 anthropic 端点不支持 prompt caching，不发 cache_control（strip 掉标记即可）。
        from agent.context import builder as _builder
        if system_text:
            stable, dynamic = _builder.split_for_cache(system_text)
            if dynamic and not is_mimo:
                system_param = [
                    {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": dynamic},
                ]
            else:
                _sys_blk = {"type": "text", "text": _builder.strip_cache_marker(system_text)}
                if not is_mimo:
                    _sys_blk["cache_control"] = {"type": "ephemeral"}
                system_param = [_sys_blk]
        else:
            system_param = system_text

        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; round_i = 0
        any_tool_called = False; narration_retry = 0; decision_retry = 0; intent_retry = 0   # 真实性守卫状态
        _user_req = _user_text(messages[-1]["content"]) if messages and messages[-1].get("role") == "user" else ""
        # 自我核实阶段：一旦进入就持续到收尾（含其查证用的 get_* 轮）。期间模型文字先缓冲——
        # 干净通过则整段丢弃（不把"已核实…"那种重复确认刷给用户）；发现并补做了，才在补做那轮发一次说明。
        verify_mode = False; verify_fixed = False; verify_queried = False
        while round_i < MAX_ROUNDS + MAX_VERIFY * 2:   # 核实轮额外预算，不挤占任务的 MAX_ROUNDS
            round_i += 1
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _im_cancelled():
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return
            # 单次流式调用：既实时流式输出文本，又能拿到 tool_use（无双调用、无敷衍）
            # 经 _stream_round 包一层瞬时错误退避重试（⑦）；流式途中仍协作检查取消。
            # ② 给发出去的 messages 打一个滚动缓存断点（最后一条 message 的最后一个块）：多轮工具循环里
            #    历史越滚越长，缓存住已发生的几轮、每轮只重算新增。用副本、不改原 messages（原列表要持久化，
            #    绝不能混入 cache_control）。mimo 不支持 cache_control → 原样发。
            _msgs = messages if is_mimo else _with_history_cache(messages)
            _kwargs = dict(
                model=ai.model, system=system_param, messages=_msgs,
                tools=tools, max_tokens=max_tokens, temperature=temperature, **thinking_param,
            )
            _tok = 0
            final = None
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            try:
                async for _kind, _val in _stream_round(client, _kwargs):
                    if _kind == "final":
                        final = _val
                        break
                    if verify_mode:
                        _verify_buf.append(_val)   # 核实阶段文字不实时发，先缓冲
                    else:
                        yield f"data: {json.dumps({'type': 'token', 'content': _val})}\n\n"
                    # 流式途中也协作检查取消：单轮长回答没有「下一轮」，只能在这里掐断；
                    # 退出生成器会关闭 stream、断开上游请求，真正停掉生成（不是只丢弃后续 token）
                    _tok += 1
                    if _tok % _CANCEL_CHECK_EVERY == 0 and await _im_cancelled():
                        yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                        return
            except Exception as e:
                import anthropic
                busy = isinstance(e, getattr(anthropic, "RateLimitError", ()))
                detail = "咕咕这会儿有点忙（接口繁忙），过几秒再发一次试试 🙏" if busy else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                print(f"[core] LLM 调用失败（已重试）: {type(e).__name__}: {str(e)[:120]}", flush=True)
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return

            total_in  += final.usage.input_tokens
            total_out += final.usage.output_tokens
            total_cache_read += getattr(final.usage, "cache_read_input_tokens", 0) or 0

            tool_blocks = [b for b in final.content if b.type == "tool_use"]
            if tool_blocks:
                any_tool_called = True   # 本轮真调了工具 → narration 兜底不触发
                # 核实阶段首次补做（本轮调了增删改）→ 把"发现漏了X，补一下"说明发一次；之后的核对文字仍静默
                if verify_mode and not verify_fixed and _verify_buf and any(b.name in _mutset for b in tool_blocks):
                    async for _line in genstream.typed_stream(''.join(_verify_buf)):   # 逐字流式，与正常回复一致
                        yield _line
                tool_results = []
                for block in tool_blocks:
                    label = self._label(block.name)
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = self._label("_verify_prefix", "复查 · ") + label
                    await _im_set_tool_state(block.name)
                    # 自检轮工具照常显示，但打 verify 标记：前端凭 verify 收尾不冒「生成中」点点（否则回复完还在转、像卡住）
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block.name, 'label': label, 'input': block.input, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, block.name, block.input)
                    if block.name in _mutset:
                        did_mutate = True   # 本次做过增删改 → 收尾时强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and block.name.startswith(_READ_PREFIXES):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': block.name, 'label': label, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })
                # 序列化为 dict：让 messages 列表 JSON 可序列化（便于持久化），
                # 同时保留 thinking blocks（MiniMax / Anthropic 多轮时原样回传）
                content_dicts = [
                    b.model_dump() if hasattr(b, "model_dump") else dict(b)
                    for b in final.content
                ]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": tool_results})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue

            # 自我核实：① 做过增删改 → 注入核实 prompt 让用查询工具查证、没做全就补做；
            # ② 已进核实阶段却只嘴上确认、没真调过查询工具（verify_queried=False）→ 强制再追一轮真查。
            # 都受 MAX_VERIFY 封顶防死循环。补做会再置 did_mutate → 触发下一轮核实。
            _need_verify = did_mutate and verify_count < MAX_VERIFY
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_count < MAX_VERIFY
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                content_dicts = [
                    b.model_dump() if hasattr(b, "model_dump") else dict(b)
                    for b in final.content
                ]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调。
            # 只追一次；核实阶段不算（那是另一套）。content 在 verify_mode 下被缓冲，故取 _verify_buf 兜底。
            _final_text = "".join(b.text for b in final.content if b.type == "text")
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _looks_like_narration(_final_text)):
                narration_retry += 1
                content_dicts = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in final.content]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": _NARRATION_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 意图守卫（B）：宣告「我这就去查/建/改…」却本轮零工具 → 逼它当场做（_announces_intent 已排除问句/征询）。只追一次。
            if (not any_tool_called and not verify_mode and intent_retry < 1
                    and _announces_intent(_final_text)):
                intent_retry += 1
                content_dicts = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in final.content]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": _INTENT_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清，别擅自不做。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _is_decision_dodge(_user_req, _final_text)):
                decision_retry += 1
                content_dicts = [b.model_dump() if hasattr(b, "model_dump") else dict(b) for b in final.content]
                messages.append({"role": "assistant", "content": content_dicts})
                messages.append({"role": "user", "content": _DECISION_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 收尾：干净核实阶段的确认文字（_verify_buf）直接丢弃，用户看不到重复确认
            # （若补做过，说明已在补做那轮发过；这里不再补发）

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out, 'cache_read': total_cache_read})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完 😅 前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list, ai=None) -> AsyncGenerator[str, None]:
        import httpx
        from openai import AsyncOpenAI

        settings = self.settings
        ai = ai if ai is not None else settings.ai
        # mimo（小米）是推理模型：会把思考放 reasoning_content、正文放 content，偶尔整轮正文为空 →
        # 空回复/空气泡。据此单独适配（下方空 content 兜底）。
        is_mimo = (ai.provider or "").lower() == "mimo" or "xiaomimimo" in (ai.base_url or "").lower()
        tools = registry.openai_schemas(self.tool_names)
        # system 里可能带 builder 的缓存断点标记（CACHE_BREAK）——openai 通道不支持 anthropic 式 cache_control，
        # 去掉它还原成普通 system 串（标记仅出现在 system 消息里，每轮重建、改它无副作用）。
        from agent.context import builder as _builder
        for _m in messages:
            if _m.get("role") == "system" and isinstance(_m.get("content"), str) and _builder.CACHE_BREAK in _m["content"]:
                _m["content"] = _builder.strip_cache_marker(_m["content"])
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        from agent.llm_select import openai_default_headers, supports_thinking_toggle, _is_deepseek
        client = AsyncOpenAI(
            api_key=ai.api_key or "dummy",
            base_url=ai.base_url,
            timeout=_timeout,
            default_headers=openai_default_headers(ai),
        )

        max_tokens  = ai.max_tokens
        temperature = ai.temperature
        # 思考开关：mimo 与 deepseek 都用同一 OpenAI 参数 `{"thinking":{"type":...}}`（见各自官方文档）。
        # 思考关时显式传 disabled——mimo 从源头避免「正文全进 reasoning_content、content 空」的空气泡，
        # deepseek 则省下推理 token/延迟。思考开（adaptive）则不传、用厂商默认（两家默认都是开），靠下方空回复兜底。
        # 仅对支持该参数的厂商发（qwen/openai 没这参数，传了可能报错）。reasoning_content 的多轮回传已统一处理。
        # 思考开（adaptive）时，DeepSeek 还可带「思考强度」reasoning_effort（high/max；思考模式下 temperature 失效，
        # effort 是唯一质量/成本旋钮）。mimo 文档无此参数，故只对 deepseek 发。
        _think_extra = {}
        if supports_thinking_toggle(ai):
            if getattr(ai, "thinking", "disabled") != "adaptive":
                _think_extra["thinking"] = {"type": "disabled"}
            elif _is_deepseek(ai) and getattr(ai, "reasoning_effort", ""):
                _think_extra["reasoning_effort"] = ai.reasoning_effort
        total_in = total_out = total_cache_hit = 0   # cache_hit：DeepSeek 自动上下文缓存命中 token（观测命中率用）
        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; round_i = 0; empty_retry = 0
        any_tool_called = False; narration_retry = 0; decision_retry = 0; intent_retry = 0   # 真实性守卫状态
        _user_req = _user_text(messages[-1]["content"]) if messages and messages[-1].get("role") == "user" else ""
        # 自我核实阶段：进入后持续到收尾，期间文字先缓冲——干净通过整段丢弃、补做了才发一次说明（同 Anthropic 路）
        verify_mode = False; verify_fixed = False; verify_queried = False
        while round_i < MAX_ROUNDS + MAX_VERIFY * 2:   # 核实轮额外预算
            round_i += 1
            if await _im_cancelled():
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return
            stream = await client.chat.completions.create(
                model=ai.model,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
                stream_options={"include_usage": True},
                extra_body=_think_extra,
            )
            content = ""
            reasoning = ""                   # mimo 深度思考产出（reasoning_content）：多轮+工具调用必须原样回传，否则 400
            tool_buf: dict[int, dict] = {}   # index → {id, name, args}，流式分片累积
            announced = False                # 工具参数流式期间先亮个指示，免得前端空窗以为卡死
            _tok = 0
            def _asst(text, tool_calls=None):
                # 统一构造 assistant 历史消息：mimo 开思考时把本轮 reasoning_content 一并带回（文档硬性要求，
                # 多轮 Function Call 缺它 → 400）。思考关时 reasoning 恒空、不加该字段，行为与原先逐字一致。
                m = {"role": "assistant", "content": text}
                if tool_calls is not None:
                    m["tool_calls"] = tool_calls
                if reasoning:
                    m["reasoning_content"] = reasoning
                return m
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    total_in  += chunk.usage.prompt_tokens or 0
                    total_out += chunk.usage.completion_tokens or 0
                    # DeepSeek 自动上下文缓存命中（prompt_cache_hit_tokens）；非 DeepSeek 厂商无此字段 → 0
                    total_cache_hit += getattr(chunk.usage, "prompt_cache_hit_tokens", 0) or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                _rc = getattr(delta, "reasoning_content", None)
                if _rc:
                    reasoning += _rc   # 思考分片（流式里先于 content 到）；只入历史回传，不流式发给用户
                if delta.content:
                    content += delta.content
                    if not verify_mode:   # 核实阶段不实时发，攒到 content 里待回合末定夺
                        yield f"data: {json.dumps({'type': 'token', 'content': delta.content})}\n\n"
                    # 流式途中协作检查取消（同 Anthropic 路：单轮长回答只能在这里掐断）
                    _tok += 1
                    if _tok % _CANCEL_CHECK_EVERY == 0 and await _im_cancelled():
                        try:
                            await stream.close()
                        except Exception:
                            pass
                        yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                        return
                if delta.tool_calls and not announced:
                    # 工具调用开始（此后在流式输出工具参数，可能很长，无 token、tool_call 也要等参数收完才发）
                    announced = True
                    if not verify_mode:   # 自检轮静默：连「正在整理」预告也不冒泡
                        _prep = self._label("_preparing", "咕咕正在整理…")
                        yield f"data: {json.dumps({'type': 'tool_call', 'name': '_preparing', 'label': _prep}, ensure_ascii=False)}\n\n"
                for tc in (delta.tool_calls or []):
                    b = tool_buf.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                    if tc.id:
                        b["id"] = tc.id
                    if tc.function and tc.function.name:
                        b["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        b["args"] += tc.function.arguments

            if tool_buf:
                any_tool_called = True   # 本轮真调了工具 → narration 兜底不触发
                ordered = [tool_buf[i] for i in sorted(tool_buf)]
                # 核实阶段首次补做（本轮有增删改）→ 发一次"发现漏了X，补一下"说明；之后核对文字仍静默
                if verify_mode and not verify_fixed and content and any(b["name"] in _mutset for b in ordered):
                    async for _line in genstream.typed_stream(content):   # 逐字流式，与正常回复一致
                        yield _line
                messages.append(_asst(
                    content or None,
                    tool_calls=[
                        {"id": b["id"], "type": "function",
                         "function": {"name": b["name"], "arguments": b["args"]}}
                        for b in ordered
                    ],
                ))
                for b in ordered:
                    label = self._label(b["name"])
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = self._label("_verify_prefix", "复查 · ") + label
                    try:
                        args = json.loads(b["args"])
                    except Exception:
                        # 参数 JSON 解析失败（常见于长内容被 max_tokens 截断）→ 记下原文便于排查
                        print(f"[core] 工具 {b['name']} 参数解析失败(疑似 max_tokens 截断), "
                              f"len={len(b['args'])} 尾部={b['args'][-120:]!r}", flush=True)
                        args = {}
                    await _im_set_tool_state(b["name"])
                    # 自检轮工具照常显示，但打 verify 标记：前端标注「复查·」且收尾不冒「生成中」点点（否则回复完还在转、像卡住）
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': b['name'], 'label': label, 'input': args, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, b["name"], args)
                    if b["name"] in _mutset:
                        did_mutate = True   # 做过增删改 → 收尾时强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and b["name"].startswith(_READ_PREFIXES):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': b['name'], 'label': label, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": b["id"],
                        "content": result,
                    })
                continue

            # 无工具调用：正文已逐 token 流式输出完毕
            # 空回复兜底：模型整轮没产出正文 → 用户看到空气泡。常见于 ① 推理模型把话全放进
            # reasoning_content；② 精力降级进轻量模式后「没重活可干」干脆不说话。不限 mimo——
            # 任何模型空正文都要兜（此前只 gate 在 is_mimo，导致非 mimo 模型精力用尽时裸露成空气泡）。
            # 本轮没动工具、也不在核实阶段时：先追一轮要它直接给正文；仍空则给句得体兜底。
            if not content.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    messages.append({"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"})
                    yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                    continue
                fb = "嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～"
                async for _line in genstream.typed_stream(fb):   # 空回复兜底也走逐字流式
                    yield _line
                content = fb
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调（只一次）。
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _looks_like_narration(content)):
                narration_retry += 1
                messages.append(_asst(content or "（…）"))
                messages.append({"role": "user", "content": _NARRATION_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 意图守卫（B）：宣告要做却本轮零工具 → 逼它当场做（_announces_intent 已排除问句）。只追一次。
            if (not any_tool_called and not verify_mode and intent_retry < 1
                    and _announces_intent(content)):
                intent_retry += 1
                messages.append(_asst(content or "（…）"))
                messages.append({"role": "user", "content": _INTENT_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _is_decision_dodge(_user_req, content)):
                decision_retry += 1
                messages.append(_asst(content or "（…）"))
                messages.append({"role": "user", "content": _DECISION_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 自我核实：① 做过增删改 → 核实查证/补做；② 已进核实阶段却只嘴上确认、没真调查询工具 → 强制再追一轮真查
            _need_verify = did_mutate and verify_count < MAX_VERIFY
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_count < MAX_VERIFY
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                messages.append(_asst(content or ""))
                messages.append({"role": "user", "content": _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 收尾：干净核实阶段的确认文字（content，未实时发）直接丢弃，用户看不到重复确认
            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out, 'cache_read': total_cache_hit})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完 😅 前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"

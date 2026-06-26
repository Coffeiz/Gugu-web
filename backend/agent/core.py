"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

Anthropic 路：单次流式调用（带 tools）—— 实时流式输出文本的同时，结束后从
get_final_message 取 tool_use；有工具则执行（走 skills.registry）回填后继续，
无工具则收尾。一次调用兼顾流式与工具检测，既保留真流式、又无"双调用敷衍"。
OpenAI 路：非流式探测工具 → 无工具时分块输出已生成文本。工具 schema 由 profile
启用的工具名从 registry 派生，消除手写双格式。temperature 已加到调用上保证离散度生效。
"""
import asyncio
import json
from typing import AsyncGenerator

from agent.tools import registry

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


async def _stream_round(client, kwargs):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试。
    yield ('token', delta) 逐字；结束 yield ('final', message)。重试用尽 / 不可重试 → 抛出。"""
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError)
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
# 没做成/不完整就补做；最多 MAX_VERIFY 轮。防"嘴上说建好了、实际没建全"。
MAX_VERIFY = 3
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

# narration 兜底：模型有时不真调工具，改用文字"假装"在读/改文件（「让我读一下…读到了…改好了」并
# 编造内容），这段叙述进历史后还会自我强化。检测这类话术——若本轮整段生成一个工具都没真调，多半在演。
_NARRATION_RE = __import__("re").compile(
    r"让我(先|再|现在)?(读|看|查|改|滚动|翻)"
    r"|我(来|先)?(读|看|查|改)一?下"
    r"|读到了|看到了|改好了|改成了"
    r"|文件里(是|有|写)"
)


def _looks_like_narration(text: str) -> bool:
    """文本宣称在读/改/查文件，却（由调用方判断）本轮没真调工具 → 多半用嘴假装。"""
    return bool(text) and bool(_NARRATION_RE.search(text))


_NARRATION_NUDGE = (
    "【系统提醒 · 你在用嘴假装操作】你刚才用文字描述了读取/修改文件，但本轮**没有真的调用任何工具**。"
    "这是绝不允许的——不能凭空说出文件内容、不能说\"读到了/改好了\"。"
    "现在**立刻发出真正的工具调用**（read_file / edit_file 等）去真正执行；"
    "若确实不需要动手，就如实说清楚，别再叙述虚构的读取/修改过程。"
)


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
        self.labels = registry.labels()

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

        # prompt 缓存：把 system（含人格/记忆/上下文）作为稳定前缀缓存。
        # Anthropic 顺序 tools→system→messages，断点打在 system 即缓存 tools+system，
        # 多轮工具循环只重算新增 messages，命中后读取便宜 ~90%。
        # 例外：mimo 的 anthropic 端点不支持 prompt caching，不能发 cache_control（可能报错）。
        if system_text:
            _sys_blk = {"type": "text", "text": system_text}
            if not is_mimo:
                _sys_blk["cache_control"] = {"type": "ephemeral"}
            system_param = [_sys_blk]
        else:
            system_param = system_text

        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; round_i = 0
        any_tool_called = False; narration_retry = 0   # narration 兜底：整段生成有没有真调过工具
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
            _kwargs = dict(
                model=ai.model, system=system_param, messages=messages,
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
                    yield f"data: {json.dumps({'type': 'token', 'content': ''.join(_verify_buf)})}\n\n"
                tool_results = []
                for block in tool_blocks:
                    label = self.labels.get(block.name, block.name)
                    await _im_set_tool_state(block.name)
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block.name, 'label': label, 'input': block.input}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, block.name, block.input)
                    if block.name in _mutset:
                        did_mutate = True   # 本次做过增删改 → 收尾时强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and block.name.startswith(_READ_PREFIXES):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': block.name, 'label': label}, ensure_ascii=False)}\n\n"
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
        _timeout = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        from agent.llm_select import openai_default_headers
        client = AsyncOpenAI(
            api_key=ai.api_key or "dummy",
            base_url=ai.base_url,
            timeout=_timeout,
            default_headers=openai_default_headers(ai),
        )

        max_tokens  = ai.max_tokens
        temperature = ai.temperature
        # mimo：思考关时显式传 thinking:disabled（官方两套 API 都支持此参数）——从源头避免「输出全进
        # reasoning_content、正文空」的空气泡。思考开（adaptive）则不传，用 mimo 默认（开），靠下方空回复兜底。
        _mimo_extra = {"thinking": {"type": "disabled"}} if (is_mimo and getattr(ai, "thinking", "disabled") != "adaptive") else {}
        total_in = total_out = 0
        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; round_i = 0; empty_retry = 0
        any_tool_called = False; narration_retry = 0   # narration 兜底：整段生成有没有真调过工具
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
                extra_body=_mimo_extra,
            )
            content = ""
            tool_buf: dict[int, dict] = {}   # index → {id, name, args}，流式分片累积
            announced = False                # 工具参数流式期间先亮个指示，免得前端空窗以为卡死
            _tok = 0
            async for chunk in stream:
                if getattr(chunk, "usage", None):
                    total_in  += chunk.usage.prompt_tokens or 0
                    total_out += chunk.usage.completion_tokens or 0
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
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
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': '_preparing', 'label': '咕咕正在整理…'}, ensure_ascii=False)}\n\n"
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
                    yield f"data: {json.dumps({'type': 'token', 'content': content})}\n\n"
                messages.append({
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": [
                        {"id": b["id"], "type": "function",
                         "function": {"name": b["name"], "arguments": b["args"]}}
                        for b in ordered
                    ],
                })
                for b in ordered:
                    label = self.labels.get(b["name"], b["name"])
                    try:
                        args = json.loads(b["args"])
                    except Exception:
                        # 参数 JSON 解析失败（常见于长内容被 max_tokens 截断）→ 记下原文便于排查
                        print(f"[core] 工具 {b['name']} 参数解析失败(疑似 max_tokens 截断), "
                              f"len={len(b['args'])} 尾部={b['args'][-120:]!r}", flush=True)
                        args = {}
                    await _im_set_tool_state(b["name"])
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': b['name'], 'label': label, 'input': args}, ensure_ascii=False)}\n\n"
                    result, artifact = await registry.dispatch(user_id, b["name"], args)
                    if b["name"] in _mutset:
                        did_mutate = True   # 做过增删改 → 收尾时强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and b["name"].startswith(_READ_PREFIXES):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': b['name'], 'label': label}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    messages.append({
                        "role": "tool",
                        "tool_call_id": b["id"],
                        "content": result,
                    })
                continue

            # 无工具调用：正文已逐 token 流式输出完毕
            # mimo 空回复兜底：推理模型偶尔把整轮输出全放进 reasoning_content、正文 content 为空 →
            # 用户看到空气泡。本轮没动工具、也不在核实阶段时：先追一轮要它直接给正文；仍空则给句得体兜底。
            if is_mimo and not content.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    messages.append({"role": "user", "content": "（把要回复用户的话直接说出来就好，别只在心里想。）"})
                    yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                    continue
                fb = "嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～"
                yield f"data: {json.dumps({'type': 'token', 'content': fb}, ensure_ascii=False)}\n\n"
                content = fb
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调（只一次）。
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _looks_like_narration(content)):
                narration_retry += 1
                messages.append({"role": "assistant", "content": content or "（…）"})
                messages.append({"role": "user", "content": _NARRATION_NUDGE})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 自我核实：① 做过增删改 → 核实查证/补做；② 已进核实阶段却只嘴上确认、没真调查询工具 → 强制再追一轮真查
            _need_verify = did_mutate and verify_count < MAX_VERIFY
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_count < MAX_VERIFY
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                messages.append({"role": "assistant", "content": content or ""})
                messages.append({"role": "user", "content": _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 收尾：干净核实阶段的确认文字（content，未实时发）直接丢弃，用户看不到重复确认
            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完 😅 前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"

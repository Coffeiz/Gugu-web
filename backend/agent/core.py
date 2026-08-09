"""LLM 主循环（迁自原 agent.py 的 _loop_anthropic / _loop_openai）。

`LLMRunner._run_loop`（PRD-LLM-1 Phase 2）：工具调用/核实阶段状态机/三条防幻觉守卫/
空回复兜底/轮次上限——这套控制流对 Anthropic 块格式和 OpenAI 格式完全一样，原来是
两条逐字复制的循环（`_run_anthropic`/`_run_openai`），现在收成一条共享循环，"怎么跟
这个 provider 打交道"（流式事件形状/工具参数解析/历史消息格式/缓存记账）收进
`agent/loop_drivers.py` 的 `AnthropicDriver`/`OpenAIDriver`。`_run_anthropic`/
`_run_openai` 两个方法名和外部签名原样保留（`runner.py`/`gateway/web.py` 等调用点、
以及 `tests/test_core_loop_characterization.py` 都按名字直接调用它们），内部只是转发
给 `_run_loop`。
"""
import asyncio
import json
import logging
import random
import re as _re_mod
from typing import AsyncGenerator

from agent.llm import genstream
from agent import loop_drivers
from agent.tools import registry
from app.core.errors import RetryableError
from app.core.redaction import diag_log

_log = logging.getLogger("agent.core")

# ⑦ 慢尾兜底：LLM 瞬时错误（限流 429 / 超时 / 网络 / 5xx）退避重试——贴着并发上限跑时
# 把偶发 429 吸收成短延迟、不丢消息。只在「本轮还没吐 token 前」重试（已吐过再重试会重复输出）。
_RETRY_BACKOFF = [1, 2, 4]   # 退避秒数；最多重试 3 次


async def _stream_round(client, kwargs, adapter=None):
    """跑一轮 Anthropic 流式，遇瞬时错误在出 token 前退避重试（P2-b §4-A 标杆模板）。
    yield ('token', delta) 逐字；结束 yield ('final', message)。

    两种「抛出」语义不同，调用方（主循环边界）据此区分：
    - **已吐过 token 中途出错**：不能重试（会重复输出），原样把底层异常抛出去——这不是
      「重试用尽」，是「已产生副作用不敢重试」，按未知/中断处理，不伪装成 RetryableError。
    - **重试用尽、一个 token 都没吐过**：包成 `RetryableError`（真正符合可重试语义：
      幂等——还没输出任何东西，从头重试不会重复）。

    `adapter`（`agent.providers.ProviderAdapter`）可选——不传（`None`）时只用下面这几个
    provider 无关的基础瞬时错误类型；传了就叠加该 provider 专属的容错（PRD-LLM-1）。
    """
    import anthropic
    transient = (anthropic.RateLimitError, anthropic.APITimeoutError,
                 anthropic.APIConnectionError, anthropic.InternalServerError)
    if adapter is not None:
        # 各 provider 专属的「流式响应跟 SDK 期望 schema 对不上」容错，只加给对应 provider——
        # 见 agent/providers.py 里每个适配器 transient_exceptions 的注释（MiniMax 的
        # IndexError/KeyError/AttributeError 是目前唯一非空的一份）。不全局放宽，避免把
        # 跟该 provider 无关的真实 bug 也当"重试就好"吞掉。
        transient = transient + adapter.transient_exceptions
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
            if emitted:
                raise   # 已吐 token，重试会重复输出——原样抛给上层当未知/中断处理
            if i >= len(_RETRY_BACKOFF):
                # where 里带上 provider——上次这里崩溃排查时 diag_log 没记 provider，只能靠
                # 静态代码分析猜是哪家（PRD-LLM-1「待确认问题」），这次直接把它写进日志，
                # 下次同类问题不用再猜。
                _provider = adapter.name if adapter is not None else "unknown"
                diag_log(f"agent.core.stream_round provider={_provider}", e)   # 原始 → 受限诊断出口
                _log.warning("LLM 流式调用重试 %d 次后仍失败：%s", i, type(e).__name__)
                raise RetryableError("llm.stream_exhausted", "LLM 调用重试后仍失败",
                                      cause=e, attempt=i) from e
            _log.info("LLM 瞬时错误 %s，%ss 后重试(%d)", type(e).__name__, _RETRY_BACKOFF[i], i + 1)
            await asyncio.sleep(_RETRY_BACKOFF[i])
    if last:
        raise last

# 工具循环最大轮次。配合「工具使用准则」(skills.md，先规划后执行、别重复验证) + 强工具
# (create_project 带 stages/todos、set_stages 整体替换、move_items/批量 rename/edit 一次处理多个)，
# 多步任务通常 2~3 轮就完成。设 6 给复杂任务留余量、同时收紧慢尾（封顶单条耗时）；真撞上限会友好提示「前面已生效，要不要接着做」。
MAX_ROUNDS = 6
_CANCEL_CHECK_EVERY = 24   # 流式途中每 N 个 token 协作检查一次取消（单轮长回答只能在这里掐断）

# ── 自我核实：成功做了增删改后，立刻跑一轮核实（用查询工具查证真生效/完整），
# 没做成/不完整就补做；最多 MAX_VERIFY 轮（每次对话回合计，非整 session）。防"嘴上说建好了、实际没建全"。
MAX_VERIFY = 5
_VERIFY_PROMPT = (
    "【系统自检 · 请认真执行，勿跳过】你刚才执行了增删改操作。现在**用对应的查询工具把刚改的东西查出来、核对真生效且完整**："
    "查询工具一般是 `list_*` / `get_*` / `read_*`（建项目用 `get_project` 看阶段待办、定时任务用 `list_scheduled_tasks` 看 cron/内容……照此类推，不管什么资源都先查后认，别凭印象说完成）。"
    "**尤其改了文件正文（`edit_file`/`create_document`）：必须用 `read_file` 把内容读回来逐字比对——`list_files` 只能看文件在不在、读不到正文，光看那个不算核实。**"
    "**发现没做成或不完整 → 立刻补做，并简要说明补了什么**。"
    "自检过程是内部校验，不要把“核对完成”“复查完成”“已确认”等过程标签当成最终回复。"
    "核实后直接总结这次实际做了什么、哪些成功、哪些没做成及原因；数量、文件名、位置和失败原因只能来自工具回执。"
    "表达沿用用户当前的风格偏好和咕咕人设：偏正式时克制准确，偏活泼时自然亲近，偏简短时收束，偏详细时补充必要上下文；不要套用固定口号，也不要把结果写成生硬的逐项统计表。"
)

# 核实轮只嘴上说"确认/没问题"、却没真调查询工具时，强制再追一轮真查（防"凭印象说做完了"）
_VERIFY_FORCE_PROMPT = (
    "【系统自检 · 你还没真正核实】你上一条只是嘴上说\"确认/没问题\"，**没有调用任何查询工具去查证**——"
    "光凭印象不算核实。现在**立刻调 `read_file`（改了文件正文）/ `get_project` / `list_*` 等查询工具，把刚改的东西真查出来**，"
    "对照确认：真生效、内容完整、**没把别的内容覆盖丢**（尤其 `edit_file` replace_all 容易冲掉其它段落）。"
    "查证是内部步骤，不要只回复“核对完成/复查完成”；最后按用户当前的正式/活泼、简短/详细偏好，"
    "自然说明实际做了什么、成功了什么，以及仍失败或未完成的部分。"
)

# 查询工具命名前缀：核实轮必须真调这类工具，不许凭印象说"确认了"。
# 思维笔记保留了 mind_get/mind_search 的历史命名，必须显式纳入，避免明明读回了
# 数据却被误判成没有观察，白白多跑复查回合。
_READ_PREFIXES = ("read_", "list_", "get_", "find_", "search_")
_READ_TOOL_NAMES = {"mind_get", "mind_search"}

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

# 叙事/决策拒绝/意图播报守卫（跟 provider 无关，PRD-LLM-1 FR-LLM-3 搬到了 core_guards.py）：
from agent.security.core_guards import (
    _looks_like_narration, _NARRATION_NUDGE,
    _is_decision_dodge, _DECISION_NUDGE,
    _announces_intent, _INTENT_NUDGE,
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


def _is_successful_tool_result(result: str) -> bool:
    """失败的写调用没有状态可复查，不能为它额外等待一轮模型响应。"""
    try:
        payload = json.loads(result)
    except (TypeError, json.JSONDecodeError):
        return True
    return not isinstance(payload, dict) or not payload.get("error")


def _is_read_tool(name: str) -> bool:
    """返回该工具能否作为一次有效的状态观察。"""
    return name.startswith(_READ_PREFIXES) or name in _READ_TOOL_NAMES


async def _im_cancelled() -> bool:
    """IM 路：用户中途发「算了」→ 网关置了取消标志。web 路无 imctx，恒 False。"""
    from agent import imctx
    from agent.runtime import runtime_state as rt
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return False
    cancelled = await rt.is_cancelled(
        im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"], im["puid"]
    )
    if cancelled:
        # 取消标志命中、即将掐断 loop：记录确认（puid 指纹脱敏），供排查「取消是否真的
        # 中断了生成」。只在真正命中时打，不会刷屏。
        from agent.security.logsafe import fingerprint
        from app.core.redaction import diag_log_raw
        diag_log_raw(
            "agent.core.im_cancelled_hit",
            f"platform={im['platform']} puid={fingerprint(im['puid'])}",
        )
    return cancelled


async def _im_set_tool_state(tool_name: str) -> None:
    """据工具名打细粒度状态（web_search→SEARCHING、create_document→GENERATING），
    让网关「还在吗」答得更准。web 路无 imctx 时 no-op。"""
    from agent import imctx
    from agent.runtime import runtime_state as rt
    im = imctx.get_im()
    if not im or not im.get("puid"):
        return
    fine = rt.TOOL_STATE.get(tool_name)
    if fine:
        await rt.set_state(
            im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"],
            im["puid"], fine,
        )


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
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        async for line in self._run_loop(loop_drivers.AnthropicDriver(), user_id, messages, ai,
                                          system_text=system_text):
            yield line

    # ── OpenAI ──────────────────────────────────────────────────────────────
    async def _run_openai(self, user_id, messages: list, ai=None) -> AsyncGenerator[str, None]:
        settings = self.settings
        ai = ai if ai is not None else settings.ai
        async for line in self._run_loop(loop_drivers.OpenAIDriver(), user_id, messages, ai,
                                          system_text=None):
            yield line

    # ── 共享主循环（PRD-LLM-1 Phase 2）────────────────────────────────────────
    async def _run_loop(self, driver, user_id, messages: list, ai,
                         system_text: str | None) -> AsyncGenerator[str, None]:
        """工具调用/核实阶段状态机/三条防幻觉守卫/空回复兜底/轮次上限——Anthropic 和
        OpenAI 两条格式共用同一份控制流，只在"怎么跑一轮/怎么把这轮结果写回历史"这几处
        调用 `driver`（`agent/loop_drivers.py` 的 `AnthropicDriver`/`OpenAIDriver`）。

        合并后有一处行为变化，如实记在这里、不是本次改动的目标而是自然结果：原来
        `_run_openai` 整段没有 try/except 包裹流式调用，一旦 SDK 抛异常会原样往外炸；
        `_run_anthropic` 一直有（靠 RetryableError/通用 Exception 两层兜底）。合并成
        一条共享循环后两边自然共用同一层兜底——OpenAI 路因此从"异常直接炸穿"变成
        "跟 Anthropic 路一样优雅降级成'咕咕开小差了'"，是明确的行为改善，不是意外。
        """
        # 这轮真正要跑的模型配置透传给工具层（见 agent/modelctx.py 文档）——工具判断
        # "当前模型支持什么"必须看这个，不能重新读静态的 get_settings().ai。
        from agent.llm import modelctx
        modelctx.set_model_cfg(ai)
        client, ctx = driver.prepare(self.tool_names, ai, messages, system_text)

        _mutset = _mutating_tools(self.tool_names)
        did_mutate = False; verify_count = 0; round_i = 0; empty_retry = 0
        any_tool_called = False; narration_retry = 0; decision_retry = 0; intent_retry = 0   # 真实性守卫状态
        _user_req = _user_text(messages[-1]["content"]) if messages and messages[-1].get("role") == "user" else ""
        # 自我核实阶段：一旦进入就持续到收尾（含其查证用的 get_* 轮）。期间模型文字先缓冲——
        # 干净通过则整段丢弃（不把"已核实…"那种重复确认刷给用户）；发现并补做了，才在补做那轮发一次说明。
        verify_mode = False; verify_fixed = False; verify_queried = False
        total_in = total_out = total_cache = 0

        while round_i < MAX_ROUNDS + MAX_VERIFY * 2:   # 核实轮额外预算，不挤占任务的 MAX_ROUNDS
            round_i += 1
            # 用户中途「算了」→ 轮间协作中断（单次 LLM 流式调用本身切不了，故粒度是轮与轮之间）
            if await _im_cancelled():
                yield f"data: {json.dumps({'type': '_cancelled'})}\n\n"
                return

            _tok = 0
            result = None
            _verify_buf = []   # 核实轮缓冲区：先攒着，回合结束按"有没有补做"决定 flush 还是丢弃
            try:
                async for _kind, _val in driver.run_round(client, ctx, messages):
                    if _kind == "done":
                        result = _val
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
            except RetryableError as e:
                # _stream_round 已经把原始异常记进受限诊断出口、也记过 WARNING 了，这里不重复记；
                # 只根据 cause 类型挑一句降级文案给用户。
                import anthropic
                busy = isinstance(e.cause, getattr(anthropic, "RateLimitError", ()))
                detail = "咕咕这会儿有点忙（接口繁忙），过几秒再发一次试试 🙏" if busy else "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return
            except Exception as e:
                # 已吐过 token 中途出错（emitted 就原样抛的路径）或其他未预期异常——按未知处理：
                # 原始进受限诊断出口，可见日志只留类型名，不带原始 str(e)。
                # where 里带上 provider + api_format——2026-07-14 那次 MiniMax AttributeError
                # 故障排查时，diag_log 没记 provider，只能靠静态代码分析猜是哪家（PRD-LLM-1
                # 「待确认问题」），这次直接把它写进日志，下次同类问题一眼就能看出是哪个 provider。
                diag_log(f"agent.core.main_loop provider={getattr(ai, 'provider', '') or 'unknown'} "
                         f"format={driver.api_format}", e)
                _log.error("LLM 调用中途出错：%s", type(e).__name__)
                detail = "咕咕开小差了 😵‍💫 麻烦再说一遍好吗？"
                yield f"data: {json.dumps({'type': 'error', 'detail': detail}, ensure_ascii=False)}\n\n"
                return

            total_in  += result.usage_in
            total_out += result.usage_out
            total_cache += result.cache_tokens

            if result.tool_calls:
                any_tool_called = True   # 本轮真调了工具 → narration 兜底不触发
                # 核实阶段首次补做（本轮调了增删改）→ 把"发现漏了X，补一下"说明发一次；之后的核对文字仍静默
                if verify_mode and not verify_fixed and _verify_buf and any(tc.name in _mutset for tc in result.tool_calls):
                    async for _line in genstream.typed_stream(''.join(_verify_buf)):   # 逐字流式，与正常回复一致
                        yield _line
                dispatched = []
                for tc in result.tool_calls:
                    label = self._label(tc.name)
                    if verify_mode:   # 复查前缀后端拼接（可在「状态命名」面板改 _verify_prefix；支持多候选随机）
                        label = self._label("_verify_prefix", "复查 · ") + label
                    if tc.parse_error:
                        # OpenAI 路专属：工具参数 JSON 被截断解析失败——别拿空参跑，改回一条错误
                        # tool_result 让模型精简参数后重发；不真 dispatch、不置 did_mutate。
                        yield f"data: {json.dumps({'type': 'tool_call', 'name': tc.name, 'label': label, 'input': {}, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                        yield f"data: {json.dumps({'type': 'tool_done', 'name': tc.name, 'label': label, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                        dispatched.append((tc, loop_drivers.TOOL_ARGS_TRUNCATED_ERROR))
                        continue
                    await _im_set_tool_state(tc.name)
                    # 自检轮工具照常显示，但打 verify 标记：前端凭 verify 收尾不冒「生成中」点点（否则回复完还在转、像卡住）
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': tc.name, 'label': label, 'input': tc.input, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    res, artifact = await registry.dispatch(user_id, tc.name, tc.input)
                    if tc.name in _mutset and _is_successful_tool_result(res):
                        did_mutate = True   # 本次成功做过增删改 → 立刻强制自我核实
                        if verify_mode:
                            verify_fixed = True   # 核实阶段里补了东西 → 确有遗漏
                    elif verify_mode and _is_read_tool(tc.name):
                        verify_queried = True   # 核实阶段真的用查询工具查证了（不是嘴上确认）
                    yield f"data: {json.dumps({'type': 'tool_done', 'name': tc.name, 'label': label, 'verify': verify_mode}, ensure_ascii=False)}\n\n"
                    if artifact:
                        yield f"data: {json.dumps({'type': 'file', 'file': artifact}, ensure_ascii=False)}\n\n"
                    dispatched.append((tc, res))
                driver.append_tool_round(messages, result, dispatched)
                # 工具结果已经入历史，直接接复查 prompt。旧流程会先多请求一次模型来生成
                # "已完成"，随后才开始复查；这轮没有新信息，只会徒增一次等待。
                if did_mutate and verify_count < MAX_VERIFY:
                    verify_count += 1
                    did_mutate = False
                    verify_mode = True
                    verify_queried = False
                    messages.append({"role": "user", "content": _VERIFY_PROMPT})
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue

            # 自我核实：① 理论上工具结果后会立即注入核实 prompt；这里保留为轮次封顶等
            # 边界状态的兜底；② 已进核实阶段却只嘴上确认、没真调过查询工具（verify_queried=False）→ 强制再追一轮真查。
            # 都受 MAX_VERIFY 封顶防死循环。补做会再置 did_mutate → 触发下一轮核实。
            _need_verify = did_mutate and verify_count < MAX_VERIFY
            _need_force  = verify_mode and not verify_queried and not did_mutate and verify_count < MAX_VERIFY
            if _need_verify or _need_force:
                verify_count += 1
                did_mutate = False
                verify_mode = True   # 进入/保持核实阶段 → 之后文字先缓冲
                driver.append_followup(messages, result, _VERIFY_FORCE_PROMPT if _need_force else _VERIFY_PROMPT)
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue

            _final_text = result.text
            # 空回复兜底：整轮无正文、没动工具、不在核实阶段 → 先追一轮要正文，仍空给句得体兜底。
            if not _final_text.strip() and not did_mutate and not verify_mode:
                if empty_retry < 1:
                    empty_retry += 1
                    driver.append_empty_retry(messages, result)
                    yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                    continue
                fb = "嗯…我这下没太接住，你再说一遍、或者换个说法，我马上跟上～"
                async for _line in genstream.typed_stream(fb):   # 空回复兜底也走逐字流式
                    yield _line
                _final_text = fb
            # narration 兜底：整段生成一个工具都没真调，但文字在"假装"读/改文件 → 追一轮逼它真调。
            # 只追一次；核实阶段不算（那是另一套）。
            if (not any_tool_called and not verify_mode and narration_retry < 1
                    and _looks_like_narration(_final_text)):
                narration_retry += 1
                driver.append_followup(messages, result, _NARRATION_NUDGE)
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 意图守卫（B）：宣告「我这就去查/建/改…」却本轮零工具 → 逼它当场做（_announces_intent 已排除问句/征询）。只追一次。
            if (not any_tool_called and not verify_mode and intent_retry < 1
                    and _announces_intent(_final_text)):
                intent_retry += 1
                driver.append_followup(messages, result, _INTENT_NUDGE)
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # P3 决策守卫：用户明确要改、模型零工具却用「不用改/已合理」驳回 → 逼它执行或问清，别擅自不做。
            if (not any_tool_called and not verify_mode and decision_retry < 1
                    and _is_decision_dodge(_user_req, _final_text)):
                decision_retry += 1
                driver.append_followup(messages, result, _DECISION_NUDGE)
                yield f"data: {json.dumps({'type': '_new_round'})}\n\n"
                continue
            # 即时复查时，前面还没有生成过最终说明；保留读回后的确认给用户，
            # 复查过程中的文字仍然一直缓冲、不显示。
            if verify_mode and verify_queried and _final_text.strip():
                async for _line in genstream.typed_stream(_final_text):
                    yield _line

            yield f"data: {json.dumps({'type': '_usage', 'input': total_in, 'output': total_out, 'cache_read': total_cache})}\n\n"
            return

        yield f"data: {json.dumps({'type': 'error', 'detail': '这步操作有点多，咕咕没在一口气里全做完，前面几步已经生效了，要我接着把剩下的做完吗？'}, ensure_ascii=False)}\n\n"

"""主会话只读快照：append_reuse 反思分支的短生命周期输入（PRD-LLM-27 §6.1）。

拓扑边界（§6.1 钉死的结论，落码即在此）：快照只存在于捕获它的进程内——
登记表是模块级内存结构，不写 Redis、不落数据库、不打正文日志。因此只有
「内联冲刷」路径（反思队列在主请求同进程内 drain）能直接拿到完整快照走
append_reuse；快照缺失时 owner idle worker 与群业务 worker 都从已持久化消息
重建追加历史，不创建独立提取器。重建只恢复最小历史与当前静态 system，不保留
完整 provider tools/动态上下文，所以不承诺前缀缓存命中。

快照内容是主请求实际发送的 provider 消息序列（canonical 形态），包含末尾
assistant 回复、不含 dynamic tail（时间 reminder 每轮必变，进快照会把公共
前缀截短）。revision 是 history 的 digest，供消费侧做漂移校验。
"""
from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

# TTL 与容量上限共同兜住内存占用：history 可能上百 KB，64 条 × 15 分钟足够
# 覆盖「主请求完成 → 内联反思冲刷」的窗口，同时防止长会话用户把登记表撑大。
_SNAPSHOT_TTL_SECONDS = 900.0
_SNAPSHOT_MAX_ENTRIES = 64


@dataclass(frozen=True)
class ReflectionSnapshot:
    """只读主会话快照；字段只允许进程内消费，禁止序列化外传。"""

    user_id: str
    session_id: int
    run_id: str | None
    # anthropic/openai 两条路由的 system 都不进消息容器，分支经 stable_system 传。
    system_prompt: str
    # 捕获时的模型配置对象（进程内引用）：消费侧用它做 provider/模型一致性门，
    # 并用同一份配置渲染历史——provider 切换后用新配置渲染旧前缀必然失配。
    ai: Any
    # 主 run 实际发给 provider 的工具声明（driver ctx.tools）；provider 把 tools
    # 算进可缓存前缀，缺了它整段 miss（PRD-MCP 复审与压缩分支的实测结论）。
    tools: tuple
    # canonical 形态消息（含末尾 assistant 回复，不含 dynamic tail）。
    history: tuple
    # digest(history)：快照自洽指纹；消费前重算比对可发现进程内篡改/损坏。
    revision: str
    created_at: float


_snapshots: "OrderedDict[tuple[str, int], ReflectionSnapshot]" = OrderedDict()


def model_identity(ai: Any) -> str:
    """provider/模型/API 格式的身份指纹（§6.7 一致性门的第一输入）。"""
    from agent.llm.llm_select import use_anthropic_for
    from .canonical_context import digest

    return digest({
        "provider": getattr(ai, "provider", ""),
        "model": getattr(ai, "model", ""),
        "api_format": getattr(ai, "api_format", ""),
        "anthropic_route": bool(use_anthropic_for(ai)),
    })


def capture_reflection_snapshot(
    *,
    user_id,
    session_id: int | None,
    run_id: str | None,
    ai: Any,
    system_prompt: str,
    tools,
    messages: Any,
    reply_text: str,
) -> ReflectionSnapshot | None:
    """主 run 成功收尾时捕获快照；任何异常都不能打断主流程（调用方亦应兜底）。"""
    try:
        if session_id is None or not (reply_text or "").strip():
            return None
        # PromptMessages.conversation 排除 dynamic tail；普通 list 调用方（测试/
        # 内部直调）原样作为前缀。末尾追加 assistant 回复——它是主请求的输出，
        # 不在请求输入序列里，追加属于尾部 delta，不影响前缀缓存命中。
        conversation = (
            list(messages.conversation)
            if hasattr(messages, "conversation") else list(messages)
        )
        if not conversation:
            return None
        history = tuple(conversation) + (
            ({"role": "assistant", "content": reply_text},)
            if (reply_text or "").strip() else ()
        )
        from .canonical_context import digest

        snapshot = ReflectionSnapshot(
            user_id=str(user_id),
            session_id=int(session_id),
            run_id=run_id,
            system_prompt=system_prompt or "",
            ai=ai,
            tools=tuple(tools or ()),
            history=history,
            revision=digest({"history": history}),
            created_at=time.monotonic(),
        )
        _snapshots[(snapshot.user_id, snapshot.session_id)] = snapshot
        _snapshots.move_to_end((snapshot.user_id, snapshot.session_id))
        while len(_snapshots) > _SNAPSHOT_MAX_ENTRIES:
            _snapshots.popitem(last=False)
        return snapshot
    except Exception:
        from app.core.redaction import diag_log
        # 只记异常类型与位置，不打快照内容（聊天正文/工具参数不进日志）。
        diag_log("agent.context.reflection_snapshot.capture", None)
        return None


def peek_reflection_snapshot(user_id, session_id: int | None) -> ReflectionSnapshot | None:
    """按 user+session 取快照（非破坏性：Memory 与 Knowledge 是 sibling branch，
    先后共用同一份快照）。TTL 过期视为不存在——过期快照对应的主会话可能已经
    前进，复用它有污染风险（§7）；owner 与群业务改由持久化消息重建追加历史。
    """
    if session_id is None:
        return None
    key = (str(user_id), int(session_id))
    snapshot = _snapshots.get(key)
    if snapshot is None:
        return None
    if time.monotonic() - snapshot.created_at > _SNAPSHOT_TTL_SECONDS:
        _snapshots.pop(key, None)
        return None
    _snapshots.move_to_end(key)
    return snapshot


def discard_reflection_snapshot(user_id, session_id: int | None) -> None:
    """会话删除/写回冲突等场景主动丢弃快照，防止后续反思复用过期前缀。"""
    if session_id is None:
        return
    _snapshots.pop((str(user_id), int(session_id)), None)


def _reset_for_tests() -> None:
    """仅测试使用：清空登记表，避免用例间串扰。"""
    _snapshots.clear()

"""BYOK 用户链路守卫：防止新调用点绕过 BYOK 静默烧平台配额。

历史 bug：定时任务、反思、压缩、总结、问候语都直接读 `settings.ai`（平台激活
预设），BYOK 用户聊天走自己的 Key，后台调用却烧平台配额，直到上游 429
insufficient_quota 才暴露。治本方案（2026-09-04）：

- 三个用户入口（Web 流/IM/定时）经 resolve_run_config_for_user 后把模型绑进
  modelctx（ContextVar，create_task 派生的后台任务自动继承）；
- 用户链路读模型一律走 `modelctx.effective_ai(settings)`；
- 本文件静态扫描禁止非白名单模块直读 `settings.ai`，防止问题复发。
"""
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3]

# 允许直读 settings.ai 的模块（相对 agent/、app/ 路径）：
# - llm_select/modelctx：解析与兜底本身
# - media_reader/run_finalize：主循环模型缺失时的兜底与 context_tokens 读取
# - media/gates/byok/policy：能力开关判断，不选模型
# - email_admin/agent_admin：管理端指定/平台预设按设计
ALLOWLIST = {
    "agent/llm/llm_select.py",
    "agent/llm/modelctx.py",
    "agent/core.py",
    "agent/tools/media_reader.py",
    "agent/context/run_finalize.py",
    "agent/media/gates.py",
    "app/byok/policy.py",
    "app/api/v1/email_admin.py",
    "app/api/v1/agent_admin.py",
}


def _iter_python_files():
    for base in ("agent", "app"):
        yield from (BACKEND / base).rglob("*.py")


def _non_code_lines(path: Path) -> set[int]:
    """返回只出现在注释或字符串字面量里的行号。

    守卫要拦的是"代码直读 settings.ai"，文档字符串里**提到** settings.ai
    （比如解释"为什么不能直读"）不是违规——只按行扫原文会把这类说明当成违规，
    制造误报。用 tokenize 把注释与字符串行标出来，扫描时跳过。
    """
    import io
    import tokenize

    source = path.read_text(encoding="utf-8")
    skip: set[int] = set()
    try:
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type in (tokenize.COMMENT, tokenize.STRING):
                skip.update(range(token.start[0], token.end[0] + 1))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return set()
    return skip


def test_user_scoped_modules_do_not_read_settings_ai_directly():
    """用户链路模块不得直读 settings.ai 选模型，必须走 modelctx.effective_ai。"""
    violations = []
    for path in _iter_python_files():
        rel = path.relative_to(BACKEND).as_posix()
        if rel in ALLOWLIST or "__pycache__" in rel:
            continue
        non_code = _non_code_lines(path)
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if lineno in non_code:
                # 注释 / 文档字符串里提到 settings.ai 不是"直读"
                continue
            stripped = line.strip()
            if "settings.ai" in line.replace(" ", "") and "context_tokens" not in line:
                # context_tokens 行是上下文预算兜底（与 run_finalize 同模式），不选模型
                violations.append(f"{rel}:{lineno}: {stripped}")
    assert not violations, (
        "以下代码直读 settings.ai（平台预设），用户链路会绕过 BYOK。"
        "请改用 agent.llm.modelctx.effective_ai(settings)，或确认属于白名单场景后"
        "把模块加入本测试的 ALLOWLIST：\n" + "\n".join(violations)
    )


def test_effective_ai_prefers_bound_model_and_warns_on_user_scope_fallback(monkeypatch):
    """effective_ai：绑定模型优先；用户链路未绑定时回落平台预设并打哨兵日志。"""
    import logging
    from types import SimpleNamespace

    from agent.llm import modelctx

    platform = object()
    bound = object()
    settings = SimpleNamespace(ai=platform)

    records = []
    handler = logging.Handler()
    handler.emit = lambda rec: records.append(rec.getMessage())
    logging.getLogger("agent.modelctx").addHandler(handler)
    try:
        # 无标记的纯后台上下文（如 admin）：回落不打哨兵
        assert modelctx.effective_ai(settings) is platform

        # 用户链路 + 已绑定：用绑定模型
        modelctx.mark_user_scope()
        modelctx.set_model_cfg(bound)
        assert modelctx.effective_ai(settings) is bound
        assert not any("兜底哨兵" in m for m in records)

        # 用户链路 + 未绑定：回落平台预设 + 哨兵日志现形
        modelctx.set_model_cfg(None)
        assert modelctx.effective_ai(settings) is platform
        assert any("兜底哨兵" in m for m in records)
    finally:
        logging.getLogger("agent.modelctx").removeHandler(handler)


def test_user_scope_and_binding_inherit_into_created_tasks():
    """create_task 派生的后台任务（反思/总结/压缩等）自动继承绑定与用户链路标记。"""
    import asyncio

    from agent.llm import modelctx

    async def main():
        modelctx.mark_user_scope()
        modelctx.set_model_cfg(object())

        async def child():
            return modelctx.get_model_cfg() is not None

        task = asyncio.create_task(child())
        _BG.add(task)
        return await task

    _BG = set()
    assert asyncio.run(main()) is True

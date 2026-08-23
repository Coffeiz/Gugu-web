"""Skill 基类与全局 registry。

一个工具只声明一次（name / description / input_schema），由基类派生
Anthropic 与 OpenAI 两种 schema，消除手写两份的重复。core 通过 registry
统一分发执行，替代原 agent.py 里的 `_exec_tool` if/elif。
"""
from __future__ import annotations

import json
import logging
import time
from contextvars import ContextVar
from typing import Any, Callable

from app.core.redaction import diag_log, diag_log_raw, redact as sanitize_error
from agent.tools.tool_contract import SchemaError, build_validator, invalid_input_payload, validate_input

# 工具调用轨迹（可观测，reliability Roadmap P1）：每次 dispatch 落一行 JSON 到 `agent.traj` logger
# → 经 INFO 进 gugu.log（Debug 面板 tail 得到）。「调没调工具/调了啥/成没成」翻一眼即得，不用复现+猜。
_traj_log = logging.getLogger("agent.traj")
_log = logging.getLogger("agent.tools")
_dispatch_session_id: ContextVar[int | None] = ContextVar("agent_dispatch_session_id", default=None)


def set_dispatch_session_id(session_id: int | None):
    """为当前 Agent 工具执行上下文绑定真实会话 ID。"""
    return _dispatch_session_id.set(session_id)


def reset_dispatch_session_id(token) -> None:
    _dispatch_session_id.reset(token)


def current_dispatch_session_id() -> int | None:
    return _dispatch_session_id.get()

# 脱敏逻辑（连接串/密钥/路径/UUID/traceback）已迁到 app.core.redaction.redact——
# app.*（API/存储/core）不得反向依赖 agent.*，放这儿会逼它们反依赖 agent；
# 这里保留 sanitize_error 这个名字只是别名，避免这个文件内一堆调用点改名（P2-b §5）。
# 详见 docs/refactor/P2b-错误处理规则.md、docs/security/安全-工具错误信息脱敏.md。


def _redact_result(name: str, result):
    """脱敏工具结果里的 error 字段——**任意深度**的 dict `error` 键 / `{"error":...}` 字符串。
    **只动 error 键，绝不碰正常内容**。脱敏前把原始 error print 到服务端日志、保排查。
    递归的原因：批量工具（如多文件保存）把 `{"error": str(e)}` 收进 `failed`/`saved` 列表，
    顶层只看 `error` 会漏掉这些嵌套错误串，导致原始 str(e)（含路径/UUID）直达模型。"""
    def _walk(obj):
        if isinstance(obj, dict):
            out = {}
            for k, v in obj.items():
                if k == "error" and isinstance(v, str) and v:
                    diag_log_raw(f"agent.tools.{name}", v[:2000])   # 原始 → 受限出口，不进 gugu.log
                    out[k] = sanitize_error(v)
                else:
                    out[k] = _walk(v)
            return out
        if isinstance(obj, list):
            return [_walk(x) for x in obj]
        return obj

    if isinstance(result, dict):
        return _walk(result)
    if isinstance(result, str) and result.lstrip().startswith('{"error"'):
        diag_log_raw(f"agent.tools.{name}", result[:2000])   # 原始 → 受限出口，不进 gugu.log
        try:
            d = json.loads(result)
            if isinstance(d, (dict, list)):
                return json.dumps(_walk(d), ensure_ascii=False)
        except Exception:
            return sanitize_error(result)
    return result


def _log_traj(name: str, user_id, args: Any, ok: bool, note: str, t0: float) -> None:
    """记一行工具调用轨迹（best-effort，绝不因记日志影响工具）。

    隐私：args 只记**结构**——数字/布尔/null（project_id 等便于排查落位）原样保留，字符串值
    一律打码（可能含文件名/客户名/正文），不把用户内容写进日志（与决策轨迹脱敏同口径）。
    非 object 输入只记类型名，不回显原值。
    """
    try:
        if isinstance(args, dict):
            summary = {}
            for k, v in args.items():
                summary[k] = v if isinstance(v, (int, float, bool)) or v is None else "***"
        else:
            summary = {"_input_type": type(args).__name__}
        _ms = int((time.monotonic() - t0) * 1000)
        rec = {"t": "tool", "tool": name, "user": str(user_id)[:8], "ok": ok, "ms": _ms, "args": summary}
        from agent.runtime.trace import get_trace
        if get_trace():
            rec["trace"] = get_trace()   # 全链路 trace：与网关「收到」行、worker 回复行同 id 可 grep 串联
        if not ok and note:
            rec["err"] = note[:120]
        _traj_log.info(json.dumps(rec, ensure_ascii=False))
        # 运维指标旁路（失败率/延迟分布，Redis 按日聚合）：fire-and-forget，绝不影响工具
        from app.core import opsmetrics
        opsmetrics.record_tool(name, ok, _ms)
    except Exception:
        pass

# 这些 id 键对应的模型都是 int 主键，LLM 传成字符串会让 asyncpg 抛错。统一在 dispatch 入口转 int。
# 注意：attach_id 是 hex 串（chat_attach 的 uuid4().hex）、user_id 是 UUID，都不在此列。
_INT_ID_KEYS = ("project_id", "file_id", "folder_id", "parent_id",
                "event_id", "client_id", "stage_id", "todo_id", "session_id", "node_id",
                "canvas_id", "item_id", "relation_id", "ref_id")


def _to_int_id(v):
    """把形如 "91" / "#91" 的字符串 id 转 int；非纯数字或非字符串原样返回。"""
    if isinstance(v, str):
        s = v.strip().lstrip("#")
        if s.isdigit():
            return int(s)
    return v


def _coerce_int_ids(args) -> None:
    """就地归一工具参数里的整型 id 和常见的结果数量。"""
    if not isinstance(args, dict):
        return
    for k in _INT_ID_KEYS:
        if k in args:
            args[k] = _to_int_id(args[k])
    # IM 模型有时会把 JSON Schema 中的 integer 参数序列化成数字字符串。
    # 在 schema 校验前做无损归一，避免把可执行的调用误判成输入错误；非数字字符串保持原样，
    # 仍由对应 schema 给出明确的 type 错误。
    if "max_results" in args:
        args["max_results"] = _to_int_id(args["max_results"])
    tgt = args.get("target")
    if isinstance(tgt, dict):
        for k in ("project_id", "folder_id"):
            if k in tgt:
                tgt[k] = _to_int_id(tgt[k])


async def _maybe_announce_progress(tool: "Tool", args: dict) -> None:
    """IM 慢工具进度声明（见 docs/agent/proposals/IM慢工具进度声明-设计.md）：工具即将真正执行
    时，若登记了 start_message 就发一条声明给用户，让 IM 非流式的长时间沉默有个"人在动手"的信号。
    文案 100% 来自工具自己的 metadata，绝不是模型现场生成——只在「工具确定要执行」这一刻触发，
    不存在"说了没做"的风险。仅 IM 生效（imctx 只有 IM 路径会 set）、每个 Busy Session（THINKING
    状态期间）最多发一次、失败不影响工具本身执行（fire-and-forget）。

    边界：只对「用户主动发起的 IM 消息」发声明。定时任务（群定时任务为取群 memory 也会
    set_im，但 message_id=None，见 app/scheduled_tasks.py::_inject_group_context）没有具体
    触发的 IM 消息，用户并不在等这句过渡话术——它应包含在最终报告里，不能单独发一条，故跳过。"""
    if not tool.start_message:
        return
    from agent.im import imctx
    payload = imctx.to_send_payload()
    if not payload:             # web 路径：imctx 没 set 过，压根不在 IM 上下文里
        return
    if not payload.get("message_id"):  # 定时任务等无具体触发消息的路径：不发进度声明
        return
    if imctx.was_announced():  # 本 Busy Session 已经发过声明，不重复发
        return
    try:
        from app.core.config import get_settings
        if not get_settings().agent.im_progress_announce_enabled:
            return
        # 用户已取消：不再发进度声明。取消是实时控制信号，声明会误导用户以为还在执行
        # （实测：取消后仍看到「我搜搜看有没有合适的图」这类 start_message）。
        im = imctx.get_im()
        if im and im.get("puid"):
            from agent.runtime import runtime_state as rt
            if await rt.is_cancelled(
                im["platform"], im.get("channel_id") or "", im.get("chat_id") or im["puid"], im["puid"]
            ):
                return
        text = tool.start_message(args) if callable(tool.start_message) else tool.start_message
        if not text:
            return
        imctx.mark_announced()   # 先标记再发送：即便发送失败也别在本 session 里反复重试打扰用户
        from agent.im.replies import send_text
        await send_text(payload, text)
    except Exception as e:
        print(f"[skill] 慢工具进度声明发送失败（不影响工具执行）: {type(e).__name__}: {e}", flush=True)


class Tool:
    """单个工具的声明 + 执行入口。"""

    def __init__(self, name: str, description: str, input_schema: dict,
                 handler, label: str | None = None, destructive: bool = False,
                 mutates: bool = False,
                 start_message: str | Callable[[dict], str] | None = None,
                 description_short: str | None = None,
                 category: str = "",
                 permissions: tuple[str, ...] = (),
                 platforms: tuple[str, ...] = (),
                 related_skills: tuple[str, ...] = (),
                 source: str = "builtin", schema_version: int = 1):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler          # async (db, user_id, args) -> dict | list
        self.label = label or name
        self.destructive = destructive  # 不可逆操作，handler 内走 confirm.gate
        # 是否会改数据（写库/改长期记忆/删笔记……）：定时任务只有在整轮没有任何
        # mutates=True 的调用时才允许重跑完整 execution（见 scheduled_tasks.py 的
        # mutated 判断）。以前靠猜工具名前缀（create_/update_/delete_/...），
        # remember、undo_last_gugu_note 这类不在前缀表里的写工具会被漏判，导致
        # 报错后重跑整轮、重复执行已经生效的写操作。destructive 管的是要不要走
        # confirm 二次确认，跟这个是两件事：写操作不一定不可逆（destructive），
        # 但只要写了就不能自动重放（mutates）。
        self.mutates = mutates
        # IM 慢工具进度声明用（仅 IM、每个 Busy Session 最多发一次，见 dispatch）：固定文案或
        # 按调用参数变化措辞的函数——只能读 dispatch 时已知的参数，不能猜返回结果（见设计文档 §2.3
        # 的边界：像 http_get 这种响应类型要等结果才知道的工具，就别细分，用统一粗粒度文案）。
        # 不设置 = 该工具认为自己够快，不需要这条声明。
        self.start_message = start_message
        # Capability Registry metadata。旧工具未补齐 metadata 时由 adapter 生成诊断，
        # 不改变既有工具 Schema 或 dispatch 语义。
        # label 是现有工具定义中的短用户可见名称；未显式补充短描述时用它作为迁移期
        # metadata，绝不从完整 description 截断生成。
        self.description_short = description_short or label or name
        self.category = category
        self.permissions = tuple(permissions)
        self.platforms = tuple(platforms)
        self.related_skills = tuple(related_skills)
        self.source = source
        self.schema_version = schema_version
        # 注册时由 SkillRegistry.add() 完成 schema 自检并缓存；未注册 Tool 不允许直接 dispatch。
        self._input_validator = None

    def to_anthropic(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


class BaseSkill:
    """领域技能基类：聚合一组 Tool。

    子类在 `tools` 列表里声明工具，实例化后调用 `register()` 自注册。
    """

    name: str = ""
    tools: list[Tool] = []

    def register(self) -> "BaseSkill":
        registry.add_skill(self.name, [t.name for t in self.tools])
        for tool in self.tools:
            registry.add(tool)
        return self


class ToolContractError(Exception):
    """工具注册期契约校验失败（重名 / 空名 / schema 非法 / handler 不可调用）。
    启动期 fail-fast，对齐 OpenClaw 的 assertUniqueNames / ToolPlanContractError——
    工具定义写错宁可启动就炸、立刻发现，也不要运行时静默失效（重名覆盖、调用崩）。"""


class SkillRegistry:
    """全局工具注册表，按工具名索引。"""

    def __init__(self):
        self._tools: dict[str, Tool] = {}
        self._skills: dict[str, list[str]] = {}  # skill 名 → 有序工具名

    def add(self, tool: Tool) -> None:
        # P4 · 注册期契约校验（fail-fast）：定义错在这里就炸，不留到运行时静默失效
        if not tool.name or not isinstance(tool.name, str):
            raise ToolContractError(f"工具名非法（空或非字符串）：{tool.name!r}")
        if tool.name in self._tools:
            raise ToolContractError(f"工具重名：{tool.name}（已注册，工具名必须全局唯一）")
        if not isinstance(tool.input_schema, dict) or tool.input_schema.get("type") != "object":
            raise ToolContractError(f"工具 {tool.name} 的 input_schema 非法：必须是 dict 且顶层 type='object'")
        if not callable(tool.handler):
            raise ToolContractError(f"工具 {tool.name} 的 handler 不可调用")
        try:
            tool._input_validator = build_validator(tool.input_schema)
        except SchemaError as e:
            rule = str(getattr(e, "validator", None) or "schema")
            raise ToolContractError(
                f"工具 {tool.name} 的 input_schema 不符合 JSON Schema Draft 2020-12（{rule}）"
            ) from e
        self._tools[tool.name] = tool

    def add_skill(self, name: str, tool_names: list[str]) -> None:
        """记录一个 skill 包含的工具（按声明顺序），供 profile 按 skill 组合。"""
        self._skills[name] = list(tool_names)

    def tools_of(self, skill_names: list[str]) -> list[str]:
        """把若干 skill 展开为有序、去重的工具名列表（profile.tool_names 据此派生）。"""
        out: list[str] = []
        seen: set[str] = set()
        for s in skill_names:
            for t in self._skills.get(s, []):
                if t not in seen:
                    seen.add(t)
                    out.append(t)
        return out

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def known_skill_names(self) -> set[str]:
        """已注册的 skill 组名集合，供调用方校验存量数据里的组名是否还认识
        （比如定时任务存的 tool_groups——组名改了/拼错了不该悄悄裁没工具）。"""
        return set(self._skills.keys())

    def labels(self) -> dict[str, str]:
        return {name: t.label for name, t in self._tools.items()}

    def anthropic_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_anthropic() for n in names if n in self._tools]

    def openai_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_openai() for n in names if n in self._tools]

    async def dispatch(self, user_id, name: str, args: Any) -> tuple[str, dict | None]:
        """执行工具，返回 (给 LLM 的 JSON 字符串, 给前端的 UI artifact|None)。

        工具结果若是 dict 且含 `_artifact` 键，则把它抽出来作为 artifact（如发文件卡片），
        其余字段序列化回给 LLM。每次工具调用自开一个数据库会话。
        """
        t0 = time.monotonic()
        from agent.im import imctx
        from agent.im.permissions import can_use_tool
        current_im = imctx.get_im()
        allowed_tool_names = current_im.get("allowed_tool_names") if current_im else None
        if not can_use_tool(name, allowed_tool_names):
            _log_traj(name, user_id, args, False, "当前群聊身份没有使用该工具的权限", t0)
            return json.dumps({"error": "当前群聊身份没有使用该工具的权限"}, ensure_ascii=False), None

        tool = self._tools.get(name)
        if tool is None:
            _log_traj(name, user_id, args, False, "未知工具", t0)
            return json.dumps({"error": f"未知工具: {name}"}), None

        # Shell 的会话身份由 Agent 执行器提供，不能信任模型自行填写的 session_id。
        # 兼容旧模型残留的同名参数：校验前丢弃，执行时统一使用真实会话 ID。
        public_args = args
        if name == "shell" and isinstance(args, dict) and "session_id" in args:
            public_args = dict(args)
            public_args.pop("session_id", None)
            args = public_args

        # JSON 能解析 ≠ 符合工具契约。先要求顶层 object，再保留现有 ID 弱归一，最后按
        # Tool.input_schema 做本地实例校验。任何失败都在进度声明/DB/handler/confirm 之前返回，
        # 防止“参数根本不能执行，却先对用户说我去做了”或 mutation handler 带错参运行。
        if not isinstance(args, dict):
            payload = invalid_input_payload(
                name,
                [{"path": "$", "rule": "type", "message": "工具输入必须是 object"}],
            )
            _log_traj(name, user_id, args, False, "tool_input_invalid:type", t0)
            return json.dumps(payload, ensure_ascii=False), None

        # 整型主键 id 归一：LLM 常把 id 当字符串传（"91"）。除 User 外所有模型都是 int 主键，
        # int4 列拿到字符串会让 asyncpg 直接抛 DataError（db.get(Project,"91") 崩，而非返回 None）。
        # 在 schema 校验前只转这批既有白名单 id；其它类型不做猜测式 coercion。
        _coerce_int_ids(args)

        # 正常工具会在 registry.add() 时缓存 validator；测试工具和少量运行时扩展可能直接
        # 注入 registry，仍需在 dispatch 边界补建，避免校验器为空导致整轮 Agent 崩溃。
        if tool._input_validator is None:
            tool._input_validator = build_validator(tool.input_schema)
        issues = validate_input(tool._input_validator, args)
        if issues:
            payload = invalid_input_payload(name, issues)
            first_rule = issues[0].get("rule", "invalid")
            _log_traj(name, user_id, args, False, f"tool_input_invalid:{first_rule}", t0)
            return json.dumps(payload, ensure_ascii=False), None

        await _maybe_announce_progress(tool, args)

        # user_id 归一成 UUID：IM 路（worker）传进来的是字符串，而 ORM 对象的 .user_id 是
        # UUID 对象。SQL 查询（File.user_id == user_id）能自动转型，但工具里 python 层的
        # 归属校验 `obj.user_id != user_id` 不会——字符串 vs UUID 永远不等，会把"自己的项目/
        # 文件夹"误判成"不存在"。在唯一入口统一转一次，下游所有校验/查询都对（str(uuid) 仍是
        # 同一规范字符串，存储 key 不变）。
        if isinstance(user_id, str):
            import uuid as _uuid
            try:
                user_id = _uuid.UUID(user_id)
            except (ValueError, AttributeError):
                pass   # 非标准 UUID 串：原样传，交给下游 SQL 比较

        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()

        # 工具异常不能冲垮整个对话：捕获后当作错误结果回给 LLM（它可解释/换路）。
        # 双出口（P2-b §4-B）：原始 traceback 只进受限诊断出口（不进 gugu.log/Debug 面板）；
        # 可见日志只留脱敏摘要 + 异常类型名；外发给模型/用户/轨迹的也只有脱敏版。
        try:
            async with _sess._SessionLocal() as db:
                handler_args = args
                if name == "shell":
                    handler_args = dict(args)
                    handler_args["_session_id"] = current_dispatch_session_id()
                result: Any = await tool.handler(db, user_id, handler_args)
                # Agent 一次工具调用就是一个任务事务边界。Service 层只负责 flush，
                # 由这里统一提交/回滚：handler 返回 error dict 说明业务校验失败，
                # 虽然不会修改数据（校验在写入前就 return 了），但 flush 可能留下
                # 部分状态，统一 rollback 更安全；成功路径统一 commit。
                if db is not None:
                    if isinstance(result, dict) and result.get("error"):
                        await db.rollback()
                    else:
                        await db.commit()
        except Exception as e:
            diag_log(f"agent.tools.dispatch.{name}", e)          # 原始 → 受限诊断出口
            _safe = sanitize_error(f"{type(e).__name__}: {e}")
            _log.error("工具 %s 执行出错：%s", name, _safe)        # 可见日志只给脱敏摘要
            _log_traj(name, user_id, args, False, _safe, t0)
            return json.dumps({"error": f"工具 {name} 执行出错：{_safe}"}, ensure_ascii=False), None

        # 脱敏工具自己返回的 error 字段（如 files.py 的 `{"error": f"…{str(e)}"}`）：只动 error、不碰正常内容；
        # 原始 error 已在 _redact_result 内 print 到日志。放在轨迹记录前，让 traj 也存脱敏版。
        result = _redact_result(name, result)

        # 工具调用轨迹（成功路径，一次覆盖 str / 图片块 / dict 三种返回）
        if isinstance(result, dict):
            _ok, _note = (not result.get("error")), str(result.get("error") or "")
        elif isinstance(result, str):
            _ok = not result.lstrip().startswith('{"error"')
            _note = "" if _ok else result[:120]
        else:
            _ok, _note = True, ""

        # destructive 绊线：不可逆工具在「未带 confirm」的调用里，合法结果只有两种——
        # needs_confirm 拦截（handler 内 confirm.needs_confirmation 返回）或业务错误。
        # 返回了"成功执行" = 该 handler 漏接确认门、无确认就做了不可逆操作——已无法撤销，
        # 但必须响亮地被看见（静态守卫 scripts/check_confirm_gate.py 在提交前拦同类问题，
        # 这里是运行时兜底，抓静态分析覆盖不到的动态路径）。
        from agent.security import confirm as _confirm
        if tool.destructive and _ok and not _confirm.is_confirmed(args) and not _confirm.is_block(result):
            print(f"[skill] ⚠️ confirm-gate.bypassed 工具 {name} 未经确认执行了不可逆操作！", flush=True)
            _traj_log.critical("confirm-gate.bypassed tool=%s user=%s", name, str(user_id)[:8])
            from app.core import opsmetrics
            opsmetrics.record_security("confirm-gate.bypassed")

        _log_traj(name, user_id, args, _ok, _note, t0)

        if isinstance(result, str):
            return result, None

        # 工具想让模型「看图」：返回 Anthropic 图片内容块（文字说明 + 图），核心循环原样塞进 tool_result.content。
        # 仅在 vision + anthropic 通道下由工具产生（如 read_file 读图片）；OpenAI 路工具不会走到这里。
        if isinstance(result, dict) and "_vision_image" in result:
            block = result.pop("_vision_image")
            note = result.get("note", "")
            content = ([{"type": "text", "text": note}] if note else []) + [block]
            return content, None

        if isinstance(result, dict) and "_vision_images" in result:
            images = result.pop("_vision_images")
            note = result.pop("inspection_note", "")
            content = ([{"type": "text", "text": note}] if note else [])
            for item in images:
                if isinstance(item, dict) and item.get("block"):
                    content.append({"type": "text", "text": item.get("title", "候选图片")})
                    content.append(item["block"])
            return content, None

        # 工具想让模型「看视频」：同上，真正的 video content block（不是代表帧/转写），
        # 目前只有 read_file 读文件库视频（file_readers.py 的 read_video）会产生，且仅限
        # MiniMax M3 这种 Anthropic 通道原生支持视频块的 provider——OpenAI 路工具结果只能
        # 是纯文本，走不到这里。
        if isinstance(result, dict) and "_video_media" in result:
            block = result.pop("_video_media")
            note = result.get("note", "")
            content = ([{"type": "text", "text": note}] if note else []) + [block]
            return content, None

        artifact = result.pop("_artifact", None) if isinstance(result, dict) else None
        # 细粒度增量提示（如删除类工具带 {op:remove,kind,id}）——供前端本地剔除，免全量重拉。
        # pop 掉别让它进给模型看的 JSON。咕咕/IM 侧无 client-id，origin 恒 None → 所有端都刷新。
        file_op = result.pop("_file_op", None) if isinstance(result, dict) else None

        # 改动型工具成功后，推「资源变了」事件给该用户的网页端实时刷新（best-effort）
        if not (isinstance(result, dict) and result.get("error")):
            from app.core import events
            res = events.RESOURCE_BY_TOOL.get(name)
            if res:
                try:
                    await events.publish(user_id, res, file_op=file_op if res == "files" else None)
                except Exception:
                    pass

        return json.dumps(result, ensure_ascii=False), artifact


registry = SkillRegistry()

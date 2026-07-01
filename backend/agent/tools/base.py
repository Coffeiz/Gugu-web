"""Skill 基类与全局 registry。

一个工具只声明一次（name / description / input_schema），由基类派生
Anthropic 与 OpenAI 两种 schema，消除手写两份的重复。core 通过 registry
统一分发执行，替代原 agent.py 里的 `_exec_tool` if/elif。
"""
from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

# 工具调用轨迹（可观测，reliability Roadmap P1）：每次 dispatch 落一行 JSON 到 `agent.traj` logger
# → 经 INFO 进 gugu.log（Debug 面板 tail 得到）。「调没调工具/调了啥/成没成」翻一眼即得，不用复现+猜。
_traj_log = logging.getLogger("agent.traj")


# ── 工具错误信息脱敏（安全：别把原始异常里的路径/UUID/连接串/密钥/traceback 透传给模型/用户/轨迹）──
# 详见 docs/安全-工具错误信息脱敏.md。这是「网」层（dispatch 级兜底）；原始细节仍 print 到服务端日志。
# ⚠️ 只用于 error 字段，绝不动正常工具结果（如 read_file 正文可能含任意文本）。
_CONN_RE = re.compile(r"\b(?:postgres(?:ql)?|redis|rediss|mysql|mongodb)://[^\s'\"]+", re.I)
_KEY_RE  = re.compile(r"\b(?:sk-[A-Za-z0-9]{16,}|(?:api[_-]?key|token|secret|bearer)[\"'=:\s]+[A-Za-z0-9._\-]{12,})", re.I)
_PATH_RE = re.compile(r"(?:\.{0,2}/)?(?:uploads|\.agent|\.thumbs|\.chat_staging)/[^\s'\"]*|/(?:home|opt|Users|var|etc|root|tmp|private)/[^\s'\"]*")
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_TB_RE   = re.compile(r"\n?\s*File \"[^\"]+\", line \d+[^\n]*(?:\n\s+[^\n]+)?")


def sanitize_error(s: str) -> str:
    """抹掉错误串里的敏感内部信息（连接串/密钥/路径/UUID/traceback）。顺序有讲究：
    连接串、密钥含路径/uuid 片段，先抹；再抹路径、UUID；最后去 traceback 帧。"""
    if not s or not isinstance(s, str):
        return s
    s = _CONN_RE.sub("‹连接串已隐藏›", s)
    s = _KEY_RE.sub("‹密钥已隐藏›", s)
    s = _PATH_RE.sub("‹路径已隐藏›", s)
    s = _UUID_RE.sub("‹id已隐藏›", s)
    s = _TB_RE.sub("", s)
    return s.strip()


def _redact_result(name: str, result):
    """脱敏工具结果里的 error 字段（dict 的 error 键 / `{"error":...}` 字符串）。
    **只动 error，绝不碰正常内容**（line 212 同款判别）。脱敏前把原始 error print 到服务端日志、保排查。"""
    if isinstance(result, dict):
        err = result.get("error")
        if isinstance(err, str) and err:
            print(f"[skill] 工具 {name} 返回错误(原始): {err[:300]}", flush=True)
            return {**result, "error": sanitize_error(err)}
        return result
    if isinstance(result, str) and result.lstrip().startswith('{"error"'):
        print(f"[skill] 工具 {name} 返回错误(原始): {result[:300]}", flush=True)
        try:
            d = json.loads(result)
            if isinstance(d.get("error"), str):
                d["error"] = sanitize_error(d["error"])
                return json.dumps(d, ensure_ascii=False)
        except Exception:
            return sanitize_error(result)
    return result


def _log_traj(name: str, user_id, args: dict, ok: bool, note: str, t0: float) -> None:
    """记一行工具调用轨迹（best-effort，绝不因记日志影响工具）。

    隐私：args 只记**结构**——数字/布尔/null（project_id 等便于排查落位）原样保留，字符串值
    一律打码（可能含文件名/客户名/正文），不把用户内容写进日志（与决策轨迹脱敏同口径）。
    """
    try:
        summary = {}
        for k, v in (args or {}).items():
            summary[k] = v if isinstance(v, (int, float, bool)) or v is None else "***"
        _ms = int((time.monotonic() - t0) * 1000)
        rec = {"t": "tool", "tool": name, "user": str(user_id)[:8], "ok": ok, "ms": _ms, "args": summary}
        from agent.trace import get_trace
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
                "event_id", "client_id", "stage_id", "todo_id", "session_id")


def _to_int_id(v):
    """把形如 "91" / "#91" 的字符串 id 转 int；非纯数字或非字符串原样返回。"""
    if isinstance(v, str):
        s = v.strip().lstrip("#")
        if s.isdigit():
            return int(s)
    return v


def _coerce_int_ids(args) -> None:
    """就地把 args（含嵌套 target）里的整型 id 键从字符串转成 int。"""
    if not isinstance(args, dict):
        return
    for k in _INT_ID_KEYS:
        if k in args:
            args[k] = _to_int_id(args[k])
    tgt = args.get("target")
    if isinstance(tgt, dict):
        for k in ("project_id", "folder_id"):
            if k in tgt:
                tgt[k] = _to_int_id(tgt[k])


class Tool:
    """单个工具的声明 + 执行入口。"""

    def __init__(self, name: str, description: str, input_schema: dict,
                 handler, label: str | None = None, destructive: bool = False):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler          # async (db, user_id, args) -> dict | list
        self.label = label or name
        self.destructive = destructive  # 不可逆操作，handler 内走 confirm.gate

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

    def labels(self) -> dict[str, str]:
        return {name: t.label for name, t in self._tools.items()}

    def anthropic_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_anthropic() for n in names if n in self._tools]

    def openai_schemas(self, names: list[str]) -> list[dict]:
        return [self._tools[n].to_openai() for n in names if n in self._tools]

    async def dispatch(self, user_id, name: str, args: dict) -> tuple[str, dict | None]:
        """执行工具，返回 (给 LLM 的 JSON 字符串, 给前端的 UI artifact|None)。

        工具结果若是 dict 且含 `_artifact` 键，则把它抽出来作为 artifact（如发文件卡片），
        其余字段序列化回给 LLM。每次工具调用自开一个数据库会话。
        """
        t0 = time.monotonic()
        tool = self._tools.get(name)
        if tool is None:
            _log_traj(name, user_id, args, False, "未知工具", t0)
            return json.dumps({"error": f"未知工具: {name}"}), None

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

        # 整型主键 id 归一：LLM 常把 id 当字符串传（"91"）。除 User 外所有模型都是 int 主键，
        # int4 列拿到字符串会让 asyncpg 直接抛 DataError（db.get(Project,"91") 崩，而非返回 None）。
        # 在入口把这些 id 键转成 int，下游 db.get/比较都稳。attach_id 是 hex 串、不能转，排除。
        _coerce_int_ids(args)

        import app.db.session as _sess
        if _sess._engine is None:
            _sess._build_engine()

        # 工具异常不能冲垮整个对话：捕获后当作错误结果回给 LLM（它可解释/换路），并打日志便于排查
        try:
            async with _sess._SessionLocal() as db:
                result: Any = await tool.handler(db, user_id, args)
        except Exception as e:
            import traceback
            print(f"[skill] 工具 {name} 执行出错: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()   # 原始 traceback 进服务端日志，排查不丢
            # 给模型/用户/轨迹的版本脱敏：异常串常含路径/UUID/连接串/密钥（见 docs/安全-工具错误信息脱敏.md）
            _safe = sanitize_error(f"{type(e).__name__}: {e}")
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
        from agent import confirm as _confirm
        if tool.destructive and _ok and not _confirm.is_confirmed(args) and not _confirm.is_block(result):
            print(f"[skill] ⚠️ confirm-gate.bypassed 工具 {name} 未经确认执行了不可逆操作！", flush=True)
            _traj_log.critical("confirm-gate.bypassed tool=%s user=%s", name, str(user_id)[:8])

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

        artifact = result.pop("_artifact", None) if isinstance(result, dict) else None

        # 改动型工具成功后，推「资源变了」事件给该用户的网页端实时刷新（best-effort）
        if not (isinstance(result, dict) and result.get("error")):
            from app.core import events
            res = events.RESOURCE_BY_TOOL.get(name)
            if res:
                try:
                    await events.publish(user_id, res)
                except Exception:
                    pass

        return json.dumps(result, ensure_ascii=False), artifact


registry = SkillRegistry()

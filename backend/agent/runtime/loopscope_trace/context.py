from __future__ import annotations

import functools
import inspect
from pathlib import Path
from typing import Any

from .state import _now, record_context_source
from .utils import _display_source_path, _estimate_tokens, _jsonable

def _loader_input(name: str, args: tuple[Any, ...], kwargs: dict[str, Any]) -> dict[str, Any]:
    # db/session 本身不序列化；只留 user/query/limit/tz 等真正影响结果的参数。
    vals = list(args)
    if vals and hasattr(vals[0], "execute"):
        vals = vals[1:]
    return {"args": _jsonable(vals), "kwargs": _jsonable(kwargs), "loader": name}

def _loader_rows(result: Any) -> int | None:
    if isinstance(result, (list, tuple, set, dict)):
        return len(result)
    return None

def _wrap_context_loader(module: Any, name: str, kind: str, label: str) -> None:
    original = getattr(module, name, None)
    if original is None or getattr(original, "__loopscope_wrapped__", False):
        return

    @functools.wraps(original)
    async def wrapped(*args, **kwargs):
        start = _now()
        result = await original(*args, **kwargs)
        end = _now()
        record_context_source(
            kind,
            label,
            input=_loader_input(name, args, kwargs),
            output=_jsonable(result),
            attributes={"loader": name, "rows": _loader_rows(result)},
            code_target=original,
            source_value=result,
            started_at=start,
            ended_at=end,
        )
        return result

    wrapped.__loopscope_wrapped__ = True
    setattr(module, name, wrapped)

def _prompt_file_path(path: Path) -> str:
    return _display_source_path(path)

def _record_builder_sources(context_builder: Any, original_build: Any, bound: inspect.BoundArguments, result: tuple[str, str, str], start: float, end: float) -> None:
    try:
        args = bound.arguments
        profile = str(args.get("profile") or "default")
        include_memory = bool(args.get("include_memory", True))
        include_projects = bool(args.get("include_projects", True))
        include_calendar = bool(args.get("include_calendar", True))
        include_files = bool(args.get("include_files", True))
        projects = args.get("projects") or []
        events = args.get("events") or []
        files = args.get("files") or {}
        memory = args.get("memory") or {}
        style_prefs = args.get("style_prefs") or {}
        skills = args.get("skills") or []
        source = args.get("source")
        im_channels = args.get("im_channels") or {}

        # 先把真正读取的 prompt 文件逐个登记。profile 模板包含占位符，因此记录 raw；最终展开值在
        # Context Assembly 的完整 system_prompt 与下面各 runtime fragment 里查看。
        prompt_dir = getattr(context_builder, "_PROMPTS_DIR", None)
        if prompt_dir:
            for filename, role in (
                ("persona.md", "persona"),
                ("skills.md", "execution_policy"),
                ("policy.md", "content_policy"),
                (f"{profile}.md", "profile_template"),
            ):
                path = Path(prompt_dir) / filename
                try:
                    content = path.read_text(encoding="utf-8").strip()
                except FileNotFoundError:
                    continue
                record_context_source(
                    "file",
                    filename,
                    input={"path": _prompt_file_path(path), "role": role},
                    output={"content": content},
                    attributes={"path": _prompt_file_path(path), "role": role},
                    code_target=original_build,
                    source_value=content,
                    included_value=content if role != "profile_template" else None,
                    started_at=start,
                    ended_at=end,
                )

        # builder 内真正进入 prompt 的业务片段也单独呈现，方便把 DB 原始结果与最终文字对照。
        if include_projects:
            status_zh = getattr(context_builder, "_STATUS_ZH", {})
            lines = []
            for p in projects[:25]:
                deadline = f"截止 {p.deadline}" if getattr(p, "deadline", None) else "无截止"
                stages = getattr(p, "stages", None) or []
                done_cnt = sum(1 for s in stages if isinstance(s, dict) and s.get("done"))
                prog = f"{done_cnt}/{len(stages)}阶段" if stages else "无阶段"
                lines.append(
                    f"- [id={p.id}] [{status_zh.get(p.status, p.status)}] {p.name}"
                    f"（{prog}，{deadline}，客户：{getattr(p, 'client', None) or '无'}）"
                )
            block = "\n".join(lines) if lines else "暂无项目"
            record_context_source(
                "context",
                "Rendered project context",
                output={"content": block},
                attributes={"source": "projects", "rows": len(projects[:25])},
                code_target=original_build,
                included_value=block,
            )

        if include_calendar:
            block = "\n".join(f"- {ev.date} {ev.title}" for ev in events[:10]) if events else "暂无近期事件"
            record_context_source(
                "context",
                "Rendered calendar context",
                output={"content": block},
                attributes={"source": "calendar", "rows": len(events[:10])},
                code_target=original_build,
                included_value=block,
            )

        if include_files:
            try:
                names = {p.id: p.name for p in projects}
                block = context_builder._files_block(files, names)
                record_context_source(
                    "context",
                    "Rendered files context",
                    output={"content": block},
                    attributes={"source": "files"},
                    code_target=original_build,
                    included_value=block,
                )
            except Exception:
                pass

        if include_memory:
            try:
                mem_block = context_builder._memory_block(memory)
                record_context_source(
                    "memory",
                    "Assembled memory block",
                    output={"content": mem_block},
                    attributes={"source": "memory", "assembled": True},
                    code_target=original_build,
                    included_value=mem_block,
                )
            except Exception:
                pass
            for key, label in (
                ("summary", "Memory · recent state"),
                ("profile", "Memory · profile"),
                ("pattern", "Memory · patterns"),
                ("memory", "Memory · long term"),
                ("daily", "Memory · recent"),
                ("lens", "Memory · lens"),
            ):
                value = memory.get(key)
                if isinstance(value, str) and value.strip():
                    record_context_source(
                        "memory",
                        label,
                        output={"content": value.strip()},
                        attributes={"memory_key": key, "component": True},
                        code_target=original_build,
                        source_value=value.strip(),
                    )

        for label, fn, params in (
            ("Reply style", getattr(context_builder, "_style_block", None), (style_prefs,)),
            ("Skill index", getattr(context_builder, "_skills_index_block", None), (skills,)),
            ("Conversation source", getattr(context_builder, "_source_block", None), (source, im_channels)),
        ):
            if fn is None:
                continue
            try:
                block = fn(*params)
            except Exception:
                block = ""
            if block:
                attributes = {}
                if label == "Skill index":
                    skill_rows = skills if isinstance(skills, (list, tuple)) else []
                    skill_slugs = []
                    for row in skill_rows:
                        if isinstance(row, str) and row:
                            skill_slugs.append(row)
                        elif isinstance(row, dict) and row.get("slug"):
                            skill_slugs.append(str(row["slug"]))
                    attributes = {
                        "context_source": "skill_index",
                        "source": "skills_index",
                        "skill_count": len(skill_rows),
                        "skill_slugs": skill_slugs,
                    }
                record_context_source(
                    "context",
                    label,
                    output={"content": block},
                    attributes=attributes,
                    code_target=original_build,
                    included_value=block,
                )

        # build_split 已是唯一组装入口，直接记录其真实三段返回值。
        if isinstance(result, tuple) and len(result) == 3:
            static_text, dynamic_text, now_text = result
            for label, content, role in (
                ("Prompt stable prefix", static_text, "stable_prefix"),
                ("Prompt snapshot context", dynamic_text, "snapshot_context"),
                ("Prompt current time", now_text, "volatile_tail"),
            ):
                if content:
                    record_context_source(
                        "cache" if role != "volatile_tail" else "context",
                        label,
                        output={"content": content},
                        attributes={"cache_role": role},
                        code_target=original_build,
                        included_value=content,
                    )
    except Exception:
        pass

def install_context_hooks(context_loaders: Any, context_builder: Any):
    for name, kind, label in (
        ("load_projects", "database", "DB · Projects"),
        ("load_user_tz", "database", "DB · User timezone"),
        ("load_events", "database", "DB · Calendar events"),
        ("load_files_overview", "database", "DB · Files overview"),
        ("load_style_prefs", "database", "DB · Reply style preferences"),
        ("load_memory", "memory", "Memory retrieval"),
        ("load_im_channels", "context", "IM channel state"),
    ):
        _wrap_context_loader(context_loaders, name, kind=kind, label=label)

    original_build = context_builder.build_split
    if not getattr(original_build, "__loopscope_wrapped__", False):
        @functools.wraps(original_build)
        def traced_build(*args, **kwargs):
            start = __import__('time').time()
            result = original_build(*args, **kwargs)
            end = __import__('time').time()
            try:
                sig = inspect.signature(original_build)
                bound = sig.bind_partial(*args, **kwargs); bound.apply_defaults()
                _record_builder_sources(context_builder, original_build, bound, result, start, end)
            except Exception:
                pass
            return result
        traced_build.__loopscope_wrapped__ = True
        context_builder.build_split = traced_build
    return original_build

#!/usr/bin/env python3
"""验证英文偏好下三个模型的连续对话语言表现。

测试完全在内存中进行：不读取数据库、不创建用户或会话、不加载记忆/项目/文件，
也不注册工具。每个模型单独维护一份连续消息列表，连续请求三轮。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

_UID = "00000000-0000-0000-0000-000000000000"
_PROMPTS = (
    "Please answer in one short sentence: what is the main benefit of keeping a conversation history?",
    "Now refer to your previous answer and give one practical example.",
    "Finally, summarize both answers in exactly two short English bullet points.",
)


def _language(text: str) -> str:
    letters = [char for char in text if char.isascii() and char.isalpha()]
    cjk = sum("\u4e00" <= char <= "\u9fff" for char in text)
    if cjk and cjk >= len(letters):
        return "中文"
    if letters and cjk == 0:
        return "英文"
    return "混合/空"


def _presets(settings, providers: set[str]) -> list[Any]:
    selected = []
    seen = set()
    for item in list(getattr(getattr(settings, "ai_presets", None), "items", None) or []):
        provider = str(getattr(item, "provider", "") or "").lower()
        if provider in providers and provider not in seen:
            selected.append(item)
            seen.add(provider)
    missing = providers - seen
    if missing:
        raise RuntimeError(f"缺少模型预设：{', '.join(sorted(missing))}")
    return selected


async def _run_model(settings, model_cfg) -> dict[str, Any]:
    from agent.context.assembly import PromptMessages
    from agent.core import LLMRunner
    from agent.llm.llm_select import use_anthropic_for
    from test_full_schema_compact_ab import payload

    anthropic = use_anthropic_for(model_cfg)
    system = (
        "## Current conversation language\n"
        "Unless the user explicitly asks for another language, always reply in English."
    )
    messages = PromptMessages()
    runner = LLMRunner([], settings)
    rows = []
    for turn, prompt in enumerate(_PROMPTS, 1):
        messages.append({"role": "user", "content": prompt})
        generation = runner.run(
            _UID,
            system if anthropic else None,
            messages if anthropic else PromptMessages(
                [{"role": "system", "content": system}, *messages]
            ),
            anthropic,
            model_cfg,
        )
        parts: list[str] = []
        errors: list[str] = []
        try:
            async for raw in generation:
                event = payload(raw) if isinstance(raw, str) else raw
                if not event:
                    continue
                if event.get("type") == "token":
                    parts.append(str(event.get("content") or ""))
                elif event.get("type") == "error":
                    errors.append(type(event.get("detail")).__name__)
        finally:
            await generation.aclose()
        reply = "".join(parts)
        messages.append({"role": "assistant", "content": reply})
        rows.append({"turn": turn, "reply_language": _language(reply), "reply_chars": len(reply), "errors": errors})
    return {
        "provider": str(getattr(model_cfg, "provider", "")),
        "model": str(getattr(model_cfg, "model", "")),
        "turns": rows,
        "all_english": all(row["reply_language"] == "英文" and not row["errors"] for row in rows),
    }


async def _main(args: argparse.Namespace) -> int:
    if not args.allow_real_llm:
        raise SystemExit("必须显式传入 --allow-real-llm 才会请求真实模型")
    from app.core.config import get_settings

    settings = get_settings()
    providers = {item.strip().lower() for item in args.providers.split(",") if item.strip()}
    reports = []
    for model_cfg in _presets(settings, providers):
        reports.append(await _run_model(settings, model_cfg))
    print(json.dumps({"memory": "disabled", "database": "not used", "turns_per_model": 3, "reports": reports}, ensure_ascii=False, indent=2))
    return 0 if all(report["all_english"] for report in reports) else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="英文偏好连续对话测试")
    parser.add_argument("--providers", default="qwen,deepseek,glm")
    parser.add_argument("--allow-real-llm", action="store_true")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args)))


if __name__ == "__main__":
    main()

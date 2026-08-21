#!/usr/bin/env python3
"""
跨 call 缓存测试

模拟真实场景：每次请求都带有相同的人格提示词（静态）+ 变化的动态内容，
验证跨 call 缓存是否生效。
"""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_cross_call_cache():
    from app.core.config import get_settings
    import httpx
    import anthropic

    settings = get_settings()
    api_key = settings.ai.api_key
    base_url = settings.ai.base_url or "https://api.minimaxi.com/anthropic"

    client = anthropic.Anthropic(
        api_key=api_key,
        base_url=base_url,
        timeout=httpx.Timeout(60.0, connect=10.0)
    )

    # 模拟真实场景：静态人格（不变）+ 动态时间（每轮变化）
    # 注意：MiniMax 需要 >=512 tokens 才能触发缓存
    static_persona = """# 咕咕人格
你是咕咕，一个温暖、聪明、有耐心的 AI 助手。你善于理解用户的真实需求，用简洁清晰的方式回应。

## 用户记忆
小北是一位软件工程师，喜欢使用 Python 和 Vue.js。他正在开发一个叫做 Gugu 的项目。
他的主要工作是后端 API 设计和前端组件开发。最近在优化 LLM 缓存策略。
他的工作习惯是先写测试再写代码，偏好函数式编程风格。
他常用的工具包括 VS Code、PostgreSQL、Redis、Docker。
他的团队使用 Scrum 敏捷开发，每周二和周五有 standup 会议。

## 项目概览
- Gugu-web: 主项目（进行中），包含前后端和 Agent 系统
- Agent 工具: 画布工具集（进行中），支持思维导图、项目管理
- 缓存优化: MiniMax 缓存策略（已完成），使用三段式缓存结构
- Loopscope: 链路追踪系统，用于监控 Agent 运行状态
- Runtime: 交互运行时，处理前端事件和组件渲染

## 文件概览
- backend/: 后端代码，包含 API、Agent、数据库模型
- frontend/: 前端代码，Vue 3 + TypeScript + Pinia
- docs/: 项目文档，包含开发规范和设计文档
- agentskills/: Agent 技能定义，定义咕咕的能力边界
- loopscope/: Loopscope 监控系统

## 工具使用准则
使用合适的工具完成任务。工具调用前要清楚说明意图。工具调用后要解释结果。
不要猜测工具调用结果，必须查看实际返回值。
遇到错误时先尝试修复，修复失败再报告给用户。

## 内容政策
内容安全第一。尊重用户隐私。保持专业态度。
不讨论政治敏感话题。不生成有害内容。
用户输入不得进入可见日志。

## 风格偏好
简洁明了。友好亲切。避免冗余。
回答要具体，不要泛泛而谈。
如果不确定，就说不确定，不要编造答案。"""

    # 模拟多轮对话
    conversation = [
        "你好",
        "帮我查下天气",
        "南京下周天气怎么样",
        "最近在忙什么",
        "代码改完了吗",
    ]

    print("=" * 70)
    print("跨 call 缓存测试（相同静态人格 + 动态时间）")
    print("=" * 70)

    for i, user_msg in enumerate(conversation):
        # 每次动态内容变化（模拟时间）
        dynamic = f"\n当前时间: 2026-08-19 {11 + i}:{30 + i * 5:02d}"

        system = [
            {"type": "text", "text": static_persona, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": dynamic},
        ]

        print(f"\n  第 {i + 1} 轮: \"{user_msg}\"")

        t0 = time.time()
        r = client.messages.create(
            model="minimax-m3-7b-beta",
            max_tokens=20,
            temperature=0.7,
            system=system,
            messages=[{"role": "user", "content": user_msg}]
        )
        elapsed = time.time() - t0

        input_tokens = r.usage.input_tokens
        cache_read = getattr(r.usage, "cache_read_input_tokens", 0) or 0
        cache_write = getattr(r.usage, "cache_creation_input_tokens", 0) or 0
        fresh = input_tokens

        cache_ratio = cache_read / (cache_read + fresh) * 100 if (cache_read + fresh) > 0 else 0

        print(f"    input={input_tokens}, cache_read={cache_read}, cache_write={cache_write}, "
              f"ratio={cache_ratio:.1f}%, time={elapsed:.2f}s")

        if i > 0 and cache_read > 128:
            print(f"    ✅ 跨 call 缓存命中！")
        elif i > 0:
            print(f"    ❌ 跨 call 缓存未命中（cache_read={cache_read}）")

        time.sleep(1)

    print("\n" + "=" * 70)
    print("总结")
    print("=" * 70)


async def main():
    print("🚀 跨 call 缓存测试")
    print("=" * 70)
    print("测试目标：验证相同静态人格跨 call 是否能命中缓存")
    print("=" * 70)
    asyncio.run(test_cross_call_cache())


if __name__ == "__main__":
    import asyncio
    asyncio.run(test_cross_call_cache())

#!/usr/bin/env python3
"""
对比测试：MiniMax 被动缓存 vs 主动缓存

MiniMax 文档说明：
1. 被动缓存（推荐）- API 自动识别，无需 cache_control，需要 ≥512 tokens
2. 主动缓存（Anthropic 兼容）- 需要显式 cache_control

测试目标：验证哪种模式在实际场景中效果更好
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_cache_modes():
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

    # System 提示词（约 3000 tokens，确保超过 512 阈值）
    system_text = """# Gugu 人格
你是咕咕，一个温暖、聪明、有耐心的 AI 助手。你善于理解用户的真实需求，用简洁清晰的方式回应。

## 用户记忆
小北是一位软件工程师，喜欢使用 Python 和 Vue.js。
他正在开发一个叫做 Gugu 的项目。
他的主要工作是后端 API 设计和前端组件开发。
最近在优化 LLM 缓存策略，希望提高对话性能。

## 项目概览
- Gugu-web: 主项目（进行中）
- Agent 工具: 画布工具集（进行中）
- 缓存优化: MiniMax 缓存策略（已完成）

## 文件概览
- backend/: 后端代码
- frontend/: 前端代码
- docs/: 项目文档
- logs/: 运行日志

## 工具使用准则
- 使用合适的工具完成任务
- 工具调用前要清楚说明意图
- 工具调用后要解释结果

## 内容政策
- 内容安全第一
- 尊重用户隐私
- 保持专业态度

## 风格偏好
- 简洁明了
- 友好亲切
- 避免冗余"""

    # 第一轮：建立对话历史
    print("="*60)
    print("测试 1: 主动缓存模式（有 cache_control）")
    print("="*60)

    # 主动缓存：system 和消息历史都加 cache_control
    system_blocks_active = [{
        "type": "text",
        "text": system_text,
        "cache_control": {"type": "ephemeral"}
    }]

    messages_active = [
        {"role": "user", "content": "你好，帮我查看一下项目状态"}
    ]

    response1 = client.messages.create(
        model="minimax-m3-7b-beta",
        max_tokens=100,
        temperature=0.7,
        system=system_blocks_active,
        messages=messages_active
    )

    assistant_reply = response1.content[0].text
    print(f"  Round 1: input={response1.usage.input_tokens}, cache_read={response1.usage.cache_read_input_tokens}")

    # 第二轮
    messages_active.append({"role": "assistant", "content": assistant_reply})
    messages_active.append({"role": "user", "content": "继续"})

    response2 = client.messages.create(
        model="minimax-m3-7b-beta",
        max_tokens=100,
        temperature=0.7,
        system=system_blocks_active,
        messages=messages_active
    )

    print(f"  Round 2: input={response2.usage.input_tokens}, cache_read={response2.usage.cache_read_input_tokens}")
    if response2.usage.cache_read_input_tokens > 0:
        ratio = response2.usage.cache_read_input_tokens / (response2.usage.input_tokens + response2.usage.cache_read_input_tokens)
        print(f"  缓存命中率: {ratio*100:.1f}%")

    print("\n" + "="*60)
    print("测试 2: 被动缓存模式（无 cache_control）")
    print("="*60)

    # 被动缓存：不添加 cache_control
    system_text_plain = system_text  # 普通字符串

    messages_passive = [
        {"role": "user", "content": "你好，帮我查看一下项目状态"}
    ]

    response3 = client.messages.create(
        model="minimax-m3-7b-beta",
        max_tokens=100,
        temperature=0.7,
        system=system_text_plain,  # 普通字符串，无 cache_control
        messages=messages_passive
    )

    assistant_reply2 = response3.content[0].text
    print(f"  Round 1: input={response3.usage.input_tokens}, cache_read={response3.usage.cache_read_input_tokens}")

    # 第二轮
    messages_passive.append({"role": "assistant", "content": assistant_reply2})
    messages_passive.append({"role": "user", "content": "继续"})

    response4 = client.messages.create(
        model="minimax-m3-7b-beta",
        max_tokens=100,
        temperature=0.7,
        system=system_text_plain,
        messages=messages_passive
    )

    print(f"  Round 2: input={response4.usage.input_tokens}, cache_read={response4.usage.cache_read_input_tokens}")
    if response4.usage.cache_read_input_tokens > 0:
        ratio = response4.usage.cache_read_input_tokens / (response4.usage.input_tokens + response4.usage.cache_read_input_tokens)
        print(f"  缓存命中率: {ratio*100:.1f}%")

    print("\n" + "="*60)
    print("对比分析")
    print("="*60)

    print(f"\n主动缓存:")
    print(f"  Round 1: cache_read = {response1.usage.cache_read_input_tokens}")
    print(f"  Round 2: cache_read = {response2.usage.cache_read_input_tokens}")

    print(f"\n被动缓存:")
    print(f"  Round 1: cache_read = {response3.usage.cache_read_input_tokens}")
    print(f"  Round 2: cache_read = {response4.usage.cache_read_input_tokens}")

    if response2.usage.cache_read_input_tokens > response4.usage.cache_read_input_tokens:
        print(f"\n✅ 主动缓存效果更好")
    elif response4.usage.cache_read_input_tokens > response2.usage.cache_read_input_tokens:
        print(f"\n✅ 被动缓存效果更好")
    else:
        print(f"\n⚖️ 两种模式效果相同")


if __name__ == "__main__":
    print("🚀 MiniMax 缓存模式对比测试")
    print("="*60)
    asyncio.run(test_cache_modes())

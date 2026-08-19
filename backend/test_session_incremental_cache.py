#!/usr/bin/env python3
"""
Session 增量缓存测试

模拟 dsh 的消息累积模式：
- 每次请求发送完整的消息历史（system + 所有历史 messages）
- 验证跨 call 缓存是否能命中（system prefix 不变时）

测试策略：
1. 静态 system（完全不变）→ 预期跨 call 缓存命中
2. 动态 system（每次变化）→ 预期跨 call 缓存不命中
3. 混合模式（静态 system + 动态在 messages 中）→ 预期跨 call 缓存命中
"""

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_session_incremental():
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

    # 静态 system（完全不变）
    static_system = """# 咕咕人格
你是咕咕，一个温暖、聪明、有耐心的 AI 助手。你善于理解用户的真实需求，用简洁清晰的方式回应。

## 用户画像
小北是一位软件工程师，喜欢使用 Python 和 Vue.js。

## 工具使用准则
使用合适的工具完成任务。工具调用前要清楚说明意图。

## 内容政策
内容安全第一。尊重用户隐私。保持专业态度。

## 风格偏好
简洁明了。友好亲切。避免冗余。"""

    # 模拟 5 轮对话（每次发送完整历史）
    conversation_history = []

    print("=" * 70)
    print("Session 增量缓存测试（静态 system + 累积 messages）")
    print("=" * 70)

    user_messages = [
        "你好，我是小北",
        "帮我查下天气",
        "南京下周天气怎么样",
        "最近在忙什么",
        "代码改完了吗",
    ]

    for i, user_msg in enumerate(user_messages):
        # 添加用户消息到历史
        conversation_history.append({"role": "user", "content": user_msg})

        # 模拟 assistant 回复（简化）
        if i > 0:
            conversation_history.append({
                "role": "assistant",
                "content": f"好的，我来帮你处理：{user_msg}"
            })

        system = [{
            "type": "text",
            "text": static_system,
            "cache_control": {"type": "ephemeral"}
        }]

        # 给最后一条用户消息加 cache_control（dsh 的做法）
        if conversation_history and conversation_history[-1]["role"] == "user":
            last_msg = conversation_history[-1].copy()
            last_msg["content"] = [{
                "type": "text",
                "text": last_msg["content"],
                "cache_control": {"type": "ephemeral"}
            }]
            messages = conversation_history[:-1] + [last_msg]
        else:
            messages = list(conversation_history)

        print(f"\n  第 {i + 1} 轮: \"{user_msg}\"")
        print(f"    messages 数量: {len(messages)}")

        t0 = time.time()
        r = client.messages.create(
            model="minimax-m3-7b-beta",
            max_tokens=20,
            temperature=0.7,
            system=system,
            messages=messages
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


if __name__ == "__main__":
    print("🚀 Session 增量缓存测试")
    print("=" * 70)
    print("测试目标：验证静态 system + 累积 messages 的跨 call 缓存效果")
    print("=" * 70)
    asyncio.run(test_session_incremental())

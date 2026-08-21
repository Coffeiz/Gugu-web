#!/usr/bin/env python3
"""
真实测试：验证将 dynamic 内容移到 messages[0] 后的跨 call 缓存效果

测试场景：连续 5 轮天气查询，验证 round1 cache_read 是否提升
"""
import asyncio
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_cross_call_cache_with_optimization():
    """测试优化后的跨 call 缓存"""
    from app.core.config import get_settings
    import httpx
    import anthropic

    settings = get_settings()
    client = anthropic.Anthropic(
        api_key=settings.ai.api_key,
        base_url=settings.ai.base_url or "https://api.minimaxi.com/anthropic",
        timeout=httpx.Timeout(60.0, connect=10.0)
    )

    from agent.context import builder

    print("=" * 70)
    print("真实测试：优化后的跨 call 缓存效果")
    print("=" * 70)

    # 模拟连续 5 轮对话
    conversation_history = []
    static_system = None

    for i in range(5):
        # 每轮都调用 build_split
        static, dynamic = builder.build_split(
            "default", "小北", [], [],
            memory={"summary": f"记忆内容第{i+1}轮"},
            files={"total": 5},
            skills=["weather"],
            source="web"
        )

        # 优化方案：static 放 system，dynamic 放 messages[0]
        if i == 0:
            static_system = static  # 第一轮建立缓存

        # 构建 messages
        messages = []
        # dynamic 内容作为 messages[0]
        messages.append({"role": "user", "content": dynamic})
        # 历史消息
        messages.extend(conversation_history)
        # 当前用户消息
        user_msg = f"第{i+1}轮天气查询"
        messages.append({"role": "user", "content": user_msg})

        print(f"\n  第 {i+1} 轮: \"{user_msg}\"")
        print(f"    System 长度: {len(static_system)} (不变)")
        print(f"    Dynamic 长度: {len(dynamic)}")
        print(f"    Messages 数量: {len(messages)}")

        # 发起 API 调用
        r = client.messages.create(
            model="minimax-m3-7b-beta",
            max_tokens=10,
            temperature=0.7,
            system=[{"type": "text", "text": static_system, "cache_control": {"type": "ephemeral"}}],
            messages=messages
        )

        cache_read = getattr(r.usage, "cache_read_input_tokens", 0) or 0
        input_tokens = r.usage.input_tokens
        cache_ratio = cache_read / (input_tokens + cache_read) * 100 if (input_tokens + cache_read) > 0 else 0

        print(f"    input={input_tokens}, cache_read={cache_read}, ratio={cache_ratio:.1f}%")

        if i > 0 and cache_read > 128:
            print(f"    ✅ 跨 call 缓存命中！")
        elif i > 0:
            print(f"    ❌ 跨 call 缓存未命中")

        # 更新历史消息（模拟 assistant 回复）
        conversation_history.append({"role": "user", "content": user_msg})
        conversation_history.append({"role": "assistant", "content": f"第{i+1}轮回复"})

        time.sleep(1)


async def main():
    """主函数"""
    await test_cross_call_cache_with_optimization()


if __name__ == "__main__":
    print("真实测试：验证优化后的跨 call 缓存效果")
    print("=" * 70)
    asyncio.run(main())

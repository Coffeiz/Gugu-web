#!/usr/bin/env python3
"""
测试新的组装结构：system=static，messages=历史+动态+当前消息

验证：
1. system prefix 跨 call 完全一致
2. 动态内容可以正确注入到 messages[0]
3. 跨 call 缓存命中率
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_new_assembly():
    """测试新的组装结构"""
    from app.core.config import get_settings
    import httpx
    import anthropic
    from agent.context import builder

    settings = get_settings()
    client = anthropic.Anthropic(
        api_key=settings.ai.api_key,
        base_url=settings.ai.base_url or "https://api.minimaxi.com/anthropic",
        timeout=httpx.Timeout(60.0, connect=10.0)
    )

    print("=" * 70)
    print("测试新架构：system=static，messages=历史+动态+当前消息")
    print("=" * 70)

    # 1. 生成 static 部分（完全静态）
    static_text, _ = builder.build_split(
        "default", "小北", [], [],
        memory={}, files={}, skills=[], source="web"
    )
    print(f"\n1. Static 部分：{len(static_text)} chars（完全静态，跨 call 不变）")

    # 2. 模拟 5 轮对话
    conversation_history = []

    for i in range(5):
        # 动态内容（每次变化）
        dynamic_context = f"""## 当前状态

### 记忆
用户是软件工程师，正在开发 Gugu 项目。

### 相处方式
本轮相处方式：好好陪聊（Companion）

### 当前时间
2026-08-20 03:0{i}，深夜未眠"""

        # 构建 messages
        messages = []

        # messages[0] = 动态上下文（每次变化）
        messages.append({"role": "user", "content": dynamic_context})

        # 累积历史消息
        messages.extend(conversation_history)

        # 当前用户消息（每次变化）
        user_msg = f"第{i+1}轮测试消息"
        messages.append({"role": "user", "content": user_msg})

        print(f"\n2. 第 {i+1} 轮：\"{user_msg}\"")
        print(f"   Messages 数量: {len(messages)}")

        # 发起 API 调用
        r = client.messages.create(
            model="minimax-m3-7b-beta",
            max_tokens=10,
            temperature=0.7,
            system=[{"type": "text", "text": static_text, "cache_control": {"type": "ephemeral"}}],
            messages=messages
        )

        cache_read = getattr(r.usage, "cache_read_input_tokens", 0) or 0
        input_tokens = r.usage.input_tokens
        cache_ratio = cache_read / (input_tokens + cache_read) * 100 if (input_tokens + cache_read) > 0 else 0

        print(f"   input={input_tokens}, cache_read={cache_read}, ratio={cache_ratio:.1f}%")

        if i > 0 and cache_read > 128:
            print(f"   ✅ 跨 call 缓存命中！")
        elif i > 0:
            print(f"   ❌ 跨 call 缓存未命中")

        # 更新历史消息
        conversation_history.append({"role": "user", "content": user_msg})
        conversation_history.append({"role": "assistant", "content": f"第{i+1}轮回复"})

        time.sleep(1)


async def main():
    """主函数"""
    await test_new_assembly()


if __name__ == "__main__":
    from pathlib import Path
    print("🚀 测试新架构：system=static，messages=历史+动态+当前消息")
    print("=" * 70)
    asyncio.run(main())

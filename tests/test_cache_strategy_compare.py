#!/usr/bin/env python3
"""
缓存策略对比测试

对比两种策略的真实效果：
- 策略 A：当前策略（保守，只有稳定前缀标记缓存）
- 策略 B：激进策略（所有内容都标记缓存）

跑 3 轮对话，比较每轮的 cache_read_tokens 和 cache_write_tokens
"""

import asyncio
import json
import sys
import time
from pathlib import Path
from typing import AsyncGenerator

sys.path.insert(0, str(Path(__file__).parent))


async def make_llm_request(messages, system_text, mark_all_cache=False):
    """
    发起真实的 LLM 请求

    mark_all_cache: True 表示激进策略，所有 system 都标记缓存
                   False 表示保守策略，只有稳定前缀标记
    """
    from app.core.config import get_settings
    import httpx
    from agent import providers
    import anthropic

    settings = get_settings()
    api_key = settings.ai.api_key
    base_url = settings.ai.base_url or "https://api.minimaxi.com/anthropic"

    # 构建 system 块
    if mark_all_cache:
        # 激进策略：所有 system 都标记 cache_control
        system_blocks = [
            {
                "type": "text",
                "text": system_text,
                "cache_control": {"type": "ephemeral"}
            }
        ]
    else:
        # 保守策略：按 CACHE_BREAK 分割，只标记前半部分
        from agent.context.builder import split_for_cache
        stable, dynamic = split_for_cache(system_text)
        if dynamic:
            system_blocks = [
                {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}},
                {"type": "text", "text": dynamic}
            ]
        else:
            system_blocks = [
                {"type": "text", "text": stable, "cache_control": {"type": "ephemeral"}}
            ]

    # 给消息历史的每个块也加 cache_control
    prepared_messages = []
    for msg in messages:
        content = msg.get("content")
        if isinstance(content, list):
            # 块形式，给最后一个块加 cache_control
            new_content = content[:-1] + [
                {**content[-1], "cache_control": {"type": "ephemeral"}}
            ] if content else content
            prepared_messages.append({**msg, "content": new_content})
        else:
            # 字符串形式，转成块
            new_content = [{
                "type": "text",
                "text": content,
                "cache_control": {"type": "ephemeral"}
            }] if mark_all_cache or content else [{"type": "text", "text": content}]
            prepared_messages.append({**msg, "content": new_content})

    # 发起请求
    client = anthropic.Anthropic(
        api_key=api_key,
        base_url=base_url,
        timeout=httpx.Timeout(60.0, connect=10.0)
    )

    response_obj = await asyncio.to_thread(
        client.messages.create,
        model="minimax-m3-7b-beta",
        max_tokens=100,
        temperature=0.7,
        system=system_blocks,
        messages=prepared_messages
    )

    # 提取 usage 信息
    usage = response_obj.usage
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read_tokens": getattr(usage, 'cache_read_input_tokens', 0) or 0,
        "cache_write_tokens": getattr(usage, 'cache_creation_input_tokens', 0) or 0,
    }


async def simulate_conversation(strategy_name, mark_all_cache):
    """
    模拟 3 轮对话，对比同一策略在多轮中的缓存效果

    每轮发送相同的消息，看缓存命中情况
    """
    print(f"\n{'='*60}")
    print(f"策略: {strategy_name} ({'激进' if mark_all_cache else '保守'})")
    print(f"{'='*60}")

    # 构造一个真实的 system prompt
    # 包括用户人格、记忆、项目信息等
    system_text = """# Gugu 人格
你是咕咕，一个温暖、聪明、有耐心的 AI 助手。你善于理解用户的真实需求，用简洁清晰的方式回应。

## 当前任务
帮助用户完成各种任务，包括但不限于回答问题、编写代码、提供建议等。

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
- 避免冗余

## 技能索引
- 文件操作
- 时间管理
- 项目管理
- 搜索能力
""" + "\x1d" + """## 用户记忆
小北是一位软件工程师，喜欢使用 Python 和 Vue.js。
他正在开发一个叫做 Gugu 的项目。
他的主要工作是后端 API 设计和前端组件开发。

## 当前状态
时间：2026-08-19
最近对话：关于项目画布和缓存优化
当前活跃项目：Gugu-web（7 个项目）

## 项目概览
- Gugu-web: 主项目（进行中）
- Agent 工具: 画布工具集（进行中）
- 缓存优化: MiniMax 缓存策略（已完成）

## 文件概览
- backend/: 后端代码
- frontend/: 前端代码
- docs/: 项目文档
- logs/: 运行日志
"""

    # 3 轮对话
    conversations = [
        "帮我查看一下当前的项目状态",
        "项目画布相关的工具都有哪些？",
        "缓存优化方面有什么最新进展？"
    ]

    results = []

    # 第一轮：建立缓存
    messages = [{"role": "user", "content": conversations[0]}]
    print(f"\n  第 1 轮: {conversations[0]}")

    result = await make_llm_request(messages, system_text, mark_all_cache)
    result['round'] = 1
    result['user_msg'] = conversations[0]
    results.append(result)
    print(f"    input_tokens: {result['input_tokens']}")
    print(f"    cache_read_tokens: {result['cache_read_tokens']}")
    print(f"    cache_write_tokens: {result['cache_write_tokens']}")
    if result['cache_read_tokens'] > 0:
        ratio = result['cache_read_tokens'] / (result['input_tokens'] + result['cache_read_tokens'])
        print(f"    缓存命中率: {ratio*100:.1f}%")

    # 模拟助手回复
    assistant_response = "好的，我来帮你看看项目状态。当前你有 7 个项目在进行中..."

    # 第二轮：复用缓存
    messages.append({"role": "assistant", "content": assistant_response})
    messages.append({"role": "user", "content": conversations[1]})
    print(f"\n  第 2 轮: {conversations[1]}")

    result = await make_llm_request(messages, system_text, mark_all_cache)
    result['round'] = 2
    result['user_msg'] = conversations[1]
    results.append(result)
    print(f"    input_tokens: {result['input_tokens']}")
    print(f"    cache_read_tokens: {result['cache_read_tokens']}")
    print(f"    cache_write_tokens: {result['cache_write_tokens']}")
    if result['cache_read_tokens'] > 0:
        ratio = result['cache_read_tokens'] / (result['input_tokens'] + result['cache_read_tokens'])
        print(f"    缓存命中率: {ratio*100:.1f}%")

    # 第三轮
    messages.append({"role": "assistant", "content": "项目画布相关的工具包括..."})
    messages.append({"role": "user", "content": conversations[2]})
    print(f"\n  第 3 轮: {conversations[2]}")

    result = await make_llm_request(messages, system_text, mark_all_cache)
    result['round'] = 3
    result['user_msg'] = conversations[2]
    results.append(result)
    print(f"    input_tokens: {result['input_tokens']}")
    print(f"    cache_read_tokens: {result['cache_read_tokens']}")
    print(f"    cache_write_tokens: {result['cache_write_tokens']}")
    if result['cache_read_tokens'] > 0:
        ratio = result['cache_read_tokens'] / (result['input_tokens'] + result['cache_read_tokens'])
        print(f"    缓存命中率: {ratio*100:.1f}%")

    return results


async def main():
    """主函数：对比两种策略"""
    print("🚀 缓存策略对比测试")
    print("="*60)
    print("目标：对比'全部标记缓存'vs'当前策略'的真实效果")
    print("="*60)

    # 策略 A：当前策略（保守）
    print("\n📊 测试 1: 当前策略（保守）")
    results_A = await simulate_conversation("当前策略", mark_all_cache=False)

    # 等待 1 秒，确保上一轮缓存不命中（测试新策略）
    await asyncio.sleep(2)

    # 策略 B：激进策略（全部标记）
    print("\n📊 测试 2: 激进策略（全部标记缓存）")
    results_B = await simulate_conversation("激进策略", mark_all_cache=True)

    # 对比分析
    print(f"\n{'='*60}")
    print("📊 对比分析")
    print(f"{'='*60}")

    print(f"\n{'轮次':<6} {'策略':<10} {'input':<8} {'cache_read':<12} {'cache_write':<12} {'命中率':<8}")
    print("-"*70)

    for i, (a, b) in enumerate(zip(results_A, results_B), 1):
        ratio_a = a['cache_read_tokens'] / (a['input_tokens'] + a['cache_read_tokens']) * 100 if (a['input_tokens'] + a['cache_read_tokens']) > 0 else 0
        ratio_b = b['cache_read_tokens'] / (b['input_tokens'] + b['cache_read_tokens']) * 100 if (b['input_tokens'] + b['cache_read_tokens']) > 0 else 0

        print(f"{i:<6} {'保守':<10} {a['input_tokens']:<8} {a['cache_read_tokens']:<12} {a['cache_write_tokens']:<12} {ratio_a:.1f}%")
        print(f"{i:<6} {'激进':<10} {b['input_tokens']:<8} {b['cache_read_tokens']:<12} {b['cache_write_tokens']:<12} {ratio_b:.1f}%")
        print("-"*70)

    # 计算节省
    print(f"\n💰 缓存效果分析:")

    total_input_A = sum(r['input_tokens'] for r in results_A)
    total_cache_A = sum(r['cache_read_tokens'] for r in results_A)
    total_input_B = sum(r['input_tokens'] for r in results_B)
    total_cache_B = sum(r['cache_read_tokens'] for r in results_B)

    print(f"  保守策略总 input_tokens: {total_input_A}")
    print(f"  保守策略总 cache_read_tokens: {total_cache_A}")
    if total_cache_A > 0:
        print(f"  保守策略平均命中率: {total_cache_A/(total_input_A + total_cache_A)*100:.1f}%")

    print(f"\n  激进策略总 input_tokens: {total_input_B}")
    print(f"  激进策略总 cache_read_tokens: {total_cache_B}")
    if total_cache_B > 0:
        print(f"  激进策略平均命中率: {total_cache_B/(total_input_B + total_cache_B)*100:.1f}%")

    if total_cache_A > 0 and total_cache_B > 0:
        improvement = (total_cache_B - total_cache_A) / total_cache_A * 100
        print(f"\n  激进策略相对保守策略缓存提升: {improvement:+.1f}%")

    print(f"\n✨ 结论:")
    print(f"  - 如果激进策略命中率明显更高，建议改为激进策略")
    print(f"  - 如果两者差异不大（< 10%），保守策略更稳定")
    print(f"  - 关键看 cache_write_tokens（第一轮）vs cache_read_tokens（后续轮）的比例")


if __name__ == "__main__":
    print("🚀 缓存策略对比测试")
    print("="*60)

    asyncio.run(main())
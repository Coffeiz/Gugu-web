#!/usr/bin/env python3
"""测试 MiniMax 的主动缓存 vs 被动缓存效果

说明：
- 主动缓存：发送 cache_control，API 返回 cache_read_input_tokens
- 被动缓存：不发送 cache_control，API 不报告 cache_read_input_tokens

用法：
    python tests/minimax_cache_test.py
"""
import os
import json
import sys
from pathlib import Path

# 添加项目根目录到路径
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

# 直接读取 config.override.json 中的 MiniMax 配置
def load_minimax_config():
    config_path = project_root / "config.override.json"
    if not config_path.exists():
        print(f"❌ 配置文件不存在: {config_path}")
        sys.exit(1)

    with open(config_path, 'r', encoding='utf-8') as f:
        config = json.load(f)

    # 优先从 ai_presets 中读取
    if config.get("ai_presets", {}).get("items"):
        for preset in config["ai_presets"]["items"]:
            if preset.get("provider") == "minimax":
                return {
                    "api_key": preset.get("api_key", ""),
                    "base_url": preset.get("base_url", "https://api.minimax.chat/v1/text/chatcompletion_v2"),
                    "model": preset.get("model", "MiniMax-M3"),
                }

    # 回退到全局 ai 配置
    if config.get("ai", {}).get("provider") == "minimax":
        ai = config["ai"]
        return {
            "api_key": ai.get("api_key", ""),
            "base_url": ai.get("base_url", "https://api.minimax.chat/v1/text/chatcompletion_v2"),
            "model": ai.get("model", "MiniMax-M3"),
        }

    print("❌ 未找到 MiniMax 配置")
    sys.exit(1)


config = load_minimax_config()
minimax_api_key = config["api_key"]
minimax_base_url = config["base_url"]
minimax_model = config["model"]

if not minimax_api_key:
    print("❌ 未找到 MiniMax API Key")
    sys.exit(1)

# 如果 model 是 "MiniMax-M3"，尝试替换为官方兼容模型
if minimax_model in ("MiniMax-M3", "minimax-m3"):
    minimax_model = "abab6.5s-chat"

import httpx


def parse_stream_response(content: str):
    """解析 Anthropic/SSE 流式响应"""
    lines = content.strip().split('\n')
    message_data = None
    usage_data = None

    for line in lines:
        line = line.strip()
        if line.startswith('data: '):
            data_str = line[6:]
            if data_str == '[DONE]':
                break
            try:
                chunk = json.loads(data_str)
                if chunk.get('type') == 'message_start':
                    message_data = chunk
                elif chunk.get('type') == 'message_delta':
                    if message_data is None:
                        message_data = {}
                    message_data.update(chunk.get('delta', {}))
                elif chunk.get('type') == 'message_stop':
                    pass
                elif chunk.get('type') == 'message_content_block_delta':
                    if message_data is None:
                        message_data = {}
                    content_blocks = message_data.get('content', [])
                    if content_blocks:
                        content_blocks[-1].update(chunk.get('delta', {}))
                        message_data['content'] = content_blocks
                elif chunk.get('type') == 'message_stop':
                    pass
            except json.JSONDecodeError:
                continue

    # 尝试从原始响应中提取 usage 信息（Anthropic 格式）
    # usage 通常在 message_stop 之后或作为一个单独的 event
    for line in lines:
        line = line.strip()
        if line.startswith('data: '):
            data_str = line[6:]
            if data_str == '[DONE]':
                break
            try:
                chunk = json.loads(data_str)
                if chunk.get('type') == 'message_stop':
                    # 检查是否有 usage 在 payload 中
                    usage = chunk.get('usage')
                    if usage:
                        return {
                            'choices': [{'message': {'content': ''}}],
                            'usage': usage
                        }
            except json.JSONDecodeError:
                continue

    if message_data:
        # 提取 usage
        usage = message_data.get('usage', message_data.get('delta', {}).get('usage', {}))
        return {
            'choices': [{'message': {'content': message_data.get('content', '')}}],
            'usage': usage
        }

    return None


def test_active_cache(session_id: int = 1):
    """测试主动缓存模式"""
    print(f"\n{'='*70}")
    print(f"测试 1: 主动缓存模式 (Session {session_id})")
    print(f"{'='*70}")

    # 模拟多轮对话：2 轮
    messages_active = [
        {
            "role": "user",
            "content": [{"type": "text", "text": "记住我说的第一句话：今天天气真好"}]
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "好的，今天天气真好！你有什么计划吗？"}]
        },
        {
            "role": "user",
            "content": [{"type": "text", "text": "我计划去公园野餐"}]
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "听起来很棒！野餐需要准备什么呢？"}]
        },
    ]

    # 给每条消息的最后一块打 cache_control
    for msg in messages_active:
        if isinstance(msg["content"], list) and msg["content"]:
            last_block = msg["content"][-1]
            last_block["cache_control"] = {"type": "ephemeral"}

    # Anthropic 兼容格式
    url = f"{minimax_base_url.rstrip('/')}/v1/messages"

    payload = {
        "model": minimax_model,
        "messages": messages_active,
        "temperature": 0.7,
        "max_tokens": 500,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {minimax_api_key}",
        "Content-Type": "application/json",
        "X-Minimax-Group-ID": "test-active",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            content = resp.content.decode('utf-8')

        data = parse_stream_response(content)

        if not data:
            print(f"❌ API 响应格式异常: {content[:200]}")
            return None

        message = data.get("choices", [{}])[0].get("message", {})
        usage = data.get("usage", {})

        cache_read = usage.get("prompt_cache_hit_tokens", 0)

        print(f"User: {messages_active[-1]['content'][0]['text']}")
        print(f"Assistant: {message.get('content', '')}")
        print(f"\nUsage:")
        print(f"  - Input tokens: {usage.get('prompt_tokens', 0)}")
        print(f"  - Output tokens: {usage.get('completion_tokens', 0)}")
        print(f"  - Cache read: {cache_read}")
        print(f"  - Cache ratio: {cache_read / usage.get('prompt_tokens', 1) * 100:.2f}%" if usage.get('prompt_tokens') else "  - Cache ratio: N/A (prompt_tokens=0)")

        return {
            "session_id": session_id,
            "mode": "active",
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "cache_read": cache_read,
            "cache_ratio": cache_read / usage.get('prompt_tokens', 1) * 100 if usage.get('prompt_tokens') else 0,
        }

    except Exception as e:
        print(f"❌ 请求失败: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_passive_cache(session_id: int = 1):
    """测试被动缓存模式（不发送 cache_control）"""
    print(f"\n{'='*70}")
    print(f"测试 2: 被动缓存模式 (Session {session_id})")
    print(f"{'='*70}")

    # 完全相同的 messages，但不加 cache_control
    messages_passive = [
        {
            "role": "user",
            "content": [{"type": "text", "text": "记住我说的第一句话：今天天气真好"}]
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "好的，今天天气真好！你有什么计划吗？"}]
        },
        {
            "role": "user",
            "content": [{"type": "text", "text": "我计划去公园野餐"}]
        },
        {
            "role": "assistant",
            "content": [{"type": "text", "text": "听起来很棒！野餐需要准备什么呢？"}]
        },
    ]

    url = f"{minimax_base_url.replace('/v1', '')}/completion"

    payload = {
        "model": minimax_model,
        "messages": messages_passive,
        "temperature": 0.7,
        "max_tokens": 500,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {minimax_api_key}",
        "Content-Type": "application/json",
        "X-Minimax-Group-ID": "test-passive",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            content = resp.content.decode('utf-8')

        data = parse_stream_response(content)

        if not data:
            print(f"❌ API 响应格式异常: {content[:200]}")
            return None

        message = data.get("choices", [{}])[0].get("message", {})
        usage = data.get("usage", {})

        cache_read = usage.get("prompt_cache_hit_tokens", 0)

        print(f"User: {messages_passive[-1]['content'][0]['text']}")
        print(f"Assistant: {message.get('content', '')}")
        print(f"\nUsage:")
        print(f"  - Input tokens: {usage.get('prompt_tokens', 0)}")
        print(f"  - Output tokens: {usage.get('completion_tokens', 0)}")
        print(f"  - Cache read: {cache_read}")
        print(f"  - Cache ratio: {cache_read / usage.get('prompt_tokens', 1) * 100:.2f}%" if usage.get('prompt_tokens') else "  - Cache ratio: N/A (prompt_tokens=0)")

        return {
            "session_id": session_id,
            "mode": "passive",
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "cache_read": cache_read,
            "cache_ratio": cache_read / usage.get('prompt_tokens', 1) * 100 if usage.get('prompt_tokens') else 0,
        }

    except Exception as e:
        print(f"❌ 请求失败: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_long_conversation_active(session_id: int = 1):
    """测试长对话的主动缓存效果（多轮工具调用）"""
    print(f"\n{'='*70}")
    print(f"测试 3: 长对话主动缓存 (Session {session_id})")
    print(f"{'='*70}")

    # 模拟更长的对话（4 轮）
    messages = []

    for i in range(4):
        messages.append({
            "role": "user",
            "content": [{"type": "text", "text": f"第 {i+1} 轮：{['创建任务', '查询任务', '更新任务', '总结任务'][i]}"}]
        })
        messages.append({
            "role": "assistant",
            "content": [{"type": "text", "text": f"已执行第 {i+1} 轮操作"}]
        })

    # 给每条消息的最后一块打 cache_control
    for msg in messages:
        if isinstance(msg["content"], list) and msg["content"]:
            last_block = msg["content"][-1]
            last_block["cache_control"] = {"type": "ephemeral"}

    url = f"{minimax_base_url.replace('/v1', '')}/completion"

    payload = {
        "model": minimax_model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 500,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {minimax_api_key}",
        "Content-Type": "application/json",
        "X-Minimax-Group-ID": "test-active-long",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            content = resp.content.decode('utf-8')

        data = parse_stream_response(content)

        if not data:
            print(f"❌ API 响应格式异常")
            return None

        message = data.get("choices", [{}])[0].get("message", {})
        usage = data.get("usage", {})

        cache_read = usage.get("prompt_cache_hit_tokens", 0)

        print(f"User: {messages[-1]['content'][0]['text']}")
        print(f"Assistant: {message.get('content', '')}")
        print(f"\nUsage:")
        print(f"  - Input tokens: {usage.get('prompt_tokens', 0)}")
        print(f"  - Output tokens: {usage.get('completion_tokens', 0)}")
        print(f"  - Cache read: {cache_read}")
        print(f"  - Cache ratio: {cache_read / usage.get('prompt_tokens', 1) * 100:.2f}%" if usage.get('prompt_tokens') else "  - Cache ratio: N/A (prompt_tokens=0)")

        return {
            "session_id": session_id,
            "mode": "active",
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "cache_read": cache_read,
            "cache_ratio": cache_read / usage.get('prompt_tokens', 1) * 100 if usage.get('prompt_tokens') else 0,
        }

    except Exception as e:
        print(f"❌ 请求失败: {e}")
        import traceback
        traceback.print_exc()
        return None


def test_long_conversation_passive(session_id: int = 1):
    """测试长对话的被动缓存效果（不发送 cache_control）"""
    print(f"\n{'='*70}")
    print(f"测试 4: 长对话被动缓存 (Session {session_id})")
    print(f"{'='*70}")

    # 完全相同的 messages，但不加 cache_control
    messages = []

    for i in range(4):
        messages.append({
            "role": "user",
            "content": [{"type": "text", "text": f"第 {i+1} 轮：{['创建任务', '查询任务', '更新任务', '总结任务'][i]}"}]
        })
        messages.append({
            "role": "assistant",
            "content": [{"type": "text", "text": f"已执行第 {i+1} 轮操作"}]
        })

    url = f"{minimax_base_url.replace('/v1', '')}/completion"

    payload = {
        "model": minimax_model,
        "messages": messages,
        "temperature": 0.7,
        "max_tokens": 500,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {minimax_api_key}",
        "Content-Type": "application/json",
        "X-Minimax-Group-ID": "test-passive-long",
    }

    try:
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload, headers=headers)
            content = resp.content.decode('utf-8')

        data = parse_stream_response(content)

        if not data:
            print(f"❌ API 响应格式异常")
            return None

        message = data.get("choices", [{}])[0].get("message", {})
        usage = data.get("usage", {})

        cache_read = usage.get("prompt_cache_hit_tokens", 0)

        print(f"User: {messages[-1]['content'][0]['text']}")
        print(f"Assistant: {message.get('content', '')}")
        print(f"\nUsage:")
        print(f"  - Input tokens: {usage.get('prompt_tokens', 0)}")
        print(f"  - Output tokens: {usage.get('completion_tokens', 0)}")
        print(f"  - Cache read: {cache_read}")
        print(f"  - Cache ratio: {cache_read / usage.get('prompt_tokens', 1) * 100:.2f}%" if usage.get('prompt_tokens') else "  - Cache ratio: N/A (prompt_tokens=0)")

        return {
            "session_id": session_id,
            "mode": "passive",
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
            "cache_read": cache_read,
            "cache_ratio": cache_read / usage.get('prompt_tokens', 1) * 100 if usage.get('prompt_tokens') else 0,
        }

    except Exception as e:
        print(f"❌ 请求失败: {e}")
        import traceback
        traceback.print_exc()
        return None


def main():
    print("="*70)
    print("MiniMax 主动缓存 vs 被动缓存测试")
    print("="*70)
    print(f"API Key: {minimax_api_key[:20]}...")
    print(f"Base URL: {minimax_base_url}")
    print(f"Model: {minimax_model}")
    print(f"\n测试说明：")
    print("  - 主动缓存：发送 cache_control 断点")
    print("  - 被动缓存：不发送 cache_control")
    print("  - 通过 cache_read_input_tokens（或 prompt_cache_hit_tokens）对比效果")

    results = []

    # 测试短对话
    result1 = test_active_cache(session_id=1)
    result2 = test_passive_cache(session_id=1)

    if result1 and result2:
        results.extend([result1, result2])

    # 测试长对话
    result3 = test_long_conversation_active(session_id=2)
    result4 = test_long_conversation_passive(session_id=2)

    if result3 and result4:
        results.extend([result3, result4])

    # 总结
    print(f"\n{'='*70}")
    print("测试总结")
    print(f"{'='*70}")

    if not results:
        print("❌ 没有有效结果")
        return

    active_results = [r for r in results if r["mode"] == "active"]
    passive_results = [r for r in results if r["mode"] == "passive"]

    if active_results and passive_results:
        avg_input_active = sum(r["input_tokens"] for r in active_results) / len(active_results)
        avg_cache_active = sum(r["cache_read"] for r in active_results) / len(active_results)
        avg_ratio_active = sum(r["cache_ratio"] for r in active_results) / len(active_results)

        avg_input_passive = sum(r["input_tokens"] for r in passive_results) / len(passive_results)
        avg_cache_passive = sum(r["cache_read"] for r in passive_results) / len(passive_results)
        avg_ratio_passive = sum(r["cache_ratio"] for r in passive_results) / len(passive_results)

        print(f"\n{'模式':<10} {'输入 tokens':<12} {'缓存命中':<12} {'缓存率':<10}")
        print("-" * 44)
        print(f"{'主动':<10} {avg_input_active:<12.0f} {avg_cache_active:<12.0f} {avg_ratio_active:<10.2f}%")
        print(f"{'被动':<10} {avg_input_passive:<12.0f} {avg_cache_passive:<12.0f} {avg_ratio_passive:<10.2f}%")
        print("-" * 44)

        if avg_cache_active > avg_cache_passive:
            improvement = (avg_cache_active - avg_cache_passive) / avg_cache_passive * 100
            print(f"\n✅ 主动缓存比被动缓存多命中 {avg_cache_active - avg_cache_passive:.0f} tokens ({improvement:.1f}%)")
        else:
            print(f"\n⚠️  主动缓存比被动缓存少命中 {avg_cache_passive - avg_cache_active:.0f} tokens")

        print(f"\n结论：{'主动缓存效果更好' if avg_cache_active > avg_cache_passive else '被动缓存效果更好'}")

    print("\n测试完成！")


if __name__ == "__main__":
    main()

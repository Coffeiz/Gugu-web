#!/usr/bin/env python3
"""
测试 MiniMax API 对 null 字段的容忍度

模拟真实的 agent 调用流程，包含 null 字段，观察是否发生 ValueError
"""

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_minimax_with_null_fields():
    """测试 MiniMax 处理 null 字段的能力"""
    print("=" * 60)
    print("测试 MiniMax 对 null 字段的容忍度")
    print("=" * 60)

    # 1. 获取配置
    from app.core.config import get_settings
    settings = get_settings()

    # 2. 构建测试消息
    print("\n🔵 测试场景 1: 包含 project_id=null 的工具结果")

    messages_with_null = [
        {
            "role": "user",
            "content": "帮我创建一个测试画布，标题是'调试测试画布'"
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "我来帮你创建画布。"
                },
                {
                    "type": "tool_use",
                    "id": "toolu_test123",
                    "name": "canvas_create",
                    "input": {"title": "调试测试画布"}
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_test123",
                    "content": json.dumps({
                        "canvas": {
                            "canvas_id": 999,
                            "title": "调试测试画布",
                            "project_id": None  # 这是关键：null 字段
                        }
                    }, ensure_ascii=False)
                }
            ]
        }
    ]

    print(f"  消息结构准备完成")
    print(f"  消息数量: {len(messages_with_null)}")

    # 检查 null 字段
    tool_result_content = messages_with_null[2]["content"][0]["content"]
    parsed = json.loads(tool_result_content)
    has_null = parsed["canvas"]["project_id"] is None
    print(f"  包含 null 字段: {has_null}")
    print(f"  工具结果: {json.dumps(parsed, ensure_ascii=False, indent=2)}")

    # 3. 测试场景 2：没有 null 字段的消息
    print(f"\n🔵 测试场景 2: 不包含 null 字段的工具结果")

    messages_without_null = [
        {
            "role": "user",
            "content": "帮我创建一个测试画布，标题是'调试测试画布'"
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "text",
                    "text": "我来帮你创建画布。"
                },
                {
                    "type": "tool_use",
                    "id": "toolu_test456",
                    "name": "canvas_create",
                    "input": {"title": "调试测试画布"}
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_test456",
                    "content": json.dumps({
                        "canvas": {
                            "canvas_id": 998,
                            "title": "调试测试画布"
                            # 故意省略 project_id 字段
                        }
                    }, ensure_ascii=False)
                }
            ]
        }
    ]

    print(f"  消息结构准备完成")
    print(f"  消息数量: {len(messages_without_null)}")

    # 4. 实际调用 MiniMax API
    print(f"\n🔵 测试场景 3: 真实 MiniMax API 调用（包含 null）")

    try:
        import anthropic
        import httpx

        # 构建 MiniMax 客户端
        api_key = settings.ai.api_key
        base_url = settings.ai.base_url or "https://api.minimax.chat/v1"

        print(f"  API Key: {api_key[:10]}...")
        print(f"  Base URL: {base_url}")

        client = anthropic.Anthropic(
            api_key=api_key,
            base_url=base_url,
            timeout=httpx.Timeout(60.0, connect=10.0)
        )

        # 测试调用（包含 null）
        print(f"\n  📡 调用 MiniMax API（包含 null 字段）...")

        try:
            response = await asyncio.to_thread(
                client.messages.create,
                model="minimax-m3-7b-beta",  # 或者其他可用的模型
                max_tokens=100,
                temperature=0.7,
                messages=messages_with_null
            )

            print(f"  ✅ API 调用成功!")
            print(f"  响应内容: {response.content[0].text[:100]}...")

        except Exception as e:
            print(f"  ❌ API 调用失败!")
            print(f"  错误类型: {type(e).__name__}")
            print(f"  错误消息: {e}")

            if isinstance(e, ValueError):
                print(f"\n  🎯 确认：MiniMax 无法处理 null 字段！")
                print(f"  这就是 ValueError 的根本原因。")
            else:
                print(f"\n  其他错误，可能与 null 字段无关")
                traceback.print_exc()

    except ImportError as e:
        print(f"  ⚠️  无法导入 anthropic 库: {e}")
        print(f"  跳过真实 API 测试")
    except Exception as e:
        print(f"  ⚠️  测试准备失败: {e}")
        traceback.print_exc()

    # 5. 对比测试
    print(f"\n🔵 测试场景 4: 真实 MiniMax API 调用（不含 null）")

    try:
        print(f"\n  📡 调用 MiniMax API（不含 null 字段）...")

        response = await asyncio.to_thread(
            client.messages.create,
            model="minimax-m3-7b-beta",
            max_tokens=100,
            temperature=0.7,
            messages=messages_without_null
        )

        print(f"  ✅ API 调用成功!")
        print(f"  响应内容: {response.content[0].text[:100]}...")

    except Exception as e:
        print(f"  ❌ API 调用失败!")
        print(f"  错误类型: {type(e).__name__}")
        print(f"  错误消息: {e}")


    print(f"\n📊 测试总结:")
    print(f"  - 场景 1: 消息构建（含 null）✅")
    print(f"  - 场景 2: 消息构建（无 null）✅")
    print(f"  - 场景 3: MiniMax API 调用（含 null）{'❌' if 'ValueError' in str(globals()) else '✅ 需要实际测试'}")
    print(f"  - 场景 4: MiniMax API 调用（无 null）{'✅ 需要实际测试'}")


async def main():
    """主函数"""
    try:
        await test_minimax_with_null_fields()
    except KeyboardInterrupt:
        print("\n\n⚠️  测试被用户中断")
    except Exception as e:
        print(f"\n🔴 主函数错误: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    print("🚀 MiniMax null 字段容忍度测试")
    print("=" * 60)

    asyncio.run(main())

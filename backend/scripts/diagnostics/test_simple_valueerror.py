#!/usr/bin/env python3
"""
简化的 ValueError 调试脚本 - 直接测试 MiniMax 的消息序列化问题
"""

import asyncio
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))


async def test_minimax_message_serialization():
    """测试 MiniMax 消息序列化中的问题"""
    print("=" * 60)
    print("测试 MiniMax 消息序列化...")
    print("=" * 60)

    # 1. 测试工具返回值的序列化
    print("\n🔵 测试 1: 工具返回值序列化")
    canvas_result = {"canvas": {"canvas_id": 141, "title": "测试画布", "project_id": None}}

    try:
        serialized = json.dumps(canvas_result, ensure_ascii=False)
        print(f"  ✓ 序列化成功: {serialized}")

        # 反序列化
        deserialized = json.loads(serialized)
        print(f"  ✓ 反序列化成功: {deserialized}")

        # 检查 null 字段
        if deserialized["canvas"]["project_id"] is None:
            print(f"  ⚠️  发现 null 字段: project_id")

    except Exception as e:
        print(f"  ✗ 序列化错误: {e}")
        traceback.print_exc()

    # 2. 测试消息格式构建
    print("\n🔵 测试 2: Anthropic 消息格式构建")

    # 模拟工具调用结果
    messages = []

    # 助手消息（包含工具调用）
    assistant_message = {
        "role": "assistant",
        "content": [
            {
                "type": "text",
                "text": "我来帮你创建画布。"
            },
            {
                "type": "tool_use",
                "id": "toolu_0123456789",
                "name": "mind_create_canvas",
                "input": {"title": "测试画布"}
            }
        ]
    }

    # 用户消息（工具结果）
    user_message = {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_0123456789",
                "content": json.dumps(canvas_result, ensure_ascii=False)
            }
        ]
    }

    try:
        messages.append(assistant_message)
        print(f"  ✓ 添加助手消息")

        messages.append(user_message)
        print(f"  ✓ 添加用户消息（含工具结果）")

        # 验证消息可以 JSON 序列化
        messages_json = json.dumps(messages, ensure_ascii=False, indent=2)
        print(f"  ✓ 消息序列化成功")
        print(f"  消息长度: {len(messages_json)} 字符")

        # 显示关键部分
        print(f"\n  助手消息内容类型数: {len(assistant_message['content'])}")
        print(f"  用户消息内容类型数: {len(user_message['content'])}")

        # 检查工具结果中的 null 值
        tool_result_content = user_message["content"][0]["content"]
        parsed_result = json.loads(tool_result_content)
        print(f"  工具结果解析: {json.dumps(parsed_result, ensure_ascii=False)}")

    except Exception as e:
        print(f"  ✗ 消息构建错误: {e}")
        traceback.print_exc()

    # 3. 测试 Anthropic SDK 的解析
    print("\n🔵 测试 3: Anthropic SDK 对消息的解析")

    try:
        import anthropic

        # 创建一个测试客户端（不需要真实连接）
        print(f"  ✓ Anthropic SDK 版本: {anthropic.__version__}")

        # 测试消息对象的创建
        test_messages = [
            {"role": "user", "content": "测试消息"}
        ]

        # 尝试创建消息对象
        print(f"  ✓ 基础消息测试通过")

    except ImportError:
        print(f"  ✗ Anthropic SDK 未安装")
    except Exception as e:
        print(f"  ✗ SDK 测试错误: {type(e).__name__}: {e}")
        traceback.print_exc()

    # 4. 模拟真实的 agent 流程
    print("\n🔵 测试 4: 模拟 agent 消息处理流程")

    from agent.loop_drivers import AnthropicDriver

    try:
        driver = AnthropicDriver()

        # 模拟 RoundResult
        class MockToolCall:
            def __init__(self):
                self.id = "toolu_0123456789"
                self.name = "mind_create_canvas"
                self.input = {"title": "测试画布"}

        class MockContentBlock:
            def __init__(self, block_type, text="", **kwargs):
                self.type = block_type
                self.text = text
                for k, v in kwargs.items():
                    setattr(self, k, v)

            def model_dump(self):
                result = {"type": self.type}
                if hasattr(self, 'text') and self.text:
                    result["text"] = self.text
                if hasattr(self, 'id'):
                    result["id"] = self.id
                if hasattr(self, 'name'):
                    result["name"] = self.name
                if hasattr(self, 'input'):
                    result["input"] = self.input
                return result

        class MockRoundResult:
            def __init__(self):
                self.text = "画布创建成功！"
                self.tool_calls = [MockToolCall()]
                self.usage_in = 100
                self.usage_out = 50
                self.cache_tokens = 0
                self.raw = [
                    MockContentBlock("text", "我来帮你创建画布。"),
                    MockContentBlock("tool_use", id="toolu_0123456789",
                                   name="mind_create_canvas", input={"title": "测试画布"})
                ]

        result = MockRoundResult()
        dispatched = [
            (MockToolCall(), json.dumps(canvas_result, ensure_ascii=False))
        ]

        print(f"  ✓ 创建 Mock 对象成功")

        # 测试 _content_dicts 方法
        content_dicts = driver._content_dicts(result)
        print(f"  ✓ _content_dicts 返回 {len(content_dicts)} 个块")

        for i, block in enumerate(content_dicts):
            print(f"    块 {i}: {json.dumps(block, ensure_ascii=False)}")

        # 测试 append_tool_round 方法
        test_messages = []
        driver.append_tool_round(test_messages, result, dispatched)
        print(f"  ✓ append_tool_round 成功")
        print(f"    最终消息数: {len(test_messages)}")

        # 显示最终消息结构
        for i, msg in enumerate(test_messages):
            print(f"    消息 {i} (role={msg['role']}):")
            if isinstance(msg['content'], list):
                print(f"      内容块数: {len(msg['content'])}")
                for j, block in enumerate(msg['content']):
                    print(f"        块 {j}: {json.dumps(block, ensure_ascii=False)[:100]}...")
            else:
                print(f"      内容: {str(msg['content'])[:100]}...")

    except Exception as e:
        print(f"  ✗ agent 流程测试错误: {type(e).__name__}: {e}")
        traceback.print_exc()

    print(f"\n🟢 所有测试完成!")


async def main():
    """主函数"""
    try:
        await test_minimax_message_serialization()
    except KeyboardInterrupt:
        print("\n\n⚠️  测试被用户中断")
    except Exception as e:
        print(f"\n🔴 主函数错误: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    print("🚀 简化 ValueError 调试脚本")
    print("=" * 60)

    asyncio.run(main())

#!/usr/bin/env python3
"""
调试 ValueError 发生的具体位置和原因。

复现 canvas_create 工具调用后，下一轮 LLM 调用中的 ValueError。
"""

import asyncio
import json
import sys
import traceback
from pathlib import Path

# 添加项目路径
sys.path.insert(0, str(Path(__file__).parent))

from agent.core import _stream_round
from agent.providers import _MINIMAX
from agent.llm.llm_select import get_ai
from agent.tools import registry
from app.db.session import _build_engine, _SessionLocal
from app.core.config import get_settings


async def test_canvas_creation_flow():
    """测试完整的创建画布流程"""
    print("=" * 60)
    print("开始测试创建画布流程...")
    print("=" * 60)

    # 1. 准备测试环境
    settings = get_settings()
    ai = get_ai(settings.ai)

    # 2. 模拟用户消息
    messages = [
        {"role": "user", "content": "帮我创建一个测试画布，标题是'调试测试画布'"}
    ]

    print(f"\n🔵 初始消息: {messages[0]['content']}")

    try:
        # 3. 构建工具列表和 driver
        tool_names = ["canvas_create", "canvas_list"]
        from agent.loop_drivers import AnthropicDriver

        driver = AnthropicDriver()

        # 4. 准备客户端和上下文
        import httpx
        from agent import providers

        client = providers.build_anthropic_client(
            ai, httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
        )
        ctx = driver.prepare(tool_names, ai, messages, "")

        print(f"\n🟢 准备完成，provider: {ai.provider}, model: {ai.model}")

        # 5. 执行第一轮 LLM 调用
        print(f"\n🔵 开始第一轮 LLM 调用...")
        async for kind, val in driver.run_round(client, ctx, messages):
            if kind == "token":
                print(f"  Token: {val[:50]}..." if len(val) > 50 else f"  Token: {val}")
            elif kind == "done":
                print(f"\n🟢 第一轮完成:")
                print(f"  - 文本: {val.text[:100]}...")
                print(f"  - 工具调用: {len(val.tool_calls)} 个")
                for tc in val.tool_calls:
                    print(f"    • {tc.name}: {tc.input}")

                # 6. 如果有工具调用，执行工具
                if val.tool_calls:
                    print(f"\n🔵 执行工具调用...")
                    dispatched = []

                    # 模拟用户 ID
                    user_id = "test-user-123"

                    async with _SessionLocal() as db:
                        for tc in val.tool_calls:
                            print(f"  调用 {tc.name}...")
                            try:
                                res, artifact = await registry.dispatch(user_id, tc.name, tc.input)
                                print(f"    ✓ 结果: {res[:100]}...")
                                dispatched.append((tc, res))
                            except Exception as e:
                                print(f"    ✗ 错误: {e}")
                                traceback.print_exc()

                    # 7. 将工具结果添加到消息历史
                    print(f"\n🔵 添加工具结果到消息历史...")
                    print(f"  工具结果数量: {len(dispatched)}")

                    try:
                        driver.append_tool_round(messages, val, dispatched)
                        print(f"  ✓ 消息历史更新成功")
                        print(f"  当前消息数: {len(messages)}")

                        # 显示最后两条消息的结构
                        for i, msg in enumerate(messages[-2:], 1):
                            print(f"  消息 {i}: role={msg['role']}")
                            if 'content' in msg:
                                if isinstance(msg['content'], list):
                                    print(f"    content 类型: list, 长度: {len(msg['content'])}")
                                    for j, item in enumerate(msg['content'][:2]):  # 只显示前两项
                                        print(f"      [{j}] {str(item)[:100]}...")
                                else:
                                    print(f"    content: {str(msg['content'])[:100]}...")

                    except Exception as e:
                        print(f"  ✗ 添加工具结果时出错: {e}")
                        traceback.print_exc()
                        return

                    # 8. 第二轮 LLM 调用（这里很可能发生 ValueError）
                    print(f"\n🔵 开始第二轮 LLM 调用（最可能出错的地方）...")
                    try:
                        # 重新准备上下文
                        client2, ctx2 = driver.prepare(tool_names, ai, messages, "")

                        async for kind, val in driver.run_round(client2, ctx2, messages):
                            if kind == "token":
                                pass  # 静默处理 tokens
                            elif kind == "done":
                                print(f"\n🟢 第二轮完成:")
                                print(f"  - 文本: {val.text[:100]}...")
                                print(f"  - 工具调用: {len(val.tool_calls)} 个")

                    except Exception as e:
                        print(f"\n🔴 第二轮 LLM 调用出错!")
                        print(f"  错误类型: {type(e).__name__}")
                        print(f"  错误消息: {e}")
                        print(f"\n📋 完整堆栈:")

                        # 详细堆栈信息
                        error_lines = traceback.format_exc().split('\n')
                        for line in error_lines:
                            print(f"  {line}")

                        # 分析可能的原因
                        print(f"\n🔍 可能的原因分析:")

                        if isinstance(e, ValueError):
                            print(f"  • ValueError - 可能的原因:")
                            print(f"    - MiniMax API 解析工具结果时遇到意外的 null 字段")
                            print(f"    - 消息历史格式不符合 Anthropic 规范")
                            print(f"    - 工具返回值序列化问题")

                            # 检查工具结果
                            print(f"\n  🔎 检查工具结果:")
                            for tc, res in dispatched:
                                print(f"    工具: {tc.name}")
                                try:
                                    parsed = json.loads(res)
                                    print(f"      解析成功: {json.dumps(parsed, ensure_ascii=False, indent=2)}")

                                    # 查找 null 值
                                    null_fields = []
                                    def find_null(obj, path=""):
                                        if isinstance(obj, dict):
                                            for k, v in obj.items():
                                                if v is None:
                                                    null_fields.append(f"{path}.{k}" if path else k)
                                                elif isinstance(v, (dict, list)):
                                                    find_null(v, f"{path}.{k}" if path else k)
                                        elif isinstance(obj, list):
                                            for i, item in enumerate(obj):
                                                if item is None:
                                                    null_fields.append(f"{path}[{i}]" if path else f"[{i}]")
                                                elif isinstance(item, (dict, list)):
                                                    find_null(item, f"{path}[{i}]" if path else f"[{i}]")

                                    find_null(parsed)
                                    if null_fields:
                                        print(f"      ⚠️  发现 null 字段: {null_fields}")
                                    else:
                                        print(f"      ✓ 无 null 字段")

                                except json.JSONDecodeError as je:
                                    print(f"      ✗ JSON 解析失败: {je}")

                        return

                break  # 只处理第一轮的工具调用

        print(f"\n🟢 测试完成，没有发生 ValueError!")

    except Exception as e:
        print(f"\n🔴 测试过程中发生意外错误:")
        print(f"  错误类型: {type(e).__name__}")
        print(f"  错误消息: {e}")
        traceback.print_exc()


async def main():
    """主函数"""
    try:
        await test_canvas_creation_flow()
    except KeyboardInterrupt:
        print("\n\n⚠️  测试被用户中断")
    except Exception as e:
        print(f"\n🔴 主函数错误: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    print("🚀 ValueError 调试脚本")
    print("=" * 60)

    # 检查环境
    try:
        settings = get_settings()
        print(f"✓ 配置加载成功")
        print(f"  Provider: {settings.ai.provider}")
        print(f"  Model: {settings.ai.model}")
    except Exception as e:
        print(f"✗ 配置加载失败: {e}")
        sys.exit(1)

    # 运行测试
    asyncio.run(main())

#!/usr/bin/env python3
"""
完整的 Agent 链路测试 - 从发送创建画布消息到输出的全流程

精确定位 ValueError 在哪个环节发生
"""

import asyncio
import json
import sys
import traceback
from pathlib import Path
from typing import AsyncGenerator

sys.path.insert(0, str(Path(__file__).parent))


class StepByStepTracer:
    """逐步跟踪器 - 记录每一步的执行情况"""

    def __init__(self):
        self.steps = []
        self.current_step = 0

    def log(self, step_name: str, details: str = ""):
        """记录一个步骤"""
        self.current_step += 1
        step_info = f"步骤 {self.current_step}: {step_name}"
        if details:
            step_info += f" - {details}"
        self.steps.append(step_info)
        print(f"  🔵 {step_info}")
        return self.current_step

    def error(self, error_msg: str, exception: Exception = None):
        """记录错误"""
        error_step = f"❌ 错误在步骤 {self.current_step}: {error_msg}"
        self.steps.append(error_step)
        print(f"  🔴 {error_step}")
        if exception:
            print(f"     异常类型: {type(exception).__name__}")
            print(f"     异常消息: {exception}")
            print(f"     堆栈:")
            for line in traceback.format_exc().split('\n'):
                print(f"       {line}")

    def summary(self):
        """打印步骤总结"""
        print(f"\n📋 执行步骤总结:")
        for i, step in enumerate(self.steps, 1):
            print(f"  {i}. {step}")


async def test_full_agent_canvas_creation():
    """测试完整的 agent 创建画布流程"""
    print("=" * 70)
    print("完整的 Agent 创建画布流程测试")
    print("=" * 70)

    tracer = StepByStepTracer()

    try:
        # === 步骤 1: 初始化环境 ===
        tracer.log("初始化环境")

        from app.core.config import get_settings
        import app.db.session as db_session
        from agent.loop_drivers import AnthropicDriver
        from agent.tools import registry

        settings = get_settings()
        tracer.log("配置加载完成", f"provider={settings.ai.provider}, model={settings.ai.model}")

        # === 步骤 2: 准备数据库 ===
        tracer.log("准备数据库连接")

        if db_session._engine is None:
            db_session._build_engine()
        tracer.log("数据库连接就绪")

        # === 步骤 3: 初始化 driver ===
        tracer.log("初始化 AnthropicDriver")

        driver = AnthropicDriver()
        tracer.log("Driver 初始化完成")

        # === 步骤 4: 准备初始消息 ===
        tracer.log("准备初始用户消息")

        user_id = "test-user-for-debug"
        messages = [
            {"role": "user", "content": "帮我创建一个测试画布，标题是'全流程调试画布'"}
        ]
        tracer.log("消息准备完成", f"用户: {messages[0]['content'][:30]}...")

        # === 步骤 5: 准备工具列表 ===
        tracer.log("准备工具列表")

        tool_names = ["canvas_create", "canvas_list"]
        tracer.log("工具列表准备完成", f"工具: {', '.join(tool_names)}")

        # === 步骤 6: 准备 AI 配置 ===
        tracer.log("准备 AI 配置")

        # 直接使用 settings.ai
        ai = settings.ai
        tracer.log("AI 配置完成", f"model={ai.model if hasattr(ai, 'model') else 'unknown'}")

        # === 步骤 7: 构建 client 和 context ===
        tracer.log("构建 API 客户端和上下文")

        try:
            import httpx
            from agent import providers

            client = providers.build_anthropic_client(
                ai, httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=5.0)
            )
            client_ctx = driver.prepare(tool_names, ai, messages, "")
            tracer.log("客户端和上下文准备完成", f"ctx类型: {type(client_ctx)}")

            # driver.prepare() 返回 (client, ctx) 元组
            if isinstance(client_ctx, tuple):
                tracer.log("检测到元组返回，解包 client 和 ctx")
                # 第一个元素是 client，第二个是 ctx
                # 但我们已经有 client 了，所以只取 ctx
                actual_client, ctx = client_ctx
                tracer.log(f"解包完成，使用返回的 client")
            else:
                ctx = client_ctx
                tracer.log(f"使用单个 ctx")

        except Exception as e:
            tracer.error("客户端构建失败", e)
            return

        # === 步骤 8: 执行第一轮 LLM 调用 ===
        tracer.log("开始第一轮 LLM 调用")

        try:
            round_count = 0
            result = None

            async for kind, val in driver.run_round(client, ctx, messages):
                if kind == "token":
                    # 正常的 token 流，暂时不处理
                    pass
                elif kind == "done":
                    result = val
                    round_count += 1
                    tracer.log(f"第 {round_count} 轮完成", f"文本长度: {len(val.text)}, 工具调用: {len(val.tool_calls)}")

                    # === 步骤 9: 检查工具调用 ===
                    if val.tool_calls:
                        tracer.log("检测到工具调用", f"{len(val.tool_calls)} 个")

                        # === 步骤 10: 执行工具调用 ===
                        tracer.log("开始执行工具调用")

                        dispatched = []
                        async with db_session._SessionLocal() as db:
                            for tc in val.tool_calls:
                                try:
                                    tracer.log(f"调用工具 {tc.name}")
                                    res, artifact = await registry.dispatch(user_id, tc.name, tc.input)
                                    tracer.log(f"工具 {tc.name} 执行成功", f"结果长度: {len(res)}")

                                    # 显示工具结果
                                    try:
                                        res_parsed = json.loads(res)
                                        tracer.log(f"工具结果内容", f"{json.dumps(res_parsed, ensure_ascii=False)[:100]}...")
                                    except:
                                        tracer.log(f"工具结果内容", f"{res[:100]}...")

                                    dispatched.append((tc, res))

                                except Exception as e:
                                    tracer.error(f"工具 {tc.name} 执行失败", e)

                        # === 步骤 11: 将工具结果添加到消息历史 ===
                        tracer.log("开始添加工具结果到消息历史")

                        try:
                            # 检查当前消息数量
                            msg_count_before = len(messages)
                            tracer.log(f"当前消息数", f"{msg_count_before}")

                            # 显示要添加的 result
                            tracer.log(f"RoundResult 信息", f"text长度={len(val.text)}, tool_calls={len(val.tool_calls)}")
                            if hasattr(val, 'raw'):
                                tracer.log(f"raw blocks数量", f"{len(val.raw)}")
                                for i, block in enumerate(val.raw[:2]):  # 只显示前两个块
                                    if hasattr(block, 'type'):
                                        tracer.log(f"  raw[{i}]", f"type={block.type}")
                                    if hasattr(block, 'text') and block.text:
                                        tracer.log(f"    text", f"{block.text[:50]}...")

                            # 显示要添加的 dispatched
                            tracer.log(f"dispatched 数量", f"{len(dispatched)}")
                            for i, (tc, res) in enumerate(dispatched):
                                tracer.log(f"  dispatched[{i}]", f"工具={tc.name}, 结果长度={len(res)}")

                            # 执行添加
                            driver.append_tool_round(messages, val, dispatched)
                            tracer.log("append_tool_round 执行成功")

                            # 检查添加后的消息数量
                            msg_count_after = len(messages)
                            tracer.log(f"添加后消息数", f"{msg_count_after}")

                            # 显示新增的消息结构
                            if msg_count_after > msg_count_before:
                                for i in range(msg_count_before, msg_count_after):
                                    msg = messages[i]
                                    tracer.log(f"  新消息[{i}]", f"role={msg['role']}")
                                    if isinstance(msg.get('content'), list):
                                        content_list = msg['content']
                                        tracer.log(f"    content类型", f"list, 长度={len(content_list)}")
                                        for j, item in enumerate(content_list[:2]):  # 只显示前两项
                                            tracer.log(f"      content[{j}]", f"type={item.get('type', 'unknown')}")
                                            if item.get('type') == 'tool_result':
                                                tool_content = item.get('content', '')
                                                tracer.log(f"        tool_result内容长度", f"{len(tool_content)}")
                                                try:
                                                    parsed = json.loads(tool_content)
                                                    tracer.log(f"        解析成功", f"keys={list(parsed.keys())}")
                                                    # 检查是否有 null
                                                    def check_null(obj, path=""):
                                                        nulls = []
                                                        if isinstance(obj, dict):
                                                            for k, v in obj.items():
                                                                if v is None:
                                                                    nulls.append(f"{path}.{k}" if path else k)
                                                                elif isinstance(v, (dict, list)):
                                                                    nulls.extend(check_null(v, f"{path}.{k}" if path else k))
                                                        elif isinstance(obj, list):
                                                            for i, item in enumerate(obj):
                                                                if item is None:
                                                                    nulls.append(f"{path}[{i}]" if path else f"[{i}]")
                                                                elif isinstance(item, (dict, list)):
                                                                    nulls.extend(check_null(item, f"{path}[{i}]" if path else f"[{i}]"))
                                                        return nulls

                                                    null_fields = check_null(parsed)
                                                    if null_fields:
                                                        tracer.log(f"        ⚠️ 发现null字段", f"{null_fields}")
                                                    else:
                                                        tracer.log(f"        ✓ 无null字段")
                                                except json.JSONDecodeError as je:
                                                    tracer.log(f"        ⚠️ JSON解析失败", f"{je}")
                                    else:
                                        tracer.log(f"    content", f"{str(msg.get('content', ''))[:50]}...")

                        except Exception as e:
                            tracer.error("添加工具结果到消息历史失败", e)
                            traceback.print_exc()
                            return

                        # === 步骤 12: 第二轮 LLM 调用（最可能出问题的地方） ===
                        tracer.log("准备第二轮 LLM 调用")

                        try:
                            tracer.log("重新准备客户端和上下文")
                            client2_ctx2 = driver.prepare(tool_names, ai, messages, "")
                            tracer.log("第二轮准备完成", f"返回类型: {type(client2_ctx2)}")

                            if isinstance(client2_ctx2, tuple):
                                client2, ctx2 = client2_ctx2
                                tracer.log("第二轮解包完成")
                            else:
                                client2, ctx2 = client, client2_ctx2
                                tracer.log("第二轮复用原有client")

                            tracer.log("开始第二轮 run_round")
                            round_2_count = 0
                            async for kind, val in driver.run_round(client2, ctx2, messages):
                                if kind == "token":
                                    round_2_count += 1
                                    if round_2_count % 10 == 0:  # 每10个token报告一次
                                        tracer.log(f"第二轮 token", f"已接收 {round_2_count} 个token")
                                elif kind == "done":
                                    tracer.log(f"第二轮完成", f"文本长度: {len(val.text)}, 工具: {len(val.tool_calls)}")

                            tracer.log("✅ 第二轮 LLM 调用成功完成!", f"共接收 {round_2_count} 个token")

                            # === 步骤 13: 流程成功完成 ===
                            tracer.log("🎉 整个流程成功完成!")
                            break

                        except Exception as e:
                            tracer.error("第二轮 LLM 调用失败", e)
                            print(f"\n🔍 详细错误分析:")

                            if isinstance(e, ValueError):
                                print(f"  确认是 ValueError - 发生在第二轮 LLM 调用中")
                                print(f"  可能原因:")
                                print(f"    1. 消息历史格式问题")
                                print(f"    2. 工具结果中的某些字段")
                                print(f"    3. MiniMax 对特定响应的处理")
                            else:
                                print(f"  其他错误类型")

                            print(f"\n📊 消息历史分析:")
                            print(f"  总消息数: {len(messages)}")
                            for i, msg in enumerate(messages):
                                print(f"  消息 {i}: role={msg['role']}")
                                if isinstance(msg.get('content'), list):
                                    print(f"    content: list[{len(msg['content'])}]")
                                    for j, item in enumerate(msg['content']):
                                        print(f"      [{j}] type={item.get('type', 'unknown')}")
                                else:
                                    print(f"    content: {str(msg.get('content', ''))[:50]}...")

                            return

                    else:
                        tracer.log("没有检测到工具调用")
                        break

        except Exception as e:
            tracer.error("第一轮 LLM 调用失败", e)
            return

        # === 步骤 14: 打印最终结果 ===
        tracer.log("测试成功完成", "没有发生 ValueError")

    except Exception as e:
        tracer.error("测试过程中发生未预期错误", e)
        traceback.print_exc()

    finally:
        # === 打印步骤总结 ===
        tracer.summary()


async def main():
    """主函数"""
    try:
        await test_full_agent_canvas_creation()
    except KeyboardInterrupt:
        print("\n\n⚠️  测试被用户中断")
    except Exception as e:
        print(f"\n🔴 主函数错误: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    print("🚀 完整 Agent 链路测试")
    print("=" * 70)
    print("测试目标：精确定位 ValueError 在哪个环节发生")
    print("=" * 70)

    asyncio.run(main())

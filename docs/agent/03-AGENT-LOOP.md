# Agent Loop

Python Agent loop 负责一次请求内的确定性编排：接收归一化消息、准备运行上下文、调用 provider、处理工具调用、提交事件和保存最终结果。

## 阶段

1. Gateway 校验身份、会话归属和请求去重。
2. Context builder 读取稳定 snapshot、canonical history 和本轮新消息。
3. Provider 返回普通文本或工具调用。
4. 工具 dispatch 进行注册表过滤、权限检查、确认门和真实执行。
5. 工具结果作为独立事件和 history 单元提交，再进入下一轮。
6. 只有最终普通回复完成后才结束 run，并执行上下文预算检查。

守卫可以中止、要求补充 schema 或触发重试，但不能伪造工具成功结果，也不能让隐藏控制消息落入对话历史。

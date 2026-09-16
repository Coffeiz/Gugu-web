"""Agent Loop 领域模块（PRD-LLM-25）。

职责拆分边界：
- `models.py`    RunState / PendingInteraction / RoundOutcome 等显式运行状态类型；
- `provider.py`  provider round 调用、瞬时错误重试和 usage 归一化；
- `events.py`    结构化运行事件与 SSE 编码桥接；
- `rounds.py` / `tools.py` / `interactions.py` / `guards.py` 按 Phase 2~5 逐步落位。

本包只处理 Agent Loop 状态与编排，不复制 `context/`（消息、预算、压缩、
canonical history）、`tools/`（registry 与 dispatch）、`interactions/`
（确认门事实源）和 `providers/`（协议适配）的既有职责。
"""

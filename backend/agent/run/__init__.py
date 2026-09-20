"""统一 Agent run 生命周期（PRD-LLM-18）。

`contract` 定义 PreparedExecution / EarlyExit / AgentEvent 流契约；
`preparation` 是唯一的第一段准备实现（collect/stream/web 共用）。
runner.py 的 run_collect()/run_stream() 只保留 Sink 适配职责。
"""

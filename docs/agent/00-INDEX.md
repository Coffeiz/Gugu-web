# Agent 文档索引

本文档目录描述当前 Python/FastAPI Agent 生产架构。运行时 owner、工具权限和上下文事实以代码为准，文档只记录稳定边界。

| 文档 | 内容 |
|---|---|
| [01-OVERVIEW.md](./01-OVERVIEW.md) | 系统边界与职责总览 |
| [02-ARCHITECTURE.md](./02-ARCHITECTURE.md) | 生产组件和数据流 |
| [03-AGENT-LOOP.md](./03-AGENT-LOOP.md) | Agent loop、工具循环和事件边界 |
| [04-CONTEXT-ENGINEERING.md](./04-CONTEXT-ENGINEERING.md) | snapshot、history、RAG 和缓存前缀 |
| [RAG架构与检索链路.md](./RAG架构与检索链路.md) | TS RAG worker 与 Python adapter |

历史说明和已废弃方案位于 [`_archive/`](./_archive/)。

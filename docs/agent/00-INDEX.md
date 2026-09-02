# Agent 文档索引

本目录记录 Gugu Agent 当前实际采用的架构、运行链路和工程约定。文档以代码实现和线上验证结果为准；已经失效的设计、历史排查记录和阶段性方案统一放在 `_archive/`，不作为当前行为依据。

## 阅读顺序

1. [01-OVERVIEW.md](./01-OVERVIEW.md)：系统定位、能力范围和主要组成。
2. [02-ARCHITECTURE.md](./02-ARCHITECTURE.md)：服务、模块、数据边界和依赖关系。
3. [03-AGENT-LOOP.md](./03-AGENT-LOOP.md)：消息进入 Agent 后的完整执行链路。
4. [04-CONTEXT-ENGINEERING.md](./04-CONTEXT-ENGINEERING.md)：上下文分层、组装、压缩和缓存前缀。
5. [05-TOOLS-AND-SKILLS.md](./05-TOOLS-AND-SKILLS.md)：工具、Skill、能力索引、Schema 和执行边界。
6. [06-RAG-AND-KNOWLEDGE.md](./06-RAG-AND-KNOWLEDGE.md)：RAG、Knowledge、索引、scope 和上下文注入。
7. [07-MEMORY-AND-REFLECTION.md](./07-MEMORY-AND-REFLECTION.md)：Memory、Knowledge 生命周期、反思触发和长期信息维护。
8. [08-CHANNELS.md](./08-CHANNELS.md)：Web、QQ、微信和飞书接入、身份、会话和出站协议。
9. [09-MESSAGE-PROTOCOL.md](./09-MESSAGE-PROTOCOL.md)：流式事件、工具消息、交互、附件、引用和 canonical history。
10. [10-RELIABILITY.md](./10-RELIABILITY.md)：重试、取消、压缩失败、并发、关闭和恢复。
11. [11-LoopScope.md](./11-LOOPSCOPE.md)：开发观测、Context Provenance、Prefix Diff 和 cache 排障。

## 参考文档

- [COMMANDS.md](./COMMANDS.md)：统一斜杠命令、会话控制和目标命令。

## English Documentation

English companions for the current documents are kept in `en/` with the same filenames:

- [Agent overview](./en/01-OVERVIEW.md)
- [Architecture](./en/02-ARCHITECTURE.md)
- [Agent loop](./en/03-AGENT-LOOP.md)
- [Context engineering](./en/04-CONTEXT-ENGINEERING.md)
- [Tools and skills](./en/05-TOOLS-AND-SKILLS.md)
- [RAG and Knowledge](./en/06-RAG-AND-KNOWLEDGE.md)
- [Memory and reflection](./en/07-MEMORY-AND-REFLECTION.md)
- [Channels](./en/08-CHANNELS.md)
- [Message protocol](./en/09-MESSAGE-PROTOCOL.md)
- [Reliability](./en/10-RELIABILITY.md)
- [LoopScope](./en/11-LOOPSCOPE.md)
- [Commands](./en/COMMANDS.md)

## 领域文档

按具体业务域补充实现细节（当前目录中的专题仍以代码为准）：

- 画布、文件、Shell 沙盒和定时任务：见 `backend/agent/tools/`、`backend/agent/sandbox/` 及对应测试。

## 运维文档

部署、服务状态、性能测试和故障排查：见 `agentskills/devserver/`、`backend/start.sh` 及部署文档。

## 架构决策

已经确认、会影响后续实现的决策放在 `docs/prds/`，每份文档只记录一个主题，并注明状态、适用范围和替代过的方案。

## 历史资料

`_archive/` 保存旧版 Agent 文档、提案、架构草稿和参考资料。除非明确进行历史对比，否则不要将归档内容当作当前实现说明。

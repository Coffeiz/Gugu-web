# Agent 总览

Gugu 的生产 Agent 由 FastAPI、Python Agent、Python Worker 和常驻 TypeScript RAG worker 组成。FastAPI 是唯一公开 API 与实时事件入口，Python Agent 是唯一 Agent loop owner，TS 只负责 RAG 索引和召回。

## 核心边界

- FastAPI：认证、业务 API、SSE、WebSocket 和资源查询。
- Python Agent：上下文组装、provider 调用、工具/Skill 注册、确认门、压缩和最终回复。
- Python Worker：QQ、微信、飞书和定时任务入口，统一提交 Agent command。
- TS RAG worker：Jieba、BM25、索引缓存、召回、过滤和诊断结果。
- Redis：canonical event bus、实时事件和跨进程协调。

## 一次请求

用户消息进入 FastAPI 或 IM Worker 后，先归一化为 Agent 请求，再由 Python loop 读取当前状态、组装上下文、调用模型和工具。工具结果进入 canonical history，最终回复通过统一事件出口写入持久化和实时通道。

权限、工具可用性和数据归属必须由代码判定，不能依赖模型从提示词推断。没有真实工具回执时，Agent 不得声称操作完成。

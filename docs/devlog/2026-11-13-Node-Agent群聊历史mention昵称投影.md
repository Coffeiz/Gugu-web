# Node Agent 群聊历史 mention 昵称投影

## 背景

Python `GET /api/v1/agent/sessions/{session_id}/messages` 会把群聊正文和引用原文中的已知平台 mention ID 转成可读昵称。Node 历史 adapter 之前直接向前端暴露原始 ID，导致群聊历史和 Python 行为不一致。

## 实现

- 只在群聊读取路径收集尖括号显式 mention、消息中的 Bot 平台 ID，以及引用原文中的 mention。
- 名称优先取当前会话最近一次发言昵称；随后将当前会话 Bot 映射为“咕咕”，再查询用户在同平台的其他 Bot 配置名。
- 仅替换有可信名称的 ID；未知 ID 原样保留。私聊不执行额外查询和文本替换。
- 正文与引用原文在 QQ 附件占位符处理后使用同一映射，平台身份字段不变。

## 验证

- devserver Node 26.13.1：mention、历史投影、Host 和 orphan recovery 定向测试 **10 通过、0 失败、2 个隔离 PostgreSQL 用例跳过**；跳过项需隔离 PG URL，本轮不计通过。
- devserver `corepack pnpm run typecheck` 通过。
- devserver Python `tests/agent/test_agent_api_messages.py` 全文件 **59 passed**，其中群聊 mention 契约用例 6 项通过。
- 本轮未重跑 Vite→随机 schema PostgreSQL 集成，因此没有本次认证 HTTP/PG 验收；真实 Redis 也未验收。

## 后续

Node 历史 API 仍缺 legacy timeline 的 Python 兼容读取路径。`POST /api/v1/agent/chat`、Provider/Tool 执行、持久 Run/Lease、SSE 与跨进程恢复尚未构成 Node 端完整聊天主路径。

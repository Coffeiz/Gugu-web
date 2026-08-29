# 开发记录 · 2026-08-26 · 统一上下文 canonical 序列化并修复工具续轮缓存断点

## 2026-08-26 · 统一上下文 canonical 序列化并修复工具续轮缓存断点

### 根因

- 自动 RAG 当前轮使用 `knowledge-context` block，历史中仍可能存在旧版
  `[owner-rag]...[/owner-rag]` 纯文本；恢复后消息结构变化，provider cache 在首个
  RAG 位置断开。
- 工具续轮把旧动态 tail 插回新消息之前，会重排上一轮前缀；即使 schema 没有重复，
  cache anchor 也会落在不稳定的消息边界。

### 修复

- 新增统一上下文序列化约定，RAG 当前注入、历史恢复和 provider wire 均使用同一
  `knowledge-context -> text block` 结构。
- 工具续轮首次追加时提升旧动态 tail，再按原顺序追加 assistant/tool 消息；动态 tail
  不写回历史，旧 cache anchor 保持在原消息索引上。
- 增加 RAG wire 形状一致性、旧记录恢复和工具续轮前缀稳定性回归测试。

### 验证

上下文、RAG、canonical tool history、provider 和 session snapshot 专项测试通过。

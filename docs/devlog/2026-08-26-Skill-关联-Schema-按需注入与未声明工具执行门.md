# 开发记录 · 2026-08-26 · Skill 关联 Schema 按需注入与未声明工具执行门

## 2026-08-26 · Skill 关联 Schema 按需注入与未声明工具执行门

### 修复

- `use_skill` 成功后，将 Skill 关联工具的当前 Schema 和实现指纹作为 canonical event
  追加到历史尾部；不重排稳定前缀，也不把全量 Schema 放回首轮。
- 固定 Adapter 模式下，业务工具没有当前版本 Schema 时，dispatch 前直接返回
  `tool_schema_required`，要求先调用 `get_tool_schema`，避免模型凭记忆猜参数并触发副作用；参数校验失败时 Runtime 会自动回注当前工具 Schema。
- Schema 判断同时比较 Schema digest 和 implementation digest；工具实现更新后会要求重新声明。

### 验证

- canonical history、Schema digest、工具契约和缓存边界专项测试通过。

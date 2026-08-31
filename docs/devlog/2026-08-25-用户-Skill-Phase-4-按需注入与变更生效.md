# 开发记录 · 2026-08-25 · 用户 Skill Phase 4 按需注入与变更生效

## 2026-08-25 · 用户 Skill Phase 4 按需注入与变更生效

- 用户 Skill metadata 现在按 owner 合并到每次运行的 Capability Snapshot；首轮目录只包含简介，不加载 Skill 正文。
- `use_skill` 通过数据库 owner 隔离查询启用中的用户 Skill，正文仍按需进入工具结果；正文更新后以 content digest 判断并重新加载，停用后不会从旧 session 扩大能力范围。
- Web、IM 和定时任务统一使用用户能力快照；关联工具在快照构建时按当前授权集合收窄，实际执行仍由 registry/dispatch 权限检查决定。
- LoopScope 只记录 Skill source、owner fingerprint 和 content digest 等脱敏元数据，不记录 Skill 正文或用户标识。

验证：用户 Skill 与能力注入专项 `27 passed`，Python `compileall` 通过。

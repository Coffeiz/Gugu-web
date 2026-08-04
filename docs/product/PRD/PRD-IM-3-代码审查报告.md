# PRD-IM-3 群组与成员记忆代码审查报告

更新时间：2026-08-04

## 当前结论

PRD-IM-3 的 Phase 1～4 代码路径已落地，自动化边界测试已补齐；仍需要在 devserver 使用真实 QQ/飞书/微信消息完成人工验收。当前不能把整套群记忆标记为生产验收完成。

## 职责审查

| 模块 | 当前职责 | 结论 |
|---|---|---|
| `agent/im/actor.py` | 解析 owner/member/unknown 和工具白名单 | 保持单一入口 |
| `agent/memory/scopes.py` | 构造 scope 与安全存储 key | 不访问数据库和文件内容 |
| `agent/memory/scoped_store.py` | 读写 scope 文件 | 不做提取、压缩和权限判断 |
| `agent/memory/reflection_jobs.py` | 游标、窗口、幂等任务、重试和 Redis 投递 | 不调用模型、不写文件 |
| `agent/memory/im_reflection.py` | group/member 消息提取、daily 写入和压缩 | 唯一长期记忆写入口 |
| `agent/memory/scope_lifecycle.py` | tombstone、异步删除、清理补偿和管理摘要 | 不参与普通上下文拼装 |
| `agent/im/context_loader.py` | 按角色读取 group/member scope | 只读，不触发反思 |
| `agent/runner.py` | 共用 Agent Loop；隔离 owner 群聊个人反思输入 | 只做编排 |
| `worker.py` | 消费入站、反思和清理队列 | 不包含记忆提取策略 |
| `agent/gateway/*` | 平台事件归一化和出站协议 | 未增加记忆业务职责 |

## 已验证

- 后端全量测试：`600 passed`。
- devserver 定向群记忆测试：`14 passed`；数据库已迁移到 `20260804000006 (head)`，worker 已重启并加载反思/清理消费者。
- 前端 `npm run typecheck` 通过。
- 后端新增 scope、隔离、Prompt、daily、窗口收束、user-only 反思快照、删除屏障和 owner 反思边界测试。
- `python3 -m compileall -q backend` 通过。
- `git diff --check` 通过。

## 仍需人工验收

1. 普通群消息持续活跃一小时后只整理一次，空闲 15 分钟后收束一次。
2. 下一条新消息能重新打开窗口，且不会重复处理上一窗口。
3. daily 达到 1000 条后压缩到 `memory.md`，成功后保留 500 条；压缩失败不覆盖旧内容，并进入补偿/告警路径。
4. member、group、Bot scope 删除后，后台清理完成且重新发言不会读到旧记忆。
5. 同一平台多个 Bot、多个群和多个成员之间的上下文隔离。
6. owner 在群里执行个人工具时，个人反思只包含 owner 发言和私人工具结果。

## 残余风险

- 当前删除管理入口已接入 Admin Agent 页面，但尚未在真实对象存储和多 worker 环境执行破坏性验收。
- owner 群聊个人反思使用独立输入裁剪，复杂工具结果的字段级筛选仍应通过真实任务样本复核。
- 数据库迁移已在 devserver 应用到 `20260804000006`；其他环境仍需运行项目既有 migration 流程。
- `MemoryScope` 的反思与删除已共用同一 scope Redis 锁，避免清理过程中旧任务写回文件；压缩失败超过 1200 条时只写受限诊断日志，不静默删除原始 daily。

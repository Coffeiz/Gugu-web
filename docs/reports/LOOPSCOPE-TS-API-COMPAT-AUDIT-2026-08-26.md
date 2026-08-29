# LoopScope Python/TypeScript 功能对照审查

## 结论
已在迁移期间对照过历史 Python LoopScope API、存储实现、测试和 frontend/src/services/api.ts。Phase 2 的 TypeScript API 已覆盖当前前端实际使用的 health、ingest、sessions、runs、run detail、context、usage 和 spans 接口。

## 已修复偏差
- TraceStore 不再无条件覆盖已有自定义 Session 标题。
- Run 列表 API 的 limit 上限与 Python 统一为 100，before 分页保持 started_at 排除语义。
- 非法 JSON 映射为 400；缺少必需字段由 Zod 校验为 400；未知 Run 返回 404。

## 保留边界
- TypeScript Collector 已切换 devserver 的 `4320` 入口，使用仓库外的 `/home/coffeiz/loopscope-data/loopscope.db`；未接入异常的仓库内旧数据库。旧 Python LoopScope 入口已清理。
- 历史 Python health 版本为 0.2，TypeScript 实现为 0.3，当前服务版本已统一为 0.3。
- 历史 Python 对损坏 JSON 返回原始字符串，Drizzle JSON mode 可能抛错；该差异已作为迁移边界记录。
- 历史 Python 只持久化 Session/Run/Span；TypeScript 额外持久化 context_fragments、usage 和 artifacts，作为当前实现能力保留。

## 验证
- contracts/db/storage/collector 类型检查通过。
- Collector 构建通过。
- DB 初始化、旧库迁移、Storage 幂等/标题/分页测试通过。
- 隔离临时库 HTTP smoke test 通过 health、ingest、Session Run 分页、Span 分页和 404。
- 清理前 Python 对照测试 7 项通过；TypeScript parity/storage 测试 3 项通过。
- Collector HTTP 集成测试已固化到 `apps/collector/src/server.test.ts`，覆盖 health、ingest、sessions、runs、spans 分页、400/404。
- TypeScript 生产构建后，`node apps/collector/dist/server.js` 已在临时数据库上成功启动并返回 health。
- LoopScope 前端 `npm run typecheck`、`npm run build` 通过。
- 本机没有 Docker CLI，Compose 镜像构建尚未执行。

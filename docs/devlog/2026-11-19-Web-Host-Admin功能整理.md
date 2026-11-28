# Web Host Admin 功能整理

> 后续边界调整：独立 Admin 包已撤销，所述实现现归入 `apps/web-host/src/modules/admin/`；本记录保留当时的实现和验证经过。

按功能合并 `apps/web-host/src/modules/admin/` 的用户、审计、日志、模型、语音、邮件、网络、存储、沙箱、运行状态、感知和记忆相关文件。HTTP 入口和 Host 装配继续调用 `@gugu/admin`；管理员认证、事务和提交后副作用保留原有实现。记忆预览、应用、清理及存储补偿保留独立生命周期，功能相近但契约不同的提示词、运维和网络读取实现保留各自入口。

本次同步更新生产与现有测试的导入路径及 `docs/testing/metadata/` 的归属。Admin 目录从整理前 77 个 TypeScript 文件调整为 35 个；具体文件职责见该目录 README。未删除旧业务能力或引入通用路由转发层。

验证：Web Host 生产源码 TypeScript 检查和 `git diff --check` 通过；本轮未运行行为测试。完整测试源码类型检查仍存在接口与测试替身不匹配等诊断，且缺少一处终端依赖类型声明，因此不能作为通过记录。

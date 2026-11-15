# 画布写入 Core 调用验证

Web Host 的画布创建、更新和删除使用 Core 用例及 PostgreSQL 数据适配。Host 路由直接引用 Core 错误类型；原 Host PostgreSQL 画布写入适配已删除。Core 的 SQLite/PG 合同测试继续覆盖项目归属、跨用户拒绝、Undo 和删除后的子资源状态。

画布条目的新增、更新和移除也由 Core 处理；旧 Host PostgreSQL 条目适配已删除。Vite→Host→隔离 PostgreSQL 测试切换到这些 Core 适配后再次通过，验证范围与下述 API 代理测试一致。

画布便签集成测试也已切换到生产使用的 Core 数据适配，SQLite 合同 2/2、Vite→Host→隔离 PG 测试 1/1 通过。后者通过临时路径映射加载核对一致的 Core 源码，以避开共享构建产物不完整的问题，不代表构建产物验收通过；旧 Host 便签适配及已迁入 Core 的包装已清理，其原有业务行为由双库合同覆盖。

画布及便签读取的 Host 集成测试已改用 Core 读取器，Vite→Host→隔离 PG 通过；画布读取的独立 PG 回归也已切到 Core 并通过，覆盖跨用户、软删、活动引用和关系过滤。旧 Host 读取 SQL 和对应模拟 SQL 测试已删除；保留路由测试，定向回归 3/3 通过，Core 双库合同继续覆盖真实读取行为。

画布关系创建、画布内删除和全局删除的用例测试直接调用 Core，定向测试 5/5 通过；Core SQLite/PG 合同覆盖对应数据适配。旧 Host PostgreSQL 关系适配已删除，旧 Host 关系应用包装已清理。

devserver 上，画布用例和 Host 路由定向测试共 6/6 通过。Vite 代理到 Host、再访问隔离 PostgreSQL 的画布及便签集成测试 1/1 通过；该测试使用临时目录安装的 Vite 依赖和仓库相同配置，因临时目录无页面入口，依赖预构建被跳过，只验证 API 代理链路，不代表前端页面构建通过。

旧 Host 画布、条目和关系应用包装的改动已由 Core 用例承接，并在确认无调用方后清理。真实部署和桌面调用未在本轮验收。

旧的 PostgreSQL 模拟 SQL 测试由真实 SQLite/PostgreSQL Core 合同替代，验证便签索引字段、Undo 前后快照、引用 ID、隔离、版本冲突和回滚。

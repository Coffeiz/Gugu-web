# Node WebUI 联系人当前树回归

## 路径

前端 `clientsApi` 的列表、创建和删除请求进入 Node Host 认证域，再通过 `@gugu/core` 的数据门面访问 PostgreSQL。三个操作均由认证上下文确定 owner；请求体和 ID 解析保持 Python API 的可见行为。

## Python 基线与 Node 验证

- Python 共享数据行为：`backend/tests/projects/test_core_data_bridge.py` devserver 原生串行 pytest **3/3 通过**，覆盖事务回滚、owner 隔离、兼容服务可见性和越权删除。
- Node 行为：`gugu-webui/tests/clients/clients-route.test.ts` **4/4 通过**，覆盖认证、响应字段、创建校验、删除 204/404 与有符号/非正数 ID。
- `gugu-webui/tests/persistence/postgres.integration.test.ts` 随机隔离 schema Host/PG 集成 **1/1 通过，0 跳过**。其中联系人路径实际通过认证 Host 创建、列表、预置另一 owner 的联系人并拒绝越权删除，删除本 owner 记录后核实剩余数据；schema 测试后清理。该集成文件也覆盖项目、日历与通知调用，不能把总结果当作它们所有边界的独立证明。
- devserver Vite 与直连 Node Host 未认证 `/api/v1/clients` 均返回 **401**。

## 结论与边界

联系人 CRUD 已有 Node Host、隔离 PostgreSQL 和 Python 数据桥基线，可由 Node 承担。Vite 烟测只验证代理/认证门，尚无认证态浏览器交互验收。测试均在 devserver 原生执行；未用 Docker、未改运行配置、未触发 CI、未提交。

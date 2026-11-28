# Node WebUI 全局搜索迁移（进行中）

## 范围

把顶栏 `GET /api/v1/search/` 接入 Node WebUI Host 和 PostgreSQL 查询层。此次实现了查询词规范化、OR/AND 过滤、类型筛选、owner 过滤、软删除过滤、基础排序和各结果组投影；工作区文件/文件夹结果会附上已验证的目录路径，MCP 结果不会返回 endpoint 或凭据。

## 验证

- Python 行为基线在迁移前执行：`tests/agent/knowledge/test_global_search.py` 与 `tests/mind/test_mind_api.py` 共 55 项通过。
- Node 搜索定向测试在 devserver 执行：4 项通过，0 失败，1 项因未配置隔离 PostgreSQL URL 跳过。
- `gugu-webui` typecheck 与 build 在 devserver 均通过。
- 跳过项覆盖真实 PostgreSQL 查询语法、隔离和结果排名，不能视为数据库验收通过。

## 尚未闭合

- Python 会在项目、事件、联系人、便签、画布便签、技能和对话中执行中日文罗马音匹配。Node 目前没有对应读音索引/转换器；本实现只查询文件与文件夹现有的 `search_romaji` 字段，且 Node 写入侧的别名生成尚不是 Python 的拼音/Sudachi 实现。
- 必须在具备隔离 PostgreSQL 测试库的 devserver 环境跑过定向集成，并补齐上述罗马音行为，才可把迁移清单标记完成。

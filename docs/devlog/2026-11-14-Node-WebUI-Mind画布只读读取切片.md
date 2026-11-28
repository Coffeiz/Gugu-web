# Node WebUI Mind 画布只读读取切片

## 范围

Node Host 新增并接线三个已认证读取入口：

- `GET /api/v1/mind/canvases`，支持 Python 兼容的 `project_id` 过滤与最多 200 条结果。
- `GET /api/v1/mind/canvases/{canvas_id}/items`，只返回归属用户的活动画布项与活动节点，并批量附带活动卡首屏快照。
- `GET /api/v1/mind/canvases/{canvas_id}/relations`，只返回归属画布的活动关系，并应用画布数据中的 `detachedRelationIds`。
- `GET /api/v1/mind/nodes/{node_id}/canvas-location`，只定位归属用户仍有效的画布便签。

查询均从已验证请求上下文取得 owner；画布、节点、画布项、关系和活动快照都带 owner 条件。无权限或已删除画布按不存在处理。Mind 内容卡片的标题仍由正文 Markdown 规则决定，读取层保留 `title` 作为列表与搜索元数据。

## 验证

所有命令在 devserver 原生执行，没有使用 Docker：

- Node 行为测试：6 项通过；另有 1 项隔离 PostgreSQL 集成因未配置 `GUGU_WEBUI_TEST_DATABASE_URL` 跳过。
- Node WebUI TypeScript 检查：通过。
- Python 基线 `backend/tests/mind/test_mind_api.py`：36 项通过。
- Vite→Node Host 四个读取入口的未认证请求均返回 401；Node `/health/ready` 返回 200。这只证明路由可达和认证守卫生效，不证明真实 PostgreSQL 查询已执行。

新增 PG 集成用例会在显式配置隔离数据库后验证 owner、软删除、事件快照及 detached relation 查询。真实 PostgreSQL 路径本轮未验收。

## 未覆盖范围

这是一组只读读取路径，不代表 Mind 画布已完整迁移。创建/更新/删除画布、画布节点与关系的写入口仍需迁移；相应前端操作在 Node Host 上仍不可用。搜索的罗马音差异也不由本切片解决。

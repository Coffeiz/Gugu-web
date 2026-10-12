# PRD-FS-8 Phase 1：分页 API 与 PostgreSQL 查询计划

## 范围

本阶段增加文件、直属文件夹和回收站的有界 keyset API；增加文件/文件夹详情定位、祖先路径读取和有限批量 Markdown 相对路径解析。旧页面仍可使用旧数组接口，Phase 2 迁移消费者后再移除无界接口。

分页默认 100 项、硬上限 200 项；游标加密并绑定用户、资源、筛选条件和排序。用户、活动/回收站状态、空间及目录条件由数据库查询约束。回收站文件与文件夹分别续页，已删目录内容也分别分页。相对路径解析限制每次最多 100 条路径、每条最多 64 个片段、总计最多 256 个片段。

## 查询计划验证

使用独立合成 PostgreSQL 数据验证，最终文件表 27.5 万行、文件夹表 6 万行，覆盖 personal、project、workspace、mind、根目录、目录内、回收站和多种排序。此数据只用于计划形状检查，不代表生产负载基准；百万级压力验收留在 Phase 3。

| 查询 | 加索引前 | 加索引后 | 结论 |
|---|---|---|---|
| 文件排序：name/type/stage/createdAt/size/id | 未建索引时 seq scan + top-N sort | 全部选择对应的 scope 复合索引，游标 tuple 下推为 Index Cond；根目录 101 项实测 4–105 buffers | key 前缀为用户、空间、归一化实体 scope、归一化目录；`stage` 仅允许有界 scope |
| project/workspace/mind 根目录 | 通用 scope 索引可能扫描同空间其他目录 | 同一个 scope 复合索引按项目/Workspace/Mind ID 定位，实测 7–10 buffers | 不为每种空间单独复制全部排序索引 |
| 直属文件夹：name 与前端 ID 兜底排序 | Seq Scan + top-N Sort | 选择 scope/parent 复合索引；101 项实测 4–9 buffers | 文件夹 createdAt/size/stage 沿用现有前端 ID 兜底语义 |
| 回收站顶层文件/文件夹，101 项 | 仅有 deleted_at 单列索引，排序含额外工作 | user/deletedAt/ID 索引；分别实测 5 与 4 buffers | 每个响应最多 200 项；回收站文件与文件夹独立续页 |

计划还确认：通用索引把可空的项目/Workspace/Mind/目录 ID 直接放在排序键前时，`IS NULL` 不总能提供后续排序。改为对这些 ID 使用 sentinel `0` 归一化，让 scope 和目录条件成为可索引等值前缀。索引把参数化的 `space` 保留为索引键，不放进部分索引谓词，因此 PostgreSQL generic prepared plan 仍可使用；迁移用 `CREATE INDEX CONCURRENTLY`，避免建索引期间阻塞文件写入。文件和文件夹名称排序使用 ICU `zh-u-kn-true`，保持中文数字自然序。

## 复审结论

- 保持已有分页外的业务接口不变，避免 Phase 1 单独发布时破坏当前页面；Phase 2/3 负责切换全部消费者并移除整库读取。
- 游标采用 `(排序值, ID)` tuple 比较，ID 是稳定 tie-breaker，避免 `OR` 边界使数据库无法把复合游标条件下推到索引。
- 文件名和文件夹名使用 PostgreSQL ICU 数字序；SQLite 测试环境使用兼容排序表达式，生产查询计划以 PostgreSQL 验证。
- Mind 文件相对路径查询按 `mind_map_id` 再隔离一次；路径请求限制总片段数，避免有限条数的请求仍通过超长路径触发大量逐段查询。
- 文件分页按 space 隔离；`stage` 不允许无界跨项目空间排序。文件夹未配置 createdAt/size/stage 排序器，仍以 ID 作确定顺序。
- 本阶段覆盖 PostgreSQL 的首屏、深页 tuple 条件、全部文件排序键、文件夹排序键、多空间 scope 和回收站计划形状；百万级压力、前端全调用链切换留在后续阶段，不把本次合成数据当作规模验收。

## 回归验证

`backend/tests/storage/files/test_file_listing_pagination.py`、文件/文件夹 API 与回收站测试合计 70 项通过。查询计划数据为合成数据，不访问 devserver 或用户数据。

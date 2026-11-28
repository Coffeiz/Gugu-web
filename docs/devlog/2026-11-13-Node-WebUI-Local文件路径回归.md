# Node WebUI Local 文件路径回归

## 范围

前端文件库实际调用分页、文件夹分页、详情/路径、摘要/存储信息、下载/预览、上传、删除及文件夹创建/改名等接口。Node Host 已通过受保护域接入 Local 文件分页、读写辅助、上传、删除和文件夹读写；本次对这组现有 Host 路由与 PostgreSQL adapter 做完整定向回归，不触碰项目/日历路由或 OSS 改动。

## Python 行为基准

devserver 串行运行以下基准模块：

- `backend/tests/storage/files/test_files_api.py`
- `backend/tests/storage/files/test_folders_api.py`
- `backend/tests/storage/files/test_file_listing_pagination.py`
- `backend/tests/storage/files/test_file_stream_preview.py`
- `backend/tests/storage/files/test_web_download.py`
- `backend/tests/storage/files/test_upload_stream.py`
- `backend/tests/storage/files/test_upload_confirm.py`
- `backend/tests/storage/files/test_file_write_safety.py`

首轮有 4 个 `test_web_download.py` 用例在导入阶段因 devserver 系统 Python 缺少 `apscheduler` 失败，未进入断言。将该运行依赖仅装入临时 pytest 环境后，原命令重跑结果 **87/87 通过**，没有调整测试或断言。

## Node Host 验证

在 devserver 使用 Node 26、串行运行 `gugu-webui/tests/files/*.test.ts`：**47/47 通过，0 跳过**。其中受隔离 PostgreSQL URL 控制的文件分页与 Local 上传用例实际执行；全套同时覆盖 Host owner 身份、分页、下载/字节范围、路径遍历与 symlink 拒绝、配额限制、删除回滚、文件夹版本 CAS 及 PathMirror 补偿。

devserver `npm run typecheck` 通过。Vite 代理与直连 Node Host 的文件分页和文件夹分页未认证请求均返回 **401**。Vite smoke 只确认路由与守卫，业务结果以测试及隔离 PG 用例为准。

## 使用边界与下一步

Node 当前能承担文件/文件夹分页、读取与下载、Local multipart 上传、删除/回收站投影及基础文件夹写入。此切片没有迁移前端仍调用的文件正文保存/元数据更新、复制、批量删除/下载、归档/解档、表格预览等其它文件 API；在这些接口迁移前，完整文件库交互仍需 Python 承担。隔离 PG 已验收分页和上传；其它 SQL adapter 测试中采用合成 query port，不表示 devserver 真实 PostgreSQL 的每个写路径都已验收。

测试未使用 Docker、未触发 CI、未提交代码；没有读取或修改真实用户文件与存储配置。

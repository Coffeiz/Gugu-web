# 实现 TODO：文件存储抽象与生命周期一致性

> 对应 [ADR](文件存储架构方案.md)。每条独立可提交、带验收标准。近期只做 P0–P3；P4(OSS)/围栏外不在此。
> **通用纪律**：① 每 task 独立提交；② 先补测试再改；③ 涉及真实文件的 mkdir/rmdir/搬迁**先 staging 验证**；
> ④ 零行为变化的重构靠现有 REST 测试 + 对称测试兜底；⑤ 守红线：`get_owned` 授权、删除 30 天可还原、
> **不动存量 `storage_key`**、`check_ownership.py`/`check_confirm_gate.py` 保持绿。

## 前置（P0 起手时先定）
- [ ] `FileService` / `FolderTree` / `KeyStrategy` 接口最终签名（评审 30 分钟拍板）。
- [ ] 对账工具形态：一次性 CLI 脚本 vs 后台管理入口（倾向先 CLI）。

---

## P0 — 抽象缝（零行为变化，最安全，先做）

目标：把现在散落在 `folders.py`/`files.py`/`agent/tools/files.py` 的「拼 key + 文件夹 DB 操作」收口到接口后面，**行为一字不变**。

- [ ] **P0.1 `KeyStrategy` 协议 + `PathMirrorStrategy`**
  - 新 `storage/key_strategy.py`：协议 `build_key(...) / resolve_conflict(...) / move_semantics`。
  - `PathMirrorStrategy` = 包现有 `storage/keys.py` 的 `_build_key`/`_resolve_conflict`（逐字等价）。
  - 测试：复用/迁移 `test_storage_keys.py` 的向量到策略上。
  - 验收：策略产出 key 与现 `_build_key` 逐字一致（对拍）。
- [ ] **P0.2 `FolderTree` 接口 + `SqlAlchemyFolderTree`**
  - 新 `storage/folder_tree.py`：接口 `get_folder / get_children / create_folder / rename_folder / move_folder / delete_folder / resolve_path`。
  - `SqlAlchemyFolderTree` = 把 `folders.py` 的 DB 查询 + `storage/folders.py` 的 `resolve_folder_path` 抽进来（DB 耦合逻辑集中一处）。
  - 测试：测试库/内存，覆盖 create/move/rename/delete/resolve_path + 归属校验（`get_owned` 语义）。
  - 验收：与现 `folders.py` 行为等价；`check_ownership.py` 绿。
- [ ] **P0.3 `FileService`（统一入口）**
  - 新 `storage/file_service.py`：`create_file / move / rename / delete / list / read`（软删 P2 补），内部用 `FolderTree` + `StorageBackend` + `KeyStrategy`。
  - 验收：单测覆盖各操作；不含 FastAPI 依赖（可被 REST 与 Agent 共用）。
- [ ] **P0.4 factory 装配**
  - `storage/factory.py`：`get_file_service() / get_folder_tree() / get_key_strategy()` 按配置装配（现在只 `Local + PathMirror`，YAGNI）。
  - 验收：一处装配、下游注入。
- [ ] **P0.5 REST 端点 delegate 到 `FileService`**
  - `folders.py`/`files.py` 各端点改为调 `FileService`（逐端点等价替换）。
  - 验收：**所有现有文件/文件夹 REST 测试通过**；无行为变化；typecheck 绿。

---

## P1 — 文件夹生命周期一致性（数据完整性，治 today 的 123/adr）

- [ ] **P1.1 `LocalStorageBackend` 目录原语**
  - 加 `ensure_dir(prefix)`（mkdir 空目录）、`remove_empty_ancestors(key)`（逐级 rmdir 空祖先）、`move_prefix(old,new)`。
  - 测试：tmp_path 建/删/移，验证空目录物化与孤儿清理。
- [ ] **P1.2 建文件夹物化目录**：`create_folder` 经 `FileService`/`FolderTree` 调 `ensure_dir` → 空文件夹上盘（**Local 用真 `mkdir`，不用 `.keep`**）。验收：网页建空文件夹 → 盘上可见（staging）。
- [ ] **P1.3 修 rename/delete 留孤儿**：`rename_file`/`delete` 清空后调 `remove_empty_ancestors`。验收：移动/改名后无残留空目录。
- [ ] **P1.4 文件夹改名/移动走目录级**：纯改名 → `rename_dir`（整目录 mv）；移动 → 目录+文件同步 + 清旧祖先。验收：改名/移动后盘面与 DB 一致、无孤儿。
- [ ] **P1.5 对账工具（folder doctor）**：diff DB 树 vs 磁盘 → 报告（缺失目录/孤儿目录）；**自动补缺失目录**；**孤儿目录先报告、人工确认后清**（非空绝不自动删）。一次性 CLI + 低频兜底，非常驻扫描。验收：在存量数据上跑出报告、清掉现存 `adr`、补出 `123`（staging 先行）。

---

## P2 — 软删 + 回收站 + 字段（Agent 安全 + 可恢复 + 快速切 OSS 就绪）

- [ ] **P2.1 Alembic 加列**：`File` 加 `storage_backend`(默认 `'local'`)/`version`/`updated_at`/`deleted_at`；`Folder` 加 `version`/`updated_at`/`deleted_at`。nullable/带默认、不回填即安全。验收：迁移在 staging 跑通、存量零影响。
- [ ] **P2.2 文件夹软删**：`delete_folder`（REST + `FileService`）改软删（不再 `db.delete` 硬删）+ 递归软删文件 + 物理搬 trash 前缀。验收：删文件夹后 DB 行仍在、`deleted_at` 非空、文件在 trash。
- [ ] **P2.3 回收站列文件夹**：`trash.py` 列出 `deleted_at` 非空的**顶层文件夹**为可恢复单元。
- [ ] **P2.4 整体恢复**：恢复文件夹子树 + 文件（`deleted_at=null`）+ 物理搬回。验收：删→恢复往返后与删前一致。
- [ ] **P2.5 过期清理**：`cleanup_expired` 同步物理清文件夹子树（30 天）。
- [ ] **P2.6 version 接乐观并发**：`version`/`updated_at` 延伸现有 409 并发锁到文件夹。

---

## P3 — Agent / REST 统一（咕咕一致）

- [ ] **P3.1 Agent 工具走 `FileService`**：`agent/tools/files.py` 的 `_create_folder`/`_delete_folder`/`_move_folder`/`_rename_*` 改调 `FileService`（同一实现）。
- [ ] **P3.2 对称测试**：同一操作 REST vs Agent 结果一致（建/删/移/软删/恢复）。
- [ ] **P3.3 清重复**：移除 agent tools 里重复的 folder 逻辑（保共享 helper、去业务重复）。
  - 验收：咕咕文件夹操作与网页逐字一致；对称测试全绿；`check_ownership.py`/`check_confirm_gate.py` 绿。

---

## 建议起手顺序

**P0.1（`KeyStrategy` + `PathMirrorStrategy`）** 是最小、最安全的第一刀：纯抽提、有现成测试向量对拍、零行为变化、零生产风险。做完再 P0.2→P0.5 把缝铺满，然后 P1（数据完整性，价值最高）。

> P4（OSS backend + 方向无关 lazy 迁移作业 + 管理员按钮）等 OSS 到来或需求突增时做；`storage_backend` 列 P2.1 已就位，届时是「加实现」不是「改 schema」。

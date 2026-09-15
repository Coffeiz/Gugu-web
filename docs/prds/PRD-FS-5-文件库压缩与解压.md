# PRD-FS-5：文件库压缩与解压

> 状态：全部阶段已完成
> 创建：2026-09-11
> 最近更新：2026-09-14
> 关联模块：`backend/app/services/files/`、`backend/app/api/v1/files.py`、`backend/agent/tools/files/transfer.py`、`frontend/src/views/Files/index.vue`
> 背景参考：PRD-FS-4（顶层 Workspace 文件库空间）、`backend/app/services/filesync/targeted.py`（配额余量计算先例）

## 0. 实际状态

| 能力/结果 | 状态 | 说明 |
|---|---|---|
| 文件库压缩（多选文件/文件夹 → zip） | ✅ | `archive.py` 服务完成；512MB 源限制、配额、重名及空目录覆盖 |
| 文件库解压（zip / tar.gz → 压缩包旁新建目录） | ✅ | `archive.py` 服务完成；目录名默认取压缩包主体，可编辑；zip/tar.gz、目录结构与冲突改名覆盖 |
| 解压安全边界（zip-slip / 解压炸弹 / 符号链接） | ✅ | 路径预检、10,000 条/2GB/余量预算、链接跳过、整体回滚有服务测试 |
| API `POST /files/archive` / `POST /files/unarchive` | ✅ | 薄壳复用服务；成功后发布文件创建事件，跨用户资源按归属层统一隐藏为 404 |
| 咕咕工具 `compress_files` / `extract_files` | ✅ | typed entries 区分独立 File/Folder ID；无确认门；工具事件触发实时刷新 |
| 前端「压缩」「解压」入口 | ✅ | 文件多选工具栏/右键压缩；压缩在当前目录创建 ZIP；解压在压缩包旁按可编辑名称新建目录，不提供目标目录选择 |

## 1. 背景与目标

文件库（个人文件 / 项目文件 / Workspace 目录）目前没有压缩与解压能力：用户要打包一组文件只能逐个下载；拿到 zip/tar.gz 上传后无法在库内展开，只能下载到本地处理再传回。咕咕也无法替用户完成「打包发我」「把这个压缩包解开看看」这类高频请求——用 Shell `zip` 命令在个人/项目空间写的产物不落库、任何界面都看不见（Workspace 之外没有 filesync 投影），这条捷径走不通。

目标：文件库获得一等压缩/解压能力——Web 多选压缩、库内解压、配额受控、产物写 File 行并发文件事件实时可见；咕咕获得同能力的一等工具。

明确不做：

- 不支持 rar / 7z（需要外部二进制，出安全面）；解压格式限定 zip 与 tar/tar.gz/tgz。
- 不做异步大任务：同步执行的总量上限内直接完成，超限明确拒绝；worker 异步队列留待真实需求出现后再立项。
- 不做压缩包内浏览（不解开就预览内容列表）；解压是唯一入口。
- 不做跨空间打包：压缩产物与解压目标必须与源在同一空间（个人↔项目↔Workspace 之间用现有复制/粘贴语义）。
- 不做加密压缩包（带密码 zip）的解密。

## 2. 功能需求

### FR-FS5-001：压缩选中项为 zip

- 触发：文件页多选若干文件和/或文件夹（允许混合、允许只选文件夹）后点「压缩」，输入归档名（默认取首个选中项名，缺省 `archive.zip`）。
- 行为：递归打包选中项，保留目录层级与空文件夹；产物写为一个 `zip` File 行，落在所选内容所在的当前目录，`mime_type=application/zip`。用户只填写压缩包名称。
- 边界：源总字节数 > 512MB 时拒绝并提示「内容过大，暂不支持在库内压缩」（HTTP 409，同一文案给咕咕工具）；归档名与既有文件同名时走 FR-FS5-004 的重命名规则；空选集拒绝。
- 完成后产物出现在文件列表（文件事件实时刷新），可下载、可再压缩、可删除，与普通文件无异。

### FR-FS5-002：解压 zip / tar.gz 到新建目录

- 触发：`zip` / `tar` / `tar.gz` / `tgz` 文件的卡片、列表或右键菜单选择「解压」；不选择目标目录，只填写解压文件夹名称，默认取压缩包文件名（移除完整归档后缀）。
- 行为：在压缩包所在目录创建同空间子文件夹，并将解包条目写入该文件夹；同名目录按冲突规则自动改名；压缩包本体保留不动。若压缩包所有有效条目都位于与输出文件夹同名的唯一顶层目录中，则移除该重复前缀，避免产生空的外层目录和重复嵌套。目录创建与条目解压在同一事务中，失败不留下空目录。
- 边界：`policy` 固定为 `rename`（见 FR-FS5-004）；格式不支持（rar/7z/加密 zip）时明确报错「不支持的压缩格式」；损坏的压缩包报错且不产生任何部分产物（事务内完成，异常整体回滚）。

### FR-FS5-003：解压安全边界

- **Zip-slip**：条目名在规范化后包含 `..` 段、绝对路径或盘符前缀的，拒绝该条目；若存在任何被拒条目则整个解压拒绝（不做「部分成功」），错误信息不回显原始条目路径细节以外的内容。
- **符号链接条目**：zip 的 symlink 条目（external_attr 文件类型位）与 tar 的 symlink/hardlink/device 条目一律跳过，不落库、不报错，计入 summary 的 `skipped`。
- **解压炸弹**：解包前按压缩包元数据预算 uncompressed 总字节数与条目数；总量上限 = `min(用户剩余配额, 2GB)`，条目数上限 10000；超限整体拒绝，不开始写盘。
- 元数据不可信：以上预算只信压缩包自带元数据做预检，实际落盘仍逐条校验目标路径在目标文件夹内。

### FR-FS5-004：同名冲突自动重命名

- 目标文件夹内已存在同名文件/文件夹时，新产物追加序号后缀：`name (2).ext`、`name (3).ext`，以此类推；不覆盖、不跳过、不询问。
- 解压时压缩包内部的同名条目互不覆盖——按解包顺序依次应用同一重命名规则。

### FR-FS5-005：配额受控

- 压缩与解压前检查用户存储余量（`storage_limit_bytes` − 现存活量，口径与文件同步一致）；产物/解压量超过余量时整体拒绝，HTTP 409，文案「存储空间不足」。
- 压缩产物自身的字节计入用量；解压按解包后条目字节数计入；压缩过程不额外预留「临时双份空间」预算（产物落库时一并校验）。

### FR-FS5-006：咕咕工具 `compress_files` / `extract_files`

- `compress_files`：入参 `entries`（`{kind: "file"|"folder", id}` 数组）、`folder_id`（产物目标文件夹）、`name`；行为与 FR-FS5-001 一致，返回产物 `file_id` 与 `name`。File 与 Folder 使用独立主键，不能用未标类型的 `entry_ids` 消歧。
- `extract_files`：现有 `file_id`（压缩包）、`folder_id`（目标）、可选 `format` 提示契约保持不变。Web 的 `POST /files/unarchive` 增加可选 `folder_name`，用于在压缩包所在目录创建命名子目录；未传时保持旧 API 语义。
- 两个工具均不设确认门：默认路径不覆盖任何既有数据（冲突自动重命名）。未来若增加「覆盖」策略，覆盖分支必须接确认门。
- 工具描述写明：只操作文件库条目；压缩工具注明 512MB 源上限，解压工具注明 10,000 条/2GB 与配额边界；失败文案即用户可读原因。

### FR-FS5-007：完成即实时可见

- 压缩产物与解压出的每个条目都写 File/Folder 行，并按现有文件操作口径发布 `files` 通道事件（create）；前端列表无需手动刷新即出现产物。

## 3. 技术方案

核心是单一服务模块，Web API 与咕咕工具都只做薄壳；格式能力只用 Python 标准库 `zipfile` / `tarfile`，不引入新依赖。

```
backend/
  app/services/files/archive.py        【新增】压缩/解压核心服务（安全边界、配额、重命名都在这里）
  app/api/v1/files.py                  【修改】POST /files/archive、POST /files/unarchive 两个端点（薄壳）
  agent/tools/files/transfer.py        【修改】compress_files / extract_files 工具（handler 调 archive 服务）
  tests/test_files_archive.py          【新增】服务级测试（安全边界/配额/重命名/CJK/空目录/tar.gz）
  tests/test_tools_archive.py          【新增】工具 handler 测试（schema、鉴权、错误透出）
frontend/
  src/views/Files/index.vue            【修改】多选工具条「压缩」入口
  src/views/Files/components/ArchiveOperationDialog.vue 【新增】压缩包名/解压文件夹名输入
  src/services/api.ts                  【修改】filesApi.archive / filesApi.unarchive
  src/i18n/locales/zh-CN.ts            【修改】中文文案（en-US、ja-JP 同步补）
docs/
  devlog/2026-09-xx-文件库压缩解压.md  【新增】实施记录
```

- `archive.py` 职责：条目收集（含文件夹递归）、安全预检、打包/解包、冲突重命名、配额校验、File/Folder 行创建；不依赖 API 或 Agent 事件上下文。API 在提交后发布带完整实体的创建事件，工具由统一 dispatch 资源映射触发合并刷新。API 与工具不重复实现任何一条归档规则。
- 空间归属校验沿用 `get_owned`；压缩产物当前落在源目录，解压目录作为压缩包所在目录的子目录，均由服务层验证归属，不信任前端。API 压缩请求使用独立 `file_ids`/`folder_ids` 字段；工具请求使用 typed `entries`。
- 归档读文件通过 `StorageBackend.iter_chunks` 分块读取；ZIP/TAR 需要 seek 的归档输入、输出仅暂存系统临时文件，不将整个源文件/归档载入内存。
- 重命名规则与上传重名处理保持同一观感（`name (2).ext` 序号后缀）。
- 事务边界：单次解压整体一个事务，任一条目落库失败即整体回滚；压缩产物在字节写盘成功后才建 File 行。
- 明确不修改：`filesync/`（不涉及绑定与投影）、回收站逻辑（删除走既有软删）、文件下载/上传端点。

## 4. 验证与上线

- 后端：`cd backend && PYTHONPATH=. .venv/bin/pytest tests/test_files_archive.py tests/test_tools_archive.py -q` 全绿；随后 `PYTHONPATH=. .venv/bin/pytest -q` 全量回归。
- 前端：`cd frontend && npm run typecheck && npm run test:run` 全绿。
- 手工验收：文件页多选压缩含中文与空文件夹的目录 → 产物可下载且系统解压工具可正常展开；上传一个含 `../evil.txt` 恶意条目与 symlink 条目的 zip → 整体拒绝/跳过，目标目录无越权文件；构造超配额 zip → 拒绝且无部分产物；咕咕对话里说「把 xx 打包」「解开 yy」→ 工具执行且列表实时出现产物。
- 灰度与回滚：无配置开关；回滚 = revert 提交即可（新端点与新工具随代码消失，已产生的 zip 条目是普通文件，无清理负担）。

## 5. 风险与待确认问题

| 风险 | 影响 | 对策 |
|---|---|---|
| 恶意压缩包（zip-slip / 炸弹 / symlink） | 越权写文件、撑爆磁盘 | FR-FS5-003 三道边界 + 测试用恶意样例覆盖 |
| 大目录同步执行超时 | 请求挂死、用户重复点击 | 512MB 上限直接 409；后续如有真实需求再立项异步 |
| zip 中文文件名兼容性 | Windows 旧解压工具乱码 | `zipfile` 对非 ASCII 名称写 UTF-8 标志位，Win10+ 系统解压正常；tar.gz 无此问题 |
| 压缩过程占内存 | 2 核小内存机器压力 | 流式写归档（逐条 `write`，不整包进内存）；解压逐条落盘 |

已确认：压缩与解压均不提供目标目录选择。Web 压缩只输入压缩包名称；Web 解压在压缩包旁新建文件夹，默认去掉完整压缩包后缀并允许编辑名称。

- 压缩是否需要提供 tar.gz 选项（当前只出 zip）？建议先不做，等用户反馈。

## 6. 唯一实施 TODO

### Phase 1：后端服务与安全边界

- [x] `FS5-001` 实现 `archive.py` 压缩服务；验收：多选文件+文件夹（含中文名、空文件夹）打包为 zip 并写 File 行，源超 512MB 返回 409。
- [x] `FS5-002` 实现 `archive.py` 解压服务（zip + tar.gz）；验收：正常包展开目录结构正确，冲突自动重命名 `name (2).ext`，损坏包整体回滚无部分产物。
- [x] `FS5-003` 实现安全边界（zip-slip 拒绝、symlink 跳过、炸弹预算 + 条目数上限 + 配额校验）；验收：恶意样例测试全绿，越权文件不落盘，超配额整体拒绝。

### Phase 2：API 与咕咕工具

- [x] `FS5-004` 暴露 `POST /files/archive`、`POST /files/unarchive`（身份依赖、服务内 `get_owned`/同空间校验、提交后发布文件事件）；验收：API 测试覆盖成功/409/跨用户隐藏为 404/不支持格式。
- [x] `FS5-005` 注册 `compress_files` / `extract_files` 工具（typed schema、工具描述含上限与用法、无确认门说明）；验收：handler/schema 测试通过，dispatch 通过文件资源事件实时触发列表刷新。

### Phase 3：前端入口

- [x] `FS5-006` 文件页多选「压缩」入口（工具栏与右键菜单；右键单个已选文件/文件夹也可压缩）+ zip/tar 卡片、列表及右键菜单「解压」入口；压缩只填写名称并写入源所在当前目录；解压默认按压缩包主体名创建同目录子文件夹，名称可编辑，无目标目录选择器；归档唯一顶层目录与输出目录同名时去除冗余前缀。验收：typecheck、定向单测与生产构建通过；前后端归档/API 定向测试通过。未对共享开发文件库执行会写入真实文件的 5173 手工流程；压缩与解压核心行为由服务/API 自动化测试覆盖。

### Phase 4：回归与收尾

- [x] `FS5-007` 后端全量回归 + devlog 实施记录；验收：`PYTHONPATH=. .venv/bin/pytest -q` 全绿（2,973 passed），devlog 落盘。前端 `npm run typecheck`、`npm run test:run`（525 passed）与 `npm run build` 均通过。

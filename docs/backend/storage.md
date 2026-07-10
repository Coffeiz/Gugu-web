# 文件存储结构规范

> 更新：2026-07-11（§2.8 前端缓存与实时刷新重写；Tier 0–3 全部落地：三套缓存收敛为单一 `filesCache` store + SSE 细粒度化（origin 回声抑制 / fileOp remove 快路径 / 合并刷新），详见 §2.8.8）
> 项目：咕咕 / gugugu.site

---

## 一、易读概述

### 这是什么

咕咕的"文件"分两种存在方式：**正式文件**（用户在文件库里能看到、管理的文件，进数据库有记录）和**聊天暂存附件**（用户在对话里随手发的文件，先临时存着，用户明确说"存一下"才会变成正式文件）。这份文档讲的是这两类东西分别存在哪、怎么组织、怎么和数据库对应上。

### 空间划分

文件库按"空间"分了四类，目前真正做完、能用的只有前两个：

| 空间 | 说明 | 开发状态 |
|------|------|---------|
| 个人文件 | 用户自由上传，支持自建文件夹无限嵌套 | 已完成 |
| 项目文件 | 关联项目，按年/月/项目/用户文件夹分层 | 已完成 |
| 回收站 | 软删除文件，30 天自动清理 | 已完成 |
| 思维画布（mind） | 附件存储 | 预留，数据库表已建但无功能入口 |
| 素材板（asset） | 素材管理 | 预留，连数据库表都还没有 |

### 存储后端可以热切换

开发阶段文件存在本机磁盘，正式上线后可以切到阿里云 OSS——这个切换在 Admin 后台点一下就完成，不用重启、不用改代码，因为磁盘和 OSS 背后走的是同一套抽象接口。但**切换本身不会自动把旧文件搬过去**，这是运维时最容易踩的坑，详见 §五。

### 聊天附件为什么要"暂存"

用户在跟咕咕聊天时随口发个图或文件，大多数时候只是想让咕咕"看一眼"，不一定要真的存进文件库占位置。所以这类文件先扔进一个临时目录（7 天自动过期），只有用户明确要求保存时，咕咕才会把它复制一份变成正式的文件库记录。

---

## 二、专业细节

### 2.1 磁盘目录结构

```
uploads/
└── {user_id}/
    ├── 个人文件/
    │   ├── 文件.pdf
    │   └── {用户文件夹}/
    │       └── 文件.pdf
    ├── 项目文件/
    │   └── {year}/
    │       └── {month}/
    │           └── {项目名} #{project_id}/
    │               ├── 文件.pdf
    │               └── {用户文件夹}/
    │                   └── 文件.pdf
    ├── 思维/
    │   └── {mind_map_title} #{mind_map_id}/
    │       └── 文件.pdf          ← 预留，storage_key 已能构造，但无 API 可用（见 §四）
    ├── 素材板/
    │   └── 文件.pdf              ← 预留，纯 key 分支，无数据库模型支撑
    ├── .chat_staging/
    │   └── {attach_id}.ext       ← 聊天暂存附件，7 天 TTL（见 §六）
    ├── .voice/
    │   └── {attach_id}.ext       ← 语音条暂存，7 天 TTL（独立子目录，见 §六）
    ├── .thumbs/
    │   └── {file_id}_{size}.webp ← 缩略图磁盘缓存
    └── trash/
        └── {file_id}/
            └── 原文件名.ext       ← 软删除时移入，30 天后自动永久删除
```

`{user_id}` 现在是 UUID（`uuid7`）字符串，不是自增整数。

**用户隔离：** 回收站路径包含 `{user_id}/`，不同用户的回收站完全隔离。`/uploads/` 目录不对外静态暴露，所有访问必须经后端鉴权接口（`/files/{id}/download` 等）。

**年月来源：** 优先用项目 `start_date`，fallback 到 `created_at`（`_proj_date()` 工具函数，`backend/app/api/v1/projects.py`）。

**项目目录带 `#{id}` 的原因：** 项目改名时目录同步重命名，`#{id}` 不变，未来桌面客户端可通过 ID 定位关联，不依赖名称匹配。

**storage_key 构造函数：** `_build_key()`（`backend/app/api/v1/files.py`）和 Agent 工具侧的 `_resolve_key()`（`backend/agent/tools/files.py`）各自实现了一遍同样的路径拼接规则，两处需保持一致。

### 2.2 数据库表

#### 2.2.1 `files` 表（SQLAlchemy 模型，`backend/app/models/__init__.py`）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | Integer PK 自增 | |
| user_id | Uuid FK → users.id, CASCADE | |
| display_name | String(300) | |
| ext | String(20) | |
| space | String(20)，默认 `personal` | `project` \| `mind` \| `asset` \| `personal` |
| project_id | FK → projects.id, SET NULL | NULL = 个人文件 |
| folder_id | FK → folders.id, SET NULL | NULL = 当前空间根目录 |
| stage_name | String(100)，默认空 | 标签字段，非导航层级 |
| mind_map_id | FK → mind_maps.id, SET NULL | 预留 |
| storage_key | String(500) | 相对于 `UPLOAD_DIR` 的路径，OSS 迁移时直接用作 object key |
| size | String(50) | 人类可读格式，如 `2.3 MB` |
| size_bytes | BigInteger，默认 0 | |
| mime_type | String(200)? | |
| img_width / img_height | Integer? | 图片尺寸，上传时提取 |
| created_at / updated_at | DateTime | |
| deleted_at | DateTime?，索引 | 非 NULL 表示已移入回收站 |

#### 2.2.2 `folders` 表

`id`（自增 PK）、`user_id`（FK CASCADE）、`project_id`（FK → projects.id，CASCADE，NULL=个人文件夹）、`parent_id`（FK → folders.id，CASCADE，自引用，NULL=根目录，支持无限嵌套）、`name`（String(200)）、`created_at`。删除文件夹时级联删除所有子文件夹，文件的 `folder_id` SET NULL。

#### 2.2.3 自动迁移

`session.py` 的 `create_all_tables()` 执行后自动跑 `_MIGRATIONS` 列表里的 `ALTER TABLE`，新增 nullable 列时加到此列表即可，无需手动执行 SQL。

### 2.3 API 接口

#### 2.3.1 Files（`backend/app/api/v1/files.py`，约 1100 行，目前最大的路由文件）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/files` | 列出文件（支持过滤） |
| `GET` | `/files/all` | 当前用户所有文件元数据（前端全量缓存用） |
| `GET` | `/files/version` | 变更感知摘要 `count:max_updated:max_deleted` |
| `GET` | `/files/storage` | 存储用量统计 |
| `GET` | `/files/tree` | 文件树结构 |
| `POST` | `/files` | 上传文件（服务器代理，本地后端走这条） |
| `POST` | `/files/presign` | OSS 直传：计算 storage_key、查配额，返回预签名 URL（见 §七） |
| `POST` | `/files/confirm` | OSS 直传完成后注册 DB 记录 |
| `PATCH` | `/files/{id}` | 重命名 / 移动文件 |
| `PUT` | `/files/{id}/content` | 直接编辑保存文本内容 |
| `DELETE` | `/files/{id}` | 软删除（移入回收站） |
| `POST` | `/files/batch-delete` | 批量软删除 |
| `POST` | `/files/batch-download` | 批量打包下载 |
| `POST` | `/files/{id}/copy` | 复制文件到指定目录 |
| `GET` | `/files/{id}/download` | 下载（Bearer token 鉴权） |
| `GET` | `/files/{id}/preview-pdf` | Office → PDF 转换预览（LibreOffice headless） |
| `GET` | `/files/{id}/stream-url` / `/files/{id}/stream` | 视频流地址 / 流式播放 |
| `GET` | `/files/{id}/thumb` | 图片缩略图（`?size=tiny\|card\|full`），见 §九 |

**`GET /files` Query 参数：** `project_id`（省略则返回个人文件）、`folder_id`（省略则返回根目录文件）、`include_deleted`（回收站模式）。

#### 2.3.2 Folders

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/folders` / `/folders/all` | 列出（后者全量，前端缓存用） |
| `POST` | `/folders` | 新建文件夹 |
| `PATCH` | `/folders/{id}` | 重命名 |
| `PATCH` | `/folders/{id}/parent` | 移动（含循环引用检查） |
| `DELETE` | `/folders/{id}` | 删除（级联删除子文件夹，文件 SET NULL） |
| `GET` | `/folders/{id}/download-zip` | 打包下载文件夹 |

#### 2.3.3 Trash

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/trash` | 列出回收站文件 |
| `POST` | `/trash/{id}/restore` / `/trash/batch-restore` | 恢复单个 / 批量 |
| `DELETE` | `/trash/{id}` | 永久删除单个文件 |
| `DELETE` | `/trash/empty`（内部为 `/trash`，方法 DELETE） | 清空回收站 |

后端 lifespan 启动定时清理任务（`_auto_cleanup_loop`，`app/main.py`），每小时检查一次，自动永久删除 `deleted_at` 超过 30 天的文件。

### 2.4 存储后端抽象层

#### 2.4.1 设计目标

- 开发期用本地磁盘，上线后切换 OSS，**只改配置，不改业务代码**
- Admin 面板实时切换，无需重启服务
- `storage_key` 对两种后端完全一致，DB 不变

#### 2.4.2 接口定义（`backend/app/services/storage/__init__.py`）

```python
class StorageBackend(ABC):
    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def rename_file(self, old_key: str, new_key: str) -> None: ...
    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None: ...
    def public_url(self, key: str) -> str: ...
    async def exists(self, key: str) -> bool: ...          # 物理对象是否存在（对账用）
    async def list_keys(self) -> list[str]: ...             # 枚举所有对象 key（对账用；Local 走 rglob，OSS 走 ObjectIterator）
    async def delete_prefix(self, prefix: str) -> int: ...  # 删除前缀下所有对象（账户注销清数据用），空/根前缀直接抛 ValueError 防误清全库
```

`fetch_url(key) -> str | None` **不是抽象方法**，基类给了默认实现直接返回 `None`；只有 `OSSStorageBackend` 覆写它，返回**外部第三方可直接 HTTP 抓取**的临时签名 URL（1 小时有效，QQ 富媒体 url 模式用）。本地存储没有公网地址，调用方拿到 `None` 后应退回 base64 上传。

`OSSStorageBackend` 额外提供（**不在 ABC 接口里，仅 OSS 后端有**）：

```python
def presign_put(self, key: str, mime_type: str | None = None, expires: int = 600) -> str:
    """返回有效期 expires 秒的 presigned PUT URL，供浏览器绕过服务器直传 OSS。"""
```

#### 2.4.3 工厂函数

```python
def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
```

#### 2.4.4 OSS 切换与迁移注意

**配置项**（Admin → 存储，落到 `settings.storage`）：`backend`（`local` | `oss`）、`oss_access_key_id` / `oss_access_key_secret` / `oss_bucket` / `oss_endpoint` / `oss_prefix`。OSS 凭据即使 `backend=local` 也会保存在 settings 里，方便切换前先验证。

**切换即时生效**：`get_storage()` 每次请求重读 settings，把 `backend` 改成 `oss` 后**下一请求**就走 OSS，无需重启。

**现有本地文件不自动迁移**：`files.storage_key` 是相对路径（如 `{uid}/项目文件/…/x.png`），本地与 OSS **共用同一套 key**。切到 OSS 后，老文件的 key 在 OSS 上并不存在 → 读取/缩略图会 404（`get_thumb` 等已改为缺文件返回 404、不再 500）。**平滑切换需先把 `uploads/` 全量同步到 OSS 同名 key**（`StorageBackend.list_keys()` 可枚举：Local 走 `rglob`、OSS 走 `ObjectIterator`，对账工具即基于此）。

**Endpoint 协议**：`oss_endpoint` 不带协议时 oss2 默认 `http://`，签名 URL（`fetch_url`，QQ 抓媒体用）也是 http。需要 https 就把 endpoint 配成 `https://oss-cn-…aliyuncs.com`。

**冒烟验证**：可直接实例化 `OSSStorageBackend(get_settings().storage)` 跑 `put → exists → get → fetch_url → rename_file → delete` 往返（用 `.smoketest/` 前缀的临时 key，跑完清理），确认凭据/连通正常，不必先切活跃 backend。

### 2.5 项目重命名联动

`PATCH /projects/{id}` 修改 `name` 时（逻辑内联在 `update_project` 里，`backend/app/api/v1/projects.py`，并非单独函数）：

1. 用 `_proj_date(p)` 取 `(year, month)`（优先 `start_date`，否则 `created_at`），构造旧目录前缀 `{uid}/项目文件/{year}/{month}/{旧名} #{id}/`
2. `get_storage().rename_dir(old_prefix, new_prefix)` 重命名磁盘/OSS 目录
3. 批量替换该项目下所有 `files.storage_key` 前缀
4. 更新 `projects.name`，`version` 字段 +1（乐观锁）

### 2.6 项目删除时的文件处理（与早期设计不同，已重写）

**当前行为**：删除项目（`DELETE /projects/{id}`，或 Agent 的 `delete_project` 工具）时，项目下的文件**软删除进回收站**（`deleted_at` 置为当前时间），文件夹通过 `folders.project_id` 的 `ON DELETE CASCADE` 随项目一起硬删除。物理文件和 `storage_key` 不动，走的是与单文件删除完全一致的回收站语义——30 天后由定时任务永久清理。前端在项目下有文件/文件夹时会先弹确认，之后直接执行这套级联删除。

> 早期方案是删项目前把文件"rehome"成个人文件（`space` 改 `personal`，`project_id`/`folder_id` 清空），用来防止 `project_id` 被 `SET NULL` 后変成"孤儿文件"却混进个人空间视图。这套函数（曾用名 `rehome_project_files_to_personal`）**在当前代码里已不存在**——现在的解法是直接软删而不是脱钩重挂，从源头避免了孤儿文件问题。如果你在别处（旧文档、旧 commit message）看到这个函数名，按当前代码为准。

### 2.7 同名文件冲突处理

同一目录下已存在同名文件时，追加 `(n)`：

```
需求文档.pdf → 需求文档(1).pdf → 需求文档(2).pdf
```

`display_name` 字段同步更新。

### 2.8 前端文件缓存策略与实时刷新

#### 2.8.1 目标

两个目标：① 消除文件库导航时的"白屏/加载"感，文件夹切换、返回上级接近本地应用；② 保证**所有展示文件的页面不需要手动刷新就能看到最新状态**——不管是本页写操作、还是咕咕/其它端/另一标签页的改动，都应自动同步。目标 ① 早已达成；目标 ②（"免刷新保证"）当前**尚未完全达成**，缺口与方案见 §2.8.8。

#### 2.8.2 三套并存的前端缓存（现状，重要）

文件数据目前在前端有**三套互不共享底层的缓存**，只在"全量重拉 / 重新进页面"时才互相对齐：

| 缓存 | 用在哪 | 结构 / 特点 | 回前台兜底 |
|---|---|---|---|
| 全局 `stores/filesCache.ts`（cacheStore） | 文件库页 `views/Files/index.vue`、项目卡文件数 `views/Projects/index.vue` | 扁平 `allFiles`/`allFolders` + 两个 computed 分层索引；增量 API 齐全；`refresh()` **全量重拉** | ✅ visibilitychange 版本校验 |
| ProjectModal **自持**本地缓存 | 项目编辑卡 `views/Projects/components/ProjectModal.vue`（`projectFiles`/`folderFilesMap`/`subFolderMap`/`projectFolders`，`:763-797`） | 只拿全局缓存当**开屏种子**，随后直连 `filesApi.list`/`foldersApi.list` 覆盖；**导航吃缓存不重拉** | ❌ 无 |
| Dashboard FilePanel 的 sessionStorage `services/cache.ts` | `views/Dashboard/components/FilePanel.vue` | 扁平列表 | ❌ 无 |

> ⚠️ 三套并存是当前最大的结构性缝隙：一处改了，另两套要靠 SSE 全量重拉或重进页面才对齐。长期方向是收敛为单一 store（见 §2.8.8 Tier 3）。

#### 2.8.3 后端接口

```
GET /files/all    → 当前用户所有未删除文件元数据（FileResponse[]）
GET /folders/all  → 当前用户所有文件夹（FolderResponse[]）
GET /files/version → count:max_updated:max_deleted 摘要（版本校验用）
```

**数据量评估：** 单条文件元数据约 300–600 字节，10,000 个文件约 5 MB，对浏览器无压力。

#### 2.8.4 全局内存索引（`src/stores/filesCache.ts`）

扁平 `allFiles`/`allFolders` + Computed Map 双索引，O(1) 查找：

```ts
// files: 'personal' | 'proj:{id}' | folderId(int) → File[]
const _fileIdx = computed(() => { ... })
// folders: 'personal' | 'proj:{id}' | 'sub:{parentId}' → Folder[]
const _folderIdx = computed(() => { ... })
```

对外查找 `getPersonalRootFiles/getProjectRootFiles/getFolderFiles`、`getPersonalRootFolders/getProjectRootFolders/getSubFolders`；增量 API `addFile/removeFile/removeFiles/updateFile`、`addFolder/removeFolder/updateFolder`（`removeFolder` 递归级联子文件夹及其文件）。

#### 2.8.5 乐观更新 + 服务端验证

| 操作 | 本地先做 | 失败时 |
|------|---------|--------|
| 上传文件 | 加入缓存 | 无需回滚（服务端若失败则文件本就不存在） |
| 删除文件 | 从缓存移除 | 放回 + 报错 |
| 重命名 | 直接改名称 | 还原 + 报错 |
| 新建文件夹 | 插入临时负数 ID 条目 | 移除临时条目 + 报错 |
| 剪切粘贴 | 更新 folderId/projectId | 还原 + 报错 |

> 移动/剪切文件到"项目根"时**必须显式带 `projectId`**：后端 `update_file` 在未传 `project_id` 时保留原值，而项目文件夹内文件的 `project_id` 可能为 null，只传 `folderId:null` 会让 `new_space` 退成 personal、文件落到个人库根（项目根视图按 `project_id` 查不到 → 看似"移不过去"）。参见 §2.3 `update_file` 与 `ProjectModal.movePmFilesInto`。

#### 2.8.6 缓存失效与实时刷新（三条通道叠加）

1. **写操作乐观增量**：发起视图先本地改，后台同步服务端，失败回滚（见 §2.8.5）。
2. **SSE 实时通道**（`stores/live.ts` ← 后端 `/live/stream`）：
   - **粒度**：**粗粒度 bump**——后端只推 `{"resources":["files"]}`，**不带文件 id、不带操作类型**（`backend/app/core/events.py:47-65`）；前端 `rev.files++`，订阅者一律 `cacheStore.refresh()` **全量重拉整个文件库**（有意为之，`filesCache.ts:146`：GET `/files/version` 可能被浏览器缓存到旧值，不敢做版本门控）。
   - **谁推**：**只有咕咕/IM 走 tool-dispatch 那条唯一钩子会 publish**（`backend/agent/tools/base.py:354-362` + `events.py:28-39` 的 `RESOURCE_BY_TOOL`）；`app/api/v1/files.py`/`folders.py` 这些 **REST 端点完全不 publish** → **用户自己在网页上的操作后端不广播**。这是"跨标签页 / 不共享缓存的面收不到用户自己操作"的根因。
   - **谁订阅**：Files 页（`index.vue:1189`）、ProjectModal（`:1428`，只对当前项目重拉、且不刷 `subFolderMap`）。**FilePanel 没订阅**。
   - 另有 `uploadSignal` / `liveStore.bump('files')` 纯前端递增（不过网络、不跨标签页），仅 Files 页 watch（`index.vue:1182`）。
3. **版本校验兜底**：Tab 切回前台（`visibilitychange`）调 `GET /files/version`，与上次不一致则静默重拉。**只有全局 cacheStore 有**（`filesCache.ts:88-94`）；ProjectModal 本地缓存、FilePanel 都没绑。
4. **本地文件删除检测**：`GET /files/all` 在 LocalStorageBackend 下扫描每个文件实体是否存在；不存在的直接硬删 DB 记录（不进回收站），保证 UI 与文件系统一致。

> 早期本节曾写"多标签/多设备由版本校验覆盖，无需 WebSocket"——**已过时**：现已有 SSE `/live/stream`，但它只广播咕咕/IM 侧改动；用户自己的网页操作仍只靠本标签乐观更新 + 回前台版本校验，跨标签页/跨面尚未打通（见 §2.8.8）。

#### 2.8.7 加载体验优化

- **内容过渡动画**：导航切换时 `content-fade` 淡出（40ms）+ 淡入（120ms），`mode="out-in"` 避免双层叠放
- **热缓存同步初始化**：`onMounted` 检测 `cacheStore.loaded && projectStore.projects.length > 0` 时同步调 `restoreNav() + loadContents()`，跳过 `await`，SPA 内导航回文件库无空帧闪烁
- **tiny blob 全局预热**：任何页面获取文件列表后调 `preloadTinyThumbs(files)`，后台静默 fetch 所有图片 tiny blob（已缓存则跳过），跨页面共享，渐进式加载
- **项目编辑卡文件预填**：打开项目时先从 `filesCacheStore` 同步填充文件/文件夹列表，API 刷新后覆盖，消除等待期间文件区域为空的问题
- 回收站仍走异步请求（需要 `deleted_at` 字段，不在主缓存中）

#### 2.8.8 已知 stale 缺口与「免刷新保证」方案（2026-07-11 排查）

**要达成"所有页面免刷新即更新"的保证，最小充分集 = ① 所有改动都广播 → ② 所有展示面都订阅 → ③ 收到就刷新。当前 ②③ 基本有（除 FilePanel），缺的核心是 ①：用户自己的网页操作后端不 publish（§2.8.6）。**

已知缺口（按严重度，均带 `文件:行号`，随代码演进可能漂移）：

**A. 真 bug（当前视图当场就错，不用导航）**
- Files 页右键"移到回收站"删文件不消失——`ctxDelete` 只调 API + `loadContents`，**漏 `cacheStore.removeFile`**（`views/Files/index.vue:1963`）；而 `loadContents` 从缓存同步重建 → 文件原地不动。同功能的悬停垃圾桶 `deleteSingleFile` 有乐观删除，两条路径不一致。
- ProjectModal 在子文件夹里删/改其子文件夹，当前视图不更新——`deleteFolderCard`（`ProjectModal.vue:1355`）、`commitFolderRename`（`:1323`）的 `loadFolders` 写死 `parentId=null` 只刷根层，当前层读的是 `subFolderMap[父id]`。

**B. 导航后 stale（换层才暴露）**
- 剪切文件跨层粘贴，源文件夹 `folderFilesMap[src]` 残留（`ProjectModal.vue:2160`，`pmRefreshCurrentFolder` 只刷当前层）。
- Dashboard FilePanel 开着期间几乎必 stale（不订阅任何实时信号，只进 Dashboard 时版本门控拉一次）。

**C. 计数徽标 stale（数字对不上，次要）**
- `subFolderMap.fileCount` 几乎从不增量刷新（所有单项操作调 `loadFolders` 都写死根层）；面包屑移动、右键删文件不刷两侧计数。

**D. 跨面 / 跨标签不同步（结构性）**
- 用户网页操作不进 SSE；三套缓存不互通；ProjectModal 本地缓存、FilePanel 都无 visibilitychange 兜底，回前台不自愈。

**分级方案与落地状态（2026-07-11）：**

| Tier | 做什么 | 状态 |
|---|---|---|
| **0 止血** | 修 A、B 具体处：`ctxDelete` 加乐观 `cacheStore.removeFiles`+失败回滚+`fetchStorage`；`deleteFolderCard`/`commitFolderRename` 的 `loadFolders` 改按当前层 `pmCurrentFolderId()` 刷；剪切跨层粘贴后逐层剔除源层被移走的文件 id | ✅ 已实现 |
| **1 兜底** | FilePanel 订阅 SSE(`liveStore.rev.files`)+`uploadSignal`（版本门控重拉）；计数徽标改本地增减 `_pmAdjustFolderCount`（逐层找卡片，接入删/移/传）；visibilitychange 兜底经评估**冗余**（SSE 重连 `_catchUp` 已错峰 bump 所有资源，覆盖切回标签页）→ 不做 | ✅ 已实现 |
| **2 关键** | `files.py`/`folders.py`/`trash.py` 的所有增删改端点（16 处）commit 后 `await events.publish(current_user.id, "files")` → 用户自己的网页操作也广播，跨标签页/跨面自动同步 | ✅ 已实现（需重启后端生效） |
| **3-A 缓存收敛** | 三套缓存统一到单一 store：Dashboard/FilePanel（Phase A，5e7f422）+ ProjectModal（Phase B，c4b725b）都改从全局 `filesCache` 派生，删除各自本地并行缓存（projectFiles/folderFilesMap/subFolderMap、services/cache 的 filesCache），所有增删改走 store 增量 API | ✅ 已实现 |
| **3-B SSE 细粒度化 + 回声抑制** | SSE 载荷带 `origin`（发起标签页 client-id）+ `fileOp`（{op,kind,id/ids}）。前端：① 发起页收到自己的回声 → 跳过重拉（已乐观更新）；② 删除类 → 本地直接剔除（零网络）；③ 其余 → 防抖合并后全量刷新 | ✅ 已实现（需重启后端生效） |

**Tier 3-B 契约（新增，2026-07-11）：**

- **前端**：`api.ts` 每标签页生成 `CLIENT_ID`，所有写操作（`request()` + `uploadWithProgress`）带 `X-Client-Id` 头。
- **后端**：`get_client_id` 依赖读该头 → `events.publish(..., origin=<client_id>, file_op={...})`。删除类端点（`delete_file`/`batch_delete`/`delete_folder`，及咕咕 `_delete_file`/`_delete_folder` 经 `_file_op` 结果字段）带 `file_op={"op":"remove","kind":"file|folder","id"|"ids"}`；增改类只带 `origin`。咕咕/IM 侧无 client-id → `origin=None`，不被抑制，所有端都刷新（正确）。
- **SSE payload**：`{"resources":["files"], "origin":"<id>|null", "fileOp":{...}?}`。
- **前端消费分工**：
  - `rev.files` 仍照旧 bump —— 预览窗（FilePreviewModal/FloatPreviewWindow）、回收站视图、项目卡片计数等**粗信号**消费者不动。
  - `live.fileEvent`（新通道）供 `filesCache` 独家消费：回声抑制 / remove 快路径 / 防抖合并刷新。`filesCache` 不再订阅 `rev.files`。
  - `Files/index.vue` 的 `contents` 是手动投影快照 → 改为 `watch([allFiles, allFolders])` 重投影（filesCache 统一负责刷新/patch，本页不再自持重拉，回声抑制对本页同样生效）。ProjectModal/FilePanel 用 computed 派生，天然响应。
- **边界**：还原（trash→库）是唯一「不乐观更新」的网页写操作，发起页 SSE 回声被抑制拉不回来 → `restoreFile`/`restoreSelected` 显式 `cacheStore.refresh()` 自刷。断线重连 `_catchUp` 对 files 额外 poke 一次 `fileEvent` refresh（`origin=null`，不抑制）补回漏掉的改动。

**落地后现状**：Tier 0/1/2/3 全部闭环。"所有页面免刷新即更新"保证达成；三套缓存收敛为单一 `filesCache` store；SSE 细粒度化后——发起页零重拉（回声抑制）、其它端删除零网络（remove 快路径）、增改合并刷新，"任意小改动全库重拉"的性能天花板消除。回声成本（Tier 2 遗留）随回声抑制一并解决。

### 2.9 图片缩略图

#### 2.9.1 接口

```
GET /files/{id}/thumb?size=full|tiny|card
Authorization: Bearer <user_token>
```

| size | 分辨率 | 格式 | 质量 | 用途 |
|------|--------|------|------|------|
| `tiny` | 20px | WebP | q75 | blur-up 模糊占位 |
| `card` | 192px | WebP | q82 | 网格卡片显示 |
| `full`（默认） | 原图 | 原格式 | — | 全尺寸预览 |

具体尺寸/质量定义在 `_THUMB_SIZE_MAP = {"tiny": (20, 75), "card": (192, 82)}`（`backend/app/api/v1/files.py`）。**当前格式是 WebP，不是 JPEG**——JPEG（quality=80）只在 WebP 编码失败时作为降级兜底（`_generate_thumb_jpeg_fallback`），正常路径不会走到。

- 鉴权：`Authorization: Bearer` 请求头（URL 不含 token，HTTP 缓存 key 稳定）
- 响应头：`Cache-Control: private, max-age=86400`（浏览器缓存 24 小时）
- SVG 跳过 Pillow，`size=full` 直接返回原文件

支持格式：JPEG / PNG / GIF / WEBP / AVIF / BMP / HEIC / HEIF / SVG。

#### 2.9.2 后端磁盘缓存

生成的缩略图持久化到 `uploads/.thumbs/{fid}_{size}.webp`（旧版遗留的 `.jpg` 缓存文件在 lifespan 启动时会被清理）。请求到来时优先命中缓存，跳过 Pillow，响应时间从数百毫秒降至毫秒级。

**生成策略：**

- **一次生成两个尺寸**：无论请求 `tiny` 还是 `card`，均读取一次原图，同时生成并缓存 tiny + card，避免重复 I/O
- **上传时预生成**：图片上传完成后，后台任务（FastAPI `BackgroundTasks`）立即预生成缩略图，首次访问直接命中缓存
- **删除时清理**：硬删除单个文件、清空回收站、定时清理过期文件时，均自动删除对应缩略图缓存（`_delete_thumb_cache(fid)`）
- **生成并发限流**：`_THUMB_SEM = Semaphore(cpu-1)`（`files.py`）——同时只允许 `cpu-1` 个缩略图在生成（2C 机 = 1），批量上传时不会让 Pillow 把 CPU 打满拖垮整机

**磁盘占用估算：** 单张图片缓存约 10–50 KB（tiny ~1 KB + card ~10–40 KB），1000 张图片约 10–50 MB。

#### 2.9.3 Blur-up 渐进式加载

前端卡片双层叠放：

1. `fc-thumb-tiny`（z-index 1）：`?size=tiny` 图片 + CSS `blur(10px) scale(1.15)`，进入视口即加载
2. `fc-thumb-full`（z-index 2）：`?size=card` 图片，初始 `opacity: 0`，`load` 事件后 0.4s 淡入

**跨页导航不重播动画：** `thumbLoadedIds`（模块级 `reactive(new Set())`，`useThumbCache.js`）记录 card 尺寸已加载的文件 id，SPA 内跨页导航回文件库/总览/项目卡时 `fc-loaded` 类直接存在，无淡入动画。

#### 2.9.4 IntersectionObserver 懒加载

`vLazySrc` 本地指令（`Files/index.vue`）：只有当卡片进入视口 250px 范围内才设置 `img.src`，避免进入大文件夹时同时发出数十个请求打满浏览器连接池（HTTP/1.1 每域名 6 个）。

#### 2.9.5 缩略图加载并发限流

懒加载只控制「进视口才请求」，但一屏内仍可能同时进入几十张卡片。`useThumbCache.js` 的 `getThumb`/`getThumbUrl` 经 `@/utils/concurrency` 的 `pLimit(THUMB_CONCURRENCY=6)` 限流——与批量上传共用同一限流器实现，把同时在途的 `/thumb` 请求压在 6 个内，尾部不再超时。详见 [`../ops/performance.md`](../ops/performance.md) 十三节。

#### 2.9.6 缓存层汇总

| 位置 | 持久范围 | 说明 |
|------|---------|------|
| 后端磁盘（`.thumbs/`） | 永久 | 生成后即写磁盘，文件删除时同步清理 |
| 浏览器 HTTP 缓存 | 最多 24h | `Cache-Control: private, max-age=86400`，由浏览器管理 |
| 前端 blob Map（`useThumbCache.js`） | SPA 生命周期 | 模块级 `Map`，切换路由不丢失；`URL.createObjectURL` blob URL，无重复网络请求；并发去重（pending Map） |
| `thumbLoadedIds`（`useThumbCache.js`） | SPA 生命周期 | 模块级 `reactive(new Set())`，记录 card 已加载 id，导航回来直接应用 `fc-loaded`，无重播淡入 |
| `filesCache` sessionStorage | 页面会话 | 文件列表持久化到 `sessionStorage`，刷新页面后总览文件卡第一帧即可渲染 |

### 2.10 存储↔DB 对账与修复（Admin · 数据库）

**以物理存储为准**核对 DB 记录与磁盘/OSS 对象，修复两者不一致。起因：DB 在两台服务器间迁移、两边 `uploads/` 都有文件，配置一改两边数据就串了。

#### 2.10.1 两类不一致

| 类型 | 定义 | 修复 |
|------|------|------|
| 幽灵（ghost） | DB 有 `files` 行，但 `storage_key` 指向的物理对象不存在 | 暂只报告（删 DB 行风险高，留人工判断） |
| 孤儿（orphan） | 物理对象存在，但没有任何 `files` 行引用 | `delete`（删物理文件）或 `import`（重建 DB 记录） |

内部 key 不计入孤儿：`.agent/`、`.chat_staging`、`.thumbs/`、`_thumb`、`.thumbcache`、`avatars/`（`_is_internal_key`，`backend/app/api/v1/config.py`）。

**待核实/已知潜在缺口**：语音暂存用的 `.voice/` 子目录**不在**这份内部 key 白名单里（当前列表只覆盖 `.chat_staging`）。理论上语音条暂存文件如果凑巧被对账工具扫到，可能被误判为"孤儿"。是否已有其他机制规避（比如语音条留存周期短、TTL 内不会被扫到等）待核实，未来加固建议把 `.voice/` 一并加进 `_is_internal_key`。

#### 2.10.2 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/config/reconcile-storage` | **只读**对账，返回 `db_file_rows / storage_objects / matched / ghost_count / orphan_count` + 幽灵/孤儿明细（各截断 300 条，`truncated` 标记） |
| `POST` | `/admin/config/reconcile-storage/repair` | **写**修复，body `{action: "delete"\|"import", keys: [...]}`，返回 `{action, done, failed, done_keys}`（逐 key try/except，单条失败不中断） |

- **`import` 反推规则**：从 `storage_key` 拆 `{uid}/空间/...` → 校验 user 存在 → `项目文件` 段按 `#{id}` 取 `project_id`、`个人文件` 段按文件夹名匹配 `folder_id` → 回填 `File` 行（`size_bytes` 取实际字节、`mime_type` 用 `mimetypes` 猜）
- 依赖存储后端的 `list_keys()`（枚举）与 `exists()`（核对），见 §2.4.2
- Admin → 系统配置 → 数据库 有「存储对账」按钮：出报告 + 每条孤儿「导入/删除」+ 批量

### 2.11 禁止使用的字符

项目名、文件夹名、文件名均不允许：`\ / : * ? " < > |`

### 2.12 OSS 预签名直传

#### 2.12.1 设计背景

普通上传路径：浏览器 → FastAPI → OSS（文件经过服务器两次），消耗服务器带宽。OSS 直传路径：浏览器先向服务器要一个预签名 URL，然后直接 PUT 到 OSS 边缘节点，服务器只参与签发 URL 和注册 DB 记录，带宽消耗降为零。

#### 2.12.2 适配逻辑

| 后端 | 上传路径 | 触发条件 |
|------|---------|---------|
| `local` | 浏览器 → `POST /files`（服务器代理）| `storage.backend != 'oss'` |
| `oss`   | 浏览器 → `/files/presign` → 直传 OSS → `/files/confirm` | `storage.backend == 'oss'` |

Admin 切换后端后，下一次上传立即走对应路径，无需重启、无需前端改动。

#### 2.12.3 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/v1/files/presign` | 计算 storage_key、检查配额；OSS 返回 `{ mode:'oss', upload_url, storage_key, final_name, ext }`，本地返回 `{ mode:'proxy' }` |
| `POST` | `/api/v1/files/confirm` | 直传完成后注册 DB 记录；校验 key 归属（`storage_key` 必须以 `{user_id}/` 开头）+ 验证 OSS 对象存在 |

**`/presign` 请求体：**

```json
{
  "filename": "design.psd",
  "size_bytes": 8500000,
  "mime_type": "image/vnd.adobe.photoshop",
  "space": "project",
  "project_id": 12,
  "folder_id": null,
  "stage_name": "执行"
}
```

**`/confirm` 请求体：**

```json
{
  "storage_key": "uuid/项目文件/2026/06/设计稿 #12/design.PSD",
  "display_name": "design",
  "ext": "PSD",
  "mime_type": "image/vnd.adobe.photoshop",
  "size_bytes": 8500000,
  "space": "project",
  "project_id": 12,
  "folder_id": null,
  "stage_name": "执行"
}
```

#### 2.12.4 安全校验

- `storage_key` 必须以当前登录用户的 ID 开头，否则 403（防跨用户伪造）
- OSS 对象必须实际存在（`storage.exists(key)`），否则 400（防 confirm 注入不存在的文件记录）
- 配额检查在 `/presign` 阶段完成，超出配额直接 400，不签发 URL

#### 2.12.5 前端实现

`frontend/src/services/api.js`：
- `filesApi.presign(data)` — 调 `POST /files/presign`
- `filesApi.confirm(data)` — 调 `POST /files/confirm`
- `uploadDirectWithProgress(url, file, onProgress)` — 原生 XHR PUT 到预签名 URL，无 Authorization 头（预签名 URL 自带鉴权），支持进度回调

`UploadModal.vue` 上传循环：先调 `/presign` 查后端类型，`mode === 'oss'` 走直传（进度 0→95%）+ confirm（95%→100%），否则走原有代理上传。

### 2.13 聊天附件暂存（`backend/app/core/chat_attach.py`）

#### 2.13.1 定位

用户在对话里发给咕咕的文件**先暂存，不进文件库**。咕咕能"看"（文本类读内容注入上下文；图片走 vision 模型），能"存"（用户明确要求时，`save_uploaded_file` 工具把暂存字节**复制**成正式文件库记录——是新建一条 File 记录 + 新的 storage 对象，不是把暂存文件原地转正/改名移动）。

#### 2.13.2 存储与元数据

- 字节走 `StorageBackend`，key 格式固定为 `{user_id}/{subdir}/{attach_id}.{ext}`，扁平结构不再分层。
  - 普通附件：`subdir=".chat_staging"`，TTL 7 天
  - 语音条：`subdir=".voice"`（独立子目录，非 `.chat_staging`），TTL 同为 7 天（`TTL_VOICE` 常量名不同但取值相同）
- 元数据走 Redis，key 为 `chatfile:{user_id}:{attach_id}`，随字节写入同时 `SET ... EX <ttl>`，过期自动失效（字节和元数据各自独立过期，无强一致保证）。
- `stage()` / `stage_sync()`（供 IM 网关同步上下文调用）两套实现并存；语音条对应 `stage_voice()` / `stage_voice_sync()`。

#### 2.13.3 附件类型与"能力门控"

按扩展名分类（`_kind()`）：`image` / `audio` / `video` / `text`（含 PDF/Office，走 `doctext` 提取）/ `binary`。是否能真正"喂给模型看/听"取决于当前激活模型的能力：

- **看图**：`ai.vision=True` 时才把图片编码成 vision 内容块；未开启则退化为"当普通文件"处理，不跟用户说"看不了图"（体验考虑）。
- **听音视频**：仅 mimo 系模型 + OpenAI 兼容格式路径支持原生 `input_audio`/`video_url` 扩展块；否则退回"配置了独立语音识别模型就转写，没配就说明局限"。
- 图片过大/尺寸过大时自动降采样重编码（`_fit_image_for_vision`，长边压到 2048px，体积压到约 4.5MB 内），不再直接因超限丢弃。

#### 2.13.4 附件 ID 容错解析（`resolve_attach`）

LLM 经常把 16 位 hex 的 `attach_id` 抄错/截断，`resolve_attach` 按"精确命中 → 前缀/子串唯一命中 → 无歧义时退到最近上传的一个"逐级容错。会先按当前 IM 渠道（`imctx`，qq/feishu/wechat/web）收窄候选，避免跨渠道甚至跨对话的旧附件被误当成这次要存的文件；候选类型不一致（比如同时有图片和语音）时不再瞎猜最新的，而是把候选列表返回给调用方，要求模型明确指定——这是踩过真实事故坑后加的（连发图片后跟一句语音，防抖拆轮导致图片 ID 没跟上，误把语音存成了图片）。

---

*待核实：`.voice/` 未计入 `_is_internal_key` 白名单是否会导致对账工具误报孤儿，需要实测或补充豁免规则确认。*

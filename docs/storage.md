# 文件存储结构规范

> 更新：2026-06-24
> 项目：咕咕 / gugugu.site

---

## 一、空间划分

| 空间 | 说明 | 开发状态 |
|------|------|---------|
| 个人文件 | 用户自由上传，支持自建文件夹无限嵌套 | ✅ 已完成 |
| 项目文件 | 关联项目，按年/月/项目/用户文件夹分层 | ✅ 已完成 |
| 回收站 | 软删除文件，30 天自动清理 | ✅ 已完成 |
| 思维画布 | 附件存储 | 🔜 预留 |
| 素材板 | 素材管理 | 🔜 预留 |

---

## 二、磁盘目录结构

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
    └── trash/
        └── {file_id}/
            └── 原文件名.ext   ← 软删除时移入，30 天后自动永久删除
```

**用户隔离：** 回收站路径包含 `{user_id}/`，不同用户的回收站完全隔离。`/uploads/` 目录不对外静态暴露，所有访问必须经后端鉴权接口（`/files/{id}/download` 等）。

**年月来源：** 优先用项目 `start_date`，fallback 到 `created_at`（`_proj_date()` 工具函数，`backend/app/api/v1/projects.py`）。

**项目目录带 `#{id}` 的原因：** 项目改名时目录同步重命名，`#{id}` 不变，未来桌面客户端可通过 ID 定位关联，不依赖名称匹配。

---

## 三、数据库表

### 3.1 `files` 表

```sql
CREATE TABLE files (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(300) NOT NULL,
    ext          VARCHAR(20)  NOT NULL,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    folder_id    INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    stage_name   VARCHAR(100) NOT NULL DEFAULT '',  -- 标签字段，非导航层级
    storage_key  VARCHAR(500) NOT NULL,
    size         VARCHAR(50)  NOT NULL DEFAULT '',
    size_bytes   BIGINT       NOT NULL DEFAULT 0,
    mime_type    VARCHAR(200),
    deleted_at   TIMESTAMP NULL,                    -- 软删除时间戳
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
```

| 字段 | 说明 |
|------|------|
| `project_id` | NULL = 个人文件；有值 = 项目文件 |
| `folder_id` | NULL = 当前空间根目录；有值 = 所在用户文件夹 |
| `stage_name` | 文件标签，不作为导航层级，可选填 |
| `storage_key` | 相对于 `UPLOAD_DIR` 的路径，OSS 迁移时直接用作 object key |
| `deleted_at` | 非 NULL 表示已移入回收站 |

### 3.2 `folders` 表

```sql
CREATE TABLE folders (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = 个人文件夹
    parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,   -- NULL = 根目录，自引用支持无限嵌套
    name       VARCHAR(300) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

- `project_id = NULL`：个人文件夹
- `parent_id = NULL`：该空间根目录下的文件夹
- 删除文件夹时级联删除所有子文件夹，文件的 `folder_id` SET NULL

### 3.3 自动迁移

`session.py` 的 `create_all_tables()` 执行后自动跑 `_MIGRATIONS` 列表里的 `ALTER TABLE`，新增 nullable 列时加到此列表即可，无需手动执行 SQL。

```python
_MIGRATIONS = [
    "ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP NULL",
    # 新增列在此追加
]
```

---

## 四、API 接口

### 4.1 Files

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/files` | 列出文件（支持过滤） |
| `GET` | `/files/all` | 当前用户所有文件元数据（前端全量缓存用） |
| `POST` | `/files` | 上传文件 |
| `PATCH` | `/files/{id}` | 重命名 / 移动文件 |
| `DELETE` | `/files/{id}` | 软删除（移入回收站） |
| `POST` | `/files/batch-delete` | 批量软删除 |
| `POST` | `/files/{id}/copy` | 复制文件到指定目录 |
| `GET` | `/files/{id}/download` | 下载（Bearer token 鉴权） |
| `GET` | `/files/{id}/preview-pdf` | Office → PDF 转换预览（LibreOffice headless） |
| `GET` | `/files/{id}/stream` | 视频流 URL |
| `GET` | `/files/{id}/thumb` | 图片缩略图（`?size=tiny` 20×20 JPEG，`?size=card` 192×192 JPEG，`?size=full` 原图；后端磁盘缓存，Authorization Bearer 鉴权） |

**`GET /files` Query 参数：**

| 参数 | 说明 |
|------|------|
| `project_id` | 过滤指定项目（省略则返回个人文件） |
| `folder_id` | 过滤指定文件夹（省略则返回根目录文件） |
| `include_deleted` | 回收站模式 |

### 4.2 Folders

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/folders` | 列出文件夹 |
| `GET` | `/folders/all` | 当前用户所有文件夹（前端全量缓存用） |
| `POST` | `/folders` | 新建文件夹 |
| `PATCH` | `/folders/{id}` | 重命名 |
| `DELETE` | `/folders/{id}` | 删除（级联删除子文件夹，文件 SET NULL） |
| `GET` | `/folders/{id}/download-zip` | 打包下载文件夹 |

**`GET /folders` Query 参数：**

| 参数 | 说明 |
|------|------|
| `project_id` | 省略 = 个人文件夹；有值 = 项目文件夹 |
| `parent_id` | 省略 = 只返回根目录文件夹（`parent_id IS NULL`） |

### 4.3 Trash

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/trash` | 列出回收站文件 |
| `POST` | `/trash/{id}/restore` | 恢复单个文件 |
| `POST` | `/trash/batch-restore` | 批量恢复 |
| `DELETE` | `/trash/{id}` | 永久删除单个文件 |
| `DELETE` | `/trash/empty` | 清空回收站 |

后端 lifespan 启动定时清理任务，每小时检查一次，自动永久删除 `deleted_at` 超过 30 天的文件。

---

## 五、存储后端抽象层

### 5.1 设计目标

- 开发期用本地磁盘，上线后切换 OSS，**只改配置，不改业务代码**
- Admin 面板实时切换，无需重启服务
- `storage_key` 对两种后端完全一致，DB 不变

### 5.2 接口定义

```python
class StorageBackend(ABC):
    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def delete(self, key: str) -> None: ...
    async def rename_file(self, old_key: str, new_key: str) -> None: ...
    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None: ...
    def public_url(self, key: str) -> str: ...
    def fetch_url(self, key: str) -> str | None: ...     # 第三方可直接 HTTP 抓取的临时 URL（QQ 富媒体用），本地存储返回 None
    async def exists(self, key: str) -> bool: ...         # 物理对象是否存在（对账用）
    async def list_keys(self) -> list[str]: ...           # 枚举所有对象 key（对账用；Local 走 rglob，OSS 走 ObjectIterator）
```

`OSSStorageBackend` 额外提供（本地后端无此方法，presign 端点在返回 `mode:proxy` 前不调用）：

```python
def presign_put(self, key: str, mime_type: str | None = None, expires: int = 600) -> str:
    """返回有效期 expires 秒的 presigned PUT URL，供浏览器绕过服务器直传 OSS。"""
```

### 5.3 工厂函数

```python
def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
```

### 5.4 OSS 切换与迁移注意

**配置项**（Admin → 存储，落到 `settings.storage`）：`backend`（`local` | `oss`）、`oss_access_key_id` / `oss_access_key_secret` / `oss_bucket` / `oss_endpoint` / `oss_prefix`。OSS 凭据即使 `backend=local` 也会保存在 settings 里，方便切换前先验证。

**切换即时生效**：`get_storage()` 每次请求重读 settings，把 `backend` 改成 `oss` 后**下一请求**就走 OSS，无需重启。

**⚠️ 现有本地文件不自动迁移**：`files.storage_key` 是相对路径（如 `{uid}/项目文件/…/x.png`），本地与 OSS **共用同一套 key**。切到 OSS 后，老文件的 key 在 OSS 上并不存在 → 读取/缩略图会 404（`get_thumb` 等已改为缺文件返回 404、不再 500）。**平滑切换需先把 `uploads/` 全量同步到 OSS 同名 key**（`StorageBackend.list_keys()` 可枚举：Local 走 `rglob`、OSS 走 `ObjectIterator`，对账工具即基于此）。

**Endpoint 协议**：`oss_endpoint` 不带协议时 oss2 默认 `http://`，签名 URL（`fetch_url`，QQ 抓媒体用）也是 http。需要 https 就把 endpoint 配成 `https://oss-cn-…aliyuncs.com`。

**冒烟验证**：可直接实例化 `OSSStorageBackend(get_settings().storage)` 跑 `put → exists → get → fetch_url → rename_file → delete` 往返（用 `.smoketest/` 前缀的临时 key，跑完清理），确认凭据/连通正常，不必先切活跃 backend。

---

## 六、项目重命名联动

`PATCH /projects/{id}` 修改 `name` 时：

1. 读出旧项目名，构造旧目录前缀 `{uid}/项目文件/{year}/{month}/{旧名} #{id}/`
2. `get_storage().rename_dir(old_prefix, new_prefix)` 重命名磁盘目录
3. 批量替换 `files.storage_key` 前缀
4. 更新 `projects.name`

---

## 七、同名文件冲突处理

同一目录下已存在同名文件时，追加 `(n)`：

```
需求文档.pdf → 需求文档(1).pdf → 需求文档(2).pdf
```

`display_name` 字段同步更新。

---

## 八、前端文件缓存策略 ✅

### 8.1 目标

消除文件库导航时的"白屏/加载"感，使文件夹切换、返回上级的体验接近本地应用。

### 8.2 方案：全量元数据缓存 + 乐观更新

进入文件库时一次性拉取当前用户所有文件和文件夹的**元数据**（不含文件内容/Blob），构建内存索引，所有导航为纯内存查找，写操作先更新本地缓存再后台同步服务端。

**数据量评估：** 单条文件元数据约 300–600 字节，10,000 个文件约 5 MB，对浏览器无压力。

### 8.3 后端接口

```
GET /files/all    → 当前用户所有未删除文件元数据（FileResponse[]）
GET /folders/all  → 当前用户所有文件夹（FolderResponse[]）
```

### 8.4 前端内存索引（`src/stores/filesCache.js`）

Computed Map 双索引，O(1) 查找：

```js
// files: 'personal' | 'proj:{id}' | folderId(int) → File[]
const _fileIdx = computed(() => { ... })
// folders: 'personal' | 'proj:{id}' | 'sub:{parentId}' → Folder[]
const _folderIdx = computed(() => { ... })
```

### 8.5 乐观更新 + 服务端验证

| 操作 | 本地先做 | 失败时 |
|------|---------|--------|
| 上传文件 | 加入缓存 | 无需回滚（服务端若失败则文件本就不存在） |
| 删除文件 | 从缓存移除 | 放回 + 报错 |
| 重命名 | 直接改名称 | 还原 + 报错 |
| 新建文件夹 | 插入临时负数 ID 条目 | 移除临时条目 + 报错 |
| 剪切粘贴 | 更新 folderId/projectId | 还原 + 报错 |

### 8.6 缓存失效策略

- **主动失效**：写操作后局部更新索引（addFile/removeFile/updateFile 等乐观更新接口）
- **版本校验**：Tab 切回（`visibilitychange` 事件）时调 `GET /files/version`，返回 `count:max_updated:max_deleted` 摘要；与上次版本不一致则静默重拉全量数据
- **本地文件删除检测**：`GET /files/all` 在 LocalStorageBackend 下扫描每个文件实体是否存在；不存在的直接硬删数据库记录（不进回收站），确保 UI 与文件系统一致
- 多标签/多设备场景由版本校验覆盖，无需 WebSocket

### 8.7 加载体验优化

- **内容过渡动画**：导航切换时 `content-fade` 淡出（40ms）+ 淡入（120ms），`mode="out-in"` 避免双层叠放
- **热缓存同步初始化**：`onMounted` 检测 `cacheStore.loaded && projectStore.projects.length > 0` 时同步调 `restoreNav() + loadContents()`，跳过 `await`，SPA 内导航回文件库无空帧闪烁
- **tiny blob 全局预热**：任何页面获取文件列表后调 `preloadTinyThumbs(files)`，后台静默 fetch 所有图片的 tiny blob（已缓存则跳过），跨页面共享，实现渐进式加载
- **项目编辑卡文件预填**：打开项目时先从 `filesCacheStore` 同步填充文件/文件夹列表，API 刷新后覆盖，消除等待期间文件区域为空的问题
- 回收站仍走异步请求（需要 `deleted_at` 字段，不在主缓存中）

---

## 九、图片缩略图

### 9.1 接口

```
GET /files/{id}/thumb?size=full|tiny|card
Authorization: Bearer <user_token>
```

| size | 说明 |
|------|------|
| `full`（默认）| 返回原始图片文件 |
| `tiny` | 20×20px JPEG（约 1 KB），用于 blur-up 模糊占位 |
| `card` | 192×192px JPEG（约 10–40 KB），网格卡片显示用 |

- 鉴权：`Authorization: Bearer` 请求头（URL 不含 token，HTTP 缓存 key 稳定）
- 响应头：`Cache-Control: private, max-age=86400`（浏览器缓存 24 小时）
- SVG 跳过 Pillow，`size=full` 直接返回原文件

支持格式：JPEG / PNG / GIF / WEBP / AVIF / BMP / HEIC / HEIF / SVG。

### 9.2 后端磁盘缓存

生成的缩略图持久化到 `uploads/.thumbs/{fid}_{size}.jpg`。请求到来时优先命中缓存，跳过 Pillow，响应时间从数百毫秒降至毫秒级。

**生成策略：**

- **一次生成两个尺寸**：无论请求 `tiny` 还是 `card`，均读取一次原图，同时生成并缓存 tiny + card，避免重复 I/O
- **上传时预生成**：图片上传完成后，后台任务（FastAPI `BackgroundTasks`）立即预生成缩略图，首次访问直接命中缓存
- **删除时清理**：硬删除单个文件、清空回收站、定时清理过期文件时，均自动删除对应缩略图缓存（`_delete_thumb_cache(fid)`）

**磁盘占用估算：** 单张图片缓存约 10–50 KB（tiny ~1 KB + card ~10–40 KB），1000 张图片约 10–50 MB。

### 9.3 Blur-up 渐进式加载

前端卡片双层叠放：

1. `fc-thumb-tiny`（z-index 1）：`?size=tiny` 图片 + CSS `blur(10px) scale(1.15)`，进入视口即加载
2. `fc-thumb-full`（z-index 2）：`?size=card` 图片，初始 `opacity: 0`，`load` 事件后 0.4s 淡入

**跨页导航不重播动画：** `thumbLoadedIds`（模块级 `reactive(new Set())`，`useThumbCache.js`）记录 card 尺寸已加载的文件 id，SPA 内跨页导航回文件库/总览/项目卡时 `fc-loaded` 类直接存在，无淡入动画。

### 9.4 IntersectionObserver 懒加载

`vLazySrc` 本地指令（`Files/index.vue`）：只有当卡片进入视口 250px 范围内才设置 `img.src`，避免进入大文件夹时同时发出数十个请求打满浏览器连接池（HTTP/1.1 每域名 6 个）。

### 9.5 缓存层汇总

| 位置 | 持久范围 | 说明 |
|------|---------|------|
| 后端磁盘（`.thumbs/`） | 永久 | 生成后即写磁盘，文件删除时同步清理 |
| 浏览器 HTTP 缓存 | 最多 24h | `Cache-Control: private, max-age=86400`，由浏览器管理 |
| 前端 blob Map（`useThumbCache.js`） | SPA 生命周期 | 模块级 `Map`，切换路由不丢失；`URL.createObjectURL` blob URL，无重复网络请求；并发去重（pending Map） |
| `thumbLoadedIds`（`useThumbCache.js`） | SPA 生命周期 | 模块级 `reactive(new Set())`，记录 card 已加载 id，导航回来直接应用 `fc-loaded`，无重播淡入 |
| `filesCache` sessionStorage | 页面会话 | 文件列表持久化到 `sessionStorage`，刷新页面后总览文件卡第一帧即可渲染 |

---

## 十、存储↔DB 对账与修复（Admin · 数据库）

**以物理存储为准**核对 DB 记录与磁盘/OSS 对象，修复两者不一致。起因：DB 在两台服务器间迁移、两边 `uploads/` 都有文件，配置一改两边数据就串了。

### 10.1 两类不一致

| 类型 | 定义 | 修复 |
|------|------|------|
| 幽灵（ghost） | DB 有 `files` 行，但 `storage_key` 指向的物理对象不存在 | 暂只报告（删 DB 行风险高，留人工判断） |
| 孤儿（orphan） | 物理对象存在，但没有任何 `files` 行引用 | `delete`（删物理文件）或 `import`（重建 DB 记录） |

内部 key 不计入孤儿：`.agent/`、`.chat_staging`、`.thumbs/`、`_thumb`、`.thumbcache`、`avatars/`（`_is_internal_key`，`backend/app/api/v1/config.py`）。

### 10.2 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/admin/config/reconcile-storage` | **只读**对账，返回 `db_file_rows / storage_objects / matched / ghost_count / orphan_count` + 幽灵/孤儿明细 |
| `POST` | `/admin/config/reconcile-storage/repair` | **写**修复，body `{action: "delete"\|"import", keys: [...]}`，返回 `{action, done, failed, done_keys}`（逐 key try/except，单条失败不中断） |

- **`import` 反推规则**：从 `storage_key` 拆 `{uid}/空间/...` → 校验 user 存在 → `项目文件` 段按 `#{id}` 取 `project_id`、`个人文件` 段按文件夹名匹配 `folder_id` → 回填 `File` 行（`size_bytes` 取实际字节、`mime_type` 用 `mimetypes` 猜）
- 依赖存储后端的 `list_keys()`（枚举）与 `exists()`（核对），见 §5.2
- Admin → 系统配置 → 数据库 有「存储对账」按钮：出报告 + 每条孤儿「导入/删除」+ 批量

---

## 十一、项目删除与孤儿文件防护

`File.project_id` 外键是 `ON DELETE SET NULL`：直接删项目会把文件 `project_id` 抹成 `NULL`、但 `space` 仍是 `'project'`，成为「孤儿文件」。前端 `filesCache` 按「`projectId` 为空即归个人」分组，会把这些孤儿**漏进个人空间视图**（曾导致已删项目的文件出现在用户个人文件里）。

**防护**：删项目前先调 `rehome_project_files_to_personal(db, user_id, pid)`（`backend/app/api/v1/projects.py`）——把项目下文件 `space='personal'`、`project_id/folder_id/stage_name` 一并置空，干净归个人。`storage_key` 不动（物理文件仍在、仍可访问，路径里的旧项目名残留无害）。HTTP `DELETE /projects/{id}` 与 Agent `delete_project` 工具两条路都先 rehome 再删。

> 历史遗留的孤儿可用 §十 的对账工具 `import` 重建记录、或 `delete` 清理。

---

## 十三、OSS 预签名直传

### 13.1 设计背景

普通上传路径：浏览器 → FastAPI → OSS（文件经过服务器两次），消耗服务器带宽。OSS 直传路径：浏览器先向服务器要一个预签名 URL，然后直接 PUT 到 OSS 边缘节点，服务器只参与签发 URL 和注册 DB 记录，带宽消耗降为零。

### 13.2 适配逻辑

| 后端 | 上传路径 | 触发条件 |
|------|---------|---------|
| `local` | 浏览器 → `POST /files`（服务器代理）| `storage.backend != 'oss'` |
| `oss`   | 浏览器 → `/files/presign` → 直传 OSS → `/files/confirm` | `storage.backend == 'oss'` |

Admin 切换后端后，下一次上传立即走对应路径，无需重启、无需前端改动。

### 13.3 新增端点

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

### 13.4 安全校验

- `storage_key` 必须以当前登录用户的 UUID 开头，否则 403（防跨用户伪造）
- OSS 对象必须实际存在（`storage.exists(key)`），否则 400（防 confirm 注入不存在的文件记录）
- 配额检查在 `/presign` 阶段完成，超出配额直接 400，不签发 URL

### 13.5 前端实现

`frontend/src/services/api.js`：
- `filesApi.presign(data)` — 调 `POST /files/presign`
- `filesApi.confirm(data)` — 调 `POST /files/confirm`
- `uploadDirectWithProgress(url, file, onProgress)` — 原生 XHR PUT 到预签名 URL，无 Authorization 头（预签名 URL 自带鉴权），支持进度回调

`UploadModal.vue` 上传循环：先调 `/presign` 查后端类型，`mode === 'oss'` 走直传（进度 0→95%）+ confirm（95%→100%），否则走原有代理上传。

## 十二、禁止使用的字符

项目名、文件夹名、文件名均不允许：`\ / : * ? " < > |`

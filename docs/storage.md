# 文件存储结构规范（方案 A）

> 更新：2026-06-17
> 项目：PM Studio / gugugu.site

---

## 一、空间划分

PM Studio 有四个独立的文件空间，每个空间有各自的目录和 DB 关联：

| 空间 | `space` 值 | 目录前缀 | 开发状态 |
|------|-----------|---------|---------|
| 项目文件 | `project` | `{项目名} #{id}/` | ✅ 当前开发 |
| 思维画布 | `mind` | `思维/{画布名} #{id}/` | 🔜 预留 |
| 素材板 | `asset` | `素材板/` | 🔜 预留 |
| 个人文件 | `personal` | `个人文件/` | ✅ 当前开发 |

---

## 二、磁盘目录结构

### 2.1 完整结构

```
uploads/
└── {user_id}/
    ├── {项目名} #{project_id}/      ← 项目空间
    │   ├── {阶段名}/
    │   │   └── 原始文件名.ext
    │   └── 原始文件名.ext           ← 归属项目但未指定阶段
    ├── 思维/                        ← 思维空间（预留）
    │   └── {画布名} #{mind_map_id}/
    │       └── 附件.ext
    ├── 素材板/                      ← 素材板空间（预留）
    │   └── 素材.ext
    └── 个人文件/                    ← 个人文件空间
        └── 原始文件名.ext
```

### 2.2 示例

```
uploads/
└── 1/
    ├── NB品牌设计 #3/
    │   ├── 企划阶段/
    │   │   ├── 需求文档.pdf
    │   │   └── 封面图.png
    │   └── 执行阶段/
    │       └── 分镜稿.pdf
    ├── 动画制作 #7/
    │   └── 脚本初稿.docx
    ├── 思维/
    │   └── 产品规划 #1/
    │       └── 流程图参考.png
    ├── 素材板/
    │   └── 风格参考.jpg
    └── 个人文件/
        └── 合同扫描.pdf
```

### 2.3 命名规则

| 层级 | 格式 | 示例 |
|------|------|------|
| 用户目录 | `{user_id}/` | `1/` |
| 项目目录 | `{项目名} #{project_id}/` | `NB品牌设计 #3/` |
| 阶段目录 | `{阶段名}/`（原样，无 ID） | `企划阶段/` |
| 思维目录 | `思维/{画布名} #{mind_map_id}/` | `思维/产品规划 #1/` |
| 素材板目录 | `素材板/` | `素材板/` |
| 个人文件目录 | `个人文件/` | `个人文件/` |
| 文件名 | 上传时的原始文件名 | `需求文档.pdf` |

**项目目录带 `#{id}` 的原因：**
- 客户打开文件夹可直接识别项目名
- 桌面客户端同步时通过 `#{id}` 定位 DB 对应项目，不依赖名称匹配
- 项目改名时目录同步重命名，`#{id}` 不变，桌面客户端不丢失关联

**阶段目录不带 ID：**
- 阶段名在项目内唯一，无需 ID 区分
- 更简洁，客户看到纯粹的阶段名

---

## 三、数据库表设计

### 3.1 变更概览（对比旧版本）

| 变更 | 说明 |
|------|------|
| 删除 `file_versions` 表 | 版本管理已从 UI 移除 |
| 删除 `folders` 表 | 自定义文件夹废弃，改为空间/项目/阶段结构 |
| 修改 `files` 表 | 见下方 |
| 新增 `mind_maps` 表 | 思维画布元数据，暂不开发，预留结构 |

### 3.2 新 `files` 表

```sql
CREATE TABLE files (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(300) NOT NULL,
    ext          VARCHAR(20)  NOT NULL,
    space        VARCHAR(20)  NOT NULL DEFAULT 'personal',
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    stage_name   VARCHAR(100) NOT NULL DEFAULT '',
    mind_map_id  INTEGER REFERENCES mind_maps(id) ON DELETE SET NULL,
    storage_key  VARCHAR(500) NOT NULL,
    size         VARCHAR(50)  NOT NULL DEFAULT '',
    size_bytes   BIGINT       NOT NULL DEFAULT 0,
    mime_type    VARCHAR(200),
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);
```

#### 字段说明

| 字段 | 说明 | 示例 |
|------|------|------|
| `space` | 所属空间：`project` \| `mind` \| `asset` \| `personal` | `project` |
| `project_id` | space=project 时必填；其余空间为 NULL | `3` |
| `stage_name` | space=project 时可填；空字符串表示未指定阶段 | `企划阶段` |
| `mind_map_id` | space=mind 时必填；其余空间为 NULL | `1` |
| `storage_key` | 相对于 UPLOAD_DIR 的路径，OSS 迁移时直接用作 object key | `1/NB品牌设计 #3/企划阶段/需求文档.pdf` |
| `size` | 格式化显示用 | `1.2 MB` |
| `size_bytes` | 精确字节数 | `1258291` |

#### storage_key 构造规则

```
project + 有阶段：  {uid}/{项目名} #{pid}/{stage_name}/{name}.{ext}
project + 无阶段：  {uid}/{项目名} #{pid}/{name}.{ext}
mind：              {uid}/思维/{画布名} #{mid}/{name}.{ext}
asset：             {uid}/素材板/{name}.{ext}
personal：          {uid}/个人文件/{name}.{ext}
```

#### 同名文件冲突处理

同一目录下若已存在同名文件，追加 `(n)`：
```
需求文档.pdf → 需求文档(1).pdf → 需求文档(2).pdf
```
`display_name` 字段同步更新。

### 3.3 `mind_maps` 表（预留，暂不开发）

```sql
CREATE TABLE mind_maps (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(300) NOT NULL,
    project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    data_json   TEXT NOT NULL DEFAULT '{}',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### 3.4 `assets` 表（预留，暂不开发）

```sql
CREATE TABLE assets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tags_json   TEXT NOT NULL DEFAULT '[]',
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);
```

---

## 四、API 接口设计

### 4.1 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/files` | 列出文件（支持过滤） |
| `GET` | `/files/tree` | 按项目/阶段返回树形结构 |
| `POST` | `/files` | 上传文件 |
| `DELETE` | `/files/{id}` | 删除文件（含磁盘） |
| `PATCH` | `/files/{id}` | 重命名/移动文件 |

**废弃接口：**
- `POST /files/{id}/versions` — 删除
- `GET/POST/PATCH/DELETE /folders/*` — 删除

### 4.2 `GET /files`

**Query 参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `space` | str | `project` \| `mind` \| `asset` \| `personal` |
| `project_id` | int | 过滤指定项目（space=project 时） |
| `stage_name` | str | 过滤指定阶段 |
| `mind_map_id` | int | 过滤指定画布（space=mind 时） |
| `ext` | str | 过滤扩展名 |
| `q` | str | 搜索文件名 |

**Response：`FileResponse[]`**

```json
[
  {
    "id": 5,
    "displayName": "需求文档",
    "ext": "PDF",
    "space": "project",
    "projectId": 3,
    "projectName": "NB品牌设计",
    "projectColor": "#7b7fb2",
    "stageName": "企划阶段",
    "size": "1.2 MB",
    "createdAt": "2026-06-17"
  }
]
```

> `projectName`、`projectColor` 通过 JOIN projects 实时查询，不在 files 表冗余存储。

### 4.3 `GET /files/tree`

返回项目空间的树形结构，供文件库导航。

**Response：**

```json
{
  "projects": [
    {
      "id": 3,
      "name": "NB品牌设计",
      "color": "#7b7fb2",
      "stages": [
        { "name": "企划阶段", "count": 2 },
        { "name": "执行阶段", "count": 1 }
      ],
      "unstagedCount": 0,
      "totalCount": 3
    }
  ],
  "personalCount": 1
}
```

### 4.4 `POST /files`

**Form data：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `file` | File | 文件二进制 |
| `space` | str | 默认 `personal` |
| `project_id` | int? | space=project 时填写 |
| `stage_name` | str? | space=project 时可选 |
| `mind_map_id` | int? | space=mind 时填写 |

**上传流程：**
1. 解析文件名 → `display_name` + `ext`
2. 按 `space` 和关联 ID 构造目标目录
3. 检查同名冲突，必要时追加 `(n)`
4. 构造 `storage_key`
5. 通过 `get_storage().put(key, data)` 写入
6. 写入 `files` 表
7. 返回 `FileResponse`

### 4.5 `DELETE /files/{id}`

1. 校验所有权
2. `await get_storage().delete(file.storage_key)`
3. 删除 DB 记录
4. 返回 204

### 4.6 `PATCH /files/{id}`

重命名或移动文件（改阶段/改项目），需同步移动磁盘文件。

**Body：**
```json
{
  "displayName": "新文件名",
  "stageName": "执行阶段"
}
```

**流程：**
1. 构造新 `storage_key`
2. `await get_storage().rename_file(old_key, new_key)`
3. 更新 DB

---

## 五、项目重命名联动

`PATCH /projects/{id}` 修改 `name` 时：

1. 读出旧项目名
2. 通过 `get_storage().rename_dir(old_prefix, new_prefix)` 重命名目录
3. 批量更新 `files.storage_key`（字符串前缀替换）
4. 更新 `projects.name`

```
旧目录：1/NB品牌设计 #3/
新目录：1/新名称 #3/
```

---

## 六、存储后端抽象层

### 6.1 设计目标

- 开发期用本地磁盘，上线后切换 OSS，**只改配置，不改业务代码**
- 后台管理页面实时切换，无需重启服务
- `storage_key` 对两种后端完全一致，DB 不变

### 6.2 接口定义

```python
# app/services/storage/__init__.py

from abc import ABC, abstractmethod

class StorageBackend(ABC):

    @abstractmethod
    async def put(self, key: str, data: bytes, mime_type: str | None = None) -> None:
        """写入文件"""

    @abstractmethod
    async def get(self, key: str) -> bytes:
        """读取文件内容"""

    @abstractmethod
    async def delete(self, key: str) -> None:
        """删除文件，不存在时静默忽略"""

    @abstractmethod
    async def rename_file(self, old_key: str, new_key: str) -> None:
        """移动/重命名单个文件"""

    @abstractmethod
    async def rename_dir(self, old_prefix: str, new_prefix: str) -> None:
        """重命名目录前缀（项目改名时用）"""

    @abstractmethod
    def public_url(self, key: str) -> str:
        """返回可访问的 URL"""
```

### 6.3 本地实现

```python
class LocalStorageBackend(StorageBackend):
    def __init__(self, root: Path):
        self.root = root

    async def put(self, key, data, mime_type=None):
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    async def get(self, key):
        return (self.root / key).read_bytes()

    async def delete(self, key):
        (self.root / key).unlink(missing_ok=True)

    async def rename_file(self, old_key, new_key):
        old = self.root / old_key
        new = self.root / new_key
        new.parent.mkdir(parents=True, exist_ok=True)
        old.rename(new)

    async def rename_dir(self, old_prefix, new_prefix):
        old = self.root / old_prefix
        new = self.root / new_prefix
        if old.exists():
            old.rename(new)

    def public_url(self, key):
        return f"/uploads/{key}"
```

### 6.4 OSS 实现

```python
class OSSStorageBackend(StorageBackend):
    def __init__(self, cfg: StorageSettings):
        import oss2
        auth = oss2.Auth(cfg.oss_access_key_id, cfg.oss_access_key_secret)
        self.bucket = oss2.Bucket(auth, cfg.oss_endpoint, cfg.oss_bucket)
        self.pfx = cfg.oss_prefix  # 如 "pm-studio/"

    async def put(self, key, data, mime_type=None):
        import asyncio
        headers = {"Content-Type": mime_type} if mime_type else {}
        await asyncio.to_thread(
            self.bucket.put_object, self.pfx + key, data, headers=headers
        )

    async def get(self, key):
        import asyncio
        result = await asyncio.to_thread(self.bucket.get_object, self.pfx + key)
        return result.read()

    async def delete(self, key):
        import asyncio
        await asyncio.to_thread(self.bucket.delete_object, self.pfx + key)

    async def rename_file(self, old_key, new_key):
        import asyncio
        await asyncio.to_thread(
            self.bucket.copy_object,
            self.bucket.bucket_name, self.pfx + old_key, self.pfx + new_key
        )
        await self.delete(old_key)

    async def rename_dir(self, old_prefix, new_prefix):
        import asyncio, oss2
        objs = await asyncio.to_thread(
            list, oss2.ObjectIterator(self.bucket, prefix=self.pfx + old_prefix)
        )
        for obj in objs:
            new_key = self.pfx + new_prefix + obj.key[len(self.pfx + old_prefix):]
            await asyncio.to_thread(
                self.bucket.copy_object, self.bucket.bucket_name, obj.key, new_key
            )
            await asyncio.to_thread(self.bucket.delete_object, obj.key)

    def public_url(self, key):
        return f"https://{self.bucket.bucket_name}.{self.bucket.endpoint}/{self.pfx}{key}"
```

### 6.5 工厂函数

```python
def get_storage() -> StorageBackend:
    """每次调用重新读取 settings，Admin 切换 backend 后下一请求立即生效。"""
    cfg = get_settings()
    if cfg.storage.backend == "oss":
        return OSSStorageBackend(cfg.storage)
    return LocalStorageBackend(Path(cfg.storage.local_path))
```

### 6.6 切换流程

```
Admin 面板
  → PATCH /admin/config {"storage": {"backend": "oss", ...}}
  → save_override() 写入 config.override.json + get_settings.cache_clear()
  → 下一请求 get_storage() 返回 OSSStorageBackend
  → 新文件写 OSS，旧文件仍在本地（storage_key 不变）
```

切换不自动迁移已有文件，需手动调用：
```
POST /admin/storage/migrate
```

---

## 七、Config 配置

`StorageSettings` 新增 `oss_prefix` 字段：

```python
class StorageSettings(BaseModel):
    backend:               str = Field("local")
    local_path:            str = Field("./uploads")
    oss_access_key_id:     str = Field("")
    oss_access_key_secret: str = Field("")
    oss_bucket:            str = Field("pm-studio")
    oss_endpoint:          str = Field("oss-cn-hangzhou.aliyuncs.com")
    oss_prefix:            str = Field("", description="OSS 对象前缀，如 pm-studio/")
```

Admin 面板"存储"分组新增 OSS 连接测试：
```
POST /admin/config/test-connection  {"type": "oss"}
```
后端调 `bucket.get_bucket_info()` 验证凭证。

---

## 八、禁止使用的字符

项目名、阶段名、文件名均不允许：`\ / : * ? " < > |`

---

## 九、前端变更概览

| 模块 | 变更 |
|------|------|
| `UploadModal.vue` | 加 `space` 选择；project 空间时显示阶段下拉 |
| `Files/index.vue` | 导航改为空间/项目/阶段树，移除 `foldersApi` |
| `services/api.js` | 删除 `foldersApi`，`filesApi` 更新参数 |

---

*本文档为实现规范，重构时以此为准。*

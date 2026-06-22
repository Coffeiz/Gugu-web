# 设计清单 · Agent 工具扩展

> 状态：设计稿（属 `backend/agent/skills/` 领地，由 Agent 重构方实现）
> 前提：Phase 1 的 `skills/` 架构已就位 —— 加工具 = 加一个 `Tool` 声明 + 一个 `async handler(db, user_id, args)`，自动派生 Anthropic/OpenAI 双格式并注册，`core`/`web` 无需改动。
> 所有 handler 必须带 `user_id` 所有权校验（与现有 4 工具一致）。

## 现有工具（23，已实现）

第一~三批已全部落地：
- **项目**：`list_projects` / `create_project` / `update_project` / `update_stage` / `set_priority` / `archive_project` / `delete_project`🔒
- **日历**：`create_event` / `list_events` / `update_event` / `delete_event`🔒
- **文件**：`list_files` / `read_file` / `edit_file` / `create_document` / `rename_file` / `move_file` / `create_folder` / `delete_file`
- **客户**：`list_clients` / `create_client`
- **聚合**：`get_upcoming` / `get_dashboard_stats`

🔒 = 受删除二次确认保底保护。

---

## ⚠️ 已发现的能力缺口（待补，后端均支持）

> 实战暴露：用户让咕咕"给项目建阶段"，因**缺 `add_stage`**，旧 agent 拿 `create_project` 凑数、误建了一堆项目。说明阶段/待办、文件夹、回收站、客户改删是硬缺口。

### P0 — 挡住日常操作 ✅ 已全部实现

- ✅ **项目阶段/待办（`skills/projects.py`）**：`get_project`（完整结构）/ `add_stage` / `remove_stage` / `rename_stage` / `add_todo`（支持批量 texts）/ `remove_todo`。（`reorder_stage` 暂缓）
- ✅ **文件夹（`skills/files.py`）**：`list_folders` / `rename_folder` / `delete_folder`。
  - ⏸️ `move_folder` 暂缓：后端 `/folders` 无移动端点（PATCH 仅改 name），且移动需同步重写夹内文件物理路径，待后端先支持。
- ✅ **回收站（`skills/trash.py`）**：`list_trash` / `restore_file`（复用 `trash._restore_file_storage`）/ `permanent_delete`🔒。
- ✅ **客户（`skills/clients.py`）**：`update_client` / `delete_client`🔒。

> 实测：LLM「给项目加一个叫 X 的阶段」已正确调 `add_stage`（不再误建项目）；删除类新工具（permanent_delete / delete_client）二次确认保底生效。工具总数 → 37。

### P1 — 常用增强
- `copy_file`（后端 `/files/{id}/copy`）。
- `set_color`（项目 `color` 字段，现 `update_project` 未含）。
- `list_projects` 增按客户 / 截止区间筛选。
- 文件**按内容**搜索（现仅按文件名）。
- 客户关联项目查询（某客户名下有哪些项目）。
- `create_event` 补 `client` 字段。

### P2 / 未来（多属 Phase 2+ 或未排期）
- `save_identity`（昵称，Phase 1.6/2）、记忆类命令（`/remember` `/forget`，Phase 2）。
- 思维导图工具（`mind_maps` 表已建、`/mind` 路由预留）。
- 联网搜索（文档提过 Tavily）。
- Record 记录（日记/财务/健康，文档 30，数据模型未做）。

> 备注：删除/永久删除/客户删除等不可逆操作，新增时一律加 `destructive=True` 走 `confirm.gate`（与 `delete_project` 一致）。文件软删进回收站可恢复，不算不可逆。

---

> 以下"字段参考 / 第一~三批"为当时的设计稿，现已全部实现，保留供追溯。

## 字段参考（核实自模型）

- **Project**：`status` ∈ {pending, active, done}；`priority` ∈ {high, medium, low, null}；`current_stage` 存阶段 key；`archived` bool；`done_at`；`stages_json` 反序列化为 `stages` 属性 = `[{key, label, todos:[{id,text,done}]}]`。
- **CalendarEvent**：`title, date(YYYY-MM-DD), type∈{event,deadline}, client, project_id, description`。
- **File**：`display_name, ext, space∈{project,mind,asset,personal}, project_id, folder_id, stage_name, size_bytes, deleted_at`（查询须 `deleted_at IS NULL`）。
- **Folder**：`name, project_id, parent_id`（无限嵌套）。
- **Client**：`name, contact, email, phone, notes`。

> 注意：Project / CalendarEvent 有 `version` 乐观锁列，但现有 agent 工具直接改字段提交、**不参与 version 校验**（沿用 `_exec_tool` 现状），新工具同样不碰 version。

---

## 第一批 · 高价值低成本（最常用的口语操作）

### 1. `update_stage` —— 改当前阶段 / 勾待办  → `skills/projects.py`
口语：「把 X 项目推进到执行阶段」「X 的设计阶段标记完成」
```
参数: { project_id:int(必填),
        stage:str(阶段 key 或 label，二选一),
        todo_done:{stage:str, todo_text:str, done:bool}(可选，勾某条待办) }
```
复用：读 `p.stages`（list）→ 改 `current_stage` 或对应 todo 的 `done` → `p.stages_json = json.dumps(...)` 回写 → `updated_at`。
注意：阶段匹配支持 key 与 label 模糊匹配；联动 `progress`/末阶段自动完成的逻辑较重，**初版只做 current_stage 切换 + 单条 todo 勾选**，复杂联动留后续。

### 2. `list_events` —— 查日历事件  → `skills/calendar.py`
口语：「这周有什么安排」「下个月的截止日」
```
参数: { from:str(YYYY-MM-DD,可选), to:str(可选), type:str∈{event,deadline}(可选) }
```
复用：`select(CalendarEvent).where(user_id==, date between)`，按 date 升序。

### 3. `update_event` —— 改事件  → `skills/calendar.py`
```
参数: { event_id:int(必填), title?, date?, type?, project_id?, description? }
```
复用：取 event（校验 user_id）→ setattr 已传字段 → commit。

### 4. `delete_event` —— 删事件  → `skills/calendar.py`
```
参数: { event_id:int(必填) }
```
复用：取 event（校验 user_id）→ `db.delete` → commit。

### 5. `set_priority` —— 设项目优先级  → `skills/projects.py`
口语：「把 X 设为高优先级」
```
参数: { project_id:int(必填), priority:str∈{high,medium,low}(必填，传 "none"/"" 则清空) }
```
复用：取 project（校验 user_id）→ 设 `priority` → commit。

---

## 第二批 · 查询与归档

### 6. 文件操作（查 / 读 / 改 / 整理）  → 新建 `skills/files.py`
> 用户明确要求：咕咕要能**读取、修改、整理**文件。
> 存储层能力（`app.services.storage`）：`get(key)->bytes` 读、`put(key,data,mime)` 写、`rename_file`、`rename_dir`、`delete`。
> 复用 `app.api.v1.files` 现成模块级 helper：`_build_key`（算 storage_key 路径）、`_resolve_conflict`（重名加 (1)）、`_fmt_size`、`_safe_name`、`_move_to_trash`。移动/重命名核心逻辑见 `update_file`（446 行起），整理类工具应照其 `_build_key + rename_file` 模式，**不要自己拼路径**。
> 安全护栏：读/改仅限**文本类**（md/txt/json/csv/代码等，按 ext 或 mime 白名单），且**大小上限**（建议 ≤256KB）防止撑爆上下文；二进制（图片/视频/psd）只能查/整理，不可读改内容。

**查**
- `list_files` —— 「素材库里有哪些图」「X 项目有哪些文件」
  ```
  { space?∈{project,mind,asset,personal}, project_id?:int, ext?:str, q?:str(名称模糊), limit?:int=30 }
  ```
  复用 `select(File).where(user_id==, deleted_at IS NULL, ...)`；返回 id/display_name/ext/space/size/project_id。

**读**
- `read_file` —— 「念一下那份脚本」「X 文档写了什么」
  ```
  { file_id:int(必填) }
  ```
  取 File（校验 user_id + 文本白名单 + size_bytes 上限）→ `await get_storage().get(f.storage_key)` → decode 返回文本内容。

**改**
- `edit_file` —— 「把文档里的 A 改成 B」「在结尾加一段」
  ```
  { file_id:int(必填), mode:str∈{replace_all, find_replace, append},
    content?:str(replace_all/append 用), find?:str + replace?:str(find_replace 用) }
  ```
  读旧内容 → 按 mode 生成新文本 → `put(storage_key, 新文本.encode(), mime)` → 更新 `size_bytes/size(用 _fmt_size)/updated_at`。文本白名单同上。
- `create_document` —— 「新建一份笔记」「把分镜导成 Word」「生成本月报表 Excel」
  ```
  { name:str(必填), format:str∈{md, txt, json, csv, docx, pdf, xlsx}(默认 md),
    space∈{project,personal,...}, project_id?, folder_id?,
    content:str(咕咕生成的正文；office/pdf 用 Markdown 或 HTML 表达) }
  ```
  **两条生成路径**：
  - **文本类**（md/txt/json/csv）：直接 `content.encode()` 写入。
  - **二进制类**（docx/pdf/xlsx）：LLM 出 Markdown/HTML → 用 **LibreOffice 转换**成目标格式的二进制。复用并泛化 `files.py` 的 `_office_to_pdf`（813 行起）为 `_convert(data, src_ext, target_ext)`：
    ```
    libreoffice --headless --convert-to <target> --outdir <tmp> <src>
    ```
    —— 系统已装 `/usr/bin/libreoffice`，现有 Office→PDF 预览就用它，**零新依赖**。csv→xlsx、md/html→docx/pdf 均支持。
  - 落库：`_build_key` + `_resolve_conflict` → `put(key, 二进制, mime)` → 插入 File 行（ext=format，size 用 `_fmt_size`）。

  **护栏**：
  - 转换是子进程，**120s 超时 + 失败兜底**（沿用 `_office_to_pdf` 的 timeout/returncode 处理），失败时返回友好错误而非抛栈。
  - 排版为朴素样式（Markdown 转出的 Word/PDF 无复杂版式），满足「可交付、可继续编辑」即可；要精细排版另议（可选加 `python-docx`）。
  - 中间 tmp 目录用后即删（`shutil.rmtree`，照搬现有 finally）。

  > 不支持的创建类型：图片 / 视频 / 音频（需二进制素材或 AI 生图，超出本工具范围）。

**整理**
- `rename_file` —— 「把这文件改名叫…」
  ```
  { file_id:int, new_name:str }
  ```
  复用 `update_file` 重命名路径（`_build_key` 新 key → `rename_file` → 更新 display_name/storage_key）。
- `move_file` —— 「把它移到 X 项目的设计阶段」「归到素材库」
  ```
  { file_id:int, target:{ space?, project_id?, folder_id?, stage_name? } }
  ```
  复用 `update_file` 移动路径：按目标重算 `_build_key` → `rename_file` → 更新 space/project_id/folder_id/stage_name/storage_key。
- `create_folder` —— 「在 X 项目下建个『参考图』文件夹」
  ```
  { name:str, project_id?:int, parent_id?:int }
  ```
  复用 `folders.py` 创建逻辑（支持无限嵌套）。
- `delete_file` —— 软删进回收站
  ```
  { file_id:int }
  ```
  复用 `_move_to_trash` + 设 `deleted_at`（30 天自动清理沿用现有机制）。

> 实现备注：上述 helper 目前是 `files.py` 的私有函数，agent skill 直接 import 即可（务实），但更干净的做法是后续把它们抽到 `app/services/files_service.py` 共享层 —— 不阻塞本期。

### 7. `list_clients` / `create_client` —— 客户  → 新建 `skills/clients.py`
口语：「我有哪些客户」「新建客户老王，电话…」
```
list_clients: {}
create_client: { name:str(必填), contact?, email?, phone?, notes? }
```
复用：`Client` 模型 CRUD（后端 `/clients` API 已就绪，逻辑直接照搬）。

### 8. `delete_project` / `archive_project`  → `skills/projects.py`
```
delete_project:  { project_id:int }   # 真删，需谨慎，建议先归档
archive_project: { project_id:int, archived:bool=true }  # 设 archived 标记
```
复用：取 project（校验 user_id）→ delete 或 set archived → commit。
注意：`delete_project` 风险高，建议工具描述里引导咕咕**优先用 archive**、删除前确认。

---

## 第三批 · 聚合查询（让咕咕"主动"起来的基础）

### 9. `get_upcoming` —— 近期要交的/日程
口语：「我最近有什么要忙的」
```
参数: { days:int=7 }
```
复用：合并查询 —— deadline 在 [今天, 今天+days] 的未完成项目 + 同期 CalendarEvent，按日期排序返回统一列表。

### 10. `get_dashboard_stats` —— 总览数字
口语：「我现在手头多少项目」
```
参数: {}
```
复用：count 各 status 项目数、近 N 天事件数、文件数（接近 Dashboard 的统计口径）。

---

## 删除二次确认 · 保底机制

> ⚠️ 已变更（实现版）：早期设计为"强度 C 跨轮强制"（下方保留作记录），但实测与模型"先用文字征询用户"的自然行为冲突 —— 首次真正调用删除工具发生在用户已口头确认之后，又触发一轮需确认，导致**反复确认、删不掉**。
> **现行实现 = 显式 `confirm` 参数**：删除工具加 `confirm` 入参，`agent/confirm.py` 的 `needs_confirmation(args, summary)` 在未带 `confirm=true` 时返回影响详情、不执行；用户明确同意后模型带 `confirm=true` 再调一次才删。物理保底不变（不带 confirm 绝不删），但一次确认即可，贴合模型行为。persona 与工具描述均指示"仅在用户明确同意后置 confirm=true"。

---

### （历史记录）原强度 C 跨轮强制设计

> 目标：**不可逆删除必须经用户亲自确认**，且咕咕在服务端被物理约束 —— 无法在「发起删除」的同一轮里自问自答自删。

### 适用范围：仅不可逆操作
工具加 `destructive: bool` 声明。**需要确认（不可逆）**：
- `delete_project`（真删，连带文件）
- `delete_event`（事件无回收站，删了不可恢复）
- `empty_trash` / `permanent_delete_file`（清空 / 永久删除回收站）

**不需要确认（可恢复，仅在结果里告知"已移入回收站，30 天内可还原"）**：
- `delete_file`（软删进回收站）、`archive_project`（归档，可取消）。

### 机制（按用户消息序号跨轮闸门）
1. 给删除类工具的执行传入上下文 `ctx{session_id, user_msg_seq}`（见下方"接口改动"）。`user_msg_seq` = 当前会话中 role=user 的消息条数（web 编排在跑 LLM 前已写入本轮 user 消息，故含当前轮）。
2. **首次调用**（无匹配 pending）：handler **不执行删除**，登记一条待确认记录，返回需确认结果。
   - 存储：Redis 键 `agent:confirm:{session_id}:{op_sig}`，值含 `{issued_seq: user_msg_seq, summary}`，TTL ~10 分钟（无 Redis 时退化为进程内 dict）。
   - `op_sig = hash(tool_name + 规范化 args)`，确保确认绑定到**具体那一次删除**。
   - 返回：`{"needs_confirm": true, "summary": "将永久删除项目「X」及其 N 个文件，此操作不可恢复", "instruction": "请向用户复述影响并征得明确同意；用户在下一条消息确认后再调用本工具"}`。
   - 咕咕据此向用户提问 → 本轮自然结束（无更多工具调用）。
3. **再次调用**：仅当 `pending 存在` 且 `op_sig 一致` 且 **`当前 user_msg_seq > pending.issued_seq`**（= 用户确实又发了一条消息）才真正执行删除，执行后清除 pending。
   - 同一轮内重复调用：`user_msg_seq` 未增长 → 闸门不放行，仍返回需确认 → **物理上无法自删**。
   - 用户拒绝（说"不"）：咕咕不再调用，pending 到期自动失效；也可显式调 `cancel_pending`/任意非匹配调用不影响。

### 接口改动（均在 `backend/agent/` 内）
- `skills/base.py`：`Tool` 增 `destructive: bool=False`；`registry.dispatch(user_id, name, args, ctx=None)` 增 `ctx` 形参（非删除工具忽略）。
- 新增 `agent/confirm.py`：`check_and_consume(session_id, op_sig, user_msg_seq) -> bool` + `issue(session_id, op_sig, seq, summary)`，封装 Redis/内存存储。
- `core.py`：`LLMRunner` 持有并向 `dispatch` 透传 `ctx`（session_id + user_msg_seq 由 `adapters/web.py` 算好传入）。
- `adapters/web.py`：构造 `ctx`（已有 session_id；user_msg_seq 查一次或复用历史计数）。
- prompt（`default.md` 或 persona）：补一句引导 —— "删除不可逆内容前，先用一句话说明影响并等用户明确同意"。提示词是软引导，**真正保底靠上面的服务端闸门**。

### 前端（可选增强，属后台/前端 agent 领地）
后端可在需确认时额外 emit 一个 `confirm_required` SSE 事件（带 summary），前端渲染成「确认 / 取消」按钮，体验更好；但**不依赖前端**也安全 —— 纯文字问答 + 跨轮闸门已构成保底。

---

## 实现与组织建议

- **分批落地**：先做第一批（5 个，全部是已有逻辑的薄包装，半天内可完成 + 冒烟）。
- **文件组织**：`skills/projects.py` 扩到 5 个工具、`skills/calendar.py` 扩到 4 个，新增 `skills/files.py`、`skills/clients.py`，在 `skills/__init__.py` 注册。
- **Profile**：`DefaultProfile.tool_names` 加上新工具名即生效；未来可按 Profile 裁剪工具集。
- **prompt**：`agent/prompts/default.md` 可补一两句引导（如"删除项目前先确认"），但工具描述写清楚即可，多数无需改 prompt。
- **验收**：复用 Phase 1 的进程内冒烟脚本思路，对每个新工具发一句口语指令验证 tool_call 触发 + 落库正确 + user_id 隔离。

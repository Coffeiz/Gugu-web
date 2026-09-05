# PRD-FS-2：present_file 文件推送到用户当前页面

> 状态：已实现
> 创建：2026-09-04
> 关联模块：`backend/agent/tools/files.py`、`backend/app/api/v1/live.py`、`backend/app/core/events.py`、`frontend/src/stores/live.ts`、`frontend/src/stores/preview.ts`

## 1. 背景与目标

咕咕目前能读写文件库、发送文件（send_file 走聊天附件下载），但用户要看一张图或听一段音频时，
只能点下载或在文件库里自己找。用户希望咕咕能「直接把文件打开在我当前页面上」。

方案（已与用户确认）：新增 Agent 工具 `present_file`，通过现有 SSE 实时事件通道把文件
标识推给该用户所有在线网页端，前端用全局 `previewStore`（浮动图片窗 / 侧边预览 modal）
直接打开。与「推送通知」同一条链路，不引入新长连接。

## 2. 功能需求

### 2.1 工具（后端）

- 工具名 `present_file`，注册在 `FilesSkill`，只读（`mutates` 不设置，不进确认门）。
- 参数：`file_id`（整数）或 `file`（文件名，复用 `_resolve_file` 的定位与歧义防护）。
- 行为：定位文件后向 `events:{user_id}` 发布 `{"present": {...}}` 载荷，返回成功 receipt
  （含 file_id、名称），模型可据此向用户复述。
- 工具描述必须明确：**仅在用户明确要求展示/打开文件时调用**；不适合代替 send_file（不产生
  聊天附件、不留下载记录）。
- 定位失败沿用 `_resolve_file` 的错误 JSON（含候选列表），不暴露跨用户信息。

### 2.2 推送载荷与 SSE 放行

- 载荷：`{"present": {"file_id": int, "name": str, "ext": str}}`，与 `notification` 平级，
  走同一用户频道；只发给文件属主（频道即用户级），无广播。
- `app/api/v1/live.py` 的 `_serialize_message` 白名单新增 `present` 分支：仅当
  `present` 是 dict 且 `file_id` 是 int 时放行，其余丢弃。

### 2.3 前端行为

- `stores/live.ts` SSE 循环识别 `evt.present` → `presentFromLive()`：
  - 标签页可见（`document.visibilityState === 'visible'`）：调 `previewStore.open()`
    打开全局预览（图片/视频/文本浮动窗，其余类型走侧边 modal）。
  - 标签页不可见：只弹 AppToast 通知「咕咕展示了文件 xxx」，不抢焦点、不自动弹窗。
- 预览内容仍走既有 `/files/{id}/download`、`/preview-pdf` 端点取数，鉴权与所有权校验
  由端点自身保证（本工具不新开任何取数端点、不在载荷里带 URL 或 token）。

## 3. 安全边界

1. **同用户隔离**：Redis 频道按 user_id 订阅（SSE 鉴权 `get_current_user_id`）；工具侧
   `get_user_file`（get_owned 语义）保证只能展示属主自己的文件；预览取数端点同样校验
   属主。三层各自独立成立，任一层不信任上游。
2. **最小载荷**：只传 `file_id/name/ext` 三个展示必需字段；不传路径、存储位置、token。
3. **无确认门但受限**：工具只读、不改数据、不消耗存储；风险面是「打扰用户」，通过
   「仅用户明确要求时调用」的工具描述 + 不可见标签页不自动弹窗缓解。
4. **载荷校验**：后端 `_serialize_message` 白名单校验结构，前端对 `file_id` 非法值直接忽略，
   不把未知字段注入 store。

## 4. 不做的事

- 不做跨用户分享、临时代码或签名 URL。
- 不做「多文件画廊」批量推送（首版单文件；需要时模型多次调用）。
- 不改变 send_file / 附件下载的现有语义。

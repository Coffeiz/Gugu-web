# Web 消息排队：run 中到达的消息真正排队 + pending 气泡 + 停止保留队列

日期：2026-09-12
关联：`backend/agent/gateway/web.py`、`backend/app/api/v1/agent.py`、
`frontend/src/components/common/gugu-chat/composables/useChatStream.ts`、`GuguChatMessageList.vue`、`GuguChatMessageRow.vue`、`GuguChat.vue`

## 现象与根因

用户反馈：咕咕 run 进行中发的消息，run 结束后有时不排队处理、直接消失。排查发现两条丢失路径：

1. **服务端盲区（主嫌）**：`POST /agent/chat` 一进来就把用户消息落库，然后查
   `genstream.is_active`——**活跃时旧实现不创建任何后台任务**，只把当前 run 的事件
   转发给这条连接。消息躺在 DB 里永远没人处理。触发场景：双开标签页/多设备、刷新后
   空窗期发送、点停止后的竞态窗口、`reconcileStaleStreaming` 复位后的瞬间。
   更糟的是转发的当前 run 尾部事件会被前端渲染成**本条消息的回答**（归属错乱）。
2. **前端续看不排水（确定 bug）**：`resumeStream` 的 `finally` 漏调
   `drainPendingQueue()`，刷新续看期间排队的消息永远停在内存队列里、从未 POST。
3. 附带 UX 问题：run 中发的消息直接以普通气泡上屏（看不出是排队的）；点「停止」
   会整队清空，连用户明确想发的排队消息一起丢掉。

Web 的「排队」此前是纯前端行为（`pendingQueue` 只在浏览器内存里）；IM 走
`run_collect` 的会话门阻塞等待，才是真服务端排队。

## 修复

### 服务端：run 中到达的 POST 真正排队

`stream()` 活跃分支重构：同样创建后台 `_generate` 任务，进 `session_run_gate` 阻塞
等待当前 run 结束后接续处理（门本身会串行化，`pending_message_count` 正常计数）。

配套四个细节：

- **`begin_after_gate`**：排队任务的 `genstream.begin` 必须推迟到拿到门之后——
  提前 begin 会清掉当前 run 的快照、归属和取消标记。begin 清租约后立即补
  `claim_lease`，避免出现「无租约的活跃快照」被孤儿回收误杀。
- **`_stream_queued_run`**：排队连接的专属 SSE。先发 `queued` 事件（旧前端忽略不炸），
  然后轮询快照直到 `owner_run_id` 变成本 run 才订阅转发；当前 run 的尾部事件
  （含 done）一律不转发，杜绝回复归属错乱。任务结束仍未接管快照（排队中被取消、
  preflight 失败）→ 补 `done idle` 让前端走 DB 收口；15 分钟兜底超时；15s ping 保活。
- **取消标记的代际隔离**：排队任务的心跳在 begin 之前必须忽略取消标记——那可能是
  给上一个 run 的「停止」，否则排队消息会被上一轮的停止连带杀死。
- **按 owner 精确取消**：`_session_gen_tasks` 改为 `session → {owner_run_id: task}`，
  终止端点从快照读 owner 只取消「正在跑的 run」。否则按最新登记取消会杀掉排队任务、
  真正要停的 run 继续占着门。

历史重载的重复注入风险已由既有机制兜住：`run_context._effective_history` 按主键排除
当前用户行（`prepare_run` 再追加 `current_text` 一次），排队 run 拿门后
`_refresh_generation_history` 重载也不会重复。

### 前端：pending 气泡 + 续看排水 + 停止保留队列

- **pending 气泡**：生成中发的消息以压暗气泡 +「排队中」旋转标签上屏（`msg.pending`，
  已入 `v-memo` 数组保证转正时重渲染），多条在底部依次追加；排水真正 POST 时转正为
  普通气泡（透明度过渡）。i18n 新增 `chatUi.pendingQueue`（排队中/待機中/Queued）。
- **续看排水**：`resumeStream` 的 `finally` 补 `drainPendingQueue()`（带 ownsView 身份核对）。
- **停止保留队列**：`stopStreaming` 不再清空 `pendingQueue`；取消当前 run 后，被中断流
  的 finally 排水立即发出下一条。后端此时若还没释放 run，新 POST 走服务端排队分支接续，
  端到端语义成立。切换会话/新建会话仍清空队列（跨会话语义，保持原状）。

## 已知边界（未处理，如实记录）

- 客户端队列仍在浏览器内存：run 中排队后刷新页面，队列里的消息随内存消失（从未 POST，
  服务端无痕）。要彻底解决需把排队草稿落 localStorage 或提前落库+断点续投，属后续项。
- 排队 SSE 的 15 分钟兜底超时后，回复仍会在服务端完成并落库，刷新可见；连接本身收口。

## 验证

- 新增回归：排队流先 `queued`、不转发他人事件、自身 run 接管后转发至终态；任务未接管
  快照即结束补 `done idle`；按 owner 精确取消（排队任务不被误杀）；常量下限校验。
- 后端全量 `2545 passed`；devserver 定向 24 passed；前端 typecheck 干净、488 passed。
- devserver 三服务重启后 active，日志无异常。

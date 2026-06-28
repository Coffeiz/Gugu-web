# Wishlist

> 按优先级排列

---

## 进行中 🚧

- _（里程碑之间，下一项待锁定）_

## 规划中 🔜

- **客户管理页面** — 后端 `clients` API 已完成，前端无页面
- **定时任务 + 截稿主动通知** — 截止日期提醒 / 周期归档 / 同步；复用 IM 出口 + APScheduler，把「48h 内到期」主动推给用户（侧边栏通知入口已预留）
- **思维画布** — 创意节点图，可挂文件附件，侧边栏入口已预留
- **团队协作** — 多用户共享项目、权限管理（ToB 方向）
- **城市天气显示** — IP 定位（无需用户授权）拿到城市，调天气 API（和风天气 / OpenWeatherMap）展示实时天气；候选位置：顶栏日期旁或 Dashboard 侧边
- **咕咕回语音（双向语音条）** — 用 MiniMax T2A 语音合成（`POST /v1/t2a_v2`）让咕咕也能"说"，渲染成 AI 侧语音条（语音条 UI + `stage_voice` 已就绪）。注意：响应音频是 **hex 编码**（非 base64），部分账号需 GroupId，key 可复用池里的 MiniMax；何时用语音回可加开关或让咕咕自己判断。MiniMax 无 ASR，"听"仍走 mimo

## 已完成 ✅（曾列入 Wishlist）

- 文件管理支持文件夹（无限嵌套，支持个人/项目空间）
- 文件按项目/阶段归档
- 文件预览（PDF / 图片 / 视频 / 文本 / Office）
- 回收站（软删除、30 天自动清理、还原）
- 自然语言管理接口（AI Agent SSE 流式，多 provider）
- 中国节假日日历标注
- 文件本地/UI 双向同步（visibilitychange + /files/version）
- **Agent 对话历史持久化**（`conversation_sessions` / `conversation_messages`）
- **Agent 工具扩展** — 改阶段/配色、查文件、建文件夹等，现共 23 工具
- **Agent 记忆系统（Phase 2）** — `.agent/` 三层档案 + 反思 + 压缩 + persona 伙伴化
- **IM 接入（飞书 + QQ · BYO 扫码）** — 文件双向收发、PDF/Office 读取、实时同步
- **提示词分层** — persona/skills/policy/default 四层，后台可分别编辑

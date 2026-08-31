# Wishlist

> 按优先级排列

---

## 易读概述

这是咕咕的功能规划清单，记录"还没做但想做"和"已经做完"的功能点，方便追踪产品方向、避免重复造轮子。状态标记：**进行中 🚧** = 正在推进、**规划中 🔜** = 已明确要做但还没动手、**已完成 ✅** = 已上线（曾经列在这份清单里）。

> 核实说明（2026-08-30）：按仓库当前 `0.22.0`、路由、前后端实现和 `CHANGELOG.md` 重新核对。思维画布已从规划项移入已完成；客户管理仍只有 API/Agent 能力，天气常驻组件、语音回复和团队协作仍未完成。生产部署、真实用户稳定性和运营数据不以代码存在作为完成依据。

---

## 专业细节

## 进行中 🚧

> 当前主线（2026-08-30，详见 [`../agent/proposals/反馈信号系统-设计.md`](../agent/proposals/反馈信号系统-设计.md)）：

- **MVP 内测与生产验收**（当前仓库版本为 `0.22.0`；功能实现持续进入 Unreleased，生产部署、备份恢复、压测和真实用户稳定性仍需现场验收，详见 [`MVP.md`](MVP.md)）
- ~~**反馈信号采集器**~~ ✅（2026-07-02 已落地+验证+部署:①feedback 枚举采集 ④时长锚点+禁自估红线;③lens 写回等 feedback 攒 1–2 周。关系温度已于 2026-08-30 下线）

**排队中（有依赖/等数据）**:
- lens 印证/反驳写回（③,等 feedback 数据 1–2 周）
- 复盘错读案例质量（pattern 是否常落「其他」、召回如何——step 1.5 数据攒够后）
- 置信度原语设计（stance→Need Hypothesis 范式切换图纸,可先纸面设计）
- 检索基建 embedding 召回（Person Model 前置,见 [`../agent/11-记忆系统.md`](../agent/11-记忆系统.md) §10）
- 观察:窗口系统边缘 case、问候/闲聊体感

## 规划中 🔜

- **客户管理页面** — 后端 `clients` API 和 Agent 工具已完成，前端仍无页面或正式路由。**核实：当前仍未上线**，与 [`MVP.md`](MVP.md) / [`OVERVIEW.md`](OVERVIEW.md) 的待办一致
- **团队协作** — 多用户共享项目、权限管理（ToB 方向）。**核实：仍未开发**
- **城市天气显示（Dashboard/顶栏常驻小组件）** — IP 定位（无需用户授权）拿到城市，调天气 API 展示实时天气；候选位置：顶栏日期旁或 Dashboard 侧边。**核实：待核实差异** —— Agent 已有 `weather` 技能（`backend/agent/skills/weather.md`，走 wttr.in，按需对话查询），但这是"问咕咕天气"的聊天能力，不是本条描述的顶栏/Dashboard 常驻展示组件，两者不等价，UI 组件本身仍未做
- **咕咕回语音（双向语音条）** — 用 MiniMax T2A 语音合成让咕咕也能"说"，渲染成 AI 侧语音条。输入侧已有音视频/语音理解能力，但**核实：当前仍未实现 T2A 回复调用**。

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
- **Agent 记忆系统（Phase 2 + 2b）** — `.agent/` 五层档案（facts.json 结构化 kind/conf/imp + daily + memory + summary 时间衰减 + lens 解读先验）+ 反思增量提炼 + 压缩 + persona 伙伴化
- **结构化 facts + 增量反思（2b）** — facts 升级为带置信/重要度/衰减的 JSON，反思只吐增删、不回显整份；旧 facts.md 自动迁移
- **事件总线 + 记忆控制命令** — `agent/events/bus.py`（`MemoryUpdated` 发布/订阅 + 审计）；聊天里 `/memory` 看记得啥、`/forget` 忘掉一条
- **感知系统 P0–P2** — 感知遥测 + 误判捕获（LLM 判、分感知误读/数据执行错）+ Admin 诊断面板；行为模块库（emotion-first/stuck-first/decision-explore）；per-user 解读先验 lens
- **IM 接入（飞书 + QQ + 微信 · BYO 扫码）** — 文件双向收发、PDF/Office 读取、**音视频理解 + 语音条（30 天存储）**、实时同步
- **定时任务面板** — 用户自定义一次性 / 周期任务 + 提醒，结果走通知 / 飞书·QQ·微信 IM 出口（不进对话）；后续升级为推送写进 IM 会话历史，用户回复能接上上下文
- **提示词分层** — persona/skills/policy/default 四层，后台可分别编辑
- **通知系统**（本次核实新增）— 通知气泡（打字动画、5s 自动消失）+ 侧边栏通知中心 + 后台广播（Redis pub/sub + SSE 实时推送）
- **日历周视图**（本次核实新增）— 时间轴布局，全天/日期多日框选 + 右键新建项目/活动，活动块可拖拽移动/改时长
- **新手引导系统**（本次核实新增）— 独立子系统，注册播种教程项目/文件/日历活动 + 欢迎/引导气泡（一账号一次触发）
- **咕咕相处方式重构**（本次核实新增）— persona 瘦身为纯人格，相处方式改由反思驱动的 stance 行为模块选择（baseline/companion/execution/record/query/reflect 等），告别"总爱往推进项目上带"
- **思维画布与笔记工作台**（2026-07-13 至 2026-08-29）— `/mind/notes` 与 `/mind/canvases` 已上线；支持便签时间流、项目/文件/活动引用卡、画布拖拽、缩放平移、关联连线、编辑删除，以及对应 API、Agent 工具和实时同步。实现依据：[`OVERVIEW.md`](OVERVIEW.md)、[`PRD-AGENT-2-思维画布咕咕工具.md`](../prds/【已完成】PRD-AGENT-2-思维画布咕咕工具.md)、[`CHANGELOG.md`](../../CHANGELOG.md)。

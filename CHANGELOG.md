# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### 修复

- **飞书引用咕咕自己的流式卡片回复时看不到真实内容**（`agent/adapters/feishu.py`）：先是拿到「请升级至最新版本客户端」占位文案，补参数后又变成「[空消息]」——根因是抽取逻辑没适配流式卡片的 schema 2.0 嵌套结构，两处都修了。

### 改进

- **飞书流式回复卡片收尾改标题**（`agent/adapters/feishu.py`）：回复完成后把卡片标题从「咕咕思考中」改成「咕咕」，不再挂着思考中的标题。
- **QQ 彻底移除 botpy 依赖**（`agent/adapters/qq.py`、`requirements.txt`）：收发两侧全部改为自建 raw WebSocket/HTTP，不再需要 qq-botpy 包。
- **项目许可证改为 Apache-2.0**（`LICENSE`、`README.md`）：项目开源协议从 MIT 调整为 Apache License 2.0，并补齐许可证文件与前端包元数据。
- **咕咕聊天改用虚拟滚动**（`components/common/GuguChat.vue`）：长会话不再一次性渲染全部消息，打开更快、滚动更流畅。
- **记忆系统拆分为用户画像/行为模式两个文件**（`agent/memory/store.py`、`agent/memory/reflection.py`）：不再用一份文件混装稳定身份和行为习惯，各自判断标准更清晰、不共用不必要的置信度/衰减机制。详见 [devlog.md](docs/devlog.md) 2026-07-08 条目。
- **`/memory` `/forget` 命令适配 profile+pattern 拆分**（`agent/commands.py`）：`/memory` 分开展示「关于你」（画像）和「行为习惯」（模式），`/forget` 同时搜索两者。
- **`complete_json` 支持 temperature 参数**（`agent/memory/_llm.py`）：默认 0.3，稳定性要求高的调用方（如批量删除类）可传更低值。
- **Admin 数据总览排除新手引导教程项目**（`app/api/v1/admin_analytics.py`）：每个新用户注册都会播种一个引导项目，不计入项目相关统计指标。

### 新增

- **飞书支持图文消息/视频/转发卡片入站**（`agent/adapters/feishu.py`）：图文消息拼接段落文字并下载内嵌图片/视频，视频消息复用附件下载逻辑，转发的卡片消息抽取可读文字。
- **定时任务按需精简工具/上下文，省 token**（`agent/tools/scheduled_tasks.py`、`agent/runner.py`、`agent/context/builder.py`）：创建/修改任务时顺手判断这个任务用得上哪些工具组、要不要带项目/日历/文件/记忆，存下来执行时按需注入；判断不出来就用回全量，安全优先。详见 [devlog.md](docs/devlog.md) 2026-07-08 条目。
- **文件上传同名冲突支持覆盖/保留两者/跳过**（`views/Files/index.vue`、`Projects/components/ProjectModal.vue`）：上传前列出冲突文件，可选覆盖、保留两者或跳过。
- **`http_get` 按 Content-Type 自动提取正文**（`agent/tools/web.py`）：HTML/PDF 自动提取正文，不再把截断的原始响应喂给模型。详见 [devlog.md](docs/devlog.md) 2026-07-06 条目。
- **飞书 IM 支持流式输出**（`agent/runner.py`、`agent/adapters/feishu.py`）：新增 `run_stream` 逐字 yield token，飞书端实时 patch 卡片内容，体感速度与 web 端对齐。
- **微信 iLink 接入「正在输入」状态**（`agent/adapters/wechat.py`、`wechat_client.py`、`wechat_config_cache.py`、`wechat_typing.py`）：咕咕思考时在微信端显示"对方正在输入…"，缓解等待感。
- **个人设置支持自助注销账号**（`components/common/ProfileModal.vue`、`app/api/v1/auth.py`）：需输入密码二次确认，注销后账号与全部数据永久删除。
- **Admin 面板支持一键复核清理记忆**（`Admin/Agent/index.vue`、`app/api/v1/config.py`、`scripts/refresh_memory.py`）：一次预览同时算出该删的旧条目、该搬去用户画像的条目、可清理的遗留文件，确认后一并执行，不会重新判断一遍。
- **感知诊断面板新增「关系温度」当前值列表**（`Admin/Perception/index.vue`）：按温度降序列出各用户当前值。
- **感知诊断面板加「排除开发者」开关**（`Admin/Perception/index.vue`）：跟数据总览同款开关，一键排除开发者账号数据。
- **项目支持归档/查看已归档/取消归档**（`views/Projects/index.vue`）：网页端补齐入口，之前只有咕咕自己能归档。
- **IM 慢工具触发时先发一句进度声明**（`agent/tools/base.py`）：缓解飞书/QQ/微信这类非流式渠道调慢工具时的干等感。
- **浮动预览窗四角都能拖拽调整大小**（`components/common/FloatPreviewWindow.vue`）：之前只有右下角一个手柄能拉伸。
- **文件预览窗支持直接编辑文本/代码文件**（`components/common/viewers/TextViewer.vue`）：代码类文件改用 CodeMirror 6，直接编辑、自动保存。详见 [devlog.md](docs/devlog.md) 2026-07-07 条目。

### 修复

- **咕咕无法查看已归档项目**（`agent/tools/projects.py`）：`list_projects` 一直写死过滤掉已归档项目，问「归档的 XX 项目」也查不到，现在支持按 `archived` 参数查已归档一批。
- **看板已完成列玻璃质感跟另外两列不一致**（`Projects/components/{KanbanColumn,DoneColumn}.vue`、`Schedules/index.vue`）：已完成列一直是历史遗留的写死样式、连 `backdrop-filter` 都没有，改成跟另外两列一样接入全局 `.glass-card`，定时任务页大版面顺带一起统一。
- **IM/定时任务推送里混入模型过程性旁白**（`agent/runner.py`、`agent/context/builder.py`、`agent/skills/weather.md`）：多轮工具调用间的过渡话被原样拼进推送内容，现在只取最后一轮总结文本；顺带修了天气 skill 容易查出超大 JSON 被截断、逼模型反复重试的问题。详见 [devlog.md](docs/devlog.md) 2026-07-08 条目。
- **文件库改名输入框不支持中文输入法**（`views/Files/index.vue`）：敲回车上屏候选词会被误判成确认改名，已修复。
- **docx/xlsx/pptx 预览「转换失败 (500)」**（`app/api/v1/files.py`）：部署配置问题导致转换失败，已修复。详见 [devlog.md](docs/devlog.md) 2026-07-06 条目。
- **`http_get` 反复超时后咕咕答非所问**（`agent/prompts/skills.md`）：现在会如实告知连不上，不再用无关话搪塞。
- **弹窗叠在浮动窗口上打开时，淡入动画期间毛玻璃完全不模糊**（`components/common/BaseModal.vue`）：进场动画改为「玻璃 ramp」修复。详见 [devlog.md](docs/devlog.md) 2026-07-06 条目。
- **弹窗毛玻璃背景/阴影全局失真**（`components/common/BaseModal.vue`）：scoped CSS 没生效导致，改用 prop 传值修复。详见 [devlog.md](docs/devlog.md) 2026-07-06 条目。
- **定时任务生成的消息误报「IM 渠道未连」**（`agent/runner.py`）：现在跟直接对话一样读取真实连接状态。
- **浮动预览窗打开低分辨率图片先猜大窗口再骤缩**（`components/common/FloatPreviewWindow.vue`）：改为等真图加载完再定尺寸。
- **记忆 summary 快照里的相对时间没法换算**（`agent/memory/reflection.py`）：补充当前日期，涉及时间点换算成绝对日期。
- **头像存盘后缀从客户端文件名推导，粘贴图片时出错**（`app/api/v1/auth.py`）：改用真实文件类型判断后缀。
- **个人设置面板隐藏未生效的 QQ 群聊开关**（`components/common/ProfileModal.vue`）：功能还没接入其它平台，先隐藏。
- **清除记忆接口漏删部分记忆文件**（`app/api/v1/agent.py`）：改成直接清空整个 `.agent/` 目录，不再挨个列文件名，以后新增记忆文件不会再漏。
- **飞书流式输出全部 200770 幂等失败**（`agent/adapters/feishu.py`）：飞书 `streaming_update_text` 的 UUID 是幂等键，同 UUID 只生效一次，原代码整个流式会话复用同一 UUID 导致第二次及之后的 patch 全被拒绝，改为每次 patch 生成新 UUID。

## [0.16.1] - 2026-07-05 · 登录支持邮箱 + 项目优先级 + 记忆向量扩展 + 对话追问路由修复

> 登录新增邮箱通道；建项目支持一次性设优先级（`set_priority` 独立工具下线并入 `create_project`/`update_project`）；记忆向量检索接着 0.16.0 的地基往下补两块（facts 注入上限 40→100、memory.md 块级向量）；修复咕咕说"马上查"却没真的查、用户追问反被拦截的问题。

### 改进

- **登录支持用户名或邮箱**（`app/api/v1/auth.py`、`views/Login.vue`）：注册时已收邮箱（唯一约束）但登录一直只认用户名。改成 `username`/`email` 任一匹配（两字段均唯一，不会撞车），登录页文案同步更新，密码找回/注册流程不受影响。
- **建项目支持优先级，`set_priority` 独立工具下线**（`agent/tools/projects.py`、`app/core/events.py`）：`create_project`/`update_project` 直接接受 `priority` 参数一次建好，不用建完项目再单独调一次；`update_project` 本就是通用字段更新入口，单独为一个字段开工具意义不大，已删除，工具清单 59→58。
- **记忆向量检索扩展：facts 上限 40→100 + memory.md 块级向量**（`agent/memory/{store,compress,embedding}.py`、`api/v1/config.py`、`Admin/Agent/index.vue`）：facts 注入上限提到 100（超出才走相关性挑选）；memory.md 是唯一「全量注入无上限」的记忆层，超字数阈值且 embedding 启用时切块、按 cosine 挑相关块拼预算内并保原文顺序，未超阈值/无向量则整篇退回、零回归；compress 重写后自动重嵌变动块；重建按钮同步覆盖两处。默认关闭、增量自动嵌入，收益要真超阈值才兑现。详见 `docs/agent/11-记忆系统.md` §11。

### 修复

- **Intent Router 空闲时拦截"查到了吗"类追问 + 意图守卫漏判省略主语的承诺句**（`agent/router.py`、`agent/core.py`）：咕咕报错后回复「马上重新查一下」，用户追问「查到了吗」却只回了句寒暄、没真的去查。两处根因：`router.py` 的关键词短路不看忙闲、状态回 IDLE 时把追问拦成空话；`core.py` 的意图守卫只认"我+动词"开头，漏判"马上重新查一下"这类省略主语的变体。已修复，真实对话文本验证。

## [0.16.0] - 2026-07-04 · 记忆向量语义检索（可选自托管 embedding）+ 全项目安全审计与加固 + 感知反馈信号采集

> 记忆检索从词法（bigram）升级到可选的向量语义（默认关闭、随时可退回，支持自托管 Ollama）；对照认证授权 / 注入·SSRF·文件 / 密钥·配置·日志三个攻击面做了一轮完整安全审计并修复 SSRF 重定向绕过、全站无限流、邀请码注册竞态等；感知系统补上反馈信号采集 + 关系温度 + 时长锚点；IM 补飞书/微信消息引用识别。

### 安全

- **全项目安全审计 + 一批修复**（`app/core/ratelimit.py` 新增 + `agent/tools/{files,base}.py` + `app/api/v1/{auth,admin_auth,config}.py` + `app/main.py`；报告 [docs/security/安全审计报告-2026-07-03.md](docs/security/安全审计报告-2026-07-03.md)）：对认证授权/注入·SSRF·文件/密钥·配置·日志三个攻击面做了一轮完整审计，核心结论是应用层内核扎实，修复了 SSRF 重定向绕过、全站无限流、邀请码注册竞态等 9 项真实问题。详见 [devlog.md](docs/devlog.md) 2026-07-04 条目。
- **IM Bot 凭据补上静态加密**（`app/core/crypto.py` 新增 + 迁移 `20260702000002`）：`UserBot.app_secret`（飞书/QQ/微信机器人密钥）实际是明文落库，跟隐私政策承诺的"AES-256-GCM 加密存储"不符。新增 `EncryptedString` 类型让读写对业务代码透明加解密，迁移原地加密历史明文行，`app_id`（公开标识符）保持明文不影响绑定流程查询。
- **IM 收发日志脱敏**（新增 `agent/logsafe.py` + `agent/adapters/{qq,feishu,wechat}.py` + `worker.py`）：网关/worker 此前打印聊天原文（收到消息前 40 字符、回复全文不截断），跟项目已有的脱敏红线不一致。新增 `logsafe.fingerprint()`（md5 前 8 位，不可逆）替代原文打印，5 处日志点覆盖"收到没/是否重复处理"等排查场景。

### 改进

- **全站 TypeScript 转换收尾（51 个 `.vue` 文件补 `lang="ts"`）+ 顺带修复三处真实 bug**：67 个 `.vue` 文件里只有 14 个接了 `lang="ts"`，本次补齐剩余 51 个并清空暴露出的类型错误（196→0）。顺带抓出三处存量 bug：`ProjectModal.vue` 引用了从未声明的 `selectedProjectId`、`Privacy.vue` 两处反引号忘转义截断了模板字符串、`filesApi.update`/`copy` 多处传参用错命名风格。`npm run typecheck`/`build` 均验证通过。
- **通知气泡改回只能手动关闭**（`components/common/NotificationBubble.vue`）：0.15.2 把气泡改成打完字 5s 自动消失，实际用起来经常没看完就没了，撤回自动消失，只能点 ✕ 关；「只弹一次」语义不受影响。

### 新增

- **记忆向量语义检索（可选自托管 embedding，默认关闭）**（新 `agent/memory/embedding.py` + `store.py` + `Admin/Agent/index.vue` 配置 UI）：记忆检索从词法（bigram）升级到向量语义，facts 超注入上限时按语义相关性挑而非字面重叠。定位为共享 embedding 基建，走 OpenAI 兼容 `/embeddings`（支持自托管 Ollama），per-user 规模不需要向量数据库、Python 暴力 cosine 即可；默认关闭、全链路退回词法，对现有行为零副作用。设计见 `docs/agent/参考/咕咕改进方案-MaiBot借鉴.md` 改进一。
- **飞书 / 微信支持消息引用识别，QQ 协议层做不到**（`agent/adapters/{feishu,wechat}.py`）：用户"引用/回复"某条历史消息时，之前咕咕感知不到"这句话针对哪条历史消息"。QQ 官方机器人协议层拿不到引用内容、判定不可行；飞书需要额外反查 API 且要处理卡片消息的嵌套结构；微信 iLink 直接内嵌了被引用消息全文，最省事。详见 [devlog.md](docs/devlog.md) 2026-07-04 条目。
- **反馈信号采集器 + 关系温度 + 时长锚点（感知系统 step2 采集侧）**（`memory/reflection.py` + 新 `memory/temperature.py` + `context/builder.py`）：学习闭环的燃料源从"仅用户显式纠正"加宽一个数量级——反思顺带判"用户这句怎么接上一轮"（确认夸赞/改写重问/顺着聊/无视跳开等枚举）；`temperature.py` 用 28 天滑动窗口聚合出关系温度供语气校准；`read_memory` 注入"记忆从 N 天前开始积累"的硬数字锚点，防模型编造"这几个月的观察"这类无据时间词。设计见 `docs/agent/proposals/反馈信号系统-设计.md`。
- **感知诊断面板：反馈信号分布 + 数据导出**（`api/v1/agent_perception.py`、`Admin/Perception/index.vue`）：配合反馈信号采集，面板加正/负向信号分布条，加"下载完整记录"按钮导出脱敏后的原始事件 JSON 供离线分析。
- **支持拖文件夹上传（保留目录结构）+ 统一三处上传逻辑**（新增 `composables/useFileUpload.ts`）：拖放此前只读扁平 `FileList`，拖文件夹进来会被当空文件静默失败；上传文件/文件库/项目编辑卡三处还各自维护一套并发策略不一致的实现。新 composable 用 `webkitGetAsEntry()` 递归展开文件夹结构、统一并发调度，三处收敛成同一份逻辑。

### 修复

- **咕咕悬浮球会挡住聊天窗**（`components/common/GuguChat.vue`）：`.ai-fab` 固定 `z-index:99999` 恒高于聊天窗，展开状态下会盖住聊天窗一角。改为动态 `fabZ`，聊天窗打开时球压到 `chatZ-1`。
- **拖拽克隆缩略图看不出模糊 + 聊天窗大小切换偶发闪烁**（`assets/styles/global.css`、`components/common/GuguChat.vue`）：图片缩略图区单独挂 `backdrop-filter` 让"背后模糊"透出来；`resizing` 状态改成监听真实 `transitionend` 而非硬编码定时器，掉帧时不再提前触发闪烁。
- **pointer 模式下松手指针原地不动、卡片悬浮态卡在"未悬停"**（`composables/usePhysicsDrag.ts`）：`_revealWithoutStaleHover` 是给已淘汰的原生拖拽设计的治标手法，文件卡/项目卡全转 pointer 模式后这手法反而帮倒忙，导致 `:hover` 卡死不刷新。pointer 模式下不再套用。
- **文件复制/剪切跨空间粘贴静默失败**（`app/api/v1/files.py`、`Files/index.vue`、`ProjectModal.vue`）：`copy_file`/`update_file` 此前无条件从源文件继承 `project_id`，项目文件复制到个人文件库表面成功、实际还留在原项目。改按调用方显式传入的 `project_id` 决定目标空间。
- **文件拖拽两处静默失效**（`composables/useFileDragDrop.ts`、`views/Files/index.vue`）：`data-folder-key` 混用带前缀字符串导致 `Number()` 转出 `NaN`、面包屑落点判定读到被提前清空的拖拽状态，两个独立 bug 都是"看起来有反应、实际没挪窝"。详见 [devlog.md](docs/devlog.md) 2026-07-03 条目。
- **项目编辑卡文件拖拽统一为 pointer 模式，抽取共享 composable**（新增 `composables/useFileDragDrop.ts`；`views/Files/index.vue`、`views/Projects/components/ProjectModal.vue`）：项目编辑卡此前仍是原生 HTML5 拖拽，跟文件库改造前一样有归位悬停跳变的风险。把拖拽编排抽成共享 composable，文件库和项目编辑卡都改为消费它，差异点（data 属性名、面包屑放置规则、落地后刷新策略）做成配置项。
- **文件卡拖拽改用 pointer 模式，根治归位悬停跳变**（`composables/usePhysicsDrag.ts`、`views/Files/index.vue`）：perf trace 定位根因——原生 HTML5 拖拽期间浏览器暂停 `mouseover`/`mouseout` 派发，抓起卡片时缓存的 `:hover=true` 直到 `dragend` 才刷新，导致归位揭示时 hover 高亮跳变。改用项目看板已验证的 pointer 模式（`setPointerCapture`）根治，不再在揭示时机上打补丁。
- **快速重新抓拖拽落地中的卡片会抓到隐形克隆**（`composables/usePhysicsDrag.ts`）：Chrome trace 定位——两次拖拽间隔（约 310ms）可能短于落地动画复位源卡 `display`/`opacity` 的耗时（420~580ms），此时重新抓取量到的尺寸是 0×0，克隆不可见。入口处强制先复位源卡再量尺寸。顺带定版拖拽克隆的白底/毛玻璃比例，详见 [docs/product/design.md](docs/product/design.md)。

## [0.15.2] - 2026-07-02 · 商用就绪安全加固（多用户隔离/删除确认门/全链路可观测/隐私合规）+ 窗口系统 + 后台运维面板

> 对照一份外部商用就绪评审逐条核实（[docs/security/商用就绪评审-核实版.md](docs/security/商用就绪评审-核实版.md)）后，把放量前四项必须项（P0-2 多用户隔离、P0-3 删除确认门、P0-4 可观测、P0-5 隐私合规）主体落地，并搭起后端首套自动化测试基础设施（此前是 0）；成本防护（原 P0-1）经产品阶段判断降级为 P2、量起来再做。另有窗口层级系统重构、附件回查、图片搜索、微信语音、后台数据面板拆页等功能更新。

### 新增

- **聊天附件可回查重发 + `list_files` 结果格式化指引**（`backend/agent/tools/files.py`、`agent/skills/file-ops.md`）：修复「把刚刚的图/QQ那张发我一下」这类模糊指代找不到原图的问题，根因是 `attach_id` 只在收到那一轮上下文里可见、翻篇即失忆。新增 `list_recent_attachments` 工具查暂存区未过期附件，`send_file` 支持按 `attach_id` 直接重发。
- **后台数据面板拆两页 + 新指标 + 开发者标记**（`api/v1/admin_analytics.py` + `users_admin.py` + `Admin/Analytics/{index.vue,Usage.vue,_shared.ts}` + `Users` + 迁移 `20260702000001`）：原「数据分析」单页太挤，按「生意好不好 / 用户怎么用」拆成**数据总览**（日活曲线、项目留存）与**使用分析**（新建项目曲线、会话深度分布、周活跃维度）。新增 `users.is_developer` 标记 + 两个数据页「排除开发者」全局开关，一键看真实用户数据。
- **图片搜索 `image_search` + `send_file` 支持网络图片**（`backend/agent/tools/search.py`、`tools/files.py`）：新增 `image_search` 工具走自建 SearXNG（免配额），`send_file` 加 `url` 参数支持下载网络图片（带 SSRF 防护）后暂存转发，网页和 IM 都能收到。新增独立技能文档 `agent/skills/web-search.md`。
- **微信支持语音消息**（`backend/agent/adapters/wechat.py`）：iLink 语音消息自带 ASR 转写在 `voice_item.text`，直接读转写文字注入对话即可，转写为空时给兜底提示、不静默丢消息。文本/图片/语音三平台（飞书/QQ/微信）至此全部打通。
- **窗口系统：点谁谁到最上层（工作环境式多窗口）**（新 `composables/windowz.ts` + `BaseModal.vue` + 16 个组件接入）：原来 BaseModal/通知气泡/GuguChat/预览窗四套 z-index 各自为政。统一为四带式 z 管理（遮罩带/窗口带 mousedown 置顶/悬浮球/压顶带），项目编辑卡、预览窗、聊天窗可自由叠放点谁谁上；BaseModal 遮罩与卡片拆成平级节点，背景模糊不再糊到其它窗口；ESC 只关最顶层。
- **多用户隔离下沉查询层 + 后端首套自动化测试（商用就绪 P0-2）**（`app/core/ownership.py` + `tests/` + 9 个 REST 路由文件）：此前隔离靠每处手写判断、属约定而非机制。新增 `get_owned()` 取行+归属校验一体（不存在/不是你的对外统一返回 None 防资源枚举），46 处裸查询全部收敛为统一调用，配套 pytest + 内存 SQLite 测试基建与静态守卫防新增裸查询。
- **删除确认门框架级强制（P0-3）**（`scripts/check_confirm_gate.py` + dispatch 绊线 + 9 测试）：`Tool.destructive` 此前只是文档性标记、确认门靠 handler 作者自觉。补两层机制：AST 静态守卫校验所有 destructive 工具源码必须引用 `needs_confirmation`，加 dispatch 运行时绊线兜底。
- **全链路 trace_id + 工具失败率/延迟运维指标（P0-4）**（`agent/trace.py` + `app/core/opsmetrics.py` + `api/v1/ops_admin.py`）：一条消息跨网关/worker 两进程此前日志无共同标识、只能时间戳对账。新增 ContextVar 全链路 trace（IM 网关生成 → 随 payload 入队 → worker 恢复），并补上工具失败率/延迟运维指标闭环。
- **账户注销全量清数据 + IM 侧记忆命令 + 三平台 ToS 合规记录（P0-5）**（`app/services/storage/__init__.py` + `api/v1/users_admin.py` + `worker.py` + `20-IM接入架构.md` §3.4）：隐私政策承诺「注销后永久删除」，但 `delete_user` 此前只做 DB 级联，AI 记忆/上传文件等存储层数据碰不到。新增 `StorageBackend.delete_prefix()`，注销按序清缩略图缓存/存储前缀/Redis/DB。`/memory` `/forget` 接入 IM 侧，飞书/QQ/微信用户同享隐私控制权。
- **后台运维监控页 + 安全事件计数 + Debug 全链路搜索 + 注销清除反馈**（`views/Admin/Ops/index.vue` + `app/core/opsmetrics.py` + `views/Admin/Debug/index.vue` + `views/Admin/Users/index.vue`）：把 P0-4/P0-5 攒下的数据接进后台界面——新增运维监控页（安全事件横幅+调用量/失败率/延迟）、Debug 日志按 `trace_id` 关键词搜索、删除用户后显示清除对象数的绿色横幅。

### 改进

- **毛玻璃三档统一收变量 + 拖拽克隆体毛玻璃**（`variables.css` + `global.css` + 12 个组件）：全站 blur 值此前散写多种数值。统一为三档并全走 CSS 变量（大面板/小弹窗/拖拽克隆，详见 [docs/product/design.md](docs/product/design.md)），拖拽克隆体新增毛玻璃背景，文件库/编辑卡/看板拖拽克隆全站一致。
- **后台刷新按钮全局统一 + 用户管理操作按钮横排**（`AdminApp.vue` + 12 个 Admin 页面）：所有页面刷新按钮统一为方形图标钮样式（抽成 Admin 全局共用），各页删除本地重复定义；用户管理操作列加宽并禁折行，修复加 DEV 按钮后被挤成竖排。

### 修复

- **浮动预览窗打开低分辨率图片先猜大窗口再骤缩**（`components/common/FloatPreviewWindow.vue`）：缩略图顶到尺寸上限时原图真实尺寸未知，此前套 4K 估算兜底，遇到实际是低分辨率图会先猜出超大窗口再骤缩。改为不猜，等真图加载完直接按正确尺寸定窗。
- **多附件误存**（`backend/app/core/chat_attach.py`、`agent/tools/files.py`）：QQ 连发 4 张图后一句「存到XX项目」实际只存了 1 个不相关的语音文件，根因是 `resolve_attach()` 兜底逻辑不分类型/渠道取最近暂存的一条。`stage` 新增 `platform` 字段按渠道收窄候选，有歧义时返回候选列表而非静默瞎猜；新增 `save_uploaded_file` 批量参数一次存多个。
- **项目编辑卡图片文件多选，文件名标签区未被选中暗色覆盖**（`views/Projects/components/ProjectModal.vue`）：`.fc-card.selected` 的选中覆盖层误写成只对无缩略图卡生效的选择器，导致有缩略图的图片卡选中时下方文件名区域不跟着变暗。对齐文件库正确实现。
- **通知气泡改为一次显示、自动消失，无需手动点关闭**（`components/common/NotificationBubble.vue`）：此前只有教程气泡打完字 5s 后自动消失，其它通知会一直停留、需手动点 ✕。现在所有气泡一视同仁，打完字 5s 后自动消失。
- **输入框中文候选词回车被误当提交**：中文输入法下敲回车确认候选词，各输入框此前没排除 IME 组合态，候选词还没选完就被误触发提交。新增全局自定义指令 `v-enter`（判据用标准 `event.isComposing`），全仓 20 处回车确认输入框统一迁移。
- **网关秒崩无限重启刷日志**（`backend/agent/adapters/supervisor.py`）：`reconcile()` 发现子进程退出就立即重启、没有退避，凭据错误等必现问题会变成每 5s 重启一次的死循环。加指数退避：存活不到 5s 判定「秒崩」，退避 10s→20s→40s…封顶 5 分钟；正常跑了一阵子才挂的不退避、立即重启。
- **重命名输入框自适应宽度提为全局共用样式，补齐项目模板改名遗漏**（`assets/styles/global.css`、`views/Projects/components/{ProjectModal,NewProjectModal}.vue`、`views/Dashboard/components/FilePanel.vue`、`views/Files/index.vue`）：项目模板改名输入框此前用 `flex:1` 撑满整行，不像其它三处那样随文字自适应宽度，根因是自适应实现在多个文件里各自本地复制、新增时漏抄。提到 `global.css` 做唯一共享定义，统一类名。

## [0.15.1] - 2026-07-01 · 日历磨砂玻璃白带根治（GlassBg 活玻璃）+ 交互反馈打磨 + 视图切换图标修复

> 收尾 0.15.0 日历周视图后的一批体验修复：顶栏/日历工具栏磨砂玻璃在 hover 时闪「白带」根治（改用不依赖 backdrop-filter 的 `GlassBg` 活玻璃）；快速点击面板「变暗」修复；月/周/全天/日期头的 hover 与选中统一为淡入淡出 + 可叠加、点击不再闪现旧态；文件库/项目卡「网格·列表」切换图标被 flex 挤压变小修复。

### 修复

- **日历磨砂玻璃「白带」根治 + `GlassBg` 活玻璃组件**（`layouts/DefaultLayout.vue`、`views/Calendar/index.vue`、`components/common/GlassBg.vue`）：顶栏与日历工具栏在 hover 时下沿闪白带，改用不依赖 `backdrop-filter` 的 `<GlassBg>` 根治，并把日历各 hover/高光改为合成层友好的 opacity 叠层。详见 [devlog.md](docs/devlog.md) 2026-07-01 条目。
- **日历快速点击/切换面板「变暗」修复**：真因是 `.glass-card:hover` 的背景过渡在快速交互时掉帧、`cal-main` 背景朝基态淡回。中和 `cal-main:hover`，与基态一致、无可闪变化。
- **日历 hover/选中统一淡入淡出 + 叠加**（月/周/全天/日期头四处一致）：悬停与选中反馈改为 opacity 淡入淡出、可叠加（悬停已选中格 = 相加变深），并给全天区补上悬停高亮、日期头拆成选中/悬停两层。
- **日历点击选中不再「先变淡 / 闪现旧格」**：全天/日期头/月格的 mousedown 不再提前清空选区（只有真拖到别的天才进 range 选择），单击直接切到选中暗色；月视图多选后点单日不再闪现上一个单日格。
- **周视图交互优化 + 右键菜单精简**（`views/Calendar/index.vue`）：单击/拖选小时格改为只做格子选中，同一格二次单击才弹添加活动弹窗；顺带修复弹窗一闪而过的问题（`mouseup` 打开弹窗后紧跟的 `click` 被误判成点击外部随即关掉）。右键菜单按区域精简为「新建项目」/「新建活动」。
- **文件库 / 项目编辑卡「网格·列表」切换图标变小修复**（`views/Files/index.vue`、`views/Projects/components/ProjectModal.vue`）：工具栏拥挤时 `.view-toggle` 被 flex 挤压，带 `viewBox` 的 SVG 图标随之缩成 2~3px（首屏/从别页回来布局最紧时最明显）。给切换组 + 按钮 + 图标加 `flex-shrink: 0`。

## [0.15.0] - 2026-07-01 · 日历周视图 + 咕咕相处方式重构（反思驱动 stance）+ 前端 TS 迁移 + 定时推送进 IM 会话

> 日历新增周视图（时间轴，含全天/日期多日框选 + 右键新建项目/活动）；咕咕相处方式从「爱推进」重构为反思驱动的 stance 行为模块 + 感知误读案例收集器；前端搭起 TS 工具链并迁移 api/stores/composables/utils/Calendar（`src` 已无 `.js`）；定时推送/主动消息现在写进 IM 会话历史（用户回复能接上上下文）+ 加粗小标题渲染兜底。

### 新增

- **日历周视图（时间轴）**（`views/Calendar/index.vue`）：工具栏加「月/周」切换。周视图为时间轴布局，左侧 0–23 点刻度 + 周一~周日 7 列，有时间的活动按 `time/end_time` 摆成色块（重叠自动并排分栏），全天行显示跨天项目条。支持拖空白建活动、拖动活动块改日期/时间、拖上下边缘改起止时间。

- **周视图：全天/顶部日期多日框选 + 右键菜单**（`views/Calendar/index.vue`）：全天区与顶部日期格支持横向拖拽多选（复用月视图 rangeSelect/activeRange）；右键菜单按区域智能显隐——全天/日期区「新建项目」、小时区「新建活动」。日选择与时段选择互斥。

### 改进

- **默认问候接入感知：从「催人门卫」变「热络老友」**（`agent/greeting.py`）：原 prompt 明写「优先挑最近在推进的项目提」，一开口就催。系统性重做——项目/日程从必提清单降为可选话头且只问体验角度、读 per-user stance 定口吻、已完成项目和过去事件从上下文剔除不再查岗、结尾主动递一个轻话头。
- **咕咕相处方式重构：persona 纯人格 + 反思驱动 stance 选行为模块**（`prompts/persona.md` + `prompts/behaviors/*.md` + `agent/behaviors.py` + `memory/{store,reflection}.py` + `context/builder.py`）：解决「总爱把对话往推进项目上带、想闲聊时没闲聊感」。persona 瘦身为纯人格，相处行为抽成独立模块（`baseline`/`companion`/`execution`/`record`/`query`/`reflect` 等），模块选择从「正则猜本句」改为反思（异步 LLM）产出的 stance 驱动。详见 [docs/agent/10-感知系统.md](docs/agent/10-感知系统.md) §2.6。
- **错读需求案例收集器 + companion 松绑（感知系统续）**（`memory/reflection.py` + `prompts/reflection.md` + `behaviors/companion.md`）：反思检测到感知误读纠正时，吐脱敏的结构化诊断 `miss{read_as, actual, pattern}`（固定枚举、零泄漏），持久化进全局 md + admin 下载端点，后台 Perception 面板加「错读案例」预览栏，给后续「需求发现闭环」攒燃料。`companion` 松绑，区分真上心帮忙与生产力式硬推。详见 [docs/agent/10-感知系统.md](docs/agent/10-感知系统.md) §11。
- **前端引入 TypeScript 工具链 + api 层迁移（JS→TS 阶段 0+1，纯内部、无用户可见变化）**（`frontend/tsconfig.json` + `vite.config.js` + `services/api.ts` + `types/api.ts` + `package.json`）：为渐进式 JS→TS 迁移搭好地基——`tsconfig` 以 `strict:false` 起步只查新写的 TS，`npm run typecheck` 作类型门禁；`npm run gen:types` 用 `openapi-typescript` 从后端 OpenAPI 生成入库的类型文件，`services/api.js → api.ts` 泛型化。约定：新代码一律 TS，改到的 JS 顺带转、不主动批量重写。详见 [docs/product/前端-JS转TS迁移指南.md](docs/product/前端-JS转TS迁移指南.md)。
- **导航栏文字对比度提升**（`components/common/NavItem.vue` + `AppSidebar.vue`）：导航项默认文字 `rgba(30,32,40,.62)→.8`、hover `.82→.92`，分组标题 `#8a8fa8→#6e7289`，可读性更清晰（「即将上线」占位项仍保持淡、表示禁用）。
- **Calendar 视图迁移到 TypeScript**（`views/Calendar/index.vue` → `<script setup lang="ts">`）：JS→TS 迁移延续，vue-tsc 0 错。

### 修复

- **续聊（重开浏览器接续上次对话）时不再闪默认问候**（`components/common/GuguChat.vue`）：`animateGreeting` 在 `loadSession` 异步加载完替换消息之前就把问候占位打了出来，导致「续聊的旧对话」与「问候」同时出现。改为续聊时立刻清空问候占位。
- **周视图活动 409 冲突误用未定义的 `loadEvents()`**（`views/Calendar/index.vue`，TS 迁移时 vue-tsc 抓出的真 bug）：改为 `fetchEvents()`，原会在「活动已被他人修改」的刷新路径上运行时抛错。
- **定时推送/主动消息现在进 IM 会话历史**（`app/scheduled_tasks.py` + `agent/runner.py`）：之前定时任务走 `run_ephemeral` 直发 IM、推送从不进会话历史，用户回复时咕咕零上下文（发完新闻速览、用户回「4」不知道指什么）。改为投递成功后把推送 append 到该用户 IM 最近会话。
- **加粗小标题 `** 标题**`（`**` 后带空格）不渲染加粗**（`components/common/GuguChat.vue`）：模型有时把加粗写成 `** 标题**`，`**` 后带空格是无效 md、marked 原样输出。`renderMd` 前加 `fixLooseBold` 在代码块之外去掉成对 `**` 内侧紧邻空格。

## [0.14.3] - 2026-06-30 · 日历提醒完整体系 + 文件库 UX 打磨 + DeepSeek 思考可调 + 工具错误脱敏

> md 任务清单可交互、日历活动时间与提醒完整落地（phase 1–3）、工具错误脱敏纵深防御、DeepSeek 思考强度后台可调、文件库多选/拖拽体验对齐、日历已完成项目显示优化。

### 新增

- **md 文件预览任务勾选框可点 + 回存**（`api/v1/files.py` + `viewers/TextViewer.vue` + `services/api.js`）：md 预览里的 GFM 任务清单此前是只读禁用框，现在可直接点勾/取消、即时改文件并持久化。后端新增 `PUT /files/{fid}/content`，前端按文档顺序给每个框打 `data-task`、点击回存并失败回滚。仅 md + 真实文件 id 可交互（聊天附件保持只读）。
- **日历活动时间 + 提醒完整体系**（`models` + `alembic` + `events.py` + `scheduled_tasks.py` + `tools/calendar.py` + `Calendar/index.vue`）：三阶段落地——① 后端新增 `calendar_events.time` + `scheduled_tasks.event_id`（绑定到某活动的提醒），含迁移 `20260629000001`（**生产 pull 后需 `make migrate`**）；② 网页 UI 加时间输入、编辑面板内「提醒」区可直接建提醒；③ 咕咕新增 `add_event_reminder`/`list_event_reminders`/`remove_event_reminder` 工具，能像网页一样管理活动提醒。

### 安全

- **工具错误信息脱敏（防原始异常透传泄露）**（`agent/tools/base.py`）：在工具执行唯一咽喉 `registry.dispatch` 加 `sanitize_error()` 兜底，抹掉路径/UUID/DB 连接串/API key/traceback，一处覆盖全部工具。原始异常仍进服务端日志，排查不丢。详见 [docs/security/安全-工具错误信息脱敏.md](docs/security/安全-工具错误信息脱敏.md)。

### 改进

- **DeepSeek 思考强度（reasoning_effort）后台可调 + 缓存命中监控**（`config.py` + `agent_admin.py` + `agent/core.py` + `Admin/Agent/index.vue`）：后台「Agent 配置」新增 DeepSeek 思考强度调节控件，修复 create/update/activate 三处字段同步不一致导致「面板保存了却不生效」。并采集 `prompt_cache_hit_tokens`，openai 路缓存命中可观测。
- **DeepSeek 思考开关真正生效 + 反思走结构化输出**（`agent/llm_select.py` + `agent/core.py` + `agent/memory/_llm.py`）：新增 `supports_thinking_toggle`，把思考开关扩到 DeepSeek；记忆/反思 `complete_json` 对 DeepSeek 开结构化输出 + 关思考，避免推理挤占 `max_tokens` 截断大 JSON。

### 体验

- **文件库多选拖拽 UX 完善**（`usePhysicsDrag.js` + `Files/index.vue` + `ProjectModal.vue`）：文件夹与混合选中拖拽时出现折叠堆叠动画、混合拖拽 drop 同时移动文件夹和文件、文件夹 Shift 范围多选（修复无锚点时误导航 bug）、选中样式与拖拽克隆视觉统一。两个面板全局生效。
- **日历已完成项目显示优化**（`Calendar/index.vue` + `preferences.js` + `ProfileModal.vue`）：已完成项目不再延伸到截止日，改为显示到实际完成时间（`done_at`）。个人设置新增「已完成项目显示」开关，可在按完成日（默认）/按截止日间切换。

### 修复

- **中断生成不再误报「没有收到回复」**（`GuguChat.vue`）：`consumeStream` 捕获 `AbortError` 后返回 `aborted: true`，`send()` 检查该标志跳过兜底错误气泡。
- **日历月视图溢出格单日活动不显示**（`Calendar/index.vue`）：月视图首/末行溢出到上/下月的格子，其单日活动此前因 `extraEvents` 只按当月加载而匹配不到。新增 `spilloverEvents` 取上月 + 下月活动合并去重。

## [0.14.2] - 2026-06-29 · 防「说了没做」意图守卫（A-lite+B 的 B）+ mimo 深度思考可与多轮工具共存 + 反思走 json_object 结构化输出 + 个人设置 UI（重开接续 / 接入咕咕独立面板）

### 改进

- **意图守卫：治「说了要做却没动手」（咕咕"我去查一下"然后停住）**（`agent/core.py`）：回复循环里「自由文字+无工具=终止态」，模型随口宣告意图就触发结束。新增确定性守卫 `_announces_intent`，检测「我去/我来/这就…+ 查/搜/建/改」这类将来式宣告且本轮零工具，逼一轮当场调工具；问句/征询硬排除，只追一次不死循环。详见 [docs/agent/31-多步执行与防停顿.md](docs/agent/31-多步执行与防停顿.md)。
- **mimo 深度思考可与「多轮工具调用」共存 + 记忆/反思走结构化输出（json_object）**（`agent/core.py` + `agent/memory/_llm.py`）：mimo 文档硬性要求多轮 Function Call 必须把上一轮 `reasoning_content` 完整回传，否则 400，而 openai 路此前完全没读它，开思考时多步调工具就会 400。现在流式里捕获并在所有 assistant 回填点统一带回；记忆/反思对 mimo 开 `response_format=json_object` + 关思考，避免大 JSON 被推理挤到截断。仅 mimo 生效，其它厂商行为不变。
- **个人设置：加「重开浏览器接续上次对话」开关 + 接入咕咕独立成面板**（`ProfileModal.vue` + `GuguChat.vue`）：新增「重开浏览器接着上次 / 开新对话」开关（默认开新，会话 id 存 localStorage 跨浏览器留最近一段）；把「接入咕咕」（飞书/QQ/微信扫码连接）从「咕咕设置」面板拆出单独成一个 nav 面板。

## [0.14.1] - 2026-06-29 · prompt 缓存真正生效 + 独立语音识别模型 + 密码找回 + IM 发图/多图修复 + 缩略图/拖拽/定时等体验打磨

### 新增

- **密码找回（邮件重置链接）**（`api/v1/auth.py` + `ForgotPassword`/`ResetPassword` 页）：`POST /auth/forgot-password` 生成一次性 token 存 Redis（30 分钟 TTL）并发重置邮件，邮箱不存在/冷却中都返回同一句防枚举；`POST /auth/reset-password` 校验 token 后改密并删除。登录页加「忘记密码？」入口。
- **独立语音识别模型（与主模型解耦）**（`settings.voice` + `agent/voice.py`）：语音/音视频转写改用独立配置的 ASR 模型把音频转成文字再交主模型处理，主模型不再被强切 mimo（根治「主模型非 mimo 时媒体块被静默丢弃、语音被当文件」）。Admin「Agent 配置」加语音模型卡。
- **IM 连发多图聚合 + 微信图片接收**（`worker.py` + `agent/adapters/wechat.py`·`qq.py`）：QQ/微信「一张图一条消息」，连发的图+指令本是一次表达。worker 加输入防抖，静默 1s 才把缓冲里所有消息合并成一轮处理、只回一次；网关侧 ack 秒回加 10s 冷却。微信图片接入：下载 CDN 图片后 AES-128-ECB 解密，接上 QQ 同一链路。

### 改进

- **MiniMax/Anthropic prompt 缓存真正生效 + 多轮工具滚动缓存**（`agent/context/builder.py` + `agent/core.py`）：原先把整段 system 当一个 `cache_control` 块，但 system 末尾的「当前时刻」精确到分钟、加上每轮变的记忆/行为模块，整块每轮就 miss，缓存几乎白打。改为 system 拆成「稳定前缀┃动态后缀」两块，只缓存不变的稳定前缀（实测 ~12.5K 字）；并给多轮工具循环加滚动缓存断点。mimo 不支持缓存跳过、openai 通道 strip 掉标记。
- **skills.md 瘦身：situational 剧本抽成按需 skill**（`agent/skills/`）：把 `prompts/skills.md` 里三块针对性 how-to（项目规划、定时任务、接入 IM）抽成按需 `use_skill` 拉取的 skill，skills.md 只留主动触发+安全红线的短指针，常驻 prompt 省 ~600-1000 tokens。安全红线（真实性铁律、删除两步确认）仍常驻不拆。
- **文件操作 how-to 抽成按需 skill + 编辑后反馈「改了啥」**（`agent/skills/file-ops.md` + `agent/tools/files.py`）：继续 skills.md 瘦身，把文件操作 how-to 抽成按需 `use_skill 文件操作`。并让咕咕编辑文件后一句话反馈改了什么——`edit_file` 回执新增 `change` 摘要，不再只说「改好了」。
- **项目规划更克制**（`agent/skills/project-planning.md`）：推进项目时主动让状态跟上进展（规划完/开始动手就从「待开始」转「进行中」，全部做完先问确认再标「已完成」）；默认精简、别甩一面墙（阶段宜少、每段只列关键待办，详细按需展开）；待办本就可选；同类型项目尽量同色系。
- **实时刷新通用模板 + 定时面板补实时**（`composables/useLiveRefresh.js`）：抽出 `useLiveRefresh(资源, fn)` composable 作为「资源变更 → 刷新」的统一订阅入口，替代各处手写 `watch(rev.X, fn)`。并把定时任务做成 live 资源，咕咕在 web/IM 建/改/删都实时推到网页定时面板，不用手动刷新。

### 修复

- **「咕咕开小差了」——MiniMax 偶发流式解析崩**（`agent/core.py`）：MiniMax 偶尔返回空/异常的流式响应，导致 anthropic SDK 解析时 `IndexError`/`KeyError` 越界，而这俩不在可重试集、直接降级兜底。把它们纳入 `transient`，出第一个 token 前退避重试，重试用尽才降级。
- **重命名图片后没缩略图 + 文件库/项目卡滚动严重闪屏**（`composables/useThumbCache.js` + `useLazyThumb.js` + `views/Files/index.vue`）：批量重命名触发缩略图请求瞬时爆发，并发限流器被卡住/超时的请求占死，而懒加载指令单次尝试失败不重试，图永久空着导致滚动严重闪屏。三处修：`fetch` 加超时释放槽位、懒加载指令加有限重试、去掉常驻 `will-change`。
- **抓文件拖拽出现浏览器默认「小地球」favicon**（`composables/usePhysicsDrag.js` + `views/Files/index.vue` + `Projects/components/ProjectModal.vue`）：物理拖时先 `setDragImage(卡片)` 又设透明 ghost，部分浏览器只认第一次 setDragImage、源卡随后被隐藏导致拖影变空。改为走物理拖时不再设卡片为拖影，让离屏挂载的透明 ghost 当唯一拖影。
- **IM 发图咕咕「看不到 / 没回复」**（`agent/runner.py` + `sanitize.py` + `core/chat_attach.py` + `llm_select.py`）：三层真因——① 图片识别崩溃：变量覆盖导致 `voice.transcribe` 被误传字符串崩溃（凡喂图必崩），改名根治；② IM 路从未调 `sanitize_messages`，SDK 响应残留非标字段触发 MiniMax 严格校验 400，`run_collect` anthropic 路补上；③ vision 门控改用这轮真模型，去掉「带图强切 vision 模型」的硬切逻辑。
- **保存上传附件传项目名当 id 直接崩**（`tools/files.py`）：`_as_int`/`_i` 解析失败返回原字符串而非 None，导致非数字项目名流进整数主键查询直接崩溃。改成失败返 None，由上层干净报错让模型用 `list_projects` 拿 id 重试。
- **语音 ffmpeg 找不到（进程 PATH 收窄）**（`agent/voice.py`）：裸 `"ffmpeg"` 在 setsid/systemd 起的进程里 PATH 找不到，导致转码失败、语音识别不了。复用 `media_transcode._ffmpeg_bin()`（PATH 找不到时绝对路径兜底）。
- **网关把「嗯/好」等确认吞掉**（`agent/router.py`）：IM 网关原先用关键词把「嗯/好/谢谢」这类 ACK 短路回复或直接 drop，吃掉用户真实意图（如咕咕说「我去查」后用户回「好」被吞）。去掉这一类 ACK 短路，改交主模型据上下文回应；斜杠命令、忙时进度追问/取消等其它短路逻辑保留。
- **说要查却不查（只口头宣告不执行）**（`prompts/skills.md`）：「有没有 X 新闻 / 帮我查 Y」时咕咕回「我去查一下」就结束这轮，干等用户再问「查了吗」才动手。强化提示词：说了要查/要做就这一轮真发出工具调用。
- **要提醒却没真建定时任务（只口头答应 / 谎称已建）**（`prompts/skills.md`）：用户明说「中午提醒我修 bug」，咕咕回「好~12点提醒你」却没调 `create_scheduled_task`，甚至事后谎称「我新建了」。根因是旧指针对已明确的提醒请求也走「先确认一句」流程。改为明确要提醒的请求这一轮立刻建好，拿 success 再回话；红线绑死到话术，工具没成功前不许说「已设好提醒」。
- **一次性定时任务过期不自动清理**（`app/scheduled_tasks.py`）：正常触发的 `@once` 任务由 `execute_task` 即时删除，但停用/misfire 没触发的过期任务无人回收，会一直僵在面板里。`reconcile` 新增 GC，过点约 2 分钟后自动清理；`GET /scheduled-tasks` 读时也顺手清一遍，worker 滞后时面板也不留残留。
- **久置标签页切回来卡死约 1 秒**（`stores/live.js` + `stores/filesCache.js`）：标签页放后台久了 SSE 断开，切回前台重连时一次性 `bump` 全部 5 个资源 → filesCache / projects / calendar / sessions / clients 同时 refetch + 替换大数组 + 重渲染，挤在一两帧 → 卡主线程。改：重连补刷**错峰逐个 bump**（延后 300ms 起、每 250ms 一个），把这波刷新摊开、让出主线程（总量不变、不挤一帧）。（曾顺手给 filesCache 的 `rev.files` 加版本门控省刷新，但 `/files/version` GET 可能被缓存 → 拿旧版本号 → IM 存文件后项目卡片文件数不实时更新，已回退、保持无条件 refresh。）
- **`systemctl` 重启后端起不来、每次要手动 `pkill`**（`scripts/dev-restart.sh` + `deploy.md`）：根因是 8000 端口同时被 systemd 与手动 uvicorn**两个主人**抢，`systemctl restart` 停不掉非 systemd 的那个 → 绑不上端口死循环。立「一台机 8000 只一个主人」铁律：生产给 `gugu-backend.service` 加 `ExecStartPre=-/usr/bin/fuser -k -n tcp 8000` 自愈腾端口（`systemctl restart` 再不用手动 pkill）；dev 机 systemd 保持 disabled、用新增的 `scripts/dev-restart.sh`（免 sudo、自带腾端口）一条命令重启 web/worker/supervisor。
- **接入 IM 按钮漏微信**：咕咕给扫码绑定按钮时只发飞书 / QQ、漏了微信，现补齐微信。
- **拖到「已完成」没勾完待办**（`stores/projects.js`）：项目卡拖到已完成列时自动勾选所有阶段的全部待办——`moveProject` 进 done 分支原只推进 `currentStage` + `progress=100`、没勾 todo 也没把 stages 传后端。补：深拷贝 stages、未完成 todo 设 `done`+`autoCompleted`（快照原状态随 patch 存），与 `setStage` 同一约定，拖回进行中自动复原。
- **网页语音咕咕「听不到」（IM 正常）**（`core/chat_attach.py` + `agent/voice.py`）：两层卡点——① chat_attach 的 `native` 格式门控只放行 mp3/m4a/wav/ogg，**Chrome 录音是 webm**（`_recExt` fallback），不在白名单 → 媒体块根本不建、连 transcribe 都没调到（IM 语音在网关已转 mp3、是原生的，故畅通）。改：配了语音识别模型时音频/语音不再要求原生（`fmt_ok = native or (voice_ok and not is_video)`），交下游 ffmpeg 转。② 就算放行，Safari 的 `audio/mp4` 送到 mimo-v2.5-asr（只收 wav/mpeg/mp3）会 400 `Param Incorrect` → `voice.py` 转写前凡 mime 不在白名单的，用 **ffmpeg** 转 16k 单声道 wav 再送（输入走临时文件，mp4 的 moov 在尾部需可寻址）。现 Chrome/Safari 网页录音 + QQ/微信 amr 全覆盖。
- **邮件系统：配置「不保存」+ 发件人填名字崩**（`core/config.py` + `services/email.py`）：① `apply_override` 的「顶层字段」兜底循环排除集漏了 `smtp`、`voice` → 这两段先被各自处理块构造成对象、又被原始 dict 覆盖回 → `settings.smtp/voice` 变 dict、后台读出当空配置（看着像没保存）、发信用空配置发不出。补进排除集即根治。② 后台「发件人」常被填成显示名（如「咕咕」）而非邮箱，旧逻辑直接当地址塞进 From → 信封发件人 `<咕咕>` → smtplib `MAIL FROM` 按 ASCII 编码崩。`_resolve_from`：含 `@` 才当地址，否则当显示名、地址退回登录账号；中文主题 / 发件名走 `EmailMessage` 自动 RFC2047 编码。
- **网页语音发出后先显示成文件卡、刷新才变语音条**（`GuguChat.vue`）：`send()` 拼乐观用户气泡时 `files.map` 漏了附件的 `kind` / `duration`，而语音条靠 `f.kind==='voice'` 判定 → 补上即解。
- **语音 API Key 看着「没保存」**（`stores/config.js` + Admin/Agent）：key 实际存住了，但后端脱敏成 `****`、前端又清空显示 → 字段永远空、看着像没存。`config` store 记录后端是否已有 key（`secretSet.voiceApiKey`），面板据此显示「· 已配置 ✓」+ 动态占位。
- **后台页滚动闪动**（`layouts/AdminLayout.vue`）：`.admin-main` 既是 100vh 滚动容器又用了 `background-attachment: fixed`，渐变被钉在视口、滚动时每帧重绘整块导致闪动。去掉该属性（元素本身就是视口高的滚动容器，默认 `scroll` 已让背景相对自身固定，视觉一致且无重绘），所有后台页共用此布局。
- **录音条与按钮没对齐**（`GuguChat.vue`）：`.rec-bar` 没设高度、靠 padding 撑出约 22px，比 28px 按钮矮，底对齐时内容偏低。设成与按钮等高（28 / 放大态 32）、内容居中。

## [0.14.0] - 2026-06-29 · 感知系统（遥测/行为模块/解读先验）+ 记忆 2b（结构化 facts/事件总线/控制命令）

> 本版两根主线：① 给决策环最上游的「感知」装上**可观测 + 可 per-user 成长**的体系——A+B 感知遥测 + 误判捕获 + Admin 诊断面板 / 情境行为模块库 / per-user 解读先验 lens，**观测与学习全在异步反思里、零聊天延迟**；② 记忆补齐 **Phase 2b**——facts 升级为带置信/重要度/时间衰减的结构化 `facts.json`、反思增量化、事件总线、`/memory`·`/forget` 控制命令。外加 IM 跨 session 续接、会话一句话总结、在线/离线状态、一轮时区显示统一。

### 感知系统 P0–P2（新子系统，详见 [docs/agent/10-感知系统.md](docs/agent/10-感知系统.md)）

把「感知用户要什么」从隐式变显式、可观测、可学，全程不给聊天热路径加 LLM 跳。

- **P0 · A+B 感知遥测 + 误判捕获**（`memory/reflection.py`）：反思多吐 `perception`（intent/ambiguity/emotion）打日志 + 推 Redis；Admin「感知诊断」面板按活跃用户宏平均聚合误判率/意图分布，阈值可调。误判捕获从「正则关键词」升级为反思 LLM 顺带判定 `correction:{is_correction, kind}`，区分「感知误读」与「数据执行错」，判定原则钉死「谁错了」（只认咕咕自己理解错，用户自认错/第三方错/外部信息源错均不算）。
- **P1 · 行为模块库**（`agent/behaviors.py` + `prompts/behaviors/`）：从 persona 抽出三个情境策略模块（`emotion-first`/`stuck-first`/`decision-explore`），由本句线索软点亮、零前置 LLM，情绪在场优先接情绪不叠加任务型模块。
- **P2 · per-user 解读先验 lens**（`agent/memory/lens.py` + `.agent/lens.json`）：第 5 类记忆「怎么读懂这个用户」的偏置规则，事件驱动吃反思 `lens_hint`，防过拟合双闸（候选须复现 2 次才提拔），confidence 带半衰期衰减。

### 记忆系统：结构化 facts（2b）+ 增量化 + 时间衰减 + 事件总线 + 控制命令

- **反思跳过的修正：确认轮带动作也反思**（`memory/reflection.py` `schedule`）：原本「嗯/好的」这类纯应答词整轮跳过反思，但若这轮咕咕真用了工具（如「要建项目吗？」→「嗯」→真建了），现在即便用户只回「嗯」也反思，记下这轮做了啥。判据是本轮有没有动作而非消息长短。
- **facts 结构化（2b）**（`memory/store.py` `facts.json`）：facts 从 markdown 行升级为结构化条目，带 `kind`（observed/inferred）/`conf`/`imp`/`ts`。observed 不衰减，inferred 按半衰期 45 天淡出，旧数据自动迁移。
- **反思增量化（2b · delta）**（`memory/reflection.py`）：反思只吐增删、不再回显整份 facts，根治「facts 一多 → 回显超 `max_tokens` → 截断解析失败 → 老用户反思全废」的隐蔽坑。
- **事件总线（2b）**（`agent/events/bus.py` + `types.py`）：轻量异步发布/订阅，反思/`remember`/`/forget` 在 facts 变更后 `publish`，成就/分析等下游以后挂 listener 即可。
- **记忆控制命令（2b）**（`agent/commands.py`）：聊天里直接打 `/memory` 看咕咕记得哪些事、`/forget <内容>` 忘掉一条 fact，确定性短路、零 LLM、不计精力。
- **summary 时间衰减**（`agent/decay.py` + `store`）：summary 按半衰期 5 天权重换话术档（新鲜直接给/半旧标"约 N 天前"/过时标"多半过时"），过期状态不被当成近况。

### 跨 session 续接修复（IM「没续上之前的聊天」）

IM 会话是 12h 滑动 TTL，过期会起新空会话，咕咕丢掉上一条上下文续不上。三处一并修：

- **`read_conversation` 取最近而非最旧**（`tools/conversations.py`）：原逻辑升序+limit 返回的是最旧 N 条，改 DESC 取完再正序。
- **IM 新会话「续接桥」**（`runner._im_continuity_bridge`）：新会话开场注入上一条对话的一句话总结指针；用户这句带「继续/刚刚/上次」等续接词时，直接把上一条尾部几轮塞进上下文。超 48h 不注入。
- **默认问候优先最近项目**（`greeting.py`）：上下文里「最近在推进的项目」提到最前，治「记忆里聊过的旧项目被当成『最近在忙』」。

### 新增：会话一句话总结（`conversation_sessions.summary`）

每个会话存一句「这段聊了啥」，供跨 session 查找 + 续接桥指针。后台 fire-and-forget 生成（新会话出一版、之后每 ~6 条刷新），不计精力；`search_conversations` 列表/搜索带上。新增 `summary` 列 + 迁移 `20260628000001`。

### GuguChat 在线 / 离线状态

未接入任何 IM（微信/QQ/飞书）时状态显示「离线」（原硬编码恒「在线」），点击展开大窗并摊开 IM 抽屉露出「扫码连接」，引导接入。

### 修复 / 其它

- **时区显示统一**：聊天气泡与后台各面板时间偏 8 小时修复，新增 `app/core/tz.py` 统一时区处理，消除各模块散落的硬编码 `timedelta(hours=8)`。
- **服务状态脱敏**：隐藏 PID / 主机名 / 网关所属用户名，定时任务列表只显示数量。

## [0.13.2] - 2026-06-28 · 微信接入 + 记忆四层 + 音视频·语音 + 精力修复 + 体验打磨

> 本版核心：新增**微信接入**（个人微信官方 iLink Bot，扫码自连，模式同飞书/QQ）；记忆补到**四层**（facts / daily / memory / **summary 当前状态快照**）；咕咕能**听 / 看音视频**（mimo 多模态 + IM 语音转码）、语音做成可播放**语音条 + 30 天存储**；修了一批 **Agent 可靠性**问题（联网不虚构 / 交叉验证、未来任务主动确认设定时、IM「确认用的嗯」被吞、用 QQ 聊却说没绑定）；**精力配额**修了「100% 仍拦不住」（封顶截断 + IM 漏判）与时区（UTC→CST）；外加拖拽实时让位、文件按状态分组、决策轨迹脱敏、DAU→WAU 等体验与后台打磨。

### 接入微信（个人微信 · 官方 iLink Bot）

咕咕可接入个人微信：走微信官方 iLink Bot API（扫码授权 `bot_token` → long-poll 收 + HTTP send 发），非逆向、无封号风险，模式同飞书/QQ 的 BYO 扫码自动连接。新增 `adapters/wechat.py`/`wechat_client.py` 网关+客户端、`api/v1/wechat_connect.py` 扫码连接端点、`ProfileModal` 微信扫码入口。MVP 限文本（图片/语音后补）。

### 记忆新增 summary.md（当前状态快照「用户现在在做什么」）

记忆从三层补到四层：facts（稳定身份）/ daily（流水）/ memory（长期）之外，加 `summary.md`——一段「用户此刻在忙什么」的快照。反思调用输出扩成 `{facts,daily,summary}`，基于原快照增量演进；作为「## TA 最近的状态」注入系统提示记忆块顶部，`greeting.py` 默认问候也优先参考它。

### mimo 音 / 视频理解适配（含模型池路由修复）

让咕咕能真正「听/看」用户发的音视频（mimo 的 OpenAI 扩展块 `input_audio`/`video_url`）：音视频附件 base64 随消息喂给 mimo；QQ 语音（SILK/`pilk` 解码）等经 `ffmpeg` 转码；修复带音视频消息被模型池路由到非 mimo 模型导致媒体块被静默丢弃的问题（改为强制切到 active mimo 模型）。

### 语音消息做成「语音条」+ 30 天独立存储 + 「让我听听」语气

QQ 语音/网页录音不再当文件卡，做成可播放的语音条（`GuguChat.vue`）。语音走 `stage_voice()` 独立 `.voice/` 目录留存 30 天（普通附件仍 6h）；语音分支提示词改成「直接听内容并回应，别问要不要存」；补上飞书语音接入（此前 `audio` 类型被直接丢弃）。

### 红线：不虚构联网信息（交叉验证）+ 未来任务主动确认设定时

- **不虚构联网/实时信息**（`policy.md`）：联网查到什么说什么，绝不在搜索结果之外脑补/外推（尤其赛程/比分/日期/价格），关键事实交叉验证。治咕咕给 F1 赛果时凭单一来源瞎编。
- **未来要到点执行的活 = 定时任务**（`skills.md`）：用户提「明天/X 点/每天 做某事」时先主动确认要不要设定时任务，认可才 `create_scheduled_task`；铁规则「没真建成就别口头答应」。

### 咕咕行为：问候口吻 + 建项目当规划伙伴

- **默认问候据「上次互动」定口吻**（`agent/greeting.py`）：生成问候前查最近一条对话消息的时间，几小时内/今天/昨天绝不说「好久不见」；确实隔了多天才用久别重逢语气。修「刚聊过还说好久不见」的出戏。
- **建项目当规划伙伴，别套模板**（`prompts/skills.md`）：建项目时按项目真实流程拟贴合的阶段和待办，别一律默认「计划/执行/交付」模板。
- **多天/多任务的事倾向做成项目**（`prompts/skills.md`）：旅游/办展/装修/搬家这类倾向做成项目而非只记日历事件。
- **保存/创建文档 ≠ 把文件发给用户**（`prompts/skills.md` + `send_file` 工具描述）：创建文档后一句话告诉用户存到哪个目录，绝不主动 `send_file`，只有用户明确要才发。

### 日历提醒：要提醒就建一次性定时任务（治「空口承诺提醒」）

日历事件本身不会主动提醒，咕咕却常按常识空口承诺「会提前 X 分钟通知」而不真设。`skills.md` 加规则：要提醒必须 `create_event` 后再 `create_scheduled_task` 建一次性提醒，并加铁规则「没真建成就别说会提醒」。

### 修：用户正用 QQ 聊天，咕咕却说「QQ 没绑定、扫码连」

用户在 QQ 上跟咕咕说「QQ 通知我」，咕咕却回「QQ 还没绑定，扫一下连上」，因为系统提示从不注入「当前来源平台/已连 IM 渠道」。系统提示加「## 当前对话来源/通知渠道」块（`builder._source_block`），当前来源平台强制标记已连；`create_scheduled_task` 工具描述同步订正。

### 修：IM 路由把「确认用的嗯」当闲聊吞掉

咕咕问「要删吗/要建项目吗」后，用户回「嗯」确认，却被 Intent Router 当成闲聊短路吞掉，确认永远丢失，根因是路由不知道「咕咕刚问了问题」。新增「等回话」标志（咕咕回复以问句/确认收尾时置 Redis 标记，20min TTL），路由放行时优先判断这轮是否在回答上一轮的提问。

### 修：精力 100% 仍拦不住对话（封顶截断到 0 + IM 漏判）

精力满了却还能继续聊，三处根因一并修：`cap_usage` 按比例缩被 `int()` 截断到 0 导致用量永远填不满上限、硬拦永不触发（改为精确填满剩余额度）；IM/定时任务路径根本没接硬拦（抽出 `quota.is_exhausted` 统一判定）；网页原为 UTC 窗口内联判定，改走同一函数统一口径。

### 修：精力配额与 DAU 统计时区错误（UTC → CST）

- **精力 6h 窗口**（`agent/quota.py`）：`six_h_window_start` 原按 UTC 整点切割（北京 08/14/20/02 点重置），改为 CST 整点（00/06/12/18）。
- **DAU 改为「登录即算」+ CST 今日 0 点**（`admin_analytics.py` / `auth.py` / `models`）：原 DAU 按 `AgentUsage` 统计（须发消息才算）且用 UTC 午夜。改为 `User.last_active_at`，新增字段 + migration `20260627000002`。

### 待办/阶段拖拽升级为实时让位（去动画 + 克隆无底框）

待办与阶段拖拽从 HTML5 drag 升级为指针驱动，拖动时其他元素实时同步让位（不再等落下才重排），待办可跨阶段拖动；去掉让位过渡动画杜绝抖动。`ProjectCard.vue`/`ProjectModal.vue`/`Schedules/index.vue`。

### 项目待办：拖拽排序

项目卡待办弹窗 + 项目编辑卡阶段待办，每条左侧加拖拽手柄，原生 HTML5 drag 重排落库。手柄独立于输入框，点字照常编辑、拖手柄才排序。`ProjectCard.vue`/`ProjectModal.vue`。

### 文件库：项目文件按状态分组（已完成按完成日期归档）

文件库「项目文件」从按 startDate 年/月归档所有项目，改为先按项目状态分组（待开始/进行中/已完成），已完成项目按完成日期归档为年/月/项目，三态文件夹配状态色+图标。纯前端 `Files/index.vue`。

### 日历：已完成项目统一淡化

日历各处（月视图 chip、跨天项目条、当天日程等）的已完成项目统一加 `cal-done` 淡化，退到背景不抢眼，只淡化项目、用户活动事件不受影响。`Calendar/index.vue`。

### 深夜对话时间语境（0–4 点以日出为一天的分界）

凌晨 0–4 点时，`builder.py` 在注入的当前时刻后附加提示：以日出为一天的分界，让咕咕正确理解深夜说「明天」的语义。

### 关闭气泡通知自动标记导航栏已读

通知同时推送导航栏和气泡时，关闭气泡（点 ✕ 或被新气泡顶替）即调 `uiStore.markRead(notifId)` 标记已读。纯 bubble-only 通知（无后端 id）不受影响。

### 聊天内扫码绑定 IM：咕咕直接给按钮

- **问「怎么加 IM」→ 咕咕给可点的扫码按钮**（`prompts/skills.md` + `GuguChat.vue`）：用户问「怎么绑定飞书/QQ」时咕咕输出动作链接当按钮，前端渲染成胶囊按钮，聊天上弹小窗显示二维码，扫码成功自动绑定。复用现有 connect 的 start/poll，后端零改动。

### 前端发版门：新版本自动清过期客户端状态

- **客户端状态版本门**（`utils/clientVersionGate.js` + `main.js`/`admin.js` + `vite(.admin).config.js`）：构建版本号变化时应用启动前清掉 localStorage/sessionStorage（保留登录态与无害偏好），修「发版后旧 localStorage 残留、新代码走旧逻辑」。
- 配套（运维侧，需在 1Panel/nginx 配）：`index.html` 发 `no-cache`、`/assets`（带哈希）长缓存，确保新 JS 真加载、版本门跑到最新那套。

### 登录页底部加备案号与署名

登录页底部绝对定位一行小字：「Created by Claude with love · 苏ICP备2026042185号」，备案号链接工信部查询页。

### 隐私：决策轨迹脱敏（数据最小化）

后台「决策轨迹」原本能看任意用户会话的完整对话原文+工具内容+文件，改为脱敏保留：只暴露决策结构不暴露用户内容。对话正文只给字数、工具结果只留成/败、文件名打码留扩展名、会话标题改「会话 #id」并禁用按标题搜索；`agent.traj` 日志同口径脱敏。仍保留每轮调了哪些工具、落到哪个 id、token、轮次的排查能力。

### 后台分析：DAU 改 WAU，纳入 IM 活跃

活跃指标从「今日活跃（DAU）」改为「周活跃（WAU）」：过去 7 天对话过（网页+IM 都记）∪ 登录过网页，按 user_id 去重。修原 DAU 只看 `last_active_at`、漏掉纯用 IM 不登网页用户的问题。

### 后台 / 数据

- **记录用户 `last_active_at` + 后台活跃统计**（`models` / `auth` / `admin_analytics` + 迁移 `20260627000002`）：User 加 `last_active_at` 列，用户活动时按 1 小时节流更新，后台基于它统计活跃用户。

### 修：delete_project 工具 ImportError 导致 agent 删项目必失败

agent 工具层 `_delete_project` 还在导入已被移除的函数（「删项目改为连文件软删」时清理不彻底），导致任何 agent 删项目请求都以 ImportError 崩溃。改为与 API 端一致：先软删文件再删除项目。

### 其它修复

- **阶段拖拽重排没把待办带走**（`ProjectModal.vue` `commitStageDrag`）：拖拽落下时原本只重排了 `label` 数组，`todos`/`key` 留在原地，表现为「只改了阶段名，待办没跟走」。改成整个阶段对象一起搬。
- **已完成项目取消前面阶段的待办没退出已完成**（`ProjectModal.vue` `saveTodos`）：完成判据只看当前（最后）阶段进度，取消前面阶段的待办时项目仍赖在「已完成」。改成所有阶段全部待办都勾选才算完成。
- **新用户首登弹历史广播、撞新手引导**（`notifications.py` `_visible`）：新用户没补弹记录导致首登必弹一条旧广播气泡、和新手引导欢迎气泡撞车。加「只看注册之后产生的通知」闸。
- **IM 前置路由把话题误当成催咕咕 + 空闲催促答非所问**（`agent/router.py`）：情绪/催词原本子串匹配，「法拉利怎么这么慢」含「怎么这么慢」就被误判成催咕咕而短路，改成句首锚定；催促原本空闲时也短路回复，改成只在咕咕真在忙时才拦，空闲催促交主 Agent 正常回应。

## [0.13.1] - 2026-06-27 · 新手引导系统 + 精力配额硬拦 + 默认问候咕咕生成 + 逐字流式统一

> 本版核心：新增**独立新手引导子系统**（注册播种「活的示例项目」+ claim-once 欢迎/情境/回头看气泡，全静态文案、不依赖 agent）；精力（Token 配额）从「软降级」改为**耗尽硬拦 + 满额封顶/冻结**（精力条不越 100%、满额不污染周精力）；对话默认问候改为**咕咕轻量生成**（带记忆、不计精力、打字机入场）；「咕咕逐字说话」的系统侧文案统一走 `genstream.typed_stream` 流式；外加通知气泡文字/调性打磨、删项目连文件删与弹窗 / UI 细节。

### 精力系统：耗尽硬拦 + 满额冻结 + 逐字流式提示

精力（Token 配额）从「软降级」改为「硬拦」，新增满额冻结与全局逐字流式。详见 [docs/agent/12-精力系统.md](docs/agent/12-精力系统.md)。

- **耗尽硬拦**（`web.py` / `profiles/base.py`）：6h/周配额用尽后不再软降级，改为直接回一句「咕咕累了，休息会儿再来～」并 return，聊天/查询一律不放行。
- **封顶 + 满额冻结记账**（新增 `agent/quota.py` `cap_usage`）：记账前按 6h 剩余额度封顶本轮用量，精力条最多 100% 不越线；6h 已满则本轮不写 `AgentUsage`，web 与 runner（IM/定时任务）两处记账都接。
- **空回复兜底覆盖全模型**（`core.py`）：原空气泡兜底只 gate 在 `is_mimo`，去掉该门，任何模型空正文都兜。
- **逐字流式统一**（新增 `genstream.typed_stream` 通用件）：系统侧成段文案统一改走逐字推送，与正常回复同款动画。

### 对话框默认问候改为咕咕生成（轻量直连 + 打字机动画，不计精力）

打开对话框时那句默认问候，从写死的固定文案改成咕咕在进入全新对话时生成一句，带点记忆、像熟人开口。详见 [docs/agent/proposals/对话默认问候-生成方案.md](docs/agent/proposals/对话默认问候-生成方案.md)。

- **后端轻量生成**（`agent/greeting.py` + `GET /agent/greeting`）：组装记忆上下文后轻量 LLM 直连生成，不走 agent 循环、不计入精力/配额。
- **只在进入「全新对话」时生成**（`useGreeting.js` + `GuguChat.vue`）：`GuguChat` 挂载时据 `SESSION_KEY` 判断，有可恢复会话不生成，无则才后台预取。
- **打开对话框时打字机动画显示**（`GuguChat.vue`）：默认问候改为占位空消息，打开时逐字冒出，与咕咕回复同源。
- **问候纳入对话**（`GuguChat.vue` + `web.py`）：用户回复问候时把已显示的问候随首条消息发给后端，并注入 system prompt 作为「对话开场」（不能只靠前导 assistant 历史，会被 `sanitize_messages` 剥掉），否则模型会把用户对问候的回复当成「对话刚开始」又重新打招呼。
- **兜底池**（`useGreeting.js`）：生成失败时从 5 条静态兜底随机取一条，同样走打字机动画。

### 通知气泡文字统一 + 调性放宽到「个人成长」

- **通知气泡文字对齐 GuguChat 小窗正文**：所有通知气泡正文从 12px/次要色改为与聊天一致的 13px/主色，抽出全局 CSS 变量共用。
- **5s 自动消失收窄为仅教程气泡**（`NotificationBubble.vue`）：只作用于新手引导气泡，IM/后台广播等其它通知恢复留到手动关。
- **调性放宽**（`persona.md` + 文档）：从「面向创作者」放宽到「陪伴个人成长」，面向任何有目标要推进的人。
- **自我介绍不报功能菜单**（`persona.md`）：被问「你能做什么」时别像念说明书罗列功能清单，用一两句像朋友那样说清是谁。

### 新手引导 Phase 3：回头看（完成第 5 个项目）

完成第 5 个项目时咕咕回头看一眼引导项目当初的样子（claim-once 只一次）。至此新手引导 Phase 1/2/3 全部落地。

### 新手引导 Phase 2：情境气泡（7 个「第一次」钩子）

各界面第一次操作时咕咕缓一拍冒一句轻提示——claim-once 在后端，只弹一次、跨设备/重登有效。7 个钩子覆盖文件库/日历/定时任务/阶段推进/新建项目/IM 绑定。顺带修复：新建项目阶段默认值排除播种的教程项目，否则教程模板会污染第一个真实项目。

### 新手引导 Phase 1：注册播种 + 欢迎/引导气泡 + 高亮（独立子系统 `backend/onboarding/`）

新用户首次进来不再是空房间——咕咕提前布置好一个「活的示例项目」并主动打招呼。独立子系统、不依赖 agent，文案全静态随机、不过 LLM。详见 [docs/agent/proposals/新手引导-实现方案.md](docs/agent/proposals/新手引导-实现方案.md)。

- **注册播种**（`onboarding/seed.py`）：建引导项目（三阶段带待办）+ 2 个 markdown 欢迎文件 + 日历活动「和咕咕的第一天」，幂等、一账号一次。
- **自有数据 + claim-once**（`onboarding/models.py` `OnboardingState`）：一用户一行 JSON 状态，各气泡首次 claim 返回随机文案，之后返空，天然只触发一次、跨设备有效。
- **欢迎/引导气泡 + 高亮**（`useOnboarding.js`）：进应用弹欢迎、引导并高亮引导项目卡。
- **老用户隔离 + demo 仅 dev**：没走过新引导的老用户不打扰，`/dev/onboarding` 控制面板仅 dev 环境。

### 项目 / 弹窗 / UI 细节

- **删项目改为连文件一并删除 + 有内容弹确认**（`projects.py` / `ProjectModal.vue`）：原先删项目把文件归位个人空间，改为文件软删、文件夹随 FK 级联删；前端在项目有文件时弹浏览器确认。
- **新建项目卡 / 定时任务卡标题输入框统一**（`NewProjectModal.vue` / `Schedules/index.vue`）：标题框统一为与其余字段一致的样式。
- **GuguChat 附件按钮与发送按钮垂直对齐**（`GuguChat.vue`）：附件按钮补固定高度与发送按钮等高。
- **项目卡悬停高光淡入淡出**（`ProjectCard.vue`）：悬停高光此前瞬间出现，根因是 `linear-gradient` 实现的背景对 `transition: background` 不生效。改为常驻微光+悬停强高光分层，用 opacity 淡入淡出。

---

## [0.13.0] - 2026-06-27 · MiMo接入、可靠性守卫体系、通知系统升级与全面体验打磨

> 本版核心：接入小米 MiMo 双格式模型；Agent 可靠性从「提示词软约束」升级为「代码多层硬守卫」；通知系统落库持久化 + 气泡流式打字机；SearXNG 替代 Tavily 承接通用搜索；对话状态指示动画化并全后台可配；外加文本预览稳定化、一批前端交互与 UI 细节打磨。

### MiMo（小米）模型接入 + 双 API 格式适配

- **后台新增 MiMo provider**（`Admin/Agent/index.vue`）：供应商下拉加「MiMo (小米)」，`mimo-v2.5` 支持看图+深度思考+1M 上下文。
- **API 格式显式可选**（`api_format` 字段）：MiMo 提供 OpenAI/Anthropic 两套兼容 API 可选格式，后端抽出唯一判定口 `llm_select.use_anthropic_for(ai)` 统一聊天/记忆/IM 五处重复逻辑。
- **空气泡根治**：mimo 推理模型偶尔整轮输出落进 `reasoning_content`、`content` 为空导致空气泡。传 `thinking:{type:disabled}` 从源头消除，仍空时追一轮要正文再兜底。
- **修复：MiMo 标题不更新**：标题调用未禁 mimo 的思考，`max_tokens=30` 被思考块吃光导致标题空。改传 `thinking:disabled`。
- **修复：流式首条空气泡**（`genstream.py`）：生成的头几个 token 在订阅建好前被 publish 掉丢失。新增 `open_subscription()` 先 attach 再启动生成。

### Agent 可靠性：多层硬守卫体系

实战逮到「说了没做」「复制落错位置」「update 谎报成功」等多类执行幻觉，从代码层面硬化：

- **跨项目复制/移动落错位置**（`tools/files.py`）：未指定 folder 时默认继承源文件夹，实际落回原地。抽 `_target_loc` 统一定位，跨项目又没指定 folder 时落目标根目录。
- **update 类工具杜绝空转报成功**：`update_client`/`update_event`/`update_scheduled_task`/`update_todo` 没提供任何改动字段时改返回错误，不再空转谎报 success。
- **核实轮强制真查**（`core.py`）：核实轮只嘴上说「没问题」却没真调查询工具时，强制再追一轮真调工具查证，防「凭印象说做完了」。
- **narration / 完成断言检测**（`core.py`）：检测模型用文字假装读/改文件却没真调工具，收窄到只收强 CRUD 动词避免误触发。
- **决策守卫**（`core.py` `_is_decision_dodge`）：用户消息含改动命令+回复含「不用改」+本轮零工具，三信号齐备时逼执行或问清。
- **`edit_file` 差异校验**（`files.py`）：原文 ≥200 字且改后 <50% 时加 `warning`，逼模型读回核对。
- **工具调用轨迹日志**（`tools/base.py`）：`registry.dispatch` 每次落一行 JSON 到 `agent.traj`，排查一目了然。
- **工具注册契约 fail-fast**（`SkillRegistry.add`）：重名/空名等违规启动期即抛错，不留到运行时。
- **可靠性架构文档**：新增 [docs/agent/03-可靠性.md](docs/agent/03-可靠性.md)（Execution Verifier：信 Tool 不信 Assistant）。

### Agent 人格与知识边界

- **记忆边界：根治「伪个性化幻觉」**：空记忆/新用户下咕咕会硬编「你之前聊过 X」。`persona.md`/`policy.md` 加「不虚构共同历史」红线，空记忆时注入锚点提示别假装记得共同经历。
- **emoji 红线：输出层确定性兜底**：persona 明令不用阴阳/情绪表情，但活泼语气下照冒（token 级习惯，prompt 治不了）。`sanitize.strip_disallowed_emoji` 白名单制之外的 emoji 一律删，挂三出口。
- **不确定就主动查证**：去掉 `skills.md` 的「省工具」框架，`persona.md` 加「不确定就去查证，别糊弄」，限定在新词/热梗/近期事件。
- **看图信自己的眼睛**：被问「这是谁」时咕咕会反射性联网搜索「核实」，但网页搜文字帮不了认图。`persona.md` 加「看图类问题凭看到的直接答」。
- **对外口径：堵住工具名泄露**：`policy.md` 补禁用名单，只用能力说法答不报工具名。
- **语气和善底线**：`persona.md` 新增「和善底线」——纠正方案不纠正人、归因到事实而非人、把选择权交还用户，与语气/长度偏好设置衔接。

### 联网搜索分层：SearXNG（通用）+ Tavily（深度）

- **`web_search` → 自建 SearXNG**（`tools/search.py`）：通用搜索免费无配额，国内固定带 `sogou/quark/360search` 避开被墙引擎，后台可配地址/引擎+测试按钮。
- **Tavily → `deep_research`**：原 `web_search`(Tavily) 改名，定位「读网页正文+总结/比较/研究」，保留每日次数配额。路由准则：普通查找走 SearXNG，需读正文走 Tavily。
- **prompt skills 系统**（新 `agent/skills/`）：带触发条件的「剧本」md，按需加载，builder 只注入索引、模型相关时调 `use_skill(name)` 拉正文。
- **`http_get(url)` 工具**（`tools/web.py`）：prompt skills 的联网执行原语，含 SSRF 私网拦截、不跟随重定向。工具数 51→53。
- **`agent/skills/` → `agent/tools/` 改名**：原 skills 目录全是函数调用工具，改名对齐语义；新 `agent/skills/` 专放 prompt skill 剧本。

### 通知系统：持久化 + 流式气泡 + 已读追踪

- **通知落库 + 按用户已读**：新表 `notification_reads`，`site_notifications` 加 `bubble`/`persist`/`bubble_expire_at` 三列，通知一律落库，气泡落库才能离线补弹。
- **两渠道独立发布**：`bubble`（弹气泡）/`persist`（进通知中心）可分别开关，后台发布页加气泡时限。
- **导航栏通知中心（持久态）**：`GET /notifications` + 标已读落库，前端拉全量+实时 SSE 追加，关浏览器重开仍在。
- **气泡上线补弹**：实时在线立即弹，离线者上线时补弹最近一条有效气泡（只一次）。
- **气泡流式打字机**（`NotificationBubble.vue`）：新通知标题逐字冒出→正文逐字流式，全局单计时器只让最新一条打字。
- **通知支持无标题**：标题/内容不可同时为空，气泡/侧边栏/预览均按无标题渲染。
- **气泡组件**（`NotificationBubble.vue`）：玻璃风固定 360px 与小窗/播放器严格同宽，新通知把旧的顶上去，最新这条不自动超时。
- **气泡与侧边栏解耦**：气泡存独立快照，关闭气泡不影响侧边栏通知列表。
- **独立 `MarkdownView` 组件**（`utils/markdown.js`）：轻量独立 `marked` 实例，通知气泡/侧边栏/聊天统一同款 md 样式。
- **后台通知发布页**（`Admin/Notifications`）：填标题+内容（支持 Markdown），预览 1:1 复刻真实气泡，一键发送给所有在线用户。

### 对话状态指示：全可配 + 动画化

- **状态命名后台可配**（`Admin/Agent/index.vue` 新标签页）：可改全部状态显示名（思考中/整理中/复查前缀+每个工具），留空回退默认，保存即热生效。
- **一态多名随机显示**：任一命名值用 `|` 分隔填多个，每次随机取一条。
- **单一数据源**：工具名/复查前缀由后端在 `tool_call` 事件里解析好下发，前端直接显示。
- **打字机入场 + 排队切换**（`GuguChat.vue`）：状态文字逐字冒出，SSE 状态事件入队逐个播放，不再一闪而过，真回复 token 一到即打断队列让位正文。
- **思考默认回三个点**：`core.py` `_thinking` 默认空时显示三个点动画。
- **自检轮气泡治理**：复查轮原来把 `thinking` 重置导致点点残留到 `done`，改为复查工具打 `verify` 标记区分状态。

### 文本预览稳定化 + 浮动窗口增强

- **文本文件走浮动窗口预览**：`preview.js` 把 MD/TXT/代码等路由到浮动窗口，`FloatPreviewWindow` 新增文本分支，支持拖拽/最大化/多开。
- **稳定即时刷新**（`GuguChat.vue`）：文件工具 `tool_done` 即 `liveStore.bump('files')`，确定性触发预览重载，不靠会丢的 events SSE 兜底。
- **TextViewer 滚动位置存 localStorage**：按 `fileKey` 存，跨组件重建/整页刷新都保留。
- **下载 URL cache-bust**：刷新时带 `?_t=`，避免浏览器返回缓存旧内容。
- **文本预览可选中复制**（`TextViewer.vue`）：覆盖预览弹窗的 `user-select:none`，正文可选/复制。
- **浮动窗口：内容刷新不重置位置**（`FloatPreviewWindow.vue`）：`refresh=true` 时跳过 `fitWindow()`，窗口位置/尺寸原地保留。
- **SSE 断线重连补偿**（`live.js`）：重连成功后 bump 所有 rev，补上断线期间漏掉的资源变更。
- **工具集漂移修复**：`_PROJECT_TOOLS`/`_FILE_TOOLS` 与后端 `RESOURCE_BY_TOOL` 不同步导致连回合末兜底都漏刷，已对齐。

### 前端交互与 UI 打磨

- **GuguChat 展开大窗跳底**：`enterExpanded()` 加 ResizeObserver 在过渡期间持续跟底，修复原来只设一次 scrollTop 随即失效的问题。
- **日历多选：单日悬停不切侧边栏**（`Calendar/index.vue`）：只有真正跨天拖选后才切「添加项目」模式。
- **定时任务时间输入改文本框**（`Schedules/index.vue`）：不弹系统选择器，圆角统一。
- **项目卡悬停亮色高光**（`ProjectCard.vue`）：`::after` 伪元素顶部白色渐变，hover 时明显增亮。
- **看板「新建项目」卡悬停亮色**（`KanbanColumn.vue`）：hover 背景修正为与项目卡风格对齐。
- **ProjectModal 删除阶段按钮位置修复**：防止「×」按钮落在阶段分割线上。
- **项目编辑卡阶段区版面记忆**（`pmStagesExpanded`）：展开状态持久化到用户偏好。
- **GuguChat 小窗/播放器/气泡严格同宽**（360px border-box）。
- **新建项目状态球**：顶部胶囊改为 14px 圆形状态球，点击循环切换三态。
- **DatePicker 样式统一**：边框色/背景/内边距与其他表单对齐。
- **定时任务试运行 Toast**：从浏览器 `alert()` 改为页面内 Toast 提示。
- **颜色格方形化**：新建项目颜色格从圆形改为圆角方块。
- **数据分析趋势图增强**（`Admin/Analytics`）：折线改为 canvas 渐变填充，hover 显示跨系列 tooltip。

### 项目与工作流增强

- **全局搜索准确跳转**：对话搜索滚到并高亮命中消息，日程搜索切换到对应月份并高亮目标条目。
- **全局搜索拼音/罗马音匹配**（`utils/romaji.py`）：纯 ASCII query 自动走罗马音分支（pypinyin + pykakasi），搜 `riqi` 命中「日期」。
- **全局搜索点项目 → 高亮项目卡**：点项目跳到项目面板、对应卡片滚到中央高亮，不再弹编辑窗。
- **待办全完成自动进下一阶段**（`ProjectCard.vue`）：勾完当前阶段最后一个待办自动推进下一阶段，与 `ProjectModal` 已有逻辑对齐。
- **项目卡：点击阶段名快速操作待办**：阶段名变可点击触发器，弹出当前阶段待办弹层，支持勾选/编辑/删除/添加。
- **mode2 文件卡拖影尺寸修复**（`usePhysicsDrag.js`）：stages-expanded 下文件卡拖影克隆体挂 body 后丢上下文导致尺寸回落更大。给物理拖拽加 `cloneClass` 选项补回版式。
- **修复：多工具对话后追问报「咕咕开小差了」**（孤儿 tool_result）：历史截断时丢掉打头的 `assistant(tool_use)` 把紧跟的 `tool_result` 变孤儿导致 MiniMax 400。`sanitize_messages` 改为按位置标记合法相邻对。

### 其他

- **前端代码复用重构**：提取 `useSorting`/`useUploadQueue`/`useBoxSelection` 三个 composable，消除 Files 和 ProjectModal 间约 180 行重复代码。
- **AI 回复文件编号外漏修复**：文件列表去掉 `[id=xxx]` 前缀，工具按文件名定位足够；Admin Agent 行为开关改为点击即时保存。
- **缩略图减负**：`Image.draft()` 大图快速降采样解码 + 并发闸，2 核机上传后不再占满双核卡请求。
- **开发服务器稳定性**：uvicorn `--reload` 限定监听 `app/` + `agent/` 两目录，pip install 不触发大量连锁重启。
- **后台管理员用户名走 env**（`ADMIN_USERNAME`，默认 `admin`），与 `ADMIN_PASSWORD` 同款。


---


## [0.12.0] - 2026-06-25 · 并发扩量、定时任务、IM 强化与体验打磨

> 本版核心：worker 从串行并发化、配多 key 分流扩到 50+ 人；落地用户定时任务 + 提醒工作流；
> IM 交互（斜杠命令 / 取消打断 / 多模态）与网页聊天体验大幅强化；外加一大批文件系统、看板、
> Admin、防幻觉与运维打磨。下面按主题归并（开发期约 50 个迭代小节）。

### 并发扩量与性能（worker 串行 → 50+ 人）

- **worker 串行 → 有界并发**：改 `asyncio.create_task` 并发派发 + 全局 `Semaphore`，`user_gate(puid)` 同用户串行保序、不同用户并发。实测 ~6×（串行 ~21 → 并发 ~190 条/分，带工具）。
- **多 key 分流（pick_model 模型解析层）**：`agent/llm_select.py` 统一「选哪个模型」决策点，`pool` 策略把请求散到多个 key，总并发 ≈ key 数 × 16。
- **慢尾兜底**：`core._stream_round` 对 429/超时/网络/5xx 在出 token 前退避重试。
- **配额耗尽能力降级**：不再一刀切拦死，降到只读工具集+婉拒重操作，查询/对话照常。
- **连接池 + SSE**：SSE 鉴权改不查 DB，池调优修「试运行/重启后整站卡死」。
- 压测详见 [docs/ops/并发压测结果.md](docs/ops/并发压测结果.md)。

### 定时任务 + 提醒工作流

- **用户自定义定时任务**：新增 `scheduled_tasks` 表（DB 驱动），worker 单实例每 ~30s reconcile 到 APScheduler；`/schedules` 页 CRUD+试运行+排程选择器。
- **提醒工作流重构**：结果不进对话——`execute_task` 用 `run_ephemeral` 跑 agent，改投递到侧边栏铃铛通知(SSE) + IM 主动 DM。
- **多平台精确投递**：web/飞书/QQ 分别勾选各自独立投递，`imreach:{uid}:{platform}` 按平台存址互不覆盖。
- **对话历史压缩（新）**：超长会话把旧消息滚动总结成摘要注入 system prompt 省 token，后台开关可关。
- 重复模式改场景选择器；单次任务执行后自动删除；试运行同步返回各渠道结果。

### IM 交互强化

- **斜杠强制命令** `/stop`·`/status`·`/help`：网关层确定性触发，绕过关键词分类，比自然语言取消稳。
- **自然语言取消·流式途中可打断**：core 工具循环原只在轮顶查取消，单轮长回答打不断，改为流式输出每 24 token 协作查、命中即断上游。
- **轻量 Intent Router + State Manager（Phase 1.7）**：任务进行中的「还在吗/算了/嗯」网关据 Redis 状态短路、不进主模型。
- **多模态看图增强**：大图自动压缩、HEIC/HEIF 支持、`read_file` 看文件库内图。
- **IM 出口兜底**（`agent/outbound.py`）：发用户前确定性清洗 tool_id/拦系统提示词泄露，空回复兜底。

### 咕咕聊天（网页）体验

- **多会话流式隔离 + 切换实时续看**：流绑定归属会话（修「回复串到别的会话」），切走 abort、切回补快照再续。
- **消息图片缩略图 / 拖入上传 / 滚动跟随**：气泡缩略图，大小窗整窗拖入多文件，大窗流式跟随脱手修复。
- **侧栏 IM 接入抽屉**：飞书/QQ 两个可展开抽屉，未接入显示「扫码连接」。

### 文件系统与项目

- **文件工具集合操作**：`move_items`（文件+文件夹递归整搬）取代单文件 move，`rename_file`/`edit_file` 批量，逐项如实回报。
- **存储↔DB 对账与修复工具**（Admin·数据库）：以物理存储为准核对幽灵/孤儿文件，明细+导入/删除修复。
- **项目删除遗留孤儿修复**：删项目前先归位文件到个人空间，不再变孤儿泄漏。
- **OSS 预签名直传**：`storage.backend=='oss'` 自动走浏览器直传，省服务器中转带宽。
- **项目进度口径统一**为「所有阶段待办已完成/总数」（看板/总览/编辑卡/日历/胶囊一致）。
- 文件夹删除改软删进回收站；项目卡拖放上传+文件数实时徽章；编辑卡 Shift/Ctrl 多选快捷键。

### 界面打磨

- **卡片拖拽物理效果**（`usePhysicsDrag`）：弹簧跟手、FLIP 占位收合、落点让位/换列双克隆飞行/吸入文件夹，接入看板/文件库/编辑卡。
- **看板进度条瀑布动画**（per-stage 填充+全局 ease-out 错峰）。
- **通知面板** Markdown 渲染+高度自适应不溢出。
- 弹窗样式统一；项目卡名称悬停浮出编辑框。
- 顶栏/定时任务按钮 Phosphor 图标；站内全局搜索（跨项目/文件/文件夹/日程/客户/对话 6 类）。
- 隐私政策独立页 `/privacy`（无需登录）+ 注册页内测提示勾选。
- PDF 预览修 iframe 滚动/开关时整页闪烁。

### Agent 提示词与防幻觉

- **提示词分层**：persona（角色）/skills（执行规则）/policy（内容红线）/default（数据模板），后台分别可编辑。
- **防幻觉增强**：概览每轮注入各空间文件真值，数量只数本轮 success，被质疑数量/结果必重查。
- **咕咕中文化**：注入上下文时项目状态英文枚举转中文，内部 id/编号绝不对用户说。
- 改文件内容前先 `read_file` 拿最新，防覆盖用户外部改动。

### Admin / 后台

- 服务状态页队列水位监控（消费组 lag/pending，超阈值标黄）。
- 用户反馈功能（提交入口+Admin 分页列表+SMTP 邮件通知）。
- SMTP 邮件系统配置卡片（SSL/STARTTLS 切换+测试发送）。
- Admin 导航图标全换 Phosphor。

### 运维 / 文档

- **systemd 托管 worker / supervisor**（`Restart=always`），`make install` 一次装全 3 个，修「进程死了不自动拉起、消息无限排队」的生产隐患。
- **文档收口**：并发优化文档整合为单一权威版本，`00-总览.md` 重整为纯架构参考（1059→418 行）。

### 修复

- **配置 override 漏 `agent` 段合并**（存量 bug）：`apply_override` 没有 agent 合并块，导致整个 agent 行为配置 override 失效，已补。
- **对话压缩致命 bug**：摘要原以 `role="summary"` 当消息发给 LLM（API 只认 user/assistant 会报错），改注入 system prompt。
- **`read_file` 读 PDF/Office 报「找不到文件」误导**：服务器没装 `pdftotext`/`libreoffice` 时的 `FileNotFoundError` 被误读成「用户文件丢了」，改报命令未装、文件完好。
- 一批：文件夹文件数漏排回收站、项目卡计数漏算文件夹内文件、换头像不实时、Admin 工具分布接口 500、缩略图缺文件 500→404、IM 空回复发 QQ 被拒、`ProjectCard`/`ProjectModal` TDZ。

---

## [0.11.1] - 2026-06-24 · IM 全接入、文件收发、Agent 执行策略

> 本版把 IM 接入做全（飞书 + QQ，BYO 扫码自连），打通文件双向收发与 PDF/Office 读取，
> 并重构 Agent 提示词分层、引入执行策略。下面按主题归并（开发期约 25 个迭代小节）。

### IM 接入（飞书 + QQ · BYO 扫码自连）

- **飞书 + QQ 统一 BYO**：每用户自带 bot，「接入咕咕」扫码自动连接（飞书 OAuth 设备授权、QQ bind_task，无需合作方资质），凭据加密写入 `user_bots`，`supervisor` 统一拉起网关。
- **清理旧共享 bot**：删除旧共享绑定与 Admin「频道」面板，IM 接入全改用户自助。
- **飞书 Webhook 模式**：新增长连接的替代方案，有公网时少跑一个进程。
- **IM 上下文修复**：`run_collect` 原来不读历史，每条孤立处理，现与网页同口径读历史窗口。
- **飞书 markdown**：回复改交互卡片渲染粗体/列表/代码。
- **IM 新会话 AI 标题**（此前只 web 有）；标题生成移出关键路径改后台。
- **飞书秒回表情**：网关收到即用关键词本地判一个 emoji 即时点上。

### 文件收发 + PDF/Office 读取

- **用户 → 咕咕发文件**（网页上传/飞书/QQ）：暂存后咕咕看内容并可 `save_uploaded_file` 存库。
- **咕咕 → 用户发文件**（网页卡片/飞书/QQ）：`send_file` 工具按平台发，飞书图 10MB/文 30MB，QQ 富媒体走签名 URL。
- **`read_file` 读 PDF/Word/Excel/PPT**（新 `app/core/doctext.py`：pdftotext + LibreOffice 提取），文件库与聊天附件共用。

### Agent 执行策略与工具

- **提示词分层**：拆成 persona（角色）/skills（执行规则）/policy（内容红线）/default（数据模板），后台可分别编辑。
- **执行策略 skills.md**：任务分级、成本意识、真实性铁律、不可逆 confirm 两步流程。
- **`MAX_ROUNDS` → 6**（早期 5→16，配合强工具+准则逼出低成本执行）。
- **项目工具增强**：`create_project` 带 `stages`、`set_stages`（声明式整体替换）、`update_todo`。
- **咕咕能读历史对话**（新 `conversations` skill：search/read，严格多用户隔离）。
- **健壮性**：工具异常不冲垮对话，错误文案友好分类。

### 实时与流式

- **实时刷新（Redis pub/sub → SSE）**：咕咕改数据/IM 来消息时网页自动刷新，按用户隔离频道。
- **网页生成解耦**（新 `genstream`）：生成脱离 HTTP 请求跑后台任务，刷新不丢回复、还能续看。
- **OpenAI 路真流式**（DeepSeek 等）：`stream=True` 逐 token，原来是非流式假切片。
- **IM 多轮修复**：MiniMax 重述开场白、IM 对话在网页分两次推等问题修复。
- 修复：实时回复空气泡、`agent_usage.tools_used` 缺列、文件库不实时刷新、`create_document` 缺 name 死循环。

### 界面 / 性能

- **PDF 预览换回 iframe 原生引擎**（PDFium，大文件/多页流畅，之前 pdfjs 自渲染性能一般且白屏/漂移）。
- 文件卡片气泡化、隐藏导航悬停 URL、回收站多选/框选，一批界面细节打磨。
- **精力恢复改固定 6h 重置**（UTC 整点 00/06/12/18 切桶）。

### 文档 / 运维

- 新增并发与性能优化文档、Admin Debug 实时日志页、咕咕风格 404 页、systemd 按安装目录自动生成。
- 迁移：`20260623000001`/`20260623000002`/`20260623000003`——**部署须 `make migrate`**。

---

## [0.11.0] - 2026-06-23 · 记忆系统、联网搜索、IM 接入（飞书）

### 新增

- **Skill 一等公民**：Profile 改为组合 skill 名，`tool_names` 由 registry 从 skill 派生，消除「加工具改两处」的双重维护。
- **记忆系统（Phase 2a · 伙伴化）**：咕咕能记住用户，三层 markdown 记忆存用户私有 `.agent/`——`facts.md` 稳定档案（反思每轮调和重写）、`daily.md` 近期记忆（滚动保留 30 条）、`memory.md` 长期沉淀（daily 老条目摘要而来）。对话后反思 fire-and-forget 提炼写盘，`remember` 工具主动记。
- **联网搜索**：`web_search`（Tavily），Admin 配 key，每日次数配额。
- **IM 平台接入（飞书）**：用户私聊咕咕机器人，带完整人格/记忆/工具回复。平台无关骨架（Redis Streams 队列+独立 worker 进程），飞书网关走 `lark-oapi` WebSocket 长连（不用公网 URL），后台频道管理面板增删启停各平台 bot。
- **prompt 缓存**：`core.py` Anthropic/MiniMax 路 system 打 `cache_control`，多轮工具循环命中缓存省 ~90%。

### 调整

- **记忆模型简化**：砍掉 weekly 中间层，压缩定为 `daily → memory` 两段。
- **成本结论**（1M 上下文+缓存背景下）：记忆/工具/人格注入近乎免费，无需 trim。

### 修复

- **系统日志**：traceback 区框选文字松开鼠标不再误关展开，新增「复制日志」按钮。
- **worker Redis 阻塞读超时**：`get_redis` 设 `socket_timeout=None`，治 `XREADGROUP block` 反复超时。

### 文档 / 运维

- **`deploy.md` 完全重写**：开发+生产完整教程（venv/依赖/配置/数据库/nginx/systemd/排错/备份）。
- 新增飞书接入指南文档；`.env.example` 更新为当前嵌套格式；`.gitignore` 补 root `uploads/`（含咕咕 `.agent/` 记忆）防误提交用户数据。

---

## [0.10.1] - 2026-06-23 · 咕咕聊天体验修复

### 修复

- **AI 创建项目缺少默认阶段**：`_create_project` 技能之前创建空 `stages_json = "[]"`，AI 建出的项目没有任何阶段。现在自动注入三个默认阶段（计划/执行/交付），与前端手动新建保持一致。
- **工具调用后出现空窗期**：`tool_done` 事件后两个状态同时清零，导致工具完成到 AI 开始回复之间无任何气泡。改为切换到思考气泡直到首个 token 到来。
- **小窗切换大窗再返回后不再向上扩展**：`exitExpanded()` 未重置小窗高度基准，导致新消息触发的增量计算错误。改为返回小窗时同步更新基准。

### 调整

- **工具/思考气泡视觉统一**：去掉工具气泡的透明度差异，统一水平内边距。
- **三类气泡高度统一**：按单行文字气泡高度反推调整各气泡 padding。

---

## [0.10.0] - 2026-06-22 · Agent 工具系统与伙伴人格

### 新增

- **Agent 包化重构**：业务逻辑从单文件 `app/api/v1/agent.py`（637 行）迁出为独立 `backend/agent/` 包（`core`/`context`/`skills`/`profiles`/`adapters/web`/`confirm`/`sanitize`），`agent.py` 瘦身为 106 行薄层，对外 SSE 接口不变。
- **工具体系（39 个）**：单一声明自动派生 Anthropic/OpenAI 双格式+全局 registry 统一分发，覆盖项目/日历/文件/客户的查建改删+回收站+聚合统计。
- **删除二次确认保底（显式 confirm 参数）**：`agent/confirm.py` 的 `needs_confirmation`，不可逆操作未带 `confirm=true` 时返回影响详情不执行，用户同意后再调一次才删。
- **伙伴人格 `prompts/persona.md`**：四种相处状态（做事/推进/记录/决策探索）、主动思考、风格与内容边界，builder 最先加载。
- **防编造铁律（persona + `default.md`）**：只陈述工具真实返回，不脑补文件名/数量/id，报告「已创建」前必须真调用了工具并收到 success。
- **Admin 可在线编辑人格**：Agent 面板系统提示词 Tab 新增「人格」入口，保存即热更新。
- **文件夹拖拽移动**：文件库网格/列表视图文件夹卡片支持拖拽移动，后端新增 `PATCH /folders/{fid}/parent` 含循环依赖检测。

### 调整

- **历史窗口按 token 预算裁剪**：`context/tokens.py` CJK 感知估算，从最新往回按预算裁剪，替代原按条数 `limit(10)`。
- **LLM 单次流式调用（Anthropic 路）**：原「探测-再流式」两次调用导致模型看到相同输入而敷衍，改为单次 `messages.stream`（带 tools），流式输出的同时结束后取 tool_use 决定是否执行工具。
- **每轮注入「文件/文件夹概览」**：治「读不到最新文件」（之前上下文只有项目+日历），咕咕每轮开局即看到最新文件夹列表、文件总数、最近 25 个文件。

### 修复

- **所有工具支持按「名字」操作（不再依赖 id）**：过去要求传 `xxx_id`，咕咕常猜错 id 导致工具失败却被误报成功。改为每类实体统一加「按名解析」，重名时返回候选让其指明。
- **MiniMax tool-call 标记泄漏**：`agent/sanitize.py` 流式清洗，token 流出现标记即截断其后泄漏内容。
- **聊天气泡偶发消失**：`GuguChat.vue` 消息列表改用稳定 `:key="msg.id"`，替代数组索引 key。
- **流式中气泡内容闪烁/消失**：流式过程中半截 markdown 被解析成残缺结构而隐藏，改为流式中按纯文本显示、完成后再渲染 markdown。
- **咕咕回看历史出现空气泡**：`GET /sessions/{id}/messages` 过滤工具中间消息，仅返回正文对话。
- **咕咕展开后不在底部**：`toggleOpen` 改为 async，展开时滚到列表底部。
- **生成完成后时间戳被截掉**：`finally` 补一次 `scrollBottom`。
- **工具轮次之间出现空气泡**：`_new_round` 转发至前端后静默处理，不触发思考态。

### 调整

- **咕咕大窗宽度**：展开模式改为右锚约 60% 视口宽，两侧气泡距离更紧凑。

### 移除

- 废弃的 agent worktree 及其分支：内容已并入 main，无独有提交。

---

## [0.8.0] - 2026-06-22

### 新增

- **Admin 独立入口**：Admin 面板从主应用拆分为独立 Vite 入口（`admin/index.html` + `src/admin.js`），Dev Server 端口 5174（`npm run dev:admin`），打包产物分离至 `dist/admin/`；Nginx 将 `admin.gugugu.site` 指向 `dist/admin/index.html` 即可实现独立域名
- **用户管理面板**：全用户列表（头像、昵称、用户名、邮箱、注册时间、本周 Token、存储用量、配额状态），支持搜索过滤、封禁/解封、删除；操作写审计日志
- **配额管理页**（独立路由 `/quota`）：三区块设计——全局默认配额（热保存至 `config.override.json`，无需重启）、用户覆盖列表（自定义配额用户）、所有用户表（可编辑任意用户配额）
- **Token 用量限制**：6 小时滑动窗口 + 每周上限（周一 00:00 UTC 重置），对话前双重拦截；per-user 覆盖优先于全局默认，均为 `None` 时不限制
- **存储空间限制**：上传前检查 `used + size > limit`，超限返回 400；同样支持全局默认与用户覆盖
- **`QuotaSettings` 配置类**：`default_token_limit_6h` / `default_token_limit_weekly` / `default_storage_limit_bytes`，纳入 `AppSettings` 热更新流程；User 模型新增对应字段（migrations `20260622000006` / `20260622000007`）
- **邀请码系统**：Admin 生成/管理邀请码（格式 `GUGU-XXXX-XXXX`），注册时校验，使用后标记失效；支持批量生成（1–20 个）、过滤（全部/有效/已用）、复制（非 HTTPS 降级 `execCommand`）
- **Agent Admin 面板**：LLM 配置（provider 预设切换）、系统提示词（profile 热编辑）、行为配置（记忆参数）、用量统计四个 Tab
- **用量统计**：每次对话记录 token（`AgentUsage` 表），统计面板含今日/总计汇总卡、SVG 折线图（对话/输入/输出三指标，可切换月份）、按模型分组表格
- **审计日志 & 系统日志**：后端写入 + Admin 页面查看，关键操作（配置修改、用户管理、配额变更）全程可追溯

### 调整

- **去除 Onboarding 页面**：改为由 Agent 在首次对话中主动了解用户；移除路由守卫、`identity_done` localStorage 标记及 `/me/identity` 接口
- **Admin 路由去前缀**：路由从 `/admin/*` 简化为 `/*`，`AdminLayout` 链接同步更新，对齐独立域名部署
- **存储配额预设**：全局配额卡与用户编辑弹窗统一为 5 GB / 20 GB / 50 GB / 100 GB
- **去除 Admin「返回主界面」链接**：两个应用完全独立，侧边栏与登录页均已移除

### 修复

- **配额页刷新后变无限制**：config store 缺少 `cfg.quota` 初始化，`fetchConfig` 未读取 `data.quota`；已补全
- **用户覆盖列表始终为空**：`overrideUsers` 过滤条件错误引用已废弃字段 `token_limit_monthly`，修正为 `token_limit_6h || token_limit_weekly || storage_limit_bytes`
- **Admin 登录跳转路径**：从 `/admin/config` 修正为 `/config`，对齐新 Router base

### 架构

- **Agent 设计方向确立**：咕咕定位为伙伴而非助理，记忆系统为核心；用户主动输入仅昵称一处，其余由咕咕自主观察积累；压缩路径 daily → weekly → memory.md，无 monthly 层；`summary.md` 由 Reflection（importance ≥ 4）触发更新
- **用户档案目录确立**：`.agent/` 下 `identity.json` / `summary.md` / `facts.json` / `preferences.md` / `memory.md` / `daily/` / `weekly/`，每个文件回答一个独立问题

---

## [0.7.2] - 2026-06-22

### 新增

- **个人设置 Modal**：左导航分栏（900×600），与 AppSidebar 同风格毛玻璃；三大板块：个人信息、账号设置、偏好设置，另有「咕咕设置」入口
- **头像上传**：头像圆圈 hover 显相机图标，支持 JPEG/PNG/WebP/GIF ≤5MB，存储至 `uploads/avatars/`，`GET /api/v1/auth/avatar/{user_id}` 提供服务；AppSidebar 同步显示
- **昵称与登录名解耦**：新增 `display_name` 字段（migration `20260622000005`），登录名全局唯一不可改，昵称可随时修改；所有展示位优先显示昵称，fallback 至登录名
- **用户 ID 迁移至 UUID v7**：`users.id` 及子表 `user_id` 外键从自增整数迁移至 UUID v7（有序、不暴露注册量，migration `20260622000004`）；UID 在设置页展示为前 12 位大写十六进制
- **多标签页音频互斥**：`BroadcastChannel` 跨标签页协调，新标签页播放时其他自动停止
- **401 自动登出**：任何 API 返回 401 时前端清除 token 并跳转登录页
- **用户弹窗重设计**：底部用户卡弹窗改用 `.popup-menu` 风格；去除管理后台入口，新增「个人设置」按钮
- **全局表单输入框样式**：新增 `.form-input` CSS class，统一所有表单输入框

### 调整

- **日历右键菜单宽度**：从 140px 收窄至 110px
- **日历完成勾号范围**：仅保留右侧当日列表与近期节点胶囊，移除格内 chip、多日条、「更多」弹窗中的重复标记
- **日历今日保底颜色**：选中其他日期时今日格子保留淡紫色（周末淡红色）底色

---

## [0.7.1] - 2026-06-22

### 新增

- **项目优先级**：看板卡片与总览项目行右上角新增三星优先级按钮（高/中/低），点击直接设置等级，再次点击同级取消；优先级字段持久化至后端（`priority` 列，Alembic migration `20260622000001`）
- **乐观锁（Optimistic Locking）**：项目与日历活动新增 `version` 字段，每次 PATCH 自动携带当前版本号，后端不匹配返回 409；项目 store 捕获 409 后自动重新拉取最新数据；活动 409 弹提示并重载（migration `20260622000002`）
- **项目状态快速前进**：看板卡片右侧新增 `>` 按钮，点击将项目状态前进一列（待开始→进行中→已完成）；总览项目行状态胶囊可直接点击前进（仅前进，不可退回）
- **日历「更多」弹窗定位**：弹窗从「更多」按钮正上方/下方弹出（依剩余空间自动决定），动画的 `transform-origin` 随方向动态设置，不再从弹窗中间展开
- **日历「更多」弹窗进度条**：更多列表中的项目条目显示进度渐变背景（与日历条/胶囊一致）
- **分段进度条**：看板卡片与总览项目行的进度条按阶段数等分为独立段，每段可点击直接切换至对应阶段；悬浮时仅该段放大（`scaleY`，不影响卡片高度）；点击星级或进度段时卡片不触发下沉动画（CSS `:has()` 排除）
- **阶段自动打勾/还原**：前进阶段时，经过的阶段未完成待办自动标记完成（`autoCompleted: true`，记录 `_savedDone` 快照）；退回阶段时，目标阶段及之后阶段的自动打勾待办精确还原至快照状态；手动勾选/取消任何待办会清除 `autoCompleted` 标记，退回时不再还原该项；逻辑持久化至后端 stages JSON，刷新页面后仍有效
- **最后阶段自动完成**：当前阶段为最后阶段且进度达到 100% 时，项目自动标记为「已完成」；退回非末阶段或待办进度不满时自动回退至「进行中」；从看板「已完成」列拖回时同步还原所有 `autoCompleted` 待办至快照状态
- **新建项目 modal 日期预填**：日历页多选日期范围后点击顶栏「新建项目」，开始/截止日期自动填入选区
- **全局标题编辑框样式**：新增 `.title-edit-input` 全局 CSS 类，统一弹窗/卡片标题内联编辑框样式
- **日历完成标记**：所有日历位置（格内 chip、多日条、近期节点胶囊、「更多」弹窗、右侧当日列表）的已完成项目在名称后显示绿色 ✓ 勾号；同时保留项目颜色球
- **日历今日保底颜色**：选中其他日期时，今日格子保留淡紫色（周末淡红色）底色，不再与普通格子相同

### 调整

- **排序规则全面统一**：所有项目列表（看板列、总览列表、日历格内、日历侧栏当日/近期节点）统一为优先级降序 → 开始日期升序 → 截止日期升序 → 创建时间兜底；已完成项目始终排在最后
- **已完成列排序**：由纯完成时间降序改为优先级降序 → 完成时间降序
- **新建项目 modal 顶部**：名称输入区高度固定 52px，输入框字体与显示态统一
- **项目编辑卡填写框底色统一**：阶段重命名框、待办输入框聚焦态底色统一为 `rgba(255,255,255,0.72)`
- **`saveTodos` 走 `_patchProject`**：修复直接调 `projectsApi.update` 不携带 `version` 触发 409 的问题

### 修复

- **`api.js` 变量名冲突**：`err` 重复声明导致构建失败，改为 `apiErr`
- **后端 `_to_resp` 缺失字段**：项目响应补入 `priority`、`version`；活动响应补入 `version`
- **`ProjectModal.vue` 缺少 `projectsApi` 导入**：运行时 `ReferenceError`，已补入 import
- **阶段切换待办不实时更新**：改为在 `setStage` 同步替换 `localStages.value`，不再依赖 store 异步回写
- **退回阶段目标阶段本身待办未还原**：还原循环起点从 `newIdx+1` 修正为 `newIdx`
- **`_stageBeforeDone` 记录了末阶段而非原始阶段**：`setStage` 已先修改 `currentStage` 再调 `moveProject` 导致快照 key 错误；改为修改前提前保存
- **拖回已完成后待办全部保持勾选**：`moveProject` done→active 路径补入 `autoCompleted` 还原遍历
- **编辑卡状态胶囊不实时更新**：新增 `watch(() => props.project?.status, ...)` 实时同步 `localStatus`
- **胶囊变色延迟明显**：乐观更新移至第一个 `await` 前，合并为单次 patch
- **上传文件弹窗文件过多时溢出**：`.drop-zone.has-files` 加 `max-height: 320px; overflow-y: auto`
- **进度条鼠标判定区域**：进度段 `::before` 伪元素从 `inset: -4px` 扩展至 `-6px`
- **阶段拖拽排序只重排名称**：拖动仅移动 `label`，todo/key/当前阶段状态保持原位

---

## [0.7.0] - 2026-06-21 / 2026-06-22

### 新增

- **用户偏好持久化**：新建 `user_preferences` 表，`GET/PATCH /api/v1/preferences` 接口；阶段模板与上次使用的阶段存入后端，换设备登录后自动同步，不再依赖 localStorage
- **新建项目重设计**：700px 两栏布局（左：客户 / 项目周期 / 状态 / 颜色 / 备注；右：阶段 + 模板），默认截止日期为一周后
- **新建项目阶段模板**：支持保存、删除、重命名，内置「标准流程」「插画流程」「动画流程」三个默认模板，持久化至后端用户偏好（`preferencesApi`，随账号跨设备同步）
- **新建项目默认阶段**：优先读后端偏好 `last_stages`，其次读 store 最近项目，删除全部项目后仍保留上次填写的阶段
- **DateSpanPicker（连续日期选择器）**：开始 / 结束日期合为一个选择框，支持范围高亮、自动排序；「今天」按钮仅跳转月份；每次打开重置为选开始日期状态
- **日期选择器年份快速切换**：点击月份导航标题进入年份网格（4×3），点击直接跳转，支持翻页
- **项目备注自动保存**：防抖 600ms 写入 store
- **文件双向同步**：Tab 切回时调 `GET /files/version` 摘要接口，版本变化静默重拉全量；本地删除后 `/files/all` 扫描孤儿记录自动硬删
- **日历活动删除**：编辑弹窗右上角新增 × 关闭按钮，右下角新增「删除」按钮（`#b07858` 琥珀色）
- **项目完成时间记录**：状态改为 `done` 时记录精确完成时间戳（前端 `new Date().toISOString()`，后端 `datetime.utcnow()`）；撤回时清除，重新完成时更新为最新时间；已完成列卡片显示「✓ 完成」绿色胶囊 + 完成日期，隐藏原开始/截止日期
- **看板列排序**：待开始按开始日期升序、进行中按截止日期升序（最快到期排最上）、已完成按完成时间戳降序（最近完成排最上）；日期相同时以项目 ID 升序兜底
- **项目进度可视化**：
  - 日历项目条背景改为进度渐变（已完成 `accent` 32% / 未完成 10%），`barSegFill()` 保证跨周多行进度连贯
  - 总览 / 日历侧栏近期节点项目胶囊同步显示进度渐变，活动事件不受影响
  - `.cap-capsule` 背景统一由 CSS 变量 `--cap-bg` 驱动，`capBg()` 函数生成渐变字符串
- **日历周末今日日期框**：今日为周末时渐变改为低饱和红（`#b85c5c → #c97070`），平日保持紫灰
- **阶段待办事项**：ProjectModal 与 NewProjectModal 每个阶段下常驻待办列表（`{ id, text, done }`），支持勾选、内联编辑、Enter 快速追加、Backspace 清空删除；待办数据存入 `stages_json`，持久化至后端，无需新增数据表
- **进度细分**：阶段进度由待办完成比例驱动——有待办时当前阶段进度 = 已完成待办数 / 总待办数 × 阶段权重；无待办时直接计入整个阶段权重（2阶段无待办：选阶段1 = 50%，阶段2 = 100%）；看板卡片与编辑卡头部进度条实时联动
- **阶段模板支持待办**：`useStageTemplates` 模板存储完整 `{ label, todos }` 对象；保存模板时保留各阶段的待办内容，应用模板时还原；模板预览仅展示阶段名称
- **项目编辑卡保存按钮**：删除按钮旁新增绿色保存按钮（`PhCheck`），点击关闭弹窗（数据已实时自动保存）

- **文件库 Shift 多选**：点击 / 框选后按 Shift+点击可连续选中整段文件；Shift+框选合并到已有选中；Shift 按下时直接选中文件而不触发预览；`lastAnchorIndex` 在框选结束后自动定位到最末项，便于继续延伸
- **日历多日框选**：在日历格空白处按住鼠标拖拽可选中连续日期范围，首尾高亮（周末用红色调），框选期间实时预览；选区保持直到用户重新拖选
- **日历右键菜单**：在日期格空白处右键弹出 `.popup-menu` 风格菜单，可选「新建活动」（预填右键日期）或「新建项目」（预填框选范围为开始/截止日期）；菜单通过 `week-row` 层级捕获事件，避免 bars-layer 遮挡；关闭弹窗后选区不丢失

### 调整

### 修复

- **项目编辑卡状态按钮不实时更新**：补加 `localStatus` ref，点击立即更新 class，与 `localColor` / `localCurrentStage` 模式一致
- **项目编辑卡颜色 / 阶段 / 名称不实时更新**：`localColor`、`localCurrentStage`、`localName` 改为独立 ref，点击立即生效；`startEditName` 不再重置 `localName`
- **项目编辑卡阶段拖动带动进度**：阶段球样式改为位置索引（`activeStageIdx`）驱动，拖动重排只移动标签名，done/active 样式不跟随
- **阶段球 CSS 闪烁**：移除 `.stage-node.active` CSS background 规则与 transition，消除 inline style 与 class 单帧冲突
- **阶段拖动 ghost 倾斜**：去除 `rotate(-1deg) scale(1.02)` 变换
- **`startStageDrag` indexOf 失效**：改为传 v-for 位置索引 `i`，避免 Vue proxy 引用比较失效
- **项目卡截止日期时区错误**：`new Date("YYYY-MM-DD")` 解析 UTC 零点导致凌晨显示「明天」；4 处改为本地日期零点比较
- **项目卡文件数量不实时**：改为从 `filesCache.allFiles` 实时计算
- **`file_count` 含回收站文件**：`GET /projects` 加 `deleted_at IS NULL` 过滤
- **文件库历史残留已删除文件夹**：删除后同步清理 `navHistoryStack`，索引追踪替代 `indexOf` 引用比较
- **跨年日期显示**：年份与当前年不同时前置年份（`2025/12/31`、`2025年12月31日`）
- **添加阶段后立即聚焦**：点击「添加阶段」新输入框自动获焦
- **模板弹窗**：换亮白色背景；click-outside 排除内部点击；重命名时铅笔→对勾，删除按钮保持可见
- **项目备注 `textarea` 未绑定**：补加 `v-model`

- **全局弹出菜单样式**（`global.css`）：提取 `.popup-menu` / `.popup-menu-item` / `.popup-menu-sep` / `.popup-menu-shortcut` 为全局类（背景 `rgba(255,255,255,0.6)` + `blur(24px)`），右键菜单、排序下拉、日历活动弹窗统一复用
- **全局关闭按钮**：`.popup-close-btn` 提取至 `global.css`，Calendar / mini 播放器统一使用
- **mini 播放器图钉 / 音量按钮**：默认无底色，固定态仅保留紫色文字，hover 才显示浅底色
- **浮动预览器 / 抽屉预览器按钮**：默认无底色，hover 显示 `rgba(0,0,0,0.1)` 暗色；判定区域扩大 2px，gap 去除使相邻判定连续
- **PDF 加载状态位置**：`pv-status` 改为 `position: absolute; inset: 0` 绝对居中
- **UI 交互全局优化**：
  - 所有底层玻璃面板加 `backdrop-filter: blur(20px)` 毛玻璃；hover 背景 / 阴影 `0.25s ease` 淡入淡出
  - 彩色胶囊 / 条 hover 统一用 `inset 0 0 0 100px rgba(255,255,255,0.45)` box-shadow，`0.25s ease`
  - 文件卡片 `::after` 叠加 `rgba(255,255,255,0.15)` 白色高亮，提取至 `global.css`；内容层 z-index 分层确保白色仅覆盖缩略图
  - 不可拖动的卡片（如总览最近文件）hover 不浮起（`transform: none`），保留阴影加深
  - 日历侧栏当天日程卡片 hover 加 `rgba(255,255,255,0.2)` 白色高亮 + 黑色外阴影
  - 日历多行项目条 `hoveredBarId` 联动高亮；日期格 hover 改 `mousemove` 方案防止跨层闪烁
- **项目名称颜色**：全局统一 `darkenHex(color, 0.40)`，字重 `font-weight: 500`（Dashboard 项目列表、看板 ProjectCard）
- **总览项目行 hover**：`rgba(255,255,255,0.65)` 白色背景 + 外描边 + 顶边高光；行间添加 1px 分割线
- **看板 ProjectCard**：背景左侧透出项目色（`linear-gradient` 渐变至白）；hover `::after` 向上白色渐变叠加
- **总览文件面板动态列数**：`ResizeObserver` 计算，始终填满一行（`displayCount = colCount - 1`，上传按钮占最后一格）
- **总览文件面板样式**：统一使用文件库 `fc-card` 样式（大图标、ext 角标、渐变遮罩、缩略图）
- **日历近期节点**：过滤 `status === 'done'` 项目
- **日历活动 / 项目弹窗**：统一 `popup-header + × 关闭` 结构；弹窗日期标题修复行高压缩问题
- **导航栏**：选中项 `font-weight: 700`
- **总览日历头部**：三列 grid，年月居中，切换按钮分列两侧
- **缩略图系统**：Authorization header 认证稳定缓存 key；`useThumbCache` 模块级 blob Map 跨页零请求命中；`preloadTinyThumbs()` 全局预热；`thumbLoadedIds` 模块级持久化；`sessionStorage` 持久化文件列表；文件库热缓存加载跳过 `await`
- **项目编辑卡**：左右栏背景统一；文件列表打开时预填防空帧；阶段球平面化
- **文件库**：删除顶栏上传按钮；多选工具栏垂直对齐优化；按钮高度统一
- **删除废弃组件** `ProjectDrawer.vue`

### 性能

- **WebP 缩略图根因修复**：补入 `Pillow` 依赖，tiny 缩至几百字节 / card 缩至几 KB，根本解决滚动卡顿
- **缩略图降级**：生成失败输出缩小 JPEG，兜底返回原图；异常打印 traceback
- **HTTP Cache 绕过**：fetch 加 `cache: 'no-cache'`，防止浏览器缓存旧版大图
- **移除 `glass-card` backdrop-filter**：主体面板背后平滑渐变无需 blur，消除 GPU 捕获峰值
- **FilePanel 懒加载**：card 缩略图面板接近视口才解码，tiny 仍即时预热
- **IntersectionObserver 始终启用**：有缓存时也不跳过，防止二次打开批量解码卡顿
- **渐进式动画**：`fc-loaded` 改由 `@load` 事件驱动，二次打开 blur→sharp 效果一致

### 安全

- **用户隔离漏洞修复**（6 处）：`copy_file` / `update_file` / `agent create_event` 目标资源未验证所有者；`update_project` 返回 `file_count` 未过滤 `user_id`
- **回收站路径隔离**：路径由 `trash/{fid}/` 改为 `{user_id}/trash/{fid}/`

---

## [0.6.0] - 2026-06-20 / 2026-06-21

### 新增

- **文件库全量元数据缓存**：进入文件库一次性拉取所有元数据，导航切换无网络请求；乐观更新（失败自动回滚）；新增 `GET /files/all`、`GET /folders/all`
- **图片缩略图**：网格卡片 blur-up 渐进加载（tiny 占位 → card 淡入），IntersectionObserver 懒加载，后端磁盘缓存，上传时自动预生成；文件库 + ProjectModal 均支持
- **面包屑后退 / 前进按钮**（文件库 + 项目编辑卡），根目录或无历史时自动禁用
- **右键「详细信息」弹窗**（`FileInfoPopup.vue`）：独立信息卡，可拖拽，只能按 X 关闭
- **音频播放进度持久化**：刷新时保存，重载后恢复一次，切歌不保存
- **全局图标统一为 Phosphor**：播放器、FilePreviewModal、FloatPreviewWindow、咕咕聊天窗剩余手写 SVG 全部替换
- **日历接入中国法定节假日**：调用 timor.tech API，按年缓存至 localStorage（30 天过期），日历格与 Dashboard 小日历同步显示「休」/「班」标签
- **日历样式优化**：今日 / 选中日期外框改为圆角矩形；周末格子背景与表头加入红色调；选中周末格用红色系；日历格底部安全区 `BOTTOM_PAD = 8`，防止活动条溢出
- **日历活动右键打开编辑**：侧栏列表、近期节点、格内 chip 均支持右键直接打开编辑弹窗

### 修复

- **软删除不释放路径**：软删除时物理文件移至 `trash/{fid}/原文件名`，修复删后上传同名变 `xxx(1)` 的问题；还原时移回并处理命名冲突；`rmdir` 清理空目录
- **PDF/Office 预览页面左移**：`html, body, #app` 加 `overflow: hidden`
- **FilePreviewModal 信息面板超出右侧视口**：改为右对齐定位
- **日历侧栏活动名不换行**：改为 block + `word-break: break-word`，标签 `inline-block` 紧跟名称
- **音乐播放器按钮风格**：关闭 / 固定 / 音量改为圆角矩形，与聊天窗关闭按钮对齐；播放 / 暂停恢复圆形；音量图标改为 fill
- **咕咕聊天窗发送按钮**图标颜色改为白色
- 缺失的 `anthropic` 后端依赖补入 `requirements.txt`
- 面包屑根目录去掉多余右箭头；排序图标 11 → 13；上传按钮不出现在根目录 / 年月层；视频播放器按钮渐变背景，不透明度降低

### 删除

- `AudioViewer.vue`（死代码）

---

## [0.5.0] - 2026-06-20

### 新增

- **文件预览系统**：图片 / 视频可拖拽浮动窗口（多窗口并存、resize、最大化）；PDF / 文本侧边抽屉（翻页、缩放、代码高亮、Markdown 渲染）；音频直接进迷你播放器；所有查看器支持可拖拽信息弹窗
- **文件操作**：右键菜单（文件 / 文件夹 / 空白三种模式）；剪切 / 复制 / 粘贴（`Ctrl/⌘+X/C/V`）；框选多选；列表视图列头排序；7 层导航，文件夹无限嵌套，回收站 30 天自动清理

---

## [0.3.0] - 2026-06-18

### 新增

- **主界面（DefaultLayout）**：顶栏 + 侧边栏玻璃拟态布局、全局导航、用户卡片
- **总览页（Dashboard）**：统计卡片、项目列表、日历面板、最近文件
- **项目页（Projects）**：三列看板、HTML5 拖拽换列、ProjectModal 阶段编辑
- **日历页（Calendar）**：月视图、项目横跨条、事件 chip、年/月快速选择器

### 进行中

- 文件系统重构（四空间架构 + 本地 / OSS 双后端）

---

## 历史版本

更早的变更记录参见 git 提交历史（`git log --oneline`）。

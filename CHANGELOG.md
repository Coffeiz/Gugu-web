# 更新日志 · Changelog

本项目所有显著的更新都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [0.7.0] - 2026-06-21

### 新增（续）

- **用户偏好持久化**：新建 `user_preferences` 表，`GET/PATCH /api/v1/preferences` 接口；阶段模板与上次使用的阶段均存入后端，换设备登录后自动同步，不再依赖 localStorage
- **日历活动删除**：编辑活动弹窗右上角新增 × 关闭按钮，右下角新增「删除」按钮（与侧栏删除按钮样式统一，`#b07858` 琥珀色）
- **新建项目默认阶段**：打开新建面板时优先读取后端偏好中 `last_stages`，其次读 store 最近项目，删除全部项目后仍保留上次填写的阶段

### 修复（续）

- **项目编辑卡颜色/阶段/名称不实时更新**：`localColor`、`localCurrentStage`、`localName` 改为独立 ref，点击后立即生效，不再依赖 props 响应式链；`startEditName` 不再重置 `localName`，避免二次点击回退旧值
- **项目编辑卡阶段拖动带动进度与样式变化**：阶段球样式改为位置索引（`activeStageIdx`）驱动；`stageProgress` 改为 ref，仅在点击切换阶段时更新；拖动重排只移动标签名，done/active/plain 样式锁定在原位置不跟随
- **阶段球 CSS 闪烁**：移除 `.stage-node.active .node-circle { background: var(--color-primary) }` CSS 规则与 `transition`，消除 inline style 与 class 之间的单帧冲突
- **拖动 ghost 倾斜**：新建项目与编辑卡的阶段拖动 ghost 均去除 `rotate(-1deg) scale(1.02)` 变换
- **`startStageDrag` indexOf 失效**：改为传 `i`（v-for 位置索引）替代 `localStages.indexOf(stage)`，避免 Vue proxy 引用比较失效

### 调整

- **项目编辑卡左右栏背景统一**：移除右栏 `background: rgba(0,0,0,0.015)`
- **阶段球平面化**：去渐变与外描边，active 状态改用 inline style（项目颜色填充）；之后恢复 `1.5px` 描边
- **多选工具栏垂直对齐**：`pm-selection-bar` bottom 调整至与右下角删除按钮中心对齐
- **文件库删除顶栏上传按钮**
- **UI 微调**：项目编辑卡看板状态胶囊加大（`padding: 5px 12px`，字号 12px）；配色球放大至 22px；SVG 全部迁移至 Phosphor Icons（ProjectModal、NewProjectModal、Calendar）
- **导航栏**：选中项 `font-weight: 700`，未选中恢复默认字重
- **总览日历头部**：年月文字居中，左右切换月份按钮分列两侧（三列 grid 布局）
- **日历近期节点**：过滤已完成（`status === 'done'`）项目，不再显示在右侧栏
- **日历添加活动弹窗**：改为与编辑弹窗一致的结构（popup-header + × 关闭，底部保存按钮）
- **缩略图缓存优化**：`/files/{id}/thumb` 改为 Authorization header 认证（URL 不含 token，浏览器 HTTP 缓存 key 稳定）；新增 `useThumbCache` 模块级 blob Map，切换页面命中缓存零请求，并发自动去重
- **总览文件面板**：使用文件库同款 `fc-card` 样式（大图标、ext 角标、渐变遮罩、图片缩略图）；`will-change: transform` 消除 backdrop-filter 叠加导致的 hover 卡顿
- **删除废弃组件** `ProjectDrawer.vue`（无任何引用）
- **缩略图跨页持久化**：`thumbLoadedIds` 提升为模块级 `reactive(new Set())`，导航回文件库/总览/项目卡时 `fc-loaded` 已就绪，卡片不再重新淡入；`getCachedThumb` 命中时同步标记，无需等 `@load` 事件
- **tiny blob 全局预热**：新增 `preloadTinyThumbs(files)` 函数，任意页面获取文件列表后立即后台 fetch 所有图片的 tiny blob（已缓存则跳过）；文件库、总览、项目编辑卡均接入，跨页面共享 tiny 缓存实现渐进式加载
- **文件列表 sessionStorage 持久化**：`filesCache` 改为读写 `sessionStorage`，页面刷新后总览文件卡第一帧即可渲染，无需等待 API
- **文件库热缓存加载**：`onMounted` 检测 store 已加载时同步调 `loadContents()`，跳过 `await`，SPA 内导航回文件库无空帧闪烁
- **项目编辑卡文件预填**：打开项目时先从 `filesCacheStore` 同步填充文件列表，API 刷新后覆盖，消除等待 API 期间文件区域为空的问题

### 新增



- **文件双向同步**：Tab 切回时自动调 `GET /files/version`（返回 `count:max_updated:max_deleted` 摘要），版本变化则静默重拉全量数据，感知删除/修改/新增；本地手动删除文件后 UI 自动同步（`/files/all` 扫描实体存在性，孤儿记录直接硬删，不进回收站）
- **新建项目模板**：支持保存、删除、重命名阶段模板，持久化至 localStorage；内置「标准流程」「插画流程」「动画流程」三个默认模板
- **DateSpanPicker（连续日期选择器）**：合并开始/结束日期为一个选择框，点击开始日期后再次选择即为结束日期，自动交换顺序；支持范围高亮，「今天」按钮仅跳转月份不选日期；每次打开重置为选开始日期状态
- **日期选择器年份快速切换**：点击月份导航中间的年月文字进入年份网格（4×3），点击年份直接跳转；支持翻页
- **新建项目重设计**：700px 两栏布局，左栏（客户、项目周期、看板状态、颜色、备注），右栏（阶段 + 模板），默认截止日期为一周后
- **项目备注自动保存**：备注 textarea 绑定 `v-model`，防抖 600ms 写入 store

### 修复

- **项目卡截止日期时区错误**：`new Date("YYYY-MM-DD")` 解析为 UTC 零点，凌晨访问时「今天截止」显示为「明天」；修复 `ProjectCard`、`ProjectList`、`ProjectDrawer`、`stores/projects.js` 共 4 处，改为本地日期零点比较
- **项目卡文件数量不实时**：项目卡片的文件数量来自后端静态值，删除文件后不更新；改为从 `filesCache.allFiles` 实时计算
- **项目列表 `file_count` 含回收站文件**：`GET /projects` 的 `file_count` 未过滤 `deleted_at`，导致回收站文件被计入；加 `deleted_at IS NULL` 过滤
- **添加阶段后立即聚焦**：点击「添加阶段」后新输入框自动获得焦点，无需手动点击
- **跨年日期显示**：`ProjectCard`、`Dashboard ProjectList` 日期格式化，当年份与当前年不同时前置年份（如 `2025/12/31`、`2025年12月31日`）
- **文件库前进/后退历史残留已删除文件夹**：删除文件夹（单删或批量删）后同步清理 `navHistoryStack`，使用索引追踪方式替代 `indexOf` 引用比较，避免 Vue 代理对象相等性失效；批量删除路径之前完全未清理历史记录
- **文件库/项目编辑卡按钮高度对齐**：`new-folder-btn`、`upload-btn` 高度与同行其他按钮统一
- **模板弹窗样式**：换为亮白色（`rgba(255,255,255,0.96)`），与文件库排序菜单保持一致
- **模板弹窗点击内部关闭**：click-outside 检测新增对面板 DOM 的排除，阻止内部点击触发关闭
- **模板重命名 UX**：重命名时删除按钮保持可见，铅笔图标变为对勾（确认）；保存模板行的图标按钮统一为与上方相同的 SVG 图标风格
- **项目备注区域 `textarea` 未绑定**：备注输入框此前无 `v-model`，输入内容不会保存

### 安全

- **用户隔离漏洞修复**（6 处）：
  - `copy_file`：目标 `project_id` / `folder_id` 未验证所有者，用户 A 可将文件复制进用户 B 的项目或文件夹
  - `update_file`：目标 `folder_id` 未验证所有者，用户 A 可将文件移入用户 B 的文件夹
  - `agent create_event`：`project_id` 未验证所有者，可将事件关联到其他用户的项目
  - `update_project` 返回的 `file_count` 未过滤 `user_id`，可泄露其他用户文件数量
- **回收站路径用户隔离**：回收站路径由 `trash/{fid}/` 改为 `{user_id}/trash/{fid}/`，确保多用户环境下回收站文件完全隔离

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
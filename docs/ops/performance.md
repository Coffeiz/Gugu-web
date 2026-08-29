# 咕咕 · 性能优化文档

> 最后更新：2026-08-30（全栈性能盘点）

---

## 易读概述（不懂前端也能看懂）

这篇文档记录的是"为什么咕咕网页版一开始感觉卡、后来怎么变流畅的"，并补充后端、Agent、RAG 和运维侧的性能措施。核心思路就两条：

1. **少下载、少请求**：图片、文件列表这些数据，只要没变就别重新问后端要，用浏览器本地缓存（内存里的、或者刷新也不丢的 sessionStorage）先顶上，用户几乎感觉不到等待。
2. **少占用浏览器的"画图资源"**：有些视觉效果（比如卡片的毛玻璃模糊效果）看着好看，但会让浏览器每次都重新计算一遍怎么画，攒起来就是明显的卡顿感。该效果影响不到实际观感时就把它去掉或换个更省资源的实现方式。

文档里的每一节对应一个具体问题和一个具体修法，越往后越进阶（并发限流、根因排查）。真正的性能瓶颈曾经不在前端这些优化点上，而是**后端一个依赖包没装**（Pillow 缺失导致缩略图功能整体失效，见下面第一节）——这提醒我们排查性能问题时先看有没有更底层的"地基没打好"，再去抠前端细节。

⚠️ **阅读方式**：下面的「当前盘点」是以 2026-08-30 工作区代码为准的现状清单；后面的 §一至 §十三保留历史问题、方案和演进细节。若历史章节和当前盘点冲突，以当前盘点和代码为准。性能数字只有在报告明确给出测试口径时才视为实测，不把经验值写成基准结果。

## 当前盘点（2026-08-30）

### 1. 前端加载、渲染与交互

| 优化 | 当前实现 | 状态与边界 |
|---|---|---|
| 路由级懒加载 | 普通页面、Admin 页面均使用 `component: () => import(...)` | 已落地；首次进入某路由才加载页面 chunk |
| 聊天虚拟列表 | `@tanstack/vue-virtual` 只挂载视口附近消息，动态测量行高 | 已落地；长会话恢复时避免一次性渲染和 Markdown 解析 |
| Markdown 按需解析 | 历史消息先保留 `html: null`，进入虚拟列表后再解析 | 已落地；减少长会话打开时的 CPU 尖峰 |
| 缩略图懒加载 | `useLazyThumb.ts` / 聊天缩略图指令使用 `IntersectionObserver` | 已落地；只在接近视口时取 card 图 |
| 缩略图渐进加载 | tiny 预热、card 按需加载、`Image.decode()` 预解码 | 已落地；降低滚入视口时的下载、解码峰值 |
| 上传/缩略图并发 | `pLimit`，上传 3、缩略图 6 | 已落地；限制单客户端并发，不等于全局限流 |
| 文件领域缓存 | Pinia `useFilesCacheStore` 统一缓存文件夹、文件和 version，并建立 folder/project 索引 | 当前实现；旧的 `services/cache.ts` 扁平 sessionStorage 文件列表缓存已移除 |
| 页面导航缓存 | 文件库导航路径、聊天当前会话使用 sessionStorage | 已落地；仅保存轻量 UI 状态，不作为业务数据真源 |
| 日历缓存 | `CalendarPanel` 模块级事件缓存和节假日缓存 | 已落地；按年月复用，写操作后乐观更新对应缓存 |
| 动态玻璃背景 | 顶栏、日历等易出现白带的场景使用 `GlassBg`；静态卡片保留原生 blur | 已落地；不是全局删除 `backdrop-filter` |
| 代码分包 | 路由分包和 TextViewer 的 CodeMirror 异步加载 | 已落地；构建仍有超大公共 chunk，见「待优化」 |

### 2. 后端 API、数据库和文件处理

| 优化 | 当前实现 | 状态与边界 |
|---|---|---|
| 异步请求链路 | FastAPI async endpoint、SQLAlchemy async session、外部阻塞操作用 `asyncio.to_thread` | 已落地；阻塞库仍需逐项检查，不能只看 endpoint 是否 async |
| 数据库连接池 | `pool_pre_ping`、`pool_size=15`、`max_overflow=25`、`pool_timeout=10`、`pool_recycle=1800` | 已落地；web/worker 每进程独立连接池，连接数需按部署规模核算 |
| 连接池生命周期 | `async with` session、显式 `dispose_engine`、跨事件循环重建旧池 | 已落地；用于降低连接泄漏和 loop 绑定错误，不能替代业务方正确关闭 session |
| 查询边界 | 对会话、事件、文件、搜索、管理列表普遍使用 `limit`/分页；Agent 上下文有项目、事件、笔记和文件上限 | 已落地；复杂管理列表仍应继续检查排序字段索引 |
| 数据库索引 | workspace、knowledge index owner/source/time 等索引，启动初始化带 advisory lock、DDL timeout | 已落地；索引覆盖仍需按真实慢查询补充，不能仅靠 `limit` 保证快 |
| 图片缩略图 | Pillow 生成 WebP，磁盘缓存，失败时小 JPEG fallback，CPU 信号量限制生成并发 | 已落地；缩略图响应 private cache 1 天 |
| 文件/附件响应 | 缩略图、头像和附件使用 private `Cache-Control`；流式接口使用 no-cache 与 `X-Accel-Buffering: no` | 已落地；权限数据不使用公共缓存 |
| 后台化副作用 | 上传后的缩略图预生成、反馈邮件等通过 `BackgroundTasks` | 已落地；后台任务失败不会阻塞主响应，但不提供持久队列保证 |
| 流式传输 | Agent、实时事件、终端使用 `StreamingResponse`；实时通道避免缓存和代理缓冲 | 已落地；客户端断连、provider 延迟仍需单独观测 |

### 3. Agent、LLM 与上下文

| 优化 | 当前实现 | 状态与边界 |
|---|---|---|
| 共享主循环 | Anthropic/OpenAI provider 差异收口到 `LoopDriver`，避免两套循环重复执行 | 已落地；减少维护分叉，不直接减少 provider token |
| Prompt 缓存稳定性 | 静态 system prefix 固定；动态行为、记忆、时间等放到 conversation 的 system reminder | 已落地；目标是保护 provider 前缀缓存，动态尾部不设置缓存锚点 |
| provider 缓存适配 | 按 provider/model 判断自动前缀缓存、显式 cache control、单锚点能力 | 已落地；DeepSeek、MiniMax 等行为不同，不能统一假设 |
| 工具 Schema 注入 | 支持简介模式与全量模式，当前默认简介模式；简介模式为 `description_short + 紧凑字段签名` | 已落地；效果以 `docs/reports/schema-probes/` 和具体 A/B 报告为准 |
| 上下文读取限额 | 项目、事件、最近笔记、个人文件、RAG 结果均有数量/字符上限 | 已落地；控制 prompt 体积，也避免单条大数据拖慢请求 |
| 会话历史限制 | 历史消息有 `HISTORY_MAX_MSGS=500`，上下文压缩有分支输入和摘要字符/token上限 | 已落地；压缩仍会产生一次额外 LLM 请求 |
| 并行上下文加载 | 多来源 RAG、动态上下文等通过 `asyncio.gather` 并行读取 | 已落地；并行度和数据库连接池压力需要一起评估 |
| 运行时观测 | LoopScope 记录 schema token、cache read/write、fresh input、digest 和缓存锚点诊断 | 已落地；只记录脱敏诊断，不记录聊天正文、工具参数和密钥 |

### 4. RAG、记忆和检索

| 优化 | 当前实现 | 状态与边界 |
|---|---|---|
| Python 索引缓存 | 按 owner/backend/revision 缓存，带 TTL、owner/global 字节预算、LRU 和并发锁 | 已落地；多 worker 进程之间不共享 Python 内存 |
| Rust/Tantivy sidecar | 词法检索可走持久化 Rust sidecar，和 Python 路径共用 revision/cache 编排 | 已落地；Admin 可选后端，sidecar 不改变权限过滤和业务表回查责任 |
| Memory scope 缓存 | owner/daily/group/member 文档投影按 revision + 30 分钟 TTL 缓存，写入事件触发失效 | 已落地；revision 读取失败时重建，不把错误缓存成永久结果 |
| 向量缓存 | Memory/Knowledge 文档向量复用 owner cache 与 TTL，按模型/版本区分 | 已落地；向量覆盖不足时按设计回退词法检索 |
| RAG 结果边界 | 最多 10 个 active results、每来源最多 3 个、注入最多 3000 字符 | 已落地；目标是控制延迟和上下文膨胀，不等同于质量保证 |
| 搜索查询限流 | 搜索词长度、查询数量、URL 检查次数、每日额度和外部响应体积均有上限 | 已落地；外部服务延迟仍受供应商影响 |

### 5. 运行时、媒体和沙盒

- 视频转码并发限制为 2；视觉输入在超大尺寸/体积时降采样和压缩，文本抽取有字节与字符上限。
- 沙盒执行有 semaphore、超时、输出上限、PID/CPU/内存/磁盘配额；终端使用 PTY 和流式输出，不把长输出一次性塞进页面。
- IM 会话、绑定任务、上一轮消息和配置同步均使用 TTL；失败的外部连接使用退避或有限重试，避免故障时忙等。
- 文件上传单文件、附件、下载和搜索外部响应都有硬上限，优先保护服务稳定性而不是无限等待。

## 已验证的性能证据

| 领域 | 证据 | 结论 |
|---|---|---|
| Provider prompt cache | `docs/reports/TEST-CACHE-DEEPSEEK-MINIMAX-M3-20RUN-20260825.md`、`docs/reports/TEST-CACHE-MINIMAX-GLM-DEEPSEEK-20RUN-20260826.md` | MiniMax 连续对话缓存稳定性较好；DeepSeek 受前缀边界和 provider 行为影响，不能直接类比 |
| Tool Schema | `docs/reports/schema-probes/` 及其 A/B 报告 | 简介/全量差异应同时看 schema token、总 input、cache ratio 和工具参数准确率 |
| RAG lexical | `docs/reports/TEST-RAG-PHASE5-RUST-TANTIVY评估-2026-08-24.md` | sidecar 核心检索显著快于基线，但报告明确不等于生产端到端 P95 |
| 文件缩略图 | 本文 §十二、§十三及对应前端实现 | WebP、懒加载、预解码和并发限制共同解决大图下载与滚动峰值 |

## 当前待优化与观测缺口

1. 前端构建仍有超过 500KB 的 chunk，且 `useOnboarding` 同时静态/动态导入，动态导入未形成真正分包。
2. 数据库连接池按进程创建，web、worker 和 sidecar 的总连接数需要结合部署实例数和 PostgreSQL 上限压测确认。
3. RAG 多 worker 缓存不共享；高并发下可能重复构建同一 owner 的索引，需要跨进程协调或外部缓存时再处理。
4. 当前性能报告覆盖了缓存、RAG 和文件缩略图，但缺少统一的真实用户端到端指标：首屏、路由切换、首 token、工具续轮、API P95/P99 和数据库慢查询。
5. `backdrop-filter` 仍应按动态背景场景取舍；不能用全局删除或全局开启作为统一结论。
6. 性能诊断不得写入聊天正文、附件名、工具参数、用户标识或密钥；新增指标应优先记录时长、计数、大小和脱敏 digest。

## 目录

- [⚠️ 根因：Pillow 未安装导致全量原图降级](#️-根因pillow-未安装导致全量原图降级)
- [一、缩略图 blob 缓存](#一缩略图-blob-缓存usethumpcachejs)
- [二、tiny blob 全局预热](#二tiny-blob-全局预热preloadtinythumbs)
- [三、filesCache sessionStorage 持久化](#三filescache-sessionstorage-持久化)
- [四、总览页去重请求 + fileCount 响应式读缓存](#四总览页去重请求--filecount-响应式读缓存)
- [五、文件库热缓存路径](#五文件库热缓存路径filesindexvue)
- [六、总览 CalendarPanel 事件模块级缓存](#六总览-calendarpanel-事件模块级缓存)
- [七、FilePanel thumbMap 改 shallowRef + 拆分 tiny/card 更新路径](#七filepanel-thumbmap-改-shallowref--拆分-tinycard-更新路径)
- [八、滚动入视口卡顿优化](#八滚动入视口卡顿优化filepanel)
- [九、浮动预览窗口占位图竞速修复](#九浮动预览窗口占位图竞速修复floatpreviewwindow)
- [十、Dashboard 版本前置检查](#十dashboard-版本前置检查跳过无效-list-请求)
- [十一、移除 glass-card 的 backdrop-filter](#十一移除-glass-card-的-backdrop-filter)
- [十二、WebP 缩略图根因修复](#十二webp-缩略图根因修复)
- [十三、并发限流：批量上传 + 缩略图加载](#十三并发限流批量上传--缩略图加载)
- [缓存层总览](#缓存层总览)
- [当前盘点（2026-08-30）](#当前盘点2026-08-30)
- [已验证的性能证据](#已验证的性能证据)
- [当前待优化与观测缺口](#当前待优化与观测缺口)

---

## ⚠️ 根因：Pillow 未安装导致全量原图降级

> **大白话**：本来应该显示的是"缩略图"（几 KB 的小图），结果因为后端少装了一个图片处理库（Pillow），生成缩略图失败后又默默退化成返回原图（可能几 MB）。前端怎么优化缓存都没用——因为下载的东西本身就是错的（该几 KB 的图变成了几 MB）。这是一条典型的"治标不治本"教训：先确认问题真正出在哪一层，再对症下药。
>
> 本节是最重要的一条。上方所有前端优化都是在治标，这里才是真正的性能瓶颈。

`Pillow` 未写入 `requirements.txt`，venv 中从未安装。后端 `_generate_thumbs_sync()` 每次调用都在 `except Exception: pass` 中静默失败，最终降级返回**原始大图**（JPEG/PNG，几百KB ～ 几MB）。

前端将大图 blob 缓存为 `tiny`/`card`，叠加浏览器 HTTP Cache（`max-age=86400`）后，强刷页面也无法触发新的 thumb 请求——uvicorn 日志中完全看不到 `/thumb` 条目。

**修复**：安装 Pillow、修复 RGBA 处理、fetch 加 `cache: 'no-cache'`、降级改输出小 JPEG。详见[十二、WebP 缩略图根因修复](#十二webp-缩略图根因修复)。

---

## 一、缩略图 blob 缓存（useThumbCache.js）

### 问题
每次路由切换后进入含缩略图的页面，图片都会重新 fetch、重新淡入，即使图片数据完全没变。

### 方案

**模块级 blob Map（跨路由持久化）**

```js
// composables/useThumbCache.js
const cache   = new Map()   // `${id}_${size}` → blob URL
const pending = new Map()   // 防并发重复 fetch
```

`cache` 和 `pending` 是模块级变量，SPA 导航不会重置。命中缓存时直接返回已有的 `blob:` URL，避免重复网络请求和 `URL.createObjectURL`。

**`thumbLoadedIds`：模块级 reactive Set**

```js
export const thumbLoadedIds = reactive(new Set())
```

原来每个页面用组件局部的 `loadedThumbs = reactive(new Set())`，路由离开即销毁，回来后所有图片重新淡入。改为模块级后，已加载的图片跨路由记忆，`fc-loaded` 类不丢失。

### 效果
- 二次进入文件库/项目页：缩略图零网络请求，零淡入动画

---

## 二、tiny blob 全局预热（preloadTinyThumbs）

### 问题
进入页面时图片区域一片空白，等待网络才能显示模糊占位图。

### 方案

```js
export function preloadTinyThumbs(files) {
  for (const f of files) {
    if (_IMG_EXTS.has((f.ext || '').toLowerCase()) && !cache.has(`${f.id}_tiny`)) {
      getThumb(f.id, 'tiny').catch(() => {})
    }
  }
}
```

在以下时机静默后台预热 tiny blob：
- **总览页 FilePanel** `onMounted` 及 `watch(filesCache.ref)` 回调
- **文件库** `watch(() => contents.value.files, ...)`
- **ProjectModal** 打开时

tiny 尺寸仅 20px WebP，预热成本极低，完成后 `getCachedThumb(id, 'tiny')` 同步命中，用于 blur-up 渐进式加载。

**`v-lazy-src` 指令 tiny 优先策略（Files / ProjectModal）**

文件库和项目 Modal 使用 `v-lazy-src` IntersectionObserver 指令懒加载缩略图。原来 tiny 和 card 都走 Observer，两者几乎同时进视口、同时 fetch，无法保证 tiny 先出现。

改为：`size === 'tiny'` 时跳过 Observer，直接后台 fetch；card 仍走 Observer 懒加载。

```js
if (size === 'tiny') {
  getThumb(id, size).then(url => { if (url) el.src = url })
  return   // 不设 Observer，tiny 始终先于 card 出现
}
// card：仍走 IntersectionObserver，进视口附近再 fetch
```

结合 `preloadTinyThumbs`，二次访问时 tiny 已在 blob Map 中，`getCachedThumb` 同步命中，模板挂载时立即设置 `el.src`，blur 占位从第一帧开始可见。

### 效果
- 首次访问：tiny 后台 fetch（~50ms），blur 占位先于 card 出现，card 进视口后 fade in
- 二次访问：tiny 缓存命中，blur 占位第一帧即可见；card 走 Observer 按需 fetch

---

## 三、filesCache sessionStorage 持久化

### 问题
刷新页面或首次进入总览，需等待 `filesApi.list()` 返回才能渲染文件列表，出现空帧。

### 方案

```js
// services/cache.js
const SS_KEY   = 'gugu_files_cache'
const _fileList = shallowRef(readSS())   // 启动时从 sessionStorage 同步读取

export const filesCache = {
  get data() { return _fileList.value },
  ref: _fileList,                         // 响应式引用，供 watch/computed 使用
  set(data) { _fileList.value = data; writeSS(data) },
  clear()   { _fileList.value = null; sessionStorage.removeItem(SS_KEY) },
}
```

- `shallowRef` 作底层，`.ref` 暴露给 `watch` 使用
- `readSS()` 在模块初始化时同步执行，第一帧即有数据
- `sessionStorage` 随 tab 关闭自动清理，不会携带跨 session 的脏数据

### 效果
- 刷新后第一帧即渲染文件列表，无空白

---

## 四、总览页去重请求 + fileCount 响应式读缓存

### 问题
`Dashboard/index.vue` 和 `FilePanel.vue` 各自调一次 `filesApi.list()`，进入总览会触发两次相同请求；`fileCount` 等 API 回包才能更新。

### 方案

**`index.vue`**：只保留一次 `filesApi.list()`，结果写入 `filesCache`。
```js
const fileCount = computed(() => filesCache.ref.value?.length ?? '—')

onMounted(async () => {
  const fresh = await filesApi.list()
  filesCache.set(fresh)
})
```

**`FilePanel.vue`**：移除独立请求，改为 `watch(filesCache.ref)` 响应更新：
```js
watch(filesCache.ref, (list) => {
  if (!list?.length) return
  rawFiles.value = list
  preloadTinyThumbs(list)
  loadThumbs(list.slice(0, 7))
})
```

### 效果
- 进入总览只有 1 次文件列表请求
- `fileCount` 从缓存立即读取，不等网络

---

## 五、文件库热缓存路径（Files/index.vue）

### 问题
即使 `cacheStore` 已加载（从其他页面跳转），`onMounted` 仍 `await` 所有初始化 Promise，导致空帧闪烁。

### 方案

```js
onMounted(async () => {
  if (cacheStore.loaded && projectStore.projects.length > 0) {
    restoreNav()
    loadContents()   // 同步读缓存，不 await
    return           // 跳过网络请求，直接渲染
  }
  await Promise.all([...])
  restoreNav()
  loadContents()
})
```

热路径提前 `return`，跳过所有 `await`，`loadContents` 从 `cacheStore` 同步读取数据，第一帧即有内容。

### 效果
- 从其他页面进入文件库：内容立即出现，无空帧

---

## 六、总览 CalendarPanel 事件模块级缓存

### 问题
每次进入总览都调 `eventsApi.list(year, month)`；节假日数据虽有 `useHolidays` 的模块级 `memCache`，但组件局部的 `hdayCache` 每次挂载都为空，仍需走 Promise 链。

### 方案

```js
// CalendarPanel.vue（组件外，模块级）
const _eventsCache = new Map()   // key: `${year}-${month}` → Event[]
const _hdayStore   = {}          // key: year → holiday data
```

**事件缓存：**
```js
async function loadEvents() {
  const key = `${year.value}-${month.value}`
  if (_eventsCache.has(key)) { events.value = _eventsCache.get(key); return }
  const data = await eventsApi.list(year.value, month.value)
  events.value = data
  _eventsCache.set(key, data)
}
```

**节假日缓存：**
```js
const hdayCache = ref(_hdayStore)   // ref 指向同一对象，触发响应式

async function loadHolidays() {
  let changed = false
  for (const yr of years) {
    if (!_hdayStore[yr]) { _hdayStore[yr] = await fetchYear(yr); changed = true }
  }
  if (changed) hdayCache.value = { ..._hdayStore }
}
```

**写操作乐观更新 + 失效缓存：**
```js
async function saveEditForm() {
  events.value = events.value.map(e => e.id === ev.id ? { ...e, ...patch } : e)
  _eventsCache.set(`${year.value}-${month.value}`, events.value)
  await eventsApi.update(ev.id, patch)
}
```

### 效果
- 二次进入总览：`eventsApi.list()` 零请求，日历立即渲染

---

## 七、FilePanel thumbMap 改 shallowRef + 拆分 tiny/card 更新路径

### 问题

**问题 A**：`thumbMap = reactive({})` 每写一次 `thumbMap[id] = ...` 触发一次 Vue reactive update，7 张图片 × 每张写 3 次 = ≥21 次 trigger。

**问题 B**：原来用 `Promise.all([tiny, card])` 捆绑更新，导致渐进式 blur-up 失效（见方案内表格）。

### 方案

```js
const thumbMap = shallowRef({})

function loadThumbs(list) {
  const imgFiles = list.filter(f => isImageExt(f.ext))

  // 同步：写入所有已缓存的 tiny 和 card（1 次 trigger）
  const snap = { ...thumbMap.value }
  imgFiles.forEach(f => {
    snap[f.id] = { tiny: getCachedThumb(f.id, 'tiny'), card: getCachedThumb(f.id, 'card') }
  })
  thumbMap.value = snap

  // 异步 tiny（未缓存时各自独立到达，尽早显示 blur 占位）
  imgFiles.forEach(f => {
    if (snap[f.id]?.tiny) return
    getThumb(f.id, 'tiny').then(url => {
      if (url) thumbMap.value = { ...thumbMap.value, [f.id]: { ...thumbMap.value[f.id], tiny: url } }
    })
  })

  // 异步 card（批量等待，全部 resolve 后一次写入）
  const uncachedCards = imgFiles.filter(f => !snap[f.id]?.card)
  if (uncachedCards.length) {
    Promise.all(uncachedCards.map(f =>
      getThumb(f.id, 'card').then(url => ({ id: f.id, url }))
    )).then(results => {
      const m = { ...thumbMap.value }
      for (const { id, url } of results) if (url) m[id] = { ...m[id], card: url }
      thumbMap.value = m
      preDecodeBlobs(m)
    })
  } else {
    preDecodeBlobs(snap)
  }
}
```

**时间线（均未缓存时）：**
```
0ms    → snap 写入（tiny: null, card: null），1 次 trigger
~50ms  → tiny 各自 resolve → blur 占位出现（最多 N 次 trigger）
~200ms → Promise.all(cards) resolve → fade in（1 次 trigger）
```

**原 `Promise.all([tiny, card])` 的渐进式失效场景：**

| 缓存状态 | 原行为 | 现行为 |
|---------|--------|--------|
| tiny + card 均已缓存 | 同时写入，直接显示 card，无 blur-up | 同时写入（数据已热，无需占位，合理） |
| 均未缓存 | 等 card 完成才一起写，tiny 的 50ms 窗口浪费 | tiny 50ms 到达即显示 blur，card 200ms fade in |
| tiny 缓存、card 未缓存 | 偶然正常 | 正常 |

### 效果
- reactive trigger 从 ≥21 次降到 2+N 次（N ≤ 7，tiny 极小几乎同帧 resolve）
- 渐进式 blur-up 在所有缓存状态下均正确生效

---

## 八、滚动入视口卡顿优化（FilePanel）

### 问题
浏览器窗口不够高时，FilePanel 在视口外。每次滚动到 FilePanel 区域都会卡一帧，原因：
1. **图片解码 + GPU 纹理上传**：7 张 blob URL 图片同时进入视口，在同一帧内完成解码 + 上传
2. **backdrop-filter 合成层创建**：glass-card 的 `backdrop-filter` 在 FilePanel 进入视口时需要捕获背景快照并创建合成层，每次导航后重建

### 方案

**`img.decode()` 预解码（离屏时提前完成）**

```js
function preDecodeBlobs(map) {
  for (const entry of Object.values(map)) {
    for (const url of [entry?.tiny, entry?.card]) {
      if (url) { const i = new Image(); i.src = url; i.decode().catch(() => {}) }
    }
  }
}
```

`loadThumbs` 完成后立即调用，在 FilePanel 还在视口外时把解码和 GPU 上传做完。滚入时直接取已解码的结果，当帧无 CPU/GPU 峰值。

> `content-visibility: auto` 曾用于延迟渲染 FilePanel，但实测滚动时仍有卡顿感，且整页加载完整体验更好，已移除。

### 效果
- `preDecodeBlobs` 消除滚动进入时的图片解码峰值

---

## 九、浮动预览窗口占位图竞速修复（FloatPreviewWindow）

### 问题

`FloatPreviewWindow` 的渐进式加载策略：先显示 card 缩略图作占位，全图下载完成后淡出占位图。

但占位图使用直接 HTTP URL（`?token=` 查询参数格式），与 `useThumbCache.js` 走 `Authorization: Bearer` + blob Map 的请求通道完全不同，浏览器 HTTP cache key 不一致，每次都发新网络请求。

```js
// 原来：HTTP URL，每次新请求
const placeholderSrc = computed(() =>
  `${BASE_URL}/files/${file.id}/thumb?token=${token}&size=card`
)
```

`onPlaceholderLoad` 里的保护逻辑：
```js
if (blobUrl.value) return  // 全图已到，跳过占位图
```

当全图（download 接口）比 card 缩略图先下载完成时（文件小 / 网络快），`blobUrl` 已有值，渐进效果被跳过，直接显示全图无过渡。

### 方案

`placeholderSrc` 改为 `ref`，在 `load()` 里优先从 blob Map 同步命中，未缓存时后台 fetch：

```js
const placeholderSrc = ref(null)

async function load(f) {
  placeholderSrc.value = null
  // ...
  if (isImg.value && !_SVG_EXTS.has(f.ext?.toUpperCase())) {
    const cached = getCachedThumb(f.id, 'card')
    if (cached) {
      placeholderSrc.value = cached          // 同步命中，第一帧即有占位图
    } else {
      getThumb(f.id, 'card').then(url => {
        if (url && !imageReady.value) placeholderSrc.value = url
      })
    }
  }
}
```

### 效果
- 文件列表/总览已预热 card blob → `getCachedThumb` 同步命中率接近 100%，占位图第一帧出现，全图无论多快都追不上
- 未缓存时：`getThumb` 与全图下载并行，card 体积小通常先到
- 渐进式过渡（模糊占位 → 清晰全图）在所有情况下稳定生效

---

## 十、Dashboard 版本前置检查（跳过无效 list 请求）

### 问题

Dashboard `onMounted` 无条件调用 `filesApi.list()`，即使文件数据未发生任何变化：

```js
// 每次进入总览都执行，即使数据没变
const fresh = await filesApi.list()
filesCache.set(fresh)  // 触发 watch → FilePanel loadThumbs → preDecodeBlobs
```

导致每次进总览都有一次完整的 list 请求 + FilePanel 级联重渲染。

### 方案

先请求轻量的 `/files/version`（返回 `count:max_updated:max_deleted` 摘要），与 sessionStorage 存储的上次版本比对，版本未变时直接返回：

```js
// services/cache.js
export const filesCacheVersion = {
  get()    { return sessionStorage.getItem('gugu_files_version') },
  set(ver) { sessionStorage.setItem('gugu_files_version', ver) },
}

// Dashboard/index.vue
onMounted(async () => {
  const { version: ver } = await filesApi.version()
  if (ver && ver === filesCacheVersion.get() && filesCache.data) return  // 跳过
  const fresh = await filesApi.list()
  filesCache.set(fresh)
  if (ver) filesCacheVersion.set(ver)
})
```

### 效果
- 文件未变时：1 次轻量 version 请求，FilePanel 零更新，进总览速度接近进文件库
- 文件有变化时：正常 version + list 双请求，数据刷新

---

## 十一、移除 glass-card 的 backdrop-filter

### 问题

`.glass-card` 全局类带有 `backdrop-filter: blur(20px)`，用于主体面板（总览各卡片、文件库、日历）。

但这些面板背后是页面固定背景渐变（`#e8e9ee → #9aa2b8`，160deg 线性渐变），对平滑渐变应用 blur 与不 blur 视觉上完全无差异。

同时 `backdrop-filter` 有固定的 GPU 成本：每次带有该属性的元素**进入视口**，浏览器必须执行"捕获背景快照 → 应用 blur → 生成合成层"，这无法预计算或缓存。FilePanel 是总览页唯一可能在屏外的大型面板，滚入时必然触发一次 backdrop 合成峰值，是滚动卡顿的根因。

### 方案

从 `global.css` 的 `.glass-card` 中删除 `backdrop-filter`：

```css
/* 移除前 */
.glass-card {
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  ...
}

/* 移除后 */
.glass-card {
  background: var(--glass-bg);
  /* 无 backdrop-filter */
  ...
}
```

真正需要 blur 的浮层（侧边栏、BaseModal、ContextMenu、FloatPreviewWindow、DatePicker、日历事件弹窗等）均**单独声明** `backdrop-filter`，不受此次改动影响。

### 视觉影响

| 类型 | 影响 |
|------|------|
| 主体面板（总览/文件库/日历） | 无视觉变化（背后是平滑渐变，blur 本已不可见） |
| 侧边栏 / 弹窗 / 右键菜单 / 浮层 | 不受影响（各自独立声明 backdrop-filter） |

### 效果
- FilePanel 滚入视口时无 backdrop 捕获峰值，滚动流畅
- 所有主体页面进入时减少 5+ 个 backdrop-filter 合成层的创建开销

### ⚠️ 现状更新（2026-07-02 核实）

**本节描述的"全局移除"已不是当前状态。** 2026-07-01（0.15.1，见 `CHANGELOG.md`）起，`.glass-card` 的 `backdrop-filter` 已经**恢复**（当前 `frontend/src/assets/styles/global.css` 第 42–51 行可见 `backdrop-filter: var(--glass-blur)`）。

后续演进为**按需方案**，而不是简单地"全站都不要 blur"：
- 日历页面（`Calendar/index.vue`）和顶栏（`DefaultLayout.vue`）此前用 `.glass-card` 时，在 hover 会动的内容上出现了"白带"视觉伪影（Chrome `backdrop-filter` 边缘重栅格问题），排查发现这两处场景本节的合成隔离手段无法根治。改用新组件 `GlassBg`（`components/common/GlassBg.vue`）——不依赖 `backdrop-filter`，而是用页面背景的静态副本叠一层半透明磨砂，视觉效果接近但不占用实时合成开销，也彻底避免白带问题。
- 真正拖累滚动的根因除了本节说的合成层创建，还包括日历卡片 `box-shadow: inset` 这类**主线程重绘**（perf trace 定位），已改为合成层友好的 opacity 叠层方案。
- 其余静态背景的面板（无会动内容遮挡）恢复用回原生 `backdrop-filter`，因为对着平滑渐变背景视觉上和不加区别不大，且没有白带问题。

一句话总结：**这条优化的结论从"全局删掉"演变为"哪里会闪白带就换 GlassBg，其余保留原生 blur"**。详见项目记忆 `gugu-glass-backdrop-filter.md` 或 `CHANGELOG.md` 0.15.1 条目。

---

## 十二、WebP 缩略图根因修复

### 问题

`Pillow` 未写入 `requirements.txt`，venv 中从未安装。所有缩略图生成静默失败，降级返回原始大图。浏览器 HTTP Cache（`max-age=86400`）进一步缓存了这些大图响应，强刷也不发新请求。

### 修复清单

**后端 `requirements.txt`**
```
Pillow>=10.0.0
```

**`_generate_thumbs_sync`**：修复色彩模式处理
```python
img = Image.open(_io.BytesIO(raw))
if img.mode not in ("RGB", "RGBA"):
    img = img.convert("RGBA") if "transparency" in img.info else img.convert("RGB")
```

**`get_thumb` 端点**：降级链路改为小 JPEG，移除静默异常
```python
except Exception as e:
    print(f"[缩略图] WebP 生成失败 fid={fid}: {e}\n{traceback.format_exc()}")

# 降级：小 JPEG（非原图）
jpeg_bytes = await asyncio.to_thread(_generate_thumb_jpeg_fallback, raw, size)
# 最后兜底才返回原图
```

**`useThumbCache.js`**：绕过 HTTP Cache 确保拿到最新 WebP
```js
const p = fetch(`${BASE}/files/${id}/thumb?size=${size}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  cache: 'no-cache',
})
```

### 效果

- tiny：几百字节 WebP → blur 占位图正常
- card：几 KB WebP → 渐进式加载正常
- 所有前端优化（preDecodeBlobs、懒加载、shallowRef）得以真正生效

---

## 十三、并发限流：批量上传 + 缩略图加载

### 问题

浏览器对单域名 HTTP/1.1 连接约 6 条上限。批量拖入几十个文件时：

- **上传**：`ProjectModal.uploadFiles` 原本 `Promise.allSettled(tasks.map(...))` **一次性把所有上传请求全发出去**，无上限；
- **缩略图**：上传完成 + 列表渲染又同时触发同样多的 `/thumb` 请求。

两者叠加瞬间打满浏览器连接和服务器带宽，尾部请求排队超时 → 503 / 网络错误。低配生产（2C/2G + 有限带宽）尤其明显。

### 方案：共享并发限流器

抽出 `@/utils/concurrency.ts`（原 `.js`，已随项目 TS 迁移转为 TypeScript）的 `pLimit(n)`——任务排队、按阈值放行、完成即补位。**上传与缩略图加载共用同一实现**，阈值集中在该文件末尾两个常量，带宽吃紧时只调一处：

```js
export const UPLOAD_CONCURRENCY = 3   // 同时上传的文件数
export const THUMB_CONCURRENCY  = 6   // 同时加载的缩略图数（贴浏览器单域名连接上限）
```

| 限制点 | 位置 | 阈值 |
|--------|------|------|
| 同时上传文件数 | `ProjectModal.vue` 批量上传（`limit(async () => …)` 包住每个任务） | `UPLOAD_CONCURRENCY = 3` |
| 同时加载缩略图数 | `useThumbCache.js` `getThumb` / `getThumbUrl`（替换原 `_acquire/_release`） | `THUMB_CONCURRENCY = 6` |
| 同时生成缩略图数（后端） | `app/api/v1/files.py` `_THUMB_SEM = Semaphore(cpu-1)` | 2C 机 = 1 |

> `UploadModal.vue` / `ProjectCard.vue` 的上传本就是 `for` 串行（同时 1 个），未改。
> ⚠️ 仅**单客户端内**限流；多用户并发仍可能叠加，真要全局限需后端中间件信号量（当前量级不必要）。

---

## 缓存层总览

> **大白话**：本文档一共动用了这几种"记性"，各自记多久、记什么，一张表理清楚——排查"为什么这个数据没刷新/为什么又发了一次请求"时可以对照查。

| 层级 | 实现 | 生命周期 | 用途 |
|------|------|----------|------|
| blob Map | 模块级 `Map`（useThumbCache.js） | SPA 进程内永久 | 缩略图 blob URL，避免重复 fetch |
| thumbLoadedIds | 模块级 `reactive(Set)` | SPA 进程内永久 | 记录已渲染图片，跨路由不重新淡入 |
| filesCache | `shallowRef` + sessionStorage | tab 关闭清理 | 文件列表，刷新后首帧可用 |
| eventsCache | 模块级 `Map`（CalendarPanel.vue） | SPA 进程内永久 | 日历事件，按年月缓存 |
| hdayStore | 模块级 `{}`（CalendarPanel.vue） | SPA 进程内永久 | 节假日数据（配合 useHolidays memCache） |
| useHolidays memCache | 模块级 `Map` + localStorage（30天） | 30 天 | 节假日网络请求结果 |
| preDecodeBlobs | 浏览器解码缓存（Image.decode） | 进程内 | 图片解码结果，滚入视口时零开销 |

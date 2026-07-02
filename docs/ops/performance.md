# 咕咕 · 前端性能优化文档

> 最后更新：2026-07-02（核对 §十一 现状，标注 backdrop-filter 已恢复 + 后续 GlassBg 方案）

---

## 易读概述（不懂前端也能看懂）

这篇文档记录的是"为什么咕咕网页版一开始感觉卡、后来怎么变流畅的"。核心思路就两条：

1. **少下载、少请求**：图片、文件列表这些数据，只要没变就别重新问后端要，用浏览器本地缓存（内存里的、或者刷新也不丢的 sessionStorage）先顶上，用户几乎感觉不到等待。
2. **少占用浏览器的"画图资源"**：有些视觉效果（比如卡片的毛玻璃模糊效果）看着好看，但会让浏览器每次都重新计算一遍怎么画，攒起来就是明显的卡顿感。该效果影响不到实际观感时就把它去掉或换个更省资源的实现方式。

文档里的每一节对应一个具体问题和一个具体修法，越往后越进阶（并发限流、根因排查）。真正的性能瓶颈曾经不在前端这些优化点上，而是**后端一个依赖包没装**（Pillow 缺失导致缩略图功能整体失效，见下面第一节）——这提醒我们排查性能问题时先看有没有更底层的"地基没打好"，再去抠前端细节。

⚠️ **需要注意**：§十一「移除 glass-card 的 backdrop-filter」这条优化后来发生了变化——2026-07-01（0.15.1）起，`.glass-card` 的 `backdrop-filter` 已经**恢复**（当前 `frontend/src/assets/styles/global.css` 里可以看到），改用更精细的按需方案：对会遇到"白带"视觉问题的浮层（顶栏、日历工具栏等，背后是会动的内容）换成不依赖 `backdrop-filter` 的 `GlassBg` 组件；对普通静态背景的卡片保留原生 `backdrop-filter` 也没问题。也就是说 §十一原文描述的"全局移除"已不是当前状态，详见该节末尾的更新说明。

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

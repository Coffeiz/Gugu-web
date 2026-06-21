# 咕咕 · 前端性能优化文档

> 最后更新：2026-06-21

---

## 目录

- [一、缩略图 blob 缓存](#一缩略图-blob-缓存usethumpcachejs)
- [二、tiny blob 全局预热](#二tiny-blob-全局预热preloadtinythumbs)
- [三、filesCache sessionStorage 持久化](#三filescache-sessionstorage-持久化)
- [四、总览页去重请求 + fileCount 响应式读缓存](#四总览页去重请求--filecount-响应式读缓存)
- [五、文件库热缓存路径](#五文件库热缓存路径filesindexvue)
- [六、总览 CalendarPanel 事件模块级缓存](#六总览-calendarpanel-事件模块级缓存)
- [七、FilePanel thumbMap 改 shallowRef + 拆分 tiny/card 更新路径](#七filepanel-thumbmap-改-shallowref--拆分-tinycard-更新路径)
- [八、滚动入视口卡顿优化](#八滚动入视口卡顿优化filepanel)
- [缓存层总览](#缓存层总览)

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

### 效果
- 进入页面时立即显示模糊占位图，card 图加载完成后交叉淡入，无空白帧

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

**`content-visibility: auto`（提前渲染窗口）**

```css
.file-panel {
  content-visibility: auto;
  contain-intrinsic-block-size: 280px;
}
```

浏览器在 FilePanel 进入视口前约一个屏幕高度时，利用空闲帧提前渲染（含 backdrop-filter 合成），把渲染成本从滚动帧分散到空闲期。`contain-intrinsic-block-size` 保留占位高度，防止滚动条跳变。

### 效果
- 滚动到 FilePanel 时不再卡顿

---

## 缓存层总览

| 层级 | 实现 | 生命周期 | 用途 |
|------|------|----------|------|
| blob Map | 模块级 `Map`（useThumbCache.js） | SPA 进程内永久 | 缩略图 blob URL，避免重复 fetch |
| thumbLoadedIds | 模块级 `reactive(Set)` | SPA 进程内永久 | 记录已渲染图片，跨路由不重新淡入 |
| filesCache | `shallowRef` + sessionStorage | tab 关闭清理 | 文件列表，刷新后首帧可用 |
| eventsCache | 模块级 `Map`（CalendarPanel.vue） | SPA 进程内永久 | 日历事件，按年月缓存 |
| hdayStore | 模块级 `{}`（CalendarPanel.vue） | SPA 进程内永久 | 节假日数据（配合 useHolidays memCache） |
| useHolidays memCache | 模块级 `Map` + localStorage（30天） | 30 天 | 节假日网络请求结果 |
| preDecodeBlobs | 浏览器解码缓存（Image.decode） | 进程内 | 图片解码结果，滚入视口时零开销 |

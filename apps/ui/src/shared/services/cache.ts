import { ref } from 'vue'

// 文件列表缓存已统一到全局 Pinia store `@/stores/filesCache`（单一数据源 + SSE + visibilitychange），
// 原先这里那套 sessionStorage 扁平缓存（filesCache / filesCacheVersion，仅 Dashboard/FilePanel 用）已移除。
// 这里只保留跨组件的轻量「变更信号」（纯前端递增、不过网络、不跨标签页）。

export const uploadSignal = ref(0)
// 日历事件变更信号（咕咕对话里增删改活动后 bump，日历页监听并清缓存重取）
export const calendarSignal = ref(0)

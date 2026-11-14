export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

// 小窗尺寸与大窗侧栏宽度：窗口位置计算（GuguChat.vue）和输入框宽度估算
// （GuguChatComposer.vue）都要用同一份数字，避免两处各写一份导致漂移。
export const SMALL_W   = 360
export const SMALL_H   = 360
export const SIDEBAR_W = 220

// 本地存储 key：目前只有 useChatWindow.ts 用，单独收在这里而不是内联字面量，
// 是为了防止将来有第二处需要读同一个 key 时各写一份导致漂移（历史上 SESSION_KEY
// 相关的几个 key 曾经历过这种偏差）。
export const SESSION_KEY        = 'gugu_session_id'
export const LAST_SESSION_KEY   = 'gugu_last_session_id'
export const MINI_PINNED_KEY    = 'gugu_mini_pinned'
export const REOPEN_RESUME_KEY  = 'gugu_reopen_resume'

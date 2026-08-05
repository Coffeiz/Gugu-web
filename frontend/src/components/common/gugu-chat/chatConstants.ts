export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1'

// 小窗尺寸与大窗侧栏宽度：窗口位置计算（GuguChat.vue）和输入框宽度估算
// （GuguChatComposer.vue）都要用同一份数字，避免两处各写一份导致漂移。
export const SMALL_W   = 360
export const SMALL_H   = 360
export const SIDEBAR_W = 220

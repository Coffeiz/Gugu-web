// 对话框默认问候：进入「全新对话（无可恢复会话）」时后台生成一次（内存 ref，不跨刷新缓存）。
// 由 GuguChat onMounted 据 SESSION_KEY 决定——刷新停在老会话时不生成（问候那时根本不显示）。
// 打开对话框时以打字机动画显示；生成没好/失败 → 从兜底池随机取一条（兜底同样走打字机）。文案不自我介绍、不报菜单。
import { ref } from 'vue'
import { agentApi } from '@/services/api'

// 静态兜底池（与 docs/对话默认问候-生成方案.md §4.2 一致；改文案动这里）
const FALLBACKS = [
  '回来啦。\n这阵子忙的事，有进展就一起往前推，卡住了也别自己扛。\n想先理清点啥、推进点啥，还是随便聊聊？都行。',
  '咕咕在呢。\n该做的我帮你盯着，容易忘的我帮你记着，别让事情悄悄跑丢。\n今天想从哪件开始？不急也没关系。',
  '嘿，在的。\n不管是要推进的事、要理清的念头，还是想找个人说说，我都在。\n你说，我听着。',
  '来啦~\n手头那些要做的、要记的、要想明白的，交给我一起整。\n想先弄哪样，直接说就行。',
  '等你半天啦。\n这地方会慢慢攒下你做过、想过、聊过的东西。\n今天，想先做点啥、聊点啥？',
]
function pickFallback() { return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] }

// 生成好的问候（响应式，仅本次页面生命周期；刷新即重置 → 每次刷新重新生成）
export const greeting = ref('')

// 挂载时后台预取一次（fire-and-forget，不阻塞）
export async function prefetchGreeting() {
  try {
    if (greeting.value) return
    const { text } = await agentApi.greeting()
    const t = (text || '').trim()
    if (t) greeting.value = t
  } catch { /* 静默：取问候时走兜底 */ }
}

// 取问候：有生成版用生成版，否则随机兜底（永不空）
export function getGreeting() {
  return greeting.value || pickFallback()
}

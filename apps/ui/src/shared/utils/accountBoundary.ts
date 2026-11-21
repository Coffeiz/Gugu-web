import { ref } from 'vue'

/** 账号切换边界：阻止旧账号的持久化状态和异步响应进入新账号。 */
export const accountBoundaryEpoch = ref(0)

const ACCOUNT_SCOPED_KEYS = [
  'gugu_audio_file', 'gugu_last_bubble_id', 'gugu_reopen_resume',
  'gugu_session_id', 'gugu_last_session_id', 'files_nav_path', 'mind-last-canvas-id',
]

export function getAccountBoundaryEpoch(): number { return accountBoundaryEpoch.value }

export function beginAccountBoundary(): number {
  accountBoundaryEpoch.value += 1
  for (const key of ACCOUNT_SCOPED_KEYS) {
    try { localStorage.removeItem(key) } catch {}
    try { sessionStorage.removeItem(key) } catch {}
  }
  return accountBoundaryEpoch.value
}

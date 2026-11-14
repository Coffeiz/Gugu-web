import notificationUrl from '@/assets/sounds/gugu-notification.wav'
import messageUrl from '@/assets/sounds/gugu-message.wav'
import doneUrl from '@/assets/sounds/gugu-done.wav'
import errorUrl from '@/assets/sounds/gugu-error.wav'
import uploadedUrl from '@/assets/sounds/gugu-uploaded.wav'

export type GuguSfx = 'notification' | 'message' | 'done' | 'error' | 'uploaded'

const sources: Record<GuguSfx, string> = {
  notification: notificationUrl,
  message: messageUrl,
  done: doneUrl,
  error: errorUrl,
  uploaded: uploadedUrl,
}

const players = new Map<GuguSfx, HTMLAudioElement>()
const volume = 0.35

/** 页面音效统一入口；浏览器尚未允许播放时静默忽略，不影响业务操作。 */
export function playGuguSfx(kind: GuguSfx) {
  if (typeof window === 'undefined') return
  let player = players.get(kind)
  if (!player) {
    player = new Audio(sources[kind])
    player.preload = 'auto'
    player.volume = volume
    players.set(kind, player)
  }
  player.currentTime = 0
  void player.play().catch(() => undefined)
}

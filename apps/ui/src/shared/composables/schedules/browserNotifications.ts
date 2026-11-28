import { ref, watch } from 'vue'
import { scheduledTasksApi } from '@/services/api'
import { useAuthStore } from '@/stores/auth'
import { confirmDialog } from '@/composables/core/useConfirmDialog'
import { showAppNotice } from '@/composables/core/useAppToast'
import { browserPushSupported, disableBrowserPush, enableBrowserPush, prepareBrowserPush, refreshBrowserPush, pushSubscriptionId, trackBrowserPushChange } from '@/services/browserPush'

type PushContext = Awaited<ReturnType<typeof prepareBrowserPush>>
const pushAvailable = ref(false)
const pushEnabled = ref(false)
const pushBusy = ref(false)
let pushContext: PushContext | undefined

export const browserReminderControls = { pushAvailable, pushEnabled, pushBusy }

export function toggleBrowserPush(ownerId: string, current: () => boolean) {
  if (!pushContext || pushBusy.value) return
  const context = pushContext
  pushBusy.value = true
  return trackBrowserPushChange((async () => {
    if (pushEnabled.value) {
      await disableBrowserPush(ownerId)
      if (current()) {
        pushEnabled.value = false
        localStorage.setItem(snooze, String(Date.now() + week))
      }
    } else {
      await enableBrowserPush(context, ownerId, current)
      if (current()) pushEnabled.value = Boolean(pushSubscriptionId(ownerId))
    }
  })().catch(() => {
    if (!current()) return
    showAppNotice(Notification.permission === 'denied'
      ? '请在浏览器站点设置中允许通知，再试一次。'
      : '无法更新浏览器推送，请稍后重试。')
  }).finally(() => {
    pushBusy.value = false
  }))
}

const snooze = 'gugu:browser-reminders:snooze'
const week = 7 * 24 * 60 * 60 * 1000

function supported() {
  return window.isSecureContext && typeof Notification !== 'undefined'
}

export function useBrowserReminderPermission() {
  const auth = useAuthStore()
  watch(() => auth.sessionChecked ? auth.user?.id : null, async (id, _previous, onCleanup) => {
    pushAvailable.value = false
    pushEnabled.value = false
    pushContext = undefined
    if (!id || !supported()) return
    let current = true
    onCleanup(() => { current = false })
    try {
      if (browserPushSupported()) {
        const context = await prepareBrowserPush().catch(() => undefined)
        if (!current) return
        if (context) {
          pushContext = context
          pushAvailable.value = true
          const active = await refreshBrowserPush(context, id, () => current)
          if (current) pushEnabled.value = active
        }
      }
      if (!current || pushEnabled.value || (!pushContext && Notification.permission === 'granted')) return
      if (Number(localStorage.getItem(snooze)) > Date.now()) return
      if (!(await scheduledTasksApi.pendingWebNotifications()).pending || !current) return
      const denied = Notification.permission === 'denied'
      const accepted = await confirmDialog({
        title: '浏览器提醒',
        message: denied ? '你有待执行的提醒。此浏览器已关闭通知，可在站点权限中重新开启。'
          : pushContext ? '你有待执行的提醒。开启浏览器推送后，关闭网页也能收到提醒。'
            : '你有待执行的提醒。开启浏览器通知后，此设备可以收到弹窗。',
        confirmText: denied ? '查看开启方法' : '开启通知',
        cancelText: '稍后',
      })
      if (!current) return
      localStorage.setItem(snooze, String(Date.now() + week))
      if (!accepted) return
      if (denied) {
        showAppNotice('点击地址栏旁的站点设置图标，将「通知」设为允许。')
        return
      }
      if (pushContext) await toggleBrowserPush(id, () => current)
      else await Notification.requestPermission()
    } catch { /* 站内提醒照常投递。 */ }
  }, { immediate: true })
}

export async function showBrowserReminder(value: { source?: string; id?: number; title?: string; content?: string }) {
  if (!supported() || Notification.permission !== 'granted' || value.source !== 'scheduled_task'
    || pushSubscriptionId(useAuthStore().user?.id) || !Number.isSafeInteger(value.id) || !value.title) return
  const tag = `gugu:reminder:${value.id}`
  function show() {
    try {
      const seen = (localStorage.getItem('gugu:shown-browser-reminders') ?? '').split(',')
      if (seen.includes(tag)) return
      const notice = new Notification(value.title!, { body: value.content, tag })
      localStorage.setItem('gugu:shown-browser-reminders', [...seen.slice(-63), tag].join(','))
      notice.onclick = () => { window.focus(); notice.close() }
    } catch { /* 站内提醒已保存。 */ }
  }
  try {
    if (navigator.locks) await navigator.locks.request(tag, show)
    else show()
  } catch { /* 浏览器未提供跨标签页协同。 */ }
}

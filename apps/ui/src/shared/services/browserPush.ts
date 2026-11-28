import { del, get, post } from '@/api/client'

const storageKey = 'gugu:web-push'
const workerPath = '/reminder-worker.js'
type Binding = { id: string; ownerId: string }
let pendingChange: Promise<void> | undefined

export function trackBrowserPushChange(change: Promise<void>) {
  pendingChange = change.finally(() => { pendingChange = undefined })
  return pendingChange
}

export const waitForPushChange = () => pendingChange

function binding(): Binding | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (typeof value?.id === 'string' && typeof value.ownerId === 'string') return value
  } catch { /* 本地没有可用的订阅记录。 */ }
}

export function browserPushSupported() {
  return window.isSecureContext && 'PushManager' in window && 'serviceWorker' in navigator
}

export function pushSubscriptionId(ownerId?: string) {
  const saved = binding()
  return saved?.ownerId === ownerId ? saved?.id : undefined
}

export async function prepareBrowserPush() {
  const { publicKey } = await get<{ publicKey: string }>('/notifications/push/key')
  const candidate = await navigator.serviceWorker.register(workerPath)
  const registration = candidate.active ? candidate : await navigator.serviceWorker.ready
  return { publicKey, registration }
}

type PushContext = Awaited<ReturnType<typeof prepareBrowserPush>>

export async function enableBrowserPush({ publicKey, registration }: PushContext, ownerId: string, current: () => boolean) {
  const applicationServerKey = Uint8Array.from(
    atob(publicKey.replace(/-/gu, '+').replace(/_/gu, '/')), character => character.charCodeAt(0),
  )
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
  if (!current()) return
  const { id } = await post<{ id: string }>('/notifications/push/subscriptions', subscription.toJSON())
  if (current()) localStorage.setItem(storageKey, JSON.stringify({ id, ownerId }))
}

export async function refreshBrowserPush({ registration }: PushContext, ownerId: string, current: () => boolean) {
  const id = pushSubscriptionId(ownerId)
  if (!id) return false
  const existing = await registration.pushManager.getSubscription()
  if (existing && Notification.permission === 'granted') {
    const { active } = await get<{ active: boolean }>(`/notifications/push/subscriptions/${encodeURIComponent(id)}`)
    if (active) return current()
  }
  if (current()) await disableBrowserPush(ownerId)
  return false
}

export async function disableBrowserPush(ownerId: string) {
  const id = pushSubscriptionId(ownerId)
  if (id) await del(`/notifications/push/subscriptions/${encodeURIComponent(id)}`)
  await clearBrowserPush(ownerId)
}

export async function clearBrowserPush(ownerId: string) {
  if (!pushSubscriptionId(ownerId)) return
  localStorage.removeItem(storageKey)
  if (!browserPushSupported()) return
  const registration = await navigator.serviceWorker.getRegistration(workerPath)
  const subscription = await registration?.pushManager.getSubscription()
  await subscription?.unsubscribe()
}

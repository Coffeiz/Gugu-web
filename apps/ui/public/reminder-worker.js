self.addEventListener('push', event => {
  let id
  try { id = event.data?.json()?.id } catch { return }
  if (!Number.isSafeInteger(id) || id <= 0) return
  event.waitUntil(self.registration.showNotification('咕咕提醒', {
    body: '你有一条新的提醒',
    icon: '/apple-touch-icon.png',
    tag: `gugu:reminder:${id}`,
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL('/projects?notifications=open', self.location.origin).href
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const page = pages.find(item => item.url === target)
    if (page) {
      await page.focus()
      page.postMessage({ type: 'gugu:open-notifications' })
    } else await self.clients.openWindow(target)
  })())
})

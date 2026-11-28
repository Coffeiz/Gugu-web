import { computed, inject, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { eventsApi } from '@/api/calendar'
import { useScheduleAccess } from '@/services/scheduleAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { sanitizeChatHtml } from '@/utils/markdown'
import { objectCardFact, objectCardLoading } from './chatObjectCards'
import { chatCalendarEventsKey, type ChatCalendarEvent } from './chatPresentationAccess'

function eventCards(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLAnchorElement>('a.chat-object-card[data-object-type="event"]')].flatMap(card => {
    const id = Number(/^gugu:\/\/open-object\/event\/([1-9]\d*)$/u.exec(card.getAttribute('href') ?? '')?.[1])
    return Number.isSafeInteger(id) ? [{ card, id }] : []
  })
}

export function useChatEventCards(html: () => string, enabled: () => boolean) {
  const localEvents = inject(chatCalendarEventsKey, null)
  const schedules = useScheduleAccess()
  const { t, locale } = useI18n()
  const events = shallowRef(new Map<number, ChatCalendarEvent | null>())
  const reminders = shallowRef(new Map<number, number>())
  const missing = shallowRef(new Set<number>())
  const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }))
  const root = computed(() => {
    const source = html()
    if (!enabled() || !source.includes('data-object-type="event"')) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    return element
  })
  const ids = computed(() => [...new Set(root.value ? eventCards(root.value).map(({ id }) => id) : [])].join(','))
  watch([ids, accountBoundaryEpoch], ([keys, epoch], _previous, onCleanup) => {
    events.value = new Map()
    reminders.value = new Map()
    missing.value = new Set()
    if (!keys) return
    let active = true
    onCleanup(() => { active = false })
    const isCurrent = () => active && epoch === accountBoundaryEpoch.value
    const local = localEvents?.().catch(() => undefined)
    for (const id of keys.split(',').map(Number)) {
      void (async () => {
        const event = await (local ? local.then(items => items ? items.find(item => item.id === id) ?? null : undefined) : eventsApi.get(id))
          .catch((error: { status?: number } | null) => error?.status === 404 ? null : undefined)
        if (!isCurrent()) return
        if (event === null) missing.value = new Set(missing.value).add(id)
        events.value = new Map(events.value).set(id, event?.id === id ? event : null)
        if (event?.id !== id || !schedules) return
        const result = await schedules.list(id).catch(() => undefined)
        if (result && isCurrent())
          reminders.value = new Map(reminders.value).set(id, result.tasks.filter(task => task.enabled === true).length)
      })()
    }
  }, { immediate: true })

  return computed(() => {
    if (!root.value || !ids.value) return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const { card, id } of eventCards(output)) {
      const event = events.value.get(id)
      if (event === undefined) card.append(objectCardLoading(t('viewerUi.loading')))
      if (!event) {
        if (missing.value.has(id)) {
          const status = document.createElement('span')
          status.className = 'chat-object-card-snapshot'
          status.textContent = t('mindUi.referenceMissing')
          card.append(status)
        }
        continue
      }
      card.dataset.chatCardLoaded = ''
      const title = card.querySelector('.chat-object-card-title')
      if (title) title.textContent = event.title
      card.setAttribute('aria-label', event.title)
      const date = new Date(`${event.date}T00:00:00Z`)
      if (Number.isFinite(date.getTime())) {
        const time = document.createElement('time')
        time.className = 'chat-note-card-date'
        time.dateTime = event.date
        time.textContent = dateFormat.value.format(date)
        card.querySelector('.chat-object-card-heading')?.append(time)
      }
      const details = document.createElement('span')
      details.className = 'chat-object-card-details'
      const start = event.time?.slice(0, 5)
      const end = event.endTime?.slice(0, 5)
      const time = start ? end ? `${start}–${end}${end < start ? ` ${t('calendar.nextDay')}` : ''}` : start : t('calendar.allDay')
      details.append(objectCardFact(t('chatUi.eventCardTime'), time))
      const count = reminders.value.get(id)
      if (count !== undefined)
        details.append(objectCardFact(t('calendar.reminder'), count ? t('chatUi.eventCardReminders', { count }) : t('chatUi.eventCardNoReminder')))
      card.append(details)
    }
    return output.innerHTML
  })
}

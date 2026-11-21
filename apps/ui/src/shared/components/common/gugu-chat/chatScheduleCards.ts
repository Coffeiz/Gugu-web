import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useScheduleAccess, type ScheduledTask } from '@/services/scheduleAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { sanitizeChatHtml } from '@/utils/markdown'
import { effectiveTimezone } from '@/utils/userTimezone'
import { cronLabel } from '@/views/Schedules/utils/scheduleCron'
import { objectCardFact, objectCardLoading } from './chatObjectCards'

const selector = 'a.chat-object-card[data-object-type="scheduled-task"]'

export function useChatScheduleCards(html: () => string, enabled: () => boolean) {
  const access = useScheduleAccess()
  const { t, locale } = useI18n()
  const tasks = shallowRef<Map<number, ScheduledTask> | null>()
  const root = computed(() => {
    const source = html()
    if (!enabled() || !access || !source.includes('data-object-type="scheduled-task"')) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    return element
  })
  const hasCards = computed(() => Boolean(root.value?.querySelector(selector)))
  watch([hasCards, accountBoundaryEpoch], async ([hasLinks, epoch], _previous, onCleanup) => {
    tasks.value = undefined
    if (!access || !hasLinks) return
    let active = true
    onCleanup(() => { active = false })
    const result = await access.list().catch(() => null)
    if (active && epoch === accountBoundaryEpoch.value)
      tasks.value = result ? new Map(result.tasks.map(task => [Number(task.id), task])) : null
  }, { immediate: true })

  function runTime(task: ScheduledTask) {
    if (task.schedule_kind === 'once') {
      const date = new Date(task.start_at ?? '')
      return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short', timeZone: effectiveTimezone() }).format(date)
        : t('schedules.once')
    }
    if (task.schedule_kind === 'interval' && Number.isFinite(task.interval_minutes))
      return t('schedules.everyMinutes', { minutes: task.interval_minutes })
    if (typeof task.cron !== 'string' || !task.cron.trim()) return ''
    const cron = task.cron.trim().replace(/\s+/g, ' ')
    return /^\d{1,2} \d{1,2} \* \* (?:\*|[0-7](?:[-,][0-7])*)$/u.test(cron) ? cronLabel(cron) : cron
  }

  return computed(() => {
    if (!root.value || !hasCards.value) return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const card of output.querySelectorAll<HTMLAnchorElement>(selector)) {
      if (tasks.value === undefined) card.append(objectCardLoading(t('viewerUi.loading')))
      const id = Number(/^gugu:\/\/open-object\/scheduled-task\/([1-9]\d*)$/u.exec(card.getAttribute('href') ?? '')?.[1])
      const task = tasks.value?.get(id)
      const title = card.querySelector('.chat-object-card-title')
      if (!task || !title || typeof task.name !== 'string') continue
      title.textContent = task.name
      card.setAttribute('aria-label', task.name)
      card.dataset.chatCardLoaded = ''
      const ended = task.schedule_status === 'ended' || (task.end_at && new Date(task.end_at).getTime() < Date.now())
      const state = ended ? 'ended' : task.enabled === true ? 'active' : 'paused'
      const status = document.createElement('span')
      status.className = `chat-schedule-status is-${state}`
      status.textContent = t(state === 'ended' ? 'schedules.ended' : state === 'active' ? 'scheduleUi.cardActive' : 'scheduleUi.cardPaused')
      card.querySelector('.chat-object-card-heading')?.append(status)
      const details = document.createElement('span')
      details.className = 'chat-object-card-details'
      const time = runTime(task)
      if (time) details.append(objectCardFact(t('scheduleUi.cardRunTime'), time))
      details.append(objectCardFact(t('scheduleUi.taskMode'),
        t(task.execution_mode === 'instruction' ? 'scheduleUi.instructionMode' : 'scheduleUi.reminderMode')))
      card.append(details)
      card.querySelector('.chat-object-card-description')?.remove()
      if (typeof task.payload === 'string' && task.payload.trim()) {
        const description = document.createElement('span')
        description.className = 'chat-object-card-description'
        const chars = Array.from(task.payload.trim().replace(/\s+/g, ' '))
        description.textContent = chars.length > 240 ? chars.slice(0, 240).join('') + '…' : chars.join('')
        card.append(description)
      }
    }
    return output.innerHTML
  })
}

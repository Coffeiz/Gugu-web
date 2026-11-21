import { objectCardFact, objectCardLoading } from './chatObjectCards'
import { computed, inject, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { projectAccessKey, type ProjectAccess } from '@/api/projects'
import { mapProjectResponse, type Project } from '@/types/project'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { sanitizeChatHtml } from '@/utils/markdown'
import { extractProjectAccent, PROJECT_COLOR_PRESETS } from '@/utils/projectColors'
import { projectDeadlinePresentation } from '@/composables/shared/useProjectCardBasics'
import { projectProgress } from '@/utils/projectProgress'
import { projectStatusLabelKey } from '@/utils/projectStages'

function projectAnchors(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLAnchorElement>('a.chat-object-card[data-object-type="project"]')]
    .flatMap(anchor => {
      const id = Number(/^gugu:\/\/open-object\/project\/([1-9]\d*)$/.exec(anchor.getAttribute('href') ?? '')?.[1])
      return Number.isSafeInteger(id) ? [{ anchor, id }] : []
    })
}

const requests = new WeakMap<ProjectAccess, Map<string, Promise<Project | undefined>>>()
function readProject(access: ProjectAccess, id: number, epoch: number) {
  const pending = requests.get(access) ?? new Map<string, Promise<Project | undefined>>()
  requests.set(access, pending)
  const key = `${epoch}:${id}`
  const existing = pending.get(key)
  if (existing) return existing
  const request = access.get(id).then(mapProjectResponse)
    .then(project => project.id === id && !project.deletedAt ? project : undefined)
    .catch(() => undefined)
    .finally(() => pending.delete(key))
  pending.set(key, request)
  return request
}

export function useChatProjectCards(html: () => string, enabled: () => boolean) {
  const access = inject(projectAccessKey, null)
  const { t } = useI18n()
  const projects = shallowRef(new Map<number, Project>())
  const pending = shallowRef(new Set<number>())
  const root = computed(() => {
    const source = html()
    if (!enabled() || !access || !source.includes('data-object-type="project"')) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    if (projectAnchors(element).length) return element
  })
  const ids = computed(() => [...new Set(root.value ? projectAnchors(root.value).map(item => item.id) : [])].join(','))
  watch([ids, accountBoundaryEpoch], async ([keys, epoch], _previous, onCleanup) => {
    projects.value = new Map()
    pending.value = new Set(keys ? keys.split(',').map(Number) : [])
    if (!access || !keys) return
    let current = true
    onCleanup(() => { current = false })
    for (const id of keys.split(',').map(Number)) {
      const project = await readProject(access, id, epoch)
      if (!current || accountBoundaryEpoch.value !== epoch) return
      if (project) projects.value = new Map(projects.value).set(id, project)
      const remaining = new Set(pending.value)
      remaining.delete(id)
      pending.value = remaining
    }
  }, { immediate: true })

  function text(className: string, value: string) {
    const span = document.createElement('span')
    span.className = className
    span.textContent = value
    return span
  }
  return computed(() => {
    if (!root.value || (!projects.value.size && !pending.value.size)) return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const { anchor, id } of projectAnchors(output)) {
      const project = projects.value.get(id)
      if (pending.value.has(id)) anchor.append(objectCardLoading(t('viewerUi.loading')))
      const heading = anchor.querySelector('.chat-object-card-heading')
      const title = anchor.querySelector('.chat-object-card-title')
      if (!project || !heading || !title) continue
      anchor.dataset.chatCardLoaded = ''
      const status = text(`chat-project-status is-${project.status}`, t(projectStatusLabelKey(project.status)))
      heading.insertBefore(status, heading.querySelector('.chat-object-card-arrow'))
      title.textContent = project.name
      anchor.setAttribute('aria-label', project.name)

      const details = text('chat-object-card-details', '')
      const stage = project.stages.find(item => item.key === project.currentStage)
      if (stage?.label) details.append(objectCardFact(t('projects.currentPhase'), stage.label))
      if (project.deadline) {
        const deadline = projectDeadlinePresentation(project)
        const fact = objectCardFact(t('calendar.types.deadline'), deadline.label)
        if (deadline.overdue) fact.classList.add('is-overdue')
        else if (deadline.urgent) fact.classList.add('is-urgent')
        fact.title = project.deadline
        details.append(fact)
      }
      if (details.childElementCount) title.after(details)

      const completion = project.status === 'done' ? 100 : projectProgress(project)
      const progress = document.createElement('progress')
      progress.className = 'chat-project-meter'
      const fill = PROJECT_COLOR_PRESETS.includes(project.color) ? project.color : extractProjectAccent(project.color)
      progress.style.setProperty('--chat-project-fill', fill)
      progress.max = 100
      progress.value = completion
      progress.setAttribute('aria-label', t('chatUi.projectCardProgress'))
      const progressRow = text('chat-project-progress', '')
      const progressHeading = text('chat-project-progress-heading', '')
      progressHeading.append(text('chat-object-card-fact-label', t('chatUi.projectCardProgress')), text('chat-project-percent', `${completion}%`))
      progressRow.append(progressHeading, progress)
      anchor.append(progressRow)

    }
    return output.innerHTML
  })
}

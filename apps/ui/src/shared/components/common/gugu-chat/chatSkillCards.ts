import { computed, inject, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { userSkillsApi, type UserSkillItem } from '@/services/api'
import { skillAccessKey } from '@/services/resourceAccess'
import { accountBoundaryEpoch } from '@/utils/accountBoundary'
import { sanitizeChatHtml } from '@/utils/markdown'
import { objectCardLoading } from './chatObjectCards'

export function useChatSkillCards(html: () => string, enabled: () => boolean) {
  const api = inject(skillAccessKey, null)?.api ?? userSkillsApi
  const { t } = useI18n()
  const selector = 'a.chat-object-card[data-object-type="skill"][href^="gugu://open-skill/U"]'
  const skills = shallowRef<Map<string, UserSkillItem> | null>()
  const root = computed(() => {
    const source = html()
    if (!enabled() || !source.includes('href="gugu://open-skill/U')) return
    const element = document.createElement('div')
    element.innerHTML = sanitizeChatHtml(source)
    return element
  })
  const hasSkills = computed(() => Boolean(root.value?.querySelector(selector)))
  watch([hasSkills, accountBoundaryEpoch], async ([hasLinks, epoch], _previous, onCleanup) => {
    skills.value = undefined
    if (!hasLinks) return
    let active = true
    onCleanup(() => { active = false })
    const result = await api.list().catch(() => null)
    if (active && epoch === accountBoundaryEpoch.value)
      skills.value = result ? new Map(result.skills.map(skill => [skill.id, skill])) : null
  }, { immediate: true })
  return computed(() => {
    if (!root.value || !hasSkills.value) return html()
    const output = root.value.cloneNode(true) as HTMLElement
    for (const card of output.querySelectorAll<HTMLAnchorElement>(selector)) {
      if (skills.value === undefined) card.append(objectCardLoading(t('viewerUi.loading')))
      const id = card.getAttribute('href')?.split('/').at(-1) ?? ''
      const skill = skills.value?.get(id)
      const title = card.querySelector('.chat-object-card-title')
      if (!skill || !title) continue
      title.textContent = skill.name
      card.setAttribute('aria-label', skill.name)
      card.dataset.chatCardLoaded = ''
      if (!skill.description_short) continue
      const description = card.querySelector('.chat-object-card-description') ?? document.createElement('span')
      description.className = 'chat-object-card-description'
      description.textContent = skill.description_short
      card.append(description)
    }
    return output.innerHTML
  })
}

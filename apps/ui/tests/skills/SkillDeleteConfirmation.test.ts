import { createApp, h, nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import SkillsHome from '@/views/Skills/SkillsHome.vue'

const controls = vi.hoisted(() => ({ confirm: vi.fn(), remove: vi.fn() }))
vi.mock('vue-i18n', async importOriginal => ({ ...await importOriginal<typeof import('vue-i18n')>(), useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: vi.fn() }) }))
vi.mock('@/stores/ui', () => ({ useUiStore: () => ({}) }))
vi.mock('@/composables/core/useConfirmDialog', () => ({ confirmDialog: controls.confirm }))
vi.mock('@/composables/skills/useUserSkills', () => ({ useUserSkills: () => ({
  skills: ref([{ id: 'demo', name: '示例', storage_kind: 'file', enabled: true, related_tools: [] }]),
  tools: ref([]), toolsLoaded: ref(false), toolsLoading: ref(false), toolsError: ref(''),
  loaded: ref(true), loading: ref(false), saving: ref(false), error: ref(''),
  load: vi.fn(), loadTools: vi.fn(), save: vi.fn(), toggle: vi.fn(), remove: controls.remove,
}) }))
vi.mock('@/views/Skills/components/SkillCard.vue', () => ({ default: {
  props: ['skill'], emits: ['remove'], setup(props: { skill: unknown }, { emit }: { emit: (event: string, value: unknown) => void }) {
    return () => h('button', { class: 'remove-skill', onClick: () => emit('remove', props.skill) }, '删除')
  },
} }))

it('取消删除确认时不会删除文件技能', async () => {
  controls.confirm.mockResolvedValue(false)
  controls.remove.mockReset()
  const host = document.createElement('div')
  const app = createApp(SkillsHome)
  app.mount(host)
  try {
    await nextTick()
    host.querySelector<HTMLButtonElement>('.remove-skill')!.click()
    await nextTick()
    expect(controls.confirm).toHaveBeenCalledOnce()
    expect(controls.remove).not.toHaveBeenCalled()
  } finally { app.unmount() }
})

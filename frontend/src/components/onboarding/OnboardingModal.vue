<template>
  <BaseModal :show="show" width="900px" height="675px" background="var(--modal-card-bg)" @close="later">
    <div class="onboarding-modal">
      <header class="onboarding-head">
        <div>
          <span class="onboarding-kicker">{{ t('onboardingUi.kicker') }}</span>
          <h2>{{ t(`onboardingUi.steps.${step}`) }}</h2>
        </div>
        <div class="onboarding-progress" :aria-label="t('onboardingUi.progress')">
          <span v-for="item in steps" :key="item" :class="{ active: item === step, done: isDone(item) }"></span>
        </div>
        <CloseButton :title="t('common.actions.close')" @click="later" />
      </header>

      <div class="onboarding-body">
        <section class="onboarding-demo" :aria-label="t(`onboardingUi.demo.${step}.title`)">
          <div class="demo-window">
            <div class="demo-media"><img :key="mediaSource" :src="mediaSource" :alt="t(`onboardingUi.demo.${step}.title`)" /></div>
            <div class="demo-media-overlay"><strong>{{ demoTitle }}</strong><span>{{ t(`onboardingUi.demo.${step}.description`) }}</span></div>
          </div>
          <div class="demo-caption"><strong>{{ t(`onboardingUi.demo.${step}.title`) }}</strong><span>{{ t(`onboardingUi.demo.${step}.description`) }}</span></div>
        </section>

        <section class="onboarding-settings">
          <p class="onboarding-intro">{{ t(`onboardingUi.copy.${step}`) }}</p>

          <div v-if="step === 'locale'" class="choice-list">
            <button v-for="option in localeOptions" :key="option.value" type="button" class="choice-row" :class="{ selected: locale === option.value }" @click="selectLocale(option.value)">
              <span class="choice-radio"></span><span><b>{{ option.label }}</b><small>{{ option.native }}</small></span>
            </button>
          </div>
          <div v-else-if="step === 'features'" class="feature-list">
            <div v-for="item in featureItems" :key="item.key" class="feature-row"><Icon :name="item.icon" size="sm" /><span><b>{{ t(`onboardingUi.features.${item.key}.title`) }}</b><small>{{ t(`onboardingUi.features.${item.key}.description`) }}</small></span></div>
          </div>
          <div v-else-if="step === 'style'" class="style-list">
            <button v-for="item in styleFamilies" :key="item.value" type="button" class="style-choice" :class="{ selected: family === item.value }" @click="setFamily(item.value)"><span class="style-preview" :class="`preview-${item.value}`"><i></i><i></i><i></i></span><span><b>{{ item.label }}</b><small>{{ item.description }}</small></span><span class="choice-radio"></span></button>
            <div class="style-mode-list"><span>{{ t('onboardingUi.style.mode') }}</span><button v-for="item in styleModes" :key="item.value" type="button" class="pm-style-chip" :class="{ active: preference === item.value }" @click="setTheme(item.value)">{{ item.label }}</button></div>
          </div>
          <div v-else-if="step === 'model'" class="embedded-model-settings"><div class="embedded-settings-head"><div><b>{{ t('onboardingUi.modelSettings') }}</b><small>{{ t('onboardingUi.modelHint') }}</small></div><span class="status-dot"></span></div><ProfileByokPane /></div>
          <div v-else-if="step === 'im'" class="setup-card"><div class="setup-status"><span class="status-dot idle"></span><span><b>{{ t('onboardingUi.notConnected') }}</b><small>{{ t('onboardingUi.imHint') }}</small></span></div><button type="button" class="secondary-action" @click="openSettings('im')">{{ t('onboardingUi.openImSettings') }}</button></div>
          <div v-else class="complete-copy"><Icon name="status.success" size="md" /><b>{{ t('onboardingUi.completeTitle') }}</b><span>{{ t('onboardingUi.completeHint') }}</span></div>
        </section>
      </div>

      <footer class="onboarding-actions">
        <button type="button" class="later-action" @click="later">{{ t('onboardingUi.later') }}</button>
        <div><button v-if="index > 0" type="button" class="secondary-action" @click="previous">{{ t('onboardingUi.previous') }}</button><button type="button" class="primary-action" :disabled="saving || (step === 'locale' && !locale)" @click="next">{{ saving ? t('onboardingUi.saving') : step === 'complete' ? t('onboardingUi.finish') : t('onboardingUi.next') }}</button></div>
      </footer>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import CloseButton from '@/components/common/CloseButton.vue'
import Icon from '@/components/common/Icon.vue'
import ProfileByokPane from '@/components/common/ProfileModal/ProfileByokPane.vue'
import { useUiStore } from '@/stores/ui'
import { usePreferencesStore } from '@/stores/preferences'
import { getLocale, type SupportedLocale } from '@/i18n'
import { useTheme, type ThemeFamily, type ThemePreference } from '@/composables/useTheme'
import { onboardingGuideState, updateOnboardingGuide } from '@/composables/useOnboardingGuide'
import { onboardingSeedState } from '@/composables/useOnboardingSeed'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useI18n()
const uiStore = useUiStore()
const preferences = usePreferencesStore()
const steps = ['locale', 'features', 'style', 'model', 'im', 'complete'] as const
type Step = typeof steps[number]
const index = ref(0)
const locale = ref<SupportedLocale>(getLocale())
const saving = ref(false)
const step = computed<Step>(() => steps[index.value])
const seedName = computed(() => onboardingSeedState.value?.project_name || t('onboardingUi.demo.seededProject'))
const demoTitle = computed(() => t(`onboardingUi.demo.${step.value}.screen`))
const mediaSource = computed(() => step.value === 'features' || step.value === 'model' || step.value === 'complete' ? '/onboarding/kanban-drag.gif' : '/onboarding/file-drag.gif')
const { preference, family, setTheme, setFamily } = useTheme()
const localeOptions: Array<{ value: SupportedLocale; label: string; native: string }> = [
  { value: 'zh-CN', label: '简体中文', native: '中文' },
  { value: 'en-US', label: 'English', native: 'English' },
  { value: 'ja-JP', label: '日本語', native: '日本語' },
]
const featureItems = [
  { key: 'project', icon: 'navigation.projects' },
  { key: 'calendar', icon: 'navigation.calendar' },
  { key: 'im', icon: 'communication.chat' },
]
const styleFamilies = computed<Array<{ value: ThemeFamily; label: string; description: string }>>(() => [
  { value: 'glass', label: t('onboardingUi.style.glass'), description: t('onboardingUi.style.glassHint') },
  { value: 'mono', label: t('onboardingUi.style.mono'), description: t('onboardingUi.style.monoHint') },
])
const styleModes = computed<Array<{ value: ThemePreference; label: string }>>(() => [
  { value: 'light', label: t('layout.light') },
  { value: 'dark', label: t('layout.dark') },
  { value: 'system', label: t('layout.followSystemOption') },
])

watch(onboardingGuideState, value => {
  const saved = value?.current_step as Step | undefined
  if (saved) index.value = Math.max(0, steps.indexOf(saved))
}, { immediate: true })

function isDone(item: string) {
  return onboardingGuideState.value?.completed_steps.includes(item) || (index.value > steps.indexOf(item as Step))
}
async function selectLocale(value: SupportedLocale) {
  if (locale.value === value) return
  locale.value = value
  await preferences.saveLocale(value)
}
function openSettings(nav: 'im') {
  uiStore.profileInitialNav = nav
  uiStore.openProfile = true
}
async function later() {
  try { await updateOnboardingGuide({ dismissed: true }) } catch { /* 关闭不应阻塞用户使用主应用 */ }
  emit('close')
}
function previous() { if (index.value > 0) index.value -= 1 }
async function next() {
  if (saving.value) return
  saving.value = true
  try {
    const completed = new Set(onboardingGuideState.value?.completed_steps || [])
    completed.add(step.value)
    if (step.value === 'locale') await preferences.saveLocale(locale.value)
    if (step.value === 'complete') {
      await updateOnboardingGuide({ completed_steps: [...completed], completed_at: new Date().toISOString(), dismissed: false })
      emit('close')
      return
    }
    await updateOnboardingGuide({ current_step: steps[index.value + 1], completed_steps: [...completed], dismissed: false })
    index.value += 1
  } finally { saving.value = false }
}
</script>

<style scoped>
.onboarding-modal { width: 100%; aspect-ratio: 4 / 3; height: auto; display: flex; flex-direction: column; color: var(--content-primary); }
.onboarding-head, .onboarding-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 22px; border-bottom: 1px solid var(--divider-line); }
.onboarding-head h2 { margin: 4px 0 0; font-size: 20px; }
.onboarding-kicker { color: var(--content-tertiary); font-size: 10px; font-weight: 750; letter-spacing: .14em; }
.onboarding-progress { display: flex; gap: 6px; margin-left: auto; }
.onboarding-progress span { width: 28px; height: 4px; border-radius: 99px; background: var(--control-bg); transition: background-color var(--motion-hover-control) var(--motion-ease-standard); }
.onboarding-progress span.active, .onboarding-progress span.done { background: var(--action-primary); }
.onboarding-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(280px, .88fr) minmax(0, 1.12fr); gap: 28px; padding: 28px; overflow: auto; }
.onboarding-demo { min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
.demo-window { width: min(100%, 340px); aspect-ratio: 3 / 4; overflow: hidden; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--surface-soft); box-shadow: var(--elevation-card); }
.demo-window-bar { display: flex; align-items: center; gap: 5px; height: 30px; padding: 0 10px; border-bottom: 1px solid var(--divider-line); background: var(--surface-card-solid); }
.demo-window-bar span { width: 6px; height: 6px; border-radius: 50%; background: var(--status-warning); }.demo-window-bar span:nth-child(2) { background: var(--status-success); }.demo-window-bar span:nth-child(3) { background: var(--action-primary); }.demo-window-bar b { margin-left: 8px; color: var(--content-tertiary); font-size: 9px; font-weight: 600; }
.demo-window-content { display: grid; grid-template-columns: 34% 1fr; height: calc(100% - 30px); }.demo-sidebar { display: flex; flex-direction: column; gap: 11px; padding: 18px 10px; border-right: 1px solid var(--divider-line); color: var(--content-tertiary); font-size: 10px; }.demo-sidebar strong { margin-bottom: 10px; color: var(--content-primary); font-size: 14px; }.demo-sidebar span.selected { color: var(--action-primary); }.demo-main { min-width: 0; padding: 20px 14px; }.demo-main-title { overflow: hidden; color: var(--content-primary); font-size: 12px; font-weight: 700; white-space: nowrap; text-overflow: ellipsis; }.demo-locale-list { display: grid; gap: 9px; margin-top: 30px; }.demo-locale-list span, .demo-stage, .demo-setting, .demo-im-row { padding: 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); color: var(--content-secondary); font-size: 10px; }.demo-locale-list .selected { border-color: var(--border-focus); color: var(--action-primary); }.demo-project-name { margin: 22px 0 12px; color: var(--content-primary); font-size: 12px; font-weight: 700; }.demo-stage, .demo-setting, .demo-im-row { display: flex; align-items: center; gap: 7px; margin-top: 8px; }.demo-stage i { width: 7px; height: 7px; border-radius: 50%; background: var(--status-success); }.demo-stage em { margin-left: auto; color: var(--content-tertiary); font-style: normal; font-size: 9px; }.demo-setting { flex-wrap: wrap; margin-top: 16px; }.demo-setting b { margin-left: auto; color: var(--content-primary); }.demo-setting small, .demo-im-row small { width: 100%; color: var(--content-tertiary); font-size: 9px; }.demo-setting.muted { opacity: .62; }.demo-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-warning); }.demo-dot.connected { background: var(--status-success); }.demo-complete { display: grid; place-items: center; gap: 12px; height: 70%; color: var(--content-secondary); }.demo-complete span { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--status-success-bg); color: var(--status-success); font-size: 22px; }.demo-caption { display: grid; gap: 4px; max-width: 340px; text-align: center; }.demo-caption strong { font-size: 13px; }.demo-caption span { color: var(--content-secondary); font-size: 11px; line-height: 1.55; }
.onboarding-settings { display: flex; flex-direction: column; justify-content: center; min-width: 0; max-width: 520px; }.onboarding-intro { margin: 0 0 20px; color: var(--content-secondary); font-size: 14px; line-height: 1.7; }.choice-list, .feature-list { display: grid; gap: 9px; }.choice-row, .feature-row, .setup-card { display: flex; align-items: center; gap: 12px; width: 100%; padding: 13px 14px; border: 1px solid var(--border-default); border-radius: var(--control-radius); background: var(--control-bg); color: var(--content-primary); text-align: left; transition: border-color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }.choice-row:hover, .choice-row.selected { border-color: var(--border-focus); background: var(--control-bg-hover); box-shadow: var(--control-focus-shadow); }.choice-radio { width: 14px; height: 14px; border: 2px solid var(--control-border); border-radius: 50%; }.choice-row.selected .choice-radio { border: 4px solid var(--action-primary); }.choice-row b, .feature-row b { display: block; font-size: 13px; }.choice-row small, .feature-row small, .setup-status small { display: block; margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }.feature-row { background: transparent; }.feature-row > :first-child { flex: 0 0 auto; color: var(--action-primary); }.setup-card { align-items: stretch; flex-direction: column; background: var(--surface-soft); }.setup-status { display: flex; align-items: flex-start; gap: 10px; }.status-dot { width: 9px; height: 9px; margin-top: 4px; border-radius: 50%; background: var(--status-success); }.status-dot.idle { background: var(--content-tertiary); }.secondary-action, .primary-action, .later-action { border: 1px solid var(--control-border); border-radius: var(--control-radius); padding: 9px 14px; font-size: 12px; cursor: pointer; transition: background-color var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), transform var(--motion-hover-control) var(--motion-ease-standard); }.secondary-action { background: var(--control-bg); color: var(--content-primary); }.secondary-action:hover, .later-action:hover { border-color: var(--border-focus); background: var(--control-bg-hover); }.primary-action { border-color: transparent; background: var(--action-primary); color: var(--content-on-accent); }.primary-action:hover:not(:disabled), .secondary-action:hover, .later-action:hover { transform: translateY(-1px); }.primary-action:disabled { cursor: wait; opacity: .55; }.later-action { border-color: transparent; background: transparent; color: var(--content-secondary); }.onboarding-actions { border-top: 0; border-bottom: 0; }.onboarding-actions > div { display: flex; gap: 8px; }.complete-copy { display: grid; justify-items: start; gap: 10px; }.complete-copy svg { color: var(--status-success); }.complete-copy b { font-size: 18px; }.complete-copy span { color: var(--content-secondary); font-size: 13px; line-height: 1.6; }
@media (max-width: 720px) { .onboarding-body { grid-template-columns: 1fr; gap: 22px; padding: 20px; }.onboarding-demo { justify-content: flex-start; }.demo-window { width: min(100%, 270px); }.onboarding-settings { max-width: none; }.onboarding-head, .onboarding-actions { padding: 15px 17px; }.onboarding-progress { gap: 4px; }.onboarding-progress span { width: 18px; } }

/* Phase 2 uses a vertical demo-first layout so the media remains the primary signal. */
.onboarding-body { display: flex; flex-direction: column; gap: 18px; padding: 22px 28px; overflow: hidden; }
.onboarding-demo { flex: 0 0 290px; min-height: 0; flex-direction: column; justify-content: flex-start; align-items: stretch; gap: 10px; }
.demo-window { width: 100%; height: 100%; aspect-ratio: auto; flex: 0 0 auto; border: 0; box-shadow: none; }
.demo-media { position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: inherit; background: var(--surface-soft); }
.demo-media img { display: block; width: 100%; height: 100%; object-fit: cover; }
.demo-media::after { content: ''; position: absolute; inset: 38% 0 0; pointer-events: none; background: linear-gradient(to bottom, transparent, var(--modal-card-bg)); }
.demo-media-overlay { position: absolute; right: 18px; bottom: 14px; left: 18px; z-index: 1; display: grid; gap: 3px; padding: 9px 10px; border: 0; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--surface-card-solid) 76%, transparent); backdrop-filter: blur(8px); }
.demo-media-overlay strong { color: var(--content-primary); font-size: 12px; }.demo-media-overlay span { color: var(--content-secondary); font-size: 10px; line-height: 1.4; }
.demo-caption { max-width: 360px; text-align: left; }.onboarding-settings { flex: 1 1 auto; max-width: none; min-height: 0; justify-content: flex-start; overflow: auto; padding-right: 4px; }
.embedded-model-settings { min-height: 0; padding: 14px; border: 1px solid var(--border-default); border-radius: var(--card-radius); background: var(--surface-soft); overflow: auto; }
.embedded-settings-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }.embedded-settings-head b, .embedded-settings-head small { display: block; }.embedded-settings-head small { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }
.embedded-model-settings :deep(.pm-section) { padding: 0; }.embedded-model-settings :deep(.pm-section-label), .embedded-model-settings :deep(.pm-field-hint) { display: none; }.embedded-model-settings :deep(.pm-sep) { display: none; }.embedded-model-settings :deep(.byok-card-grid) { grid-template-columns: 1fr; }.embedded-model-settings :deep(.byok-group:not(:first-child)) { margin-top: 14px; }
.style-list { display: grid; gap: 10px; }.style-choice { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px; border: 1px solid var(--border-default); border-radius: var(--control-radius); background: var(--control-bg); color: var(--content-primary); text-align: left; cursor: pointer; transition: border-color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard); }.style-choice:hover, .style-choice.selected { border-color: var(--border-focus); background: var(--control-bg-hover); box-shadow: var(--control-focus-shadow); }.style-choice > span:nth-child(2) { flex: 1; }.style-choice b, .style-choice small { display: block; }.style-choice small { margin-top: 3px; color: var(--content-tertiary); font-size: 11px; }.style-choice.selected .choice-radio { border: 4px solid var(--action-primary); }.style-preview { display: grid; grid-template-columns: 18px 1fr; grid-template-rows: repeat(3, 6px); gap: 3px; width: 62px; height: 42px; padding: 6px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--surface-card-solid); }.style-preview i { border-radius: 2px; background: var(--action-primary); }.style-preview i:first-child { grid-row: 1 / span 3; background: var(--theme-selection); }.preview-mono { border-radius: 2px; }.preview-mono i { background: var(--content-secondary); }.preview-mono i:first-child { background: var(--content-tertiary); }.style-mode-list { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-top: 4px; color: var(--content-secondary); font-size: 12px; }.style-mode-list > span { margin-right: 4px; }
@media (max-width: 720px) { .onboarding-modal { aspect-ratio: auto; min-height: 100%; }.onboarding-body { gap: 14px; padding: 18px 17px; overflow: auto; }.onboarding-demo { flex-basis: 240px; }.demo-caption { max-width: none; text-align: center; }.onboarding-settings { overflow: visible; }.embedded-model-settings { max-height: none; } }
</style>

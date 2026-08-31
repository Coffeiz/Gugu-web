<template>
  <BaseModal
    :show="show"
    width="960px"
    height="720px"
    background="var(--modal-card-bg)"
    @close="later"
  >
    <div class="onboarding-modal" :data-step="step">
      <main class="onboarding-main">
        <Transition name="onboarding-step" mode="out-in">
          <section :key="step" class="onboarding-step">
            <div class="onboarding-visual">
              <img
                class="onboarding-media"
                :src="mediaSource"
                :alt="mediaAlt"
              />
              <div class="visual-close">
                <CloseButton :title="t('common.actions.close')" @click="later" />
              </div>
            </div>

            <div class="onboarding-content">
              <div class="content-heading">
                <span class="onboarding-kicker">{{ t('onboardingUi.kicker') }}</span>
                <h1>{{ t(`onboardingUi.steps.${step}`) }}</h1>
                <p>{{ t(`onboardingUi.copy.${step}`) }}</p>
              </div>

              <div v-if="step === 'locale'" class="locale-options content-options">
                <button
                  v-for="option in localeOptions"
                  :key="option.value"
                  type="button"
                  class="locale-option"
                  :class="{ selected: locale === option.value }"
                  @click="selectLocale(option.value)"
                >
                  <span class="language-code">{{ option.code }}</span>
                  <span class="locale-copy">
                    <b>{{ option.label }}</b>
                    <small>{{ option.native }}</small>
                  </span>
                  <span class="selection-mark">✓</span>
                </button>
              </div>

              <div v-else-if="step === 'features'" class="feature-options content-options">
                <div v-for="item in featureItems" :key="item.key" class="feature-option">
                  <span class="feature-icon">
                    <Icon :name="item.icon" size="sm" tone="inherit" />
                  </span>
                  <span>
                    <b>{{ t(`onboardingUi.features.${item.key}.title`) }}</b>
                    <small>{{ t(`onboardingUi.features.${item.key}.description`) }}</small>
                  </span>
                </div>
              </div>

              <div v-else-if="step === 'model'" class="direct-settings content-options">
                <div class="setup-summary">
                  <span class="status-dot" />
                  <div>
                    <b>{{ t('onboardingUi.systemDefault') }}</b>
                    <small>{{ t('onboardingUi.available') }}</small>
                  </div>
                  <span class="summary-tag">{{ t('onboardingUi.demo.optional') }}</span>
                </div>
                <div class="embedded-pane model-pane">
                  <ProfileByokPane />
                </div>
              </div>

              <div v-else-if="step === 'im'" class="direct-settings content-options">
                <div class="setup-summary">
                  <span class="status-dot neutral" />
                  <div>
                    <b>{{ t('onboardingUi.demo.im.title') }}</b>
                    <small>{{ t('onboardingUi.imHint') }}</small>
                  </div>
                </div>
                <div class="embedded-pane im-pane">
                  <ProfileImPane />
                </div>
              </div>

              <div v-else class="complete-copy content-options">
                <span class="complete-copy-mark">✓</span>
                <div>
                  <b>{{ t('onboardingUi.completeTitle') }}</b>
                  <small>{{ t('onboardingUi.completeHint') }}</small>
                </div>
              </div>
            </div>
          </section>
        </Transition>
      </main>

      <footer class="onboarding-actions">
        <ActionButton variant="secondary" fit @click="later">
          {{ t('onboardingUi.later') }}
        </ActionButton>

        <div class="onboarding-progress" :aria-label="t('onboardingUi.progress')">
          <span
            v-for="item in steps"
            :key="item"
            :class="{ active: item === step, done: isDone(item) }"
          />
        </div>

        <div class="action-group">
          <ActionButton v-if="index > 0" variant="secondary" fit @click="previous">
            {{ t('onboardingUi.previous') }}
          </ActionButton>
          <ActionButton
            fit
            :disabled="saving || (step === 'locale' && !locale)"
            @click="next"
          >
            {{ saving ? t('onboardingUi.saving') : step === 'complete' ? t('onboardingUi.finish') : t('onboardingUi.next') }}
            <span v-if="!saving && step !== 'complete'">→</span>
          </ActionButton>
        </div>
      </footer>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import CloseButton from '@/components/common/CloseButton.vue'
import ActionButton from '@/components/common/ActionButton.vue'
import Icon from '@/components/common/Icon.vue'
import ProfileByokPane from '@/components/common/ProfileModal/ProfileByokPane.vue'
import ProfileImPane from '@/components/common/ProfileModal/ProfileImPane.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { getLocale, type SupportedLocale } from '@/i18n'
import { onboardingGuideState, updateOnboardingGuide } from '@/composables/useOnboardingGuide'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useI18n()
const preferences = usePreferencesStore()

const steps = ['locale', 'features', 'model', 'im', 'complete'] as const
type Step = typeof steps[number]

const index = ref(0)
const locale = ref<SupportedLocale>(getLocale())
const saving = ref(false)
const step = computed<Step>(() => steps[index.value])

const mediaSource = computed(() => {
  if (step.value === 'locale' || step.value === 'im') return '/onboarding/file-drag.gif'
  return '/onboarding/kanban-drag.gif'
})
const mediaAlt = computed(() => t(`onboardingUi.demo.${step.value}.title`))

const localeOptions: Array<{ value: SupportedLocale; label: string; native: string; code: string }> = [
  { value: 'zh-CN', label: '简体中文', native: '中文', code: '中' },
  { value: 'en-US', label: 'English', native: 'English', code: 'EN' },
  { value: 'ja-JP', label: '日本語', native: '日本語', code: '日' },
]

const featureItems = [
  { key: 'project', icon: 'navigation.projects' },
  { key: 'calendar', icon: 'navigation.calendar' },
  { key: 'im', icon: 'communication.chat' },
]

watch(onboardingGuideState, value => {
  const saved = value?.current_step
  if (!saved) return
  const normalized = saved === 'style' ? 'model' : saved
  const savedIndex = steps.indexOf(normalized as Step)
  index.value = savedIndex >= 0 ? savedIndex : 0
}, { immediate: true })

function isDone(item: Step) {
  return onboardingGuideState.value?.completed_steps.includes(item) || index.value > steps.indexOf(item)
}

async function selectLocale(value: SupportedLocale) {
  if (locale.value === value) return
  locale.value = value
  await preferences.saveLocale(value)
}

async function later() {
  try {
    await updateOnboardingGuide({ dismissed: true })
  } catch {
    // 关闭引导不应阻塞用户进入主应用。
  }
  emit('close')
}

function previous() {
  if (index.value > 0) index.value -= 1
}

async function next() {
  if (saving.value) return
  saving.value = true
  try {
    const completed = new Set(onboardingGuideState.value?.completed_steps || [])
    completed.add(step.value)

    if (step.value === 'locale') await preferences.saveLocale(locale.value)

    if (step.value === 'complete') {
      await updateOnboardingGuide({
        completed_steps: [...completed],
        completed_at: new Date().toISOString(),
        dismissed: false,
      })
      emit('close')
      return
    }

    await updateOnboardingGuide({
      current_step: steps[index.value + 1],
      completed_steps: [...completed],
      dismissed: false,
    })
    index.value += 1
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.onboarding-modal {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--content-primary);
  background: var(--modal-card-bg);
}

.onboarding-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.onboarding-step {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.onboarding-visual {
  position: relative;
  flex: 0 0 292px;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-soft);
}

.onboarding-media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 68%, transparent 100%);
}

.visual-close {
  position: absolute;
  z-index: 3;
  top: 18px;
  right: 18px;
}

.onboarding-content {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  margin-top: -38px;
  padding: 0 54px 22px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.content-heading {
  width: min(680px, 100%);
  text-align: center;
}

.onboarding-kicker {
  display: inline-block;
  margin-bottom: 7px;
  color: var(--content-tertiary);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: .14em;
  text-transform: uppercase;
}

.content-heading h1 {
  margin: 0;
  color: var(--content-primary);
  font-size: 28px;
  line-height: 1.2;
  letter-spacing: -.035em;
}

.content-heading p {
  max-width: 620px;
  margin: 9px auto 0;
  color: var(--content-secondary);
  font-size: 13px;
  line-height: 1.65;
}

.content-options {
  width: min(690px, 100%);
  margin-top: 18px;
}

.locale-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.locale-option {
  min-width: 0;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 20px;
  align-items: center;
  gap: 10px;
  min-height: var(--control-lg);
  padding: 11px 12px;
  border: 1px solid var(--control-border);
  border-radius: var(--control-radius);
  background: var(--control-bg);
  color: var(--control-fg-strong);
  text-align: left;
  cursor: pointer;
  transition:
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    border-color var(--motion-hover-control) var(--motion-ease-standard),
    color var(--motion-hover-control) var(--motion-ease-standard),
    box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}

.locale-option:hover {
  border-color: var(--control-border-hover);
  background: var(--control-bg-hover);
}

.locale-option:focus-visible {
  outline: 0;
  border-color: var(--border-focus);
  box-shadow: var(--control-focus-shadow);
}

.locale-option.selected {
  border-color: var(--border-focus);
  background: var(--action-soft);
  box-shadow: var(--control-focus-shadow);
}

.language-code {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: var(--control-radius);
  background: var(--action-soft);
  color: var(--action-primary);
  font-size: 11px;
  font-weight: 750;
}

.locale-copy {
  min-width: 0;
}

.locale-copy b,
.feature-option b,
.setup-summary b {
  display: block;
  color: var(--content-primary);
  font-size: 12.5px;
  line-height: 1.35;
}

.locale-copy small,
.feature-option small,
.setup-summary small,
.complete-copy small {
  display: block;
  margin-top: 3px;
  color: var(--content-tertiary);
  font-size: 10.5px;
  line-height: 1.45;
}

.selection-mark {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border: 1px solid var(--control-border);
  border-radius: 50%;
  color: transparent;
  background: var(--control-bg);
  font-size: 10px;
  font-weight: 800;
}

.locale-option.selected .selection-mark {
  border-color: var(--action-primary);
  color: var(--content-on-accent);
  background: var(--action-primary-bg);
}

.feature-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.feature-option {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 13px 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
  color: var(--content-secondary);
}

.feature-icon {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: var(--control-radius);
  background: var(--action-soft);
  color: var(--action-primary);
}

.direct-settings {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.setup-summary {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
}

.setup-summary > div {
  min-width: 0;
  flex: 1;
}

.status-dot {
  width: 9px;
  height: 9px;
  flex: 0 0 9px;
  border-radius: 50%;
  background: var(--status-success);
}

.status-dot.neutral {
  background: var(--content-tertiary);
}

.summary-tag {
  flex: 0 0 auto;
  padding: 4px 7px;
  border-radius: 999px;
  background: var(--action-soft);
  color: var(--action-primary);
  font-size: 10px;
  font-weight: 650;
}

.embedded-pane {
  min-height: 0;
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-base);
}

.complete-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 18px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
}

.complete-copy-mark {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--status-success-bg);
  color: var(--status-success);
  font-weight: 800;
}

.complete-copy b {
  display: block;
  font-size: 14px;
}

.onboarding-actions {
  position: relative;
  z-index: 4;
  flex: 0 0 62px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 18px;
  padding: 0 20px;
  border-top: 1px solid var(--divider-line);
  background: var(--surface-base);
}

.onboarding-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.onboarding-progress span {
  width: 26px;
  height: 4px;
  border-radius: 999px;
  background: var(--control-bg);
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}

.onboarding-progress span.active,
.onboarding-progress span.done {
  background: var(--action-primary);
}

.action-group {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: 8px;
}

.onboarding-modal[data-step='model'] .onboarding-visual,
.onboarding-modal[data-step='im'] .onboarding-visual {
  flex-basis: 168px;
}

.onboarding-modal[data-step='model'] .onboarding-media,
.onboarding-modal[data-step='im'] .onboarding-media {
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 48%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 48%, transparent 100%);
}

.onboarding-modal[data-step='model'] .onboarding-content,
.onboarding-modal[data-step='im'] .onboarding-content {
  margin-top: -28px;
  padding-bottom: 14px;
}

.onboarding-modal[data-step='model'] .content-heading p,
.onboarding-modal[data-step='im'] .content-heading p {
  margin-top: 6px;
}

.onboarding-modal[data-step='model'] .content-options,
.onboarding-modal[data-step='im'] .content-options {
  flex: 1;
  width: min(760px, 100%);
  margin-top: 12px;
}

.onboarding-step-enter-active,
.onboarding-step-leave-active {
  transition:
    opacity var(--motion-default) var(--motion-ease-standard),
    transform var(--motion-default) var(--motion-ease-standard);
}

.onboarding-step-enter-from {
  opacity: 0;
  transform: translateX(8px);
}

.onboarding-step-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

@media (max-width: 720px) {
  .onboarding-visual {
    flex-basis: 230px;
  }

  .onboarding-content {
    padding-right: 20px;
    padding-left: 20px;
  }

  .locale-options,
  .feature-options {
    grid-template-columns: 1fr;
  }

  .onboarding-actions {
    grid-template-columns: 1fr auto;
    gap: 10px;
    padding: 0 14px;
  }

  .onboarding-progress {
    position: absolute;
    left: 50%;
    top: -14px;
    transform: translateX(-50%);
  }

  .action-group {
    grid-column: 2;
  }
}
</style>

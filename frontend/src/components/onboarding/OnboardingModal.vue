<template>
  <BaseModal
    :show="show"
    width="960px"
    height="720px"
    background="var(--modal-card-bg)"
    @close="later"
  >
    <div class="onboarding-modal">
      <main class="onboarding-main">
        <section class="onboarding-step">
          <div class="onboarding-visual" :class="{ 'theme-visual': step === 'style' }">
            <OnboardingThemePreview v-if="step === 'style'" class="theme-preview-host" />
            <img
              v-else
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

            <div class="content-panel">
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

              <div v-else-if="step === 'style'" class="theme-options content-options">
                <ThemeSwitcher
                  :model-value="preference"
                  :family="family"
                  :palette="palette"
                  @update:model-value="setTheme"
                  @update:family="setFamily"
                  @update:palette="setPalette"
                />
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
          </div>
        </section>
      </main>

      <footer class="onboarding-actions">
        <ActionButton class="onboarding-action" variant="secondary" :disabled="saving" @click="later">
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
          <ActionButton
            class="onboarding-action"
            variant="secondary"
            :class="{ 'action-placeholder': index === 0 }"
            :disabled="saving || index === 0"
            :aria-hidden="index === 0"
            @click="previous"
          >
            {{ t('onboardingUi.previous') }}
          </ActionButton>
          <ActionButton
            class="onboarding-action"
            :disabled="saving || (step === 'locale' && !locale)"
            @click="next"
          >
            {{ saving ? t('onboardingUi.saving') : step === 'complete' ? t('onboardingUi.finish') : t('onboardingUi.next') }}
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
import OnboardingThemePreview from '@/components/onboarding/OnboardingThemePreview.vue'
import ThemeSwitcher from '@/views/Design/components/ThemeSwitcher.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { getLocale, type SupportedLocale } from '@/i18n'
import { useTheme } from '@/composables/useTheme'
import { onboardingGuideState, updateOnboardingGuide } from '@/composables/useOnboardingGuide'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (event: 'close'): void }>()
const { t } = useI18n()
const preferences = usePreferencesStore()
const { preference, family, palette, setTheme, setFamily, setPalette } = useTheme()

const steps = ['locale', 'features', 'style', 'model', 'im', 'complete'] as const
type Step = typeof steps[number]

const index = ref(0)
const locale = ref<SupportedLocale>(getLocale())
const saving = ref(false)
const initializedForOpen = ref(false)
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

// 服务端状态只负责“打开这一轮引导时从哪一步继续”。
// 打开后由本地 index 单独驱动界面；否则 next() 的服务端回写会触发 watcher，
// 与本地推进叠加后一次跳两步，previous() 也会被异步回写覆盖。
watch(
  [() => props.show, onboardingGuideState],
  ([visible, value]) => {
    if (!visible) {
      initializedForOpen.value = false
      return
    }
    if (initializedForOpen.value || !value) return
    const saved = value.current_step as Step
    const savedIndex = steps.indexOf(saved)
    index.value = savedIndex >= 0 ? savedIndex : 0
    initializedForOpen.value = true
  },
  { immediate: true },
)

function isDone(item: Step) {
  return steps.indexOf(item) < index.value
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

async function previous() {
  if (saving.value || index.value <= 0) return
  const fromIndex = index.value
  const targetIndex = fromIndex - 1
  saving.value = true
  index.value = targetIndex
  try {
    await updateOnboardingGuide({
      current_step: steps[targetIndex],
      dismissed: false,
    })
  } catch {
    index.value = fromIndex
  } finally {
    saving.value = false
  }
}

async function next() {
  if (saving.value) return
  saving.value = true

  const fromIndex = index.value
  const currentStep = steps[fromIndex]
  const completed = new Set(onboardingGuideState.value?.completed_steps || [])
  completed.add(currentStep)

  try {
    if (currentStep === 'locale') await preferences.saveLocale(locale.value)

    if (currentStep === 'complete') {
      await updateOnboardingGuide({
        completed_steps: [...completed],
        completed_at: new Date().toISOString(),
        dismissed: false,
      })
      emit('close')
      return
    }

    const targetIndex = fromIndex + 1
    index.value = targetIndex
    try {
      await updateOnboardingGuide({
        current_step: steps[targetIndex],
        completed_steps: [...completed],
        dismissed: false,
      })
    } catch (error) {
      index.value = fromIndex
      throw error
    }
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

/* 所有步骤共享完全相同的两行骨架；内容切换只替换行内节点，不改变几何。 */
.onboarding-step {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: 360px minmax(0, 1fr);
}

.onboarding-visual {
  position: relative;
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
  -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000 76%, transparent 100%);
  mask-image: linear-gradient(to bottom, #000 0%, #000 76%, transparent 100%);
}

.onboarding-visual.theme-visual {
  padding: var(--space-lg) 46px 34px;
  background: var(--surface-page);
}

.theme-preview-host {
  width: 100%;
  height: 100%;
}

.visual-close {
  position: absolute;
  z-index: 3;
  top: var(--space-md);
  right: var(--space-md);
}

/* 下半部固定为“左说明 / 右交互”两栏。 */
.onboarding-content {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(250px, .78fr) minmax(0, 1.22fr);
  align-items: stretch;
  gap: 38px;
  padding: 18px 46px 20px;
  overflow: hidden;
}

.content-heading {
  min-width: 0;
  align-self: center;
  text-align: left;
}

.onboarding-kicker {
  display: inline-block;
  margin-bottom: var(--space-sm);
  color: var(--content-tertiary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: var(--tracking-label);
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
  max-width: 330px;
  margin: var(--space-sm) 0 0;
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.content-panel {
  min-width: 0;
  min-height: 0;
  display: flex;
  align-items: stretch;
  overflow: hidden;
}

.content-options {
  width: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0;
}

.locale-options,
.feature-options {
  align-self: center;
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-sm);
}

.locale-option {
  min-width: 0;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 20px;
  align-items: center;
  gap: var(--space-sm);
  min-height: var(--control-lg);
  padding: var(--space-sm) var(--space-md);
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
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
}

.locale-copy { min-width: 0; }

.locale-copy b,
.feature-option b,
.setup-summary b {
  display: block;
  color: var(--content-primary);
  font-size: var(--font-size-sm);
  line-height: 1.35;
}

.locale-copy small,
.feature-option small,
.setup-summary small,
.complete-copy small {
  display: block;
  margin-top: var(--space-xs);
  color: var(--content-tertiary);
  font-size: var(--font-size-xs);
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
  font-weight: var(--font-weight-bold);
}

.locale-option.selected .selection-mark {
  border-color: var(--action-primary);
  color: var(--content-on-accent);
  background: var(--action-primary-bg);
}

.feature-option {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
  color: var(--content-secondary);
}

.feature-icon {
  flex: 0 0 34px;
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: var(--control-radius);
  background: var(--action-soft);
  color: var(--action-primary);
}

.theme-options {
  align-self: center;
  padding: var(--space-md);
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-soft);
}

.theme-options :deep(.theme-controls) {
  width: 100%;
  margin-left: 0;
  display: grid;
  grid-template-columns: 1fr;
  justify-content: stretch;
  gap: var(--space-sm);
}

.theme-options :deep(.control-cluster) {
  min-width: 0;
  justify-content: space-between;
}

.theme-options :deep(.segmented) {
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.direct-settings {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.setup-summary {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
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

.status-dot.neutral { background: var(--content-tertiary); }

.summary-tag {
  flex: 0 0 auto;
  padding: var(--space-xs) var(--space-sm);
  border-radius: 999px;
  background: var(--action-soft);
  color: var(--action-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.embedded-pane {
  min-height: 0;
  flex: 1;
  margin-top: var(--space-sm);
  overflow: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--card-radius);
  background: var(--surface-base);
}

.complete-copy {
  align-self: center;
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-lg);
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
  font-weight: var(--font-weight-bold);
}

.complete-copy b {
  display: block;
  font-size: var(--font-size-md);
}

.onboarding-actions {
  position: relative;
  z-index: 4;
  flex: 0 0 62px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-md);
  padding: 0 var(--space-lg);
  border-top: 1px solid var(--divider-line);
  background: var(--surface-base);
}

/* Footer 三个操作位统一尺寸；文案长短不再改变布局。 */
.onboarding-actions :deep(.onboarding-action) {
  width: 92px;
  min-width: 92px;
  max-width: 92px;
  flex: 0 0 92px;
}

.onboarding-actions > .onboarding-action {
  justify-self: start;
}

.action-group {
  justify-self: end;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.action-placeholder {
  visibility: hidden;
  pointer-events: none;
}

.onboarding-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
}

.onboarding-progress span {
  width: 24px;
  height: 4px;
  border-radius: 999px;
  background: var(--control-bg);
  transition:
    width var(--motion-hover-control) var(--motion-ease-standard),
    background-color var(--motion-hover-control) var(--motion-ease-standard),
    opacity var(--motion-hover-control) var(--motion-ease-standard);
}

.onboarding-progress span.done {
  background: var(--action-primary);
  opacity: .42;
}

.onboarding-progress span.active {
  width: 34px;
  background: var(--action-primary);
  opacity: 1;
}

@media (max-width: 720px) {
  .onboarding-step {
    grid-template-rows: 300px minmax(0, 1fr);
  }

  .onboarding-visual.theme-visual {
    padding: var(--space-md) var(--space-md) 30px;
  }

  .theme-preview-host {
    min-width: 660px;
    width: 138%;
    height: 138%;
    transform: scale(.72);
    transform-origin: top left;
  }

  .onboarding-content {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
    gap: var(--space-md);
    padding: var(--space-md) var(--space-lg);
  }

  .content-heading {
    align-self: start;
  }

  .content-heading p {
    max-width: none;
  }

  .onboarding-actions {
    grid-template-columns: 92px minmax(0, 1fr) 192px;
    gap: var(--space-sm);
    padding: 0 var(--space-md);
  }
}
</style>

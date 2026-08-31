<template>
  <BaseModal
    :show="show"
    width="960px"
    height="720px"
    background="var(--modal-card-bg)"
    @close="later"
  >
    <div class="onboarding-modal" :data-step="step">
      <header class="onboarding-topbar">
        <div class="onboarding-brand">
          <span class="brand-mark" aria-hidden="true">咕</span>
          <span>{{ t('onboardingUi.brand') }}</span>
        </div>

        <div class="onboarding-progress" :aria-label="t('onboardingUi.progress')">
          <span
            v-for="item in steps"
            :key="item"
            :class="{ active: item === step, done: isDone(item) }"
          />
        </div>

        <CloseButton :title="t('common.actions.close')" @click="later" />
      </header>

      <main class="onboarding-main">
        <Transition name="onboarding-step" mode="out-in">
          <section :key="step" class="onboarding-step">
            <div class="onboarding-visual" :class="`visual-${step}`">
              <div v-if="step === 'locale'" class="scene locale-scene">
                <div class="scene-orbit orbit-a" />
                <div class="scene-orbit orbit-b" />
                <div class="locale-gugu">
                  <span class="gugu-face">咕</span>
                  <small>{{ t('onboardingUi.brand') }}</small>
                </div>
                <div class="language-bubble bubble-zh">你好</div>
                <div class="language-bubble bubble-en">Hello</div>
                <div class="language-bubble bubble-ja">こんにちは</div>
              </div>

              <div v-else-if="step === 'features'" class="scene feature-scene">
                <svg class="feature-path" viewBox="0 0 760 120" aria-hidden="true">
                  <path d="M20 92 C 128 22, 208 74, 300 34 S 468 17, 555 42 S 660 15, 740 28" />
                </svg>

                <div class="mini-product mini-project">
                  <div class="mini-product-head">{{ t('navigation.projects') }}</div>
                  <div class="project-lines">
                    <span><i /><b /></span>
                    <span><i /><b /></span>
                    <span><i /><b /></span>
                    <span><i /><b /></span>
                  </div>
                </div>

                <div class="mini-product mini-calendar">
                  <div class="mini-product-head">{{ t('navigation.calendar') }}</div>
                  <div class="calendar-grid">
                    <i v-for="n in 20" :key="n" :class="{ hot: n === 8 || n === 14 }" />
                  </div>
                </div>

                <div class="mini-product mini-note">
                  <div class="mini-product-head">{{ t('navigation.mind') }}</div>
                  <div class="note-title" />
                  <div class="note-lines"><i /><i /><i /></div>
                  <div class="note-image"><span>✦</span></div>
                </div>

                <div class="mini-product mini-canvas">
                  <div class="mini-product-head">Canvas</div>
                  <div class="canvas-board">
                    <span class="sticky sticky-a">Idea</span>
                    <span class="sticky sticky-b">Plan</span>
                    <span class="sticky sticky-c">Do</span>
                    <i class="canvas-link link-a" />
                    <i class="canvas-link link-b" />
                  </div>
                </div>
              </div>

              <div v-else-if="step === 'model'" class="scene model-scene">
                <div class="model-chat">
                  <div class="chat-avatar">咕</div>
                  <div class="chat-copy"><span /><span /><span /></div>
                </div>

                <div class="model-flow">
                  <div class="flow-card flow-default">
                    <span class="flow-dot ready" />
                    <div>
                      <b>{{ t('onboardingUi.systemDefault') }}</b>
                      <small>{{ t('onboardingUi.available') }}</small>
                    </div>
                  </div>
                  <i class="flow-line" />
                  <div class="model-core">
                    <span>AI</span>
                    <i class="core-ring ring-a" />
                    <i class="core-ring ring-b" />
                  </div>
                  <i class="flow-line right" />
                  <div class="flow-card flow-byok">
                    <span class="key-mark">⌁</span>
                    <div>
                      <b>{{ t('onboardingUi.modelSettings') }}</b>
                      <small>{{ t('onboardingUi.apiKey') }}</small>
                    </div>
                  </div>
                </div>
              </div>

              <div v-else-if="step === 'im'" class="scene im-scene">
                <div class="im-halo halo-a" />
                <div class="im-halo halo-b" />

                <div class="im-web-card">
                  <div class="web-title">
                    <span class="web-gugu">咕</span>
                    {{ t('onboardingUi.brand') }}
                  </div>
                  <div class="web-message"><i /><i /><i /></div>
                  <div class="web-input" />
                </div>

                <div class="im-phone">
                  <div class="phone-speaker" />
                  <div class="phone-chat">
                    <span class="phone-bubble bubble-left" />
                    <span class="phone-bubble bubble-right" />
                    <span class="phone-bubble bubble-left short" />
                  </div>
                </div>

                <div class="platform-pill pill-feishu">{{ t('profileImUi.feishu') }}</div>
                <div class="platform-pill pill-qq">{{ t('profileImUi.qq') }}</div>
                <div class="platform-pill pill-wechat">{{ t('profileImUi.wechat') }}</div>
              </div>

              <div v-else class="scene complete-scene">
                <div class="complete-glow" />
                <div class="complete-mark">✓</div>
                <div class="complete-project">
                  <span class="complete-dot" />
                  <div>
                    <b>{{ seedName }}</b>
                    <small>{{ t('onboardingUi.demo.ready') }}</small>
                  </div>
                </div>
                <span class="complete-spark spark-a">✦</span>
                <span class="complete-spark spark-b">✦</span>
                <span class="complete-spark spark-c">✧</span>
              </div>

              <div class="visual-fade" />
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
                  class="locale-option selectable-card"
                  :class="{ selected: locale === option.value }"
                  @click="selectLocale(option.value)"
                >
                  <span class="language-code">{{ option.code }}</span>
                  <span>
                    <b>{{ option.label }}</b>
                    <small>{{ option.native }}</small>
                  </span>
                  <span class="selection-mark">✓</span>
                </button>
              </div>

              <div v-else-if="step === 'features'" class="feature-options content-options">
                <div v-for="item in featureItems" :key="item.key" class="feature-option">
                  <Icon :name="item.icon" size="sm" tone="inherit" />
                  <span>
                    <b>{{ t(`onboardingUi.features.${item.key}.title`) }}</b>
                    <small>{{ t(`onboardingUi.features.${item.key}.description`) }}</small>
                  </span>
                </div>
              </div>

              <div v-else-if="step === 'model'" class="direct-settings content-options model-settings">
                <div class="setup-summary">
                  <span class="status-dot ready" />
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

              <div v-else-if="step === 'im'" class="direct-settings content-options im-settings">
                <div class="setup-summary">
                  <span class="status-dot idle" />
                  <div>
                    <b>{{ t('onboardingUi.notConnected') }}</b>
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
        <button type="button" class="later-action" @click="later">
          {{ t('onboardingUi.later') }}
        </button>

        <div class="action-group">
          <button v-if="index > 0" type="button" class="secondary-action" @click="previous">
            {{ t('onboardingUi.previous') }}
          </button>
          <button
            type="button"
            class="primary-action"
            :disabled="saving || (step === 'locale' && !locale)"
            @click="next"
          >
            {{ saving ? t('onboardingUi.saving') : step === 'complete' ? t('onboardingUi.finish') : t('onboardingUi.next') }}
            <span v-if="!saving && step !== 'complete'">→</span>
          </button>
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
import Icon from '@/components/common/Icon.vue'
import ProfileByokPane from '@/components/common/ProfileModal/ProfileByokPane.vue'
import ProfileImPane from '@/components/common/ProfileModal/ProfileImPane.vue'
import { usePreferencesStore } from '@/stores/preferences'
import { getLocale, type SupportedLocale } from '@/i18n'
import { onboardingGuideState, updateOnboardingGuide } from '@/composables/useOnboardingGuide'
import { onboardingSeedState } from '@/composables/useOnboardingSeed'

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
const seedName = computed(() => onboardingSeedState.value?.project_name || t('onboardingUi.demo.seededProject'))

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
  --onb-accent: var(--action-primary);
  --onb-accent-soft: color-mix(in srgb, var(--action-primary) 12%, transparent);
  --onb-blue: #6ca7f8;
  --onb-blue-soft: color-mix(in srgb, #6ca7f8 16%, transparent);
  --onb-gold: #e8b452;
  --onb-gold-soft: color-mix(in srgb, #e8b452 17%, transparent);
  --onb-green: #65bf8a;
  --onb-green-soft: color-mix(in srgb, #65bf8a 16%, transparent);
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--content-primary);
  background: var(--modal-card-bg);
}

.onboarding-topbar {
  position: relative;
  z-index: 30;
  height: 58px;
  flex: 0 0 58px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 18px;
  padding: 0 20px 0 22px;
}

.onboarding-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: 13px;
  font-weight: 750;
  letter-spacing: -.01em;
}

.brand-mark {
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: var(--content-on-accent);
  background: linear-gradient(145deg, color-mix(in srgb, var(--onb-accent) 78%, white), var(--onb-accent));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--onb-accent) 22%, transparent);
  font-size: 12px;
  font-weight: 800;
}

.onboarding-progress {
  display: flex;
  align-items: center;
  gap: 6px;
}

.onboarding-progress span {
  width: 34px;
  height: 4px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--content-tertiary) 18%, transparent);
  transition: width .28s var(--motion-ease-standard), background-color .28s var(--motion-ease-standard);
}

.onboarding-progress span.done {
  background: color-mix(in srgb, var(--onb-accent) 42%, transparent);
}

.onboarding-progress span.active {
  width: 44px;
  background: var(--onb-accent);
}

.onboarding-topbar :deep(.close-btn) { justify-self: end; }

.onboarding-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.onboarding-step {
  height: 100%;
  display: grid;
  grid-template-rows: minmax(280px, 1.12fr) minmax(230px, .88fr);
}

.onboarding-modal[data-step='model'] .onboarding-step,
.onboarding-modal[data-step='im'] .onboarding-step {
  grid-template-rows: 218px minmax(0, 1fr);
}

.onboarding-visual {
  position: relative;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 82% 8%, color-mix(in srgb, var(--onb-accent) 13%, transparent), transparent 34%),
    radial-gradient(circle at 15% 7%, color-mix(in srgb, var(--onb-blue) 11%, transparent), transparent 31%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface-soft) 76%, transparent), color-mix(in srgb, var(--surface-soft) 32%, transparent));
}

.scene {
  position: absolute;
  left: 50%;
  top: 47%;
  width: min(820px, 88%);
  height: 285px;
  transform: translate(-50%, -50%);
}

.onboarding-modal[data-step='model'] .scene,
.onboarding-modal[data-step='im'] .scene {
  top: 49%;
  height: 190px;
}

.visual-fade {
  position: absolute;
  z-index: 20;
  inset: auto 0 -1px;
  height: 46%;
  pointer-events: none;
  background: linear-gradient(180deg, transparent, color-mix(in srgb, var(--modal-card-bg) 68%, transparent) 55%, var(--modal-card-bg) 94%);
}

.onboarding-content {
  position: relative;
  z-index: 22;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2px 64px 14px;
  text-align: center;
  background: var(--modal-card-bg);
}

.onboarding-modal[data-step='model'] .onboarding-content,
.onboarding-modal[data-step='im'] .onboarding-content {
  padding-top: 0;
}

.content-heading {
  width: min(760px, 100%);
  display: grid;
  justify-items: center;
  flex: 0 0 auto;
}

.onboarding-kicker {
  margin-bottom: 6px;
  color: var(--content-tertiary);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: .14em;
  text-transform: uppercase;
}

.content-heading h1 {
  margin: 0;
  font-size: 28px;
  line-height: 1.18;
  letter-spacing: -.035em;
}

.content-heading p {
  max-width: 650px;
  margin: 7px 0 0;
  color: var(--content-secondary);
  font-size: 12.5px;
  line-height: 1.58;
}

.onboarding-modal[data-step='model'] .content-heading h1,
.onboarding-modal[data-step='im'] .content-heading h1 {
  font-size: 24px;
}

.onboarding-modal[data-step='model'] .content-heading p,
.onboarding-modal[data-step='im'] .content-heading p {
  margin-top: 5px;
  font-size: 11.5px;
}

.content-options {
  width: min(760px, 100%);
  margin-top: 15px;
}

.selectable-card {
  border: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--control-bg) 76%, transparent);
  color: var(--content-primary);
  cursor: pointer;
  transition: transform var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard), box-shadow var(--motion-hover-control) var(--motion-ease-standard);
}

.selectable-card:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--onb-accent) 28%, var(--border-subtle));
  background: var(--control-bg-hover);
}

.selectable-card.selected {
  border-color: color-mix(in srgb, var(--onb-accent) 34%, transparent);
  background: linear-gradient(110deg, color-mix(in srgb, var(--onb-accent) 9%, var(--control-bg)), var(--control-bg));
  box-shadow: 0 8px 24px color-mix(in srgb, var(--onb-accent) 8%, transparent);
}

.selection-mark {
  width: 19px;
  height: 19px;
  display: grid;
  place-items: center;
  border: 1.5px solid var(--control-border);
  border-radius: 50%;
  color: transparent;
  font-size: 10px;
  font-weight: 900;
  transition: all var(--motion-hover-control) var(--motion-ease-standard);
}

.selectable-card.selected .selection-mark {
  color: var(--content-on-accent);
  border-color: var(--onb-accent);
  background: var(--onb-accent);
}

/* language */
.locale-scene { width: min(690px, 82%); }
.scene-orbit {
  position: absolute;
  left: 50%;
  top: 52%;
  border: 1px dashed color-mix(in srgb, var(--onb-accent) 26%, transparent);
  border-radius: 50%;
  transform: translate(-50%, -50%);
}
.orbit-a { width: 390px; height: 180px; transform: translate(-50%, -50%) rotate(-8deg); }
.orbit-b { width: 530px; height: 220px; transform: translate(-50%, -50%) rotate(8deg); opacity: .55; }
.locale-gugu {
  position: absolute;
  z-index: 5;
  left: 50%;
  top: 52%;
  display: grid;
  justify-items: center;
  gap: 8px;
  transform: translate(-50%, -50%);
}
.gugu-face {
  width: 92px;
  height: 92px;
  display: grid;
  place-items: center;
  border-radius: 31px;
  color: var(--content-on-accent);
  background: linear-gradient(145deg, color-mix(in srgb, var(--onb-accent) 74%, white), var(--onb-accent));
  box-shadow: 0 24px 50px color-mix(in srgb, var(--onb-accent) 24%, transparent), inset 0 1px 0 rgba(255,255,255,.45);
  font-size: 32px;
  font-weight: 850;
}
.locale-gugu small { color: var(--content-secondary); font-size: 11px; font-weight: 700; }
.language-bubble {
  position: absolute;
  z-index: 7;
  min-width: 96px;
  padding: 11px 16px;
  border: 1px solid color-mix(in srgb, var(--border-default) 68%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface-card-solid) 91%, transparent);
  box-shadow: 0 16px 36px rgba(25, 25, 55, .1);
  font-size: 13px;
  font-weight: 720;
  backdrop-filter: blur(12px);
}
.bubble-zh { left: 44px; top: 96px; transform: rotate(-4deg); }
.bubble-en { right: 44px; top: 48px; transform: rotate(5deg); }
.bubble-ja { right: 85px; bottom: 30px; transform: rotate(-2deg); }
.locale-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.locale-option {
  min-width: 0;
  min-height: 60px;
  display: grid;
  grid-template-columns: 36px 1fr 20px;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 14px;
  text-align: left;
}
.language-code {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--onb-accent);
  background: var(--onb-accent-soft);
  font-size: 10px;
  font-weight: 850;
}
.locale-option b { display: block; font-size: 12px; }
.locale-option small { display: block; margin-top: 2px; color: var(--content-tertiary); font-size: 9.5px; }

/* feature stage */
.feature-scene { width: min(850px, 92%); height: 305px; }
.feature-path { position: absolute; left: 9%; right: 9%; top: 0; width: 82%; height: 95px; overflow: visible; opacity: .72; }
.feature-path path { fill: none; stroke: color-mix(in srgb, var(--onb-accent) 52%, transparent); stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: 5 7; animation: featureDash 10s linear infinite; }
@keyframes featureDash { to { stroke-dashoffset: -84; } }
.mini-product {
  position: absolute;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--border-default) 65%, white 35%);
  border-radius: 18px;
  background: color-mix(in srgb, var(--surface-card-solid) 93%, transparent);
  box-shadow: 0 22px 45px rgba(50, 48, 78, .11), inset 0 1px 0 rgba(255,255,255,.55);
  backdrop-filter: blur(16px);
  animation: cardIn .62s var(--motion-ease-standard) both;
}
@keyframes cardIn { from { opacity: 0; transform: translate3d(-24px,18px,0) scale(.94); filter: blur(3px); } }
.mini-product-head { height: 38px; display: flex; align-items: center; padding: 0 13px; font-size: 11px; font-weight: 760; }
.mini-project { left: 2%; top: 109px; width: 175px; height: 175px; background: linear-gradient(180deg, color-mix(in srgb, var(--onb-accent) 13%, var(--surface-card-solid)) 0 38px, var(--surface-card-solid) 38px); }
.mini-calendar { left: 22%; top: 78px; width: 205px; height: 210px; animation-delay: 90ms; background: linear-gradient(180deg, color-mix(in srgb, var(--onb-blue) 15%, var(--surface-card-solid)) 0 38px, var(--surface-card-solid) 38px); }
.mini-note { left: 45%; top: 44px; width: 220px; height: 244px; animation-delay: 180ms; background: linear-gradient(180deg, color-mix(in srgb, var(--onb-gold) 19%, var(--surface-card-solid)) 0 38px, var(--surface-card-solid) 38px); }
.mini-canvas { right: 0; top: 15px; width: 250px; height: 273px; animation-delay: 270ms; background: linear-gradient(180deg, color-mix(in srgb, var(--onb-accent) 10%, var(--surface-card-solid)) 0 38px, var(--surface-card-solid) 38px); }
.project-lines { padding: 16px 13px; display: grid; gap: 12px; }
.project-lines span { display: flex; align-items: center; gap: 8px; }
.project-lines i { width: 7px; height: 7px; border-radius: 50%; background: var(--onb-accent); }
.project-lines span:nth-child(2) i { background: var(--onb-blue); }
.project-lines span:nth-child(3) i { background: var(--onb-gold); }
.project-lines span:nth-child(4) i { background: var(--onb-green); }
.project-lines b { height: 6px; width: 84px; border-radius: 99px; background: color-mix(in srgb, var(--content-tertiary) 20%, transparent); }
.calendar-grid { padding: 16px 13px; display: grid; grid-template-columns: repeat(5,1fr); gap: 7px; }
.calendar-grid i { aspect-ratio: 1; border-radius: 5px; background: color-mix(in srgb, var(--content-tertiary) 9%, transparent); }
.calendar-grid i.hot { background: var(--onb-blue-soft); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--onb-blue) 35%, transparent); }
.note-title { width: 92px; height: 11px; margin: 17px 14px 12px; border-radius: 99px; background: color-mix(in srgb, var(--content-primary) 18%, transparent); }
.note-lines { display: grid; gap: 7px; padding: 0 14px; }
.note-lines i { height: 6px; border-radius: 99px; background: color-mix(in srgb, var(--content-tertiary) 15%, transparent); }
.note-lines i:nth-child(2){width:82%}.note-lines i:nth-child(3){width:62%}
.note-image { height: 61px; margin: 17px 14px; border-radius: 9px; display: grid; place-items: center; color: #fff; background: linear-gradient(145deg, color-mix(in srgb, var(--onb-blue) 60%, white), color-mix(in srgb, var(--onb-gold) 55%, white)); }
.canvas-board { position: absolute; inset: 50px 13px 13px; border-radius: 10px; background-color: color-mix(in srgb, var(--surface-card-solid) 96%, transparent); background-image: radial-gradient(color-mix(in srgb, var(--content-tertiary) 19%, transparent) 1px, transparent 1px); background-size: 14px 14px; }
.sticky { position:absolute; z-index:2; width:55px; min-height:42px; display:grid; place-items:center; border-radius:4px; font-size:8px; font-weight:750; box-shadow:0 6px 14px rgba(38,37,55,.08); }
.sticky-a{left:33px;top:30px;background:color-mix(in srgb,var(--onb-accent) 28%,white)}
.sticky-b{left:22px;top:117px;background:color-mix(in srgb,var(--onb-gold) 38%,white)}
.sticky-c{right:30px;top:110px;background:color-mix(in srgb,var(--onb-blue) 32%,white)}
.canvas-link { position:absolute; left:74px; width:72px; border-top:1.5px solid color-mix(in srgb,var(--content-primary) 48%,transparent); transform-origin:left center; }
.link-a{top:70px;transform:rotate(28deg)}.link-b{top:135px;transform:rotate(-7deg)}
.feature-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.feature-option {
  min-width: 0;
  min-height: 62px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: color-mix(in srgb, var(--control-bg) 72%, transparent);
  text-align: left;
}
.feature-option > :first-child { color: var(--onb-accent); flex: 0 0 auto; }
.feature-option b, .feature-option small { display:block; }
.feature-option b { font-size: 11.5px; }
.feature-option small { margin-top:3px; color:var(--content-tertiary); font-size:9.5px; line-height:1.35; }

/* model scene */
.model-scene { width: min(760px, 86%); }
.model-chat {
  position:absolute;
  left:52px;
  top:42px;
  width:205px;
  min-height:76px;
  display:flex;
  gap:12px;
  align-items:flex-start;
  padding:13px;
  border:1px solid var(--border-subtle);
  border-radius:17px;
  background:color-mix(in srgb,var(--surface-card-solid) 91%,transparent);
  box-shadow:0 20px 42px rgba(40,38,70,.1);
  transform:rotate(-3deg);
}
.chat-avatar { width:31px; height:31px; flex:0 0 31px; display:grid; place-items:center; border-radius:10px; color:var(--content-on-accent); background:var(--onb-accent); font-size:10px; font-weight:850; }
.chat-copy { flex:1; display:grid; gap:7px; padding-top:4px; }
.chat-copy span { height:6px; border-radius:99px; background:color-mix(in srgb,var(--content-tertiary) 17%,transparent); }
.chat-copy span:nth-child(2){width:88%}.chat-copy span:nth-child(3){width:61%}
.model-flow { position:absolute; left:50%; top:55%; width:620px; height:120px; transform:translate(-50%,-50%); display:flex; align-items:center; justify-content:center; }
.flow-card { position:absolute; z-index:3; width:184px; min-height:66px; display:flex; align-items:center; gap:10px; padding:11px 12px; border:1px solid var(--border-subtle); border-radius:15px; background:color-mix(in srgb,var(--surface-card-solid) 92%,transparent); box-shadow:0 17px 38px rgba(45,43,74,.1); backdrop-filter:blur(14px); }
.flow-default{left:0}.flow-byok{right:0}
.flow-card b,.flow-card small{display:block}.flow-card b{font-size:10.5px}.flow-card small{margin-top:3px;color:var(--content-tertiary);font-size:8.5px}
.flow-dot,.status-dot { width:9px; height:9px; flex:0 0 9px; border-radius:50%; background:var(--status-warning); box-shadow:0 0 0 5px color-mix(in srgb,var(--status-warning) 12%,transparent); }
.flow-dot.ready,.status-dot.ready { background:var(--status-success); box-shadow:0 0 0 5px color-mix(in srgb,var(--status-success) 12%,transparent); }
.status-dot.idle { background:var(--content-tertiary); box-shadow:0 0 0 5px color-mix(in srgb,var(--content-tertiary) 10%,transparent); }
.key-mark { width:30px; height:30px; flex:0 0 30px; display:grid; place-items:center; border-radius:9px; color:var(--onb-accent); background:var(--onb-accent-soft); font-size:20px; font-weight:800; }
.model-core { position:relative; z-index:4; width:76px; height:76px; display:grid; place-items:center; border-radius:25px; color:var(--content-on-accent); background:linear-gradient(145deg,color-mix(in srgb,var(--onb-accent) 72%,white),var(--onb-accent)); box-shadow:0 19px 44px color-mix(in srgb,var(--onb-accent) 23%,transparent); font-size:16px; font-weight:850; }
.core-ring { position:absolute; inset:-14px; border:1px solid color-mix(in srgb,var(--onb-accent) 23%,transparent); border-radius:33px; transform:rotate(12deg); }
.ring-b{inset:-28px;opacity:.46;transform:rotate(-12deg)}
.flow-line { position:absolute; left:180px; width:112px; border-top:1.5px dashed color-mix(in srgb,var(--onb-accent) 40%,transparent); }
.flow-line.right{left:auto;right:180px}

/* IM scene */
.im-scene { width:min(760px,86%); }
.im-halo { position:absolute; left:50%; top:50%; border:1px solid color-mix(in srgb,var(--onb-accent) 15%,transparent); border-radius:50%; transform:translate(-50%,-50%); }
.halo-a{width:500px;height:175px}.halo-b{width:630px;height:220px;opacity:.5}
.im-web-card { position:absolute; left:84px; top:20px; width:280px; height:145px; padding:14px; border:1px solid var(--border-subtle); border-radius:19px; background:color-mix(in srgb,var(--surface-card-solid) 92%,transparent); box-shadow:0 22px 46px rgba(44,42,72,.11); transform:rotate(-3deg); }
.web-title{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:780}.web-gugu{width:25px;height:25px;display:grid;place-items:center;border-radius:8px;color:var(--content-on-accent);background:var(--onb-accent);font-size:9px}
.web-message{width:72%;margin:16px 0 0 34px;padding:9px;border-radius:11px;background:color-mix(in srgb,var(--onb-accent) 8%,var(--surface-soft));display:grid;gap:5px}.web-message i{height:5px;border-radius:99px;background:color-mix(in srgb,var(--content-tertiary) 16%,transparent)}.web-message i:nth-child(2){width:83%}.web-message i:nth-child(3){width:56%}.web-input{position:absolute;left:14px;right:14px;bottom:12px;height:22px;border:1px solid var(--border-subtle);border-radius:8px;background:var(--surface-soft)}
.im-phone { position:absolute; right:118px; top:2px; width:112px; height:178px; padding:15px 10px 10px; border:4px solid color-mix(in srgb,var(--content-primary) 82%,transparent); border-radius:25px; background:var(--surface-card-solid); box-shadow:0 22px 45px rgba(40,39,59,.14); transform:rotate(4deg); }
.phone-speaker{position:absolute;left:50%;top:5px;width:28px;height:4px;border-radius:99px;background:color-mix(in srgb,var(--content-primary) 60%,transparent);transform:translateX(-50%)}.phone-chat{display:grid;gap:11px;padding-top:18px}.phone-bubble{width:66px;height:22px;border-radius:9px;background:var(--onb-accent-soft)}.bubble-right{margin-left:auto;background:var(--onb-blue-soft)}.phone-bubble.short{width:48px}
.platform-pill { position:absolute; z-index:5; padding:7px 11px; border:1px solid var(--border-subtle); border-radius:99px; background:color-mix(in srgb,var(--surface-card-solid) 91%,transparent); box-shadow:0 9px 22px rgba(43,41,70,.09); font-size:9px; font-weight:750; backdrop-filter:blur(10px); }
.pill-feishu{left:310px;top:13px;color:var(--onb-blue)}.pill-qq{right:50px;top:89px;color:var(--onb-accent)}.pill-wechat{right:244px;bottom:5px;color:var(--onb-green)}

/* direct configuration panes */
.direct-settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin-top: 10px;
  text-align: left;
}

.setup-summary {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 12px 1fr auto;
  align-items: center;
  gap: 10px;
  min-height: 50px;
  padding: 9px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 13px;
  background: color-mix(in srgb, var(--surface-soft) 74%, transparent);
}

.setup-summary b,
.setup-summary small { display: block; }
.setup-summary b { font-size: 11px; }
.setup-summary small { margin-top: 2px; color: var(--content-tertiary); font-size: 9.5px; }
.summary-tag { padding: 4px 8px; border-radius: 99px; color: var(--content-tertiary); background: var(--control-bg); font-size: 8.5px; font-weight: 700; }

.embedded-pane {
  flex: 1;
  min-height: 0;
  margin-top: 8px;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 4px 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-card-solid) 64%, transparent);
  scrollbar-width: thin;
}

.embedded-pane :deep(.pm-section) { padding: 13px 8px; }
.embedded-pane :deep(.pm-section-label) { margin-bottom: 9px; font-size: 10px; }
.embedded-pane :deep(.pm-field-row),
.embedded-pane :deep(.pm-bot-group-row) { gap: 12px; padding: 9px 0; }
.embedded-pane :deep(.pm-field-name) { font-size: 10.5px; }
.embedded-pane :deep(.pm-field-hint) { font-size: 9.5px; }
.embedded-pane :deep(.byok-card-grid) { gap: 8px; }
.embedded-pane :deep(.byok-card) { padding: 10px; }
.embedded-pane :deep(.byok-group) { margin-bottom: 12px; }
.embedded-pane :deep(.byok-group-title) { font-size: 10.5px; }
.embedded-pane :deep(.byok-editor) { padding: 11px; }
.embedded-pane :deep(.form-input) { min-height: 34px; font-size: 10.5px; }
.embedded-pane :deep(.pm-style-chip),
.embedded-pane :deep(.pm-bind-btn),
.embedded-pane :deep(.pm-danger-btn) { min-height: 30px; font-size: 9.5px; }
.embedded-pane :deep(.pm-sep) { margin: 0 8px; }

/* complete */
.complete-scene { width:min(650px,78%); }
.complete-glow { position:absolute; left:50%; top:50%; width:300px; height:180px; border-radius:50%; background:radial-gradient(circle,color-mix(in srgb,var(--status-success) 19%,transparent),transparent 68%); transform:translate(-50%,-50%); filter:blur(6px); }
.complete-mark { position:absolute; z-index:4; left:50%; top:43%; width:88px; height:88px; display:grid; place-items:center; border-radius:30px; color:var(--status-success); background:color-mix(in srgb,var(--status-success-bg) 82%,var(--surface-card-solid)); box-shadow:0 22px 48px color-mix(in srgb,var(--status-success) 18%,transparent), inset 0 1px 0 rgba(255,255,255,.7); transform:translate(-50%,-50%); font-size:31px; font-weight:900; }
.complete-project { position:absolute; left:50%; top:72%; width:245px; min-height:60px; display:flex; align-items:center; gap:11px; padding:11px 13px; border:1px solid var(--border-subtle); border-radius:15px; background:color-mix(in srgb,var(--surface-card-solid) 92%,transparent); box-shadow:0 14px 34px rgba(44,42,70,.09); transform:translate(-50%,-50%); text-align:left; }
.complete-project b,.complete-project small{display:block}.complete-project b{font-size:11px}.complete-project small{margin-top:3px;color:var(--content-tertiary);font-size:9px}.complete-dot{width:9px;height:9px;border-radius:50%;background:var(--status-success);box-shadow:0 0 0 5px color-mix(in srgb,var(--status-success) 12%,transparent)}
.complete-spark{position:absolute;color:var(--onb-accent);font-weight:850}.spark-a{left:25%;top:33%;font-size:17px}.spark-b{right:24%;top:22%;font-size:22px}.spark-c{right:31%;bottom:21%;font-size:13px}
.complete-copy { display:flex; justify-content:center; align-items:center; gap:12px; margin-top:18px; text-align:left; }
.complete-copy-mark { width:36px; height:36px; flex:0 0 36px; display:grid; place-items:center; border-radius:12px; color:var(--status-success); background:var(--status-success-bg); font-size:18px; font-weight:900; }
.complete-copy b,.complete-copy small{display:block}.complete-copy b{font-size:13px}.complete-copy small{margin-top:4px;color:var(--content-secondary);font-size:10.5px;line-height:1.45}

.onboarding-actions {
  position: relative;
  z-index: 35;
  height: 62px;
  flex: 0 0 62px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 9px 20px 11px;
  border-top: 1px solid color-mix(in srgb, var(--divider-line) 72%, transparent);
  background: color-mix(in srgb, var(--modal-card-bg) 92%, transparent);
}

.action-group { display: flex; align-items: center; gap: 8px; }
.secondary-action,
.primary-action,
.later-action {
  min-height: 38px;
  padding: 8px 14px;
  border-radius: 11px;
  font-size: 11px;
  font-weight: 680;
  cursor: pointer;
  transition: transform var(--motion-hover-control) var(--motion-ease-standard), border-color var(--motion-hover-control) var(--motion-ease-standard), background-color var(--motion-hover-control) var(--motion-ease-standard);
}
.secondary-action { border: 1px solid var(--control-border); color: var(--content-primary); background: var(--control-bg); }
.primary-action { min-width: 112px; border: 1px solid transparent; color: var(--content-on-accent); background: var(--onb-accent); box-shadow: 0 8px 20px color-mix(in srgb, var(--onb-accent) 20%, transparent); }
.primary-action span { margin-left: 6px; }
.later-action { border: 1px solid transparent; color: var(--content-secondary); background: transparent; }
.secondary-action:hover,
.primary-action:hover:not(:disabled),
.later-action:hover { transform: translateY(-1px); }
.secondary-action:hover,
.later-action:hover { background: var(--control-bg-hover); }
.primary-action:disabled { cursor: wait; opacity: .55; }

.onboarding-step-enter-active,
.onboarding-step-leave-active {
  transition: opacity .18s var(--motion-ease-standard), transform .18s var(--motion-ease-standard);
}
.onboarding-step-enter-from { opacity: 0; transform: translateX(12px); }
.onboarding-step-leave-to { opacity: 0; transform: translateX(-8px); }

@media (max-width: 760px) {
  .onboarding-topbar { grid-template-columns: 1fr auto; }
  .onboarding-progress { display: none; }
  .onboarding-content { padding-inline: 18px; }
  .scene { transform: translate(-50%, -50%) scale(.78); }
  .locale-options,
  .feature-options { grid-template-columns: 1fr; }
  .onboarding-step { grid-template-rows: 260px minmax(0,1fr); }
  .onboarding-modal[data-step='model'] .onboarding-step,
  .onboarding-modal[data-step='im'] .onboarding-step { grid-template-rows: 185px minmax(0,1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .feature-path path,
  .mini-product { animation: none; }
  .onboarding-step-enter-active,
  .onboarding-step-leave-active { transition-duration: .01ms; }
}
</style>

<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('common.language') }}</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('common.language') }}</span><span class="pm-field-hint">{{ t('common.languageHint') }}</span></div><div class="pm-style-group"><button v-for="item in languages" :key="item.value" class="pm-style-chip" :class="{ active: currentLocale === item.value }" @click="prefsStore.saveLocale(item.value)">{{ item.label }}</button></div></div>
      <div class="pm-field-row pm-timezone-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.timezone') }}</span><span class="pm-field-hint">{{ t('preferences.timezoneHint') }}</span></div>
        <div class="pm-timezone-control">
          <AdminSelect :model-value="selectedTimezone" :options="timezoneSelectOptions" @update:model-value="onTimezoneChange" />
        </div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('preferences.appearance') }}</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.theme') }}</span><span class="pm-field-hint">{{ t('preferences.themeHint') }}</span></div>
        <div class="pm-style-group">
          <button v-for="item in families" :key="item.value" class="pm-style-chip pm-family-chip" :class="{ active: family === item.value }" @click="setFamily(item.value)">{{ item.label }}</button>
        </div>
      </div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.appearanceMode') }}</span><span class="pm-field-hint">{{ t('preferences.appearanceModeHint') }}</span></div>
        <div class="pm-style-group">
          <button v-for="item in modes" :key="item.value" class="pm-style-chip" :class="{ active: preference === item.value }" @click="setTheme(item.value)">{{ item.label }}</button>
        </div>
      </div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.palette') }}</span><span class="pm-field-hint">{{ t('preferences.paletteHint') }}</span></div>
        <div class="pm-style-group pm-palette-group" role="group" :aria-label="t('preferences.selectPalette')">
          <button v-for="item in palettes" :key="item.value" type="button" class="pm-palette-chip" :class="{ active: palette === item.value }" :aria-label="`配色：${item.label}`" :aria-pressed="palette === item.value" @click="setPalette(item.value)">
            <span class="pm-palette-swatch" :class="`palette-${item.value}`" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('preferences.workspace') }}</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.defaultView') }}</span><span class="pm-field-hint">{{ t('preferences.defaultViewHint') }}</span></div>
        <div class="pm-style-group">
          <button v-for="view in views" :key="view.value" class="pm-style-chip" :class="{ active: prefsStore.defaultView === view.value }" @click="prefsStore.saveDefaultView(view.value)">{{ view.label }}</button>
        </div>
      </div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.projectSort') }}</span><span class="pm-field-hint">{{ t('preferences.projectSortHint') }}</span></div><div class="pm-coming">{{ t('preferences.unavailable') }}</div></div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('preferences.calendar') }}</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.weekStart') }}</span><span class="pm-field-hint">{{ t('preferences.weekStartHint') }}</span></div><div class="pm-style-group"><button class="pm-style-chip" :class="{ active: prefsStore.calendarWeekStart === 'monday' }" @click="prefsStore.saveCalendarWeekStart('monday')">{{ t('preferences.monday') }}</button><button class="pm-style-chip" :class="{ active: prefsStore.calendarWeekStart === 'sunday' }" @click="prefsStore.saveCalendarWeekStart('sunday')">{{ t('preferences.sunday') }}</button></div></div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.completedDisplay') }}</span><span class="pm-field-hint">{{ t('preferences.completedDisplayHint') }}</span></div>
        <div class="pm-style-group"><button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'done' }" @click="prefsStore.saveCalendarDoneMode('done')">{{ t('preferences.byCompleted') }}</button><button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'deadline' }" @click="prefsStore.saveCalendarDoneMode('deadline')">{{ t('preferences.byDeadline') }}</button></div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">{{ t('preferences.notifications') }}</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('preferences.deadlineNotice') }}</span><span class="pm-field-hint">{{ t('preferences.deadlineNoticeHint') }}</span></div>
        <div class="pm-coming">{{ t('preferences.unavailable') }}</div>
      </div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ t('subscriptionUi.subscribe') }}</span><span class="pm-field-hint">{{ t('subscriptionUi.hint') }}</span></div>
        <ToggleSwitch
          :model-value="!!authStore.user?.emailSubscribed"
          :aria-label="t('subscriptionUi.subscribe')"
          @update:model-value="onEmailSubscriptionChange"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useTheme, type ThemeFamily, type ThemePalette, type ThemePreference } from '@/composables/core/useTheme'
import { useI18n } from 'vue-i18n'
import { localeOptions } from '@/i18n'
import { useAuthStore } from '@/stores/auth'
import { detectedTimezone as getDetectedTimezone, timezoneOptions } from '@/utils/timezones'
import AdminSelect from '@/components/AdminSelect.vue'
import ToggleSwitch from '@/components/common/controls/ToggleSwitch.vue'

const prefsStore = usePreferencesStore()
const authStore = useAuthStore()
const { preference, family, palette, setTheme, setFamily, setPalette } = useTheme()
const { t, locale: currentLocale } = useI18n()
const families: Array<{ value: ThemeFamily; label: string }> = [
  { value: 'glass', label: 'Aero' },
  { value: 'mono', label: 'Mono' },
]
const modes = computed<Array<{ value: ThemePreference; label: string }>>(() => [
  { value: 'light', label: t('layout.light') },
  { value: 'dark', label: t('layout.dark') },
  { value: 'system', label: t('layout.followSystemOption') },
])
const palettes: Array<{ value: ThemePalette; label: string }> = [
  { value: 'mist', label: 'Mist' },
  { value: 'cafe', label: 'Cafe' },
  { value: 'rose', label: 'Rose' },
  { value: 'sky', label: 'Sky' },
  { value: 'sage', label: 'Sage' },
]
const views = computed(() => [
  { value: 'projects', label: t('navigation.projects') },
  { value: 'calendar', label: t('navigation.calendar') },
  { value: 'files', label: t('navigation.files') },
  { value: 'mind', label: t('navigation.mind') },
])
// 语言名称使用各自的原生写法，避免切换语言后选项本身被重新翻译，用户难以定位目标语言。
const languages = localeOptions
const timezones = timezoneOptions()
const detectedTimezone = getDetectedTimezone()
const selectedTimezone = computed(() => authStore.user?.timezone ?? '')
const timezoneSelectOptions = [{ value: '', label: `${t('preferences.timezoneAuto')} · ${detectedTimezone}` }, ...timezones]

function onTimezoneChange(value: string) {
  void authStore.updateProfilePreference({ timezone: value || null }, 'timezone')
}

function onEmailSubscriptionChange(value: boolean) {
  void authStore.updateProfilePreference({ emailSubscribed: value }, 'emailSubscribed')
}
</script>

<style scoped>
.pm-timezone-control { display: flex; flex: 0 1 360px; flex-direction: column; gap: 5px; min-width: 220px; }
.pm-timezone-control small { color: var(--content-tertiary); font-size: 11px; }
:deep(.pm-timezone-control .asel-wrap), :deep(.pm-timezone-control .asel-trigger) { width: 100%; }
:global(.asel-popup--model-list) { max-height: min(420px, calc(100vh - 32px)); overflow-y: auto; }
@media (max-width: 720px) { .pm-timezone-row { align-items: stretch; flex-direction: column; gap: 10px; } .pm-timezone-control { max-width: none; } }
</style>

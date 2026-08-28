<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">外观</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">主题</span><span class="pm-field-hint">选择 Aero 或 Mono 视觉体系</span></div>
        <div class="pm-style-group">
          <button v-for="item in families" :key="item.value" class="pm-style-chip pm-family-chip" :class="{ active: family === item.value }" @click="setFamily(item.value)">{{ item.label }}</button>
        </div>
      </div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">明暗模式</span><span class="pm-field-hint">固定亮色 / 暗色，或跟随系统</span></div>
        <div class="pm-style-group">
          <button v-for="item in modes" :key="item.value" class="pm-style-chip" :class="{ active: preference === item.value }" @click="setTheme(item.value)">{{ item.label }}</button>
        </div>
      </div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">配色</span><span class="pm-field-hint">独立于 Aero / Mono 的主色调</span></div>
        <div class="pm-style-group pm-palette-group" role="group" aria-label="选择配色">
          <button v-for="item in palettes" :key="item.value" type="button" class="pm-palette-chip" :class="{ active: palette === item.value }" :aria-label="`配色：${item.label}`" :aria-pressed="palette === item.value" @click="setPalette(item.value)">
            <span class="pm-palette-swatch" :class="`palette-${item.value}`" aria-hidden="true" />
            <span>{{ item.label }}</span>
          </button>
        </div>
      </div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">语言</span><span class="pm-field-hint">界面显示语言</span></div><div class="pm-static">简体中文</div></div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">工作台</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">默认视图</span><span class="pm-field-hint">打开应用时首先显示的页面</span></div>
        <div class="pm-style-group">
          <button v-for="view in views" :key="view.value" class="pm-style-chip" :class="{ active: prefsStore.defaultView === view.value }" @click="prefsStore.saveDefaultView(view.value)">{{ view.label }}</button>
        </div>
      </div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">项目排序</span><span class="pm-field-hint">项目列表的默认排序方式</span></div><div class="pm-coming">咕了</div></div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">日历</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">一周起始日</span><span class="pm-field-hint">日历每周从哪天开始</span></div><div class="pm-style-group"><button class="pm-style-chip" :class="{ active: prefsStore.calendarWeekStart === 'monday' }" @click="prefsStore.saveCalendarWeekStart('monday')">周一</button><button class="pm-style-chip" :class="{ active: prefsStore.calendarWeekStart === 'sunday' }" @click="prefsStore.saveCalendarWeekStart('sunday')">周日</button></div></div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">已完成项目显示</span><span class="pm-field-hint">日历中已完成项目的截止日期显示方式</span></div>
        <div class="pm-style-group"><button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'done' }" @click="prefsStore.saveCalendarDoneMode('done')">按完成日</button><button class="pm-style-chip" :class="{ active: prefsStore.calendarDoneMode === 'deadline' }" @click="prefsStore.saveCalendarDoneMode('deadline')">按截止日</button></div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section"><div class="pm-section-label">通知</div><div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">项目截止提醒</span><span class="pm-field-hint">截止前 3 天发送通知</span></div><div class="pm-coming">咕了</div></div></div>
  </div>
</template>

<script setup lang="ts">
import { usePreferencesStore } from '@/stores/preferences'
import { useTheme, type ThemeFamily, type ThemePalette, type ThemePreference } from '@/composables/useTheme'

const prefsStore = usePreferencesStore()
const { preference, family, palette, setTheme, setFamily, setPalette } = useTheme()
const families: Array<{ value: ThemeFamily; label: string }> = [
  { value: 'glass', label: 'Aero' },
  { value: 'mono', label: 'Mono' },
]
const modes: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
  { value: 'system', label: '跟随系统' },
]
const palettes: Array<{ value: ThemePalette; label: string }> = [
  { value: 'aero', label: 'Aero' },
  { value: 'mono', label: 'Mono' },
  { value: 'rose', label: 'Rose' },
  { value: 'sky', label: 'Sky' },
  { value: 'sage', label: 'Sage' },
]
const views = [
  { value: 'projects', label: '项目' },
  { value: 'calendar', label: '日历' },
  { value: 'files', label: '文件库' },
  { value: 'mind', label: '思维' },
]
</script>

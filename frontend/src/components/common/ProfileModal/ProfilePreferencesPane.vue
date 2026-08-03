<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">外观</div>
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">主题</span><span class="pm-field-hint">界面颜色风格</span></div><div class="pm-coming">咕了</div></div>
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
      <div class="pm-field-row"><div class="pm-field-desc"><span class="pm-field-name">一周起始日</span><span class="pm-field-hint">日历每周从哪天开始</span></div><div class="pm-coming">咕了</div></div>
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

const prefsStore = usePreferencesStore()
const views = [
  { value: 'projects', label: '项目' },
  { value: 'calendar', label: '日历' },
  { value: 'files', label: '文件库' },
  { value: 'mind', label: '思维' },
]
</script>

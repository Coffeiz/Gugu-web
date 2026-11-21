<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { desktopData } from '@desktop/bridge/bridge'
import ActionButton from '@/components/common/controls/ActionButton.vue'
import FlipChevron from '@/components/common/controls/FlipChevron.vue'
import LogMessage from '@/components/common/logs/LogMessage.vue'

const props = defineProps<{
  kind: 'regular' | 'diagnostic'
  title: string
}>()
const { t, locale } = useI18n()
const open = ref(false)
const viewport = ref<HTMLElement>()
const lines = ref<string[]>([])
const truncated = ref(false)
const loading = ref(false)
const error = ref('')

const rows = computed(() => {
  const format = new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  return lines.value.map(line => {
    try {
      const entry = JSON.parse(line)
      const date = typeof entry?.time === 'string' ? new Date(entry.time) : null
      return {
        line,
        time: date && Number.isFinite(date.getTime()) ? format.format(date) : '',
        timestamp: date && Number.isFinite(date.getTime()) ? date.toLocaleString(locale.value) : '',
        level: typeof entry?.level === 'string' ? entry.level : '',
        message: typeof entry?.message === 'string' && entry.message ? entry.message
          : typeof entry?.event === 'string' ? entry.event : line,
      }
    } catch {
      return { line, time: '', timestamp: '', level: '', message: line }
    }
  })
})

async function scrollToLatest() {
  await nextTick()
  if (open.value && viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const result = await desktopData.readLogs(props.kind)
    lines.value = result.lines
    truncated.value = result.truncated
  } catch {
    error.value = '无法读取本机日志，请稍后重试。'
  } finally {
    loading.value = false
    await scrollToLatest()
  }
}

function toggle() {
  open.value = !open.value
  if (open.value) {
    void scrollToLatest()
    void refresh()
  }
}
</script>

<template>
  <section class="pm-section desktop-log-section">
    <div class="pm-field-row desktop-log-summary">
      <span>{{ title }}</span>
      <div class="desktop-log-actions">
        <ActionButton v-if="open" fit variant="secondary" :disabled="loading" @click="refresh">{{ t('adminLogs.refresh') }}</ActionButton>
        <ActionButton fit variant="secondary" :aria-expanded="open" :aria-controls="`desktop-logs-${kind}`" @click="toggle">
          {{ t(open ? 'chat.collapse' : 'chat.expand') }}
          <FlipChevron :open="open" aria-hidden="true" />
        </ActionButton>
      </div>
    </div>
    <div :id="`desktop-logs-${kind}`" v-show="open">
      <p v-if="truncated" class="pm-field-hint desktop-log-limit">显示最近的日志记录。</p>
      <p v-if="error" class="pm-msg err" role="alert">{{ error }}</p>
      <p v-else-if="loading && !rows.length" class="pm-field-hint" role="status">{{ t('adminLogs.loading') }}</p>
      <p v-else-if="!rows.length" class="pm-field-hint">{{ t('adminLogs.empty') }}</p>
      <div v-if="rows.length" ref="viewport" class="desktop-log-list" tabindex="0" :aria-label="title">
        <div v-for="(row, index) in rows" :key="`${index}:${row.line}`" class="desktop-log-row">
          <div class="desktop-log-meta">
            <time v-if="row.time" :title="row.timestamp">{{ row.time }}</time>
            <span v-if="row.level" class="desktop-log-level" :data-level="row.level">{{ row.level }}</span>
          </div>
          <LogMessage :line="row.line" :message="row.message" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.desktop-log-section.pm-section { padding-block: 12px; gap: 8px; }
.desktop-log-summary.pm-field-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0;
  margin: 0;
  font-weight: 600;
}
.desktop-log-actions { display: flex; align-items: center; gap: 8px; }
.desktop-log-limit { margin: 0 0 4px; }
.desktop-log-list {
  max-height: min(360px, 45vh);
  overflow: auto;
  overscroll-behavior: contain;
  background: var(--surface-soft, var(--control-bg));
  border: 1px solid var(--control-border);
  border-radius: var(--radius-md);
}
.desktop-log-row {
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-divider);
  font-size: 12px;
  line-height: 1.5;
}
.desktop-log-row:last-child { border-bottom: none; }
.desktop-log-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--content-secondary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.desktop-log-level {
  padding: 0 5px;
  border-radius: var(--radius-xs);
  background: var(--action-soft);
  text-transform: uppercase;
}
.desktop-log-level[data-level="warn"] { color: var(--semantic-warning, var(--content-secondary)); }
.desktop-log-level[data-level="error"] { color: var(--semantic-danger, var(--content-secondary)); }
</style>

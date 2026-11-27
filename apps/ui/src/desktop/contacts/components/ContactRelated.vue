<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { desktopData } from '@desktop/bridge/bridge'
import { useMindRefActions } from '@/composables/mind/useMindRefActions'
import { RiLinksLine } from '@remixicon/vue'
import Icon from '@/components/common/icons/Icon.vue'

const props = defineProps({ contactId: { type: Number, required: true } })
type Item = Awaited<ReturnType<typeof desktopData.clientRelated>>[number]
const types = {
  project: { label: 'pageUi.project', icon: 'file.folder-chart' },
  note: { label: 'pageUi.note', icon: 'canvas.note' },
  canvas: { label: 'pageUi.canvas', icon: 'canvas.graph' },
} as const
const items = ref<Item[]>([])
const filter = ref<Item['type'] | null>(null)
const loading = ref(true)
const failed = ref(false)
const visible = computed(() => items.value.filter(item => !filter.value || item.type === filter.value))
const count = computed(() => {
  const totals = { project: 0, note: 0, canvas: 0 }
  for (const item of items.value) totals[item.type]++
  return totals
})
const router = useRouter()
const { openMindRef } = useMindRefActions()

onMounted(async () => {
  try { items.value = await desktopData.clientRelated(props.contactId) }
  catch { failed.value = true }
  finally { loading.value = false }
})

function open(item: Item) {
  if (item.type === 'project') {
    void openMindRef('project', item.id)
  } else {
    void router.push({ path: item.type === 'note' ? '/notes' : '/canvases', query: { object_id: String(item.id) } })
  }
}
</script>

<template>
  <section class="contact-related" aria-labelledby="contact-related-heading" :aria-busy="loading">
    <h3 id="contact-related-heading">{{ $t('pageUi.related') }}</h3>
    <div v-if="!loading && !failed" class="related-types" role="group" :aria-label="$t('pageUi.filterContent')">
      <button v-for="(type, key) in types" :key="key" type="button"
        :aria-pressed="key === filter" :disabled="!count[key]" @click="filter = key === filter ? null : key">
        <Icon :name="type.icon" :size="15" class="related-symbol" aria-hidden="true" />
        <span class="related-label">{{ $t(type.label) }}</span>
        <span class="related-count">{{ $n(count[key]) }}</span>
      </button>
    </div>
    <div class="related-results">
      <p v-if="loading" class="related-status" role="status">{{ $t('pageUi.loadingRelated') }}</p>
      <p v-else-if="failed" class="related-status" role="alert">{{ $t('pageUi.relatedFailed') }}</p>
      <p v-else-if="!items.length" class="related-status related-status--empty">
        <RiLinksLine size="16px" aria-hidden="true" /> {{ $t('pageUi.noRelated') }}
      </p>
      <ul v-else>
        <li v-for="item in visible" :key="item.type + ':' + item.id">
          <button type="button" @click="open(item)">
            <Icon :name="types[item.type].icon" size="sm" aria-hidden="true" />
            <span>{{ item.title }}</span>
            <time :datetime="item.updatedAt">{{ item.updatedAt.slice(0, 10) }}</time>
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.contact-related {
  margin-block-start: var(--space-lg);
}
.related-results {
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-sm);
}
h3 {
  margin: 0 0 var(--space-sm);
  font-size: var(--font-size-body);
  font-weight: var(--font-weight-semibold);
}
.related-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin: 0;
  padding: var(--space-lg) var(--space-md);
  color: var(--content-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-body);
}
.related-status--empty {
  padding-block: calc(var(--space-xs) + var(--space-sm));
  padding-inline: calc(var(--space-md) + var(--space-sm));
}
.related-status svg { flex: none; color: var(--content-secondary); }
.related-types {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--option-gap);
  margin-block-end: var(--space-sm);
}
button { color: var(--content-primary); font: inherit; cursor: pointer; }
.related-types button {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: 3px 6px;
  min-width: 0;
  min-block-size: 40px;
  padding: 4px 6px;
  text-align: center;
  color: var(--content-secondary);
  border: 1px solid var(--content-divider);
  border-radius: var(--radius-xs);
  background: var(--file-card-bg);
  box-shadow: var(--card-shadow);
  transition: var(--card-motion), box-shadow var(--motion-hover-card) ease;
}
.related-types button:disabled { cursor: default; color: var(--content-tertiary); box-shadow: none; }
.related-types button:hover:not(:disabled) {
  color: var(--content-primary);
  border-color: var(--border-hover);
  box-shadow: var(--card-shadow-hover);
}
.related-types button[aria-pressed='true'] {
  color: var(--sidebar-item-active-fg);
  border-color: var(--sidebar-item-active-border);
  background: var(--sidebar-item-active);
  box-shadow: var(--sidebar-item-selected-shadow);
}
.related-types button[aria-pressed='true'] .related-label { font-weight: var(--font-weight-bold); }
.related-types button:active:not(:disabled) { transform: translateY(1px); }
.related-types button:focus-visible { outline: 2px solid var(--action-outline); outline-offset: 1px; }
.related-symbol { flex: none; }
.related-label {
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  line-height: var(--line-height-body);
  overflow-wrap: anywhere;
}
.related-count {
  min-inline-size: 18px;
  max-inline-size: 100%;
  box-sizing: border-box;
  padding: 2px 5px;
  border-radius: var(--radius-pill);
  background: var(--surface-soft);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  overflow-wrap: anywhere;
}
.related-types button[aria-pressed='true'] .related-count {
  color: var(--sidebar-item-active-fg);
  background: var(--surface-soft);
}
@media (prefers-reduced-motion: reduce) {
  .related-types button { transition: none; }
  .related-types button:active:not(:disabled) { transform: none; }
}
li + li { border-block-start: 1px solid var(--content-divider); }
ul { display: grid; gap: var(--space-xs); list-style: none; margin: 0; padding: var(--space-xs) var(--space-md); }
li button {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-xs) var(--space-sm);
  width: 100%;
  border: 0;
  border-radius: var(--radius-xs);
  padding: var(--space-sm);
  background: transparent;
  text-align: start;
  transition: background-color var(--motion-hover-control) var(--motion-ease-standard);
}
li button:is(:hover, :focus-visible) { background: var(--sidebar-item-hover); }
li span { flex: 1 1 8rem; min-width: 0; overflow-wrap: anywhere; font-size: var(--font-size-body); font-weight: var(--font-weight-medium); line-height: var(--line-height-body); }
time { color: var(--content-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-body); font-variant-numeric: tabular-nums; }
</style>

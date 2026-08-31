<template>
  <section class="config-card capability-catalog-card">
    <div class="capability-catalog-head">
      <div>
        <h3 class="capability-catalog-title">{{ t('capabilityUi.title') }}</h3>
        <p class="capability-catalog-desc">{{ t('capabilityUi.description') }}</p>
      </div>
      <button type="button" class="capability-refresh-btn" :disabled="loading" @click="refresh">
        {{ loading ? t('capabilityUi.refreshing') : t('capabilityUi.refresh') }}
      </button>
    </div>
    <div v-if="error" class="llm-msg llm-msg--error">{{ error }}</div>
    <div v-else-if="loading && !catalog" class="presets-loading">{{ t('capabilityUi.loading') }}</div>
    <template v-else-if="catalog">
      <div class="capability-catalog-summary">
        <span>{{ t('capabilityUi.tools') }} {{ catalog.tools.length }}</span>
        <span>{{ t('capabilityUi.skills') }} {{ catalog.skills.length }}</span>
        <span v-if="catalog.diagnostics.length" class="capability-catalog-warning">
          {{ t('capabilityUi.diagnostics') }} {{ catalog.diagnostics.length }}
        </span>
      </div>
      <CapabilityGroup :title="t('capabilityUi.tool')" :items="catalog.tools" tool-items />
      <CapabilityGroup :title="t('capabilityUi.skill')" :items="catalog.skills" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import CapabilityGroup from './CapabilityGroup.vue'
import { useCapabilityCatalog } from '../useCapabilityCatalog'

const { catalog, loading, error, refresh } = useCapabilityCatalog()
const { t } = useI18n()
onMounted(() => { void refresh() })
</script>

<style scoped>
.capability-catalog-card { min-height: calc(100vh - 230px); }
.capability-catalog-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.capability-catalog-title { margin: 0; color: rgba(255,255,255,0.88); font-size: 14px; font-weight: 700; line-height: 1.3; }
.capability-catalog-desc { margin: 3px 0 0; color: rgba(255,255,255,0.38); font-size: 12px; line-height: 1.5; }
.capability-refresh-btn { flex: 0 0 auto; padding: 6px 14px; border: 1px solid rgba(255,255,255,0.1); border-radius: 9px; background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.58); font-size: 13px; cursor: pointer; transition: background .15s, color .15s, border-color .15s; }
.capability-refresh-btn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.82); border-color: rgba(255,255,255,0.16); }
.capability-refresh-btn:disabled { opacity: .5; cursor: default; }
.capability-catalog-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; color: rgba(255,255,255,0.58); font-size: 12px; }
.capability-catalog-summary span { padding: 5px 9px; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; background: rgba(255,255,255,0.035); }
.capability-catalog-warning { color: #f2be7e; }
</style>

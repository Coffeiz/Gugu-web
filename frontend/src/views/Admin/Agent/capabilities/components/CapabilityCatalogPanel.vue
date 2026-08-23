<template>
  <section class="config-card capability-catalog-card">
    <div class="capability-catalog-head">
      <div>
        <h3 class="presets-title">能力目录</h3>
        <p class="presets-desc">来自 Tool / Skill Registry 的只读目录；完整 Schema 和正文只在 Agent 请求中按需注入。</p>
      </div>
      <button type="button" class="pca-btn" :disabled="loading" @click="refresh">
        {{ loading ? '刷新中…' : '刷新目录' }}
      </button>
    </div>
    <div v-if="error" class="llm-msg llm-msg--error">{{ error }}</div>
    <div v-else-if="loading && !catalog" class="presets-loading">加载中…</div>
    <template v-else-if="catalog">
      <div class="capability-catalog-summary">
        <span>工具 {{ catalog.tools.length }}</span>
        <span>Skill {{ catalog.skills.length }}</span>
        <span v-if="catalog.diagnostics.length" class="capability-catalog-warning">
          诊断 {{ catalog.diagnostics.length }} 项
        </span>
      </div>
      <CapabilityGroup title="工具" :items="catalog.tools" tool-items />
      <CapabilityGroup title="Skill" :items="catalog.skills" />
    </template>
  </section>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import CapabilityGroup from './CapabilityGroup.vue'
import { useCapabilityCatalog } from '../useCapabilityCatalog'

const { catalog, loading, error, refresh } = useCapabilityCatalog()
onMounted(() => { void refresh() })
</script>

<style scoped>
.capability-catalog-card { min-height: calc(100vh - 230px); }
.capability-catalog-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.capability-catalog-summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; color: rgba(255,255,255,0.58); font-size: 12px; }
.capability-catalog-summary span { padding: 5px 9px; border: 1px solid rgba(255,255,255,0.08); border-radius: 7px; background: rgba(255,255,255,0.035); }
.capability-catalog-warning { color: #f2be7e; }
</style>

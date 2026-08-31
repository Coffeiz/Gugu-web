<template>
  <section class="config-card deep-research-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(123,127,178,0.15);--stroke:#7b7fb2">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="9" r="6"/><path d="M17 17l-3.5-3.5"/></svg>
      </div>
      <div class="card-title-block">
        <h3>{{ t('searchConfigUi.deepResearch') }}</h3>
        <p>{{ t('searchConfigUi.deepResearchHint') }}</p>
      </div>
    </div>
    <div class="behavior-grid">
      <div class="behavior-item">
        <div class="behavior-label"><span>{{ t('searchConfigUi.provider') }}</span><span class="behavior-desc">{{ t('searchConfigUi.providerHint') }}</span></div>
        <AdminSelect :model-value="draft.deep_research_provider" :options="providerOptions" @update:model-value="draft.deep_research_provider = $event" />
      </div>
      <div v-if="draft.deep_research_provider === 'tavily'" class="behavior-item">
        <div class="behavior-label"><span>Tavily API Key</span><span class="behavior-desc">{{ t('searchConfigUi.keepKey') }}</span></div>
        <input v-model="draft.tavily_api_key" type="password" class="behavior-input deep-research-input" placeholder="tvly-…" autocomplete="new-password" />
      </div>
      <template v-else-if="draft.deep_research_provider === 'baidu'">
        <div class="behavior-item"><div class="behavior-label"><span>{{ t('searchConfigUi.searchKey') }}</span><span class="behavior-desc">{{ t('searchConfigUi.keyHint') }}</span></div><input v-model="draft.deep_research_baidu_api_key" type="password" class="behavior-input deep-research-input" placeholder="API Key" autocomplete="new-password" /></div>
      </template>
      <div v-else class="behavior-item"><div class="behavior-label"><span>You.com API Key</span><span class="behavior-desc">{{ t('searchConfigUi.youApiHint') }}</span></div><input v-model="draft.deep_research_you_api_key" type="password" class="behavior-input deep-research-input" :placeholder="t('searchConfigUi.youApiPlaceholder')" autocomplete="new-password" /></div>
      <div class="behavior-item deep-research-test-row">
        <span v-if="test.msg" class="deep-research-test-message" :class="{ success: test.ok, error: !test.ok }">{{ test.msg }}</span>
        <button class="btn-ghost" :disabled="test.loading" @click="$emit('test')">{{ test.loading ? t('agentConfigUi.testing') : t('searchConfigUi.testConnection') }}</button>
      </div>
    </div>
    <div class="card-actions"><span class="save-hint" :class="{ error: !!error }"><template v-if="saved">{{ t('searchConfigUi.saved') }}</template><template v-else-if="error">{{ error }}</template></span><button class="btn-ghost" @click="$emit('reset')">{{ t('searchConfigUi.undo') }}</button><button class="btn-primary" :disabled="saving" @click="$emit('save')">{{ saving ? t('searchConfigUi.saving') : t('searchConfigUi.save') }}</button></div>
  </section>
</template>
<script setup lang="ts">
import AdminSelect from '@/components/AdminSelect.vue'
import { useI18n } from 'vue-i18n'
defineProps<{ draft: Record<string, any>; test: { loading: boolean; ok: boolean; msg: string }; saving: boolean; saved: boolean; error: string }>()
defineEmits<{ test: []; reset: []; save: [] }>()
const providerOptions = [{ value: 'tavily', label: 'Tavily' }, { value: 'baidu', label: '百度搜索' }, { value: 'you', label: 'You.com' }]
const { t } = useI18n()
</script>

<style scoped>
.deep-research-card {
  background: rgba(255,255,255,0.05);
  backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  border: 1px solid rgba(255,255,255,0.09); border-radius: 16px;
  padding: 22px 24px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06);
}
.deep-research-card .card-head { display:flex; align-items:center; gap:13px; margin-bottom:20px; }
.deep-research-card .card-icon { width:38px; height:38px; border-radius:11px; background:var(--ic); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.deep-research-card .card-icon svg { width:18px; height:18px; color:var(--stroke); }
.deep-research-card .card-title-block { flex:1; min-width:0; }
.deep-research-card .card-title-block h3 { font-size:14px; font-weight:700; color:rgba(255,255,255,0.88); }
.deep-research-card .card-title-block p { font-size:12px; color:rgba(255,255,255,0.38); margin-top:2px; }
.deep-research-card .behavior-grid { display:flex; flex-direction:column; gap:2px; }
.deep-research-card .behavior-item { display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:52px; padding:14px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
.deep-research-card .behavior-item:last-child { border-bottom:none; }
.deep-research-card .behavior-label { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
.deep-research-card .behavior-label span:first-child { font-size:13px; font-weight:500; color:rgba(255,255,255,0.8); }
.deep-research-card .behavior-desc { font-size:12px; line-height:1.45; color:rgba(255,255,255,0.3); }
.deep-research-input { width:280px; flex:0 0 280px; }
.deep-research-card .behavior-input { border-radius:8px; padding:6px 10px; font-size:13px; font-weight:600; text-align:center; outline:none; }
.deep-research-test-row { justify-content:flex-end !important; }
.deep-research-test-message { max-width:55%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.deep-research-test-message.success { color:#4caf7d; }
.deep-research-test-message.error { color:#e07070; }
.deep-research-card .card-actions { display:flex; align-items:center; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.07); }
.deep-research-card .save-hint { flex:1; font-size:12px; color:#5ab899; display:flex; align-items:center; gap:5px; }
.deep-research-card .save-hint.error { color:#e07878; }
.deep-research-card .btn-ghost { padding:6px 14px; border-radius:9px; border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.45); font-size:13px; cursor:pointer; transition:all .15s; }
.deep-research-card .btn-ghost:hover { background:rgba(255,255,255,0.1); color:rgba(255,255,255,0.7); }
.deep-research-card .btn-ghost:disabled { opacity:.5; cursor:default; }
.deep-research-card .btn-primary { padding:6px 16px; border-radius:9px; border:none; background:linear-gradient(135deg,#7b7fb2,#9590c4); color:#fff; font-size:13px; font-weight:600; cursor:pointer; transition:opacity .15s; }
.deep-research-card .btn-primary:disabled { opacity:.5; cursor:default; }
@media (max-width: 760px) {
  .deep-research-card .behavior-item { align-items:flex-start; flex-direction:column; }
  .deep-research-input { width:100%; flex-basis:auto; }
  .deep-research-test-row { align-items:center !important; flex-direction:row !important; }
  .deep-research-test-message { max-width:calc(100% - 92px); }
}
</style>
<style scoped>
.deep-research-card .btn-primary { background: var(--action-primary-bg); color: var(--content-on-accent); transition: background-color .15s; }
.deep-research-card .btn-primary:hover:not(:disabled) { background: var(--action-primary-bg-hover); }
</style>

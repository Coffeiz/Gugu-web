<template>
  <section class="config-card similar-image-card">
    <div class="card-head">
      <div class="card-icon" style="--ic:rgba(218,157,111,0.15);--stroke:#da9d6f">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.5 12.5L17 17M6.5 8.5h4M8.5 6.5v4"/>
        </svg>
      </div>
      <div class="card-title-block">
        <h3>相似图搜索</h3>
        <p>根据用户图片查找相似候选；保存有效 Provider Key 后启用，不再单独维护开启开关。</p>
      </div>
    </div>

    <div class="behavior-grid">
      <div class="behavior-item" style="grid-column: 1 / -1;">
        <div class="behavior-label">
          <span>搜索 Provider</span>
          <span class="behavior-desc">当前支持百度千帆；未保存有效 Key 时不会调用外部服务。</span>
        </div>
        <div class="provider-input-row">
          <span v-if="test.msg" :title="test.msg" class="test-message" :class="{ success: test.ok, error: !test.ok }">{{ test.msg }}</span>
          <button class="btn-ghost" :disabled="test.loading" @click="$emit('test')">{{ test.loading ? '测试中…' : '测试' }}</button>
          <AdminSelect
            :model-value="draft.similar_image_provider"
            :options="providerOptions"
            aria-label="相似图搜索 Provider"
            @update:model-value="draft.similar_image_provider = $event"
          />
          <input
            v-model="draft.baidu_qianfan_api_key"
            type="password"
            class="behavior-input provider-key-input"
            autocomplete="new-password"
            placeholder="百度 API Key（保存有效 Key 后启用）"
          />
        </div>
      </div>

      <div class="behavior-item">
        <div class="behavior-label"><span>默认结果数</span><span class="behavior-desc">范围 1～50；用户也可以在对话中指定数量</span></div>
        <input v-model.number="draft.similar_image_default_count" type="number" class="behavior-input" min="1" max="50" />
      </div>
      <div class="behavior-item">
        <div class="behavior-label"><span>每日限额</span><span class="behavior-desc">按用户统计</span></div>
        <input v-model.number="draft.similar_image_limit_daily" type="number" class="behavior-input" min="1" />
      </div>
      <div class="behavior-item">
        <div class="behavior-label"><span>请求超时</span><span class="behavior-desc">范围 5～60 秒</span></div>
        <input v-model.number="draft.similar_image_timeout_seconds" type="number" class="behavior-input" min="5" max="60" />
      </div>
    </div>

    <div class="card-actions">
      <span class="save-hint" :class="{ error: !!error }">
        <template v-if="saved">已保存</template><template v-else-if="error">{{ error }}</template>
      </span>
      <button class="btn-ghost" @click="$emit('reset')">撤销修改</button>
      <button class="btn-primary" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存' }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import AdminSelect from '@/components/AdminSelect.vue'

defineProps<{
  draft: Record<string, any>
  test: { loading: boolean; ok: boolean; msg: string }
  saving: boolean
  saved: boolean
  error: string
}>()

defineEmits<{ test: []; reset: []; save: [] }>()

const providerOptions = [{ value: 'baidu_qianfan', label: '百度千帆' }]
</script>

<style scoped>
.similar-image-card { background: rgba(255,255,255,0.05); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); border: 1px solid rgba(255,255,255,0.09); border-radius: 16px; padding: 22px 24px; box-shadow: 0 4px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.06); }
.similar-image-card .card-head { display:flex; align-items:center; gap:13px; margin-bottom:20px; }
.similar-image-card .card-icon { width:38px; height:38px; border-radius:11px; background:var(--ic); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
.similar-image-card .card-icon svg { width:18px; height:18px; color:var(--stroke); }
.similar-image-card .card-title-block { flex:1; min-width:0; }
.similar-image-card .card-title-block h3 { font-size:14px; font-weight:700; color:rgba(255,255,255,0.88); }
.similar-image-card .card-title-block p { font-size:12px; color:rgba(255,255,255,0.38); margin-top:2px; }
.similar-image-card .behavior-grid { display:flex; flex-direction:column; gap:2px; }
.similar-image-card .behavior-item { display:flex; align-items:center; justify-content:space-between; gap:18px; min-height:52px; padding:14px 0; border-bottom:1px solid rgba(255,255,255,0.06); }
.similar-image-card .behavior-item:last-child { border-bottom:none; }
.similar-image-card .behavior-label { display:flex; flex:1; min-width:0; flex-direction:column; gap:3px; }
.similar-image-card .behavior-label span:first-child { font-size:13px; font-weight:500; color:rgba(255,255,255,0.8); }
.similar-image-card .behavior-desc { font-size:12px; line-height:1.45; color:rgba(255,255,255,0.3); }
.provider-input-row { display:flex; align-items:center; justify-content:flex-end; gap:10px; min-width:0; }
.provider-key-input { width:280px; flex:0 0 280px; }
.similar-image-card .behavior-input { background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.1); border-radius:8px; padding:6px 10px; font-size:13px; font-weight:600; color:rgba(255,255,255,0.8); text-align:center; outline:none; transition:border-color .15s; }
.similar-image-card .behavior-input:focus { border-color:rgba(123,127,178,0.4); }
.similar-image-card .test-message { max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.test-message.success { color:#4caf7d; }.test-message.error { color:#e07070; }
.similar-image-card .card-actions { display:flex; align-items:center; gap:10px; margin-top:18px; padding-top:16px; border-top:1px solid rgba(255,255,255,0.07); }
.similar-image-card .save-hint { flex:1; font-size:12px; color:#5ab899; }.similar-image-card .save-hint.error { color:#e07878; }
.similar-image-card .btn-ghost,.similar-image-card .btn-primary { padding:6px 14px; border-radius:9px; font-size:13px; cursor:pointer; }
.similar-image-card .btn-ghost { border:1px solid rgba(255,255,255,0.1); background:rgba(255,255,255,0.06); color:rgba(255,255,255,0.45); }
.similar-image-card .btn-primary { border:0; background:var(--action-primary-bg); color:#fff; font-weight:600; }
.similar-image-card button:disabled { opacity:.5; cursor:default; }
</style>

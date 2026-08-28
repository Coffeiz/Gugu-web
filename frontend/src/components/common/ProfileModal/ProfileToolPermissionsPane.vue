<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">工具定义</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">工具定义模式</span><span class="pm-field-hint">能力目录节省 token；完整工具定义参数识别更准确，但消耗更多 token</span></div>
        <div class="pm-style-group">
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'catalog' }" @click="prefsStore.saveToolInjectionMode('catalog')">能力目录（轻量）</button>
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'full_schema' }" @click="prefsStore.saveToolInjectionMode('full_schema')">完整工具定义（高准确）</button>
        </div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">专项能力凭据</div>
      <p class="pm-field-hint">深度研究和相似图搜索使用独立的 API Key；不配置时继续使用 Admin 默认配置。</p>
      <div v-for="item in capabilityItems" :key="item.capability" class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ item.label }}</span><span class="pm-field-hint">{{ item.hint }}</span></div>
        <div class="capability-editor"><AdminSelect v-model="item.provider" :options="providersFor(item.capability)" placeholder="选择 Provider" /><input v-model="item.value" class="form-input" type="password" autocomplete="new-password" placeholder="留空表示保持当前 Key" /><button class="pm-style-chip" :disabled="item.saving || !item.id || (testingCapability !== null && testingCapability === item.id)" :title="item.id ? '测试当前配置' : '请先保存配置'" @click="item.id && testCapability(item)">{{ testingCapability !== null && testingCapability === item.id ? '测试中…' : '测试' }}</button><button class="pm-style-chip" :disabled="item.saving" @click="saveCapability(item)">{{ item.saving ? '保存中…' : item.id ? '更新' : '保存' }}</button></div>
      </div>
      <div v-if="capabilityMessage" class="pm-msg" :class="capabilityMessageType">{{ capabilityMessage }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { byokApi } from '@/services/api'
import AdminSelect from '@/components/AdminSelect.vue'
import { usePreferencesStore } from '@/stores/preferences'

const prefsStore = usePreferencesStore()
const capabilityMessage = ref(''); const capabilityMessageType = ref('ok')
const testingCapability = ref<number | null>(null)
const modelProviders = [{ value: 'tavily', label: 'Tavily' }, { value: 'baidu', label: '百度搜索' }, { value: 'you', label: 'You.com' }]
function providersFor(capability: string) { return capability === 'similar_image_search' ? [{ value: 'qianfan', label: '百度千帆' }] : modelProviders }
const capabilityItems = reactive<any[]>([
  { capability: 'deep_research', label: '深度研究', hint: 'Provider 可填 tavily、baidu 或 you。', providerPlaceholder: 'Provider', provider: '', value: '', id: null, saving: false },
  { capability: 'similar_image_search', label: '相似图搜索', hint: '当前支持百度千帆相似图搜索。', providerPlaceholder: 'qianfan', provider: 'qianfan', value: '', id: null, saving: false },
])
onMounted(async () => { try { const rows = (await byokApi.list()).items || []; for (const item of capabilityItems) { const row = rows.find((candidate: any) => candidate.capability === item.capability); if (row) { item.id = row.id; item.provider = row.provider } } } catch { /* BYOK 关闭时仍正常显示专项能力 */ } })
async function saveCapability(item: any) { item.saving = true; capabilityMessage.value = ''; try { const payload: Record<string, unknown> = { provider: item.provider, capability: item.capability }; if (item.value) payload.value = item.value; const row = item.id ? await byokApi.update(item.id, payload) : await byokApi.create(payload); item.id = row.id; item.value = ''; capabilityMessage.value = `${item.label}配置已保存`; capabilityMessageType.value = 'ok' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : '保存失败'; capabilityMessageType.value = 'err' } finally { item.saving = false } }
async function testCapability(item: any) { if (!item.id) return; testingCapability.value = item.id; capabilityMessage.value = ''; try { const result = await byokApi.test(item.id); capabilityMessage.value = result.message || '检查通过'; capabilityMessageType.value = result.ok ? 'ok' : 'err' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : '检查失败'; capabilityMessageType.value = 'err' } finally { testingCapability.value = null } }
</script>

<style>
.capability-editor { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.capability-editor .form-input { width: 150px; }
.capability-editor .form-input { height: 34px; box-sizing: border-box; }
</style>

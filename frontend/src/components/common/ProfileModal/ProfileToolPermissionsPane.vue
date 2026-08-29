<template>
  <div>
    <div class="pm-section">
      <div class="pm-section-label">工具定义</div>
      <div class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">工具 Schema 模式</span><span class="pm-field-hint">简介模式更省 token；全量模式提供完整字段结构，准确性更高但消耗更多 token</span></div>
        <div class="pm-style-group">
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'description' }" @click="prefsStore.saveToolInjectionMode('description')">简介模式</button>
          <button class="pm-style-chip" :class="{ active: prefsStore.toolInjectionMode === 'full' }" @click="prefsStore.saveToolInjectionMode('full')">全量模式</button>
        </div>
      </div>
    </div>
    <div class="pm-sep"></div>
    <div class="pm-section">
      <div class="pm-section-label">专项能力凭据</div>
      <p class="pm-field-hint">深度研究和相似图搜索使用独立的 API Key；不配置时继续使用 Admin 默认配置。</p>
      <div v-for="item in capabilityItems" :key="item.capability" class="pm-field-row">
        <div class="pm-field-desc"><span class="pm-field-name">{{ item.label }}</span><span class="pm-field-hint">{{ item.hint }}</span></div>
        <div class="capability-editor"><AdminSelect v-model="item.provider" :options="providersFor(item.capability)" placeholder="选择 Provider" /><input v-model="item.value" class="form-input" type="password" autocomplete="new-password" placeholder="留空表示保持当前 Key" /><button class="pm-style-chip" :disabled="item.saving || !item.provider || item.provider === serverDefault || (testingCapability !== null && testingCapability === item.id)" :title="item.provider === serverDefault ? '服务器默认配置不可在此测试' : '测试当前配置'" @click="testCapability(item)">{{ testingCapability === (item.id ?? -1) ? '测试中…' : '测试' }}</button><button class="pm-style-chip" :disabled="item.saving" @click="saveCapability(item)">{{ item.saving ? '保存中…' : item.id ? '更新' : '保存' }}</button></div>
      </div>
      <div v-if="capabilityMessage" class="pm-msg" :class="capabilityMessageType">{{ capabilityMessage }}</div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { byokApi } from '@/services/api'
import { pickByokCredential } from '@/utils/byokCredentials'
import AdminSelect from '@/components/AdminSelect.vue'
import { usePreferencesStore } from '@/stores/preferences'

const prefsStore = usePreferencesStore()
const capabilityMessage = ref(''); const capabilityMessageType = ref('ok')
const testingCapability = ref<number | null>(null)
const serverDefault = '__server_default__'
const modelProviders = [{ value: 'tavily', label: 'Tavily' }, { value: 'baidu', label: '百度搜索' }, { value: 'you', label: 'You.com' }]
function providersFor(capability: string) { return [{ value: serverDefault, label: '服务器默认' }, ...(capability === 'similar_image_search' ? [{ value: 'qianfan', label: '百度千帆' }] : modelProviders)] }
const capabilityItems = reactive<any[]>([
  { capability: 'deep_research', label: '深度研究', hint: 'Provider 可填 tavily、baidu 或 you。', provider: serverDefault, value: '', id: null, saving: false },
  { capability: 'similar_image_search', label: '相似图搜索', hint: '当前支持百度千帆相似图搜索。', provider: serverDefault, value: '', id: null, saving: false },
])
onMounted(async () => { try { const rows = (await byokApi.list()).items || []; for (const item of capabilityItems) { const row = pickByokCredential(rows, item.capability); if (row) { item.id = row.id; item.provider = row.provider } } } catch { /* BYOK 关闭时仍正常显示专项能力 */ } })
async function saveCapability(item: any) {
  if (item.provider === serverDefault) {
    if (!item.id) { capabilityMessage.value = `${item.label}将使用服务器默认配置`; capabilityMessageType.value = 'ok'; return }
    item.saving = true
    capabilityMessage.value = ''
    try {
      await byokApi.remove(item.id)
      item.id = null
      item.value = ''
      capabilityMessage.value = `${item.label}已改用服务器默认配置`
      capabilityMessageType.value = 'ok'
    } catch (e) {
      capabilityMessage.value = e instanceof Error ? e.message : '恢复服务器默认配置失败'
      capabilityMessageType.value = 'err'
    } finally { item.saving = false }
    return
  }
  item.saving = true; capabilityMessage.value = ''; try { const payload: Record<string, unknown> = { provider: item.provider, capability: item.capability, enabled: true }; if (item.value) payload.value = item.value; const row = item.id ? await byokApi.update(item.id, payload) : await byokApi.create(payload); item.id = row.id; item.value = ''; capabilityMessage.value = `${item.label}配置已保存`; capabilityMessageType.value = 'ok' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : '保存失败'; capabilityMessageType.value = 'err' } finally { item.saving = false }
}
async function testCapability(item: any) { if (!item.provider || item.provider === serverDefault || (!item.id && !item.value)) return; const marker = item.id ?? -1; testingCapability.value = marker; capabilityMessage.value = ''; try { const result = item.value ? await byokApi.testPreview({ provider: item.provider, capability: item.capability, value: item.value }) : await byokApi.test(item.id); capabilityMessage.value = result.message || '测试通过'; capabilityMessageType.value = result.ok ? 'ok' : 'err' } catch (e) { capabilityMessage.value = e instanceof Error ? e.message : '测试失败'; capabilityMessageType.value = 'err' } finally { testingCapability.value = null } }
</script>

<style>
.capability-editor { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
.capability-editor .form-input { width: 150px; }
.capability-editor .form-input { height: 34px; box-sizing: border-box; }
</style>

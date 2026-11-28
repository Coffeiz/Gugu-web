<template>
  <section class="network-policy" :aria-label="t('sandboxNetwork.title')">
    <div class="network-policy__row">
      <div class="network-policy__copy">
        <span>{{ t('sandboxNetwork.title') }}</span>
        <small>{{ t('sandboxNetwork.effective', { mode: t(`sandboxNetwork.${effectiveMode}`) }) }}</small>
        <small v-if="!ready">{{ t('sandboxNetwork.unavailable') }}</small>
      </div>
      <AdminSelect v-if="loaded" v-model="mode" :options="modes" :aria-label="t('sandboxNetwork.title')" :disabled="saving" />
    </div>
    <template v-if="loaded && mode === 'private'">
      <div class="network-policy__row">
        <span>{{ t('sandboxNetwork.privateAccess') }}</span>
        <AdminSelect v-model="privateAccess" :options="accessModes" :aria-label="t('sandboxNetwork.privateAccess')" :disabled="saving" />
      </div>
      <div v-if="privateAccess === 'specified'" class="network-policy__fields">
        <span>{{ t('sandboxNetwork.rules') }}</span>
        <textarea v-model="rulesText" class="form-input network-policy__rules control-resizable"
          :aria-label="t('sandboxNetwork.rules')" :placeholder="t('sandboxNetwork.example')" :disabled="saving" rows="4" />
        <small>{{ t('sandboxNetwork.format') }}</small>
      </div>
    </template>
    <small v-if="message" role="status">{{ message }}</small>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAdminStore } from '@/stores/admin'
import AdminSelect from '@/components/AdminSelect.vue'

type Policy = {
  mode: 'offline' | 'public' | 'private'
  privateAccess: 'specified' | 'all'
  rules: Array<{ target: string; protocol: 'tcp' | 'udp'; ports: number[] }>
}
const { t } = useI18n()
const admin = useAdminStore()
const endpoint = '/api/v1/admin/sandbox/network'
const mode = ref<Policy['mode']>('offline')
const privateAccess = ref<Policy['privateAccess']>('specified')
const rulesText = ref('')
const loaded = ref(false)
const ready = ref(false)
const effectiveMode = ref<Policy['mode']>('offline')
defineProps({ saving: Boolean })
let saved: Policy | undefined
const message = ref('')
const modes = computed(() => ['offline', 'public', 'private'].map(value => ({ value, label: t(`sandboxNetwork.${value}`) })))
const accessModes = computed(() => ['specified', 'all'].map(value => ({ value, label: t(`sandboxNetwork.${value}`) })))

async function read() {
  const response = await admin.authFetch(endpoint)
  if (!response.ok) throw new Error(t('sandboxNetwork.failed'))
  const result: { configured: Policy; ready: boolean; effectiveMode: Policy['mode'] } = await response.json()
  commit(result.configured)
  effectiveMode.value = result.effectiveMode
  ready.value = result.ready
  loaded.value = true
}

onMounted(async () => {
  try { await read() }
  catch { message.value = t('sandboxNetwork.failed') }
})
function commit(policy: Policy) {
  saved = policy
  mode.value = policy.mode
  privateAccess.value = policy.privateAccess
  rulesText.value = policy.rules.map(rule => `${rule.target} ${rule.protocol} ${rule.ports.join(',')}`).join('\n')
}
function reset() {
  if (saved) commit(saved)
}
function draft(): Policy | undefined {
  if (!loaded.value) return undefined
  const rules: Policy['rules'] = []
  for (const line of rulesText.value.split('\n').map(line => line.trim()).filter(Boolean)) {
    const [target, protocol, ports, extra] = line.split(/\s+/)
    if (!target || (protocol !== 'tcp' && protocol !== 'udp') || !/^\d+(,\d+)*$/.test(ports ?? '') || extra !== undefined) {
      throw new Error(t('sandboxNetwork.format'))
    }
    rules.push({ target, protocol, ports: ports.split(',').map(Number) })
  }
  return { mode: mode.value, privateAccess: privateAccess.value, rules }
}
defineExpose({ draft, reset, commit })
</script>

<style scoped>
.network-policy {
  padding: 13px 0;
  border-bottom: 1px solid var(--panel-divider);
  color: var(--content-secondary);
  font-size: 12px;
}
.network-policy__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}
.network-policy__row + .network-policy__row,
.network-policy__fields { margin-top: 12px; }
.network-policy__copy { display: grid; flex: 1 1 220px; gap: 4px; min-width: 0; }
.network-policy__fields { display: grid; gap: 6px; }
.network-policy small { color: var(--content-tertiary); font-size: 11px; line-height: 1.4; }
.network-policy__rules { width: 100%; box-sizing: border-box; }
</style>

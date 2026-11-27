<template>
  <section class="pm-section">
    <h3 class="pm-section-label">{{ t('sharedUi.currentDevice') }}</h3>
    <div class="pm-field">
      <span class="pm-field-name">{{ t('sharedUi.deviceClient') }}</span>
      <div class="pm-static">{{ t(desktop ? 'sharedUi.deviceDesktop' : 'sharedUi.deviceWeb') }}</div>
    </div>
    <div v-if="platform" class="pm-field">
      <span class="pm-field-name">{{ t('sharedUi.devicePlatform') }}</span>
      <div class="pm-static">{{ platform }}</div>
    </div>
    <div class="pm-field">
      <span class="pm-field-name">{{ t('sharedUi.deviceId') }}</span>
      <code v-if="deviceId" class="pm-static device-id">{{ deviceId }}</code>
      <div v-else class="pm-static" role="status">{{ t(failed ? 'sharedUi.deviceUnavailable' : 'sharedUi.deviceLoading') }}</div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAuthDeviceId } from '@/utils/authDevice'

const props = defineProps<{
  loadDesktopDevice?: () => Promise<{ deviceId: string; platform: string }>
}>()
const { t } = useI18n()
const desktop = Boolean(props.loadDesktopDevice)
const deviceId = ref('')
const platformCode = ref('')
const failed = ref(false)
const platform = computed(() => {
  const value = platformCode.value.toLowerCase()
  if (value === 'darwin' || value.startsWith('mac')) return 'macOS'
  if (value.startsWith('win')) return 'Windows'
  if (value.startsWith('linux')) return 'Linux'
  return platformCode.value
})

onMounted(async () => {
  try {
    if (props.loadDesktopDevice) {
      const device = await props.loadDesktopDevice()
      deviceId.value = device.deviceId
      platformCode.value = device.platform
    } else {
      deviceId.value = getAuthDeviceId()
      platformCode.value = navigator.platform
    }
  } catch {
    failed.value = true
  }
})
</script>

<style scoped>
.device-id { display: block; font-family: var(--font-family-mono); overflow-wrap: anywhere; user-select: text; }
</style>

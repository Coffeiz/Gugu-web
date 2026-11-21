<script setup lang="ts">
import { onMounted, onUnmounted, shallowRef, ref } from 'vue'
import FloatPreviewWindow from '@/components/common/layout/FloatPreviewWindow.vue'
import AppToast from '@/components/common/feedback/AppToast.vue'
import { previewWindowBridge } from './previewWindowBridge'
import { isTextFallbackCandidate, type PreviewWindow } from '@/stores/preview'
import { errorMessage, showAppError } from '@/composables/core/useAppToast'
import type { DesktopPreviewWindowState } from '@gugu/desktop-contracts'

const preview = shallowRef<PreviewWindow>()
const failed = ref(false)
const windowState = shallowRef<DesktopPreviewWindowState>({ fullscreen: false, pinned: false })
const unsubscribe = previewWindowBridge?.onStateChanged(state => { windowState.value = state })
onUnmounted(() => unsubscribe?.())

onMounted(async () => {
  try {
    if (!previewWindowBridge) { failed.value = true; return }
    const [reply, state] = await Promise.all([previewWindowBridge.read(), previewWindowBridge.state('read')])
    if (state.ok) windowState.value = state.result
    if (!reply?.ok) { failed.value = true; return }
    preview.value = {
      id: 1, file: reply.result, reloadToken: 1, siblings: [],
      textFallback: isTextFallbackCandidate(reply.result.ext, reply.result.mimeType),
      x: 0, y: 0, w: window.innerWidth, h: window.innerHeight, zIndex: 1, _idx: 0,
    }
  } catch { failed.value = true }
})

async function toggleWindow(action: 'fullscreen' | 'pin') {
  try {
    const reply = await previewWindowBridge?.state(action, !windowState.value[action === 'pin' ? 'pinned' : 'fullscreen'])
    if (reply?.ok === false) showAppError(reply.error.message)
  } catch (error) { showAppError(errorMessage(error)) }
}

function close() { void previewWindowBridge?.close() }

async function reveal() {
  try {
    const reply = await previewWindowBridge?.reveal()
    if (reply?.ok === false) showAppError(reply.error.message)
  } catch (error) { showAppError(errorMessage(error)) }
}
</script>

<template>
  <FloatPreviewWindow v-if="preview" :win="preview" native-window :native-state="windowState" @close="close" @reveal="reveal"
    @toggle-fullscreen="toggleWindow('fullscreen')" @toggle-pin="toggleWindow('pin')" />
  <p v-else-if="failed" role="alert">无法打开文件预览</p>
  <AppToast />
</template>

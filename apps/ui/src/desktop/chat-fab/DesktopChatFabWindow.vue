<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import GuguChatFab from '@/components/common/gugu-chat/GuguChatFab.vue'
import { chatFab } from './bridge'

const nativeGlass = ref(false)
const offMaterial = chatFab?.onMaterial(glass => { nativeGlass.value = glass })
onUnmounted(() => offMaterial?.())

let pointer: { id: number; x: number; y: number } | undefined

function start(event: PointerEvent) {
  if (event.button !== 0 || pointer || !(event.target instanceof Element) || !event.target.closest('.ai-fab')) return
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY }
  const target = event.currentTarget as Element
  target.setPointerCapture(pointer.id)
  chatFab?.gesture('down', pointer.x, pointer.y)
}

function move(event: PointerEvent) {
  if (event.pointerId !== pointer?.id) return
  pointer.x = event.screenX
  pointer.y = event.screenY
  chatFab?.gesture('move', pointer.x, pointer.y)
}

function finish(event: PointerEvent, reason: 'up' | 'cancel' | 'lost') {
  if (event.pointerId !== pointer?.id) return
  const last = pointer
  pointer = undefined
  if (reason === 'lost') chatFab?.gesture('up', last.x, last.y)
  else chatFab?.gesture(reason, event.screenX, event.screenY)
}

function activate(event: MouseEvent) {
  if (event.detail === 0) chatFab?.gesture('open')
}
</script>

<template>
  <div class="desktop-chat-fab-window" :class="{ 'has-native-glass': nativeGlass }" @pointerdown="start" @pointermove="move"
    @pointerup="finish($event, 'up')" @pointercancel="finish($event, 'cancel')"
    @lostpointercapture="finish($event, 'lost')" @click.capture="activate">
    <GuguChatFab :fab-z="1" :ripple-active="false" :has-audio-file="false"
      :spinning-back="false" :fab-jumping="false" :audio-playing="false" />
  </div>
</template>

<style>
html[data-desktop-chat-fab] body { margin: 0; background: transparent; }
html[data-desktop-chat-fab] .desktop-boot-shell { display: none; }
.desktop-chat-fab-window { display: grid; place-items: center; height: 100%; touch-action: none; user-select: none; }
.desktop-chat-fab-window .ai-fab-shell { position: relative; inset: auto; }
.desktop-chat-fab-window.has-native-glass .ai-fab {
  background: color-mix(in srgb, var(--surface-card-solid) 28%, transparent);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.desktop-chat-fab-window .ai-fab:active { cursor: grabbing; }
</style>

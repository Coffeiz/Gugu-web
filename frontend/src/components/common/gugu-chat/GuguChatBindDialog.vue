<template>
  <Transition name="chat-drop-fade">
    <div v-if="open" class="cb-overlay" @click.self="$emit('close')">
      <div class="cb-modal popup-menu">
        <div class="cb-title">{{ t('chatUi.scanBind') }}{{ label }}</div>
        <canvas ref="canvasEl" class="cb-qr"></canvas>
        <div v-if="err" class="cb-err">{{ err }}</div>
        <div v-else class="cb-hint">{{ hint || t('chatUi.generatingQr') }}</div>
        <button class="cb-cancel" @click="$emit('close')">{{ t('common.actions.cancel') }}</button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
/**
 * 聊天内「扫码绑定 IM」弹窗：咕咕回复里点 [扫码绑定…](gugu://bind-im/<platform>)
 * 按钮触发。只做展示，二维码生成（QRCode.toCanvas）、轮询和连接状态仍由
 * GuguChat.vue 的 openChatImBind() 持有——那是跨请求的轮询状态机，不是纯展示。
 * canvasEl 通过 defineExpose 暴露给它做 QRCode.toCanvas(canvasEl, ...)。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'

defineProps<{
  open: boolean
  label: string
  hint: string
  err: string
}>()

defineEmits<{ close: [] }>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
const { t } = useI18n()
defineExpose({ canvasEl: computed(() => canvasEl.value) })
</script>

<style scoped>
/* 与 GuguChat.vue 的拖拽遮罩共用同一个过渡名，各自在自己的 scope 里放一份
   （只有两行，复制比 :deep() 更简单）。 */
.chat-drop-fade-enter-active, .chat-drop-fade-leave-active { transition: opacity 0.15s ease; }
.chat-drop-fade-enter-from, .chat-drop-fade-leave-to { opacity: 0; }

.cb-overlay {
  position: absolute; inset: 0; z-index: 50;
  display: flex; align-items: center; justify-content: center;
  /* 极轻遮罩、不压暗（仅用于点外面关闭 + 一点聚焦）——避免把弹窗玻璃衬得发灰发透，
     让它和右键菜单一样浮在亮内容上、显得更实 */
  background: rgba(0,0,0,0.04);
}
.cb-modal {
  /* 玻璃外观复用全局 .popup-menu（与右键菜单完全一致）；这里只管布局 + 固定宽度（防止加载前后变宽）*/
  display: flex; flex-direction: column; align-items: center; gap: 9px;
  width: 230px; box-sizing: border-box;
  padding: 18px 20px 14px;
}
.cb-title { font-size: 13.5px; font-weight: 700; color: var(--text-primary); }
.cb-qr {
  width: 168px; height: 168px; border-radius: 10px;
  background: #fff; padding: 6px; box-sizing: border-box;
  box-shadow: 0 2px 10px rgba(123,127,178,0.18);
}
.cb-hint, .cb-err {
  font-size: 11.5px; text-align: center; line-height: 1.5; max-width: 190px;
  min-height: 33px;          /* 预留 ~2 行：二维码/提示加载前后弹窗高度不跳 */
  display: flex; align-items: center; justify-content: center;
}
.cb-hint { color: var(--text-secondary); }
.cb-err  { color: rgba(200,80,80,0.9); }
.cb-cancel {
  margin-top: 2px; padding: 5px 16px; font-size: 12px;
  color: var(--text-secondary); background: rgba(123,127,178,0.1);
  border: none; border-radius: 999px; cursor: pointer;
}
.cb-cancel:hover { background: rgba(123,127,178,0.18); }
</style>

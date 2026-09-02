<template>
  <Transition name="mini-player">
    <div v-if="visible" class="mini-player" :style="style">
      <div class="mp-info">
        <span class="mp-bars" :class="{ 'mp-bars--playing': barsPlaying }" ref="barsEl"><i v-for="n in 4" :key="n" /></span>
        <span class="mp-name">{{ fileName }}</span>
        <div class="btn-group">
          <button class="mp-btn mp-btn--pin" :class="{ 'mp-btn--pinned': pinned }"
                  @click="$emit('update:pinned', !pinned)" :title="pinned ? t('chatUi.unpin') : t('chatUi.pin')">
            <Icon name="canvas.pin" v-if="pinned" :size="14" />
            <Icon name="canvas.pin"Slash v-else :size="14" />
          </button>
          <button class="mp-btn mp-btn--close popup-close-btn" @click="onStop" :title="t('common.actions.close')">
            <Icon name="action.close" :size="13" />
          </button>
        </div>
      </div>
      <div class="mp-seek-row">
        <span class="mp-time">{{ fmtTime(current) }}</span>
        <div class="mp-track" @click="onSeek" @mousedown="onStartDrag">
          <div class="mp-fill" :style="{ width: seekPct + '%' }" />
          <div class="mp-thumb" :style="{ left: seekPct + '%' }" />
        </div>
        <span class="mp-time">{{ fmtTime(duration) }}</span>
      </div>
      <div class="mp-controls">
        <div class="mp-vol-spacer" />
        <button class="mp-btn mp-btn--play" @click="onToggle">
          <Icon name="media.play-fill"  v-if="!playing" :size="16" />
          <Icon name="media.pause" v-else :size="16" />
        </button>
        <div class="mp-vol-group">
          <button class="mp-vol-btn" @click="onToggleMute">
            <Icon name="media.speaker-high"  v-if="!muted && volume > 0.5" :size="14" />
            <Icon name="media.speaker-low"   v-else-if="!muted && volume > 0" :size="14" />
            <Icon name="media.speaker-off" v-else :size="14" />
          </button>
          <input class="mp-vol-slider" type="range" min="0" max="1" step="0.02" :value="volume" @input="onSetVolume" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
/**
 * 迷你播放器卡片：纯展示 + 交互转发。真正的 <audio> 元素和播放机制仍在
 * GuguChat.vue（useChatAudio 的 audioEl 需要在同一处声明模板 ref 才能绑定
 * 到真实 DOM），这里只是外壳。barsEl 通过 defineExpose 暴露——播放态切换时
 * 的等宽条动画重置（audioPlaying watcher）需要直接操作这些 DOM 节点的
 * style，那段是一次性的动画序列，不适合抽成响应式状态。
 */
defineProps<{
  visible: boolean
  style: Record<string, string | number>
  barsPlaying: boolean
  fileName: string
  pinned: boolean
  current: number
  duration: number
  seekPct: number
  playing: boolean
  muted: boolean
  volume: number
  fmtTime: (s: number) => string
  onStop: () => void
  onSeek: (e: MouseEvent) => void
  onStartDrag: (e: MouseEvent) => void
  onToggle: () => void
  onToggleMute: () => void
  onSetVolume: (e: Event) => void
}>()
const { t } = useI18n()

defineEmits<{ 'update:pinned': [value: boolean] }>()

const barsEl = ref<HTMLElement | null>(null)
defineExpose({ barsEl: computed(() => barsEl.value) })
</script>

<style scoped>
.mini-player {
  position: fixed; right: 28px; box-sizing: border-box; width: 360px;   /* border-box 外宽 360，与小窗/气泡严格对齐 */
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: var(--glass-card-background); backdrop-filter: var(--glass-card-blur); -webkit-backdrop-filter: var(--glass-card-blur);
  border: 1px solid var(--glass-card-border); border-radius: var(--card-radius);
  box-shadow: var(--glass-card-shadow); padding: 12px 14px 10px;
  display: flex; flex-direction: column; gap: 7px;   /* z-index 由 :style 动态(跟随聊天窗 ±1) */
}
.mp-info { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mp-name { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
.mp-bars { display: flex; align-items: flex-end; gap: 2px; height: 14px; flex-shrink: 0; }
.mp-bars i { display: block; width: 2.5px; border-radius: 99px; background: color-mix(in srgb, var(--action-primary) 58%, transparent); height: 4px; }
.mp-bars--playing i { animation: mp-eq 0.55s ease-in-out infinite alternate; }
.mp-bars--playing i:nth-child(1) { animation-duration: 0.55s; }
.mp-bars--playing i:nth-child(2) { animation-duration: 0.42s; animation-delay: 0.1s; }
.mp-bars--playing i:nth-child(3) { animation-duration: 0.65s; animation-delay: 0.05s; }
.mp-bars--playing i:nth-child(4) { animation-duration: 0.48s; animation-delay: 0.15s; }
@keyframes mp-eq { from { height: 3px; } to { height: 13px; } }
.mp-seek-row { display: flex; align-items: center; gap: 6px; }
.mp-time { font-size: 10px; color: var(--text-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.mp-track { flex: 1; height: 3px; border-radius: 99px; background: color-mix(in srgb, var(--action-primary) 14%, transparent); position: relative; cursor: pointer; }
.mp-track:hover .mp-thumb { opacity: 1; }
.mp-fill { height: 100%; border-radius: 99px; background: var(--action-primary); pointer-events: none; }
.mp-thumb { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 10px; height: 10px; border-radius: 50%; background: var(--action-primary); pointer-events: none; opacity: 0; transition: opacity 0.15s; }
.mp-btn--pin { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--pin svg { display: block; }
.mp-btn--pin:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-btn--pinned { color: var(--action-primary); }
.mp-btn--pinned:hover { background: var(--action-soft-hover); color: var(--action-primary-hover); }
.mp-btn--close { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--close:hover { background: color-mix(in srgb, var(--status-danger) 10%, transparent) !important; color: var(--status-danger) !important; }
.mp-controls { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; }
.mp-btn { border: none; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: transform 0.15s, background 0.12s; }
.mp-btn--play { width: 34px; height: 34px; border-radius: 50%; background: var(--action-primary); color: var(--content-on-accent); justify-self: center; box-shadow: var(--elevation-card); }
.mp-btn--play svg { display: block; }
.mp-btn--play:hover { transform: scale(1.08); }
.mp-btn--play:active { transform: scale(0.93); }
.mp-vol-group { display: flex; align-items: center; gap: 4px; justify-self: end; }
.mp-vol-btn { width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.12s, color 0.12s; }
.mp-vol-btn:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-vol-btn svg { display: block; }
.mp-vol-slider { width: 60px; height: 3px; cursor: pointer; accent-color: var(--action-primary); }
/* 时长/曲线跟 GuguChat.vue 的 .chat-open-enter-active/.chat-open-leave-active 严格对齐——
   播放器跟聊天窗口经常联动出现（比如小窗打开顶起播放器），用不同的时长/曲线会让两者
   一个先到位、一个还在动，看着不同步（2026-07-17 复现：播放器隐藏后再打开跟窗口动画对不上）。 */

.btn-group { display: flex; align-items: center; gap: 2px; }
.popup-close-btn {
  width: 26px; height: 26px; border-radius: 7px; border: none;
  background: none; color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: background 0.12s, color 0.12s;
}
.popup-close-btn svg { display: block; }
.popup-close-btn:hover { background: color-mix(in srgb, var(--status-danger) 10%, transparent) !important; color: var(--status-danger) !important; }

.mini-player-enter-active { transition: opacity 0.22s ease, transform 0.36s cubic-bezier(0.16, 1, 0.3, 1); }
.mini-player-leave-active { transition: opacity 0.18s ease-in, transform 0.22s cubic-bezier(0.7, 0, 0.84, 0); }
.mini-player-enter-from, .mini-player-leave-to { opacity: 0; transform: scale(0.05); }
</style>

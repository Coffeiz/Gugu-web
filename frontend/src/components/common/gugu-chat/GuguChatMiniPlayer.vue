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
            <Icon name="canvas.pin-off" v-else :size="14" />
          </button>
          <button class="mp-btn mp-btn--close popup-close-btn" @click="onStop" :title="t('common.actions.close')">
            <Icon name="action.close" :size="13" />
          </button>
        </div>
      </div>
      <div class="mp-seek-row">
        <span class="mp-time">{{ fmtTime(current) }}</span>
        <div class="mp-track" @mousedown="onStartDrag">
          <div class="mp-fill" :style="{ width: seekPct + '%' }" />
          <div class="mp-thumb" :style="{ left: seekPct + '%' }" />
        </div>
        <span class="mp-time">{{ fmtTime(duration) }}</span>
      </div>

      <div class="mp-controls">
        <div class="mp-start-controls">
          <button
            class="mp-btn mp-btn--playlist"
            :title="t('chatUi.playlist')"
            :aria-label="t('chatUi.playlist')"
            :aria-expanded="playlistExpanded"
            aria-controls="mini-player-playlist"
            @click="togglePlaylist"
          >
            <Icon name="action.list" :size="15" />
          </button>
          <button
            class="mp-btn mp-btn--mode"
            :class="{ 'mp-btn--mode-active': playbackMode !== 'none' }"
            :title="playbackModeTitle"
            :aria-label="playbackModeTitle"
            :aria-pressed="playbackMode !== 'none'"
            @click="onCyclePlaybackMode"
          >
            <span class="mp-mode-icon" :class="{ 'mp-mode-icon--none': playbackMode === 'none' }">
              <Icon :name="playbackModeIcon" :size="13" />
            </span>
          </button>
        </div>
        <div class="mp-transport">
          <button class="mp-btn mp-btn--icon mp-btn--track" :title="t('chatUi.previousTrack')" :aria-label="t('chatUi.previousTrack')" :disabled="playlist.length < 2" @click="onPrevious">
            <Icon name="action.back" :size="15" />
          </button>
          <button class="mp-btn mp-btn--transport" :title="playing ? t('chatUi.pauseAudio') : t('chatUi.playAudio')" :aria-label="playing ? t('chatUi.pauseAudio') : t('chatUi.playAudio')" @click="onToggle">
            <Icon name="media.play-fill" v-if="!playing" :size="16" />
            <Icon name="media.pause" v-else :size="16" />
          </button>
          <button class="mp-btn mp-btn--icon mp-btn--track" :title="t('chatUi.nextTrack')" :aria-label="t('chatUi.nextTrack')" :disabled="playlist.length < 2" @click="onNext">
            <Icon name="action.next" :size="15" />
          </button>
        </div>
        <div class="mp-vol-group">
          <button class="mp-vol-btn" @click="onToggleMute">
            <Icon name="media.speaker-high"  v-if="!muted && volume > 0.5" :size="14" />
            <Icon name="media.speaker-low"   v-else-if="!muted && volume > 0" :size="14" />
            <Icon name="media.speaker-off" v-else :size="14" />
          </button>
          <input class="mp-vol-slider" type="range" min="0" max="1" step="0.02" :value="volume" :style="{ '--volume-progress': `${volume * 100}%` }" @input="onSetVolume" />
        </div>
      </div>

      <Transition
        name="mp-playlist"
        @enter="measurePlaylistHeight"
        @before-leave="measurePlaylistHeight"
      >
        <div v-show="playlistExpanded" id="mini-player-playlist" class="mp-playlist">
          <div class="mp-playlist-header">
            <span>{{ t('chatUi.playlist') }}</span>
            <span>{{ playlist.length }}</span>
          </div>
          <div class="mp-playlist-items">
            <button
              v-for="track in playlist"
              :key="track.id"
              class="mp-playlist-item"
              :class="{ 'mp-playlist-item--current': track.id === currentTrackId }"
              :aria-current="track.id === currentTrackId ? 'true' : undefined"
              :title="trackName(track)"
              @click="onSelectTrack(track)"
            >
              <span class="mp-playlist-name">{{ trackName(track) }}</span>
              <span class="mp-playlist-duration">{{ track.duration ? fmtTime(track.duration) : '—' }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/icons/Icon.vue'
import type { AudioPlaybackMode, AudioTrack } from '@/stores/audio'
/**
 * 迷你播放器卡片：纯展示 + 交互转发。真正的 <audio> 元素和播放机制仍在
 * GuguChat.vue（useChatAudio 的 audioEl 需要在同一处声明模板 ref 才能绑定
 * 到真实 DOM），这里只是外壳。barsEl 通过 defineExpose 暴露——播放态切换时
 * 的等宽条动画重置（audioPlaying watcher）需要直接操作这些 DOM 节点的
 * style，那段是一次性的动画序列，不适合抽成响应式状态。
 */
const {
  visible,
  style,
  barsPlaying,
  fileName,
  playlist,
  currentTrackId,
  pinned,
  current,
  duration,
  seekPct,
  playing,
  muted,
  volume,
  playbackMode,
  fmtTime,
  onStop,
  onStartDrag,
  onToggle,
  onToggleMute,
  onSetVolume,
  onPrevious,
  onNext,
  onCyclePlaybackMode,
  onSelectTrack,
} = defineProps<{
  visible: boolean
  style: Record<string, string | number>
  barsPlaying: boolean
  fileName: string
  playlist: AudioTrack[]
  currentTrackId: number | null
  pinned: boolean
  current: number
  duration: number
  seekPct: number
  playing: boolean
  muted: boolean
  volume: number
  playbackMode: AudioPlaybackMode
  fmtTime: (s: number) => string
  onStop: () => void
  onStartDrag: (e: MouseEvent) => void
  onToggle: () => void
  onToggleMute: () => void
  onSetVolume: (e: Event) => void
  onPrevious: () => void
  onNext: () => void
  onCyclePlaybackMode: () => void
  onSelectTrack: (track: AudioTrack) => void
}>()
const { t } = useI18n()
const playbackModeTitle = computed(() => t('chatUi.playbackModeLabel', {
  mode: t(`chatUi.playbackMode.${playbackMode}`),
}))
const playbackModeIcon = computed(() => ({
  none: 'media.repeat',
  single: 'media.repeat-one',
  list: 'media.repeat',
  shuffle: 'media.shuffle',
}[playbackMode]))

const emit = defineEmits<{
  'update:pinned': [value: boolean]
  'load-playlist-durations': []
}>()

const playlistExpanded = ref(false)

function togglePlaylist() {
  playlistExpanded.value = !playlistExpanded.value
  if (playlistExpanded.value) emit('load-playlist-durations')
}

function measurePlaylistHeight(element: Element) {
  const panel = element as HTMLElement
  const previousMaxHeight = panel.style.maxHeight
  const previousBorderWidth = panel.style.borderWidth
  panel.style.maxHeight = 'none'
  panel.style.borderWidth = '1px'
  const height = panel.offsetHeight
  panel.style.maxHeight = previousMaxHeight
  panel.style.borderWidth = previousBorderWidth
  panel.style.setProperty('--mp-playlist-height', `${height}px`)
}

function trackName(track: AudioTrack) {
  return track.ext ? `${track.displayName ?? ''}.${track.ext.toLowerCase()}` : track.displayName ?? ''
}

const barsEl = ref<HTMLElement | null>(null)
defineExpose({ barsEl: computed(() => barsEl.value) })
</script>

<style scoped>
.mini-player {
  position: fixed; right: 28px; box-sizing: border-box; width: 360px;   /* border-box 外宽 360，与小窗/气泡严格对齐 */
  transition: bottom 0.28s cubic-bezier(0.34, 1.2, 0.64, 1);
  background: var(--glass-card-background); backdrop-filter: var(--glass-blur); -webkit-backdrop-filter: var(--glass-blur);
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
/* 视觉轨道保持 3px，透明命中区上下各扩 5px，不改变进度行布局。 */
.mp-track { flex: 1; height: var(--progress-track-height); border-radius: var(--progress-track-radius); background: var(--progress-track-bg); position: relative; cursor: pointer; }
.mp-track::before { content: ''; position: absolute; inset: -5px 0; border-radius: 99px; background: transparent; }
.mp-track:hover .mp-thumb { opacity: 1; }
.mp-fill { position: absolute; top: 0; height: 100%; border-radius: var(--progress-track-radius); background: var(--progress-fill-bg); pointer-events: none; }
.mp-thumb { position: absolute; top: 50%; transform: translate(-50%,-50%); width: 10px; height: 10px; border-radius: 50%; background: var(--action-primary); pointer-events: none; opacity: 0; transition: opacity 0.15s; }
.mp-btn--pin { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--pin svg { display: block; }
.mp-btn--pin:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-btn--pinned { color: var(--action-primary); }
.mp-btn--pinned:hover { background: var(--action-soft-hover); color: var(--action-primary-hover); }
.mp-btn--close { width: 24px; height: 24px; border-radius: 6px; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; background: none; color: var(--text-secondary); transition: background 0.12s, color 0.12s; }
.mp-btn--close:hover { background: color-mix(in srgb, var(--status-danger) 10%, transparent) !important; color: var(--status-danger) !important; }
.mp-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; min-height: 34px; gap: 4px; }
.mp-btn { border: none; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; transition: transform 0.15s, background 0.12s; }
.mp-start-controls { grid-column: 1; justify-self: start; display: flex; align-items: center; gap: 2px; }
.mp-btn--playlist, .mp-btn--mode { width: 30px; height: 30px; flex-shrink: 0; border-radius: 50%; background: none; color: var(--text-secondary); }
.mp-btn--playlist:hover, .mp-btn--mode:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-btn--mode-active { color: var(--action-primary); }
.mp-btn--mode-active:hover { background: var(--action-soft-hover); }
.mp-mode-icon { position: relative; display: inline-flex; }
.mp-mode-icon--none::after { content: ''; position: absolute; top: 6px; left: 1px; width: 11px; height: 1px; border-radius: 1px; background: currentColor; transform: rotate(-45deg); }
.mp-btn--icon { width: 30px; height: 30px; flex-shrink: 0; border-radius: 50%; background: color-mix(in srgb, var(--action-primary) 10%, transparent); color: var(--text-secondary); }
.mp-btn--icon:hover:not(:disabled) { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-btn--icon:disabled { opacity: 0.38; cursor: default; }
.mp-transport { grid-column: 2; display: flex; align-items: center; gap: 8px; }
.mp-btn--track { width: 30px; height: 30px; }
.mp-btn--transport { width: 34px; height: 34px; flex-shrink: 0; border-radius: 50%; background: var(--action-primary); color: var(--content-on-accent); box-shadow: var(--elevation-card); }
.mp-btn--transport svg { display: block; }
.mp-btn--transport:hover:not(:disabled) { transform: scale(1.08); }
.mp-btn--transport:active:not(:disabled) { transform: scale(0.93); }
.mp-btn--transport:disabled { opacity: 0.38; cursor: default; }
.mp-vol-group { grid-column: 3; justify-self: end; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.mp-vol-btn { width: 22px; height: 22px; border: none; border-radius: 6px; background: none; color: var(--text-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; transition: background 0.12s, color 0.12s; }
.mp-vol-btn:hover { background: var(--action-soft-hover); color: var(--action-primary); }
.mp-vol-btn svg { display: block; }
.mp-vol-slider { width: 60px; height: 3px; margin: 0; padding: 0; appearance: none; border: 0; border-radius: 99px; outline: none; cursor: pointer; background: linear-gradient(to right, var(--action-primary) 0 var(--volume-progress), color-mix(in srgb, var(--action-primary) 14%, transparent) var(--volume-progress) 100%); }
.mp-vol-slider::-webkit-slider-runnable-track { height: 3px; border: 0; border-radius: 99px; background: transparent; }
.mp-vol-slider::-webkit-slider-thumb { width: 10px; height: 10px; margin-top: -3.5px; appearance: none; border: 0; border-radius: 50%; background: var(--action-primary); }
.mp-vol-slider::-moz-range-track { height: 3px; border: 0; border-radius: 99px; background: transparent; }
.mp-vol-slider::-moz-range-thumb { width: 10px; height: 10px; border: 0; border-radius: 50%; background: var(--action-primary); }
.mp-playlist { box-sizing: border-box; overflow: hidden; border: 1px solid var(--glass-card-border); border-radius: 8px; background: color-mix(in srgb, var(--surface-card-solid) 72%, transparent); }
.mp-playlist-header { display: flex; justify-content: space-between; padding: 7px 9px 5px; color: var(--text-secondary); font-size: 10px; }
.mp-playlist-items { display: flex; flex-direction: column; gap: 1px; max-height: 154px; overflow-y: auto; padding: 0 4px 4px; }
.mp-playlist-item { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 6px 7px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); text-align: left; font: inherit; cursor: pointer; transition: background-color var(--hover-motion-control), color var(--hover-motion-control); }
.mp-playlist-item:hover { background: var(--action-soft-hover); color: var(--text-primary); }
.mp-playlist-item--current { background: var(--action-soft); color: var(--action-primary); }
.mp-playlist-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 1.45; }
.mp-playlist-duration { flex: 0 0 auto; color: var(--content-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
.mp-playlist-enter-active, .mp-playlist-leave-active { max-height: var(--mp-playlist-height, 0px); transition: max-height 0.2s ease, margin-top 0.2s ease, border-width 0.2s ease, opacity 0.16s ease; }
.mp-playlist-enter-from, .mp-playlist-leave-to { max-height: 0; margin-top: -7px; border-width: 0; opacity: 0; }
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

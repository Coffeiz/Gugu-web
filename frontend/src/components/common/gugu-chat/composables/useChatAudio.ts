import { ref, computed, watch } from 'vue'
import { useAudioStore } from '@/stores/audio'
import { getToken } from '@/services/api'
import { API_BASE } from '../chatConstants'
import type { ChatFile } from '../chatTypes'

/**
 * 迷你播放器（文件库音频）+ 消息语音条播放的唯一状态所有权：<audio> 元素、
 * 播放/进度/音量、跨曲目续播进度（localStorage）、语音 Object URL 缓存。
 *
 * 悬浮球的转圈/涟漪视觉反应（fabSvgRef 转场动画）仍留在 GuguChat.vue——那是
 * FAB 自己的展示逻辑，只是恰好由 audioPlaying 触发，不属于"播放器状态"本身。
 * audioStop() 因此拆成两半：这里做纯音频机制（暂停/清进度/通知 store），FAB
 * 转场动画通过 onBeforeStop 钩子在 audioStore.file 还没被清空前插入一次。
 */
export function useChatAudio(options: {
  onTip: (text: string) => void
  onBeforeStop?: () => void
}) {
  const audioStore = useAudioStore()

  const audioEl       = ref<HTMLAudioElement | null>(null)
  const audioPlaying  = ref(false)
  const audioCurrent  = ref(0)
  const audioDuration = ref(0)

  function progKey() { return audioStore.file ? `audio_prog_${audioStore.file.id}` : null }
  function saveProgress() {
    const key = progKey()
    if (!key || !audioEl.value?.duration) return
    const t = audioEl.value.currentTime, d = audioEl.value.duration
    if (t < d - 3) localStorage.setItem(key, String(t))
    else localStorage.removeItem(key)
  }
  function restoreProgress() {
    const key = progKey()
    if (!key || !audioEl.value) return
    const saved = localStorage.getItem(key)
    localStorage.removeItem(key)
    if (saved && +saved > 0) audioEl.value.currentTime = +saved
  }

  const needsRestore = ref(false)
  watch(() => audioStore.file?.id, () => { needsRestore.value = true })

  const audioSeekPct = computed(() =>
    audioDuration.value ? (audioCurrent.value / audioDuration.value) * 100 : 0
  )

  function onCanPlay() {
    if (!audioEl.value) return
    audioEl.value.volume = audioVolume.value
    if (needsRestore.value) { needsRestore.value = false; restoreProgress() }
    audioEl.value.play()
  }
  function onAudioPause() { audioPlaying.value = false }
  function onAudioEnded() {
    audioPlaying.value = false
    const key = progKey(); if (key) localStorage.removeItem(key)
  }
  function audioToggle() {
    if (!audioEl.value) return
    audioPlaying.value ? audioEl.value.pause() : audioEl.value.play()
  }
  function audioStop() {
    audioEl.value?.pause()
    options.onBeforeStop?.()   // FAB 转场动画：必须在 audioStore.file 清空前触发
    audioPlaying.value = false; audioCurrent.value = 0; audioDuration.value = 0
    audioStore.stop()
  }

  const VOL_KEY    = 'gugu_audio_volume'
  const audioVolume = ref(+(localStorage.getItem(VOL_KEY) ?? 0.5))
  const audioMuted  = ref(false)
  function audioSetVolume(e: Event) {
    audioVolume.value = +(e.target as HTMLInputElement).value
    localStorage.setItem(VOL_KEY, String(audioVolume.value))
    if (audioEl.value) { audioEl.value.volume = audioVolume.value; audioEl.value.muted = false }
    audioMuted.value = false
  }
  function audioToggleMute() {
    audioMuted.value = !audioMuted.value
    if (audioEl.value) audioEl.value.muted = audioMuted.value
  }
  function seekTo(clientX: number, rect: DOMRect) {
    if (!audioEl.value || !audioDuration.value) return
    audioEl.value.currentTime = ((clientX - rect.left) / rect.width) * audioDuration.value
  }
  function audioSeek(e: MouseEvent) {
    seekTo(e.clientX, (e.currentTarget as HTMLElement).getBoundingClientRect())
  }
  function audioStartDrag(e: MouseEvent) {
    // 拖拽期间用 window 级 mousemove/mouseup 跟手（鼠标移出进度条也要继续跟）；
    // 这两个事件的 currentTarget 是 window 本身，取不到进度条的 rect，必须在
    // mousedown 这一下先把 rect 量出来存住，move 阶段复用同一个 rect。
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    seekTo(e.clientX, rect)
    const move = (ev: MouseEvent) => seekTo(ev.clientX, rect)
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  function fmtTime(s: number) {
    if (!s || isNaN(s)) return '0:00'
    return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`
  }

  // ── 语音条播放：点击拉鉴权 blob（download 端点带 Bearer），单实例播放，再点暂停 ──
  const voicePlayingId = ref<string | null>(null)
  let _voiceAudio: HTMLAudioElement | null = null
  const _voiceUrls: Record<string, string> = {}            // attach_id → objectURL 缓存（同条重播不重拉）
  async function toggleVoice(f: ChatFile) {
    const id = f.attach_id
    if (!id) return
    if (voicePlayingId.value === id && _voiceAudio) { _voiceAudio.pause(); return }  // 再点＝暂停
    if (_voiceAudio) { _voiceAudio.pause(); _voiceAudio = null }                     // 切换：停掉上一条
    try {
      let url = _voiceUrls[id]
      if (!url) {
        const token = getToken()
        const res = await fetch(`${API_BASE}/agent/attachment/${id}/download`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        if (!res.ok) { options.onTip(res.status === 404 ? '这条语音过期啦（语音保留 30 天）🎤' : '语音加载失败了 😵'); return }
        url = URL.createObjectURL(await res.blob()); _voiceUrls[id] = url
      }
      const a = new Audio(url); _voiceAudio = a; voicePlayingId.value = id
      a.onended = a.onpause = () => { if (voicePlayingId.value === id) voicePlayingId.value = null }
      await a.play()
    } catch (e) { voicePlayingId.value = null; options.onTip('语音播放失败 🎤') }
  }

  return {
    audioEl, audioPlaying, audioCurrent, audioDuration, audioSeekPct,
    saveProgress, onCanPlay, onAudioPause, onAudioEnded, audioToggle, audioStop,
    audioVolume, audioMuted, audioSetVolume, audioToggleMute, audioSeek, audioStartDrag, fmtTime,
    voicePlayingId, toggleVoice,
  }
}

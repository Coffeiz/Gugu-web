import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { getAccountBoundaryEpoch } from '@/utils/accountBoundary'
import { filesApi } from '@/services/api'

const AUDIO_FILE_KEY = 'gugu_audio_file'
const AUDIO_PLAYBACK_MODE_KEY = 'gugu_audio_playback_mode'
const PLAYBACK_MODES = ['none', 'single', 'list', 'shuffle'] as const

export type AudioPlaybackMode = typeof PLAYBACK_MODES[number]

const bc = new BroadcastChannel('gugu_audio')

export interface AudioTrack {
  id?: number
  displayName?: string
  ext?: string
  folderId?: number | null
  projectId?: number | null
  space?: string
  workspaceDirectoryId?: number | null
  duration?: number
}

function isAudioTrack(file: AudioTrack): boolean {
  return ['MP3', 'WAV', 'OGG', 'FLAC', 'M4A', 'AAC', 'OPUS'].includes((file.ext ?? '').toUpperCase())
}

function sameDirectory(left: AudioTrack, right: AudioTrack): boolean {
  return left.space === right.space
    && (left.projectId ?? null) === (right.projectId ?? null)
    && (left.folderId ?? null) === (right.folderId ?? null)
    && (left.workspaceDirectoryId ?? null) === (right.workspaceDirectoryId ?? null)
}

export const useAudioStore = defineStore('audio', () => {
  const file    = ref<AudioTrack | null>(null)
  const playlist = ref<AudioTrack[]>([])
  const blobUrl = ref<string | null>(null)
  const loading = ref(false)
  const error   = ref<string | null>(null)
  const savedMode = localStorage.getItem(AUDIO_PLAYBACK_MODE_KEY)
  const playbackMode = ref<AudioPlaybackMode>(
    PLAYBACK_MODES.includes(savedMode as AudioPlaybackMode)
      ? savedMode as AudioPlaybackMode
      : 'none',
  )
  const durationLoads = new Map<string, Promise<void>>()

  // 持久化当前文件信息（blob URL 不可持久化，只存元数据）
  watch(file, (f) => {
    if (f) localStorage.setItem(AUDIO_FILE_KEY, JSON.stringify(f))
    else   localStorage.removeItem(AUDIO_FILE_KEY)
  })
  watch(playbackMode, mode => localStorage.setItem(AUDIO_PLAYBACK_MODE_KEY, mode))

  function revoke() {
    if (blobUrl.value?.startsWith('blob:')) URL.revokeObjectURL(blobUrl.value)
    blobUrl.value = null
  }

  // 其他 tab 开始播放时，停掉本 tab
  bc.onmessage = () => stop()

  function updateDuration(id: number, duration: number) {
    if (!Number.isFinite(duration) || duration <= 0) return
    playlist.value = playlist.value.map(track => track.id === id ? { ...track, duration } : track)
    if (file.value?.id === id) file.value = { ...file.value, duration }
  }

  function updatePlaylist(current: AudioTrack, siblings?: AudioTrack[]) {
    if (siblings) {
      const tracks = new Map<number, AudioTrack>()
      for (const sibling of siblings) {
        if (sibling.id != null && isAudioTrack(sibling)) tracks.set(sibling.id, sibling)
      }
      if (current.id != null && tracks.has(current.id)) {
        tracks.set(current.id, { ...tracks.get(current.id)!, ...current })
      } else if (current.id != null && isAudioTrack(current)) {
        tracks.set(current.id, current)
      }
      playlist.value = [...tracks.values()]
    } else if (!playlist.value.some(track => track.id === current.id)) {
      playlist.value = current.id != null && isAudioTrack(current) ? [current] : []
    }
  }

  async function play(f: AudioTrack, siblings?: AudioTrack[]) {
    updatePlaylist(f, siblings)
    if (f.id == null) return              // 没有文件 id 无法取流
    if (file.value?.id === f.id) return  // 同一首不重新加载
    bc.postMessage('playing')
    revoke()
    file.value    = f
    loading.value = true
    error.value   = null
    const requestEpoch = getAccountBoundaryEpoch()
    try {
      // 交给原生 audio 直接请求流地址，让浏览器自行使用 Range，避免把大文件
      // 一次性聚合成 Blob 后才开始播放。
      const { url } = await filesApi.getStreamUrl(f.id)
      if (requestEpoch !== getAccountBoundaryEpoch() || file.value?.id !== f.id) return
      blobUrl.value = url
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      loading.value = false
    }
  }

  // 刷新后恢复：从 localStorage 读文件信息并重新拉取 blob
  async function restore() {
    if (file.value) return
    try {
      const saved = JSON.parse(localStorage.getItem(AUDIO_FILE_KEY) ?? 'null')
      if (!saved?.id) return
      const requestEpoch = getAccountBoundaryEpoch()
      try {
        const files = await filesApi.list({
          space: saved.space ?? (saved.projectId != null ? 'project' : 'personal'),
          projectId: saved.projectId ?? undefined,
          folderId: saved.folderId ?? undefined,
          workspaceDirectoryId: saved.workspaceDirectoryId ?? undefined,
        })
        if (requestEpoch !== getAccountBoundaryEpoch()) return
        const current = files.find(candidate => candidate.id === saved.id) ?? saved
        const siblings = files.filter(candidate => isAudioTrack(candidate) && sameDirectory(candidate, current))
        await play(current, siblings)
      } catch {
        if (requestEpoch === getAccountBoundaryEpoch()) await play(saved)
      }
    } catch { /* 存储数据损坏则忽略 */ }
  }

  async function loadTrackDuration(track: AudioTrack): Promise<void> {
    if (track.id == null || track.duration) return
    const trackId = track.id
    if (playlist.value.find(candidate => candidate.id === trackId)?.duration) return
    if (!playlist.value.some(candidate => candidate.id === trackId)) return
    const requestEpoch = getAccountBoundaryEpoch()
    const requestKey = `${requestEpoch}:${trackId}`
    const existing = durationLoads.get(requestKey)
    if (existing) return existing

    const task = (async () => {
      let probe: HTMLAudioElement | null = null
      try {
        const { url } = await filesApi.getStreamUrl(trackId)
        if (!url || requestEpoch !== getAccountBoundaryEpoch() || !playlist.value.some(candidate => candidate.id === trackId)) return
        probe = new Audio()
        probe.preload = 'metadata'
        const duration = await new Promise<number>((resolve, reject) => {
          let timeout = 0
          const cleanup = () => {
            window.clearTimeout(timeout)
            probe?.removeEventListener('loadedmetadata', onLoaded)
            probe?.removeEventListener('error', onError)
          }
          const onLoaded = () => { cleanup(); resolve(probe?.duration ?? 0) }
          const onError = () => { cleanup(); reject(new Error('Audio metadata unavailable')) }
          timeout = window.setTimeout(() => { cleanup(); reject(new Error('Audio metadata timeout')) }, 15000)
          probe!.addEventListener('loadedmetadata', onLoaded, { once: true })
          probe!.addEventListener('error', onError, { once: true })
          probe!.src = url
          probe!.load()
        })
        if (requestEpoch === getAccountBoundaryEpoch() && playlist.value.some(candidate => candidate.id === trackId)) {
          updateDuration(trackId, duration)
        }
      } catch {
        // Track duration is optional metadata; a failed lookup must not interrupt playback.
      } finally {
        if (probe) {
          probe.removeAttribute('src')
          probe.load()
        }
      }
    })()

    durationLoads.set(requestKey, task)
    try { await task } finally { durationLoads.delete(requestKey) }
  }

  async function loadPlaylistDurations() {
    const pending = playlist.value.filter(track => track.id != null && !track.duration)
    // Limit concurrent metadata requests so opening a large directory does not fan out
    // an unbounded burst of signed-URL requests and media connections.
    let cursor = 0
    const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (cursor < pending.length) {
        const track = pending[cursor++]
        await loadTrackDuration(track)
      }
    })
    await Promise.all(workers)
  }

  function stepTrack(offset: number) {
    if (playlist.value.length < 2 || file.value?.id == null) return
    const index = playlist.value.findIndex(track => track.id === file.value?.id)
    if (index < 0) return
    const nextIndex = (index + offset + playlist.value.length) % playlist.value.length
    void play(playlist.value[nextIndex])
  }

  function playRandomTrack() {
    if (playlist.value.length < 2 || file.value?.id == null) return
    const candidates = playlist.value.filter(track => track.id !== file.value?.id)
    const next = candidates[Math.floor(Math.random() * candidates.length)]
    if (next) void play(next)
  }

  function cyclePlaybackMode(): AudioPlaybackMode {
    const currentIndex = PLAYBACK_MODES.indexOf(playbackMode.value)
    playbackMode.value = PLAYBACK_MODES[(currentIndex + 1) % PLAYBACK_MODES.length]
    return playbackMode.value
  }

  function previousTrack() { stepTrack(-1) }
  function nextTrack() {
    if (playbackMode.value === 'shuffle') playRandomTrack()
    else stepTrack(1)
  }

  function handleTrackEnded(): 'stop' | 'repeat' | 'next' {
    if (playbackMode.value === 'none') return 'stop'
    if (playbackMode.value === 'single' || playlist.value.length < 2) return 'repeat'
    nextTrack()
    return 'next'
  }

  function stop() {
    revoke()
    file.value    = null   // watch 会自动清除 localStorage
    playlist.value = []
    error.value   = null
    loading.value = false
  }

  return {
    file, playlist, blobUrl, loading, error, playbackMode,
    play, stop, restore, updateDuration, loadPlaylistDurations,
    previousTrack, nextTrack, cyclePlaybackMode, handleTrackEnded,
  }
})

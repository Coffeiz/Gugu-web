// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useAudioStore, type AudioTrack } from '@/stores/audio'
import { useChatAudio } from '@/components/common/gugu-chat/composables/useChatAudio'

vi.mock('@/services/api', () => ({
  filesApi: {
    all: vi.fn(async () => []),
    getStreamUrl: vi.fn(async (id: number) => ({ url: `/audio/${id}` })),
  },
  getToken: vi.fn(() => null),
}))

vi.mock('@/utils/accountBoundary', () => ({ getAccountBoundaryEpoch: () => 0 }))

const storage = new Map<string, string>()

function track(id: number): AudioTrack {
  return { id, displayName: `曲目 ${id}`, ext: 'mp3' }
}

describe('音频播放模式', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    })
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('按无循环、单曲、列表、随机的顺序切换并持久化模式', async () => {
    const audio = useAudioStore()

    expect(audio.playbackMode).toBe('none')
    for (const mode of ['single', 'list', 'shuffle', 'none'] as const) {
      expect(audio.cyclePlaybackMode()).toBe(mode)
      await nextTick()
      expect(storage.get('gugu_audio_playback_mode')).toBe(mode)
    }
  })

  it('曲目结束时无循环停止、单曲重播、列表顺序切到下一首', async () => {
    const audio = useAudioStore()
    const first = track(1)
    audio.file = first
    audio.playlist = [first, track(2)]

    expect(audio.handleTrackEnded()).toBe('stop')
    audio.playbackMode = 'single'
    expect(audio.handleTrackEnded()).toBe('repeat')
    audio.playbackMode = 'list'
    expect(audio.handleTrackEnded()).toBe('next')
    expect(audio.file?.id).toBe(2)
    await vi.waitFor(() => expect(audio.blobUrl).toBe('/audio/2'))
  })

  it('随机模式选择不同于当前曲目的随机项', () => {
    const audio = useAudioStore()
    audio.file = track(2)
    audio.playlist = [track(1), track(2), track(3)]
    audio.playbackMode = 'shuffle'
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect(audio.handleTrackEnded()).toBe('next')
    expect(audio.file?.id).toBe(1)
  })

  it('单曲循环在原生 audio ended 时从头继续播放', () => {
    const store = useAudioStore()
    store.file = track(1)
    store.playlist = [track(1)]
    store.playbackMode = 'single'
    const { audioEl, onAudioEnded } = useChatAudio({ onTip: vi.fn() })
    const element = {
      currentTime: 61,
      play: vi.fn(() => Promise.resolve()),
    } as unknown as HTMLAudioElement
    audioEl.value = element

    onAudioEnded()

    expect(element.currentTime).toBe(0)
    expect(element.play).toHaveBeenCalledOnce()
  })
})

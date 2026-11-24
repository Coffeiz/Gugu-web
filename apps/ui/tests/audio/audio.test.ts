// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useAudioStore, type AudioTrack } from '@/stores/audio'
import { useChatAudio } from '@/components/common/gugu-chat/composables/useChatAudio'

vi.mock('@/services/api', () => ({
  filesApi: {
    all: vi.fn(async () => []),
    location: vi.fn(async (filePath: string) => ({ pathFile: { directoryId: 'personal', relativePath: filePath.split('/').at(-1)! } })),
    getStreamUrl: vi.fn(async (filePath: string) => ({ url: `/audio/${encodeURIComponent(filePath)}` })),
  },
  pathFilesApi: {
    contentUrl: vi.fn((file: { relativePath: string }) => `/path/${file.relativePath}`),
    entries: vi.fn(async () => [
      { kind: 'file', name: '一.mp3', relativePath: '音乐/一.mp3' },
      { kind: 'file', name: '二.mp3', relativePath: '音乐/二.mp3' },
      { kind: 'file', name: '说明.txt', relativePath: '音乐/说明.txt' },
    ]),
  },
}))

vi.mock('@/utils/accountBoundary', () => ({ getAccountBoundaryEpoch: () => 0 }))

const storage = new Map<string, string>()

function track(filePath: string): AudioTrack {
  return { filePath, displayName: filePath.split('/').at(-1), ext: 'mp3' }
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
    const first = track('/personal/1.mp3')
    audio.file = first
    audio.playlist = [first, track('/personal/2.mp3')]

    expect(audio.handleTrackEnded()).toBe('stop')
    audio.playbackMode = 'single'
    expect(audio.handleTrackEnded()).toBe('repeat')
    audio.playbackMode = 'list'
    expect(audio.handleTrackEnded()).toBe('next')
    expect(audio.file?.filePath).toBe('/personal/2.mp3')
    await vi.waitFor(() => expect(audio.blobUrl).toBe('/audio/%2Fpersonal%2F2.mp3'))
  })

  it('随机模式选择不同于当前曲目的随机项', () => {
    const audio = useAudioStore()
    audio.file = track('/personal/2.mp3')
    audio.playlist = [track('/personal/1.mp3'), track('/personal/2.mp3'), track('/personal/3.mp3')]
    audio.playbackMode = 'shuffle'
    vi.spyOn(Math, 'random').mockReturnValue(0)

    expect(audio.handleTrackEnded()).toBe('next')
    expect(audio.file?.filePath).toBe('/personal/1.mp3')
  })

  it('路径音频刷新后从目录恢复播放列表并能切换曲目', async () => {
    storage.set('gugu_audio_file', JSON.stringify({ displayName: '一', ext: 'mp3', workspaceFile: { directoryId: 'personal', relativePath: '音乐/一.mp3' } }))
    const audio = useAudioStore()
    await audio.restore()
    expect(audio.blobUrl).toBe('/path/音乐/一.mp3')
    expect(audio.playlist.map(item => item.displayName)).toEqual(['一', '二'])
    audio.nextTrack()
    await vi.waitFor(() => expect(audio.blobUrl).toBe('/path/音乐/二.mp3'))
  })

  it('清理无法映射为路径的旧文件 ID，不再尝试兼容定位', async () => {
    storage.set('gugu_audio_file', JSON.stringify({ id: 17, displayName: '旧曲目', ext: 'mp3' }))
    const audio = useAudioStore()
    await audio.restore()
    expect(audio.file).toBeNull()
    expect(storage.has('gugu_audio_file')).toBe(false)
  })

  it('单曲循环在原生 audio ended 时从头继续播放', () => {
    const store = useAudioStore()
    store.file = track('/personal/1.mp3')
    store.playlist = [track('/personal/1.mp3')]
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

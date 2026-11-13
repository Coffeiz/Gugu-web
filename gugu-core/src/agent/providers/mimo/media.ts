export const MIMO_AUDIO_NATIVE_EXTS = Object.freeze(['mp3', 'wav', 'flac', 'm4a', 'ogg'])

export function mimoMediaCapabilities() {
  return { audio_native_exts: [...MIMO_AUDIO_NATIVE_EXTS], supports_audio: true, supports_video: true }
}

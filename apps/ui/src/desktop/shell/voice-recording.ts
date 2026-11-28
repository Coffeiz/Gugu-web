const sampleRate = 16_000

export async function encodeVoiceRecording(file: File): Promise<File> {
  const decoder = new OfflineAudioContext(1, 1, sampleRate)
  const audio = await decoder.decodeAudioData(await file.arrayBuffer())
  if (!audio.length || audio.duration > 65) throw new Error('录音长度无效')
  const wav = new ArrayBuffer(44 + audio.length * 2)
  const view = new DataView(wav)
  const tag = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  tag(0, 'RIFF')
  view.setUint32(4, wav.byteLength - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, audio.length * 2, true)

  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
  for (let index = 0; index < audio.length; index++) {
    const mono = channels.reduce((sum, channel) => sum + channel[index]!, 0) / channels.length
    const sample = Math.max(-1, Math.min(1, mono))
    view.setInt16(44 + index * 2, sample * (sample < 0 ? 32768 : 32767), true)
  }
  return new File([wav], file.name.replace(/\.[^.]+$/, '') + '.wav', { type: 'audio/wav' })
}

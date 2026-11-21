import { DesktopError } from '../core-host.js'
import { createDesktopVoiceTranscriber } from './auxiliary-model.js'

function readRecordingDuration(raw: Uint8Array): number | null {
  if (raw.length <= 44 || raw.length > 44 + 65 * 32_000 || raw.length % 2 !== 0) return null
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== raw.length - 8
    || bytes.toString('ascii', 8, 16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16
    || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) !== 16_000 || bytes.readUInt32LE(28) !== 32_000
    || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16
    || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== raw.length - 44) return null
  return (raw.length - 44) / 32_000
}

export function createDesktopRecordingTranscriber(
  directory: string,
  encryption: Parameters<typeof createDesktopVoiceTranscriber>[1],
  resolveProxy: Parameters<typeof createDesktopVoiceTranscriber>[3],
) {
  const transcribe = createDesktopVoiceTranscriber(directory, encryption, {
    toWav: async raw => readRecordingDuration(raw) === null ? null : raw,
    probeAudioDuration: async raw => readRecordingDuration(raw),
  }, resolveProxy)
  return async (raw: Uint8Array) => {
    const duration = readRecordingDuration(raw)
    if (duration === null) throw new DesktopError('invalid_request', '录音格式无效')
    const transcript = (await transcribe({ type: 'audio', raw, mime: 'audio/wav', ext: 'wav', duration },
      AbortSignal.timeout(22_000))).trim()
    if (!transcript) throw new DesktopError('invalid_request', '没有识别到语音，请重新录制')
    return { transcript: transcript.slice(0, 8_000), duration }
  }
}

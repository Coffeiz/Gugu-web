import type { DesktopImFile } from './inbox.js'

export type DesktopImVoice = {
  transcribe(input: { bytes: Uint8Array; mime: string; ext: string }, signal: AbortSignal,
    authorize: () => Promise<boolean>): Promise<string | null>
  report(error: unknown): void
}

/** 转写失败时仍保留原始语音，取消时终止当前收件。 */
export async function transcribeDesktopImFile(file: DesktopImFile, voice: DesktopImVoice | undefined,
  signal: AbortSignal, authorize: () => Promise<boolean>): Promise<DesktopImFile> {
  if (!voice || !file.voice) return file
  signal.throwIfAborted()
  try {
    const text = await voice.transcribe({ bytes: file.bytes, mime: file.mime, ext: file.ext }, signal, authorize)
    signal.throwIfAborted()
    const transcript = text?.trim().slice(0, 8_000)
    return transcript ? { ...file, transcript } : file
  } catch (error) {
    signal.throwIfAborted()
    voice.report(error)
    return file
  }
}

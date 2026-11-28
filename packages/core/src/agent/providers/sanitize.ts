/** 流中只等待可能成为标签的短尾部；隐藏思考区不能作为普通正文提前flush。 */
export class ThinkingTextFilter {
  #pending = ''
  #hidden = false
  feed(chunk: string): string {
    this.#pending += chunk
    let output = ''
    while (this.#pending) {
      const tag = this.#hidden ? '</think>' : '<think>'
      const value = this.#pending, index = value.indexOf(tag), closing = this.#hidden ? -1 : value.indexOf('</think>')
      if (closing >= 0 && (index < 0 || closing < index)) { output += value.slice(0, closing); this.#pending = value.slice(closing + 8); continue }
      if (index >= 0) {
        if (!this.#hidden) output += this.#pending.slice(0, index)
        this.#pending = this.#pending.slice(index + tag.length)
        this.#hidden = !this.#hidden
        continue
      }
      let tail = 0
      for (const candidate of this.#hidden ? [tag] : ['<think>', '</think>'])
        for (let size = 1; size < candidate.length && size <= value.length; size++) if (candidate.startsWith(value.slice(-size))) tail = Math.max(tail, size)
      const ready = this.#pending.slice(0, this.#pending.length - tail)
      if (!this.#hidden) output += ready
      this.#pending = tail ? this.#pending.slice(-tail) : ''
      break
    }
    return output
  }
  flush(): string {
    const value = this.#hidden ? '' : this.#pending; this.#pending = ''
    return value.length > 1 && ['<think>', '</think>'].some(tag => tag.startsWith(value)) ? '' : value
  }
}
export function stripThinking(text: string): string {
  let pending = text, hidden = false, output = ''
  while (pending) {
    const open = pending.indexOf('<think>'), close = pending.indexOf('</think>')
    if (hidden) { if (close < 0) break; pending = pending.slice(close + 8); hidden = false; continue }
    if (close >= 0 && (open < 0 || close < open)) { output += pending.slice(0, close); pending = pending.slice(close + 8) }
    else if (open >= 0) { output += pending.slice(0, open); pending = pending.slice(open + 7); hidden = true }
    else { output += pending; break }
  }
  return output
}

/** 厂商已确认的内部尾标记一旦出现即截断；普通厂商不会套用MiniMax规则。 */
export class ProviderStreamSanitizer {
  readonly #thinking = new ThinkingTextFilter()
  #pending = ''
  #cut = false
  constructor(readonly markers: readonly string[] = []) {}
  feed(chunk: string): string {
    if (this.#cut) return ''
    this.#pending += chunk
    const positions = this.markers.map(marker => this.#pending.indexOf(marker)).filter(index => index >= 0)
    if (positions.length) { const output = this.#pending.slice(0, Math.min(...positions)); this.#pending = ''; this.#cut = true; return this.#thinking.feed(output) }
    let hold = 0
    for (const marker of this.markers) for (let length = 1; length < marker.length && length <= this.#pending.length; length++)
      if (marker.startsWith(this.#pending.slice(-length))) hold = Math.max(hold, length)
    const output = this.#pending.slice(0, this.#pending.length - hold)
    this.#pending = hold ? this.#pending.slice(-hold) : ''
    return this.#thinking.feed(output)
  }
  flush(): string {
    if (this.#cut) return ''
    const output = this.#pending; this.#pending = ''
    return this.#thinking.feed(output) + this.#thinking.flush()
  }
}
export function sanitizeProviderText(text: string, markers: readonly string[]): string { const filter = new ProviderStreamSanitizer(markers); return filter.feed(text) + filter.flush() }

/** 为 Node 进程的控制台日志记录发生时间，供 Debug 日志读取。 */
export function timestampConsole(output: Console = console, now: () => Date = () => new Date()): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const write = output[level].bind(output)
    output[level] = (...args: unknown[]) => {
      const date = now()
      const pad = (value: number) => String(value).padStart(2, '0')
      const time = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
      if (typeof args[0] === 'string') write(`${time} ${args[0]}`, ...args.slice(1))
      else write(time, ...args)
    }
  }
}

import { spawn } from 'node:child_process';
/** 音频/视频共用的实际进程边界；关闭并排空stdio之后才释放调用者临时目录。 */
export async function runImMediaProcess(options) {
    const { signal } = options;
    if (signal.aborted)
        throw options.cancelled();
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        TMP: options.directory, TEMP: options.directory, TMPDIR: options.directory, LANG: 'C', LC_ALL: 'C', AV_LOG_FORCE_NOCOLOR: '1' };
    // 原生Node可选依赖沿Host启动时的可信模块搜索目录解析；不继承NODE_OPTIONS或其他运行配置。
    if (options.binary === process.execPath && process.env.NODE_PATH)
        env.NODE_PATH = process.env.NODE_PATH;
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(options.binary, options.args, { cwd: options.directory, env, windowsHide: true, stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false });
        }
        catch {
            resolve(null);
            return;
        }
        let failed = false, bytes = 0, stderr = 0;
        const chunks = [];
        const stop = () => { failed = true; try {
            child.kill('SIGKILL');
        }
        catch { /* 只通过close完成，不输出原始异常。 */ } };
        const timer = setTimeout(stop, options.timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        child.on('error', () => { failed = true; });
        child.stdout?.on('error', stop);
        child.stderr?.on('error', stop);
        child.stdout?.on('data', (value) => { bytes += value.length; if (bytes > options.maxOutputBytes)
            stop();
        else if (!failed)
            chunks.push(value); });
        child.stderr?.on('data', (value) => { stderr += value.length; if (stderr > 65_536)
            stop(); });
        child.once('close', code => {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
            if (signal.aborted)
                reject(options.cancelled());
            else
                resolve(!failed && code === 0 ? Buffer.concat(chunks, bytes) : null);
        });
        if (signal.aborted)
            stop();
        if (options.input) {
            child.stdin?.on('error', stop);
            child.stdin?.end(options.input);
        }
    });
}

import { Agent } from 'node:https';
import { resolvePinnedTarget } from '@gugu/core/providers/node';
/** 官方SDK只支持HTTPS Agent注入；每个Bot独立实例，不把会话ticket写入日志。 */
export function createFeishuWsNetwork(options) {
    if (options.allowDirect !== true)
        throw new Error('飞书长连接网络策略未配置');
    const targets = new Map();
    let closed = false;
    const lookup = (hostname, lookupOptions, callback) => {
        const target = targets.get(hostname.toLowerCase());
        if (closed || !target) {
            callback(new Error('飞书长连接目标未经校验'), '', 4);
            return;
        }
        if (lookupOptions.all)
            callback(null, [{ address: target.address, family: target.family }]);
        else
            callback(null, target.address, target.family);
    };
    const agent = new Agent({ lookup, keepAlive: false, maxSockets: 1, timeout: 30_000 });
    return {
        agent,
        async validateEndpoint(value, signal) {
            try {
                if (closed || /[\x00-\x20\x7f\\]/.test(value))
                    throw new Error();
                const url = new URL(value);
                if (url.protocol !== 'wss:' || url.hostname !== 'msg-frontier.feishu.cn' || url.port
                    || url.username || url.password || url.hash || url.pathname !== '/ws/v2')
                    throw new Error();
                url.protocol = 'https:';
                const pinned = await resolvePinnedTarget(url.href, { resolve: options.resolve, signal });
                if (closed)
                    throw new Error();
                targets.set(pinned.url.hostname, pinned.target);
            }
            catch {
                throw new Error('飞书长连接目标校验失败');
            }
        },
        async close() { if (closed)
            return; closed = true; targets.clear(); agent.destroy(); },
    };
}

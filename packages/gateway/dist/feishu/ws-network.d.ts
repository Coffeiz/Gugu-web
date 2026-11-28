import { Agent } from 'node:https';
import { type AddressResolver } from '@gugu/core/providers/node';
/** 官方SDK只支持HTTPS Agent注入；每个Bot独立实例，不把会话ticket写入日志。 */
export declare function createFeishuWsNetwork(options: {
    /** Host确认本连接采用直连；代理部署必须注入另一个经过验证的安全网络适配器。 */
    allowDirect: true;
    resolve?: AddressResolver;
}): {
    agent: Agent;
    validateEndpoint(value: string, signal: AbortSignal): Promise<void>;
    close(): Promise<void>;
};

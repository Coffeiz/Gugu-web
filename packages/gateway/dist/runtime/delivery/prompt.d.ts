/** 平台发送前重新核验权限，拒绝时由调用方选择对应的回执。 */
export declare function sendAuthorizedImPrompt<T>(authorize: () => Promise<boolean>, send: () => Promise<T>, rejected: T): Promise<T>;
/** 先登记投递，登记成功才发送；发送结算交由 Host 持久化。 */
export declare function deliverImPrompt<T>(ports: {
    reserve(): Promise<boolean>;
    authorize(): Promise<boolean>;
    send(): Promise<T>;
    settle(outcome: T): Promise<void>;
    rejected: T;
}): Promise<void>;
/** 原生卡片只投递可消费的单选动作，自定义回复沿用普通文本续接。 */
export declare function projectImChoiceButtons<T extends {
    kind?: unknown;
    selection_mode?: unknown;
    task_paused?: unknown;
    body?: string;
    resolved?: unknown;
    secret_fields?: readonly unknown[];
    options: {
        id: string;
        token: string;
    }[];
}>(prompt: T, includeTextHint?: boolean): T | null;

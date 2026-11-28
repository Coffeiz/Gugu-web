export type GroupDisabledNoticeStore = {
    claim(): Promise<(() => Promise<void>) | undefined>;
};
export declare const groupDisabledNoticeText = "\u8FD9\u4E2A\u673A\u5668\u4EBA\u8FD8\u672A\u5F00\u542F\u7FA4\u804A\uFF0C\u8BF7\u5728\u5495\u5495\u7684\u63A5\u5165\u8BBE\u7F6E\u91CC\u5F00\u542F\u3002";
/** 名额在发送前持久化。结果不确定时保留名额，避免重复出站。 */
export declare function notifyGroupDisabled(options: {
    mentioned: boolean;
    authorize(): Promise<boolean>;
    store: GroupDisabledNoticeStore;
    send(authorize: () => Promise<boolean>): Promise<'accepted' | 'rejected' | 'unknown'>;
}): Promise<void>;

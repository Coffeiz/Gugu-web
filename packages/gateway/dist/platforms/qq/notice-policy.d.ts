export type QqNoticeKind = 'reply' | 'tool' | 'compaction';
/** 原始消息 ID 由宿主按会话范围读取，工具回执必须走被动回复。 */
export declare function resolveQqNoticeTarget(kind: QqNoticeKind, originalMessageId?: string): {
    mode: "active";
    messageId?: undefined;
} | {
    mode: "rejected";
    messageId?: undefined;
} | {
    mode: "passive";
    messageId: string;
};

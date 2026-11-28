/** 群聊只回执发送状态，记忆正文只能投递给已经核验的所有者。 */
export declare function replyToImMemoryCommand(input: {
    chatType: 'group' | 'c2c';
    signal: AbortSignal;
    authorizeOwner(): Promise<boolean>;
    readMemory(): Promise<string>;
    sendOwnerPrivate?(text: string): Promise<boolean>;
}): Promise<string>;

export declare function handleTelegramBinding(text: string, consume: (code: string) => Promise<boolean>, reply: (text: string) => Promise<void>): Promise<void>;

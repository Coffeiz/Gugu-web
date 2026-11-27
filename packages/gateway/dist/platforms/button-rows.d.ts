/** 按标签的估算宽度顺序分行，中文、全角字符和 emoji 按两个单位计。 */
export declare function packButtonRows<Button>(buttons: readonly Button[], label: (button: Button) => string, maxPerRow: number): Button[][];

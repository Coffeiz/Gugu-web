/**
 * Gugu-web 对 Interaction Runtime 的唯一入口。
 *
 * 以 npm 依赖 `gugu-interaction-runtime` 引用已发布的 Runtime 构建产物。
 * Runtime 版本由 frontend/package.json 和 pnpm-lock.yaml 共同锁定。
 * 此文件只负责模块边界，不承担任何对象、指针或视觉生命周期编排。
 */
export * from 'gugu-interaction-runtime'

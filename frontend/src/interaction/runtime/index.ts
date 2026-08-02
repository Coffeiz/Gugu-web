/**
 * Gugu-web 对 Interaction Runtime 的唯一源码入口。
 *
 * 联调阶段直接引用同级仓库源码，避免 npm 构建产物、Vite 解析与实际运行版本漂移。
 * 当前联调基线：gugu-interaction-runtime @ 4f1f39f7df88e5c4ccd0094af792071b08768da1。
 * 更新 Runtime 时先同步修改该基线，并在 PR 中记录两侧 commit，避免源码漂移。
 * 此文件只负责模块边界，不承担任何对象、指针或视觉生命周期编排。
 */
export * from '../../../../../gugu-interaction-runtime/src/index'
export * from '../../../../../gugu-interaction-runtime/src/vue/useObject'
export * from '../../../../../gugu-interaction-runtime/src/vue/useSurface'
export * from '../../../../../gugu-interaction-runtime/src/vue/useRuntimeTransition'

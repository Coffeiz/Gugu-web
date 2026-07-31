/**
 * Gugu-web 对 Interaction Runtime 的唯一源码入口。
 *
 * 联调阶段直接引用同级仓库源码，避免 npm 构建产物、Vite 解析与实际运行版本漂移。
 * 此文件只负责模块边界，不承担任何对象、指针或视觉生命周期编排。
 */
export * from '../../../../../gugu-interaction-runtime/src/index'
export * from '../../../../../gugu-interaction-runtime/src/vue/useObject'
export * from '../../../../../gugu-interaction-runtime/src/vue/useSurface'
export * from '../../../../../gugu-interaction-runtime/src/vue/useRuntimeTransition'

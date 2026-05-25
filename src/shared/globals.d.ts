/**
 * 构建时由 esbuild / vite 通过 define 注入的开关。
 * 生产构建为 false,esbuild 会做死代码消除。
 */
declare const __DEV__: boolean;

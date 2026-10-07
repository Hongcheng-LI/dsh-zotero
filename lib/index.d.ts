import type { ZoteroConfig } from './types.js';
export declare const name = "tool-zotero";
export declare const inject: string[];
/** schemastery 配置 schema：加载器校验 config 并渲染设置表单（DSH 0.2.0-rc.x 插件规范）。 */
export { Config } from './config.js';
export declare function apply(ctx: any, config?: ZoteroConfig): void;

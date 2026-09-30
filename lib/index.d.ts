import type { ZoteroConfig } from './types.js';
export declare const name = "tool-zotero";
export declare const inject: string[];
export type Config = ZoteroConfig;
export declare function apply(ctx: any, config?: Config): void;

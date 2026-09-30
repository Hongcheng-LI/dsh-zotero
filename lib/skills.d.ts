/**
 * 把插件随包携带的 skill 注册进 DSH 的技能注册表（`ctx.skills`）。
 *
 * DSH 的技能注册表接受任意 provider，`dsh-skill-filesystem` 只是其中一种实现。
 * 插件包内的 `skills/` 不会被 `customSkillDirs` 自动扫描，因此这里按
 * `dsh-skill-office` 的方式自带一个 provider：目录 bundle 位于
 * `<包根>/skills/<name>/SKILL.md`，正文按需重新读取。
 *
 * 依赖以结构化方式访问，不 import `@deepseek-ai/dsh-skill`：该包只存在于
 * DSH 自身的安装位置，插件目录下不一定可解析；且服务缺失时必须静默降级，
 * 不能影响插件加载。
 */
/** 与 `@deepseek-ai/dsh-skill` 的 BUNDLED_SKILL_RANK 保持一致（随包技能根 rank 600） */
export declare const BUNDLED_SKILL_RANK = 600;
/** 随包 skill 名（kebab-case，须与 SKILL.md frontmatter 的 name 一致） */
export declare const BUNDLED_SKILL_NAME = "paper-reading";
/** 取 SKILL.md 的 YAML frontmatter；只解析本插件需要的 description */
export declare function parseSkillFrontmatter(raw: string): {
    description: string;
    content: string;
};
/**
 * 注册随包 skill。返回注册的 skill 名；注册表缺失或注册失败（例如同一层重复注册）
 * 时返回 null，绝不抛出——插件加载与工具注册不受影响。
 */
export declare function registerBundledSkill(ctx: unknown, options?: {
    skillDir?: string;
}): string | null;

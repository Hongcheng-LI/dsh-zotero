import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileUrlToPath } from './files.js';
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
export const BUNDLED_SKILL_RANK = 600;
/** 随包 skill 名（kebab-case，须与 SKILL.md frontmatter 的 name 一致） */
export const BUNDLED_SKILL_NAME = 'paper-reading';
/** provider 名，仅用于技能目录展示与本层去重 */
const PROVIDER_NAME = 'dsh-zotero';
/** 取 SKILL.md 的 YAML frontmatter；只解析本插件需要的 description */
export function parseSkillFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw);
    if (!match)
        return { description: '', content: raw.trim() };
    const descriptionLine = /^description:[ \t]*(.*)$/mu.exec(match[1]);
    const rawDescription = descriptionLine ? descriptionLine[1].trim() : '';
    return {
        description: rawDescription.replace(/^["']|["']$/g, ''),
        content: raw.slice(match[0].length).trim(),
    };
}
/**
 * 读取技能注册表。`ctx.get()` 是 cordis 提供的「无需 inject 声明」的服务访问；
 * `ctx.skills` 在未声明注入时可能抛错，故两条路径都做保护。
 */
function skillsRegistry(ctx) {
    const candidates = [];
    try {
        candidates.push(ctx.skills);
    }
    catch {
        /* 未注入 skills 时访问可能抛错 */
    }
    try {
        const get = ctx.get;
        if (typeof get === 'function')
            candidates.push(get.call(ctx, 'skills'));
    }
    catch {
        /* ignore */
    }
    for (const candidate of candidates) {
        const registry = candidate;
        if (registry && typeof registry.registerProvider === 'function') {
            return registry;
        }
    }
    return null;
}
/**
 * 注册随包 skill。返回注册的 skill 名；注册表缺失或注册失败（例如同一层重复注册）
 * 时返回 null，绝不抛出——插件加载与工具注册不受影响。
 */
export function registerBundledSkill(ctx, options = {}) {
    const registry = skillsRegistry(ctx);
    if (registry === null)
        return null;
    const skillDirectory = options.skillDir ??
        join(dirname(fileUrlToPath(import.meta.url)), '..', 'skills', BUNDLED_SKILL_NAME);
    if (!isAbsolute(skillDirectory))
        return null;
    const locator = join(skillDirectory, 'SKILL.md');
    let raw;
    try {
        raw = readFileSync(locator, 'utf8');
    }
    catch {
        ctxLogger(ctx)?.warn?.(`[dsh-zotero] 随包 skill 缺失，跳过注册：${locator}`);
        return null;
    }
    const { description } = parseSkillFrontmatter(raw);
    if (description === '') {
        ctxLogger(ctx)?.warn?.(`[dsh-zotero] 随包 skill 缺少 description，跳过注册：${locator}`);
        return null;
    }
    const candidate = {
        name: BUNDLED_SKILL_NAME,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        resourceBase: { kind: 'directory', path: skillDirectory },
        locator,
    };
    const provider = {
        name: PROVIDER_NAME,
        list: () => Promise.resolve([candidate]),
        async get(entry, requestOptions) {
            const { rank: _rank, locator: entryLocator, ...summary } = entry;
            const text = await readFile(entryLocator, { encoding: 'utf8', signal: requestOptions?.signal });
            return { ...summary, content: parseSkillFrontmatter(text).content };
        },
    };
    try {
        registry.registerProvider(() => provider);
        return BUNDLED_SKILL_NAME;
    }
    catch (error) {
        // 同一 cordis 层重复注册（例如 profile 与 preset 各插一行）会抛错：降级为不再注册。
        ctxLogger(ctx)?.warn?.(`[dsh-zotero] 随包 skill 注册跳过：${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
function ctxLogger(ctx) {
    try {
        return ctx.logger;
    }
    catch {
        return undefined;
    }
}

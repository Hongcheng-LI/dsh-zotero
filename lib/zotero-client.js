import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { basename } from 'node:path';
import { fileUrlToPath } from './files.js';
import { readStoredLocalAPIKey } from './storage.js';
import { noteToText } from './notes.js';
const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LIMIT = 50;
const DEFAULT_MAX_FULLTEXT_CHARS = 80000;
/** 授权弹窗需要人工点击，等待时间单独放宽到 2 分钟 */
const DEFAULT_AUTHORIZE_TIMEOUT_MS = 120000;
export function resolveConfig(config = {}) {
    const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const library = config.library && config.library.trim() !== '' ? config.library.trim() : 'user';
    if (library !== 'user' && !/^group:\d+$/.test(library)) {
        throw new Error('library 只能是 "user" 或 "group:<数字ID>"');
    }
    return {
        baseUrl,
        libraryPath: library === 'user' ? 'users/0' : `groups/${library.slice('group:'.length)}`,
        downloadDir: config.downloadDir && config.downloadDir.trim() !== '' ? config.downloadDir.trim() : undefined,
        maxAttachmentBytes: positiveInt(config.maxAttachmentBytes, DEFAULT_MAX_BYTES),
        maxLimit: positiveInt(config.maxLimit, DEFAULT_MAX_LIMIT),
        timeoutMs: positiveInt(config.timeoutMs, DEFAULT_TIMEOUT_MS),
        dataDir: config.dataDir && config.dataDir.trim() !== '' ? config.dataDir.trim() : undefined,
        storageDir: config.storageDir && config.storageDir.trim() !== '' ? config.storageDir.trim() : undefined,
        maxFulltextChars: positiveInt(config.maxFulltextChars, DEFAULT_MAX_FULLTEXT_CHARS),
        localApiKey: config.localApiKey && config.localApiKey.trim() !== '' ? config.localApiKey.trim() : undefined,
        authorizeTimeoutMs: positiveInt(config.authorizeTimeoutMs, DEFAULT_AUTHORIZE_TIMEOUT_MS),
    };
}
function positiveInt(value, fallback) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
/** 手工拼 query，空格用 %20（URLSearchParams 会编成 +，Zotero 本地端点不认） */
function qs(entries) {
    return entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
export class ZoteroError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
    }
}
export class ZoteroClient {
    cfg;
    serverId;
    apiKey;
    constructor(cfg) {
        this.cfg = cfg;
        this.apiKey = cfg.localApiKey;
    }
    /** 缓存每个响应头里的 Zotero-Server-ID（server_localAPI.js：每个响应都带）。 */
    cacheServerId(response) {
        const sid = response.headers.get('Zotero-Server-ID');
        if (sid)
            this.serverId = sid;
    }
    /**
     * 写请求前确保拿到 Server ID。GET 无需认证，一次轻量请求读响应头即可。
     * 不走 request() 以免递归；失败时返回 undefined，让写请求带出更明确的错误。
     */
    async ensureServerId() {
        if (this.serverId)
            return this.serverId;
        const url = `${this.cfg.baseUrl}/api/${this.cfg.libraryPath}/items?limit=1&format=json`;
        try {
            const response = await fetch(url, {
                headers: { 'Zotero-Allowed-Request': 'true' },
                signal: AbortSignal.timeout(this.cfg.timeoutMs),
            });
            this.cacheServerId(response);
            await response.body?.cancel().catch(() => { });
        }
        catch {
            // 连接探测失败时保持 undefined，写请求会给出更准确的错误
        }
        return this.serverId;
    }
    /** 解析写密钥：显式配置 > Zotero profile 中「始终允许」持久化的 key。 */
    writeKey() {
        if (this.apiKey)
            return this.apiKey;
        const stored = readStoredLocalAPIKey({ dataDir: this.cfg.dataDir });
        if (stored) {
            this.apiKey = stored;
            return stored;
        }
        return undefined;
    }
    async request(path, init = {}) {
        const url = `${this.cfg.baseUrl}/api/${this.cfg.libraryPath}${path}`;
        const method = (init.method ?? 'GET').toUpperCase();
        const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const headers = new Headers(init.headers);
        headers.set('Zotero-Allowed-Request', 'true');
        if (isWrite) {
            const sid = await this.ensureServerId();
            if (sid)
                headers.set('Zotero-Server-ID', sid);
            const key = this.writeKey();
            if (key)
                headers.set('Zotero-API-Key', key);
        }
        let response;
        try {
            response = await fetch(url, {
                ...init,
                headers,
                signal: AbortSignal.timeout(this.cfg.timeoutMs),
            });
        }
        catch (error) {
            throw new ZoteroError(`无法连接 Zotero 本地 API（${this.cfg.baseUrl}）。请确认 Zotero（7 及以上，含 9.x）已启动，且已在 设置 → 高级 → 通用 中勾选「允许本机上的其他应用程序与 Zotero 通信」。`, error);
        }
        this.cacheServerId(response);
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            if (response.status === 400 && body.includes('Endpoint does not support method')) {
                throw new ZoteroError('该端点不支持此 HTTP 方法（Endpoint does not support method）。请检查端点与动词是否匹配：/items 支持 GET/POST/DELETE，/items/<key> 支持 GET/PUT/PATCH/DELETE。');
            }
            if (response.status === 428) {
                // Server-ID 变化（Zotero 重启/换库）：丢弃缓存，下次写请求会重新取
                this.serverId = undefined;
                throw new ZoteroError(`写请求缺少或不匹配 Zotero-Server-ID（跨站写保护，428）。已清除缓存，请重试；若持续出现请重启 Zotero。${body ? ' 原文：' + body.slice(0, 200) : ''}`);
            }
            if (response.status === 412) {
                this.serverId = undefined;
                throw new ZoteroError(`Zotero-Server-ID 不匹配（412）。已清除缓存，请重试。${body ? ' 原文：' + body.slice(0, 200) : ''}`);
            }
            if (response.status === 401) {
                this.apiKey = undefined;
                throw new ZoteroError('本地 API 写密钥缺失或失效（401）。请在 Zotero 弹出的「本地 API 授权」窗口点「始终允许」，或用 zotero_authorize 工具重新授权；读取不受影响。' +
                    (body ? ' 原文：' + body.slice(0, 200) : ''));
            }
            const hint = response.status === 405 || response.status === 501 ? '（当前 Zotero 版本可能不支持该写操作）' : '';
            throw new ZoteroError(`Zotero API ${response.status} ${response.statusText}${hint}${body ? '：' + body.slice(0, 300) : ''}`);
        }
        return response;
    }
    /**
     * 触发 Zotero 桌面端的「本地 API 授权」弹窗，返回写密钥。
     * 端点 /api/local/authorize 不在 /api/<libraryPath> 下，故直接 fetch，不走 request()。
     * 用户点「始终允许」→ remember=true，key 由 Zotero 持久化到 <profile>/localAPIKeys.json；
     * 点「允许」→ 一次性 key，首次成功写入后即被消费，下次写会 401。
     */
    async authorize(appName = 'dsh-zotero') {
        const url = `${this.cfg.baseUrl}/api/local/authorize`;
        const headers = {
            'Zotero-Allowed-Request': 'true',
            'Content-Type': 'application/json',
        };
        const sid = await this.ensureServerId();
        if (sid)
            headers['Zotero-Server-ID'] = sid;
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ appName }),
                signal: AbortSignal.timeout(this.cfg.authorizeTimeoutMs),
            });
        }
        catch (error) {
            throw new ZoteroError(`请求 Zotero 本地 API 授权失败（${url}）。请确认 Zotero 已启动、本地 API 已启用，并在桌面端「本地 API 授权」弹窗中点击允许。`, error);
        }
        this.cacheServerId(response);
        const text = await response.text().catch(() => '');
        if (response.status === 429) {
            throw new ZoteroError(`授权请求过于频繁（429 Too many authorization requests）。请稍后重试。${text ? ' 原文：' + text.slice(0, 200) : ''}`);
        }
        if (!response.ok) {
            throw new ZoteroError(`Zotero 授权失败 ${response.status}：${text.slice(0, 300)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new ZoteroError(`Zotero 授权返回非 JSON：${text.slice(0, 300)}`);
        }
        if (parsed.denied === true) {
            throw new ZoteroError('用户在授权弹窗点了「拒绝」，未获得写密钥。');
        }
        if (!parsed.key || parsed.key === '') {
            throw new ZoteroError(`Zotero 授权响应里没有 key：${text.slice(0, 300)}`);
        }
        this.apiKey = parsed.key;
        return { key: parsed.key, remember: parsed.remember === true };
    }
    /**
     * 查询附件的本地文件地址。Zotero 本地 API 的 /file 端点返回 302，
     * Location 指向 file:///... （storage 内文件或链接附件的绝对路径），
     * 链接到网页的附件则是 http(s) 地址。不重定向（未来直接流式返回）时返回 null。
     * 用 node:http 手动请求：undici 的 fetch 会拒绝跟随非 HTTP(S) 的重定向。
     */
    async attachmentFilePath(attachmentKey) {
        const url = new URL(`${this.cfg.baseUrl}/api/${this.cfg.libraryPath}/items/${encodeURIComponent(attachmentKey)}/file`);
        return await new Promise((resolvePromise, reject) => {
            const req = httpRequest({
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: 'GET',
                headers: { 'Zotero-Allowed-Request': 'true' },
            }, (res) => {
                res.resume();
                const location = res.headers.location;
                resolvePromise(typeof location === 'string' && location !== '' ? location : null);
            });
            req.setTimeout(this.cfg.timeoutMs, () => {
                req.destroy(new ZoteroError(`获取附件路径超时（${this.cfg.baseUrl}）`));
            });
            req.on('error', (error) => {
                reject(error instanceof ZoteroError
                    ? error
                    : new ZoteroError(`无法连接 Zotero 本地 API（${this.cfg.baseUrl}）。请确认 Zotero（7 及以上，含 9.x）已启动，且已在 设置 → 高级 → 通用 中勾选「允许本机上的其他应用程序与 Zotero 通信」。`, error));
            });
            req.end();
        });
    }
    async getJson(path) {
        const response = await this.request(path, { headers: { Accept: 'application/json' } });
        return (await response.json());
    }
    /** 探测连接与库可用性，返回库内条目总数 */
    async ping() {
        const response = await this.request('/items?limit=1&format=json');
        const total = response.headers.get('Total-Results');
        await response.body?.cancel().catch(() => { });
        return total ? Number(total) : -1;
    }
    async search(args) {
        const params = [
            ['limit', String(args.limit)],
            ['format', 'json'],
        ];
        if (args.query && args.query.trim() !== '')
            params.push(['q', args.query.trim()]);
        if (args.itemType && args.itemType.trim() !== '')
            params.push(['itemType', args.itemType.trim()]);
        if (args.tag && args.tag.trim() !== '')
            params.push(['tag', args.tag.trim()]);
        if (args.sort && args.sort.trim() !== '')
            params.push(['sort', args.sort.trim()]);
        if (args.direction && args.direction.trim() !== '')
            params.push(['direction', args.direction.trim()]);
        if (args.start && args.start > 0)
            params.push(['start', String(args.start)]);
        // 用户没有显式检索附件/笔记/批注时，走 /items/top 顶层端点：本地 API 对否定
        // itemType 语法（"-attachment -note"）解析不可靠，只有顶层端点能给出正确的
        // Total-Results 与分页；显式要附件/笔记时才回到 /items
        const requestedTypes = (args.itemType ?? '').toLowerCase();
        const wantsChildren = requestedTypes.includes('attachment') || requestedTypes.includes('note') || requestedTypes.includes('annotation');
        const autoExclude = !wantsChildren;
        const top = autoExclude ? '/top' : '';
        const base = args.collection && args.collection.trim() !== ''
            ? `/collections/${encodeURIComponent(args.collection.trim())}/items${top}`
            : `/items${top}`;
        const response = await this.request(`${base}?${qs(params)}`, { headers: { Accept: 'application/json' } });
        const totalResults = Number(response.headers.get('Total-Results')) || undefined;
        const raw = (await response.json());
        // 双保险：服务端之外再过滤一次页面内的附件/笔记
        let items = raw
            .filter((row) => !autoExclude || (row.data?.itemType !== 'attachment' && row.data?.itemType !== 'note'))
            .map(slimItem);
        const since = args.sinceYear;
        const before = args.beforeYear;
        if (since !== undefined || before !== undefined) {
            items = items.filter((item) => {
                const year = extractYear(item.date);
                if (year === undefined)
                    return false;
                if (since !== undefined && year < since)
                    return false;
                if (before !== undefined && year > before)
                    return false;
                return true;
            });
        }
        return { items, totalResults };
    }
    /** 最近添加的条目（不含附件和笔记） */
    async recent(limit) {
        // 用 /items/top（顶层条目）而不是 /items + 否定 itemType：本地 API 对多词否定
        // 语法（如 "-attachment -note"）解析不可靠，会把附件混进结果和 Total-Results
        const params = qs([
            ['sort', 'dateAdded'],
            ['direction', 'desc'],
            ['limit', String(limit)],
            ['format', 'json'],
        ]);
        const raw = await this.getJson(`/items/top?${params}`);
        return {
            items: raw
                .filter((row) => row.data?.itemType !== 'attachment' && row.data?.itemType !== 'note')
                .map(slimItem),
        };
    }
    async item(key) {
        const raw = await this.getJson(`/items/${encodeURIComponent(key)}`);
        if (!raw?.data)
            throw new ZoteroError(`条目 ${key} 不存在`);
        const { attachments, notes } = await this.children(key);
        return { item: slimItem(raw), attachments, childNotes: notes.length };
    }
    async children(key) {
        // 不带 limit 时 Zotero 默认只回 25 条，子笔记/附件多的条目会被截断
        const raw = await this.getJson(`/items/${encodeURIComponent(key)}/children?${qs([['format', 'json'], ['limit', '100']])}`);
        const attachments = [];
        const notes = [];
        for (const child of raw) {
            const data = child.data ?? {};
            if (data.itemType === 'attachment') {
                attachments.push({
                    key: child.key,
                    itemType: String(data.itemType),
                    title: str(data.title),
                    contentType: str(data.contentType),
                    path: str(data.path),
                    filename: (str(data.path) ?? '').replace(/^storage:/, '').replace(/^attachments:/, '') || undefined,
                });
            }
            else if (data.itemType === 'note') {
                notes.push(this.toNote(child, key));
            }
        }
        return { attachments, notes };
    }
    toNote(raw, fallbackParent) {
        const data = raw.data ?? {};
        return {
            key: raw.key,
            parentKey: str(data.parentItem) ?? fallbackParent,
            text: noteToText(typeof data.note === 'string' ? data.note : ''),
            tags: Array.isArray(data.tags)
                ? data.tags.map((t) => t.tag ?? '').filter(Boolean)
                : undefined,
            dateAdded: str(data.dateAdded),
        };
    }
    /** 笔记检索：给了 itemKey 列其子笔记；否则全库按关键词搜笔记 */
    async listNotes(args) {
        if (args.itemKey && args.itemKey.trim() !== '') {
            const { notes } = await this.children(args.itemKey.trim());
            const keyword = args.query?.trim();
            const filtered = keyword ? notes.filter((n) => n.text.includes(keyword)) : notes;
            return filtered.slice(0, args.limit);
        }
        const params = [
            ['itemType', 'note'],
            ['format', 'json'],
            ['limit', String(args.limit)],
            ['sort', 'dateModified'],
            ['direction', 'desc'],
        ];
        if (args.query && args.query.trim() !== '')
            params.push(['q', args.query.trim()]);
        const raw = await this.getJson(`/items?${qs(params)}`);
        return raw.map((row) => this.toNote(row));
    }
    async addNote(parentKey, text, tags) {
        const created = await this.postItems([
            { itemType: 'note', parentItem: parentKey, note: text, tags: (tags ?? []).map((t) => ({ tag: t })) },
        ]);
        return created;
    }
    /**
     * 在指定 PDF 附件下创建一条高亮批注（annotation item）。
     * 字段与 Zotero 本地 API 的 annotation JSON 对齐（实测库内已有 2040 条同类条目）：
     * annotationPosition 是「转义后的 JSON 字符串」，pageIndex 从 0 起；
     * annotationPageLabel 是 PDF 内印刷页码。
     * annotationSortIndex 对 PDF 附件必须匹配 /^\d{5}\|\d{6}\|\d{5}$/
     * （Zotero chrome/content/zotero/xpcom/data/item.js:4547 的 PDF 分支校验），
     * 即「页序(5)|纵向(6)|横向(5)」三段。这里用首个 rect 的坐标派生后两段，
     * 只保证格式合法与阅读顺序大致合理，不精确复现 Zotero PDF reader 内部的坐标换算；
     * 不传 rects 时使用占位矩形，高亮在 reader 中的落点不精确。
     */
    async addHighlight(args) {
        const page = Number.isFinite(args.page) && args.page > 0 ? Math.floor(args.page) : 1;
        const pageIndex = page - 1;
        const rects = Array.isArray(args.rects) && args.rects.length > 0 ? args.rects : [[100, 100, 110, 110]];
        const firstRect = Array.isArray(rects[0]) ? rects[0] : [0, 0, 0, 0];
        const top = typeof firstRect[1] === 'number' && Number.isFinite(firstRect[1]) ? firstRect[1] : 0;
        const left = typeof firstRect[0] === 'number' && Number.isFinite(firstRect[0]) ? firstRect[0] : 0;
        const yPart = Math.min(999999, Math.max(0, Math.round(top * 10)));
        const xPart = Math.min(99999, Math.max(0, Math.round(left * 10)));
        const item = {
            itemType: 'annotation',
            parentItem: args.attachmentKey,
            annotationType: 'highlight',
            annotationText: args.text,
            annotationComment: args.comment ?? '',
            annotationColor: args.color ?? '#ffd400',
            annotationPageLabel: args.pageLabel ?? String(page),
            annotationSortIndex: `${String(pageIndex).padStart(5, '0')}|${String(yPart).padStart(6, '0')}|${String(xPart).padStart(5, '0')}`,
            annotationPosition: JSON.stringify({ pageIndex, rects }),
            tags: [],
        };
        return await this.postItems([item]);
    }
    /**
     * 修改已有 PDF 批注的批注评论。Zotero annotation 是普通 item，
     * 走 Item 端点的 PATCH，并带 If-Unmodified-Since-Version 做并发保护。
     */
    async updateAnnotationComment(annotationKey, comment) {
        const head = await this.getJson(`/items/${encodeURIComponent(annotationKey)}`);
        if (head?.data?.itemType !== 'annotation') {
            throw new ZoteroError(`${annotationKey} 不是 PDF 批注条目（用 zotero_annotations 获取批注 key）`);
        }
        if (typeof head.version !== 'number' || head.version < 0) {
            throw new ZoteroError(`无法获取批注 ${annotationKey} 的版本号`);
        }
        await this.request(`/items/${encodeURIComponent(annotationKey)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'If-Unmodified-Since-Version': String(head.version),
            },
            body: JSON.stringify({ itemType: 'annotation', annotationComment: comment }),
        });
    }
    /** 在现有笔记末尾追加内容 */
    async appendNote(noteKey, text) {
        const head = await this.noteHead(noteKey);
        const existing = typeof head.data.note === 'string' ? head.data.note.trim() : '';
        const merged = existing === '' ? text : `${existing}\n\n${text}`;
        await this.patchNote(noteKey, head.version, { note: merged });
    }
    /** 整体替换笔记正文（可顺带更新标签） */
    async updateNote(noteKey, text, tags) {
        const head = await this.noteHead(noteKey);
        const patch = { note: text };
        if (tags !== undefined)
            patch.tags = tags.map((t) => ({ tag: t }));
        await this.patchNote(noteKey, head.version, patch);
    }
    async deleteNote(noteKey) {
        const head = await this.noteHead(noteKey);
        await this.request(`/items/${encodeURIComponent(noteKey)}`, {
            method: 'DELETE',
            headers: { 'If-Unmodified-Since-Version': String(head.version) },
        });
    }
    async noteHead(noteKey) {
        const head = await this.getJson(`/items/${encodeURIComponent(noteKey)}`);
        if (head?.data?.itemType !== 'note')
            throw new ZoteroError(`${noteKey} 不是笔记条目（用 zotero_notes 获取笔记 key）`);
        if (typeof head.version !== 'number' || head.version < 0) {
            throw new ZoteroError(`无法获取笔记 ${noteKey} 的版本号`);
        }
        return head;
    }
    async patchNote(noteKey, version, patch) {
        const body = { itemType: 'note', ...patch };
        await this.request(`/items/${encodeURIComponent(noteKey)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'If-Unmodified-Since-Version': String(version ?? 0),
            },
            body: JSON.stringify(body),
        });
    }
    /** 批量创建条目（POST /items），返回第一个新条目的 key */
    async postItems(items) {
        const response = await this.request(`/items?${qs([['format', 'json']])}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items),
        });
        const created = (await response.json());
        const key = created?.success?.['0'];
        if (!key) {
            const failed = created?.failed ? JSON.stringify(created.failed).slice(0, 400) : '';
            throw new ZoteroError(`Zotero 未返回新条目的 key${failed ? '，失败详情：' + failed : ''}`);
        }
        return key;
    }
    async collections() {
        const raw = await this.getJson(`/collections?${qs([['format', 'json'], ['limit', '100']])}`);
        return raw.map((row) => ({
            key: row.key,
            name: str(row.data?.name) ?? '(未命名)',
            // Zotero 10 对顶层分类返回 parentCollection: false（false 表示顶层；嵌套时是父分类 key）
            parentCollection: str(row.data?.parentCollection) ?? false,
            numberOfItems: Number(row.meta?.numItems ?? row.meta?.numberOfItems) || 0,
        }));
    }
    async attachmentInfo(itemKey, attachmentKey) {
        const { attachments } = await this.children(itemKey);
        const found = attachments.find((a) => a.key === attachmentKey);
        if (!found) {
            throw new ZoteroError(`附件 ${attachmentKey} 不属于条目 ${itemKey}。请先用 zotero_item 查看该条目的附件列表。`);
        }
        return found;
    }
    /**
     * 单条目导出为引用格式（BibTeX/RIS/CSL JSON）。
     * 本地 API 对多 key 的 itemKey= 过滤会静默忽略（实测返回整库），因此
     * 批量导出必须逐 key 调用本方法后由调用方拼接。
     */
    async exportItem(key, format) {
        const response = await this.request(`/items/${encodeURIComponent(key)}?${qs([['format', format]])}`, {
            headers: { Accept: 'text/plain, application/json' },
        });
        const text = await response.text();
        if (text.trim() === '')
            throw new ZoteroError(`条目 ${key} 导出结果为空（format=${format}）`);
        return text;
    }
    /**
     * 读取条目附件上的 PDF 批注（高亮/笔记/图像等）。
     * 本地 API 不在 /items/{key}/children 里返回批注，必须按
     * itemType=annotation&parentItem=<附件key> 检索（实测有效）。
     */
    async annotations(itemKey, attachmentKey) {
        const { attachments } = await this.children(itemKey);
        const targets = attachmentKey
            ? attachments.filter((a) => a.key === attachmentKey)
            : attachments;
        if (targets.length === 0) {
            if (attachmentKey) {
                throw new ZoteroError(`附件 ${attachmentKey} 不属于条目 ${itemKey}。请先用 zotero_item 查看该条目的附件列表。`);
            }
            return [];
        }
        const out = [];
        for (const attachment of targets) {
            // 单页 limit=100 会被截断（实测有附件挂 100+ 条批注），用 start 翻页拉全；
            // 2000 条封顶防失控
            const rows = [];
            for (let start = 0; start < 2000; start += 100) {
                const page = await this.getJson(`/items?${qs([
                    ['itemType', 'annotation'],
                    ['parentItem', attachment.key],
                    ['format', 'json'],
                    ['limit', '100'],
                    ['start', String(start)],
                ])}`);
                rows.push(...page);
                if (page.length < 100)
                    break;
            }
            for (const row of rows) {
                const data = row.data ?? {};
                const position = parseAnnotationPosition(str(data.annotationPosition));
                out.push({
                    key: row.key,
                    parentKey: attachment.key,
                    attachmentFilename: attachment.filename ?? attachment.title,
                    annotationType: str(data.annotationType),
                    text: str(data.annotationText),
                    comment: str(data.annotationComment) ? noteToText(String(data.annotationComment)) : undefined,
                    page: position?.pageIndex !== undefined ? position.pageIndex + 1 : undefined,
                    pageLabel: str(data.annotationPageLabel),
                    color: str(data.annotationColor),
                    ...(position?.rects ? { rects: position.rects } : {}),
                    dateModified: str(data.dateModified),
                });
            }
        }
        // 排序：有页码的按页序在前，同页内按 Zotero 的 annotationSortIndex 字典序（即文档位置序）
        return out.sort((a, b) => (a.page ?? Number.MAX_SAFE_INTEGER) - (b.page ?? Number.MAX_SAFE_INTEGER));
    }
    /** 列出库内用户标签（按 Zotero 默认序） */
    async tags(limit) {
        const raw = await this.getJson(`/tags?${qs([
            ['format', 'json'],
            ['limit', String(limit)],
        ])}`);
        return raw.map((row) => String(row.tag ?? '')).filter((tag) => tag !== '');
    }
    /** 列出保存的智能搜索（key + 名称 + 条件摘要） */
    async savedSearches(limit) {
        const raw = await this.getJson(`/searches?${qs([
            ['format', 'json'],
            ['limit', String(limit)],
        ])}`);
        return raw.map((row) => {
            const data = row.data ?? {};
            const conditions = Array.isArray(data.conditions)
                ? data.conditions
                : [];
            const summary = conditions
                .slice(0, 3)
                .map((c) => `${String(c.condition ?? '?')} ${String(c.operator ?? '')} ${String(c.value ?? '')}`.trim())
                .join('; ');
            return {
                key: row.key,
                name: str(data.name) ?? '(未命名)',
                conditions: summary || undefined,
            };
        });
    }
    async downloadAttachment(attachmentKey) {
        const head = await this.getJson(`/items/${encodeURIComponent(attachmentKey)}`);
        const data = head?.data ?? {};
        const contentType = str(data.contentType) ?? 'application/octet-stream';
        const metaFilename = str(data.filename) ??
            (str(data.path) ?? '').replace(/^(storage|attachments):/, '') ??
            `${attachmentKey}.bin`;
        // 首选：302 Location 指向的本地文件，直接从磁盘读（零 HTTP 传输）
        const location = await this.attachmentFilePath(attachmentKey).catch(() => null);
        if (location?.startsWith('file:')) {
            const path = fileUrlToPath(location);
            const info = await stat(path).catch(() => null);
            if (info?.isFile()) {
                if (info.size > this.cfg.maxAttachmentBytes) {
                    throw new ZoteroError(`附件 ${basename(path)} 有 ${info.size} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`);
                }
                const bytes = new Uint8Array(await readFile(path));
                return { bytes, contentType, filename: basename(path) || metaFilename, path };
            }
        }
        // 次选：Location 指向 http(s)（链接到网页的附件），直接下载
        if (location?.startsWith('http')) {
            const response = await fetch(location, { signal: AbortSignal.timeout(this.cfg.timeoutMs) });
            if (!response.ok)
                throw new ZoteroError(`下载附件失败：HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > this.cfg.maxAttachmentBytes) {
                throw new ZoteroError(`附件有 ${bytes.byteLength} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`);
            }
            return { bytes, contentType, filename: metaFilename };
        }
        // 兜底：服务器未重定向、直接流式返回文件内容的场景
        try {
            const response = await this.request(`/items/${encodeURIComponent(attachmentKey)}/file`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > this.cfg.maxAttachmentBytes) {
                throw new ZoteroError(`附件有 ${bytes.byteLength} 字节，超过上限 ${this.cfg.maxAttachmentBytes} 字节（maxAttachmentBytes）。`);
            }
            if (bytes.byteLength > 0)
                return { bytes, contentType, filename: metaFilename };
        }
        catch (error) {
            // 大小超限等明确错误不能被兜底分支吞掉
            if (error instanceof ZoteroError)
                throw error;
        }
        throw new ZoteroError(`无法获取附件 ${metaFilename} 的内容：可能是链接型附件且目标文件不在本机，或文件尚未同步到本地。`);
    }
}
function str(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed !== '' ? trimmed : undefined;
}
/** annotationPosition 是 JSON 字符串，如 {"pageIndex":0,"rects":[[...]]}；解析失败返回 null */
function parseAnnotationPosition(raw) {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        const pageIndex = typeof parsed?.pageIndex === 'number' && parsed.pageIndex >= 0 ? parsed.pageIndex : undefined;
        const rects = Array.isArray(parsed?.rects)
            ? parsed.rects.filter((rect) => Array.isArray(rect) &&
                rect.length === 4 &&
                rect.every((value) => typeof value === 'number' && Number.isFinite(value)))
            : undefined;
        return { pageIndex, ...(rects && rects.length > 0 ? { rects } : {}) };
    }
    catch {
        return null;
    }
}
function extractYear(date) {
    if (!date)
        return undefined;
    const match = /\d{4}/.exec(date);
    return match ? Number(match[0]) : undefined;
}
/** 把 Zotero 原始条目压缩成模型友好的精简结构 */
export function slimItem(raw) {
    const data = raw.data ?? {};
    const creators = Array.isArray(data.creators)
        ? data.creators
            .map((c) => c.name ?? [c.lastName, c.firstName].filter(Boolean).join(', '))
            .filter(Boolean)
            .join('; ')
        : undefined;
    const tags = Array.isArray(data.tags)
        ? data.tags.map((t) => t.tag ?? '').filter(Boolean)
        : undefined;
    return {
        key: raw.key,
        itemType: str(data.itemType) ?? 'unknown',
        title: str(data.title) ?? str(data.name) ?? '(无标题)',
        creators: creators || undefined,
        date: str(data.date),
        publicationTitle: str(data.publicationTitle),
        volume: str(data.volume),
        issue: str(data.issue),
        pages: str(data.pages),
        publisher: str(data.publisher),
        DOI: str(data.DOI),
        ISBN: str(data.ISBN),
        url: str(data.url),
        abstractNote: str(data.abstractNote),
        tags: tags && tags.length > 0 ? tags : undefined,
        collections: Array.isArray(data.collections) ? data.collections : undefined,
        dateAdded: str(data.dateAdded),
    };
}
const MINIMAL_FIELDS = ['key', 'itemType', 'title', 'creators', 'date', 'publicationTitle', 'DOI'];
const PREVIEW_FIELDS = [...MINIMAL_FIELDS, 'url', 'tags'];
/** 按粒度裁剪检索结果：minimal 只留定位字段；preview 附 400 字截断摘要；full 不动 */
export function trimItems(items, mode) {
    if (mode === 'full')
        return items;
    const fields = mode === 'minimal' ? MINIMAL_FIELDS : PREVIEW_FIELDS;
    return items.map((item) => {
        const trimmed = { ...pick(item, fields) };
        if (mode === 'preview' && item.abstractNote) {
            trimmed.abstractNote =
                item.abstractNote.length > 400 ? item.abstractNote.slice(0, 400) + '…' : item.abstractNote;
        }
        return trimmed;
    });
}
function pick(source, keys) {
    const out = {};
    for (const key of keys) {
        if (source[key] !== undefined)
            out[key] = source[key];
    }
    return out;
}

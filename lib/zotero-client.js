import { readFile, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { basename } from 'node:path';
import { fileUrlToPath } from './files.js';
import { noteToText } from './notes.js';
const DEFAULT_BASE_URL = 'http://127.0.0.1:23119';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LIMIT = 50;
const DEFAULT_MAX_FULLTEXT_CHARS = 80000;
/** 子项类型：默认检索里必须剔除的条目（annotation 是 PDF 标注，挂在附件下） */
const SUBITEM_TYPES = new Set(['attachment', 'note', 'annotation']);
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
        writeEnabled: config.writeEnabled === true,
        apiKey: config.apiKey && config.apiKey.trim() !== '' ? config.apiKey.trim() : undefined,
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
/**
 * writeEnabled=false 时的统一提示，工具层与客户端层共用：
 * 写操作直接给出可操作路径，不发起任何请求，也不把原因归给「服务器只读」。
 */
export function writeDisabledError() {
    return new ZoteroError('写入未启用（writeEnabled 未设置为 true），不支持该写操作。如需让插件创建/修改/删除笔记：' +
        '在 cordis.patch.yml 的 dsh-zotero 配置里设置 writeEnabled: true；' +
        'Zotero 本地 API 还要求完成一次本地授权（POST /api/local/authorize，Zotero 会弹出授权对话框）取得 API key，' +
        '把密钥填入 apiKey。在完成授权之前，请在 Zotero 中手动操作（创建/修改笔记）；读取功能不受影响。');
}
export class ZoteroClient {
    cfg;
    constructor(cfg) {
        this.cfg = cfg;
    }
    /** 缓存的 Zotero-Server-ID（null 表示取不到），写请求需要它才能通过 412 检查 */
    serverIdCache;
    /** 从 GET /api/ 的响应头读取本实例的 Server-ID（Zotero 自己公开返回，无需授权） */
    async serverId() {
        if (this.serverIdCache === undefined) {
            try {
                const response = await fetch(`${this.cfg.baseUrl}/api/`, {
                    headers: { 'Zotero-Allowed-Request': 'true' },
                    signal: AbortSignal.timeout(this.cfg.timeoutMs),
                });
                const value = response.headers.get('Zotero-Server-ID')?.trim();
                this.serverIdCache = value ? value : null;
            }
            catch {
                this.serverIdCache = null;
            }
        }
        return this.serverIdCache ?? undefined;
    }
    async request(path, init = {}) {
        const url = `${this.cfg.baseUrl}/api/${this.cfg.libraryPath}${path}`;
        const method = (init.method ?? 'GET').toUpperCase();
        const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
        // writeEnabled=false：不发任何请求，直接给出可操作的提示（而不是把原因归给服务器）。
        if (isWrite && !this.cfg.writeEnabled) {
            throw writeDisabledError();
        }
        // 写请求带上身份：Server-ID 是 Zotero 公开的信息，缺失会被 428/412 拒绝；
        // API key 需用户完成本地授权后配置。
        const headers = {
            'Zotero-Allowed-Request': 'true',
            ...(init.headers ?? {}),
        };
        if (isWrite) {
            const serverId = await this.serverId();
            if (serverId !== undefined)
                headers['Zotero-Server-ID'] = serverId;
            if (this.cfg.apiKey !== undefined)
                headers['Zotero-API-Key'] = this.cfg.apiKey;
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
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            const writeBlocked = isWrite &&
                (response.status === 401 ||
                    response.status === 412 ||
                    (response.status === 428 && /Zotero-Server-ID not provided/i.test(body)) ||
                    (response.status === 400 && body.includes('Endpoint does not support method')) ||
                    response.status === 405 ||
                    response.status === 501);
            if (writeBlocked) {
                throw new ZoteroError(this.writeBlockedMessage(response.status, body));
            }
            const statusText = response.statusText?.trim();
            const statusLabel = statusText ? `${response.status} ${statusText}` : String(response.status);
            throw new ZoteroError(`Zotero API ${statusLabel}${body ? '：' + body.slice(0, 300) : ''}`);
        }
        return response;
    }
    /** 写入被拒时按 Zotero 的实际状态码给出可操作的归因，不再笼统归因于「服务器只读」 */
    writeBlockedMessage(status, body) {
        if (status === 401) {
            return ('写入需要 Zotero 授权，当前没有可用的 API key，不支持该写操作。' +
                '请在 Zotero 中完成一次本地 API 授权（POST /api/local/authorize，Zotero 会弹出授权对话框确认），' +
                '把取得的密钥填入配置项 apiKey（writeEnabled 需为 true）；或直接在 Zotero 中手动创建/修改笔记。' +
                `读取功能不受影响。${body ? `（Zotero 应答：${body.slice(0, 200)}）` : ''}`);
        }
        if (status === 412) {
            return ('Zotero 拒绝了写入：Zotero-Server-ID 与当前 Zotero 实例不匹配，不支持该写操作。' +
                `请确认 baseUrl（${this.cfg.baseUrl}）指向正在运行的 Zotero 实例；重启 Zotero 后重试，或直接在 Zotero 中手动操作。`);
        }
        if (status === 428) {
            return ('Zotero 拒绝了写入：未提供 Zotero-Server-ID，不支持该写操作。' +
                `插件未能从 ${this.cfg.baseUrl}/api/ 读取到 Server-ID（该头由 Zotero 公开返回），请确认 Zotero 版本与运行状态；` +
                '也可直接在 Zotero 中手动操作。');
        }
        return ('当前 Zotero 本地 API 未向外部客户端开放写入（该端点/方法不受支持），不支持该写操作：' +
            '笔记的创建/修改/删除不可用，请在 Zotero 中手动操作；读取功能不受影响。');
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
    async getJsonPage(path) {
        const response = await this.request(path, { headers: { Accept: 'application/json' } });
        const totalHeader = response.headers.get('Total-Results');
        const total = totalHeader === null ? undefined : Number(totalHeader);
        return {
            data: (await response.json()),
            ...(Number.isFinite(total) ? { totalResults: total } : {}),
        };
    }
    /** 只取 Total-Results（limit=1），用于按 itemType 数出各子类条目数 */
    async countRows(base, params) {
        try {
            const page = await this.getJsonPage(`${base}?${qs([...params, ['limit', '1']])}`);
            return page.totalResults;
        }
        catch {
            return undefined;
        }
    }
    /**
     * 默认检索里「真正可翻页的条目数」。
     *
     * Zotero 10.0.3 的 `itemType=-attachment` 会同时排除附件与标注（annotation），
     * 但**保留**笔记。实测全库 13169 = 顶层 4938 + 笔记 1541 + 附件 4662 + 标注 2028，
     * 而 `itemType=-attachment` 返回 6479 = 顶层 + 笔记。因此：
     * 既不能把服务器计数（6479）当成可见条目数，也不能用「全部 − 附件 − 笔记」（6966，多算了标注）。
     * 这里用四个 limit=1 的计数把口径算准，并为「服务器忽略负向参数」的未来情形兜底。
     */
    async visibleCount(base, commonParams, serverRows) {
        const withoutItemType = commonParams.filter(([key]) => key !== 'itemType');
        const [all, attachments, annotations, notes] = await Promise.all([
            this.countRows(base, withoutItemType),
            this.countRows(base, [...withoutItemType, ['itemType', 'attachment']]),
            this.countRows(base, [...withoutItemType, ['itemType', 'annotation']]),
            this.countRows(base, [...withoutItemType, ['itemType', 'note']]),
        ]);
        if (all === undefined || attachments === undefined || annotations === undefined || notes === undefined) {
            return undefined;
        }
        const subitems = attachments + annotations;
        const excludedByServer = all - serverRows;
        if (excludedByServer < subitems) {
            // 负向参数没生效：结果里仍含附件/标注，客户端会把它们连同笔记一起剔除
            return Math.max(0, serverRows - subitems - notes);
        }
        const leftover = excludedByServer - subitems;
        if (notes > 0 && leftover >= notes) {
            // 服务器把笔记也排除了：结果里只剩顶层条目
            return Math.max(0, serverRows);
        }
        // 常规情形：结果 = 顶层 + 笔记，客户端剔除笔记后即可翻页数
        return Math.max(0, serverRows - notes);
    }
    async ensureCollectionExists(key) {
        let raw;
        try {
            raw = await this.getJson(`/collections/${encodeURIComponent(key)}?format=json`);
        }
        catch (error) {
            throw new ZoteroError(`Zotero 分类 ${key} 不存在或无法访问。请先用 zotero_collections 获取有效 collectionKey。`, error);
        }
        if ((raw.key ?? '').toUpperCase() !== key.toUpperCase()) {
            throw new ZoteroError(`Zotero 分类 ${key} 不存在或返回异常。请先用 zotero_collections 获取有效 collectionKey。`);
        }
    }
    /** 探测连接与库可用性，返回库内条目总数 */
    async ping() {
        const response = await this.request('/items?limit=1&format=json');
        const total = response.headers.get('Total-Results');
        await response.body?.cancel().catch(() => { });
        return total ? Number(total) : -1;
    }
    async search(args) {
        const collectionKey = args.collection?.trim();
        if (collectionKey)
            await this.ensureCollectionExists(collectionKey);
        const explicitItemType = args.itemType?.trim();
        const excludeSubitems = !explicitItemType;
        const commonParams = [['format', 'json']];
        if (args.query && args.query.trim() !== '')
            commonParams.push(['q', args.query.trim()]);
        if (explicitItemType) {
            commonParams.push(['itemType', explicitItemType]);
        }
        else {
            // Zotero 10.0.3 本地 API 只可靠支持单个负向 itemType。
            // 先在服务端排除数量最多的 attachment，再在客户端排除 note；
            // 即使未来服务端忽略该参数，客户端过滤仍能保证结果中没有子项。
            commonParams.push(['itemType', '-attachment']);
        }
        if (args.tag && args.tag.trim() !== '')
            commonParams.push(['tag', args.tag.trim()]);
        if (args.sort && args.sort.trim() !== '')
            commonParams.push(['sort', args.sort.trim()]);
        if (args.direction && args.direction.trim() !== '')
            commonParams.push(['direction', args.direction.trim()]);
        const base = collectionKey ? `/collections/${encodeURIComponent(collectionKey)}/items` : '/items';
        const since = args.sinceYear;
        const before = args.beforeYear;
        const filteredOffset = Math.max(0, args.start ?? 0);
        const needsClientFiltering = excludeSubitems || since !== undefined || before !== undefined;
        // 显式 itemType 且没有年份过滤时，不需要客户端再筛，可直接交给 Zotero 分页。
        if (!needsClientFiltering) {
            const params = [
                ...commonParams,
                ['limit', String(args.limit)],
                ...(filteredOffset > 0 ? [['start', String(filteredOffset)]] : []),
            ];
            const page = await this.getJsonPage(`${base}?${qs(params)}`);
            const items = page.data.map(slimItem);
            // 调用方已显式限定 itemType：服务器计数就是该类型的可见数。
            return { items, totalResults: page.totalResults ?? items.length, totalResultsKind: 'server' };
        }
        // 默认检索要排除 attachment/note；年份也只能可靠地在客户端判定。
        // 因此连续取页，直到跳过过滤后的 offset 且收集够 limit。
        const pageSize = 100;
        const needed = filteredOffset + args.limit;
        const matched = [];
        let serverStart = 0;
        let totalResults;
        while (matched.length < needed) {
            const params = [
                ...commonParams,
                ['limit', String(pageSize)],
                ['start', String(serverStart)],
            ];
            const page = await this.getJsonPage(`${base}?${qs(params)}`);
            if (totalResults === undefined)
                totalResults = page.totalResults;
            if (page.data.length === 0)
                break;
            for (const row of page.data) {
                const item = slimItem(row);
                if (excludeSubitems && SUBITEM_TYPES.has(item.itemType))
                    continue;
                if (since !== undefined || before !== undefined) {
                    const year = extractYear(item.date);
                    if (year === undefined)
                        continue;
                    if (since !== undefined && year < since)
                        continue;
                    if (before !== undefined && year > before)
                        continue;
                }
                matched.push(item);
            }
            serverStart += page.data.length;
            if (page.totalResults !== undefined && serverStart >= page.totalResults)
                break;
            if (page.data.length < pageSize && page.totalResults === undefined)
                break;
        }
        // 客户端过滤后，服务器计数里仍含被剔除的子项，不能直接当成「共 N 条」。
        // 无年份过滤时可精确算出可见条目数；有年份过滤时只能标注口径。
        let visibleTotal;
        if (excludeSubitems && since === undefined && before === undefined) {
            visibleTotal = await this.visibleCount(base, commonParams, totalResults ?? serverStart);
        }
        return {
            items: matched.slice(filteredOffset, filteredOffset + args.limit),
            totalResults: visibleTotal ?? totalResults ?? serverStart,
            totalResultsKind: visibleTotal !== undefined ? 'visible' : 'server-approximate',
        };
    }
    /** 最近添加的顶层条目（不含附件和笔记） */
    async recent(limit) {
        const result = await this.search({
            limit,
            sort: 'dateAdded',
            direction: 'desc',
        });
        return { items: result.items };
    }
    async item(key) {
        const raw = await this.getJson(`/items/${encodeURIComponent(key)}`);
        if (!raw?.data)
            throw new ZoteroError(`条目 ${key} 不存在`);
        const { attachments, notes } = await this.children(key);
        return { item: slimItem(raw), attachments, childNotes: notes.length };
    }
    async children(key) {
        const attachments = [];
        const notes = [];
        const pageSize = 100;
        let start = 0;
        while (true) {
            const page = await this.getJsonPage(`/items/${encodeURIComponent(key)}/children?${qs([
                ['format', 'json'],
                ['limit', String(pageSize)],
                ['start', String(start)],
            ])}`);
            for (const child of page.data) {
                const data = child.data ?? {};
                if (data.itemType === 'attachment') {
                    const path = str(data.path);
                    const filename = path?.replace(/^storage:/, '').replace(/^attachments:/, '');
                    attachments.push(omitUndefined({
                        key: child.key,
                        itemType: String(data.itemType),
                        title: str(data.title),
                        contentType: str(data.contentType),
                        path,
                        filename: filename || undefined,
                    }));
                }
                else if (data.itemType === 'note') {
                    notes.push(this.toNote(child, key));
                }
            }
            start += page.data.length;
            if (page.data.length === 0)
                break;
            if (page.totalResults !== undefined && start >= page.totalResults)
                break;
            if (page.data.length < pageSize && page.totalResults === undefined)
                break;
        }
        return { attachments, notes };
    }
    toNote(raw, fallbackParent) {
        const data = raw.data ?? {};
        const tags = Array.isArray(data.tags)
            ? data.tags.map((t) => t.tag ?? '').filter(Boolean)
            : undefined;
        return omitUndefined({
            key: raw.key,
            parentKey: str(data.parentItem) ?? fallbackParent,
            text: noteToText(typeof data.note === 'string' ? data.note : ''),
            tags: tags && tags.length > 0 ? tags : undefined,
            dateAdded: str(data.dateAdded),
        });
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
    /** 写入前的统一门禁：writeEnabled=false 时在读版本号之前就拒绝，不发任何请求 */
    assertWriteEnabled() {
        if (!this.cfg.writeEnabled)
            throw writeDisabledError();
    }
    async addNote(parentKey, text, tags) {
        this.assertWriteEnabled();
        const created = await this.postNote([
            { itemType: 'note', parentItem: parentKey, note: text, tags: (tags ?? []).map((t) => ({ tag: t })) },
        ]);
        return created;
    }
    /** 在现有笔记末尾追加内容 */
    async appendNote(noteKey, text) {
        this.assertWriteEnabled();
        const head = await this.noteHead(noteKey);
        const existing = typeof head.data.note === 'string' ? head.data.note.trim() : '';
        const merged = existing === '' ? text : `${existing}\n\n${text}`;
        await this.patchNote(noteKey, head.version, { note: merged });
    }
    /** 整体替换笔记正文（可顺带更新标签） */
    async updateNote(noteKey, text, tags) {
        this.assertWriteEnabled();
        const head = await this.noteHead(noteKey);
        const patch = { note: text };
        if (tags !== undefined)
            patch.tags = tags.map((t) => ({ tag: t }));
        await this.patchNote(noteKey, head.version, patch);
    }
    async deleteNote(noteKey) {
        this.assertWriteEnabled();
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
    async postNote(items) {
        const response = await this.request(`/items?${qs([['format', 'json']])}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(items),
        });
        const created = (await response.json());
        const key = created?.success?.['0'];
        if (!key)
            throw new ZoteroError('Zotero 返回成功但未包含新笔记的 key');
        return key;
    }
    async collections() {
        const collections = [];
        const pageSize = 100;
        let start = 0;
        while (true) {
            const page = await this.getJsonPage(`/collections?${qs([
                ['format', 'json'],
                ['limit', String(pageSize)],
                ['start', String(start)],
            ])}`);
            for (const row of page.data) {
                const parent = str(row.data?.parentCollection);
                collections.push({
                    key: row.key,
                    name: str(row.data?.name) ?? '(未命名)',
                    parentCollection: parent ?? false,
                    numberOfItems: Number(row.meta?.numItems ?? row.meta?.numberOfItems) || 0,
                });
            }
            start += page.data.length;
            if (page.data.length === 0)
                break;
            if (page.totalResults !== undefined && start >= page.totalResults)
                break;
            if (page.data.length < pageSize && page.totalResults === undefined)
                break;
        }
        return collections;
    }
    async attachmentInfo(itemKey, attachmentKey) {
        const { attachments } = await this.children(itemKey);
        const found = attachments.find((a) => a.key === attachmentKey);
        if (!found) {
            throw new ZoteroError(`附件 ${attachmentKey} 不属于条目 ${itemKey}。请先用 zotero_item 查看该条目的附件列表。`);
        }
        return found;
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
function extractYear(date) {
    if (!date)
        return undefined;
    const match = /\d{4}/.exec(date);
    return match ? Number(match[0]) : undefined;
}
function omitUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
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
    return omitUndefined({
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
    });
}
const MINIMAL_FIELDS = ['key', 'itemType', 'title', 'creators', 'date', 'publicationTitle', 'DOI'];
const PREVIEW_FIELDS = [...MINIMAL_FIELDS, 'url', 'tags'];
/** 按粒度裁剪检索结果：minimal 只留定位字段；preview 附 400 字截断摘要；full 不动 */
export function trimItems(items, mode) {
    if (mode === 'full')
        return items.map((item) => omitUndefined({ ...item }));
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

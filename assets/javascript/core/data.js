// data.js —— 数据层：meta 清单（标题 + 内容指纹）→ 正文按 sha 缓存拉取 → 渲染 → 全文搜索。
// meta.json 由文章仓库的 GitHub Actions 在 push 时自动生成（模板见 articles-setup/），
// 走 raw 拉取，不占 REST API 配额（匿名 60 次/小时/IP）；API 仅作兜底，条件请求命中 304 同样免配额。
// 正文以 blob sha 为键存 Cache Storage：sha 相同即内容未变，命中零请求；无指纹的旧版
// 条目（v1/v2）直拉不缓存。meta 与正文均 no-cache：每次回源再验证，新鲜度无损，
// 未变内容以 304 收场而非全量重下。
// 加载分三段：loadManifest（清单全集）→ loadHashArticles（URL 引用篇，恢复现场）→
// loadAllArticles（其余后台流），逐篇经 onArticleSettled 通知进度。
// 数据源在 config.json 配置（复制 config.example.json 填写，不进 git）。

let REPO = null;
let BRANCH = null;
let API_URL = null;
let RAW_BASE = null;
let META_URL = null;

async function loadConfig() {
    if (REPO) return;
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.userMessage = '未配置文章仓库：请复制 config.example.json 为 config.json 并填写你的仓库';
        throw e;
    }
    const cfg = await res.json();
    REPO = cfg.repo;
    BRANCH = cfg.branch || 'main';
    API_URL = `https://api.github.com/repos/${REPO}/git/trees/${BRANCH}?recursive=1`;
    RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;
    META_URL = `${RAW_BASE}/meta.json`;
}

let markedLib = null; // 由 main 在关键路径注入
let hljsLib = null;   // 由 main 在后台注入，未就绪时高亮挂起

const hljsWaiters = new Set();

export function setMarked(lib) {
    markedLib = lib;
}

export function setHljs(lib) {
    hljsLib = lib;
    for (const fn of hljsWaiters) fn();
    hljsWaiters.clear();
}

// 代码高亮：hljs 未就绪则挂起到就绪后补（每容器至多一次）
export function highlightIn(container) {
    if (!hljsLib) {
        hljsWaiters.add(() => {
            container.querySelectorAll('pre code').forEach((el) => hljsLib.highlightElement(el));
        });
        return;
    }
    container.querySelectorAll('pre code').forEach((el) => hljsLib.highlightElement(el));
}

let articles = []; // { id, path, dir, file, title, sha, state: pending|loading|ready|failed, html, text, loadPromise }

export function getArticles() {
    return articles;
}

export function getMeta(id) {
    return articles.find((a) => a.id === id);
}

export function parseHash() {
    return location.hash.slice(1).split(',').filter(Boolean).map(decodeURIComponent);
}

// 第一个 # 标题行作为文章标题（不要求在第一行）；仅旧版清单（无 meta 标题）时用于正文补全
function extractTitle(md) {
    const m = md.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : '';
}

// 相对路径媒体重写为仓库 raw 绝对地址
function resolveMediaUrl(href, dir) {
    if (!href) return href;
    if (/^(https?:|data:|#|\/\/)/i.test(href)) return href;
    return dir ? `${RAW_BASE}/${dir}/${href}` : `${RAW_BASE}/${href}`;
}

// 自定义渲染器绕过了 marked 默认的转义，属性值需自行转义
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// 渲染单篇：marked 转 HTML，并把相对路径 src/href 指向文章所在目录
function render(md, dir) {
    const renderer = new markedLib.Renderer();
    renderer.image = (token) => {
        const src = escAttr(resolveMediaUrl(token.href, dir));
        const t = token.title ? ` title="${escAttr(token.title)}"` : '';
        const a = token.text ? ` alt="${escAttr(token.text)}"` : '';
        return `<img src="${src}"${a}${t}>`;
    };
    renderer.link = (token) => {
        const url = escAttr(resolveMediaUrl(token.href, dir));
        const t = token.title ? ` title="${escAttr(token.title)}"` : '';
        return `<a href="${url}"${t}>${token.text}</a>`;
    };
    return markedLib.parse(md, { renderer });
}

// 路径 → 文章条目（v1 清单与 API 兜底共用）：id = 顶层目录名，根目录文件退化为文件名
function entryFromPath(path) {
    const parts = path.split('/');
    const file = parts[parts.length - 1];
    const id = parts.length > 1 ? parts[0] : file.replace(/\.md$/i, '');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    return { id, path, dir, file, title: '', sha: null, state: 'pending' };
}

// 纯数字 id 按数值排序，否则按字符串排序
function sortEntries(list) {
    return list.sort((a, b) => {
        const na = parseInt(a.id, 10);
        const nb = parseInt(b.id, 10);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
        return a.id.localeCompare(b.id);
    });
}

// v2/v3 meta 条目：{ id, path, title?, sha? }，编号由 Actions 增量分配
function entryFromMeta(item) {
    const parts = item.path.split('/');
    const file = parts[parts.length - 1];
    return {
        id: String(item.id),
        path: item.path,
        dir: parts.slice(0, -1).join('/'),
        file,
        title: item.title || file.replace(/\.md$/i, ''),
        sha: item.sha || null,
        state: 'pending',
    };
}

// 首选：meta.json（文章仓库 push 时由 Actions 自动生成）
async function listArticles() {
    const res = await fetch(META_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    const items = meta.articles || [];
    // v2/v3：带编号条目；v1：纯路径数组，迁移期沿用目录名解析
    if (items.length && typeof items[0] === 'object') return items.map(entryFromMeta);
    return sortEntries(items.map(entryFromPath));
}

// 迁移期兜底：meta.json 缺失时回退 GitHub trees API（条件请求 304 不占配额），稳定后可删
async function listArticlesViaApi() {
    const res = await fetch(API_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const paths = (data.tree || [])
        .filter((item) => item.type === 'blob' && item.path.toLowerCase().endsWith('.md'))
        .map((item) => item.path);
    return sortEntries(paths.map(entryFromPath));
}

// ---- 正文缓存：键 = blob sha，sha 相同即内容相同，缓存条目对它的键不可能错 ----

const CACHE_NAME = 'strata-articles';
let articleCache = null;
let cacheTried = false;

async function openCache() {
    if (!cacheTried) {
        cacheTried = true;
        // 非安全上下文（纯 HTTP）无 Cache Storage，退化为直拉
        articleCache = 'caches' in window ? await caches.open(CACHE_NAME) : null;
    }
    return articleCache;
}

async function fetchMd(entry) {
    // 无指纹（v1/v2 清单）无键可依，直拉不缓存
    if (!entry.sha) {
        const res = await fetch(`${RAW_BASE}/${entry.path}`, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
    }
    const cache = await openCache();
    const req = new Request(`/body/${entry.sha}`);
    if (cache) {
        const hit = await cache.match(req);
        if (hit) return hit.text();
    }
    const res = await fetch(`${RAW_BASE}/${entry.path}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    // 竞态说明：若 meta 拉取与正文拉取之间恰有新 push，此处内容会比 meta 声称的 sha 更新，
    // 仍按 meta 的 sha 落键。后果仅是下次 meta 追上后未命中、冗余重拉一次；
    // 旧数据被当新数据服务需要"内容精确回滚到旧 sha"叠加同一竞态，此处不设防
    if (cache) cache.put(req, new Response(md));
    return md;
}

// ---- 逐篇加载：拉取 → 渲染 → 提取纯文本（一次 DOMParser 两用，高亮移交视图层） ----

async function loadBody(entry) {
    const md = await fetchMd(entry);
    const html = render(md, entry.dir);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    entry.html = doc.body.innerHTML;
    entry.text = (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
    if (!entry.sha) {
        const t = extractTitle(md); // 旧版清单：标题以正文为准
        if (t) entry.title = t;
    }
    entry.state = 'ready';
}

async function settle(entry) {
    if (!entry) return;
    if (entry.state !== 'pending') {
        await entry.loadPromise; // 并发调用同一篇时等待首个进行中的加载
        return;
    }
    entry.loadPromise = (async () => {
        entry.state = 'loading';
        try {
            await loadBody(entry);
        } catch (e) {
            entry.state = 'failed';
        }
        notifyProgress();
    })();
    await entry.loadPromise;
}

// 打开正文未就绪的文章时由视图层调用：就绪或已有终态后返回
export function ensureLoaded(entry) {
    return settle(entry);
}

// ---- 进度通知：注册即报当前值；成功与失败都计入 ----

const progressListeners = new Set();

export function onArticleSettled(fn) {
    progressListeners.add(fn);
    fn(doneCount(), articles.length);
    return () => progressListeners.delete(fn);
}

function doneCount() {
    return articles.filter((a) => a.state === 'ready' || a.state === 'failed').length;
}

function notifyProgress() {
    const done = doneCount();
    for (const fn of progressListeners) fn(done, articles.length);
}

// ---- 三段加载 ----

// 清单：文章全集（含标题），侧栏与搜索即可完整工作，不依赖任何正文
export async function loadManifest() {
    await loadConfig();
    let list;
    try {
        list = await listArticles();
    } catch (e) {
        list = await listArticlesViaApi();
    }
    articles = list;
    notifyProgress();
    return articles;
}

// 恢复：URL hash 引用的文章优先就绪（缓存命中时瞬时），reveal 后现场还原
export async function loadHashArticles(onProgress) {
    const ids = new Set(parseHash());
    const targets = articles.filter((a) => ids.has(a.id));
    if (onProgress) onProgress(0, targets.length);
    let done = 0;
    await Promise.all(targets.map(async (entry) => {
        await settle(entry);
        if (onProgress) onProgress(++done, targets.length);
    }));
}

// 后台流：其余全部文章，逐篇就绪逐篇通知，不阻塞任何界面
export function loadAllArticles() {
    for (const entry of articles) settle(entry);
}

// 全文搜索：id(10) / 标题(10) / 正文(2)。标题与 id 覆盖全集，正文仅覆盖已就绪篇
export function search(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];

    const hits = [];
    for (const a of articles) {
        let score = 0;
        let hit = null;

        if ((a.id || '').toLowerCase().includes(q)) {
            score += 10;
            hit = hit || 'id';
        }
        if ((a.title || '').toLowerCase().includes(q)) {
            score += 10;
            hit = hit || 'title';
        }
        if ((a.text || '').toLowerCase().includes(q)) {
            score += 2;
            hit = hit || 'body';
        }

        if (score > 0) hits.push({ article: a, score, hit });
    }

    return hits.sort((x, y) => y.score - x.score).slice(0, 5);
}

// main.js —— 应用引导：并行发散（渲染库 / 平台资源 / 文章清单）→ 汇聚初始化。
// marked 与平台资源、文章清单互不依赖，三路并发，总时延取最大而非求和；
// hljs 不在关键路径，后台加载、就绪后由视图层补高亮。
// 超时预算只守护骨架与清单；正文流不占预算，单篇失败不阻塞界面。

import * as data from './core/data.js';
import { createIntro } from './core/background.js';
import { initBranding } from './core/branding.js';
import { initRouter, startRouter } from './core/router.js';
import { detectPlatform } from './platform.js';

const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.esm.js';
const HLJS_URL = 'https://cdn.jsdelivr.net/npm/highlight.js@11.12.0/lib/common.js/+esm';
const TIMEOUT = 10000;

// 平台模块在 boot 中动态加载后赋值，revealUI 通过它触发淡入
let platform = null;

function revealUI() {
    platform?.reveal();
    startRouter();
    data.loadAllArticles(); // 揭示后正文后台流，侧栏计数渐进推进
}

function injectStyle(href) {
    return new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        // 样式加载失败也放行引导：视觉问题留给检查暴露，不让页面卡在动画
        link.onload = () => resolve();
        link.onerror = () => resolve();
        document.head.appendChild(link);
    });
}

function withTimeout(promise, ms) {
    // 输家也要善后：竞速结束后清理定时器，否则迟到的 timeout 拒绝
    // 会成为无人处理的 unhandledrejection
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// hljs 后台加载：成功即注入并补高亮；失败静默，文章仍可读只是无着色
function loadHljsInBackground() {
    import(HLJS_URL)
        .then((m) => data.setHljs(m.default))
        .catch(() => {});
}

async function boot() {
    // 尽早设置图标与标题，避免加载期间短暂显示默认「Strata」
    initBranding();

    const intro = createIntro({ onReady: revealUI, onRetry: boot });
    intro.begin();

    const platformName = detectPlatform();

    // 发散：骨架（渲染库 + 平台模块 + 平台样式）与文章清单并行
    const shellPromise = Promise.all([
        withTimeout(import(MARKED_URL), TIMEOUT),
        withTimeout(import(`./platforms/${platformName}/index.js`), TIMEOUT),
        injectStyle(`assets/css/${platformName}.css`),
    ]);
    const manifestPromise = withTimeout(data.loadManifest(), TIMEOUT);

    loadHljsInBackground();

    // 骨架检查点
    let marked;
    try {
        [marked, platform] = await shellPromise;
    } catch (e) {
        intro.fail('加载渲染依赖失败');
        return;
    }
    data.setMarked(marked);
    intro.shellReady();

    // 清单检查点：文章全集（含标题）就绪，侧栏即可完整渲染
    try {
        await manifestPromise;
    } catch (e) {
        intro.fail(e.userMessage || '从 GitHub 获取文章失败');
        return;
    }
    intro.manifestReady();

    platform.initComponents();
    initRouter();

    // 恢复检查点：URL hash 引用的文章就绪（缓存命中时瞬时），随后动画进入收尾并揭示
    await data.loadHashArticles((done, total) => intro.articleProgress(done, total));
    intro.restoreReady();
}

boot();

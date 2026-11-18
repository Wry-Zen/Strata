// article-view.js —— 文章窗口（桌面）：DOM 生命周期、抽屉式转场。
// 正文未就绪（后台流未到、抢点打开）时现场拉取，就绪或失败后回填。

import * as wm from '../../core/window-manager.js';
import * as data from '../../core/data.js';

let windowsRoot = null;
const domMap = new Map(); // id -> { el }
let prevArticleIds = [];

// 正文回填：就绪即渲染并高亮（hljs 未就绪时挂起，到岗后补）；未就绪现场拉取
function fillContent(content, meta) {
    if (!meta) {
        content.innerHTML = '<p class="article-hint">文章不存在</p>';
        return;
    }
    if (meta.state === 'ready') {
        content.innerHTML = meta.html;
        data.highlightIn(content);
        return;
    }
    content.innerHTML = '<p class="article-hint">加载中…</p>';
    data.ensureLoaded(meta).then(() => {
        // 窗口可能已关闭，此时写入的是游离节点，无害
        if (meta.state === 'ready') {
            content.innerHTML = meta.html;
            data.highlightIn(content);
        } else {
            content.innerHTML = '<p class="article-hint">文章加载失败</p>';
        }
    });
}

function createWindow(id, z) {
    const meta = data.getMeta(id);
    const el = document.createElement('div');
    el.className = 'article-window';
    el.style.zIndex = z;
    el.innerHTML = `
        <div class="article-window-body">
            <div class="article-content"></div>
        </div>
    `;

    fillContent(el.querySelector('.article-content'), meta);

    windowsRoot.appendChild(el);
    domMap.set(id, { el });

    // 强制首帧布局后展开，确保 translateY(100%)→0 的过渡被触发
    void el.getBoundingClientRect();
    el.classList.add('active');
    return el;
}

function closeWindow(id) {
    const rec = domMap.get(id);
    if (!rec) return;
    domMap.delete(id);
    const el = rec.el;
    el.classList.remove('active'); // 收到底部
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // 兜底：极端情况下 transition 不触发也确保移除
    setTimeout(() => el.remove(), 1000);
}

function onStackChange(stack) {
    const articleIds = stack.filter((w) => w.type === 'article').map((w) => w.id);
    const added = articleIds.filter((id) => !prevArticleIds.includes(id));
    const removed = prevArticleIds.filter((id) => !articleIds.includes(id));

    for (const id of added) {
        const w = stack.find((x) => x.id === id);
        createWindow(id, w.z);
    }
    for (const id of removed) {
        closeWindow(id);
    }

    // 仅当栈顶是文章时才展开它；栈顶是搜索框或空时，所有文章收到底部
    const top = stack.length ? stack[stack.length - 1] : null;
    const topId = top && top.type === 'article' ? top.id : null;
    for (const w of stack) {
        if (w.type !== 'article') continue;
        const rec = domMap.get(w.id);
        if (rec) {
            rec.el.style.zIndex = w.z;
            rec.el.classList.toggle('active', w.id === topId);
        }
    }

    prevArticleIds = articleIds;
}

export function initArticleView() {
    windowsRoot = document.createElement('div');
    windowsRoot.id = 'windows';
    document.body.appendChild(windowsRoot);
    wm.subscribe(onStackChange);
}

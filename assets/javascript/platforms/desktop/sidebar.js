// sidebar.js —— 侧边栏（桌面）：清单全集即刻渲染（标题来自 meta，不依赖正文），
// 正文后台流期间显示 n/N 计数，加载失败的篇目灰显缺位。

import * as data from '../../core/data.js';
import * as wm from '../../core/window-manager.js';

let listEl = null;
let countEl = null;

function render() {
    const articles = data.getArticles();
    listEl.innerHTML = '';

    if (!articles.length) {
        const empty = document.createElement('div');
        empty.className = 'sidebar-item empty';
        empty.textContent = '暂无文章';
        listEl.appendChild(empty);
        return;
    }

    for (const a of articles) {
        const item = document.createElement('div');
        item.className = 'sidebar-item' + (a.state === 'failed' ? ' failed' : '');
        item.dataset.id = a.id;
        item.textContent = `${a.id} ${a.title}`;
        item.addEventListener('click', () => wm.open(a.id));
        listEl.appendChild(item);
    }

    updateActive(wm.getStack());
}

function updateActive(stack) {
    const top = stack.length ? stack[stack.length - 1] : null;
    const activeId = top && top.type === 'article' ? top.id : null;
    for (const el of listEl.querySelectorAll('.sidebar-item')) {
        el.classList.toggle('active', el.dataset.id === activeId);
    }
}

export function initSidebar() {
    const root = document.createElement('div');
    root.id = 'sidebar';
    root.className = 'sidebar';
    root.innerHTML = `
        <div class="sidebar-content">
            <h3>文章列表<span class="cache-count"></span></h3>
            <div class="article-list"></div>
        </div>
        <div class="sidebar-collapsed-hint"><span>☰</span></div>
    `;
    document.body.appendChild(root);
    listEl = root.querySelector('.article-list');
    countEl = root.querySelector('.cache-count');
    render();
    wm.subscribe(updateActive);
    // 正文逐篇就绪：词条外观只在出现失败态时变化，其余仅更新计数
    data.onArticleSettled((done, total) => {
        if (data.getArticles().some((a) => a.state === 'failed')) render();
        countEl.textContent = total > 1 && done < total ? `${done}/${total}` : '';
    });
}

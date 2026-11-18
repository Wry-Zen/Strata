// background.js —— 背景层：加载动画与四面体背景共用同一个 canvas。
//
// 三段绘制（点、发散、封边）与三个检查点交错：
//   点 → 发散(随机检查点) → [硬等骨架：marked+平台+样式] → 发散到底(随机)
//      → 封边(随机检查点) → [硬等清单+恢复：meta 与 hash 引用篇] → 封边完成(随机)
//      → 升维 → 旋转
//
// 节拍原则——等待才表演：检查点已就绪的段快进（280–380ms），仍在等待的段
// 保持完整节奏（650–850ms）。快网用户看到的是同一支编舞的高速版；慢网用户
// 在 hold 段得到呼吸脉动与 n/N 进度，静止与卡死可分辨。
// 揭示（onReady）在封边合拢（link2）开始后留 0.32s 再触发：收尾动画与
// 组件入场不挤在同一帧。
// 失败路径保持红色静态；重试从失败姿态续位，已就绪的检查点直接冲刺。
//
// 几何衔接：正三角形 + 三条到中心的线，恰好是正四面体在正面视角下的投影。

const canvas = document.getElementById('background');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('loadStatus');

const cx = () => canvas.width / 2;
const cy = () => canvas.height / 2;

// ---------- 2D 几何 ----------
const R = 130; // 三角形外接圆半径（像素）
const ANGLES = [
    -Math.PI / 2,
    -Math.PI / 2 + (2 * Math.PI) / 3,
    -Math.PI / 2 + (4 * Math.PI) / 3,
];

// ---------- 3D 几何（正四面体，初始姿态 v3 朝向观察者） ----------
const R3 = (2 * Math.sqrt(2)) / 3;
const VERTICES_3D = [
    ...ANGLES.map((a) => ({ x: R3 * Math.cos(a), y: R3 * Math.sin(a), z: -1 / 3 })),
    { x: 0, y: 0, z: 1 },
];
const EDGES_3D = [
    [0, 1], [1, 2], [2, 0],
    [3, 0], [3, 1], [3, 2],
];

// 投影参数：让 2D 三角形的投影与 3D 底面的投影精确重合
const DISTANCE = 5;
const SCALE = (R * (DISTANCE + 1 / 3)) / (R3 * DISTANCE);

// ---------- 状态 ----------
let state = 'idle'; // idle | point | grow1 | hold1 | grow2 | link1 | hold2 | link2 | dimension | rotate | fail
let stateStart = 0;
let stateDur = 0;   // 当前段时长，进入段时按检查点就绪与否决定
let rafId = null;

let shellFlag = false;     // 骨架：marked + 平台模块 + 平台样式
let manifestFlag = false;  // 清单：meta 全集就绪
let restoreFlag = false;   // 恢复：URL hash 引用的文章就绪
let progress = { done: 0, total: 0 }; // 恢复篇进度（hold2 计数显示）
let revealed = false;      // onReady 只触发一次
let revealTimer = null;    // 揭示延迟定时器（重试时需清理）

let spokeT = 0; // 辐条（发散）进度 0..1
let linkT = 0;  // 三角形边（封边）进度 0..1
let colorT = 0; // 颜色 0=白 1=红（失败用）
let failSpoke0 = 0;
let failLink0 = 0;

// 各检查点的随机参数（begin 时重新随机）
let growTarget = 0.45;
let linkTarget = 0.45;

let onReady = null;
let onRetry = null;
let failEl = null;

// 3D 旋转量
let selfRotation = 0;
let axisAngleX = 0;
let axisAngleY = 0;
let axisAngleZ = 0;
const noiseOffset = [Math.random() * 70, Math.random() * 70, Math.random() * 70];

const now = () => performance.now();
const rand = (min, max) => min + Math.random() * (max - min);
// 节拍二值：等待中的段完整表演，已就绪的段快进
const slowDur = () => rand(650, 850);
const fastDur = () => rand(280, 380);
// 加载完成到组件揭示之间的留白
const REVEAL_DELAY = 320;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const noise = (x) => Math.sin(x) * 0.2 + 0.2;

function enter(stateName, dur) {
    state = stateName;
    stateStart = now();
    stateDur = dur;
}

// 冲刺：检查点在段中途打开时，剩余部分压缩为快进——快网不因慢节拍空等
function accelerate() {
    if (state === 'grow1' || state === 'link1') {
        const elapsed = now() - stateStart;
        stateDur = Math.min(stateDur, elapsed + fastDur());
    }
}

// 位图尺寸与 CSS 尺寸必须同源同步：CSS 端 inset:0 跟随布局视口，innerWidth/Height
// 在移动端随地址栏收展变化且 iOS 的 resize 事件不可靠（需 visualViewport 兜底），
// 两者一旦错位，位图被拉伸/截断，图形中心就会偏移
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
}

window.addEventListener('resize', resize);
window.visualViewport?.addEventListener('resize', resize);
resize();

function lineColor(alpha) {
    const g = Math.round(255 + (68 - 255) * colorT);
    const b = Math.round(255 + (68 - 255) * colorT);
    return `rgba(255, ${g}, ${b}, ${alpha})`;
}

// hold 段呼吸：等待期 ±10% 亮度脉动（~1.2s 周期），有活性但不冒充进度
function breathe() {
    if (state !== 'hold1' && state !== 'hold2') return 1;
    return 1 + 0.1 * Math.sin(((now() - stateStart) / 1200) * Math.PI * 2);
}

// 当前等待内容的文本；恢复篇多于一篇时给出 n/N 计数
function statusText() {
    switch (state) {
        case 'point':
            return '初始化';
        case 'grow1':
        case 'hold1':
        case 'grow2':
            return '加载资源';
        case 'link1':
            return '获取文章数据';
        case 'hold2':
            return progress.total > 1 ? `文章 ${progress.done}/${progress.total}` : '获取文章数据';
        default:
            return '';
    }
}

let lastStatus = '';
function updateStatus() {
    const s = statusText();
    if (s !== lastStatus) {
        lastStatus = s;
        statusEl.textContent = s;
        statusEl.classList.toggle('show', !!s);
    }
}

function draw2D() {
    const c = { x: cx(), y: cy() };
    const pts = ANGLES.map((a) => ({ x: c.x + R * Math.cos(a), y: c.y + R * Math.sin(a) }));
    ctx.lineWidth = 2;

    // 中心白点：point 阶段淡入，发散生长时缩小消失
    const dotR = 4 * Math.max(0, 1 - spokeT * 5);
    if (dotR > 0.01) {
        const alpha = state === 'point' ? Math.min(1, (now() - stateStart) / stateDur) : 1;
        ctx.fillStyle = lineColor(0.9 * alpha * breathe());
        ctx.beginPath();
        ctx.arc(c.x, c.y, dotR, 0, Math.PI * 2);
        ctx.fill();
    }

    // 辐条（中心 → 顶点）与三角形边（顶点 → 相邻顶点）同色，一次成路径
    ctx.strokeStyle = lineColor(0.9 * breathe());
    ctx.beginPath();
    for (let i = 0; i < 3; i++) {
        const p = pts[i];
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + (p.x - c.x) * spokeT, c.y + (p.y - c.y) * spokeT);
    }
    if (linkT > 0.001) {
        for (let i = 0; i < 3; i++) {
            const p = pts[i];
            const q = pts[(i + 1) % 3];
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + (q.x - p.x) * linkT, p.y + (q.y - p.y) * linkT);
        }
    }
    ctx.stroke();
}

function updateRotation() {
    selfRotation += 0.004;
    noiseOffset[0] += 0.0015;
    noiseOffset[1] += 0.0015;
    noiseOffset[2] += 0.0015;

    const targets = noiseOffset.map((o) => noise(o) * Math.PI * 2);
    axisAngleX += (targets[0] - axisAngleX) * 0.01;
    axisAngleY += (targets[1] - axisAngleY) * 0.01;
    axisAngleZ += (targets[2] - axisAngleZ) * 0.01;
}

function rotateVertex(v) {
    const cosA = Math.cos(selfRotation);
    const sinA = Math.sin(selfRotation);
    const cosX = Math.cos(axisAngleX);
    const sinX = Math.sin(axisAngleX);
    const cosY = Math.cos(axisAngleY);
    const sinY = Math.sin(axisAngleY);
    const cosZ = Math.cos(axisAngleZ);
    const sinZ = Math.sin(axisAngleZ);

    // 自转（绕 X 轴）
    const x = v.x;
    const y = v.y * cosA - v.z * sinA;
    const z = v.y * sinA + v.z * cosA;
    // 绕 X 轴
    const y2 = y * cosX - z * sinX;
    const z2 = y * sinX + z * cosX;
    // 绕 Y 轴
    const x3 = x * cosY - z2 * sinY;
    const z3 = x * sinY + z2 * cosY;
    // 绕 Z 轴
    return {
        x: x3 * cosZ - y2 * sinZ,
        y: x3 * sinZ + y2 * cosZ,
        z: z3,
    };
}

function draw3D() {
    const c = { x: cx(), y: cy() };
    const pts = VERTICES_3D.map((v) => {
        const r = rotateVertex(v);
        const factor = DISTANCE / (DISTANCE - r.z);
        return { x: r.x * factor * SCALE + c.x, y: r.y * factor * SCALE + c.y };
    });

    ctx.strokeStyle = lineColor(0.7);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [i, j] of EDGES_3D) {
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();
}

function tick() {
    const t = (now() - stateStart) / 1000;

    switch (state) {
        case 'point':
            if (t >= stateDur / 1000) {
                enter('grow1', shellFlag ? fastDur() : slowDur());
            }
            break;

        case 'grow1': {
            const p = Math.min(1, t / (stateDur / 1000));
            spokeT = growTarget * easeOut(p);
            if (p >= 1) {
                spokeT = growTarget;
                enter('hold1', 0);
            }
            break;
        }

        case 'hold1':
            if (shellFlag) {
                enter('grow2', fastDur());
            }
            break;

        case 'grow2': {
            const p = Math.min(1, t / (stateDur / 1000));
            spokeT = growTarget + (1 - growTarget) * easeOut(p);
            if (p >= 1) {
                spokeT = 1;
                // 封边节拍看清单与恢复：两者已就绪则快进（快网路径全程 ~1.5s）
                enter('link1', manifestFlag && restoreFlag ? fastDur() : slowDur());
            }
            break;
        }

        case 'link1': {
            const p = Math.min(1, t / (stateDur / 1000));
            linkT = linkTarget * easeOut(p);
            if (p >= 1) {
                linkT = linkTarget;
                enter('hold2', 0);
            }
            break;
        }

        case 'hold2':
            if (manifestFlag && restoreFlag) {
                enter('link2', fastDur());
            }
            break;

        case 'link2': {
            // 揭示与收尾重叠：封边合拢后留一拍再触发界面入场
            if (!revealed) {
                revealed = true;
                revealTimer = setTimeout(() => {
                    if (onReady) onReady();
                }, REVEAL_DELAY);
            }
            const p = Math.min(1, t / (stateDur / 1000));
            linkT = linkTarget + (1 - linkTarget) * easeOut(p);
            if (p >= 1) {
                linkT = 1;
                enter('dimension', rand(520, 720));
            }
            break;
        }

        case 'dimension':
            if (t >= stateDur / 1000) {
                enter('rotate', 0);
            }
            break;

        case 'rotate':
            updateRotation();
            break;

        case 'fail': {
            const e = easeOut(Math.min(1, t / 0.2));
            spokeT = failSpoke0 + (1 - failSpoke0) * e;
            linkT = failLink0 + (1 - failLink0) * e;
            colorT = e;
            break;
        }
    }

    updateStatus();

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (state === 'rotate') draw3D();
    else draw2D();

    rafId = requestAnimationFrame(tick);
}

function showFailScreen(msg) {
    if (failEl) return;
    failEl = document.createElement('div');
    failEl.className = 'fail-screen';
    failEl.innerHTML = `${msg}<div class="fail-hint">点击重试</div>`;
    failEl.addEventListener('click', () => onRetry && onRetry());
    document.body.appendChild(failEl);
    requestAnimationFrame(() => failEl.classList.add('show'));
}

function reset() {
    if (rafId) cancelAnimationFrame(rafId);
    if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = null;
    }
    if (failEl) {
        failEl.remove();
        failEl = null;
    }
    state = 'idle';
    spokeT = 0;
    linkT = 0;
    colorT = 0;
    lastStatus = '';
    statusEl.textContent = '';
    statusEl.classList.remove('show');
    shellFlag = false;
    manifestFlag = false;
    restoreFlag = false;
    progress = { done: 0, total: 0 };
    revealed = false;
    selfRotation = 0;
    axisAngleX = 0;
    axisAngleY = 0;
    axisAngleZ = 0;
    for (let i = 0; i < 3; i++) noiseOffset[i] = Math.random() * 70;
}

// 创建一次加载引导。main 通过返回的控制器推进动画。
export function createIntro({ onReady: ready, onRetry: retry } = {}) {
    reset();
    onReady = ready;
    onRetry = retry;

    return {
        begin() {
            enter('point', rand(380, 480));
            growTarget = rand(0.3, 0.6);
            linkTarget = rand(0.3, 0.6);
            rafId = requestAnimationFrame(tick);
        },
        shellReady() {
            shellFlag = true;
            accelerate();
        },
        manifestReady() {
            manifestFlag = true;
            accelerate();
        },
        restoreReady() {
            restoreFlag = true;
            accelerate();
        },
        articleProgress(done, total) {
            progress = { done, total };
        },
        fail(msg) {
            failSpoke0 = spokeT;
            failLink0 = linkT;
            state = 'fail';
            stateStart = now();
            showFailScreen(msg || '加载失败');
        },
    };
}

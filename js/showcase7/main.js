/**
 * MARK VII · 表面线稿渲染
 *
 * 渲染管线（三通道）：
 *   1. 法线通道  —— MeshNormalMaterial 渲染，供屏幕空间边缘检测
 *   2. 颜色通道  —— MeshStandardMaterial（PBR 贴图 + 法线刻线 + 反照率降噪），带深度纹理
 *   3. 合成通道  —— 法线/深度/亮度三重边缘检测 → 线稿叠加 → 局部对比增强
 *
 * 关键点：这份 GLB 的 4K 贴图是 AI 噪声（法线是杂乱划痕、反照率是红金斑块），
 * 直接采样会让表面显得发糊。因此反照率按 mip 降采样成干净色块，线条交给几何边缘。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { splitArmorMeshes, getSplitStats, SPLIT_DEFS } from './segment.js';

const CONFIG = {
  // 相对「文档」解析（不是相对本模块）：两页都在站点根目录，用 ./assets 可同时
  // 兼容根路径部署（GitHub Pages 用户站）与子路径部署（项目站 / 本地预览沙箱）。
  url: './assets/models/armor2.glb',
  targetHeight: 1.95,
  fov: 32,
  exposure: 1.08,
  albedoLod: 5.0,       // 反照率降采样级别（越大越干净）
  normalScale: 0.45,    // 法线贴图强度（原图是噪声，压低只留起伏）
  safeTop: 30,
  safeBottom: 104,
  fitScale: 1,          // 取景距离倍率：宽体/厚深度模型（如反浩克）需 >1 才不被裁切；1 = 原行为
};

// 允许覆盖模型路径：优先级 ?model=… 查询参数 > 引入脚本的 data-model 属性 > CONFIG 默认值。
// 不带任何覆盖时行为完全不变。测试页用 data-model 写死默认模型，仍可用 ?model= 临时切换。
{
  const u = new URLSearchParams(location.search);
  const scriptEl = () => document.querySelector('script[type="module"][data-model]');
  let m = u.get('model');
  if (!m) {
    // 注意：ES module 执行时 document.currentScript 恒为 null，只能按属性选。
    const el = scriptEl();
    if (el && el.dataset.model) m = el.dataset.model;
  }
  if (m) CONFIG.url = m.startsWith('./') || m.startsWith('/') ? m : './' + m;

  // 取景倍率同样可覆盖（?fit=1.3 或 data-fit="1.3"），用于宽体模型
  const fitOverride = u.get('fit') || (scriptEl() && scriptEl().dataset.fit);
  const fitNum = Number(fitOverride);
  if (fitOverride && fitNum > 0) CONFIG.fitScale = fitNum;
}

const state = {
  auto: true,
  ready: false,
  tris: 0,
  showLine: true,
  invert: false,        // false=暗线 true=亮线
  strength: 0.85,
  width: 1.05,
  surface: 1.0,         // 装甲表面存在感：1=全彩，0=纯线稿（去饱和 + 压暗）
  lineOnly: false,
  prevSurface: 1.0,     // 仅线条恢复时用
  lineColor: '#dbedff', // 亮线 / 流光颜色
  flow: true,           // 线条流光
  bg: true,             // 3D 空间背景
  jarvis: false,        // 贾维斯背景（HALOFLUX；initUI 按设备类型设定初值）
  jarvisMusic: false,   // 贾维斯背景音乐
  jarvisHidBg: false,   // 开贾维斯时是否替用户关掉了 3D 背景（关闭时恢复）
  jarvisWant: false,    // 贾维斯背景是否默认开（默认关：那个形态已独立成 mk7-console.html）
  time: 0,              // 全局动画时钟（流光 / 背景共用）
  split: false,         // 拆解状态
  modules: [],          // 切分出的装甲模块
  zoomAnim: null,       // 拆/合时的相机后拉补间
  fit: { dist: 4, targetY: 1 },
  dragging: false,
  embed: false,         // ?embed=1：作为 iframe 嵌入宿主页
  embedPanel: false,    // embed+panel=1：显示底部控制面板（取景留出工具栏安全区）
};

const $ = (id) => document.getElementById(id);

/* ?embed=1 嵌入模式：被宿主页（mk7-console / ironman-hud）以 iframe 引用。
   默认只渲染装甲本体：透明背景、无 HUD、无 3D/贾维斯背景层、不自动旋转。
   可选参数（ironman-hud 的诊断投影用）：
     panel=1  显示底部控制面板（旋转 / 线条 / 流光 / 背景 / 配色等）
     bg=1     开启 3D 空间背景（光柱 / 粒子 / 环 / 地面网格）
     line=1   默认「仅线条」模式（无表面纹理；面板按钮可切回）
     auto=1   默认自动旋转
     skin=hud 面板皮肤适配 ironman-hud 诊断页：右下角玻璃条、英文标签、降低存在感 */
const EMBED_QS = new URLSearchParams(location.search);
const EMBED = EMBED_QS.has('embed');
if (EMBED) {
  state.embed = true;
  state.bg = EMBED_QS.get('bg') === '1';
  state.embedPanel = EMBED_QS.get('panel') === '1';
  state.auto = EMBED_QS.get('auto') === '1';
  state.jarvisWant = false;
  state.jarvis = false;
  document.body.classList.add('embed');
  if (state.embedPanel) document.body.classList.add('embed-panel');
  if (EMBED_QS.get('skin') === 'hud') document.body.classList.add('skin-hud');
}

/* skin=hud：面板文案换成英文（宿主 ironman-hud 是全英文界面）。
   只在嵌入+该皮肤下生效，mk7.html 主页与 mk7-console 不受影响。 */
if (document.body.classList.contains('skin-hud')) {
  const EN = {
    'btn-rotate': ['ROTATE', 'Auto-rotate (Space)'],
    'btn-lineonly': ['LINES', 'Lines only, hide surface (O)'],
    'btn-split': ['SPLIT', 'Detach / assemble armor (E)'],
    'btn-flow': ['FLOW', 'Line flow pulse (G)'],
    'btn-bg': ['SPACE', '3D spatial backdrop (B)'],
    'btn-invert': ['DIM', 'Dim / bright lines (L)'],
    'btn-reset': ['RESET', 'Reset view (R)'],
  };
  for (const [id, [label, title]] of Object.entries(EN)) {
    const b = document.getElementById(id);
    if (b) { b.textContent = label; b.title = title; }
  }
  const SL = { 'rg-strength': 'GLOW', 'rg-width': 'WIDTH', 'rg-surface': 'SURFACE' };
  for (const [id, label] of Object.entries(SL)) {
    const input = document.getElementById(id);
    const span = input && input.parentElement.querySelector('span');
    if (span) span.textContent = label;
    if (input && input.parentElement) input.parentElement.title = label.toLowerCase() + ' control';
  }
}

/* ------------------------------------------------------------------ */
/* 渲染器 / 场景                                                        */
/* ------------------------------------------------------------------ */
const canvas = $('stage');
// alpha 画布：合成通道可输出 RT 的 alpha（贾维斯 iframe 背景从画布下面透出来）。
// premultipliedAlpha:false → 直通 alpha（RT 里装甲 a=1、背景 a≈0，边缘线性过渡）。
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: true, premultipliedAlpha: false });
let DPR = Math.min(devicePixelRatio || 1, EMBED ? 1.5 : 2);   // 嵌入时背景是宿主的光环，1.5x 足够
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
// 注意：不要用 scene.background（three 对 Color 背景会强制清 alpha=1，覆盖 clearAlpha 0）。
// 底色由 renderFrame 里的 setClearColor(0x0a0e13, 0) 提供，alpha 留给合成通道做遮罩 / 透明输出。
renderer.setClearColor(0x0a0e13, 0);

const camera = new THREE.PerspectiveCamera(CONFIG.fov, innerWidth / innerHeight, 0.05, 60);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.enablePan = false;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = Math.PI * 0.85;
controls.autoRotateSpeed = 0;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.72;

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x14181f, 0.42));
const key = new THREE.DirectionalLight(0xfff3e4, 3.5); key.position.set(3.0, 4.6, 3.4);
scene.add(key);
const fill = new THREE.DirectionalLight(0x9dc6ff, 1.2); fill.position.set(-3.2, 1.6, 2.2); scene.add(fill);
const rim = new THREE.DirectionalLight(0xffd7a8, 2.4); rim.position.set(-1.8, 2.6, -3.4); scene.add(rim);
const kick = new THREE.DirectionalLight(0x86b6ff, 0.55); kick.position.set(0.4, -1.4, 1.6); scene.add(kick);

// 接触阴影：径向渐变平面（比真实阴影干净，且不受视锥边界影响）
function makeContactShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 4, 128, 128, 126);
  grad.addColorStop(0, 'rgba(0,0,0,0.85)');
  grad.addColorStop(0.45, 'rgba(0,0,0,0.42)');
  grad.addColorStop(0.75, 'rgba(0,0,0,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 1.9),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.75 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.004;
  mesh.renderOrder = 1;
  return mesh;
}
const contactShadow = makeContactShadow();
scene.add(contactShadow);

/* ------------------------------------------------------------------ */
/* 3D 空间背景                                                          */
/* ------------------------------------------------------------------ */
/*
 * 组成：渐变穹顶 + 星尘粒子 + 环形竖向光柱 + 垂直来回扫描环 + 极坐标地面网格。
 *
 * 与三通道管线的兼容约定：
 *  - 全部元素「纯加色」混合（RGB 直接相加），且 alpha 输出恒为 0 —— 颜色通道
 *    渲染目标里装甲 alpha=1、背景 alpha≈0，合成通道据此把背景排除在
 *    「亮度边缘检测」与「局部对比增强」之外，扫描环/星尘再亮也不会画出假线条；
 *  - 深度全部不写入 → 不影响深度边缘；
 *  - 法线通道中整体隐藏（见 renderFrame）→ 不产生法线边缘。
 */
const PURE_ADD = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
};

const bgFx = {
  group: new THREE.Group(),
  uTime: { value: 0 },
  uColor: { value: new THREE.Color(state.lineColor) },  // 随线条颜色联动
  rings: [],
};

(function buildBackground() {
  const g = bgFx.group;

  // 1) 渐变穹顶：地平线微光 + 顶部微亮的深空底色（替代平板纯色背景）
  const domeMat = new THREE.ShaderMaterial({
    uniforms: { uColor: bgFx.uColor },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uColor;
      void main() {
        float h = vDir.y * 0.5 + 0.5;
        vec3 col = mix(vec3(0.008, 0.012, 0.019), vec3(0.020, 0.030, 0.046), smoothstep(0.0, 0.55, h));
        col = mix(col, vec3(0.038, 0.055, 0.080), smoothstep(0.55, 1.0, h));
        col += uColor * 0.05 * exp(-pow((h - 0.48) * 9.0, 2.0));   // 地平线微光
        gl_FragColor = vec4(col, 0.0);
      }`,
    side: THREE.BackSide, depthWrite: false, transparent: true, ...PURE_ADD,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(30, 48, 24), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  g.add(dome);

  // 2) 星尘粒子：球壳分布，缓慢闪烁
  {
    const N = 560;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = 7 + Math.random() * 9;
      const s = Math.sqrt(Math.max(0, 1 - u * u));
      pos[i * 3] = r * s * Math.cos(th);
      pos[i * 3 + 1] = Math.max(0.1, r * u * 0.75 + 1.0);
      pos[i * 3 + 2] = r * s * Math.sin(th);
      seed[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: bgFx.uTime, uColor: bgFx.uColor },
      vertexShader: /* glsl */`
        attribute float aSeed;
        uniform float uTime;
        varying float vTw;
        void main() {
          vTw = 0.5 + 0.5 * sin(uTime * (0.5 + aSeed * 1.6) + aSeed * 97.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (1.3 + fract(aSeed * 43.7) * 2.2) * (18.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform vec3 uColor;
        varying float vTw;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.06, d);
          gl_FragColor = vec4(uColor * (0.30 + 0.55 * vTw) * a, 0.0);
        }`,
      transparent: true, depthWrite: false, ...PURE_ADD,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    g.add(pts);
  }

  // 3) 环形竖向光柱：围绕战甲的一圈细光柱，亮度各自缓慢起伏
  {
    const beamGeo = new THREE.CylinderGeometry(0.012, 0.012, 2.7, 6, 1, true);
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2;
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: bgFx.uTime, uColor: bgFx.uColor,
          uPhase: { value: (i / 14) * Math.PI * 6.0 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
          precision highp float;
          varying vec2 vUv;
          uniform float uTime, uPhase;
          uniform vec3 uColor;
          void main() {
            float fade = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 1.6);          // 两端渐隐
            float flick = 0.55 + 0.45 * sin(uTime * 0.9 + uPhase);
            gl_FragColor = vec4(uColor * fade * flick * 0.14, 0.0);
          }`,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, ...PURE_ADD,
      });
      const beam = new THREE.Mesh(beamGeo, mat);
      beam.position.set(Math.cos(ang) * 1.5, 1.32, Math.sin(ang) * 1.5);
      g.add(beam);
    }
  }

  // 4) 垂直扫描环：水平光环沿 Y 轴上下往返（余弦驱动 → 自带缓入缓出）
  {
    const ringGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.55, 96, 1, true);
    const mkRing = (bright, dashes) => new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
      uniforms: { uColor: bgFx.uColor, uBright: { value: bright }, uDash: { value: dashes } },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        uniform vec3 uColor;
        uniform float uBright, uDash;
        void main() {
          float band = pow(1.0 - abs(vUv.y - 0.5) * 2.0, 2.6);            // 竖向亮核
          float dash = 0.7 + 0.3 * sin(vUv.x * 6.2832 * 90.0);            // 细刻度纹理
          gl_FragColor = vec4(uColor * band * mix(1.0, dash, uDash) * uBright, 0.0);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, ...PURE_ADD,
    }));
    const r1 = mkRing(0.85, 1.0);   // 主环：带刻度
    const r2 = mkRing(0.30, 0.0);   // 副环：无刻度、错相慢速
    g.add(r1, r2);
    bgFx.rings.push(
      { mesh: r1, min: 0.05, max: 1.98, speed: 0.85, phase: 0 },
      { mesh: r2, min: 0.10, max: 1.90, speed: 0.55, phase: 2.2 },
    );
  }

  // 5) 极坐标地面网格（静态，颜色取线条色的暗调）
  {
    const c = new THREE.Color(state.lineColor);
    const grid = new THREE.PolarGridHelper(5.4, 12, 9, 72, c.clone().multiplyScalar(0.30), c.clone().multiplyScalar(0.12));
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.material.depthWrite = false;
    Object.assign(grid.material, PURE_ADD);
    grid.position.y = 0.0015;
    g.add(grid);
  }
})();
bgFx.group.visible = state.bg;
scene.add(bgFx.group);

/* ------------------------------------------------------------------ */
/* 离屏目标                                                             */
/* ------------------------------------------------------------------ */
const size0 = renderer.getDrawingBufferSize(new THREE.Vector2());
const depthTex = new THREE.DepthTexture(size0.x, size0.y, THREE.UnsignedIntType);
depthTex.format = THREE.DepthFormat;

const beautyRT = new THREE.WebGLRenderTarget(size0.x, size0.y, {
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  type: THREE.HalfFloatType, depthTexture: depthTex, depthBuffer: true,
});
const normalRT = new THREE.WebGLRenderTarget(size0.x, size0.y, {
  minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.HalfFloatType,
});

const edgeMat = new THREE.ShaderMaterial({
  uniforms: {
    tColor: { value: beautyRT.texture },
    tNormal: { value: normalRT.texture },
    tDepth: { value: depthTex },
    uTexel: { value: new THREE.Vector2(1 / size0.x, 1 / size0.y) },
    uStrength: { value: state.strength },
    uThickness: { value: state.width },
    uNormalW: { value: 1.15 },
    uDepthW: { value: 0.5 },
    uLumW: { value: 0.4 },
    uDetail: { value: 0.9 },
    uLight: { value: 0 },
    uSurface: { value: state.surface },
    uLineColor: { value: new THREE.Color(state.lineColor) },
    uTime: { value: 0 },
    uFlow: { value: 0.9 },
    // embed 默认透明输出（只取装甲本体）；solid=1 时不透明输出，
    // 这样加色混合的 3D 背景才有 alpha 可透出 —— 宿主用 mix-blend-mode:screen 把黑底筛掉。
    uTransparent: { value: EMBED && EMBED_QS.get('solid') !== '1' ? 1 : 0 },
    uNear: { value: camera.near },
    uFar: { value: camera.far },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tColor, tNormal, tDepth;
    uniform vec2 uTexel;
    uniform float uStrength, uThickness, uNormalW, uDepthW, uNear, uFar, uLight, uLumW, uDetail, uSurface, uTime, uFlow, uTransparent;
    uniform vec3 uLineColor;

    float linDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      float ndc = z * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }
    vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    float lum(vec2 uv) { return dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 o = uTexel * uThickness;
      vec3 col = texture2D(tColor, vUv).rgb;

      // 表面控制：去饱和 + 压暗（0 = 纯线稿底色，1 = 原样）
      {
        float g = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(g), col, uSurface) * mix(0.16, 1.0, uSurface);
      }

      // 法线边缘
      vec3 nC = nrm(vUv);
      float nEdge = 0.0;
      nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv + vec2(o.x, 0.0))));
      nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv - vec2(o.x, 0.0))));
      nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv + vec2(0.0, o.y))));
      nEdge = max(nEdge, 1.0 - dot(nC, nrm(vUv - vec2(0.0, o.y))));
      nEdge = smoothstep(0.14, 0.58, nEdge);

      // 深度边缘（二阶差分，抑制掠射面误判）
      float dC = linDepth(vUv);
      float lap = abs(linDepth(vUv - vec2(o.x, 0.0)) + linDepth(vUv + vec2(o.x, 0.0)) - 2.0 * dC)
                + abs(linDepth(vUv + vec2(0.0, o.y)) + linDepth(vUv - vec2(0.0, o.y)) - 2.0 * dC);
      float dEdge = smoothstep(0.0012, 0.010, lap / max(dC, 1e-4));

      // 亮度边缘（贴图里烘焙的细缝）
      // alpha 遮罩：装甲 alpha=1、3D 背景 alpha≈0 → 背景的亮暗变化不产生假线条
      float mask = texture2D(tColor, vUv).a;
      float lxC = lum(vUv);
      float lx = lum(vUv + vec2(o.x, 0.0)) - lum(vUv - vec2(o.x, 0.0));
      float ly = lum(vUv + vec2(0.0, o.y)) - lum(vUv - vec2(0.0, o.y));
      float lumEdge = smoothstep(0.05, 0.28, length(vec2(lx, ly))) * mask;

      // 局部对比：让凹槽 / 螺栓浮出来（同样仅作用于装甲）
      float blur = 0.25 * (lum(vUv + vec2(o.x, o.y) * 2.0) + lum(vUv + vec2(-o.x, o.y) * 2.0)
                         + lum(vUv + vec2(o.x, -o.y) * 2.0) + lum(vUv + vec2(-o.x, -o.y) * 2.0));
      col *= clamp(1.0 + (lxC - blur) * uDetail * mask, 0.35, 2.2);

      float edge = clamp(nEdge * uNormalW + dEdge * uDepthW + lumEdge * uLumW, 0.0, 1.0) * uStrength;

      // 表面压暗后暗线会不可见：表面越暗，线条自动越亮
      float lineLight = clamp(uLight + 1.0 - smoothstep(0.0, 0.55, uSurface), 0.0, 1.0);

      // 流光脉冲 v2：窄亮核 + 长拖尾。开启流光时基线压暗到 0.78×、峰值提到
      // ≈3.1× 线色 —— 流光与静态线条的亮度比从 ~2.1:1 拉开到 ~4:1
      float fy = fract(vUv.y * 1.35 - uTime * 0.22);
      float head = smoothstep(0.075, 0.012, fy);                     // 前缘锐利的窄亮核
      float tail = pow(max(1.0 - fy * 2.35, 0.0), 2.2) * 0.46;       // 指数衰减拖尾
      float pulse = clamp(head + tail * (1.0 - head * 0.55), 0.0, 1.0) * uFlow;

      vec3 ink = vec3(0.012, 0.017, 0.024);
      float baseDim = mix(1.0, 0.78, clamp(uFlow * 1.1, 0.0, 1.0));  // 流光开启 → 基线略压暗
      vec3 lineCol = mix(ink, uLineColor * baseDim, lineLight);
      vec3 pulseCol = uLineColor * (1.75 + 1.35 * pulse);
      lineCol = mix(lineCol, pulseCol, pulse);
      col = mix(col, lineCol, edge * mix(0.92, 0.5, lineLight) * (1.0 + pulse * 0.55));

      // 输出 alpha：贾维斯模式透传 RT alpha（装甲 1 / 背景 0，iframe 从画布下面透出），
      // 普通模式恒为 1（不透明，保持程序化 3D 背景的观感）。mask 即 tColor.a。
      float outA = mix(1.0, mask, uTransparent);
      gl_FragColor = vec4(col, outA);
      #include <colorspace_fragment>
    }
  `,
  depthTest: false, depthWrite: false,
});

const quadScene = new THREE.Scene();
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMat));

const normalMat = new THREE.MeshNormalMaterial({ side: THREE.FrontSide });

/* ------------------------------------------------------------------ */
/* 模型                                                                */
/* ------------------------------------------------------------------ */
let model = null;
const JUNK = /Plane|CreationNulCrew|IK_char_/i;

/** 材质处理：降噪反照率 + 法线刻线 + 统一金属参数 */
function dress(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!m) return;

    m.metalness = 0.96;
    m.roughness = 0.3;
    m.metalnessMap = null;      // 噪声贴图，交给常量
    m.roughnessMap = null;
    m.envMapIntensity = 0.85;
    m.emissiveIntensity = 1.15;
    if (m.normalMap) {
      m.normalScale = new THREE.Vector2(CONFIG.normalScale, CONFIG.normalScale);
      m.normalMap.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const nmSize = m.normalMap?.image?.width || 2048;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uAlbedoLod = { value: CONFIG.albedoLod };
      shader.uniforms.uNMTexel = { value: 1 / nmSize };
      shader.uniforms.uNMLine = { value: state.showLine ? 0.85 : 0.0 };
      shader.fragmentShader =
        'uniform float uAlbedoLod; uniform float uNMTexel; uniform float uNMLine;\n' + shader.fragmentShader;

      // 反照率按 mip 采样：抹掉 AI 噪声，保留红 / 金色块
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= textureLod(map, vMapUv, uAlbedoLod);
        #endif`);

      // 法线贴图梯度 → 表面刻线（与模型 UV 完全对齐）
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef USE_NORMALMAP
        {
          vec2 px = vec2(uNMTexel);
          vec3 n0 = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
          vec3 nx = texture2D(normalMap, vNormalMapUv + vec2(px.x, 0.0)).xyz * 2.0 - 1.0;
          vec3 ny = texture2D(normalMap, vNormalMapUv + vec2(0.0, px.y)).xyz * 2.0 - 1.0;
          float e = length(nx.xy - n0.xy) + length(ny.xy - n0.xy);
          diffuseColor.rgb *= 1.0 - smoothstep(0.05, 0.32, e) * uNMLine * 0.9;
        }
        #endif`);

      // 粗糙度随基色明度变化：金色更光、深红更哑，避免整块“塑料感”
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = mix(0.38, 0.21,
          smoothstep(0.08, 0.55, dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))));`);

      m.userData.shader = shader;
    };
    m.needsUpdate = true;
  });
}

/** 取景：把模型放在「去掉顶栏 / 底部工具栏」后的可视区里垂直居中 */
function frameCamera(height) {
  const vFov = THREE.MathUtils.degToRad(CONFIG.fov);
  const fitH = (height / 2) / Math.tan(vFov / 2);
  const fitW = (height * 0.68) / (2 * Math.tan(vFov / 2) * Math.max(0.5, camera.aspect));
  const narrow = camera.aspect < 0.85;
  // CONFIG.fitScale 默认 1：仅宽体/厚深度模型（如反浩克，宽深比接近 1）需要放大取景距离，
  // 否则包围盒近端角点会被投影放大而超出视口。
  const d = Math.max(fitH, fitW) * (narrow ? 1.34 : 1.14) * (CONFIG.fitScale || 1);
  state.fit.dist = d;

  const vh = innerHeight || 900;
  if (state.embed && !state.embedPanel) {
    // 纯嵌入（无控制面板）：iframe 视口即取景框，装甲完整占满，不留安全区
    state.fit.targetY = height * 0.5;
  } else {
    const safeTop = narrow ? 120 : CONFIG.safeTop;
    // 底部安全区按工具栏的实际高度算（按钮数量变化时不会把脚部遮住）
    const tb = document.querySelector('.toolbar');
    const tbTop = tb ? tb.getBoundingClientRect().top : 0;
    const measured = tbTop > 0 ? vh - tbTop + 16 : 0;
    const safeBottom = measured || (narrow ? 150 : CONFIG.safeBottom);
    const pxPerUnit = vh / (2 * Math.tan(vFov / 2) * d);
    const shift = ((safeBottom - safeTop) / 2) / pxPerUnit;
    state.fit.targetY = height * 0.5 - Math.min(shift, height * (narrow ? 0.22 : 0.12));
  }

  controls.minDistance = d * 0.34;
  controls.maxDistance = d * 2.6;
}

/** 拆解状态下的视线高度：爆炸图整体上移，视点跟着抬到 0.64H */
const splitTargetY = () => CONFIG.targetHeight * 0.64;

function resetView() {
  if (!model) return;
  const d = state.fit.dist * (state.split ? 1.45 : 1);
  const dir = new THREE.Vector3(0.26, 0.1, 1).normalize();
  controls.target.set(0, state.split ? splitTargetY() : state.fit.targetY, 0);
  camera.position.copy(controls.target).addScaledVector(dir, d);
  camera.updateProjectionMatrix();
  controls.update();
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */
const loaderEl = $('loader');
const pctEl = $('pct');
const progEl = $('prog');
const ldText = $('ld-text');

function setProgress(p, mb) {
  pctEl.textContent = Math.round(p * 100) + '%';
  progEl.style.strokeDashoffset = String(213.6 * (1 - p));
  if (mb !== undefined) ldText.textContent = `加载装甲模型… ${mb} MB`;
}

async function boot() {
  $('error').classList.add('hidden');
  loaderEl.classList.remove('done');
  setProgress(0);

  const manager = new THREE.LoadingManager();
  manager.onProgress = (_u, loaded, total) => setProgress(Math.min(1, loaded / total));

  const t0 = performance.now();
  try {
    // Draco 几何压缩支持（本地解码器在 lib/three/addons/libs/draco/）；
    // 非 draco 模型走原路径，行为不变
    const draco = new DRACOLoader(manager).setDecoderPath('./lib/three/addons/libs/draco/');
    const gltf = await new GLTFLoader(manager).setDRACOLoader(draco).loadAsync(CONFIG.url, (e) => {
      if (e.lengthComputable) setProgress(e.loaded / e.total, (e.loaded / 1048576).toFixed(1));
    });

    const root = gltf.scene;
    root.traverse((o) => {
      if (!o.isMesh) return;
      if (JUNK.test(o.name)) { o.visible = false; return; }
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;   // 蒙皮网格包围盒不可靠
    });

    dress(root);

    let tris = 0, meshes = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
    });
    state.tris = Math.round(tris);

    root.updateMatrixWorld(true);   // 骨骼静止姿态需要 matrixWorld

    // 单块蒙皮网格 → 烘焙蒙皮 → 归一化 → 连通域岛屿切分成 7 个模块
    const armorMeshes = [];
    root.traverse((o) => { if (o.isMesh && o.visible) armorMeshes.push(o); });
    const pieces = splitArmorMeshes(armorMeshes, CONFIG.targetHeight);
    window.__splitStats = getSplitStats();

    const group = new THREE.Group();
    state.modules = [];
    for (const [region, piece] of pieces) {
      const def = SPLIT_DEFS[region] || { offset: [0, 0, 0], rotate: [0, 0, 0], stagger: 0 };
      const pivot = new THREE.Group();
      pivot.position.copy(piece.center);
      pivot.userData.moduleId = region;
      const mesh = new THREE.Mesh(piece.geometry, piece.material);
      mesh.userData.moduleId = region;
      pivot.add(mesh);
      group.add(pivot);
      state.modules.push({
        id: region,
        pivot,
        base: piece.center.clone(),
        off: new THREE.Vector3(...def.offset).multiplyScalar(CONFIG.targetHeight),
        rot: new THREE.Vector3(...def.rotate),
        stagger: def.stagger,
        t: 0,
        anim: null,
      });
    }
    scene.add(group);
    model = group;

    frameCamera(CONFIG.targetHeight);
    resetView();

    $('st-tris').textContent = state.tris.toLocaleString('en-US');
    const ms = Math.round(performance.now() - t0);
    ldText.textContent = `${meshes} 个部件 · ${ms} ms`;
    setProgress(1);
    setTimeout(() => loaderEl.classList.add('done'), 220);

    state.ready = true;
    console.info('[MK7] meshes:', meshes, 'tris:', state.tris, 'load ms:', ms);
    // 嵌入模式：通知宿主页（mk7-console）装甲已就绪，可以把 iframe 揭开
    if (state.embed) { try { parent.postMessage({ type: 'mk7-ready' }, '*'); } catch {} }
    // 模型就绪后再拉贾维斯背景（38MB 模型优先占带宽；背景晚 0.6s 出现不影响观感）
    if (state.jarvis) setTimeout(jarvisEnsureLoaded, 600);
  } catch (err) {
    console.error(err);
    $('error').classList.remove('hidden');
    $('err-msg').textContent = String(err?.message || err);
    loaderEl.classList.add('done');
  }
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */
function renderFrame() {
  // 法线通道（接影面 / 3D 背景不参与边缘检测，否则会画出矩形边界或假线条）
  if (contactShadow) contactShadow.visible = false;
  bgFx.group.visible = false;
  scene.overrideMaterial = normalMat;
  renderer.setRenderTarget(normalRT);
  renderer.setClearColor(0x8080ff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  bgFx.group.visible = state.bg;
  if (contactShadow) contactShadow.visible = true;

  // 颜色 + 深度（alpha 清 0：装甲写 1，背景保持 ≈0，供合成通道做遮罩）
  renderer.setRenderTarget(beautyRT);
  renderer.setClearColor(0x0a0e13, 0);
  renderer.clear();
  renderer.render(scene, camera);

  // 合成
  renderer.setRenderTarget(null);
  renderer.render(quadScene, quadCam);
}

let last = performance.now();
let frames = 0, fpsTimer = 0;
let slowFrames = 0;

function tick() {
  requestAnimationFrame(tick);
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (state.auto && !state.dragging && model) model.rotation.y += dt * 0.14;

  // 拆/合时的相机后拉（拆开后整体变大，需要让出取景空间）
  const nowMs = performance.now();
  if (state.zoomAnim) {
    const z = state.zoomAnim;
    let k = (nowMs - z.t0) / z.dur;
    if (k >= 1) { k = 1; state.zoomAnim = null; }
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const d = z.fromD + (z.toD - z.fromD) * e;
    const dir = camera.position.clone().sub(controls.target);
    controls.target.y = z.fromY + (z.toY - z.fromY) * e;
    if (dir.lengthSq() > 1e-6) {
      camera.position.copy(controls.target).addScaledVector(dir.normalize(), d);
    }
  }
  controls.update();

  // 拆解 / 组装补间（位移恒基于 base，反复拆装无累积误差）
  for (const m of state.modules) {
    const a = m.anim;
    if (!a) continue;
    let k = (nowMs - a.t0) / a.dur;
    if (k <= 0) k = 0;
    else if (k >= 1) { k = 1; m.anim = null; }
    const e = a.ease === 'out'
      ? 1 - Math.pow(1 - k, 3)
      : (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
    m.t = a.from + (a.to - a.from) * e;
    m.pivot.position.copy(m.base).addScaledVector(m.off, m.t);
    m.pivot.rotation.set(m.rot.x * m.t, m.rot.y * m.t, m.rot.z * m.t);
  }

  edgeMat.uniforms.uStrength.value = state.showLine ? state.strength : 0;
  edgeMat.uniforms.uThickness.value = state.width;
  edgeMat.uniforms.uLight.value = state.invert ? 1 : 0;
  edgeMat.uniforms.uSurface.value = state.surface;
  state.time += dt;
  edgeMat.uniforms.uTime.value = state.time;
  edgeMat.uniforms.uFlow.value = state.flow ? 0.9 : 0;

  // 背景动画：闪烁 / 光柱起伏 + 扫描环垂直往返（余弦 → 自带缓入缓出）
  if (state.bg) {
    bgFx.uTime.value = state.time;
    for (const r of bgFx.rings) {
      r.mesh.position.y = r.min + (r.max - r.min) * (0.5 - 0.5 * Math.cos(state.time * r.speed + r.phase));
    }
  }

  renderFrame();

  frames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    const fps = Math.round(frames / fpsTimer);
    $('st-fps').textContent = String(fps);
    frames = 0; fpsTimer = 0;
    // 低端设备降载
    if (state.ready && fps < 30 && DPR > 1) {
      if (++slowFrames >= 4) {
        DPR = 1;
        renderer.setPixelRatio(1);
        resizeTargets();
        slowFrames = 0;
      }
    } else slowFrames = 0;
  }
}

function resizeTargets() {
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  beautyRT.setSize(s.x, s.y);
  normalRT.setSize(s.x, s.y);
  edgeMat.uniforms.uTexel.value.set(1 / s.x, 1 / s.y);
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  resizeTargets();
  if (model) {
    const b = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    frameCamera(b.y);
    resetView();
  }
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */
function setInvert(on) {
  state.invert = on;
  const b = $('btn-invert');
  b.textContent = on ? '亮线' : '暗线';
  b.classList.toggle('on', on);
}

/** 3D 空间背景开关 */
function setBackground(on) {
  state.bg = on;
  bgFx.group.visible = on;
  $('btn-bg').classList.toggle('on', on);
  // 贾维斯开着时透明画布画不出程序化背景（加色元素 alpha=0）——点「背景」视为要切回 3D 背景
  if (on && state.jarvis) setJarvis(false, true);
}

/* ------------------------------------------------------------------ */
/* 贾维斯背景（HALOFLUX 壁纸版 iframe）                                  */
/* ------------------------------------------------------------------ */
const jarvisFrame = $('jarvis');
let jarvisLoaded = false;   // iframe 已注入 src 并完成配置

/** 把壁纸版切成「纯光环」形态：隐藏它的 header / 面板，关掉它的音乐（同源调用） */
function jarvisConfigure() {
  const w = jarvisFrame.contentWindow;
  if (!w || !w.wallpaperPropertyListener) return false;
  try {
    w.wallpaperPropertyListener.applyUserProperties({
      showui: { value: false },     // 只留光环，去掉它的顶栏 / 八块面板
      music: { value: state.jarvisMusic },
      scanlines: { value: true },
      camera: { value: false },     // 关自动运镜 → 光环居中构型，正好框住中央的装甲
      camzoom: { value: 1 },
      tempo: { value: 0.5 },        // 节奏放缓，背景不抢戏
      ringspeed: { value: 0.42 },
      beamglow: { value: 2.2 },
    });
    // 性能裁剪：canvas filter 模糊（depthBlur / webBlur）在这套全屏合成上最贵，
    // 关掉后观感几乎不变；流线 / 光带数量也压一档。
    const perf = [
      ['depthBlur', 0], ['webBlur', 0], ['runnerCount', 260],
      ['hazeCount', 10], ['flyerCount', 1], ['depthDim', 1.1],
    ];
    for (const [k, v] of perf) { try { w.setParam(k, v, true); } catch {} }
    // 舞台上的文字叠层（STABILITY CHECK / 方法计数 / 公式牌）与装甲页自身 HUD 语义无关，
    // 内嵌时作为背景只保留纯视觉。同源注入一条样式即可。
    try {
      const d = w.document;
      if (!d.getElementById('mk7-embed-style')) {
        const s = d.createElement('style');
        s.id = 'mk7-embed-style';
        s.textContent = '.ov{display:none!important}.stage::after{opacity:.55}';
        d.head.appendChild(s);
      }
    } catch {}
    return true;
  } catch { return false; }
}

/** 首次启用时才注入 src（避免和 38MB 模型抢带宽）；load 后把壁纸切成纯光环形态 */
function jarvisEnsureLoaded() {
  if (jarvisLoaded) { jarvisConfigure(); return; }
  if (jarvisFrame.dataset.loading === '1') return;
  jarvisFrame.dataset.loading = '1';
  jarvisFrame.addEventListener('load', () => {
    jarvisLoaded = jarvisConfigure();
    if (!jarvisLoaded) setTimeout(() => {
      jarvisLoaded = jarvisConfigure();
      // 两次都配不上（页面缺失 / 加载失败）→ 自动退回程序化背景，避免露出错误页
      if (!jarvisLoaded) { console.warn('[MK7] 贾维斯背景不可用，回退 3D 背景'); setJarvis(false); }
    }, 800);
  }, { once: true });
  jarvisFrame.src = jarvisFrame.dataset.src;
}

function setJarvis(on, fromBg) {
  if (state.jarvis === on) return;
  state.jarvis = on;
  const btn = $('btn-jarvis');
  btn.classList.toggle('on', on);
  // 透明画布 ↔ 不透明画布：合成通道输出 RT alpha 或恒 1
  edgeMat.uniforms.uTransparent.value = on ? 1 : 0;
  jarvisFrame.classList.toggle('on', on);
  $('jarvisveil').classList.toggle('on', on);

  if (on) {
    // 程序化背景在透明画布下画不出来，替用户关掉并记住，关贾维斯时恢复
    if (state.bg) { setBackground(false); state.jarvisHidBg = true; }
    if (jarvisLoaded) {
      jarvisConfigure();                             // 重新显示时恢复纯光环形态
      const w = jarvisFrame.contentWindow;
      if (w) w.__wpPaused = false;
    } else if (state.ready) {
      jarvisEnsureLoaded();                          // 模型已就绪 → 直接加载
    }
    // 否则等 boot 完成后再加载（见 state.ready 那行）
  } else {
    if (state.jarvisHidBg && !fromBg) { state.jarvisHidBg = false; setBackground(true); }
    else state.jarvisHidBg = false;
    // 暂停 iframe 的渲染循环（display:none 也挡不住 rAF，必须显式叫停），音乐一并停掉
    const w = jarvisFrame.contentWindow;
    if (w) {
      w.__wpPaused = true;
      if (state.jarvisMusic && w.__bgm) { try { w.__bgm.set(false); } catch {} }
    }
  }
}

/** 贾维斯背景音乐（M 键；首次播放需要一次用户手势，按键/点击都算） */
function toggleJarvisMusic() {
  if (!state.jarvis) { setJarvis(true); }
  state.jarvisMusic = !state.jarvisMusic;
  const w = jarvisFrame.contentWindow;
  if (w && w.__bgm) {
    try {
      w.wallpaperPropertyListener.applyUserProperties({ music: { value: state.jarvisMusic } });
      if (state.jarvisMusic) w.__bgm.kick();
    } catch {}
  }
}

// HALOFLUX 是第二个全屏动画循环，和主渲染抢 CPU：隔帧暂停 → 背景跑约 30fps，
// 主渲染的帧率翻倍。HALOFLUX 自己的暂停开关是 window.__wpPaused（见其 frame 循环）。
let jarvisPhase = 0;
setInterval(() => {
  if (!state.jarvis) return;
  const w = jarvisFrame.contentWindow;
  if (w) w.__wpPaused = (jarvisPhase++ & 1) === 1;
}, 16);

/** 仅线条：表面归零；恢复时回到之前的表面值 */
function setLineOnly(on) {
  state.lineOnly = on;
  if (on) {
    state.prevSurface = state.surface > 0.02 ? state.surface : 1.0;
    state.surface = 0;
  } else {
    state.surface = state.prevSurface;
  }
  const btn = $('btn-lineonly');
  btn.classList.toggle('on', on);
  const rg = $('rg-surface');
  rg.value = String(state.surface);
  rg.disabled = on;
}

function capture() {
  if (!state.ready) return;
  renderFrame();
  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  const g = ctx.createRadialGradient(out.width / 2, out.height * 0.28, 0, out.width / 2, out.height * 0.28, Math.max(out.width, out.height) * 0.85);
  g.addColorStop(0, '#18212c');
  g.addColorStop(0.5, '#0c1117');
  g.addColorStop(1, '#05080b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, out.width, out.height);

  // 贾维斯背景：同源 → 直接把它 iframe 里的光环画布一起合成进截图，再补一层聚光遮罩
  if (state.jarvis) {
    const jc = jarvisFrame.contentWindow?.document?.getElementById('stage');
    if (jc && jc.width > 1) {
      ctx.globalAlpha = 0.62;                       // 与 #jarvis 的 opacity 一致
      ctx.drawImage(jc, 0, 0, out.width, out.height);
      ctx.globalAlpha = 1;
      const vg = ctx.createRadialGradient(out.width / 2, out.height * 0.46, 0,
        out.width / 2, out.height * 0.46, Math.max(out.width, out.height) * 0.55);
      vg.addColorStop(0, 'rgba(6,9,13,0.72)');
      vg.addColorStop(0.5, 'rgba(6,9,13,0.34)');
      vg.addColorStop(1, 'rgba(6,9,13,0)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, out.width, out.height);
    }
  }

  ctx.drawImage(src, 0, 0);
  const a = document.createElement('a');
  a.download = 'mark7-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
  a.href = out.toDataURL('image/png');
  a.click();
}

/** 拆解 / 合并：每个模块带 stagger 时序差，重复触发从当前进度平滑过渡 */
function toggleSplit() {
  if (!state.modules.length) return;
  state.split = !state.split;
  const target = state.split ? 1 : 0;
  const now = performance.now();
  for (const m of state.modules) {
    m.anim = {
      from: m.t,
      to: target,
      t0: now + m.stagger * (state.split ? 1000 : 600),
      dur: 1300 * (0.75 + 0.5 * Math.abs(target - m.t)),
      ease: state.split ? 'out' : 'inout',
    };
  }
  const b = $('btn-split');
  b.textContent = state.split ? '合并' : '拆卸';
  b.classList.toggle('on', state.split);

  // 相机后拉 + 视点上移 / 复位
  state.zoomAnim = {
    fromD: camera.position.distanceTo(controls.target),
    toD: state.fit.dist * (state.split ? 1.45 : 1),
    fromY: controls.target.y,
    toY: state.split ? splitTargetY() : state.fit.targetY,
    t0: now,
    dur: 1100,
  };
}

function initUI() {
  $('btn-rotate').addEventListener('click', () => {
    state.auto = !state.auto;
    $('btn-rotate').classList.toggle('on', state.auto);
  });
  $('rg-strength').addEventListener('input', (e) => {
    state.strength = parseFloat(e.target.value);
    $('st-line').textContent = Math.round(state.strength * 100) + '%';
  });
  $('rg-width').addEventListener('input', (e) => { state.width = parseFloat(e.target.value); });
  $('rg-surface').addEventListener('input', (e) => {
    state.surface = parseFloat(e.target.value);
    if (state.lineOnly && state.surface > 0.02) {
      state.lineOnly = false;
      $('btn-lineonly').classList.remove('on');
      $('rg-surface').disabled = false;
    }
  });
  $('btn-lineonly').addEventListener('click', () => setLineOnly(!state.lineOnly));
  $('btn-invert').addEventListener('click', () => setInvert(!state.invert));
  $('btn-split').addEventListener('click', toggleSplit);
  $('btn-flow').addEventListener('click', () => {
    state.flow = !state.flow;
    $('btn-flow').classList.toggle('on', state.flow);
  });
  $('btn-bg').addEventListener('click', () => setBackground(!state.bg));
  $('btn-jarvis').addEventListener('click', () => setJarvis(!state.jarvis));
  $('in-color').addEventListener('input', (e) => {
    state.lineColor = e.target.value;
    edgeMat.uniforms.uLineColor.value.set(state.lineColor);
    bgFx.uColor.value.set(state.lineColor);   // 背景色随线条颜色联动
  });
  $('btn-reset').addEventListener('click', resetView);
  $('btn-shot').addEventListener('click', capture);
  $('btn-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });
  $('btn-retry').addEventListener('click', () => location.reload());

  canvas.addEventListener('pointerdown', () => { state.dragging = true; });
  addEventListener('pointerup', () => { state.dragging = false; });
  canvas.addEventListener('dblclick', resetView);

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); $('btn-rotate').click(); }
    else if (k === 'r') resetView();
    else if (k === 's') capture();
    else if (k === 'l') setInvert(!state.invert);
    else if (k === 'o') $('btn-lineonly').click();
    else if (k === 'e') toggleSplit();
    else if (k === 'g') $('btn-flow').click();
    else if (k === 'b') setBackground(!state.bg);
    else if (k === 'j') setJarvis(!state.jarvis);
    else if (k === 'm') toggleJarvisMusic();
    else if (k === 'f') $('btn-full').click();
  });

  // 贾维斯背景不再自动启用：那个形态已独立成 mk7-console.html。
  // 本页保留 J 键 / 「贾维斯」按钮，按需切换到叠加模式。

  addEventListener('resize', onResize);
}

/* ------------------------------------------------------------------ */
initUI();
// 嵌入参数 line=1：进入「仅线条」并同步按钮与表面滑条
if (EMBED && EMBED_QS.get('line') === '1') setLineOnly(true);
boot().then(() => { if (state.ready) tick(); });

// 测试钩子
window.__MK7 = { THREE, scene, camera, renderer, controls, edgeMat, CONFIG, state, bgFx, get model() { return model; }, resetView, capture, setPanelVisible };

/** 宿主页开关嵌入面板（skin=hud 场景下由 ironman-hud 的按钮调用）。返回切换后的可见状态。 */
function setPanelVisible(v) {
  const off = v === false;
  document.body.classList.toggle('panel-off', off);
  state.panelVisible = !off;
  return state.panelVisible;
}
state.panelVisible = true;

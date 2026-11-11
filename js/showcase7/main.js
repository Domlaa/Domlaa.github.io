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
  url: './assets/models/detail/mk7.glb',
  targetHeight: 1.95,
  fov: 32,
  exposure: 1.08,
  albedoLod: 5.0,       // 反照率降采样级别（越大越干净）
  nmLine: 0.85,         // 法线贴图梯度 → 刻线强度（贴图本身有干净缝线的模型可调低）
  normalScale: 0.45,    // 法线贴图强度（原图是噪声，压低只留起伏）
  safeTop: 30,
  safeBottom: 104,
  fitScale: 1,          // 取景距离倍率：宽体/厚深度模型（如反浩克）需 >1 才不被裁切；1 = 原行为
  rot0: 0,              // 初始朝向（度）：并排多展位时错开起始相位，避免同步旋转
  flat: false,          // 结构线模式：丢弃贴图，装甲换成同一套素模材质（只留几何轮廓线）
  metal: 0.96,          // 统一金属度：MK VII 的金属贴图是噪声，直接用常量
  envInt: 0.85,         // 环境反射强度：暗色涂装（如反浩克的黑金）需要更高才不是一片死黑
  strength: 0.85,       // 初始线条强度：面数越高边缘越密（54 万面），需要调低才不糊成白噪
  width: 1.05,          // 初始线条宽度（px）
  splitZoom: 1.40,      // 拆解态的相机后拉倍率（零件向四周散开，需要让出取景空间）
  splitTargetY: 0.50,   // 拆解态视点高度（× 身高）：整体外扩后重心回到身高中段
  coreX: 0,             // 反应堆锚点横向偏移（× 身高）：反浩克舱口在模型中线偏左（可 ?corex= 覆盖）
  coreY: 0.775,         // 反应堆锚点高度（× 模型身高）：胸口反应堆中心（可 ?corey= 覆盖）
  coreZ: 0.62,          // 锚点深度兜底值（× 模型最大 z）：正常情况下由射线吸附到真实表面
  coreR: 0.036,         // 反应堆光斑半径（× 模型身高）；宽体模型可调大
  coreWall: 1.1,        // 离面容差（× 光斑半径）：舱口越凸凹越大，太小会把外晕切在坑沿上
  coreFx: 1,            // 反应堆辉光总强度 0~1（?corefx=0 整套关掉：光核 + 外晕 + 波纹）
  coreRip: 0,           // 波纹强度 0~1（默认关）：去掉光核周围一圈圈外扩的圆圈
  coreRad: 1,           // 静态辐射强度 0~1（默认开）：沿战甲刻线由内向外渐隐，保留纹路扩散效果
  ripMax: 4.2,          // 波纹最远半径（× 光斑半径）：调小则只留贴着光核的一圈
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

  // 初始朝向（?rot=-24 / data-rot），单位度
  const rotOverride = u.get('rot') || (scriptEl() && scriptEl().dataset.rot);
  const rotNum = Number(rotOverride);
  if (rotOverride && Number.isFinite(rotNum)) CONFIG.rot0 = rotNum;

  // 结构线模式（?flat=1）：不吃贴图，多材质模型切成单材质后不会出现错贴图黑洞
  CONFIG.flat = u.get('flat') === '1';

  // 材质常量（?metal=0.9&env=2.2）：暗色涂装模型需要更强的环境反射才不糊成剪影
  for (const [key, param] of [['metal', 'metal'], ['envInt', 'env']]) {
    const raw = u.get(param) || (scriptEl() && scriptEl().dataset[param]);
    const num = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(num) && num >= 0) CONFIG[key] = num;
  }
  // 反照率 mip 级别 + 法线刻线强度（?lod=1&nmline=0.5）：
  // MK VII 的贴图是 AI 噪声要靠大 mip 抹平；常规图集模型用大 mip 反而会糊成灰白。
  for (const [key, param] of [['albedoLod', 'lod'], ['nmLine', 'nmline']]) {
    const raw = u.get(param) || (scriptEl() && scriptEl().dataset[param]);
    const num = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(num) && num >= 0) CONFIG[key] = num;
  }
  // 初始线条强度 / 宽度（?str=0.55&wid=0.9）：高面数模型的边缘线密度大，需要更细更淡
  for (const [key, param] of [['strength', 'str'], ['width', 'wid']]) {
    const raw = u.get(param) || (scriptEl() && scriptEl().dataset[param]);
    const num = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(num) && num > 0) CONFIG[key] = num;
  }

  // 反应堆锚点微调（?corex=0.02&corey=0.72）：不同体型（反浩克 / MK VII）胸位不同，
  // 宿主页可按需覆盖，不写则用 CONFIG 默认值。
  const coreXOverride = Number(u.get('corex') || (scriptEl() && scriptEl().dataset.corex));
  if (Number.isFinite(coreXOverride)) CONFIG.coreX = coreXOverride;
  const coreYOverride = Number(u.get('corey') || (scriptEl() && scriptEl().dataset.corey));
  if (Number.isFinite(coreYOverride) && coreYOverride > 0) CONFIG.coreY = coreYOverride;
  const coreZOverride = Number(u.get('corez') || (scriptEl() && scriptEl().dataset.corez));
  if (Number.isFinite(coreZOverride) && coreZOverride > 0) CONFIG.coreZ = coreZOverride;
  const coreROverride = Number(u.get('corer') || (scriptEl() && scriptEl().dataset.corer));
  if (Number.isFinite(coreROverride) && coreROverride > 0) CONFIG.coreR = coreROverride;
  const coreWOverride = Number(u.get('corew') || (scriptEl() && scriptEl().dataset.corew));
  if (Number.isFinite(coreWOverride) && coreWOverride > 0) CONFIG.coreWall = coreWOverride;
  // 波纹最远半径（?ripmax=1.6）：控制扩散范围，越小越收敛在光核附近（下限 0.5，避免相位速率被算爆）
  const ripMaxOverride = Number(u.get('ripmax') || (scriptEl() && scriptEl().dataset.ripmax));
  if (Number.isFinite(ripMaxOverride) && ripMaxOverride > 0) {
    CONFIG.ripMax = Math.min(8, Math.max(0.5, ripMaxOverride));
  }

  // 辉光开关：允许为 0（默认 1）。不想要胸口的辉光用 ?corefx=0；
  // 只留光核 + 沿刻线的静态辐射、去掉外扩波纹时用 ?corerip=0（HUD 页就是这么配的）；
  // ?corerad=0 可再单独关掉静态辐射，只留中心光点。
  for (const [key, param] of [['coreFx', 'corefx'], ['coreRip', 'corerip'], ['coreRad', 'corerad']]) {
    const raw = u.get(param) || (scriptEl() && scriptEl().dataset[param]);
    const num = Number(raw);
    if (raw !== null && raw !== '' && Number.isFinite(num)) CONFIG[key] = Math.min(1, Math.max(0, num));
  }
}

const state = {
  auto: true,
  ready: false,
  tris: 0,
  showLine: true,
  invert: false,        // false=暗线 true=亮线
  strength: CONFIG.strength,
  width: CONFIG.width,
  surface: 1.0,         // 装甲表面存在感：1=全彩，0=纯线稿（去饱和 + 压暗）
  lineOnly: false,
  prevSurface: 1.0,     // 仅线条恢复时用
  lineColor: '#dbedff', // 亮线 / 流光颜色
  flow: true,           // 线条流光
  bg: true,             // 3D 空间背景
  jarvis: false,        // 贾维斯背景（HALOFLUX；initUI 按设备类型设定初值）
  jarvisMusic: false,   // 贾维斯背景音乐
  jarvisHidBg: false,   // 开贾维斯时是否替用户关掉了 3D 背景（关闭时恢复）
  jarvisWant: false,    // 贾维斯背景是否默认开（默认关：那个形态已独立成 jarvis-console.html）
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

/* ?embed=1 嵌入模式：被宿主页（jarvis-console / ironman-hud）以 iframe 引用。
   默认只渲染装甲本体：透明背景、无 HUD、无 3D/贾维斯背景层、不自动旋转。
   可选参数（ironman-hud 的诊断投影用）：
     panel=1  显示底部控制面板（旋转 / 线条 / 流光 / 背景 / 配色等）
     bg=1     开启 3D 空间背景（光柱 / 粒子 / 环 / 地面网格）
     line=1   默认「仅线条」模式（无表面纹理；面板按钮可切回）
     auto=1   默认自动旋转
     skin=hud 面板皮肤适配 ironman-hud 诊断页：右下角玻璃条、英文标签、降低存在感 */
const EMBED_QS = new URLSearchParams(location.search);
const EMBED = EMBED_QS.has('embed');
const SKIN_HUD = EMBED_QS.get('skin') === 'hud';
if (EMBED) {
  state.embed = true;
  state.bg = EMBED_QS.get('bg') === '1';
  state.embedPanel = EMBED_QS.get('panel') === '1';
  state.auto = EMBED_QS.get('auto') === '1';
  state.jarvisWant = false;
  state.jarvis = false;
  document.body.classList.add('embed');
  if (state.embedPanel) document.body.classList.add('embed-panel');
  if (SKIN_HUD) document.body.classList.add('skin-hud');
}

/* 说明：面板文案已全部英文化（宿主 ironman-hud 本来就是全英文界面），
   原先 skin=hud 下单独把标签换成英文的那段映射表已删除，避免两套词表打架
   （例如 HTML 里是 BG，映射表原本写 SPACE）。skin-hud 现在只管 CSS 皮肤。 */

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
  // 扫描环主色：冷青（固定色彩个性），syncBgColor 里再掺 30% 线色跟随自定义
  uTrail: { value: new THREE.Color(0x38D8FF) },
  rings: [],
};

/** 线条颜色 → 背景：本体取线色；扫描环尾迹以冷青为主色（固定的色彩个性），
    只掺入 30% 线色以便跟随自定义色，避免默认白线时整环退回纯白 */
function syncBgColor() {
  const c = new THREE.Color(state.lineColor);
  bgFx.uColor.value.copy(c);
  bgFx.uTrail.value.copy(new THREE.Color(0x38D8FF)).lerp(c, 0.3);
}

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

  // 4) 垂直扫描环：水平光环沿 Y 轴上下往返（三角波为主 + 折返处柔化 → 全程近匀速）
  //    能量扫描造型：运动前沿白热窄核 + 尾迹衰减成线色（单色相渐变，色相跟随取色器）；
  //    折返点速度为零时白热核自动熄灭，退化成对称柔光
  {
    // 高度 0.13：细扫描线但留有足够像素展示「白热→冷青」的渐变层次
    const ringGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.13, 128, 1, true);
    const mkRing = (bright, dashes) => new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
      uniforms: {
        uColor: bgFx.uColor, uTrail: bgFx.uTrail,
        uBright: { value: bright }, uDash: { value: dashes },
        uDir: { value: 1 },    // 运动方向：+1 上行 / -1 下行（tick 里按速度符号更新）
        uHot: { value: 0.8 },  // 白热强度 ∝ |速度|，折返时归零
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vFace;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          // 掠射角淡出：只在「正对镜头」的那段圆弧上发光，
          // 否则从下方看圆柱内壁会糊成一整片大盘
          vFace = abs(dot(normalize(-mv.xyz), n));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv;
        varying float vFace;
        uniform vec3 uColor, uTrail;
        uniform float uBright, uDash, uDir, uHot;
        void main() {
          // b = 距运动前沿的归一化距离（0 = 前沿，1 = 尾端），随 uDir 翻转
          float b = mix(vUv.y, 1.0 - vUv.y, step(0.0, uDir));
          float core  = exp(-b * b * 90.0);                     // 白热核心：极窄的一条线
          float glow  = exp(-b * 2.2);                          // 冷色辉光：铺满整条带
          float band  = core * 0.9 + glow * 0.42;
          float dash  = 0.72 + 0.28 * sin(vUv.x * 6.2832 * 90.0); // 细刻度纹理
          // 环体自始至终保持冷青色相，只有核心那一条烧到白热
          vec3 col = mix(uTrail, vec3(1.0), clamp(core * uHot, 0.0, 1.0) * 0.75);
          float face = smoothstep(0.10, 0.55, vFace);
          gl_FragColor = vec4(col * band * mix(1.0, dash, uDash) * uBright * face, 0.0);
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, ...PURE_ADD,
    }));
    const r1 = mkRing(0.92, 1.0);   // 主环：带刻度
    const r2 = mkRing(0.36, 0.0);   // 副环：无刻度，作为主环的随行 escort
    g.add(r1, r2);
    // 同速 + 固定相位差：两环永远保持固定间距、同向同行（配对扫描），
    // 旧版速度不可通约（0.85 / 0.55）导致两环各自乱漂、来回对穿，看起来不协调。
    // HUD 皮肤舞台更矮（上下都留了 HUD 边），扫描上限收到 1.80，免得环在最高点被舞台沿硬切出断面。
    const yTop = SKIN_HUD ? 1.80 : 1.98;
    bgFx.rings.push(
      { mesh: r1, min: 0.05, max: yTop, speed: 1.0, phase: 0 },
      { mesh: r2, min: 0.05, max: yTop, speed: 1.0, phase: -0.62 },
    );
  }

  // 5) 极坐标地面网格（静态，颜色取线条色的暗调）
  //    skin=hud（诊断页，画面容器窄）：缩小半径 + 减少圈数，外圈完整落在视野内，
  //    不会在容器左右被裁出半段弧；其余页面保持原尺寸
  {
    const R = SKIN_HUD ? 1.4 : 5.4;
    const rings = SKIN_HUD ? 5 : 9;
    const c = new THREE.Color(state.lineColor);
    const grid = new THREE.PolarGridHelper(R, 12, rings, 72, c.clone().multiplyScalar(0.30), c.clone().multiplyScalar(0.12));
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
    // 反应堆核心辉光：真正的 3D 表面光斑。
    // 合成阶段用深度纹理重建每个像素的世界坐标，再按「到锚点的空间距离」衰减 ——
    // 透视、缩放、胸甲倾斜、手臂遮挡全部自动成立，不再是浮在画面上的圆形贴纸。
    uCoreWorld: { value: new THREE.Vector3() },
    uCoreNrm: { value: new THREE.Vector3(0, 0, 1) },
    uCoreOn: { value: 0 },
    uCoreWall: { value: CONFIG.coreWall },
    uCoreR: { value: CONFIG.coreR * CONFIG.targetHeight },
    uCoreGain: { value: CONFIG.coreFx },
    uCoreRip: { value: CONFIG.coreRip },
    uCoreRad: { value: CONFIG.coreRad },
    uRipMax: { value: CONFIG.ripMax },
    uInvProj: { value: camera.projectionMatrixInverse },
    uCamWorld: { value: camera.matrixWorld },
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
    uniform vec3 uCoreWorld, uCoreNrm;
    uniform float uCoreOn, uCoreR, uCoreWall, uCoreGain, uCoreRip, uCoreRad, uRipMax;
    uniform mat4 uInvProj, uCamWorld;

    float linDepth(vec2 uv) {
      float z = texture2D(tDepth, uv).x;
      float ndc = z * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }
    vec3 nrm(vec2 uv) { return texture2D(tNormal, uv).xyz * 2.0 - 1.0; }
    float lum(vec2 uv) { return dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); }

    /* 深度 → 世界坐标。合成 pass 是全屏 quad、没有几何信息，但深度纹理记录了
       每个像素的视空间 z：反投影回去就能知道「这个像素落在哪块真实表面上」。
       背景像素深度为 1（远平面），会落到极远处，光斑自然照不到。 */
    vec3 worldAt(vec2 uv) {
      float dz = texture2D(tDepth, uv).x;
      vec4 clip = vec4(uv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0);
      vec4 view = uInvProj * clip;
      return (uCamWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    }

    void main() {
      vec2 o = uTexel * uThickness;
      vec4 src = texture2D(tColor, vUv);
      vec3 col = src.rgb;

      // 表面控制：去饱和 + 压暗（0 = 纯线稿底色，1 = 原样）
      // 取景背景（扫描环等）是发光彩色元素，若一并去色会变成一片灰白。
      // 只对「背景像素」（颜色 alpha≈0，装甲写 1）按色度保留，战甲表面仍被压成线稿。
      {
        float g = dot(col, vec3(0.2126, 0.7152, 0.0722));
        float chroma = length(col - vec3(g));
        float bgMask = 1.0 - clamp(src.a, 0.0, 1.0);
        float keep = smoothstep(0.035, 0.12, chroma) * bgMask * 0.9;
        float s = max(uSurface, keep);
        col = mix(vec3(g), col, s) * mix(0.16, 1.0, s);
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

      // 流光 v3：单向扫掠的柔和光带。
      // 旧版的三个硬伤：① 用 fract(vUv.y * 1.35) 取带子，频率非 1 → 上下接缝亮度突变；
      // ② 亮核 smoothstep(0.075, 0.012) 只有 6% 屏高、边沿近乎阶跃；
      // ③ 拖尾只覆盖 42% 高度，其余是一整片死黑 → 视觉上就是「一条亮杠在扫」。
      // 现在：带心从画面下方之外升到上方之外（两端都在画外，回卷时看不见跳变），
      // 包络改为两侧不同衰减速度的指数函数，前缘快收、下摆长余晖，
      // 亮度沿 y 连续变化，任何位置都没有硬边。
      float sweep = fract(uTime * 0.11);                             // 9.1s 一趟，缓
      float bandY = mix(-0.55, 1.55, sweep);                         // 带心 y（0 = 底, 1 = 顶）
      float dz = vUv.y - bandY;
      // v4：光带收窄拉对比。拖尾 3.4→4.4、前缘 8.0→16.0，
      // 亮部只占画面很小一段，其余回到基线 → 扫过时才有「一道光划过」的锐利感。
      float below = exp(-max(dz, 0.0) * 4.4);                        // 已扫过（下方）：余晖
      float above = exp(-max(-dz, 0.0) * 16.0);                      // 未扫到（上方）：锐利前缘
      float pulse = mix(below, above, step(0.0, -dz)) * uFlow;

      vec3 ink = vec3(0.012, 0.017, 0.024);
      // 基线压到 0.52×（原 0.78×）：流光与静态线条的分离度靠「暗部更暗」撑起来
      float baseDim = mix(1.0, 0.52, clamp(uFlow * 1.15, 0.0, 1.0));
      vec3 lineCol = mix(ink, uLineColor * baseDim, lineLight);
      // 峰值 ~3.3×（原 2.15×），并朝白热轻微偏移：亮部更「烧」，与 0.52× 的暗部
      // 形成约 6.3:1 的亮度比（原 2.76:1），扫过的痕迹一眼可见。
      vec3 pulseCol = mix(uLineColor * (1.22 + 2.05 * pulse), vec3(1.0), pulse * 0.22);
      lineCol = mix(lineCol, pulseCol, pulse);
      // 混合系数随 pulse 推到 1：此前恒为 0.5~0.92，pulseCol 再亮也被腰斩——
      // 这正是「流光不够明显」的根因。现在光带处线条完全替换成 3.3× 白热色。
      col = mix(col, lineCol, edge * clamp(mix(0.92, 0.5, lineLight) * (1.0 + pulse * 1.4), 0.0, 1.0));

      // 反应堆核心：贴在装甲表面的真实 3D 光斑。
      // 关键在于「半径在哪量」：旧版用像素表面点到锚点的球面距离，胸口每处起伏都会
      // 改变半径，环被拉成歪七扭八、看起来不在一个平面上。
      // 现在把视线与舱口平面（uCoreNrm）求交，半径在**平面内**量 —— 环恒为正圆、
      // 与舱口严格共面；再用表面点的离面距离只做「粗遮挡」：
      // 手臂、抬起的护胸这类明显凸出的东西把光挡住，轻度起伏不参与。
      {
        vec3 camPos = uCamWorld[3].xyz;
        vec3 pSurf = worldAt(vUv);
        vec3 rd = pSurf - camPos;
        float den = dot(rd, uCoreNrm);
        float t = abs(den) > 1e-5 ? dot(uCoreWorld - camPos, uCoreNrm) / den : 0.0;
        vec3 pPlane = camPos + rd * t;
        float r = length(pPlane - uCoreWorld) / uCoreR;
        float along = dot(pSurf - uCoreWorld, uCoreNrm);   // >0 = 表面比舱口更靠外（凸出）
        float occl = smoothstep(uCoreR * uCoreWall, uCoreR * uCoreWall * 0.35, along);
        // 波纹要铺满整块胸甲，不能沿用光核那套紧贴舱口的遮挡（1.1R 就把波切死在晕边）。
        // 单独放宽到 3.6R：胸甲起伏、肩甲都能过，手臂这种明显挡在前面的东西仍然被挡。
        float occlWide = smoothstep(uCoreR * 3.6, uCoreR * 2.2, along);
        float beat = 0.86 + 0.14 * sin(uTime * 2.35);
        float core = exp(-r * r * 9.0);                               // 白热光核
        float halo = exp(-r * r * 2.2);                               // 冷青外晕
        // 自内向外扩散的能量波纹（替代旧呼吸环）：
        // 主冲击波 = 前缘极锐、内侧缓收的水波剖面，越过前缘的甲片先亮再熄，有推进感；
        // 再叠几道随主波外扩的同心细纹，扩散方向一眼可读。
        // 两者都乘纹路遮罩（上文法线/深度/亮度三路边缘，即甲片刻线）：
        // 刻线被推成白热、平板只留淡青雾 —— 波是顺着机甲纹路往外烧，而非孤立光圈。
        float trace = clamp(edge * 1.7, 0.0, 1.0);                    // 纹路遮罩：缝线处 1
        // 波纹最远半径（× 光斑半径）。默认 4.2 覆盖整块胸甲；
        // 调小（?ripmax=1.6）就只剩贴着光核的一圈涌出即灭，不再铺满胸口。
        float maxR = uRipMax;
        // 相位速率按 4.2/maxR 反比补偿：半径缩小后周期同步变短，波前推进速度保持不变，
        // 否则窄范围下会变成「慢慢爬出一点点」的怪动作。
        float ph1 = fract(uTime * 0.22 * (4.2 / maxR));               // 默认 4.5s 涌出一道
        float d1 = r - ph1 * maxR;
        float shock = mix(exp(-max(-d1, 0.0) * 6.0), exp(-max(d1, 0.0) * 24.0), step(0.0, d1))
                    * pow(1.0 - ph1, 1.25);
        // 同心细纹只在半径够大时才显形：窄范围里 sin 周期挤在一起会变成一堆乱圈，
        // 所以 maxR ≤ 2.2 时完全关掉细纹，只留主冲击波那一圈（ripmax 调小就是「一波即散」）。
        float ringsK = clamp((maxR - 2.2) / 1.4, 0.0, 1.0);
        float rings = pow(0.5 + 0.5 * sin(r * 5.2 - uTime * 4.0), 14.0) * exp(-r * 0.5) * ringsK;
        float rip = max(shock, rings * 0.9) * 2.3;
        vec3 coreCol = vec3(0.58, 0.90, 1.00);
        float k = uCoreOn * occl;
        float kw = uCoreOn * occlWide;
        // uCoreGain：整套辉光的总开关（可用 ?corefx=0 关掉）；
        // uCoreRip：只控波纹强度（?corerip=0 保留光核与静态辐射）
        // uCoreRad：静态辐射强度（沿刻线由内向外渐隐，不推进）
        float kg = k * uCoreGain;
        float kwg = kw * uCoreGain * uCoreRip;
        col += coreCol * (core * 2.40 + halo * 0.52) * beat * kg;
        col += vec3(1.0) * core * 0.95 * beat * kg;                   // 核心偏白，避免整块发青
        // ------------------------------------------------------------
        // 静态辐射：胸口由内向外渐亮再渐隐，不随时间推进、不成环。
        // 和波纹是两件事 —— 波纹是「一道波前扫过去」，这里是「胸甲一直被内芯烤着」，
        // 所以 ?corerip=0 关掉波纹后仍可单独开启（?corerad=1），保留辐射状亮度梯度。
        // 注意：亮线模式下线条本身已接近纯白，只做色相替换看不出来，
        // 必须同时给刻线加色（过曝成白热）和平板一层极轻底光，才有「内亮外暗」的观感。
        // ------------------------------------------------------------
        // 乘 beat：整体亮度随光核轻微呼吸（只变明暗，不动半径 —— 不会变成环）
        float radA = kw * uCoreGain * uCoreRad * beat;
        if (radA > 0.001) {
          float radFade = exp(-max(r - 0.55, 0.0) * 0.58);            // 光斑边缘起算，向外衰减（衰减越快、内外反差越明确）
          vec3 radTint = mix(vec3(0.96, 1.0, 1.0), coreCol * 1.05, smoothstep(0.5, 3.0, r));
          float lineW = clamp(trace * radFade * 1.25, 0.0, 0.95) * radA;
          col = mix(col, radTint, lineW * 0.75);                      // 刻线偏白热
          col += radTint * lineW * 0.45;                              // 再叠加 → 中心刻线真的溢出成光
          // 平板底光只给 0.16，刚好把线条连成一片光区，不至于糊成一块
          col += coreCol * radFade * 0.30 * radA * (0.30 + 0.70 * trace);
        }
        // 波纹：平板只留一层淡青雾（约 1/10 强度），刻线才是主要载体
        float ripLine = rip * exp(-r * 0.12);                         // 线条点亮单独放缓衰减，能跑到胸甲边缘
        col += coreCol * rip * (0.09 + 1.90 * trace) * 1.05 * kwg;
        // 关键：线条本身已接近纯白，加白只会溢出成同一片白 —— 必须「替换」而不是「叠加」。
        // 波前扫过的刻线被换成青白色，才真的看得出能量顺着纹路跑。
        vec3 ripTint = mix(coreCol * 1.05, vec3(1.0), 0.28);
        col = mix(col, ripTint, clamp(ripLine * trace * 2.2, 0.0, 0.9) * kwg);
      }

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
/**
 * 辅助体过滤：只认「叫 Plane 的那个地面片」（MK VII 里 2 个三角形）、
 * CreationNulCrew（自带的占位人形）、IK_char_ 前缀的贴图文字。
 * 千万不能宽匹配 /Plane/：反浩克的装甲部件大量叫 Plane002 / Plane004 / Plane010 …，
 * 它的整个头部（Base_HumanHead 下的 Plane002 / .001 / .006 / .008 / .036）
 * 和肋甲、骨盆、上臂、前臂、大腿、小腿都在这个前缀里 —— 宽匹配会把半个身子删掉。
 */
const JUNK = /^Plane$|CreationNulCrew|IK_char_/i;

/**
 * 结构线模式（?flat=1）：全部部件换成同一套素模材质。
 * 反浩克这类多材质模型经连通域切分后只剩首个三角形的材质，UV 与图集对不上，
 * 反照率会出现大片黑洞；直接丢掉贴图后只剩几何轮廓 + 深度边缘，两台装甲观感也一致。
 */
function flatten(root) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const side = (o.material && o.material.side) || THREE.FrontSide;
    let m = cache.get(side);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: 0x3a4653, metalness: 0.0, roughness: 0.86, side });
      cache.set(side, m);
    }
    o.material = m;
  });
}

/** 材质处理：降噪反照率 + 法线刻线 + 统一金属参数 */
function dress(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (!m) return;

    m.metalness = CONFIG.metal;
    m.roughness = 0.3;
    m.metalnessMap = null;      // 噪声贴图，交给常量
    m.roughnessMap = null;
    m.envMapIntensity = CONFIG.envInt;
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
      shader.uniforms.uNMLine = { value: state.showLine ? CONFIG.nmLine : 0.0 };
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
const splitTargetY = () => CONFIG.targetHeight * CONFIG.splitTargetY;

function resetView() {
  if (!model) return;
  const d = state.fit.dist * (state.split ? CONFIG.splitZoom : 1);
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
  if (mb !== undefined) ldText.textContent = `Loading armor model… ${mb} MB`;
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

    if (CONFIG.flat) flatten(root); else dress(root);

    let tris = 0, meshes = 0;
    root.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      meshes++;
      const g = o.geometry;
      tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
    });
    state.tris = Math.round(tris);

    root.updateMatrixWorld(true);   // 骨骼静止姿态需要 matrixWorld

    // 单块蒙皮网格 → 烘焙蒙皮 → 归一化 → 连通域岛屿 → 零件级拆分
    // （380 片甲片先各自成岛，再按「同区域 + 质心近 + 朝向近」合并成几十个零件，
    //   拆解时每片沿自己的朝向弹开，而不是 7 个大块整体平移）
    const armorMeshes = [];
    root.traverse((o) => { if (o.isMesh && o.visible) armorMeshes.push(o); });
    const pieces = splitArmorMeshes(armorMeshes, CONFIG.targetHeight);
    window.__splitStats = getSplitStats();

    const H = CONFIG.targetHeight;
    const UP = new THREE.Vector3(0, 1, 0);
    const group = new THREE.Group();
    state.modules = [];
    for (const [pid, piece] of pieces) {
      const region = piece.region;
      const def = SPLIT_DEFS[region] || { offset: [0, 0, 0], rotate: [0, 0, 0], stagger: 0 };
      const pivot = new THREE.Group();
      pivot.position.copy(piece.center);
      pivot.userData.moduleId = region;
      const mesh = new THREE.Mesh(piece.geometry, piece.material);
      mesh.userData.moduleId = region;
      pivot.add(mesh);
      group.add(pivot);

      // 弹出方向 = 从身体中心向外的径向（主）+ 甲片自身朝向（辅）
      // 纯按法线走会让正面甲片全往前挤、侧面全往外挤，从正面看是乱的；
      // 以躯干中轴为中心做球状扩散，层次才是干净的「拆开」而不是「炸开」。
      // 径向只取水平分量：如果连高度一起算，脚部件的径向几乎是垂直向下，
      // 拆开时整只脚会往下掉出画面。水平径向 + 甲片法线里的 y 分量才自然。
      const radial = new THREE.Vector3(piece.center.x, 0, piece.center.z);
      const rlen = piece.center.distanceTo(new THREE.Vector3(0, H * 0.55, 0));
      if (radial.lengthSq() > 1e-6) radial.normalize(); else radial.set(0, 1, 0);
      // 甲片朝向为主 + 身体径向为辅：每片沿自己的装配法线脱开，
      // 整体轮廓仍是「人形膨胀」，不会散成零件云 —— 这是拆甲和爆炸图的区别。
      const regDir = new THREE.Vector3(...def.offset);
      if (regDir.lengthSq() > 1e-8) regDir.normalize(); else regDir.set(0, 1, 0);
      const dir = piece.normal.clone().multiplyScalar(0.58)
        .addScaledVector(radial, 0.42)
        .addScaledVector(regDir, 0.12);   // 区域方向的少量偏置：同区域整体略微同向
      if (dir.y < -0.4) { dir.y = -0.4; }   // 脚底件不许垂直下坠，否则会掉出取景
      if (dir.lengthSq() < 1e-8) dir.copy(UP); else dir.normalize();
      // 离身体中心越远走得越开（幂次 >1 抑制极端值），外轮廓呈柔和球状
      const rNorm = Math.min(0.9, rlen / (H * 0.62));   // 上限 0.9：脚这类远端件别飞太远

      // 掀盖轴：绕水平轴翻一个小角度，甲片像卸下螺丝那样抬起而不是平移
      const axis = new THREE.Vector3().crossVectors(dir, UP);
      if (axis.lengthSq() < 1e-6) axis.set(1, 0, 0); else axis.normalize();
      // 稳定伪随机：同一片每次拆装姿态一致（range 0..1）
      const h = Math.sin(piece.center.x * 73.1 + piece.center.y * 41.7 + piece.center.z * 57.3) * 43758.5453;
      const rnd = h - Math.floor(h);
      const tilt = (0.035 + 0.085 * rnd) * (rnd > 0.5 ? 1 : -1);

      const quat = new THREE.Quaternion().setFromAxisAngle(axis, tilt);
      quat.multiply(new THREE.Quaternion().setFromEuler(
        new THREE.Euler(def.rotate[0], def.rotate[1], def.rotate[2])));

      state.modules.push({
        id: pid,
        pivot,
        base: piece.center.clone(),
        off: dir.multiplyScalar(H * (0.072 + 0.112 * Math.pow(rNorm, 1.4)))
                .addScaledVector(regDir, H * 0.06),
        quat,
        // 拆解节奏：区域顺序 + 由高到低，像自上而下逐层卸甲
        stagger: (1 - piece.center.y / H) * 0.74 + def.stagger * 0.16,   // 高处先脱开，自上而下卸甲
        t: 0,
        anim: null,
      });
    }
    scene.add(group);
    // 反应堆锚点：胸口前表面。必须在设初始朝向前算（此时 group 无旋转），
    // 否则 Box3 会把 rotation 也算进去，锚点跟着偏。
    {
      group.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(group);
      const h = bb.max.y - bb.min.y;
      const cx = (bb.min.x + bb.max.x) / 2;
      const y = bb.min.y + h * CONFIG.coreY;
      // x 允许偏移（coreX × 身高）：反浩克的反应堆舱口不在模型中线上，
      // 从正中打射线会先命中凸起的胸甲、吸附到错误位置。
      const ax = cx + h * CONFIG.coreX;
      // 从正前方朝 -Z 打射线，把锚点吸附到胸甲「真实外表面」——
      // bbox 深度比例猜出来的点会嵌进身体（光核半径小于嵌入深度时前表面照不到光），
      // 吸附后 r=0 的亮核正好落在反应堆位置。
      const probe = new THREE.Raycaster(
        new THREE.Vector3(ax, y, bb.max.z + h),
        new THREE.Vector3(0, 0, -1),
      );
      const hit = probe.intersectObject(group, true)[0];
      state.coreBase = hit
        ? hit.point.clone()
        : new THREE.Vector3(ax, y, bb.max.z * CONFIG.coreZ);
      // 光斑半径按真实身高换算（世界单位）：缩放 / 换模型都自动适配
      edgeMat.uniforms.uCoreR.value = h * CONFIG.coreR;
      // 舱口局部均值面：锚点 + 周围 4 点各打一条射线，把命中的面法线做面积平均。
      // 胸口不是平的——光斑若按纯球面距离衰减，凸凹的邻面也会被照亮，
      // 圆环看起来歪歪扭扭不在一个平面上；给着色器这个平面法线后，
      // 光斑按「面内半径 + 离面容差」绘制，环严格贴着舱口所在的平面。
      {
        const nm3 = new THREE.Matrix3();
        const nSum = new THREE.Vector3();
        const addN = (h2) => {
          if (!h2 || !h2.face) return;
          nm3.getNormalMatrix(h2.object.matrixWorld);
          nSum.add(h2.face.normal.clone().applyMatrix3(nm3));
        };
        addN(hit);
        const rr = edgeMat.uniforms.uCoreR.value * 0.85;
        for (const [ox, oy] of [[rr, 0], [-rr, 0], [0, rr], [0, -rr]]) {
          const p2 = new THREE.Raycaster(
            new THREE.Vector3(ax + ox, y + oy, bb.max.z + h),
            new THREE.Vector3(0, 0, -1),
          );
          addN(p2.intersectObject(group, true)[0]);
        }
        state.coreNrm = nSum.lengthSq() > 1e-6
          ? nSum.normalize()
          : new THREE.Vector3(0, 0, 1);
        // 朝前（+Z）：射线是从正前方打的，舱口法线必然朝观众。
        // 反浩克这类模型大量节点用负缩放做镜像，hit.face.normal 经 normalMatrix
        // 变换后会朝内（-Z），不翻转的话整块胸甲都会被判成「挡住光晕」，
        // 光斑只剩中心一个白点。
        if (state.coreNrm.z < 0) state.coreNrm.negate();
        edgeMat.uniforms.uCoreNrm.value.copy(state.coreNrm);
      }
    }
    group.rotation.y = THREE.MathUtils.degToRad(CONFIG.rot0);
    model = group;

    frameCamera(CONFIG.targetHeight);
    resetView();

    $('st-tris').textContent = state.tris.toLocaleString('en-US');
    const ms = Math.round(performance.now() - t0);
    ldText.textContent = `${meshes} ${meshes === 1 ? 'part' : 'parts'} · ${ms} ms`;
    setProgress(1);
    setTimeout(() => loaderEl.classList.add('done'), 220);

    state.ready = true;
    console.info('[MK7] meshes:', meshes, 'tris:', state.tris, 'load ms:', ms);
    // 嵌入模式：通知宿主页（jarvis-console）装甲已就绪，可以把 iframe 揭开
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

// 反应堆投影用的临时对象（避免每帧分配）
const _upAxis = new THREE.Vector3(0, 1, 0);
const _coreWorld = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _fwd = new THREE.Vector3();

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
    if (m.quat) m.pivot.quaternion.identity().slerp(m.quat, m.t);
    else m.pivot.rotation.set(m.rot.x * m.t, m.rot.y * m.t, m.rot.z * m.t);
  }

  edgeMat.uniforms.uStrength.value = state.showLine ? state.strength : 0;
  edgeMat.uniforms.uThickness.value = state.width;
  edgeMat.uniforms.uLight.value = state.invert ? 1 : 0;
  edgeMat.uniforms.uSurface.value = state.surface;
  state.time += dt;
  edgeMat.uniforms.uTime.value = state.time;
  // 流光强度朝目标缓动（约 0.4s 淡入/淡出）：开关切换时不闪一下
  const flowUni = edgeMat.uniforms.uFlow;
  flowUni.value += ((state.flow ? 0.9 : 0) - flowUni.value) * Math.min(1, dt * 6.5);

  // 反应堆核心投影：锚点绕 Y 轴跟随模型自转 → 世界坐标。
  // 位置交给 shader 按 3D 距离判定，这里只负责把锚点放到正确的世界位置。
  if (model && state.coreBase) {
    const ry = model.rotation.y;
    _coreWorld.copy(state.coreBase).applyAxisAngle(_upAxis, ry);
    edgeMat.uniforms.uCoreWorld.value.copy(_coreWorld);
    // 平面法线同样要跟着模型转，否则面内半径会算错方向
    if (state.coreNrm) {
      edgeMat.uniforms.uCoreNrm.value.copy(state.coreNrm).applyAxisAngle(_upAxis, ry);
    }
    // 3D 距离已能裁掉背面像素；这里只兜住「薄壳模型没有背面几何」的极端情况
    const facing = _toCam.copy(camera.position).sub(_coreWorld).normalize()
      .dot(_fwd.set(Math.sin(ry), 0, Math.cos(ry)));
    const on = facing > -0.05 ? 1 : 0;
    edgeMat.uniforms.uCoreOn.value += (on - edgeMat.uniforms.uCoreOn.value) * Math.min(1, dt * 8);
  }

  // 背景动画：闪烁 / 光柱起伏 + 扫描环垂直往返
  if (state.bg) {
    bgFx.uTime.value = state.time;
    for (const r of bgFx.rings) {
      const w = state.time * r.speed + r.phase;
      // 三角波为主（全程近匀速）+ 22% 余弦（只给折返处一点柔性）。
      // 纯余弦会在两端速度趋零，环在顶/底「停留」近半秒才起步 —— 看起来像卡顿。
      const TAU = Math.PI * 2;
      const u = ((w % TAU) + TAU) % TAU;
      const tri = u < Math.PI ? u / Math.PI : 2 - u / Math.PI;   // 0→1→0 线性
      const p = tri * 0.78 + (0.5 - 0.5 * Math.cos(w)) * 0.22;
      r.mesh.position.y = r.min + (r.max - r.min) * p;
      // 扫描环能量渐变：前沿朝向 = 运动方向；白热强度在折返处短暂压暗
      const vel = Math.sin(w);
      r.mesh.material.uniforms.uDir.value = vel >= 0 ? 1 : -1;
      r.mesh.material.uniforms.uHot.value = Math.min(1, Math.abs(vel) * 1.4);
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
  b.textContent = on ? 'BRIGHT' : 'DIM';
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
  b.textContent = state.split ? 'MERGE' : 'SPLIT';
  b.classList.toggle('on', state.split);

  // 相机后拉 + 视点上移 / 复位
  state.zoomAnim = {
    fromD: camera.position.distanceTo(controls.target),
    toD: state.fit.dist * (state.split ? CONFIG.splitZoom : 1),
    fromY: controls.target.y,
    toY: state.split ? splitTargetY() : state.fit.targetY,
    t0: now,
    dur: 1100,
  };
}

function initUI() {
  // 把 state 的初值同步到控件（高面数模型可通过 data-str / data-wid 调低线条强度）
  $('rg-strength').value = String(state.strength);
  $('st-line').textContent = Math.round(state.strength * 100) + '%';
  $('rg-width').value = String(state.width);
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
    syncBgColor();   // 背景（含扫描环尾迹色）随线条颜色联动
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

  // 贾维斯背景不再自动启用：那个形态已独立成 jarvis-console.html。
  // 本页保留 J 键 / 「贾维斯」按钮，按需切换到叠加模式。

  addEventListener('resize', onResize);
}

/* ------------------------------------------------------------------ */
initUI();
syncBgColor();   // 初始化扫描环尾迹派生色（默认线色下也能拉出冷—白层次）
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

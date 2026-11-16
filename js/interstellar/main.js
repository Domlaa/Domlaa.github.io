/**
 * INTERSTELLAR · ENDURANCE / LANDER —— 背部对接盘 + 分离演示
 *
 * 1 单位 = 1.0667 m（环半径 30 单位 ↔ 实际 32 m，整环直径 64 m）
 * 环平面 = YZ，自转轴 = X；lander 机头朝 -Z、尾朝 +Z（原始模型），
 * 归一化时绕 Y 转 180°，约定 rig 局部 +Z = 机头方向，原点 = 机头顶点。
 *
 * 对接方式照电影：登陆艇的对接盘在**机背顶部**，机体与环面垂直地贴到环的
 * 轴向侧面上，机头顺着环的转动方向。机背对接点由模型实测，落到程序化生成的
 * 对接盘口面；分离是沿 +X 垂直退出，机身同时随环一起公转。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// <script type="module"> 里 document.currentScript 为 null，按属性反查入口节点
const script = document.querySelector('script[data-endurance]');
const CFG = {
  endurance: script.dataset.endurance,
  lander: script.dataset.lander,

  ringRadius: 30,          // 归一化后的环外半径（单位）
  landerLength: 18,        // 归一化后的 lander 全长（单位）

  // 对接位（环局部系，环心 = 0）。环上 12 个货舱每 30° 一个，各舱在 +X 侧的
  // 轴向面实测在 x ≈ 6.35，且 r ∈ [14, 21] 一段是平的，正好放得下对接盘。
  dockDeg: 300,            // 对接舱在环平面内的角度（度，自 +Z 向 +Y）
  dockR: 18.5,             // 对接盘中心到环心的距离
  padX: 6.35,              // 舱体 +X 轴向面的 x（对接盘底座）
  padH: 2.4,               // 对接筒高度 = 机背平台离舱面的距离（电影里那段明显的对接筒）
  noseMode: 'tangent',     // 机头朝向：tangent = 顺转动方向 / out = 径向朝外 / in = 径向朝内

  spin: 0.05,              // 默认环自转 rad/s
  transit: 4.4,            // 默认机动时长 s
  metersPerUnit: 32 / 30,

  // 分离后的泊位（相对对接口，环局部系）：沿 +X 垂直退出，再切向侧移 + 径向抬升
  park: { axial: 9, lateral: 15, radial: 5 },
};

// 调试用：?deg=210&r=18.5&padx=6.35 可覆盖对接位
{
  const q = new URLSearchParams(location.search);
  if (q.has('deg')) CFG.dockDeg = Number(q.get('deg'));
  if (q.has('r')) CFG.dockR = Number(q.get('r'));
  if (q.has('padx')) CFG.padX = Number(q.get('padx'));
  if (q.has('ax')) CFG.park.axial = Number(q.get('ax'));
  if (q.has('nose')) CFG.noseMode = q.get('nose');
}

/* ---------------- 渲染器 / 场景 ---------------- */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 0.8;
controls.minDistance = 26;
controls.maxDistance = 460;
controls.enablePan = false;

// 光照：暖侧主光 + 冷补光 + 顶背轮廓光，模拟远处恒星
const key = new THREE.DirectionalLight(0xfff6ec, 1.95); key.position.set(-1.1, 0.85, 1.25);
const fill = new THREE.DirectionalLight(0x9cc2ff, 0.6); fill.position.set(1.2, -0.55, -0.75);
const rim = new THREE.DirectionalLight(0xffffff, 1.25); rim.position.set(0.25, 1.0, -1.1);
const amb = new THREE.HemisphereLight(0x9fc2e8, 0x0a0f16, 0.32);
// 沿对接轴 +X 侧的补光：让停在轮毂前方的登陆艇不至于只剩剪影
const shore = new THREE.DirectionalLight(0xf4f7ff, 2.1); shore.position.set(1.7, 0.45, -0.35);
scene.add(key, fill, rim, amb, shore);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
scene.environmentIntensity = 0.8;

/* ---------------- 星空 ---------------- */
(function stars() {
  const N = 2800;
  const pos = new Float32Array(N * 3);
  const col = new Float32Array(N * 3);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    // 球壳内均匀分布
    const u = Math.random() * 2 - 1;
    const th = Math.random() * Math.PI * 2;
    const r = 780 + Math.random() * 1500;
    const s = Math.sqrt(1 - u * u);
    pos[i * 3] = r * s * Math.cos(th);
    pos[i * 3 + 1] = r * u;
    pos[i * 3 + 2] = r * s * Math.sin(th);
    // 少量偏蓝/偏暖的星，其余接近白
    const t = Math.random();
    const b = 0.35 + Math.pow(Math.random(), 2.2) * 0.65;
    if (t > 0.86) c.setRGB(1, 0.86, 0.72);
    else if (t > 0.7) c.setRGB(0.78, 0.86, 1);
    else c.setRGB(0.92, 0.96, 1);
    col[i * 3] = c.r * b; col[i * 3 + 1] = c.g * b; col[i * 3 + 2] = c.b * b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({
    size: 2.4, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.95, depthWrite: false,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  scene.add(p);
})();

/* ---------------- 模型装载 ---------------- */
const ringPivot = new THREE.Group();   // 绕 X 自转
scene.add(ringPivot);

const landerRig = new THREE.Group();   // 原点 = 机头，+Z = 机头朝向
scene.add(landerRig);

const collar = new THREE.Group();      // 对接环（程序化生成，作为可视锚点）
const glowMats = [];

const el = id => document.getElementById(id);
const loaderEl = el('loader'), pctEl = el('pct'), progEl = el('prog');

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, loaded, total) => {
  const p = Math.round((loaded / Math.max(total, 1)) * 100);
  pctEl.textContent = p + '%';
  progEl.style.strokeDashoffset = String(214 - (214 * p) / 100);
};

const draco = new DRACOLoader().setDecoderPath('./lib/three/addons/libs/draco/');
const loader = new GLTFLoader(manager).setDRACOLoader(draco);

/** 归一化：缩放到指定外径/长度，并把包围盒中心（或机头）移到原点 */
function normalize(obj, targetMax, axisOfMax, anchor) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const k = targetMax / size[axisOfMax];
  obj.scale.multiplyScalar(k);
  obj.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(obj);
  const c = b2.getCenter(new THREE.Vector3());
  if (anchor === 'nose') {
    // 机头在最 +Z 端
    obj.position.set(-c.x, -c.y, -b2.max.z);
  } else {
    obj.position.set(-c.x, -c.y, -c.z);
  }
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

function dressMaterials(root, envInt, metalCap) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.envMapIntensity = envInt;
      if (typeof m.metalness === 'number') {
        const cap = metalCap === undefined ? 0.9 : metalCap;
        if (m.metalness > cap) m.metalness = cap;
      }
      if (m.map) m.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
  });
}

/* ---------------- 对接点 / 泊位姿态 ---------------- */
const dockLocal = {
  pos: new THREE.Vector3(),             // 对接时 rig 原点（机头）在环局部系的位置
  quat: new THREE.Quaternion(),         // 对接时 rig 朝向（环局部系）
  normal: new THREE.Vector3(1, 0, 0),   // 对接口外法线（环局部 = +X，背向环心）
  port: new THREE.Vector3(),            // 对接盘口面中心（环局部）
  hatch: new THREE.Vector3(),           // 机背对接点在 rig 局部系的位置（模型实测）
};

/** 由 forward/up 构造「+Z = forward」的朝向 */
function quatFromForwardUp(forward, up) {
  const z = forward.clone().normalize();
  const x = new THREE.Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * 量出机背顶部那块平面（对接盘落座面）的中心：
 * 取最高 6% 高度内的顶点重心，返回 rig 局部系的落座点（y = 顶面高度）。
 */
function findDorsalHatch(root) {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const pts = [];
  let ymax = -Infinity, ymin = Infinity;
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += 2) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      pts.push(v.x, v.y, v.z);
      if (v.y > ymax) ymax = v.y;
      if (v.y < ymin) ymin = v.y;
    }
  });
  const lim = ymax - (ymax - ymin) * 0.06;
  let sx = 0, sz = 0, n = 0, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] < lim) continue;
    sx += pts[i]; sz += pts[i + 2]; n++;
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    z0 = Math.min(z0, pts[i + 2]); z1 = Math.max(z1, pts[i + 2]);
  }
  if (!n) {
    const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    return { point: c, w: 0, l: 0 };
  }
  return { point: new THREE.Vector3(sx / n, ymax, sz / n), w: x1 - x0, l: z1 - z0 };
}

function computeDock(hatch) {
  const a = THREE.MathUtils.degToRad(CFG.dockDeg);
  const radial = new THREE.Vector3(0, Math.sin(a), Math.cos(a)).normalize();
  // 环绕 +X 自转时该点速度方向 = ω × r = (0, -cos a, sin a)
  const tangent = new THREE.Vector3(0, -Math.cos(a), Math.sin(a)).normalize();
  const nose = CFG.noseMode === 'out' ? radial.clone()
    : CFG.noseMode === 'in' ? radial.clone().negate()
      : tangent;

  dockLocal.hatch.copy(hatch.point);
  dockLocal.normal.set(1, 0, 0);
  dockLocal.port.copy(radial).multiplyScalar(CFG.dockR).setX(CFG.padX + CFG.padH);

  // 机背（局部 +Y）朝 -X 贴住舱面 → 机体与环面垂直、腹部朝外
  dockLocal.quat.copy(quatFromForwardUp(nose, new THREE.Vector3(-1, 0, 0)));
  // rig 原点 = 机头，位置由「机背落座点正好压在口面上」反推
  dockLocal.pos.copy(dockLocal.port).sub(hatch.point.clone().applyQuaternion(dockLocal.quat));
  return { radial, tangent };
}

/**
 * 机背对接盘：贴在货舱 +X 轴向面上的安装板 + 一圈对接筒 + 发光环 + 4 个夹爪。
 * collar 的 +Z = +X（背离环心），与 dockLocal.normal 一致。
 */
function buildCollar() {
  const metal = new THREE.MeshStandardMaterial({ color: 0xb8c3cd, metalness: 0.55, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a333c, metalness: 0.8, roughness: 0.42 });
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x0b1218, metalness: 0.7, roughness: 0.3,
    emissive: new THREE.Color(0x5fd0ff), emissiveIntensity: 0.9,
  });
  glowMats.push(ringMat);

  const padR = 4.2;
  // 安装板：压在舱体轴向面上，比机背平台略大一圈，像个「停机坪」
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(padR, padR * 0.95, 0.34, 64), metal);
  plate.rotation.x = Math.PI / 2;
  plate.position.z = -0.17;
  const plateRing = new THREE.Mesh(new THREE.TorusGeometry(padR - 0.16, 0.075, 10, 72), dark);
  plateRing.position.z = 0.005;

  // 对接筒：机背平台落座的位置，把落差收在筒壁里
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(2.08, 2.3, CFG.padH, 44, 1, true), metal);
  tube.rotation.x = Math.PI / 2;
  tube.position.z = CFG.padH / 2;
  tube.material = metal.clone();
  tube.material.side = THREE.DoubleSide;

  // 两道发光环：筒口 + 安装板内侧
  const rim = new THREE.Mesh(new THREE.TorusGeometry(2.12, 0.085, 10, 56), ringMat);
  rim.position.z = CFG.padH - 0.02;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(3.05, 0.07, 10, 64), ringMat);
  inner.position.z = 0.02;

  // 4 个夹爪：绕筒口均布，分离时沿 +Z 抬起
  const clamps = new THREE.Group();
  const cz = Math.max(0.2, CFG.padH - 0.12);
  for (let i = 0; i < 4; i++) {
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.9, 0.36), dark);
    arm.position.set(Math.cos(ang) * 2.55, Math.sin(ang) * 2.55, cz);
    arm.userData.z0 = cz;
    arm.rotation.z = ang - Math.PI / 2;
    clamps.add(arm);
  }

  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: beaconTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.16,
  }));
  beacon.scale.setScalar(6);
  beacon.position.z = CFG.padH + 0.15;
  collar.userData.beacon = beacon;

  collar.add(plate, plateRing, tube, rim, inner, clamps, beacon);
  collar.userData.clamps = clamps;

  const a = THREE.MathUtils.degToRad(CFG.dockDeg);
  collar.position.set(CFG.padX + 0.01, Math.sin(a) * CFG.dockR, Math.cos(a) * CFG.dockR);
  collar.quaternion.copy(quatFromForwardUp(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
  ringPivot.add(collar);
}

/* ---------------- 机动状态 ---------------- */
const app = {
  prog: 0,              // 0 = 完全对接，1 = 完全分离
  tween: null,          // { from, to, t, dur, done }
  auto: false,
  spinOn: true,
  spinRate: CFG.spin,
  spinPhase: 0,
  transit: CFG.transit,
  free: null,           // { pos, quat, ctrl } 世界系泊位
  autoFrame: true,
  lastRange: 0,
  closure: 0,
  flash: 0,
};

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function nowWorldDock() {
  const ringQ = ringPivot.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const pos = ringPivot.localToWorld(dockLocal.pos.clone());
  const quat = ringQ.clone().multiply(dockLocal.quat.clone());
  const port = ringPivot.localToWorld(dockLocal.port.clone());
  // 对接口法线 / 径向 / 切向：环只绕 X 转，法线在世界系里恒为 +X
  const normal = dockLocal.normal.clone().applyQuaternion(ringQ).normalize();
  const radial = dockLocal.port.clone().setX(0).normalize().applyQuaternion(ringQ).normalize();
  const tangent = new THREE.Vector3().crossVectors(normal, radial).normalize();
  // 机背落座点在世界系的位置（遥测/辅助线用）
  const hatch = landerRig.localToWorld(dockLocal.hatch.clone());
  return { pos, quat, port, normal, radial, tangent, hatch };
}

function makeFreePose(dockW) {
  const n = dockW.normal;
  const rad = dockW.radial;
  const tan = dockW.tangent;

  // 泊位：沿对接法线退出 park.axial，再切向侧移 + 径向外抬
  const pos = dockW.pos.clone()
    .addScaledVector(n, CFG.park.axial)
    .addScaledVector(tan, CFG.park.lateral)
    .addScaledVector(rad, CFG.park.radial);
  // 退出后转向：机头从「顺环转动」转到「朝外」，带一点侧倾
  const quat = quatFromForwardUp(n, rad)
    .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(0.18, 0, -0.26, 'YXZ')));
  // 控制点几乎全压在法线上 → 贝塞尔头段是垂直退出（脱离对接筒）
  const ctrl = dockW.pos.clone()
    .addScaledVector(n, Math.max(2.6, CFG.park.axial * 0.42))
    .addScaledVector(tan, CFG.park.lateral * 0.06)
    .addScaledVector(rad, CFG.park.radial * 0.06);
  return { pos, quat, ctrl, tangent: tan, normal: n, radial: rad };
}

function startTween(to, done) {
  // 每次分离都按「当下的」环姿态重算泊位，否则环转过之后旧泊位会与环体错位
  if (to === 1) app.free = makeFreePose(nowWorldDock());
  app.tween = { from: app.prog, to, t: 0, dur: app.transit, done: done || null };
  setStatus(to === 1 ? 'UNDOCKING · BACK OFF' : 'APPROACH · DORSAL ALIGN');
  if (to === 0) setClamps('OPEN', 'warn');
}

const clampsEl = () => el('tl-clamps');

function setClamps(text, cls) {
  const n = clampsEl();
  n.textContent = text;
  n.className = cls || 'ok';
}

const statusEl = () => el('tl-status');
function setStatus(text) { statusEl().textContent = text; }

function bindUI() {
  const btnToggle = el('btn-toggle');
  const btnAuto = el('btn-auto');
  const btnSpin = el('btn-spin');

  btnToggle.addEventListener('click', () => {
    toggle(!(app.tween ? app.tween.to === 1 : app.prog > 0.5));
  });
  btnAuto.addEventListener('click', () => {
    app.auto = !app.auto;
    btnAuto.classList.toggle('on', app.auto);
    if (!app.auto) { clearTimeout(autoTimer); return; }
    if (!app.tween) runManoeuvre(app.prog < 0.5 ? 1 : 0);
  });
  btnSpin.addEventListener('click', () => {
    app.spinOn = !app.spinOn;
    btnSpin.classList.toggle('on', app.spinOn);
    el('tl-spin').textContent = (app.spinOn ? app.spinRate : 0).toFixed(3) + ' rad/s';
  });
  el('btn-reset').addEventListener('click', () => { app.autoFrame = true; frameView(true); });
  el('btn-full').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  const rngSpin = el('rg-spin');
  rngSpin.value = String(Math.round((CFG.spin / 0.12) * 100));
  const applySpin = () => { app.spinRate = (Number(rngSpin.value) / 100) * 0.12; updateSpinReadout(); };
  rngSpin.addEventListener('input', applySpin);
  applySpin();

  const rngRate = el('rg-rate');
  const applyRate = () => {
    app.transit = THREE.MathUtils.mapLinear(Number(rngRate.value), 20, 100, 7.6, 2.3);
  };
  rngRate.addEventListener('input', applyRate);
  applyRate();

  controls.addEventListener('start', () => { app.autoFrame = false; });

  addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); btnToggle.click(); }
    else if (e.key === 'a' || e.key === 'A') btnAuto.click();
    else if (e.key === 's' || e.key === 'S') btnSpin.click();
    else if (e.key === 'r' || e.key === 'R') el('btn-reset').click();
    else if (e.key === 'f' || e.key === 'F') el('btn-full').click();
  });
  canvas.addEventListener('dblclick', () => { app.autoFrame = true; frameView(true); });
}

function updateSpinReadout() {
  el('tl-spin').textContent = (app.spinOn ? app.spinRate : 0).toFixed(3) + ' rad/s';
}

/** 一次完整机动：按钮文案 + 收尾状态 +（自动模式下）排下一次 */
function runManoeuvre(to) {
  el('btn-toggle').textContent = to === 1 ? 'DOCK' : 'SEPARATE';
  startTween(to, () => {
    if (to === 0) {
      app.flash = 1;
      setClamps('LOCKED', 'ok');
      setStatus('DOCKED · CLAMPS LOCKED');
    } else {
      setClamps('OPEN', 'warn');
      setStatus('FREE FLIGHT · HOLD');
    }
    if (app.auto) scheduleAuto();
  });
}

function toggle(separate) {
  if (app.tween) return;
  runManoeuvre(separate ? 1 : 0);
}

let autoTimer = 0;
function scheduleAuto() {
  clearTimeout(autoTimer);
  if (!app.auto) return;
  // 下一步动作在「本次完成时」决定：对接完 → 分离，分离完 → 对接
  const next = app.prog < 0.5 ? 1 : 0;
  autoTimer = setTimeout(() => {
    if (!app.auto || app.tween) return;
    runManoeuvre(next);
  }, next === 1 ? 3200 : 3600);
}

/* ---------------- 取景 ---------------- */
// 沿对接轴偏 60° 左右看：环面仍是椭圆（读得出是环站），轴向动作也能看清
const VIEW_DIR = new THREE.Vector3(0.7, 0.32, 0.85).normalize();
const FRAME_TARGET = new THREE.Vector3(3, 0, 0);

/** 竖屏时水平视角更窄，取横向/纵向两者中更远的那一个距离，保证不裁边 */
function fitDistance(radius) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dv = radius / Math.sin(vFov / 2);
  // 竖屏：横向按 0.86 倍取景，避免环体在手机上缩得太小而四周大片留白
  const dh = (radius * (camera.aspect < 1 ? 0.86 : 1)) / Math.sin(hFov / 2);
  return Math.max(dv, dh) * 0.92;
}

function frameView(hard) {
  const dist = fitDistance(30 + 9 * app.prog);
  if (hard) {
    controls.target.copy(FRAME_TARGET);
    camera.position.copy(VIEW_DIR).multiplyScalar(dist).add(FRAME_TARGET);
    camera.lookAt(FRAME_TARGET);
  }
}

/* ---------------- 主循环 ---------------- */
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

function update(dt) {
  // 环自转
  if (app.spinOn) app.spinPhase += dt * app.spinRate;
  ringPivot.rotation.x = app.spinPhase;
  ringPivot.updateMatrixWorld(true);

  // 机动推进
  if (app.tween) {
    const tw = app.tween;
    tw.t = Math.min(1, tw.t + dt / tw.dur);
    app.prog = tw.from + (tw.to - tw.from) * easeInOut(tw.t);
    if (tw.t >= 1) {
      app.prog = tw.to;
      app.tween = null;
      const cb = tw.done; tw.done = null;
      if (cb) cb();
    }
  }

  const dockW = nowWorldDock();
  const s = app.prog;
  const free = app.free;

  if (s <= 1e-4) {
    landerRig.position.copy(dockW.pos);
    landerRig.quaternion.copy(dockW.quat);
  } else if (s >= 1 - 1e-4 && free) {
    // 自由漂浮的轻微起伏（不影响下一次对接，因为对接时全程插值回 dockW）
    const t = performance.now() * 0.0006;
    landerRig.position.copy(free.pos)
      .addScaledVector(free.normal, Math.sin(t * 1.7) * 0.45)
      .addScaledVector(free.tangent, Math.cos(t * 1.13) * 0.35);
    landerRig.quaternion.copy(free.quat);
  } else if (free) {
    // 二次贝塞尔 + 四元数插值
    const a = dockW.pos, b = free.pos, c = free.ctrl;
    const it = 1 - s;
    tmpV.set(0, 0, 0)
      .addScaledVector(a, it * it)
      .addScaledVector(c, 2 * it * s)
      .addScaledVector(b, s * s);
    landerRig.position.copy(tmpV);
    // 前 24% 姿态不动 → 先垂直退出对接筒，离开舱面后才转向（退坞的典型动作）
    const rotS = THREE.MathUtils.smoothstep(s, 0.24, 1.0);
    tmpQ.copy(dockW.quat).slerp(free.quat, rotS);
    // 退出过程中的轻微摆动；两端归零，避免破坏落座姿态
    // premultiply = 绕世界轴旋转（multiply 会被当成物体局部轴）
    const wob = Math.sin(Math.PI * s) * 0.16;
    tmpQ.premultiply(new THREE.Quaternion().setFromAxisAngle(free.radial, wob));
    landerRig.quaternion.copy(tmpQ);
  } else {
    landerRig.position.copy(dockW.pos);
    landerRig.quaternion.copy(dockW.quat);
  }

  landerRig.updateMatrixWorld(true);

  // 遥测：以「机背落座点 ↔ 对接盘口面」为基准
  const hatchW = landerRig.localToWorld(dockLocal.hatch.clone());
  const off = hatchW.clone().sub(dockW.port);
  const axialOff = off.dot(dockW.normal);
  const latOff = off.clone().addScaledVector(dockW.normal, -axialOff).length();
  const rangeM = off.length() * CFG.metersPerUnit;
  const closure = (rangeM - app.lastRange) / Math.max(dt, 1e-3);
  app.lastRange = rangeM;
  app.closure += (Math.abs(closure) - app.closure) * Math.min(1, dt * 6);

  // 机背法线（rig 局部 +Y）与「指向环内」的夹角：0° = 完全落座
  const dorsal = new THREE.Vector3(0, 1, 0).applyQuaternion(landerRig.quaternion).normalize();
  const alignDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(dorsal.dot(dockW.normal.clone().negate()), -1, 1)));

  el('tl-range').textContent = rangeM.toFixed(rangeM < 100 ? 1 : 0) + ' m';
  el('tl-closure').textContent = app.closure.toFixed(1) + ' m/s';
  const alignEl = el('tl-align');
  alignEl.textContent = alignDeg.toFixed(1) + '°';
  alignEl.className = alignDeg < 2 ? 'ok' : alignDeg < 10 ? '' : 'warn';
  const offEl = el('tl-roll');
  if (offEl) {
    const offM = latOff * CFG.metersPerUnit;
    offEl.textContent = app.prog < 0.02 ? 'SEATED' : offM.toFixed(1) + ' m';
    offEl.className = latOff < 0.06 ? 'ok' : latOff < 0.8 ? '' : 'warn';
  }

  if (app.tween && app.tween.to === 0) setStatus(app.tween.t < 0.55 ? 'APPROACH · DORSAL ALIGN' : 'FINAL · CLAMPING');

  // 对接适配环姿态 / 夹爪 / 呼吸
  if (app.flash > 0) app.flash = Math.max(0, app.flash - dt * 1.4);
  const breathe = 0.72 + Math.sin(performance.now() * 0.0022) * 0.14;
  for (const m of glowMats) m.emissiveIntensity = breathe + app.flash * 3.2;
  const cs = 1 + app.flash * 0.06;
  collar.scale.setScalar(cs);
  const beacon = collar.userData.beacon;
  if (beacon) {
    beacon.material.opacity = 0.1 + Math.max(0, Math.sin(performance.now() * 0.0018)) * 0.1 + app.flash * 0.55;
    beacon.scale.setScalar(7 + app.flash * 3.5);
  }
  collar.userData.clamps.children.forEach(arm => {
    const open = THREE.MathUtils.clamp(app.prog * 1.6, 0, 1);
    arm.position.z = arm.userData.z0 + open * 0.45;
  });

  // 引擎辉光
  const thr = app.tween ? Math.sin(Math.PI * THREE.MathUtils.clamp(app.tween.t, 0, 1)) : 0;
  thrusters.forEach((sp, i) => {
    const k = thr * (0.55 + 0.45 * Math.sin(performance.now() * 0.02 + i));
    sp.material.opacity = k * 0.95;
    sp.visible = k > 0.01;
    sp.scale.setScalar(3.4 + k * 1.6 + (i % 2) * 0.3);
  });

  // 对接辅助线：机背落座点 → 对接盘口面
  guide.visible = app.prog > 0.02 && app.prog < 0.98;
  if (guide.visible) {
    const g = guide.geometry.attributes.position;
    g.setXYZ(0, hatchW.x, hatchW.y, hatchW.z);
    g.setXYZ(1, dockW.port.x, dockW.port.y, dockW.port.z);
    g.needsUpdate = true;
    guide.material.opacity = 0.10 + 0.08 * Math.sin(performance.now() * 0.004);
  }

  // 自动取景（用户一旦手动操作相机就停止）
  if (app.autoFrame) {
    // 取景半径同时照顾环体和脱离后的登陆艇
    const need = Math.max(CFG.ringRadius * 1.08, landerRig.position.length() * 0.62 + 13);
    const want = fitDistance(need);
    const cur = camera.position.distanceTo(controls.target);
    const next = THREE.MathUtils.damp(cur, want, 2.2, dt);
    camera.position.sub(controls.target).setLength(next).add(controls.target);
    // 构图中心往登陆艇一侧偏一点（相机与目标一起平移，只挪构图不转视角）
    const k = Math.min(1, dt * 1.4);
    tmpV.copy(landerRig.position).multiplyScalar(0.42).sub(controls.target).multiplyScalar(k);
    controls.target.add(tmpV);
    camera.position.add(tmpV);
  }
  controls.update();
}

/* ---------------- 提示线 / 推进器 ---------------- */
const guideGeo = new THREE.BufferGeometry();
guideGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
const guide = new THREE.Line(guideGeo, new THREE.LineBasicMaterial({
  color: 0x8fd9ff, transparent: true, opacity: 0.12, depthWrite: false,
}));
guide.frustumCulled = false;
guide.visible = false;
scene.add(guide);

function makeGlowTexture(c0, c1, c2, c3) {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, c0);
  g.addColorStop(0.24, c1);
  g.addColorStop(0.55, c2);
  g.addColorStop(1, c3);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// 推进器：暖白 → 橙；对接信标：冷白 → 蓝
const glowTex = makeGlowTexture('rgba(255,246,232,1)', 'rgba(255,206,150,0.72)', 'rgba(255,150,90,0.22)', 'rgba(255,120,60,0)');
const beaconTex = makeGlowTexture('rgba(236,250,255,0.95)', 'rgba(143,217,255,0.6)', 'rgba(90,170,255,0.18)', 'rgba(60,140,255,0)');
const thrusters = [];
for (const [x, y, z] of [[-3.4, 0.4, -11.2], [3.4, 0.4, -11.2]]) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
  }));
  sp.position.set(x, y, z);
  sp.scale.setScalar(3.4);
  sp.visible = false;
  landerRig.add(sp);
  thrusters.push(sp);
}

/* ---------------- 启动 ---------------- */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}
addEventListener('resize', resize);
resize();

let running = false;
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
}

async function boot() {
  try {
    const [gRing, gLander] = await Promise.all([
      loader.loadAsync(CFG.endurance),
      loader.loadAsync(CFG.lander),
    ]);

    // 环：外径 = 2 × ringRadius；居中
    const ringModel = gRing.scene;
    normalize(ringModel, CFG.ringRadius * 2, 'z');
    dressMaterials(ringModel, 0.6);
    ringPivot.add(ringModel);
    ringPivot.updateMatrixWorld(true);

    // 着陆器：机头朝 +Z（原模型朝 -Z，绕 Y 转 180°），机头顶点落在原点。
    // 原模型是「机背朝 -Y」建的，再绕 Z 翻 180° 让机背朝 +Y —— 顶部那块带中央
    // 舱门的大平台才是电影里的对接面。
    const lModel = gLander.scene;
    lModel.rotation.y = Math.PI;
    lModel.rotation.z = Math.PI;
    normalize(lModel, CFG.landerLength, 'z', 'nose');
    dressMaterials(lModel, 2.0, 0.55);
    landerRig.add(lModel);
    landerRig.updateMatrixWorld(true);

    // 机背顶部的对接落座面由模型实测
    const hatch = findDorsalHatch(lModel);
    const dock = computeDock(hatch);

    buildCollar();

    // 初态：已对接（机背压在对接口上）
    landerRig.position.copy(nowWorldDock().pos);
    landerRig.quaternion.copy(nowWorldDock().quat);

    bindUI();
    frameView(true);
    updateSpinReadout();

    el('loader').classList.add('done');
    running = true;
    clock.start();
    loop();

    // 调试/自动化钩子
    window.__ENDURANCE = {
      app, CFG, scene, camera, controls, ringPivot, landerRig, collar,
      dockLocal, hatch, padX: CFG.padX, dockDeg: CFG.dockDeg, dockR: CFG.dockR,
      THREE, ringModel,
      toggle: separate => toggle(separate),
      frameView: hard => frameView(hard),
      separate: () => toggle(true),
      dock: () => toggle(false),
    };
  } catch (err) {
    document.getElementById('loader').classList.add('done');
    const box = document.getElementById('error');
    box.classList.remove('hidden');
    document.getElementById('err-msg').textContent = String(err && (err.message || err)).slice(0, 240);
    document.getElementById('btn-retry').onclick = () => location.reload();
    console.error(err);
  }
}

boot();

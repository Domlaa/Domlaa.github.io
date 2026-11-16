/**
 * INTERSTELLAR · ENDURANCE / LANDER —— 对接与分离演示
 *
 * 1 单位 = 1.0667 m（环半径 30 单位 ↔ 实际 32 m，整环直径 64 m）
 * 环平面 = YZ，自转轴 = X；lander 机头朝 -Z、尾朝 +Z（原始模型），
 * 归一化时绕 Y 转 180°，约定 rig 局部 +Z = 机头方向，原点 = 机头顶点。
 * 对接点由「沿径向向内打射线」实测环外表面得到，不写死坐标。
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
  dockAngle: 210,          // 对接点角度（度，YZ 平面自 +Z 向 +Y）；环上 12 个货舱每 30° 一个，取整倍数即舱口正中
  dockRadius: 24.2,        // 对接面半径；实测该角度沿径向最外实体在 22.6，取略外侧贴着舱体
  spin: 0.05,              // 默认环自转 rad/s
  transit: 4.4,            // 默认机动时长 s
  metersPerUnit: 32 / 30,

  park: { radial: 22, axial: -11, tangent: 13 },  // 分离后的停放点（相对对接点，环局部系）
};

// 调试用：?ang=60&r=30.4 可临时覆盖对接角度 / 半径
{
  const q = new URLSearchParams(location.search);
  if (q.has('ang')) CFG.dockAngle = Number(q.get('ang'));
  if (q.has('r')) CFG.dockRadius = Number(q.get('r'));
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
const key = new THREE.DirectionalLight(0xfff1dd, 2.0); key.position.set(-1.1, 0.85, 1.25);
const fill = new THREE.DirectionalLight(0x86b9ff, 0.85); fill.position.set(1.2, -0.55, -0.75);
const rim = new THREE.DirectionalLight(0xffffff, 1.25); rim.position.set(0.25, 1.0, -1.1);
const amb = new THREE.HemisphereLight(0x9fc2e8, 0x0a0f16, 0.32);
scene.add(key, fill, rim, amb);

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

function dressMaterials(root, envInt) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = o.receiveShadow = false;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.envMapIntensity = envInt;
      if (typeof m.metalness === 'number' && m.metalness > 0.9) m.metalness = 0.9;
      if (m.map) m.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
  });
}

/* ---------------- 对接点 / 泊位姿态 ---------------- */
const dockLocal = {
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  radial: new THREE.Vector3(0, 0, 1),
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

function computeDock(ringModel) {
  const a = THREE.MathUtils.degToRad(CFG.dockAngle);
  const radial = new THREE.Vector3(0, Math.sin(a), Math.cos(a)).normalize();
  const ringPivotRot = ringPivot.rotation.x;
  ringPivot.rotation.x = 0;
  ringPivot.updateMatrixWorld(true);

  // 沿径向向内打射线：环上的货舱朝外开口，射线会穿到舱内底板，
  // 因此实测值只作为参考，真正落点用 dockRadius（默认取模块外缘）
  const from = radial.clone().multiplyScalar(CFG.ringRadius * 1.9);
  const ray = new THREE.Raycaster(from, radial.clone().negate(), 0, CFG.ringRadius * 3.2);
  const hits = ray.intersectObject(ringModel, true);
  const measured = hits.length ? from.length() - hits[0].distance : CFG.ringRadius;

  ringPivot.rotation.x = ringPivotRot;
  ringPivot.updateMatrixWorld(true);

  const surfaceR = CFG.dockRadius > 0 ? CFG.dockRadius : CFG.ringRadius * 1.008;
  dockLocal.radial.copy(radial);
  dockLocal.pos.copy(radial).multiplyScalar(surfaceR + 0.55);
  // 机头指向环心（-radial），机身「上方」朝环轴 +X，保证舱门正对镜头
  dockLocal.quat.copy(quatFromForwardUp(radial.clone().negate(), new THREE.Vector3(1, 0, 0)));
  return { surfaceR, measured };
}

/** 对接环：程序化生成，作为可视化锚点（源模型没有独立可用的舱口节点） */
function buildCollar() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x101820, metalness: 0.92, roughness: 0.34 });
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x0b1218, metalness: 0.8, roughness: 0.3,
    emissive: new THREE.Color(0x5fd0ff), emissiveIntensity: 0.9,
  });
  glowMats.push(ringMat);

  const torus = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.2, 12, 60), ringMat);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.12, 10, 48), ringMat);
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(3.15, 3.15, 0.24, 52), metal);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.55, 24), metal);

  plate.rotation.x = Math.PI / 2;
  hub.rotation.x = Math.PI / 2;
  plate.position.z = -0.55;
  hub.position.z = -0.1;

  // 伸向舱体的短轴：collar 的 +Z 指向环心，短轴沿 +Z 插进舱内做视觉收口
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.85, 4.6, 32, 1, true), metal);
  stem.rotation.x = Math.PI / 2;
  stem.position.z = 2.3;
  collar.add(stem);

  const clamps = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.9, 0.5), metal);
    const ang = (i * Math.PI) / 2 + Math.PI / 4;
    arm.position.set(Math.cos(ang) * 3.2, Math.sin(ang) * 3.2, 0.02);
    arm.rotation.z = ang - Math.PI / 2;
    clamps.add(arm);
  }
  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: beaconTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.16,
  }));
  beacon.scale.setScalar(11);
  beacon.position.z = 0.3;
  collar.userData.beacon = beacon;

  collar.add(torus, inner, plate, hub, clamps, beacon);
  collar.userData.clamps = clamps;
  // torus 默认轴 = +Z，正好与 "朝向径向" 的约定一致
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
  const pos = ringPivot.localToWorld(dockLocal.pos.clone());
  const quat = ringPivot.getWorldQuaternion(new THREE.Quaternion()).multiply(dockLocal.quat.clone());
  const radial = dockLocal.radial.clone().applyQuaternion(ringPivot.getWorldQuaternion(new THREE.Quaternion()).normalize()).normalize();
  return { pos, quat, radial };
}

function makeFreePose(dockW) {
  const ringQ = ringPivot.getWorldQuaternion(new THREE.Quaternion()).normalize();
  const axisW = new THREE.Vector3(1, 0, 0).applyQuaternion(ringQ).normalize();
  const tangW = new THREE.Vector3().crossVectors(axisW, dockW.radial).normalize();
  const pos = dockW.pos.clone()
    .addScaledVector(dockW.radial, CFG.park.radial)
    .addScaledVector(axisW, CFG.park.axial)
    .addScaledVector(tangW, CFG.park.tangent);
  // 分离后机头略微偏开环面，带一点侧倾
  const delta = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.16, 0.42, -0.22, 'YXZ'));
  const quat = dockW.quat.clone().multiply(delta);
  const ctrl = dockW.pos.clone()
    .addScaledVector(dockW.radial, CFG.park.radial * 0.52)
    .addScaledVector(tangW, CFG.park.tangent * 0.75)
    .addScaledVector(axisW, CFG.park.axial * 0.3);
  return { pos, quat, ctrl, tang: tangW, axis: axisW };
}

function startTween(to, done) {
  // 每次分离都按「当下的」环姿态重算泊位，否则环转过之后旧泊位可能落在环体里
  if (to === 1) app.free = makeFreePose(nowWorldDock());
  app.tween = { from: app.prog, to, t: 0, dur: app.transit, done: done || null };
  setStatus(to === 1 ? 'SEPARATING' : 'APPROACH · ALIGN');
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
const VIEW_DIR = new THREE.Vector3(1.0, 0.42, 0.78).normalize();

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
  const dist = fitDistance(48 + 16 * app.prog);
  if (hard) {
    controls.target.set(0, 0, 0);
    camera.position.copy(VIEW_DIR).multiplyScalar(dist);
    camera.lookAt(0, 0, 0);
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
      .addScaledVector(free.axis, Math.sin(t * 1.7) * 0.45)
      .addScaledVector(free.tang, Math.cos(t * 1.13) * 0.35);
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
    tmpQ.copy(dockW.quat).slerp(free.quat, s);
    // 交会时的轻微姿态摆动，s 靠近两端时归零
    const wob = Math.sin(Math.PI * s) * 0.13 + Math.sin(Math.PI * 3 * s) * 0.035;
    tmpQ.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.35, 1, 0.18).normalize(), wob));
    landerRig.quaternion.copy(tmpQ);
  } else {
    landerRig.position.copy(dockW.pos);
    landerRig.quaternion.copy(dockW.quat);
  }

  landerRig.updateMatrixWorld(true);

  // 遥测
  const rangeU = landerRig.position.distanceTo(dockW.pos);
  const rangeM = rangeU * CFG.metersPerUnit;
  const closure = (rangeM - app.lastRange) / Math.max(dt, 1e-3);
  app.lastRange = rangeM;
  app.closure += (Math.abs(closure) - app.closure) * Math.min(1, dt * 6);

  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(landerRig.quaternion).normalize();
  const alignDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(fwd.dot(dockW.radial.clone().negate()), -1, 1)));

  el('tl-range').textContent = rangeM.toFixed(rangeM < 100 ? 1 : 0) + ' m';
  el('tl-closure').textContent = app.closure.toFixed(1) + ' m/s';
  const alignEl = el('tl-align');
  alignEl.textContent = alignDeg.toFixed(1) + '°';
  alignEl.className = alignDeg < 4 ? 'ok' : alignDeg < 24 ? '' : 'warn';

  if (app.tween && app.tween.to === 0) setStatus(app.tween.t < 0.6 ? 'APPROACH · ALIGN' : 'FINAL · CLAMPING');

  // 对接环姿态 / 夹爪 / 呼吸
  collar.position.copy(dockLocal.pos);
  collar.quaternion.copy(dockLocal.quat);
  if (app.flash > 0) app.flash = Math.max(0, app.flash - dt * 1.4);
  const breathe = 0.72 + Math.sin(performance.now() * 0.0022) * 0.14;
  for (const m of glowMats) m.emissiveIntensity = breathe + app.flash * 3.2;
  const cs = 1 + app.flash * 0.06;
  collar.scale.setScalar(cs);
  const beacon = collar.userData.beacon;
  if (beacon) {
    beacon.material.opacity = 0.1 + Math.max(0, Math.sin(performance.now() * 0.0018)) * 0.1 + app.flash * 0.55;
    beacon.scale.setScalar(11 + app.flash * 5);
  }
  collar.userData.clamps.children.forEach((arm, i) => {
    const open = THREE.MathUtils.clamp(app.prog * 1.6, 0, 1);
    arm.position.z = 0.02 + open * 0.5 + (i % 2) * 0.0;
  });

  // 引擎辉光
  const thr = app.tween ? Math.sin(Math.PI * THREE.MathUtils.clamp(app.tween.t, 0, 1)) : 0;
  thrusters.forEach((sp, i) => {
    const k = thr * (0.55 + 0.45 * Math.sin(performance.now() * 0.02 + i));
    sp.material.opacity = k * 0.95;
    sp.visible = k > 0.01;
    sp.scale.setScalar(3.4 + k * 1.6 + (i % 2) * 0.3);
  });

  // 对接辅助线
  guide.visible = app.prog > 0.02 && app.prog < 0.98;
  if (guide.visible) {
    const g = guide.geometry.attributes.position;
    g.setXYZ(0, landerRig.position.x, landerRig.position.y, landerRig.position.z);
    g.setXYZ(1, dockW.pos.x, dockW.pos.y, dockW.pos.z);
    g.needsUpdate = true;
    guide.material.opacity = 0.10 + 0.08 * Math.sin(performance.now() * 0.004);
  }

  // 自动取景（用户一旦手动操作相机就停止）
  if (app.autoFrame) {
    const want = fitDistance(48 + 16 * app.prog);
    const cur = camera.position.distanceTo(controls.target);
    const next = THREE.MathUtils.damp(cur, want, 2.2, dt);
    camera.position.sub(controls.target).setLength(next).add(controls.target);
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
for (const [x, y, z] of [[-3.1, -0.5, -10.6], [3.1, -0.5, -10.6]]) {
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

    const dock = computeDock(ringModel);

    // 着陆器：机头朝 +Z（原模型朝 -Z，绕 Y 转 180°），机头顶点落在原点
    const lModel = gLander.scene;
    lModel.rotation.y = Math.PI;
    normalize(lModel, CFG.landerLength, 'z', 'nose');
    dressMaterials(lModel, 0.75);
    landerRig.add(lModel);

    buildCollar();
    collar.position.copy(dockLocal.pos);
    collar.quaternion.copy(dockLocal.quat);

    // 初态：已对接
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
      dockLocal, surfaceR: dock.surfaceR, measuredR: dock.measured, THREE, ringModel,
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

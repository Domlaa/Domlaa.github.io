/**
 * MARK LXXXV · 独立模型展示页
 * 目标：稳定加载 FBX 并正确呈现在任何屏幕上。
 * 不依赖任何后处理/特效，只用 PBR 材质 + 环境光照 + 阴影。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CONFIG = {
  url: '../../assets/models/mk85.fbx',
  fileBytes: 19926540,
  targetHeight: 1.95,      // 归一化后模型高度（米）
  fov: 34,
  exposure: 1.02,
};

/* FBX 内的贴图是作者本机绝对路径（C:\Users\...\Metal019_2K_*.jpg），
   必然 404。用一张 1×1 白图顶掉，避免控制台噪音；材质随后由本站接管。 */
const BLANK_TEX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const IMG_RE = /\.(jpe?g|png|gif|bmp|tga|tiff?|exr|hdr|psd|dds)(\?.*)?$/i;

const $ = (id) => document.getElementById(id);
const canvas = $('stage');

const state = {
  mode: 'suit',         // suit | steel | matte
  auto: true,
  dragging: false,
  ready: false,
  tris: 0,
  meshes: 0,
  fit: { dist: 3.2, targetY: 1 },
};

let renderer, scene, camera, controls, sun, pmrem, model;

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
init();

function init() {
  try {
    initRenderer();
  } catch (err) {
    fail('无法初始化 WebGL：' + (err?.message || err));
    return;
  }
  initScene();
  initLights();
  initControls();
  initUI();
  loadModel();
  renderer.setAnimationLoop(tick);
}

function initRenderer() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.exposure;
}

function initScene() {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(CONFIG.fov, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.position.set(1.4, 1.3, 3.2);

  // 环境反射：室内柔光箱，金属没有环境贴图会显得死黑
  pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;

  // 接影地面：径向渐隐，避免出现生硬的圆盘边缘
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.7, 96),
    new THREE.MeshStandardMaterial({
      color: 0x131922,
      roughness: 0.6,
      metalness: 0.22,
      transparent: true,
      alphaMap: radialTexture(),
      depthWrite: false,
      envMapIntensity: 0.35,
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
}

function initLights() {
  sun = new THREE.DirectionalLight(0xfff4e6, 2.6);
  sun.position.set(2.4, 4.4, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 12;
  sun.shadow.camera.left = -2.4;
  sun.shadow.camera.right = 2.4;
  sun.shadow.camera.top = 3.4;
  sun.shadow.camera.bottom = -0.4;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 2;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0x9ec8ff, 1.15);
  fill.position.set(-3.2, 2.0, 2.2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffcf9c, 2.4);
  rim.position.set(-1.4, 2.8, -3.4);
  scene.add(rim);

  scene.add(new THREE.HemisphereLight(0xcadcff, 0x080b0f, 0.55));
}

function initControls() {
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.rotateSpeed = 0.75;
  controls.zoomSpeed = 0.8;
  controls.panSpeed = 0.6;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI * 0.54;
  controls.autoRotateSpeed = 0.55;
  controls.target.set(0, 1, 0);
  controls.addEventListener('start', () => { state.dragging = true; });
  controls.addEventListener('end', () => { state.dragging = false; });
}

/* ------------------------------------------------------------------ */
/* 加载                                                                */
/* ------------------------------------------------------------------ */
function loadModel() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (IMG_RE.test(url) ? BLANK_TEX : url));

  const started = performance.now();
  const loader = new FBXLoader(manager);
  loader.load(CONFIG.url, (obj) => onLoaded(obj, started), onProgress, (err) => {
    console.error(err);
    fail('FBX 解析失败，请检查文件是否完整（' + (err?.message || '未知错误') + '）');
  });
}

function onProgress(e) {
  const total = e.total > 0 ? e.total : CONFIG.fileBytes;
  const pct = Math.min(1, e.loaded / total);
  setProgress(pct, (e.loaded / 1048576).toFixed(1));
}

function setProgress(pct, mb) {
  const C = 2 * Math.PI * 27; // 与 CSS 中 r=27 一致
  $('ld-ring').style.strokeDashoffset = String(C * (1 - pct));
  $('ld-bar').style.width = (pct * 100).toFixed(1) + '%';
  $('ld-pct').textContent = Math.round(pct * 100) + '%';
  if (mb) $('ld-size').textContent = mb + ' MB';
}

function onLoaded(obj, started) {
  const ms = Math.round(performance.now() - started);

  // 清掉 FBX 里可能带的灯光/相机，避免和自己搭的棚灯打架
  const junk = [];
  obj.traverse((o) => { if (o.isLight || o.isCamera) junk.push(o); });
  junk.forEach((o) => o.parent && o.parent.remove(o));

  // 统计
  let tris = 0, meshes = 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    if (!g) return;
    tris += (g.index ? g.index.count : g.attributes.position?.count || 0) / 3;
  });
  state.tris = Math.round(tris);
  state.meshes = meshes;

  normalize(obj);
  model = obj;
  scene.add(model);
  dress();

  const height = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).y;
  frameCamera(height);
  resetView();

  $('st-mesh').textContent = meshes;
  $('st-tris').textContent = state.tris.toLocaleString('en-US');
  $('st-load').textContent = ms + ' ms';
  $('st-load').classList.add('ok');

  state.ready = true;
  setProgress(1, (CONFIG.fileBytes / 1048576).toFixed(1));
  setTimeout(() => $('loader').classList.add('done'), 260);

  window.__MK85 = { THREE, scene, camera, renderer, controls, state, model, resetView, setMode, capture };
}

function normalize(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (!isFinite(size.y) || size.y <= 0) throw new Error('模型尺寸异常');

  // 统一高度，防止不同来源模型（厘米/米/英寸）尺寸离谱
  obj.scale.multiplyScalar(CONFIG.targetHeight / size.y);
  obj.updateMatrixWorld(true);

  const b2 = new THREE.Box3().setFromObject(obj);
  obj.position.x -= (b2.min.x + b2.max.x) / 2;
  obj.position.z -= (b2.min.z + b2.max.z) / 2;
  obj.position.y -= b2.min.y;
  obj.updateMatrixWorld(true);
}

/* ------------------------------------------------------------------ */
/* 材质                                                                */
/* ------------------------------------------------------------------ */
/* 该 FBX 的贴图是作者本机绝对路径，网页端拿不到；
   但 28 个部件是按解剖命名的，因此按部件分配「战衣」配色最接近原作。 */
const TONE = {
  red:      { color: 0x95191f, roughness: 0.34, metalness: 0.92 },
  redDeep:  { color: 0x6d1116, roughness: 0.34, metalness: 0.90 },
  gold:     { color: 0xc08a2c, roughness: 0.29, metalness: 0.95 },
  goldDeep: { color: 0x8e641c, roughness: 0.30, metalness: 0.92 },
  dark:     { color: 0x24272c, roughness: 0.52, metalness: 0.65 },
};

const PART_TONE = {
  head: 'gold', neck: 'dark',
  chest: 'red', inner_armor: 'dark',
  shouder: 'red', upper_arm: 'red', elbow: 'goldDeep', lower_arm: 'red',
  wrist: 'gold', hand: 'red',
  weist: 'goldDeep', hip: 'red', hip_leg: 'red',
  upper_leg: 'red', knee: 'gold', lower_leg: 'red', foot: 'redDeep',
};

const MATS = {};
const SUIT_MATS = {};

function buildMaterials() {
  MATS.steel = new THREE.MeshStandardMaterial({
    color: 0x77818d, metalness: 1.0, roughness: 0.2, envMapIntensity: 1.35,
  });
  MATS.matte = new THREE.MeshStandardMaterial({
    color: 0x747d88, metalness: 0.05, roughness: 0.88, envMapIntensity: 0.45,
  });
  for (const [k, v] of Object.entries(TONE)) {
    SUIT_MATS[k] = new THREE.MeshStandardMaterial({
      color: v.color, metalness: v.metalness, roughness: v.roughness, envMapIntensity: 1.05,
    });
  }
}

/** 名字形如 upper_arm001 / foot_left / wrist_right → 基名 */
function baseName(name) {
  return String(name || '')
    .replace(/\d+$/, '')
    .replace(/_(left|right)$/, '')
    .toLowerCase();
}

function toneOf(name) {
  const base = baseName(name);
  if (PART_TONE[base]) return PART_TONE[base];
  if (/leg|foot|arm|hip/.test(base)) return 'red';
  if (/head|face|mask/.test(base)) return 'gold';
  return 'redDeep';
}

function dress() {
  buildMaterials();
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.userData.origName = o.name || '(unnamed)';
    o.userData.tone = toneOf(o.name);
    if (o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
  });
  applyMode();
  console.info('[MK85] meshes:', state.meshes, 'tris:', state.tris);
}

function applyMode() {
  if (!model) return;
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (state.mode === 'suit') o.material = SUIT_MATS[o.userData.tone || 'red'];
    else o.material = MATS[state.mode];
  });
}

function setMode(mode) {
  state.mode = mode;
  applyMode();
  const label = { suit: '战衣', steel: '钢', matte: '哑光' }[mode];
  $('btn-material').textContent = '材质 · ' + label;
  $('btn-material').classList.toggle('on', mode !== 'steel');
}

/* ------------------------------------------------------------------ */
/* 视角                                                                */
/* ------------------------------------------------------------------ */
function frameCamera(height) {
  const vFov = THREE.MathUtils.degToRad(CONFIG.fov);
  const fitH = (height / 2) / Math.tan(vFov / 2);
  const fitW = (height * 0.62) / (2 * Math.tan(vFov / 2) * Math.max(0.5, camera.aspect));
  const margin = camera.aspect < 0.85 ? 1.34 : 1.18;
  state.fit.dist = Math.max(fitH, fitW) * margin;
  state.fit.targetY = height * 0.52;
  controls.minDistance = state.fit.dist * 0.34;
  controls.maxDistance = state.fit.dist * 2.6;
}

function resetView() {
  if (!model) return;
  const d = state.fit.dist;
  const dir = new THREE.Vector3(0.34, 0.13, 1).normalize();
  controls.target.set(0, state.fit.targetY, 0);
  camera.position.copy(controls.target).addScaledVector(dir, d);
  camera.updateProjectionMatrix();
  controls.update();
}

/** 保存当前画面为 PNG（合成深色底，避免透明背景） */
function capture() {
  if (!state.ready) return;
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  const g = ctx.createRadialGradient(out.width / 2, out.height * 0.3, 0, out.width / 2, out.height * 0.3, Math.max(out.width, out.height) * 0.8);
  g.addColorStop(0, '#1b232e');
  g.addColorStop(0.45, '#0d1218');
  g.addColorStop(1, '#05070a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0);
  const a = document.createElement('a');
  a.download = 'mark85-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
  a.href = out.toDataURL('image/png');
  a.click();
}

/* ------------------------------------------------------------------ */
/* 交互                                                                */
/* ------------------------------------------------------------------ */
function initUI() {
  $('btn-rotate').addEventListener('click', () => toggleAuto());
  $('btn-material').addEventListener('click', () => {
    const order = ['suit', 'steel', 'matte'];
    setMode(order[(order.indexOf(state.mode) + 1) % order.length]);
  });
  $('btn-shot').addEventListener('click', capture);
  $('btn-reset').addEventListener('click', resetView);
  $('btn-full').addEventListener('click', toggleFull);

  canvas.addEventListener('dblclick', resetView);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); toggleAuto(); }
    else if (k === 'm') $('btn-material').click();
    else if (k === 's') capture();
    else if (k === 'r') resetView();
    else if (k === 'f') toggleFull();
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 80);
  });
}

function toggleAuto() {
  state.auto = !state.auto;
  controls.autoRotate = state.auto;
  $('btn-rotate').classList.toggle('on', state.auto);
}

function toggleFull() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  if (model) { frameCamera(CONFIG.targetHeight); resetView(); }
}

/* ------------------------------------------------------------------ */
/* 渲染循环                                                            */
/* ------------------------------------------------------------------ */
let last = performance.now();
let fpsFrames = 0, fpsTimer = 0;

function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  controls.autoRotate = state.auto && !state.dragging;
  controls.update(dt);
  renderer.render(scene, camera);

  // FPS：按窗口内帧数统计，避免 dt 抖动放大
  fpsFrames++; fpsTimer += dt;
  if (fpsTimer >= 0.5) {
    $('st-fps').textContent = Math.round(fpsFrames / fpsTimer);
    fpsFrames = 0; fpsTimer = 0;
  }
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */
function radialTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.45, '#dcdcdc');
  g.addColorStop(0.78, '#3a3a3a');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function fail(msg) {
  const box = $('error');
  if (!box) return;
  $('err-msg').textContent = msg;
  box.classList.remove('hidden');
  $('loader').classList.add('done');
}

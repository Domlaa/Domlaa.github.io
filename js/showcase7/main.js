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
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const CONFIG = {
  url: '../assets/models/armor2.glb',
  targetHeight: 1.95,
  fov: 32,
  exposure: 1.08,
  albedoLod: 5.0,       // 反照率降采样级别（越大越干净）
  normalScale: 0.45,    // 法线贴图强度（原图是噪声，压低只留起伏）
  safeTop: 30,
  safeBottom: 104,
};

const state = {
  auto: true,
  ready: false,
  tris: 0,
  showLine: true,
  invert: false,        // false=暗线 true=亮线
  strength: 0.85,
  width: 1.05,
  fit: { dist: 4, targetY: 1 },
  dragging: false,
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 渲染器 / 场景                                                        */
/* ------------------------------------------------------------------ */
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let DPR = Math.min(devicePixelRatio || 1, 2);
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.exposure;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0e13);

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
    uniform float uStrength, uThickness, uNormalW, uDepthW, uNear, uFar, uLight, uLumW, uDetail;

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
      float lxC = lum(vUv);
      float lx = lum(vUv + vec2(o.x, 0.0)) - lum(vUv - vec2(o.x, 0.0));
      float ly = lum(vUv + vec2(0.0, o.y)) - lum(vUv - vec2(0.0, o.y));
      float lumEdge = smoothstep(0.05, 0.28, length(vec2(lx, ly)));

      // 局部对比：让凹槽 / 螺栓浮出来
      float blur = 0.25 * (lum(vUv + vec2(o.x, o.y) * 2.0) + lum(vUv + vec2(-o.x, o.y) * 2.0)
                         + lum(vUv + vec2(o.x, -o.y) * 2.0) + lum(vUv + vec2(-o.x, -o.y) * 2.0));
      col *= clamp(1.0 + (lxC - blur) * uDetail, 0.35, 2.2);

      float edge = clamp(nEdge * uNormalW + dEdge * uDepthW + lumEdge * uLumW, 0.0, 1.0) * uStrength;

      vec3 ink = vec3(0.012, 0.017, 0.024);
      vec3 glow = vec3(0.86, 0.93, 1.0);
      vec3 lineCol = mix(ink, glow, uLight);
      col = mix(col, lineCol, edge * mix(0.92, 0.5, uLight));

      gl_FragColor = vec4(col, 1.0);
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

/** 归一化：缩放 / 居中 / 贴地 —— 换任何单位的模型都不会跑飞 */
function normalize(root) {
  const box = new THREE.Box3();
  root.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = CONFIG.targetHeight / size.y;
  root.scale.setScalar(s);
  root.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  root.updateMatrixWorld(true);
  box.setFromObject(root);
  return box;
}

/** 取景：把模型放在「去掉顶栏 / 底部工具栏」后的可视区里垂直居中 */
function frameCamera(height) {
  const vFov = THREE.MathUtils.degToRad(CONFIG.fov);
  const fitH = (height / 2) / Math.tan(vFov / 2);
  const fitW = (height * 0.68) / (2 * Math.tan(vFov / 2) * Math.max(0.5, camera.aspect));
  const narrow = camera.aspect < 0.85;
  const d = Math.max(fitH, fitW) * (narrow ? 1.34 : 1.14);
  state.fit.dist = d;

  const vh = innerHeight || 900;
  const safeTop = narrow ? 120 : CONFIG.safeTop;
  const safeBottom = narrow ? 150 : CONFIG.safeBottom;
  const pxPerUnit = vh / (2 * Math.tan(vFov / 2) * d);
  const shift = ((safeBottom - safeTop) / 2) / pxPerUnit;
  state.fit.targetY = height * 0.5 - Math.min(shift, height * 0.12);

  controls.minDistance = d * 0.34;
  controls.maxDistance = d * 2.6;
}

function resetView() {
  if (!model) return;
  const d = state.fit.dist;
  const dir = new THREE.Vector3(0.26, 0.1, 1).normalize();
  controls.target.set(0, state.fit.targetY, 0);
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
    const gltf = await new GLTFLoader(manager).loadAsync(CONFIG.url, (e) => {
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

    root.updateMatrixWorld(true);
    const box = normalize(root);
    scene.add(root);
    model = root;

    const b = box.getSize(new THREE.Vector3());
    frameCamera(b.y);
    resetView();

    $('st-tris').textContent = state.tris.toLocaleString('en-US');
    const ms = Math.round(performance.now() - t0);
    ldText.textContent = `${meshes} 个部件 · ${ms} ms`;
    setProgress(1);
    setTimeout(() => loaderEl.classList.add('done'), 220);

    state.ready = true;
    console.info('[MK7] meshes:', meshes, 'tris:', state.tris, 'load ms:', ms);
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
  // 法线通道（接影面不参与边缘检测，否则会画出矩形边界）
  if (contactShadow) contactShadow.visible = false;
  scene.overrideMaterial = normalMat;
  renderer.setRenderTarget(normalRT);
  renderer.setClearColor(0x8080ff, 1);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  if (contactShadow) contactShadow.visible = true;

  // 颜色 + 深度
  renderer.setRenderTarget(beautyRT);
  renderer.setClearColor(0x0a0e13, 1);
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
  controls.update();

  edgeMat.uniforms.uStrength.value = state.showLine ? state.strength : 0;
  edgeMat.uniforms.uThickness.value = state.width;
  edgeMat.uniforms.uLight.value = state.invert ? 1 : 0;

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
  ctx.drawImage(src, 0, 0);
  const a = document.createElement('a');
  a.download = 'mark7-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
  a.href = out.toDataURL('image/png');
  a.click();
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
  $('btn-invert').addEventListener('click', () => setInvert(!state.invert));
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
    else if (k === 'f') $('btn-full').click();
  });

  addEventListener('resize', onResize);
}

/* ------------------------------------------------------------------ */
initUI();
boot().then(() => { if (state.ready) tick(); });

// 测试钩子
window.__MK7 = { THREE, scene, camera, renderer, controls, edgeMat, CONFIG, state, get model() { return model; }, resetView, capture };

/**
 * INTERSTELLAR · ENDURANCE / LANDER —— 同心轴协同自旋对接
 *
 * 1 单位 = 1.0667 m（环半径 30 单位 ↔ 实际 32 m，整环直径 64 m）
 *
 * 姿态约定（环坐标系 = ringPivot，+Y 朝上、环面 = XZ 水平面）：
 *   永恒号把原始「环轴 = X」的模型绕 Z 转 90°，环面因此平躺，绕 +Y 自转；
 *   登陆艇保持正常姿态（机腹朝 -Y、机舱朝 +Y），机头顺环的转动方向。
 *
 * 动作：两者始终以同一角速度绕各自的竖直中心轴自转（登陆艇的姿态直接定义在
 * 环的随动坐标系里，相对角速度恒为 0）。登陆艇先纵向退离/逼近，把自己的
 * 自转圆心与环心对齐 —— 此时二者看过去「绝对静止」—— 最后机腹对接面
 * 压上中央毂柱「下端口」：端口面沉进登陆艇顶部舱口的凹槽里、坐在对接
 * 围栏顶上（围栏圆心与咬合深度均由模型顶点自动实测），夹爪锁死。
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

  dockYaw: 1.35,           // 落座时机头朝向（环坐标系里的偏航角）
  dockY: -7.48,            // 机腹板面的落座高度（?docky= 微调；boot 里若自动找到
                           // 舱口围栏会改写成「毂柱端口面坐上围栏顶」的精确值）
  dockFlip: true,          // 下端口朝下 → 登陆艇倒扣（机腹朝上）对接

  spin: 0.16,              // 默认环自转 rad/s
  transit: 5.6,            // 默认机动时长 s
  metersPerUnit: 32 / 30,

  // 泊位（世界系，固定点）：下端口朝下，分离后向「下方」退离再横移泊位
  park: { x: -27, z: 21, height: -13, tilt: 0.13, roll: 0.09 },
  yawLag: 0.18,            // 泊位时的偏航滞后（弧度），对齐过程中收敛到 0

  bh: true,                // 卡冈图雅（黑洞 + 引力透镜吸积盘）开关
  bhSteps: 96,             // 光线回溯步数（性能/画质折衷）
};

// 调试用：?yaw=&lat=&h=&spin=&docky=&hatchz=（手动给值则跳过对应的自动实测）
const manualDock = { docky: false, hatchz: false };
{
  const q = new URLSearchParams(location.search);
  if (q.has('yaw')) CFG.dockYaw = Number(q.get('yaw'));
  if (q.has('px')) CFG.park.x = Number(q.get('px'));
  if (q.has('pz')) CFG.park.z = Number(q.get('pz'));
  if (q.has('h')) CFG.park.height = Number(q.get('h'));
  if (q.has('spin')) CFG.spin = Number(q.get('spin'));
  if (q.has('docky')) { CFG.dockY = Number(q.get('docky')); manualDock.docky = true; }
  if (q.has('hatchz')) manualDock.hatchz = true;
  if (q.has('bh')) CFG.bh = q.get('bh') !== '0';
  if (q.has('bhsteps')) CFG.bhSteps = Math.max(16, Math.min(160, Number(q.get('bhsteps')) || 96));
}

const UP = new THREE.Vector3(0, 1, 0);

/* ---------------- 渲染器 / 场景 ---------------- */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 6000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.7;
controls.zoomSpeed = 0.8;
controls.minDistance = 26;
controls.maxDistance = 520;
controls.enablePan = false;

// 光照：暖侧主光 + 冷补光 + 顶背轮廓光，模拟远处恒星
const key = new THREE.DirectionalLight(0xfff6ec, 1.9); key.position.set(-1.05, 1.15, 0.95);
const fill = new THREE.DirectionalLight(0x9cc2ff, 0.55); fill.position.set(1.2, -0.6, -0.85);
const rim = new THREE.DirectionalLight(0xffffff, 1.15); rim.position.set(0.3, 0.6, -1.15);
const amb = new THREE.HemisphereLight(0x9fc2e8, 0x0a0f16, 0.34);
// 从下方补一点：环平躺后，机腹与平台是暗面
const under = new THREE.DirectionalLight(0xdcecff, 0.55); under.position.set(0.4, -1.2, 0.5);
scene.add(key, fill, rim, amb, under);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.05).texture;
scene.environmentIntensity = 0.8;

/* ---------------- 天空：程序化星空 + 卡冈图雅（引力透镜吸积盘） ---------------- */
const sky = (() => {
  const uni = {
    uTime: { value: 0 },
    uBH: { value: new THREE.Vector3(-470, -110, -470) },     // 黑洞中心（世界系）
    uRs: { value: 22 },                                      // 史瓦西半径（世界单位）
    uDiskN: { value: new THREE.Vector3(0.55, 1.0, -0.30).normalize() }, // 吸积盘法线（近侧对着镜头 → 电影感）
    uFlow: { value: new THREE.Vector3(0.9, 0, -0.44).normalize() },     // 巡航方向
    uFlowAxis: { value: new THREE.Vector3() },               // 星空漂移轴（⊥ uFlow）
    uDrift: { value: 0.0085 },                               // 星空漂移角速度 rad/s
    uBHOn: { value: CFG.bh ? 1 : 0 },
    uSteps: { value: CFG.bhSteps },
  };
  uni.uFlowAxis.value.crossVectors(UP, uni.uFlow.value).normalize();

  const mat = new THREE.ShaderMaterial({
    uniforms: uni,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3  uBH;
      uniform float uRs;
      uniform vec3  uDiskN;
      uniform vec3  uFlowAxis;
      uniform float uDrift;
      uniform float uBHOn;
      uniform int   uSteps;

      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      vec3 hash33(vec3 p) {
        p = fract(p * vec3(0.1031, 0.1030, 0.0973));
        p += dot(p, p.yxz + 33.33);
        return fract((p.xxy + p.yxx) * p.zyx);
      }
      float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x),
              mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
              mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        return vnoise(p) * 0.58 + vnoise(p * 2.7 + 5.1) * 0.28 + vnoise(p * 6.1 - 3.7) * 0.14;
      }
      vec3 rotAxis(vec3 v, vec3 ax, float a) {
        float c = cos(a), s = sin(a);
        return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c);
      }

      /* 程序化星空：两层星点 + 银河带星云 */
      vec3 starfield(vec3 d) {
        vec3 col = vec3(0.0);
        for (int k = 0; k < 2; k++) {
          float scale = k == 0 ? 90.0 : 44.0;
          vec3 p = d * scale;
          vec3 id = floor(p);
          vec3 f = p - id;
          float h = hash13(id);
          if (h > (k == 0 ? 0.905 : 0.955)) {
            vec3 sp = hash33(id + 17.7) * 0.7 + 0.15;
            float m = smoothstep(0.17, 0.02, length(f - sp));
            float br = pow(hash13(id + 5.2), 2.6) * (k == 0 ? 0.5 : 1.0);
            float tw = 0.72 + 0.28 * sin(uTime * (1.5 + h * 4.0) + h * 41.0);
            vec3 tint = mix(vec3(1.0), vec3(0.72, 0.84, 1.0), step(0.72, hash13(id + 3.3)));
            tint = mix(tint, vec3(1.0, 0.86, 0.68), step(0.85, hash13(id + 9.7)));
            col += tint * m * br * tw * (k == 0 ? 0.9 : 1.4);
          }
        }
        vec3 bandN = normalize(vec3(0.3, 0.9, 0.32));
        float bd = abs(dot(d, bandN));
        float bandM = smoothstep(0.40, 0.04, bd);
        float neb = fbm(d * 4.5 + 11.0);
        float neb2 = fbm(d * 9.0 - 4.0);
        vec3 nebCol = mix(vec3(0.10, 0.16, 0.30), vec3(0.30, 0.20, 0.15), neb2);
        col += nebCol * bandM * (0.30 * neb + 0.12 * neb2);
        col += vec3(0.045, 0.06, 0.09) * bandM * bandM;
        return col;
      }

      /* 吸积盘着色：温度梯度 + 差速旋转花纹 + 多普勒束流 */
      vec3 diskShade(vec3 hp, vec3 v) {
        float rr = length(hp);
        vec3 q = rotAxis(hp, uDiskN, uTime * 0.9 / pow(rr, 1.5));
        float n = 0.55 + 0.45 * fbm(vec3(q.x * 1.35, q.z * 1.35, q.y * 5.0));
        float t = smoothstep(7.0, 2.4, rr);
        vec3 c = mix(vec3(1.0, 0.42, 0.12), vec3(1.0, 0.93, 0.80), pow(t, 1.4));
        vec3 tang = normalize(cross(uDiskN, hp));
        float beta = clamp(0.62 / sqrt(rr * 0.5), 0.0, 0.7);
        float dop = dot(tang, -v);                        // 接近侧更亮更白
        float boost = pow(clamp(1.0 + dop * beta * 1.4, 0.12, 2.4), 3.0);
        c = mix(c, vec3(0.92, 0.96, 1.12), clamp(dop * 0.5 + 0.1, 0.0, 1.0) * t * 0.55);
        float fade = smoothstep(2.35, 2.9, rr) * smoothstep(7.0, 5.6, rr);
        return c * (n * boost * fade * 2.1 * pow(2.6 / rr, 1.6));
      }

      /* 简化 ACES，把超亮的盘压进显示范围 */
      vec3 aces(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }

      void main() {
        vec3 ro = cameraPosition;
        vec3 rd = normalize(vWorld - ro);

        // 星空整体绕巡航轴缓慢漂移 —— 凸显飞行器正在航行
        vec3 sd = rotAxis(rd, uFlowAxis, uTime * uDrift);
        vec3 col = starfield(sd);

        if (uBHOn > 0.5) {
          vec3 toBH = uBH - ro;
          float dBH = length(toBH);
          float ang = acos(clamp(dot(rd, toBH / dBH), -1.0, 1.0));
          float infl = 11.0 * uRs / dBH;                  // 透镜影响角半径
          if (ang < infl * 1.25) {
            // 单位 = rs：从相机回溯光线，a = -1.5·h²·p / r⁵（史瓦西零测地线近似）
            vec3 p = (ro - uBH) / uRs;
            vec3 v = rd;
            vec3 hv = cross(p, v);
            float h2 = dot(hv, hv);
            vec3 acc = vec3(0.0);
            bool captured = false;
            for (int i = 0; i < 160; i++) {
              if (i >= uSteps) break;
              float r2 = dot(p, p);
              float r = sqrt(r2);
              if (r < 1.02) { captured = true; break; }   // 落入视界：黑影
              if (r > 64.0 && dot(p, v) > 0.0) break;     // 逃逸
              float dt = clamp(r * 0.20, 0.06, 2.6);
              float ph = dot(p, uDiskN);
              float vh = dot(v, uDiskN);
              if (ph * vh < 0.0) {                        // 本步穿过盘面
                float tc = -ph / vh;
                if (tc <= dt) {
                  vec3 hp = p + v * tc;
                  float rr = length(hp);
                  if (rr > 2.3 && rr < 7.0) acc += diskShade(hp, v);
                }
              }
              v += -1.5 * h2 * p / (r2 * r2 * r) * dt;
              p += v * dt;
            }
            vec3 lensed = captured
              ? acc
              : acc + starfield(rotAxis(normalize(v), uFlowAxis, uTime * uDrift));
            float w = smoothstep(infl * 1.25, infl * 0.55, ang);
            col = mix(col, lensed, w);
          }
        }

        col = aces(col * 1.15);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 24), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, uni };
})();

/* ---------------- 星际尘埃：沿巡航方向掠过的拖尾线段，强化速度感 ---------------- */
const dust = (() => {
  const N = 260;
  const flow = sky.uni.uFlow.value;
  const pos = new Float32Array(N * 6);
  const meta = [];
  const lat = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    // 侧向偏移：避开半径 42 以内（不穿过永恒号），散布在 42~155 的圆环带上
    const a = Math.random() * Math.PI * 2;
    const rad = 42 + Math.pow(Math.random(), 0.7) * 113;
    lat.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(rad);
    lat.y += (Math.random() * 2 - 1) * 60;
    meta.push({
      lat: lat.clone(),
      proj: (Math.random() * 2 - 1) * 175,
      spd: 9 + Math.random() * 9,
      len: 3 + Math.random() * 5,
    });
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const seg = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0xa8c8e8, transparent: true, opacity: 0.30,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  seg.frustumCulled = false;
  scene.add(seg);

  function spawn(i) {
    const m = meta[i];
    const a = Math.random() * Math.PI * 2;
    const rad = 42 + Math.pow(Math.random(), 0.7) * 113;
    m.lat.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(rad);
    m.lat.y += (Math.random() * 2 - 1) * 60;
    m.proj = -175;
    m.spd = 9 + Math.random() * 9;
    m.len = 3 + Math.random() * 5;
  }

  function update(dt) {
    const f = sky.uni.uFlow.value;
    for (let i = 0; i < N; i++) {
      const m = meta[i];
      m.proj += m.spd * dt;
      if (m.proj > 180) spawn(i);
      const x = f.x * m.proj + m.lat.x;
      const y = f.y * m.proj + m.lat.y;
      const z = f.z * m.proj + m.lat.z;
      const t = m.len;
      pos[i * 6]     = x;             pos[i * 6 + 1] = y;             pos[i * 6 + 2] = z;
      pos[i * 6 + 3] = x + f.x * t;   pos[i * 6 + 4] = y + f.y * t;   pos[i * 6 + 5] = z + f.z * t;
    }
    geo.attributes.position.needsUpdate = true;
  }
  return { update };
})();

/* ---------------- 模型装载 ---------------- */
const ringPivot = new THREE.Group();   // 绕 +Y 自转：环的随动坐标系
const ringBody = new THREE.Group();    // 把原始「环轴 = X」的模型摆成环面水平
ringBody.rotation.z = Math.PI / 2;
ringPivot.add(ringBody);
scene.add(ringPivot);

const landerRig = new THREE.Group();   // 原点 = 机头，+Z = 机头，-Y = 机腹
scene.add(landerRig);

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
    obj.position.set(-c.x, -c.y, -b2.max.z);   // 机头在最 +Z 端
  } else {
    obj.position.set(-c.x, -c.y, -c.z);
  }
  obj.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(obj);
}

function dressMaterials(root, envInt, metalCap, lighten) {
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
      // 登陆艇的贴图偏脏偏暗，整体提一点，别让它读成一块岩石
      if (lighten && m.color) m.color.multiplyScalar(lighten);
      if (m.map) m.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    }
  });
}

/* ---------------- 对接位 ---------------- */
const dockLocal = {
  pos: new THREE.Vector3(),        // 落座时 rig 原点（机头）在环坐标系的位置
  quat: new THREE.Quaternion(),    // 落座时 rig 朝向（环坐标系）
  port: new THREE.Vector3(),       // 对接落座面中心（环坐标系，环轴上）
  belly: new THREE.Vector3(),      // 机腹落座点在 rig 局部系的位置（模型实测）
};

/**
 * 量出机腹那块平板（落座面）的中心：取最低 6% 高度内顶点的重心。
 * 登陆艇正常姿态 = 机腹朝 -Y，所以落座点就是最低那片平面的重心。
 */
function findVentral(root) {
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
  const lim = ymin + (ymax - ymin) * 0.06;
  let sx = 0, sz = 0, n = 0, x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i + 1] > lim) continue;
    sx += pts[i]; sz += pts[i + 2]; n++;
    x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
    z0 = Math.min(z0, pts[i + 2]); z1 = Math.max(z1, pts[i + 2]);
  }
  if (!n) {
    const c = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
    return { point: c, w: 0, l: 0 };
  }
  return { point: new THREE.Vector3(sx / n, ymin, sz / n), w: x1 - x0, l: z1 - z0 };
}

/** 三点定圆（外接圆），共线/退化返回 null */
function circleFrom3(a, b, c) {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cz = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return [cx, cz, Math.hypot(a[0] - cx, a[1] - cz)];
}

/**
 * 自动定位登陆艇顶面（倒扣后的机腹板）中央的舱口对接围栏。
 * 注意 rig 局部系还是未翻转姿态：机腹板面在最下方（plateY），围栏在其上方
 * 约 0.10~0.26 的高度带里（倒扣后才是「往下沉进舱口」）。带内除了围栏还有
 * 全板面的筋条顶点，所以用 RANSAC 找出带内最显著的圆环，再用 Kasa 精修。
 * 返回 rig 局部系里的圆心、半径与围栏贴面高度；找不到返回 null。
 */
function findHatchPort(root, plateY) {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  const band = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y <= plateY + 0.08 || v.y >= plateY + 0.26) continue;
      band.push([v.x, v.y, v.z]);
    }
  });
  if (band.length < 80) return null;
  // 种子：0.5 格密度图上最密的 3×3 邻域（围栏顶点最稠密）
  const cell = new Map();
  for (const [x, , z] of band) {
    const k = Math.round(x * 2) + ',' + Math.round(z * 2);
    cell.set(k, (cell.get(k) || 0) + 1);
  }
  let seed = null, best = 0;
  for (const k of cell.keys()) {
    const [gx, gz] = k.split(',').map(Number);
    let s = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        s += cell.get((gx + dx) + ',' + (gz + dz)) || 0;
    if (s > best) { best = s; seed = [gx / 2, gz / 2]; }
  }
  if (!seed) return null;
  // RANSAC：种子附近随机三点定圆，得分 = 落在 ±0.06 环带内的顶点数
  const near = band.filter(([x, , z]) => Math.hypot(x - seed[0], z - seed[1]) < 2.6)
                   .map(([x, , z]) => [x, z]);
  if (near.length < 40) return null;
  let rng = 1234567;
  const rand = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let cand = null;
  for (let t = 0; t < 260; t++) {
    const p1 = near[(rand() * near.length) | 0];
    const p2 = near[(rand() * near.length) | 0];
    const p3 = near[(rand() * near.length) | 0];
    const c = circleFrom3(p1, p2, p3);
    if (!c || c[2] < 0.3 || c[2] > 1.3) continue;
    let inl = 0;
    for (const [x, z] of near)
      if (Math.abs(Math.hypot(x - c[0], z - c[1]) - c[2]) < 0.06) inl++;
    if (!cand || inl > cand.inl) cand = { cx: c[0], cz: c[1], r: c[2], inl };
  }
  if (!cand || cand.inl < 40) return null;
  // 几何距离迭代精修（Kasa 代数拟合在厚环带上会退化到过原点的大圆解，不用）
  let cx = cand.cx, cz = cand.cz, r = cand.r;
  for (let it = 0; it < 6; it++) {
    const inl = [];
    for (const [x, , z] of band) {
      const d = Math.hypot(x - cx, z - cz);
      if (Math.abs(d - r) < 0.15) inl.push([x, z, d]);
    }
    if (inl.length < 40) return null;
    r = inl.reduce((s, a) => s + a[2], 0) / inl.length;
    let gx = 0, gz = 0;
    for (const [x, z, d] of inl) {
      const u = Math.max(d, 1e-6);
      gx += ((x - cx) / u) * (d - r);
      gz += ((z - cz) / u) * (d - r);
    }
    cx += gx / inl.length;
    cz += gz / inl.length;
  }
  if (r < 0.25 || r > 1.5) return null;
  // 贴面高度 = 环带内点里离板面最近的一圈（局部系最小 y；倒扣后朝向毂柱）
  let rimY = Infinity;
  for (const [x, y, z] of band)
    if (Math.abs(Math.hypot(x - cx, z - cz) - r) < 0.15 && y < rimY) rimY = y;
  if (!Number.isFinite(rimY)) return null;
  return { x: cx, z: cz, r, rimY };
}

/** 毂柱下端口面：环模型轴心 r<2 内的最低顶点（渲染位姿） */
function measureHubBottom(root) {
  const v = new THREE.Vector3();
  let ymin = Infinity;
  root.traverse(o => {
    if (!o.isMesh) return;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.x * v.x + v.z * v.z > 4) continue;   // 轴心 r<2
      if (v.y > -6 || v.y < -10) continue;       // 下端口邻域
      if (v.y < ymin) ymin = v.y;
    }
  });
  return Number.isFinite(ymin) ? ymin : null;
}

/** 落座位：环坐标系里的「环轴上一点 + 偏航」，位置由机腹锚点（舱口圆心）反推 */
function computeDock(belly) {
  dockLocal.belly.copy(belly.point);
  dockLocal.port.set(0, CFG.dockY, 0);
  dockLocal.quat.setFromAxisAngle(UP, CFG.dockYaw).normalize();
  // 下端口朝下：登陆艇倒扣（绕机头轴翻 180°，机腹法线从 -Y 变 +Y 对着端口）
  if (CFG.dockFlip) {
    dockLocal.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
  }
  dockLocal.pos.copy(dockLocal.port).sub(belly.point.clone().applyQuaternion(dockLocal.quat));
  // 机头方向与侧向（机头顺环转动方向：park 沿 SIDE 摆开时恰好切向）
  dockLocal.nose = new THREE.Vector3(0, 0, 1).applyQuaternion(dockLocal.quat).setY(0).normalize();
  dockLocal.side = new THREE.Vector3().crossVectors(dockLocal.nose, UP).normalize();
}


/* ---------------- 机动状态 ---------------- */
const app = {
  prog: 0,              // 0 = 完全对接，1 = 完全分离（泊位）
  tween: null,          // { from, to, t, dur, done }
  auto: false,
  spinOn: true,
  spinRate: CFG.spin,
  spinPhase: 0,
  transit: CFG.transit,
  autoFrame: true,
  lastRange: 0,
  closure: 0,
  relRate: 0,
  lastYaw: 0,
};

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** 落座点在世界系里的位置 / 朝向（每帧都随环一起转） */
function nowWorldDock() {
  const ringQ = ringPivot.getWorldQuaternion(new THREE.Quaternion()).normalize();
  return {
    ringQ,
    pos: ringPivot.localToWorld(dockLocal.pos.clone()),
    quat: ringQ.clone().multiply(dockLocal.quat.clone()),
    port: ringPivot.localToWorld(dockLocal.port.clone()),
    nose: dockLocal.nose.clone().applyQuaternion(ringQ).normalize(),
    side: dockLocal.side.clone().applyQuaternion(ringQ).normalize(),
    up: UP.clone().applyQuaternion(ringQ).normalize(),
  };
}

function startTween(to, done) {
  app.tween = { from: app.prog, to, t: 0, dur: app.transit, done: done || null };
  setStatus(to === 1 ? 'RELEASE · BACK OFF' : 'APPROACH · SPIN SYNC');
  setClamps(to === 1 ? 'RELEASED' : 'OPEN', 'warn');
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
    updateSpinReadout();
  });
  const btnBH = el('btn-bh');
  btnBH.classList.toggle('on', CFG.bh);
  btnBH.addEventListener('click', () => {
    CFG.bh = !CFG.bh;
    sky.uni.uBHOn.value = CFG.bh ? 1 : 0;
    btnBH.classList.toggle('on', CFG.bh);
  });
  el('btn-reset').addEventListener('click', () => { app.autoFrame = true; frameView(true); });
  el('btn-full').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  const rngSpin = el('rg-spin');
  const SPIN_MAX = 0.8;    // 滑杆满格对应的自转角速度 rad/s
  rngSpin.value = String(Math.round((CFG.spin / SPIN_MAX) * 100));
  const applySpin = () => { app.spinRate = (Number(rngSpin.value) / 100) * SPIN_MAX; updateSpinReadout(); };
  rngSpin.addEventListener('input', applySpin);
  applySpin();

  const rngRate = el('rg-rate');
  const applyRate = () => {
    app.transit = THREE.MathUtils.mapLinear(Number(rngRate.value), 20, 100, 8.4, 2.8);
  };
  rngRate.addEventListener('input', applyRate);
  applyRate();

  controls.addEventListener('start', () => { app.autoFrame = false; });

  addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); btnToggle.click(); }
    else if (e.key === 'a' || e.key === 'A') btnAuto.click();
    else if (e.key === 's' || e.key === 'S') btnSpin.click();
    else if (e.key === 'g' || e.key === 'G') el('btn-bh').click();
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
  const next = app.prog < 0.5 ? 1 : 0;
  autoTimer = setTimeout(() => {
    if (!app.auto || app.tween) return;
    runManoeuvre(next);
  }, next === 1 ? 3200 : 3600);
}

/* ---------------- 取景 ---------------- */
// 环平躺后抬高机位看环面，但压低一点让下方的登陆艇对接处也读得到
const VIEW_DIR = new THREE.Vector3(0.55, 0.40, 0.72).normalize();
const FRAME_TARGET = new THREE.Vector3(0, 4, 0);

/** 竖屏时水平视角更窄，取横向/纵向两者中更远的那一个距离，保证不裁边 */
function fitDistance(radius) {
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const dv = radius / Math.sin(vFov / 2);
  const dh = (radius * (camera.aspect < 1 ? 0.9 : 1)) / Math.sin(hFov / 2);
  return Math.max(dv, dh) * 0.92;
}

function frameView(hard) {
  const dist = fitDistance(CFG.ringRadius * 1.06);
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
const tmpQ2 = new THREE.Quaternion();

function update(dt) {
  // 天空：时间推进（星空漂移 / 盘面旋转 / 闪烁）+ 尘埃掠过
  sky.uni.uTime.value += dt;
  dust.update(dt);

  // 环自转（唯一的时间积分，登陆艇的姿态全部定义在环的随动系里）
  if (app.spinOn) app.spinPhase += dt * app.spinRate;
  ringPivot.rotation.y = app.spinPhase;
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

  /* ---- 位置：世界系里两步走 ----
   * 泊位在世界系里是固定的（登陆艇就绕自己的中心轴在原地自转），
   * 0.62→1 之间横向滑回「环轴正上方」，0.68→0.06 之间沿轴线竖直降落。
   * 横向在 s<0.62 时已经归零，此后只剩沿轴下降 —— 这一段相对环「绝对静止」。
   */
  const lat = smoothstep01(s, 0.62, 1.0);
  const hgt = CFG.park.height * smoothstep01(s, 0.06, 0.68);
  const lag = CFG.yawLag * smoothstep01(s, 0.56, 1.0);
  // 空中姿态（俯仰/滚转）只在 0.55→1 这段存在：最后一段降落姿态是干净的，OFFSET 归零
  const air = Math.sin(Math.PI * THREE.MathUtils.clamp((s - 0.55) / 0.45, 0, 1));

  tmpV.copy(dockW.pos).addScaledVector(UP, hgt);
  tmpV.x += (CFG.park.x - dockW.pos.x) * lat;
  tmpV.z += (CFG.park.z - dockW.pos.z) * lat;

  // 姿态：偏航永远跟着环的相位走（相对角速度 = 0），另加一点空中摆动
  tmpQ.setFromAxisAngle(UP, app.spinPhase + CFG.dockYaw - lag);
  // 下端口对接：倒扣（绕机头轴翻 180°）——必须与 computeDock 的落座四元数一致
  if (CFG.dockFlip) {
    tmpQ.multiply(tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI));
  }
  if (air > 1e-3) {
    tmpQ2.setFromEuler(new THREE.Euler(air * CFG.park.tilt, 0, air * CFG.park.roll, 'XYZ'));
    tmpQ.multiply(tmpQ2);
  }

  landerRig.position.copy(tmpV);
  landerRig.quaternion.copy(tmpQ);
  landerRig.updateMatrixWorld(true);

  // 自由漂浮时的轻微起伏（只在泊位附近）
  if (s > 0.98) {
    const t = performance.now() * 0.0006;
    landerRig.position.addScaledVector(UP, Math.sin(t * 1.7) * 0.4);
    landerRig.position.addScaledVector(dockW.side, Math.cos(t * 1.13) * 0.3);
    landerRig.updateMatrixWorld(true);
  }

  // 遥测：以「机腹落座点 ↔ 落座面中心」为基准
  const bellyW = landerRig.localToWorld(dockLocal.belly.clone());
  const off = bellyW.clone().sub(dockW.port);
  const axialOff = off.dot(dockW.up);
  const latOff = off.clone().addScaledVector(dockW.up, -axialOff).length();
  const rangeM = off.length() * CFG.metersPerUnit;
  const closure = (rangeM - app.lastRange) / Math.max(dt, 1e-3);
  app.lastRange = rangeM;
  app.closure += (Math.abs(closure) - app.closure) * Math.min(1, dt * 6);

  // 姿态角：机腹法线与环轴的夹角（取绝对值——上/下端口两种对接姿态都视为贴合）
  const bellyN = new THREE.Vector3(0, -1, 0).applyQuaternion(landerRig.quaternion).normalize();
  const alignDeg = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(Math.abs(bellyN.dot(dockW.up)), -1, 1)));

  // 相对角速度：机头偏航角速度 - 环自转角速度（同速 → 0）
  const noseW = new THREE.Vector3(0, 0, 1).applyQuaternion(landerRig.quaternion);
  const yaw = Math.atan2(noseW.x, noseW.z);
  let dYaw = yaw - app.lastYaw;
  if (dYaw > Math.PI) dYaw -= Math.PI * 2; else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  app.lastYaw = yaw;
  const rel = THREE.MathUtils.radToDeg(dYaw / Math.max(dt, 1e-3)) - (app.spinOn ? THREE.MathUtils.radToDeg(app.spinRate) : 0);
  app.relRate += (Math.abs(rel) - app.relRate) * Math.min(1, dt * 8);

  el('tl-range').textContent = rangeM.toFixed(rangeM < 100 ? 1 : 0) + ' m';
  el('tl-closure').textContent = app.closure.toFixed(1) + ' m/s';
  const alignEl = el('tl-align');
  alignEl.textContent = alignDeg.toFixed(1) + '°';
  alignEl.className = alignDeg < 1 ? 'ok' : alignDeg < 8 ? '' : 'warn';
  const offEl = el('tl-roll');
  if (offEl) {
    const offM = latOff * CFG.metersPerUnit;
    offEl.textContent = app.prog < 0.02 ? 'ALIGNED' : offM.toFixed(1) + ' m';
    offEl.className = latOff < 0.06 ? 'ok' : latOff < 0.8 ? '' : 'warn';
  }
  const relEl = el('tl-rel');
  if (relEl) {
    relEl.textContent = app.relRate < 0.05 ? 'SYNC' : app.relRate.toFixed(2) + ' °/s';
    relEl.className = app.relRate < 0.05 ? 'ok' : app.relRate < 1.2 ? '' : 'warn';
  }

  if (app.tween && app.tween.to === 0) setStatus(app.tween.t < 0.55 ? 'APPROACH · SPIN SYNC' : 'FINAL · CLAMPING');

  // 引擎辉光
  const thr = app.tween ? Math.sin(Math.PI * THREE.MathUtils.clamp(app.tween.t, 0, 1)) : 0;
  thrusters.forEach((sp, i) => {
    const k = thr * (0.55 + 0.45 * Math.sin(performance.now() * 0.02 + i));
    sp.material.opacity = k * 0.95;
    sp.visible = k > 0.01;
    sp.scale.setScalar(3.2 + k * 1.6 + (i % 2) * 0.3);
  });

  // 对接辅助线：机腹落座点 → 落座面中心
  guide.visible = app.prog > 0.02 && app.prog < 0.98;
  if (guide.visible) {
    const g = guide.geometry.attributes.position;
    g.setXYZ(0, bellyW.x, bellyW.y, bellyW.z);
    g.setXYZ(1, dockW.port.x, dockW.port.y, dockW.port.z);
    g.needsUpdate = true;
    guide.material.opacity = 0.10 + 0.08 * Math.sin(performance.now() * 0.004);
  }
  // 轴线：对齐阶段亮一些，提示「同一个圆心」
  axisGuide.material.opacity = 0.05 + 0.06 * (1 - THREE.MathUtils.clamp(app.prog, 0, 1));

  // 自动取景（用户一旦手动操作相机就停止）
  if (app.autoFrame) {
    const lp = landerRig.position;
    // 构图中心在「环心」和「登陆艇」之间取个折中，两个主体都不出画
    // （泊位在环面下方 → ty 允许下探，need 用 |y| 保证竖向也装得下）
    const tx = FRAME_TARGET.x + lp.x * 0.22;
    const tz = FRAME_TARGET.z + lp.z * 0.22;
    const ty = FRAME_TARGET.y + THREE.MathUtils.clamp(lp.y * 0.3, -13, 6);
    const need = Math.max(
      CFG.ringRadius * 1.06,
      Math.hypot(lp.x - tx, lp.z - tz) + 12,
      Math.abs(lp.y - ty) + 10,
    );
    const want = fitDistance(need);
    const cur = camera.position.distanceTo(controls.target);
    const next = THREE.MathUtils.damp(cur, want, 2.2, dt);
    camera.position.sub(controls.target).setLength(next).add(controls.target);
    const k = Math.min(1, dt * 1.4);
    const dx = (tx - controls.target.x) * k, dy = (ty - controls.target.y) * k, dz = (tz - controls.target.z) * k;
    controls.target.x += dx; controls.target.y += dy; controls.target.z += dz;
    camera.position.x += dx; camera.position.y += dy; camera.position.z += dz;
  }
  controls.update();
}

/** smoothstep（自定义边界，便于分段编排动作） */
function smoothstep01(x, a, b) {
  if (b <= a) return x >= a ? 1 : 0;
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
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

// 同心轴：环的自转轴穿过平台中心 —— 圆心对齐后，二者的自转轴就是这根线
const axisGuide = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -13, 0), new THREE.Vector3(0, 40, 0)]),
  new THREE.LineBasicMaterial({ color: 0x8fd9ff, transparent: true, opacity: 0.09, depthWrite: false }),
);
axisGuide.frustumCulled = false;
ringPivot.add(axisGuide);

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
// 推进器：暖白 → 橙
const glowTex = makeGlowTexture('rgba(255,246,232,1)', 'rgba(255,206,150,0.72)', 'rgba(255,150,90,0.22)', 'rgba(255,120,60,0)');
const thrusters = [];
// 尾部两台主发动机 + 腹部两台姿控喷口（下降时朝下喷）
for (const [x, y, z] of [[-3.6, 0.1, -17.6], [3.6, 0.1, -17.6], [-2.3, -2.5, -6.2], [2.3, -2.5, -6.2]]) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0,
  }));
  sp.position.set(x, y, z);
  sp.scale.setScalar(3.2);
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

    // 环：外径 = 2 × ringRadius；居中后由 ringBody 摆成环面水平（环轴 = +Y）
    const ringModel = gRing.scene;
    normalize(ringModel, CFG.ringRadius * 2, 'z');
    dressMaterials(ringModel, 0.6);
    ringBody.add(ringModel);
    ringPivot.updateMatrixWorld(true);

    // 着陆器：机头朝 +Z（原模型朝 -Z，绕 Y 转 180°），机头顶点落在原点。
    // 原模型是「机背朝 -Y」建的，再绕 Z 翻 180° 让机腹朝 -Y、机舱朝 +Y ——
    // 这才是它的正常飞行 / 降落姿态，机腹那块平板就是落座面。
    const lModel = gLander.scene;
    lModel.rotation.y = Math.PI;
    lModel.rotation.z = Math.PI;
    normalize(lModel, CFG.landerLength, 'z', 'nose');
    dressMaterials(lModel, 1.75, 0.55, 1.16);
    landerRig.add(lModel);
    landerRig.updateMatrixWorld(true);

    // 机腹落座面由模型实测
    const belly = findVentral(lModel);
    // 舱口对接端口：自动找顶部围栏圆环，把锚点从「板面重心」修正到「舱口圆心」；
    // 落座高度按「毂柱下端口面沉进舱口、坐在围栏顶上（咬合 0.02）」反推。
    const hubBottom = measureHubBottom(ringModel);
    const hatch = findHatchPort(lModel, belly.point.y);
    if (hatch && hubBottom !== null) {
      if (!manualDock.hatchz) belly.point.set(hatch.x, belly.point.y, hatch.z);
      // 围栏贴面在局部系里比板面高 (rimY - plateY) → 倒扣后低同样距离，
      // 所以板面落座高度 = 毂柱端口面 + 咬合 0.02 + 这段高差
      if (!manualDock.docky) CFG.dockY = hubBottom + 0.02 + (hatch.rimY - belly.point.y);
    }

    computeDock(belly);

    // 初态：已对接（机腹对接面压在毂柱下端口上，倒扣悬挂）
    const dockW = nowWorldDock();
    landerRig.position.copy(dockW.pos);
    landerRig.quaternion.copy(dockW.quat);
    landerRig.updateMatrixWorld(true);
    app.lastYaw = Math.atan2(new THREE.Vector3(0, 0, 1).applyQuaternion(landerRig.quaternion).x,
      new THREE.Vector3(0, 0, 1).applyQuaternion(landerRig.quaternion).z);

    bindUI();
    frameView(true);
    updateSpinReadout();

    el('loader').classList.add('done');
    running = true;
    clock.start();
    loop();

    // 调试/自动化钩子
    window.__ENDURANCE = {
      app, CFG, scene, camera, controls, ringPivot, ringBody, landerRig,
      dockLocal, belly, THREE, ringModel, sky, dust, hatch, hubBottom,
      toggle: separate => toggle(separate),
      frameView: hard => frameView(hard),
      separate: () => toggle(true),
      dock: () => toggle(false),
      pose: s => ({
        lat: smoothstep01(s, 0.62, 1.0),
        hgt: CFG.park.height * smoothstep01(s, 0.06, 0.68),
      }),
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

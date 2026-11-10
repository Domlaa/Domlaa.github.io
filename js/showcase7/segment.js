/**
 * segment.js — MK7 装甲空间切分（页面自包含，不依赖 index 页模块）
 *
 * mk7 的 armor2.glb 是「单块蒙皮网格」，没有部件层级。
 * 关键点：蒙皮网格的渲染位置由骨骼静止姿态决定（bindMatrix/node 矩阵都不可靠），
 * 因此先按 skinIndex/skinWeight 手动烘焙顶点到世界坐标（等价于着色器的蒙皮变换）。
 *
 * 区域划分用「连通域（岛屿）切分」：焊接重合顶点后按共享边洪水填充，
 * 几何上连成一片的甲片整块归属同一模块（切口沿建模留出的甲片缝隙走，
 * 不会把甲片拦腰切断）；只有跨区域的大岛才回退为直线切分。
 *
 * 归一化在烘焙坐标上完成（高 1.95、贴地、居中），子网格顶点减去区域中心，
 * pivot.position = center + offset * H * t —— 位移恒为绝对量，反复拆装无累积误差。
 */
import * as THREE from 'three';

export const REGIONS = ['helmet', 'chest', 'back', 'armL', 'armR', 'legL', 'legR'];

/** 最近一次切分的统计（islands / wholeIslands / splitIslands / largestIsland / tris） */
let splitStats = null;
export function getSplitStats() { return splitStats; }

/**
 * 拆解定义：offset/rotate 为相对模型总高 H 的比例（沿用 index 页调好的参数）
 * 注：这份模型的腕部包着一块长条护板，横切任何高度都会把它撕成碎片，
 *     因此手与前臂合为 arm 模块，不单独拆分。
 */
export const SPLIT_DEFS = {
  helmet: { offset: [0, 0.27, 0],      rotate: [0.16, 0, 0],      stagger: 0.50 },
  chest:  { offset: [0, 0.02, 0.30],   rotate: [0, 0, 0],         stagger: 0.30 },
  back:   { offset: [0, 0.02, -0.32],  rotate: [-0.14, 0, 0],     stagger: 0.36 },
  armL:   { offset: [0.34, 0.04, 0],   rotate: [0, 0, -0.10],     stagger: 0.18 },
  armR:   { offset: [-0.34, 0.04, 0],  rotate: [0, 0, 0.10],      stagger: 0.24 },
  legL:   { offset: [0.19, 0, 0],      rotate: [0, 0, 0.10],      stagger: 0.06 },
  legR:   { offset: [-0.19, 0, 0],     rotate: [0, 0, -0.10],     stagger: 0.03 },
};

const T = {
  helmetTop: 0.865,   // t 高于此值 → 头盔
  armX: 0.19,         // |x| 超过此值（躯干高度带内）→ 手臂区
  armMinT: 0.36,      // 手臂区最低高度
  waist: 0.47,        // 躯干/大腿分界
  backZ: -0.06,       // 躯干高度带内 z 低于此值 → 背部
};

function classify(x, y, z, h) {
  const t = y / h;
  const ax = Math.abs(x);
  if (t >= T.helmetTop) return 'helmet';
  if (ax > T.armX && t >= T.armMinT) return x > 0 ? 'armL' : 'armR';
  if (t <= T.waist) return x > 0 ? 'legL' : 'legR';
  return z < T.backZ ? 'back' : 'chest';
}

/** 构建每顶点蒙皮函数（静止姿态）：等价于着色器 bindMatrix→skin→bindMatrixInverse */
function makeSkinFn(mesh) {
  const g = mesh.geometry;
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  if (!mesh.isSkinnedMesh || !si || !sw) return null;
  const skeleton = mesh.skeleton;
  const mats = skeleton.bones.map((b, i) =>
    new THREE.Matrix4().multiplyMatrices(b.matrixWorld, skeleton.boneInverses[i]));
  const bm = mesh.bindMatrix, bmi = mesh.bindMatrixInverse;
  const acc = new Float32Array(16);
  const S = new THREE.Matrix4();
  return (i, v) => {
    acc.fill(0);
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w === 0) continue;
      const M = mats[si.getComponent(i, k)].elements;
      for (let e = 0; e < 16; e++) acc[e] += M[e] * w;
    }
    S.fromArray(acc);
    v.applyMatrix4(bm).applyMatrix4(S).applyMatrix4(bmi);
    return S;
  };
}

/**
 * 把（蒙皮）网格烘焙为归一化世界坐标并按区域切分。
 * @param {THREE.Mesh[]} meshes 可见装甲网格（骨骼的 matrixWorld 必须已更新）
 * @param {number} targetHeight 归一化目标身高（米）
 * @returns {Map<string, { geometry, center: THREE.Vector3, material }>}
 */
export function splitArmorMeshes(meshes, targetHeight) {
  // ---- 阶段 1：烘焙到世界坐标（含蒙皮） ----
  const baked = meshes.map((mesh) => {
    const g = mesh.geometry;
    mesh.updateWorldMatrix(true, false);
    const skinFn = makeSkinFn(mesh);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const wp = new Float32Array(pos.count * 3);
    const wn = nor ? new Float32Array(pos.count * 3) : null;
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const bm3 = mesh.bindMatrix ? new THREE.Matrix3().setFromMatrix4(mesh.bindMatrix) : null;
    const bmi3 = mesh.bindMatrixInverse ? new THREE.Matrix3().setFromMatrix4(mesh.bindMatrixInverse) : null;
    const v = new THREE.Vector3(), n = new THREE.Vector3(), S3 = new THREE.Matrix3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (skinFn) {
        const S = skinFn(i, v);
        S3.setFromMatrix4(S);
        n.fromBufferAttribute(nor, i)
          .applyMatrix3(bm3).applyMatrix3(S3).applyMatrix3(bmi3).applyMatrix3(nm).normalize();
      } else {
        v.applyMatrix4(mesh.matrixWorld);
        if (wn) n.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
      }
      wp[i * 3] = v.x; wp[i * 3 + 1] = v.y; wp[i * 3 + 2] = v.z;
      if (wn) { wn[i * 3] = n.x; wn[i * 3 + 1] = n.y; wn[i * 3 + 2] = n.z; }
    }
    // 蒙皮属性不再需要，顺便清掉
    g.deleteAttribute('skinIndex');
    g.deleteAttribute('skinWeight');
    return { mesh, wp, wn };
  });

  // ---- 阶段 2：全局包围盒 → 归一化（targetHeight、贴地、居中） ----
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of baked) {
    for (let i = 0; i < b.wp.length; i += 3) {
      if (b.wp[i] < minX) minX = b.wp[i]; if (b.wp[i] > maxX) maxX = b.wp[i];
      if (b.wp[i + 1] < minY) minY = b.wp[i + 1]; if (b.wp[i + 1] > maxY) maxY = b.wp[i + 1];
      if (b.wp[i + 2] < minZ) minZ = b.wp[i + 2]; if (b.wp[i + 2] > maxZ) maxZ = b.wp[i + 2];
    }
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const s = targetHeight / (maxY - minY);
  for (const b of baked) {
    for (let i = 0; i < b.wp.length; i += 3) {
      b.wp[i] = (b.wp[i] - cx) * s;
      b.wp[i + 1] = (b.wp[i + 1] - minY) * s;
      b.wp[i + 2] = (b.wp[i + 2] - cz) * s;
    }
  }

  // ---- 阶段 3：覆写几何体属性（子网格将在世界空间、无变换） ----
  for (const b of baked) {
    b.mesh.geometry.setAttribute('position', new THREE.BufferAttribute(b.wp, 3));
    if (b.wn) b.mesh.geometry.setAttribute('normal', new THREE.BufferAttribute(b.wn, 3));
  }

  // ---- 阶段 4：连通域（岛屿）切分 —— 切口沿建模留出的甲片缝隙走 ----
  // 旧方案用直线平面（高度/左右/前后阈值）逐三角形切分，切口会从连续甲片
  // 中间穿过，视觉上像「撕开」。新方案：
  //   a) 焊接重合顶点（UV 缝/硬边会产生重复顶点，破坏连通性判断）
  //   b) 用共享边建立三角形邻接表，洪水填充出几何连通的「岛屿」
  //      —— 建模时留有缝隙的甲片天然是独立岛屿，永远不会被切穿
  //   c) 整岛按三角形区域投票归属；只有跨区域明显的大岛才回退为
  //      逐三角形直线切分（如胸/背共用的整圈躯干壳体）
  const height = targetHeight;

  // 4.1 顶点焊接：量化位置相同的顶点视为同一点（仅在同源网格内焊接）
  const welds = baked.map((b) => {
    const pos = b.mesh.geometry.getAttribute('position');
    const q = height * 5e-5;   // 焊接容差 ≈ 0.1mm，不会把分离的甲片焊到一起
    const map = new Map();
    const w = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const key = Math.round(pos.getX(i) / q) + ',' + Math.round(pos.getY(i) / q) + ',' + Math.round(pos.getZ(i) / q);
      let id = map.get(key);
      if (id === undefined) { id = map.size; map.set(key, id); }
      w[i] = id;
    }
    return { w, V: pos.count + 1 };
  });

  // 4.2 收集三角形：质心、面法线、直线规则区域号、边 → 三角形邻接表
  const tris = [];        // { src, i0, i1, i2, W }（W = 该源网格的焊接 id 表）
  const cents = [];       // 每三角形质心（x,y,z 依次）
  const triRegion = [];   // 每三角形按直线规则的区域号
  const nrm = [];         // 每三角形面法线（断口细化时算折痕）
  const edgeTris = new Map();
  const REG_ID = new Map(REGIONS.map((r, i) => [r, i]));

  for (let si = 0; si < baked.length; si++) {
    const src = baked[si];
    const pos = src.mesh.geometry.getAttribute('position');
    const index = src.mesh.geometry.getIndex();
    const W = welds[si].w;
    const V = welds[si].V;
    const base = si * 1e12;   // 邻接键带源前缀：跨源网格永不连通
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let i = 0; i < triCount; i++) {
      const i0 = index ? index.getX(i * 3) : i * 3;
      const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      const x0 = pos.getX(i0), y0 = pos.getY(i0), z0 = pos.getZ(i0);
      const x1 = pos.getX(i1), y1 = pos.getY(i1), z1 = pos.getZ(i1);
      const x2 = pos.getX(i2), y2 = pos.getY(i2), z2 = pos.getZ(i2);
      const cx = (x0 + x1 + x2) / 3, cy = (y0 + y1 + y2) / 3, cz = (z0 + z1 + z2) / 3;
      if (!Number.isFinite(cx + cy + cz)) continue;
      // 面法线（未归一化也可，只用来比较相邻面的夹角）
      const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
      const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const t = tris.length;
      tris.push({ srcIdx: si, src, i0, i1, i2, W });
      cents.push(cx, cy, cz);
      nrm.push(nx / nl, ny / nl, nz / nl);
      triRegion.push(REG_ID.get(classify(cx, cy, cz, height)) ?? -1);
      for (const [p, r] of [[W[i0], W[i1]], [W[i1], W[i2]], [W[i2], W[i0]]]) {
        const key = base + (p < r ? p * V + r : r * V + p);
        let arr = edgeTris.get(key);
        if (!arr) edgeTris.set(key, (arr = []));
        arr.push(t);
      }
    }
  }

  // 4.3 洪水填充连通域
  const visited = new Uint8Array(tris.length);
  const islands = [];
  const stack = [];
  for (let seed = 0; seed < tris.length; seed++) {
    if (visited[seed]) continue;
    const comp = [];
    stack.length = 0;
    stack.push(seed);
    visited[seed] = 1;
    while (stack.length) {
      const t = stack.pop();
      comp.push(t);
      const cur = tris[t];
      const base = cur.srcIdx * 1e12;
      const V = welds[cur.srcIdx].V;
      const W = cur.W;
      for (const [p, r] of [[W[cur.i0], W[cur.i1]], [W[cur.i1], W[cur.i2]], [W[cur.i2], W[cur.i0]]]) {
        const key = base + (p < r ? p * V + r : r * V + p);
        for (const nb of edgeTris.get(key)) {
          if (!visited[nb]) { visited[nb] = 1; stack.push(nb); }
        }
      }
    }
    islands.push(comp);
  }

  // 4.4 岛屿归属：多数区域投票；一致率不足的（跨区域大岛）回退逐三角形切分
  const buckets = new Map();
  for (const id of REGIONS) buckets.set(id, { tris: [], sum: new THREE.Vector3(), count: 0 });
  const AGREE = 0.8;        // 一致率 ≥ 此值 → 整岛归属多数区域
  const vote = new Int32Array(REGIONS.length);
  const addTris = (region, list) => {
    const bucket = buckets.get(region);
    for (const t of list) {
      const tri = tris[t];
      bucket.tris.push({ src: tri.src, i0: tri.i0, i1: tri.i1, i2: tri.i2 });
      bucket.sum.x += cents[t * 3];
      bucket.sum.y += cents[t * 3 + 1];
      bucket.sum.z += cents[t * 3 + 2];
      bucket.count++;
    }
  };

  let wholeIslands = 0, splitIslands = 0, largestIsland = 0;
  const bigSplits = [];   // 跨区域大岛明细（调试用）

  /* 跨区域大岛（连续壳体，例如整圈躯干、骨盆与大腿）必须切开，但「直刀」
   * 按三角形离散化后会切出一圈锯齿尖刺。这里在岛内做一次折痕寻路的标签
   * 细化（ICM）：
   *   E = Σ_t [标签 ≠ 直线规则标签]·λ  +  Σ_边 β(折痕)·[两端标签不同]
   * β 在平滑面上 ≈1、在锐利折痕上 ≈0.03 —— 于是断口会主动贴到甲片分模线，
   * 只在没有沟槽可走时才勉强直切。 */
  const slot = new Int32Array(tris.length).fill(-1);   // 全局 tri → 岛内局部下标（复用）
  let refineChanged = 0;                              // 折痕细化改动的三角形总数（统计）
  const refineIslandLabels = (comp) => {
    const local = new Int8Array(comp.length);   // 局部下标 → 区域号
    const cand = [];
    for (let i = 0; i < comp.length; i++) {
      const r = triRegion[comp[i]];
      local[i] = r;
      if (r >= 0 && cand.indexOf(r) < 0) cand.push(r);
    }
    if (cand.length < 2) return local;

    const LAMBDA = 0.45;       // 偏离直线规则的数据项代价
    for (let i = 0; i < comp.length; i++) slot[comp[i]] = i;

    let flips = 0;
    for (let iter = 0; iter < 24; iter++) {
      let changed = 0;
      for (let i = 0; i < comp.length; i++) {
        const t = comp[i];
        const plane = triRegion[t];
        if (plane < 0) continue;
        const tri = tris[t];
        const W = tri.W;
        const V = welds[tri.srcIdx].V;
        const base = tri.srcIdx * 1e12;
        const tx = nrm[t * 3], ty = nrm[t * 3 + 1], tz = nrm[t * 3 + 2];
        // 邻居 + 折痕权重
        const nbIdx = [], nbBeta = [];
        for (const [p, r] of [[W[tri.i0], W[tri.i1]], [W[tri.i1], W[tri.i2]], [W[tri.i2], W[tri.i0]]]) {
          const key = base + (p < r ? p * V + r : r * V + p);
          const list = edgeTris.get(key);
          if (!list || list.length < 2) continue;
          for (const nb of list) {
            if (nb === t) continue;
            const li = slot[nb];
            if (li < 0) continue;
            const dot = tx * nrm[nb * 3] + ty * nrm[nb * 3 + 1] + tz * nrm[nb * 3 + 2];
            const crease = 1 - Math.max(-1, Math.min(1, dot));   // 0=共面 1=90° 2=反折
            nbIdx.push(li);
            nbBeta.push(1 - 0.97 * Math.min(1, crease / 0.6));
          }
        }
        let bestL = local[i], bestC = Infinity;
        for (const c of cand) {
          let cost = c === plane ? 0 : LAMBDA;
          for (let k = 0; k < nbIdx.length; k++) if (local[nbIdx[k]] !== c) cost += nbBeta[k];
          if (cost < bestC - 1e-9) { bestC = cost; bestL = c; }
        }
        if (bestL !== local[i]) { local[i] = bestL; changed++; }
      }
      flips += changed;
      if (!changed) break;
    }
    refineChanged += flips;
    for (let i = 0; i < comp.length; i++) slot[comp[i]] = -1;   // 归还映射
    return local;
  };
  for (const comp of islands) {
    if (comp.length > largestIsland) largestIsland = comp.length;
    vote.fill(0);
    let valid = 0;
    for (const t of comp) { const r = triRegion[t]; if (r >= 0) { vote[r]++; valid++; } }
    let best = -1, bestN = 0;
    for (let r = 0; r < vote.length; r++) if (vote[r] > bestN) { bestN = vote[r]; best = r; }
    if (best >= 0 && valid && bestN / valid >= AGREE) {
      wholeIslands++;
      addTris(REGIONS[best], comp);
    } else {
      // 跨区域大岛：细化断口后按局部标签分桶（断口沿甲片沟槽走）
      splitIslands++;
      if (comp.length >= 400) {
        bigSplits.push({
          size: comp.length,
          mix: REGIONS.map((r, i) => [r, vote[i]]).filter(([, n]) => n > 0),
        });
      }
      const local = refineIslandLabels(comp);
      const byRegion = new Map();
      for (let i = 0; i < comp.length; i++) {
        const r = local[i];
        if (r < 0) continue;
        let arr = byRegion.get(r);
        if (!arr) byRegion.set(r, (arr = []));
        arr.push(comp[i]);
      }
      for (const [r, arr] of byRegion) addTris(REGIONS[r], arr);
    }
  }
  splitStats = {
    islands: islands.length,
    wholeIslands,
    splitIslands,
    largestIsland,
    tris: tris.length,
    bigSplits: bigSplits.sort((x, y) => y.size - x.size).slice(0, 8),
    refineChanged,
  };

  // ---- 阶段 5：每区域合并构建子几何（顶点减去区域中心） ----
  const out = new Map();
  for (const [region, bucket] of buckets) {
    if (bucket.tris.length === 0) continue;
    const center = bucket.sum.multiplyScalar(1 / bucket.count);
    out.set(region, {
      geometry: buildRegionGeometry(bucket.tris, center),
      center,
      material: bucket.tris[0].src.mesh.material,
    });
  }
  return out;
}

/** 把一个区域的三角形重索引成独立 BufferGeometry（通用复制全部顶点属性，position 减 center） */
function buildRegionGeometry(tris, center) {
  // 按源网格分组（多材质/多网格时各源独立重编号，再拼到一个几何里）
  const srcOrder = [];
  const srcId = new Map();
  for (const t of tris) {
    if (!srcId.has(t.src)) { srcId.set(t.src, srcOrder.length); srcOrder.push(t.src); }
  }
  const perSrc = srcOrder.map(() => ({ used: new Map(), tris: [] }));
  for (const t of tris) {
    const s = perSrc[srcId.get(t.src)];
    s.tris.push(t);
    for (const old of [t.i0, t.i1, t.i2]) if (!s.used.has(old)) s.used.set(old, -1);
  }

  // 为每个源分配属性缓冲（通用复制 position/normal/uv/tangent/…）
  let totalVerts = 0;
  const attrData = srcOrder.map((src, siIdx) => {
    const g = src.mesh.geometry;
    const names = Object.keys(g.attributes);
    const maps = {};
    for (const name of names) {
      const at = g.attributes[name];
      maps[name] = { at, arr: new Float32Array(perSrc[siIdx].used.size * at.itemSize) };
    }
    const d = { names, maps, vertBase: totalVerts, vertCount: perSrc[siIdx].used.size };
    totalVerts += perSrc[siIdx].used.size;
    return d;
  });

  // 填充顶点
  attrData.forEach((d, siIdx) => {
    const s = perSrc[siIdx];
    let ni = 0;
    for (const old of s.used.keys()) {
      s.used.set(old, ni);
      for (const name of d.names) {
        const m = d.maps[name];
        if (name === 'position') {
          m.arr[ni * 3] = m.at.getX(old) - center.x;
          m.arr[ni * 3 + 1] = m.at.getY(old) - center.y;
          m.arr[ni * 3 + 2] = m.at.getZ(old) - center.z;
        } else {
          for (let k = 0; k < m.at.itemSize; k++) {
            m.arr[ni * m.at.itemSize + k] = m.at.array[old * m.at.itemSize + k];
          }
        }
      }
      ni++;
    }
  });

  // 合并各源的同名属性 + 拼接索引
  const g = new THREE.BufferGeometry();
  const names = attrData[0].names;
  for (const name of names) {
    const itemSize = attrData[0].maps[name].at.itemSize;
    const merged = new Float32Array(totalVerts * itemSize);
    attrData.forEach((d) => merged.set(d.maps[name].arr, d.vertBase * itemSize));
    g.setAttribute(name, new THREE.BufferAttribute(merged, itemSize));
  }
  const indexArr = new Uint32Array(tris.length * 3);
  let w = 0;
  for (const t of tris) {
    const d = attrData[srcId.get(t.src)];
    const s = perSrc[srcId.get(t.src)];
    indexArr[w++] = d.vertBase + s.used.get(t.i0);
    indexArr[w++] = d.vertBase + s.used.get(t.i1);
    indexArr[w++] = d.vertBase + s.used.get(t.i2);
  }
  g.setIndex(new THREE.BufferAttribute(indexArr, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * segment.js — MK7 装甲空间切分（页面自包含，不依赖 index 页模块）
 *
 * mk7 的 armor2.glb 是「单块蒙皮网格」，没有部件层级。
 * 关键点：蒙皮网格的渲染位置由骨骼静止姿态决定（bindMatrix/node 矩阵都不可靠），
 * 因此先按 skinIndex/skinWeight 手动烘焙顶点到世界坐标（等价于着色器的蒙皮变换），
 * 再按三角面质心划分到 9 个身体区域，每个区域一个可独立位移的模块。
 *
 * 归一化在烘焙坐标上完成（高 1.95、贴地、居中），子网格顶点减去区域中心，
 * pivot.position = center + offset * H * t —— 位移恒为绝对量，反复拆装无累积误差。
 */
import * as THREE from 'three';

export const REGIONS = ['helmet', 'chest', 'back', 'armL', 'armR', 'legL', 'legR'];

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

  // ---- 阶段 4：按三角面质心分桶 ----
  const height = targetHeight;
  const buckets = new Map();
  for (const id of REGIONS) buckets.set(id, { tris: [], sum: new THREE.Vector3(), count: 0 });

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cen = new THREE.Vector3();

  for (const src of baked) {
    const pos = src.mesh.geometry.getAttribute('position');
    const index = src.mesh.geometry.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    for (let i = 0; i < triCount; i++) {
      const i0 = index ? index.getX(i * 3) : i * 3;
      const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
      const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      if (!Number.isFinite(cen.x + cen.y + cen.z)) continue;
      const region = classify(cen.x, cen.y, cen.z, height);
      const bucket = buckets.get(region);
      bucket.tris.push({ src, i0, i1, i2 });
      bucket.sum.add(cen);
      bucket.count++;
    }
  }

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

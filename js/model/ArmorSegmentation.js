/**
 * ArmorSegmentation.js — 空间区域切分
 *
 * 输入一个已烘焙到世界坐标（归一化：y ∈ [0, H]，x/z 居中）的 BufferGeometry，
 * 按三角面质心的空间位置将其划分到身体区域，输出每个区域的独立 BufferGeometry。
 * 单网格 GLB 模型因此获得可交互、可拆解的"模块"结构。
 */
import * as THREE from 'three';
import { SEGMENT_THRESHOLDS as T } from '../config/armor.config.js';

export const REGION_IDS = ['helmet', 'chest', 'back', 'armL', 'armR', 'handL', 'handR', 'legL', 'legR'];

/**
 * 判定单个三角面（质心）所属区域。
 * @param {number[]} c 三角面质心 [x, y, z]（模型局部坐标，y 从脚底 0 到 H）
 * @param {number} h 模型总高
 * @returns {string} REGION_IDS 之一
 */
export function classifyTriangle(c, h) {
  const t = c[1] / h;
  const ax = Math.abs(c[0]);

  // 头部
  if (t >= T.helmetTop) return 'helmet';

  // 手臂区（肩至指尖，躯干两侧之外）
  if (ax > T.armX && t >= T.armMinT) {
    const hand = t < T.handTop;
    const side = c[0] > 0 ? 'L' : 'R'; // 模型面向 +z，其左侧为 +x
    return hand ? `hand${side}` : `arm${side}`;
  }

  // 腰部以下 → 双腿（左右按 x 分割）
  if (t <= T.waist) return c[0] > 0 ? 'legL' : 'legR';

  // 躯干：按深度分背板/胸甲
  return c[2] < T.backZ ? 'back' : 'chest';
}

/**
 * 将几何体按区域切分为多个 BufferGeometry。
 * @param {THREE.BufferGeometry} geometry 已烘焙/归一化的几何体（必须含 index 与 position）
 * @param {number} height 模型总高
 * @returns {Map<string, THREE.BufferGeometry>} region → geometry（空区域不返回）
 */
export function segmentGeometry(geometry, height) {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();

  const triCount = index ? index.count / 3 : pos.count / 3;
  const buckets = new Map(); // region -> { indices: number[] }
  for (const id of REGION_IDS) buckets.set(id, []);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const centroid = new THREE.Vector3();

  for (let i = 0; i < triCount; i++) {
    const i0 = index ? index.getX(i * 3) : i * 3;
    const i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    // 防御：跳过退化/非有限三角面（部分 FBX 导出源数据可能携带）
    if (!Number.isFinite(centroid.x + centroid.y + centroid.z)) continue;

    const region = classifyTriangle([centroid.x, centroid.y, centroid.z], height);
    buckets.get(region).push(i0, i1, i2);
  }

  const out = new Map();
  for (const [region, tri] of buckets) {
    if (tri.length === 0) continue;
    out.set(region, buildSubGeometry(pos, nor, uv, tri));
  }
  return out;
}

/** 用顶点重索引的方式构建子几何体（共享原始属性数据） */
function buildSubGeometry(pos, nor, uv, triangles) {
  // 收集用到的顶点，重编号
  const used = new Map(); // oldIndex -> newIndex
  const newIndex = new Uint32Array(triangles.length);
  for (let i = 0; i < triangles.length; i++) {
    const old = triangles[i];
    let ni = used.get(old);
    if (ni === undefined) {
      ni = used.size;
      used.set(old, ni);
    }
    newIndex[i] = ni;
  }
  const vertCount = used.size;

  const g = new THREE.BufferGeometry();
  const p = new Float32Array(vertCount * 3);
  const n = nor ? new Float32Array(vertCount * 3) : null;
  const u = uv ? new Float32Array(vertCount * 2) : null;

  for (const [old, ni] of used) {
    p[ni * 3] = pos.getX(old);
    p[ni * 3 + 1] = pos.getY(old);
    p[ni * 3 + 2] = pos.getZ(old);
    if (n) {
      n[ni * 3] = nor.getX(old);
      n[ni * 3 + 1] = nor.getY(old);
      n[ni * 3 + 2] = nor.getZ(old);
    }
    if (u) {
      u[ni * 2] = uv.getX(old);
      u[ni * 2 + 1] = uv.getY(old);
    }
  }

  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  if (n) g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  if (u) g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
  g.setIndex(new THREE.BufferAttribute(newIndex, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

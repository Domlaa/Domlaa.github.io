/**
 * ModelLoader.js — GLB 加载与归一化
 *
 * 加载 GLB 后将所有几何体烘焙到世界坐标，再统一归一化：
 *   - 模型水平居中（x/z 均值归零）
 *   - 脚底对齐 y = 0
 *   - 返回合并后的单一几何体，供切分模块使用
 * 未来替换其他 GLB：只要是人形直立模型，此流程无需改动。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

// Draco 解码器（本地化在 lib/three/addons/libs/draco/）；非压缩模型走原路径，行为不变
let _draco = null;
function dracoLoader() {
  if (!_draco) _draco = new DRACOLoader().setDecoderPath('./lib/three/addons/libs/draco/');
  return _draco;
}

/**
 * @param {string} url
 * @param {(progress:number)=>void} [onProgress]
 * @returns {Promise<{geometry: THREE.BufferGeometry, height: number, originalScene: THREE.Group}>}
 */
export function loadArmorGeometry(url, onProgress) {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader().setDRACOLoader(dracoLoader());
    loader.load(
      url,
      (gltf) => {
        try {
          resolve(prepareGeometry(gltf.scene));
        } catch (err) {
          reject(err);
        }
      },
      (ev) => {
        if (onProgress && ev.total > 0) onProgress(ev.loaded / ev.total);
      },
      (err) => reject(err),
    );
  });
}

function prepareGeometry(root) {
  root.updateMatrixWorld(true);

  // 收集所有网格几何体并烘焙世界变换
  const parts = [];
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry) {
      const g = obj.geometry.clone();
      g.applyMatrix4(obj.matrixWorld);
      parts.push(g);
    }
  });
  if (parts.length === 0) throw new Error('GLB 中未找到网格数据');

  // 合并（无 index 的先转 indexed）
  let merged;
  if (parts.length === 1) {
    merged = parts[0];
  } else {
    for (const g of parts) {
      if (!g.index) {
        const count = g.getAttribute('position').count;
        g.setIndex([...Array(count).keys()]);
      }
    }
    merged = mergeGeometriesFallback(parts);
  }

  // 归一化：居中 x/z，脚底 y=0
  merged.computeBoundingBox();
  const bb = merged.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;
  const height = bb.max.y - bb.min.y;
  merged.translate(-cx, -bb.min.y, -cz);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  if (!merged.getAttribute('normal')) merged.computeVertexNormals();
  return { geometry: merged, height, originalScene: root };
}

/** 轻量合并：仅拼接 position/normal/uv + index（避免额外依赖行为差异） */
function mergeGeometriesFallback(geos) {
  const attrs = ['position', 'normal', 'uv'];
  const use = attrs.filter((a) => geos.every((g) => g.getAttribute(a)));

  const counts = geos.map((g) => g.getAttribute('position').count);
  const totalV = counts.reduce((s, c) => s + c, 0);
  const totalI = geos.reduce((s, g) => s + g.getIndex().count, 0);

  const out = new THREE.BufferGeometry();
  const offsets = {};
  for (const name of use) {
    const itemSize = geos[0].getAttribute(name).itemSize;
    const arr = new Float32Array(totalV * itemSize);
    let off = 0;
    for (const g of geos) {
      arr.set(g.getAttribute(name).array, off);
      off += g.getAttribute(name).array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
    offsets[name] = true;
  }

  const idx = new Uint32Array(totalI);
  let vBase = 0, iOff = 0;
  for (const g of geos) {
    const gi = g.getIndex();
    for (let i = 0; i < gi.count; i++) idx[iOff++] = gi.getX(i) + vBase;
    vBase += g.getAttribute('position').count;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

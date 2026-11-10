/**
 * SurfaceMaterial.js — 装甲底材（配合屏幕空间边缘检测）
 *
 * 首页现在用「线条 + 流光」渲染：装甲表面只负责
 *   1. 写入 alpha = 1，作为合成通道的遮罩（把装甲和 3D 背景区分开）
 *   2. 提供极弱的明暗，让线条下面有一层可感知的实测体块
 * 真正的轮廓 / 折线 / 细缝由 EdgePass 从法线、深度、亮度三个通道提取。
 */
import * as THREE from 'three';

export function createSurfaceMaterial() {
  return new THREE.MeshLambertMaterial({
    color: 0x2a5064,
    emissive: 0x02090f,
    transparent: false,
    depthWrite: true,
  });
}

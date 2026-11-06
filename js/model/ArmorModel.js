/**
 * ArmorModel.js — 战甲模型管理
 *
 * 职责：
 *  1. 加载 GLB 并归一化（ModelLoader）
 *  2. 按空间区域切分为独立模块（ArmorSegmentation）
 *  3. 为每个模块构建：全息材质网格 + 线框叠加层 + 锚点（HUD 投影用）
 *  4. 管理模块的显隐 / 选中 / 悬停状态，并暴露给交互与动画系统
 *
 * 模块结构：armorGroup
 *   └─ pivot（模块组，位于模块锚点）
 *        └─ mesh（几何体偏移 -anchor，即烘焙在模型坐标中）
 *        └─ wire（线框叠加层）
 *
 * 替换真实 GLB 模型无需重写渲染系统：本类对外只暴露 Module 对象集合。
 */
import * as THREE from 'three';
import { loadArmorGeometry } from './ModelLoader.js';
import { segmentGeometry } from './ArmorSegmentation.js';
import { HolographicMaterial, WireMaterial } from '../materials/HolographicMaterial.js';
import { MODULES, MODEL_URL } from '../config/armor.config.js';

export class ArmorModel {
  constructor() {
    this.group = new THREE.Group();       // 整体（自转作用于此）
    this.modules = new Map();             // id -> Module
    this.height = 0;
    this.materials = [];                  // 所有全息材质实例（共享 uniforms 调度）
    this._hovered = null;
    this._selected = null;
    this.holo = true;
    this.wireEnabled = WireMaterial.enabled;
  }

  /**
   * 加载并构建模块。
   * @param {(p:number)=>void} [onProgress]
   * @returns {Promise<ArmorModel>}
   */
  async load(onProgress) {
    const { geometry, height } = await loadArmorGeometry(MODEL_URL, onProgress);
    this.height = height;

    const segmented = segmentGeometry(geometry, height);
    geometry.dispose();

    // 与配置中的模块定义关联（procedural 模块如 arcReactor 由外部创建后 attach）
    for (const def of MODULES) {
      if (def.procedural) continue;
      const geo = segmented.get(def.region);
      if (!geo) continue;
      this._createModule(def, geo);
    }
    return this;
  }

  /** @private */
  _createModule(def, geometry) {
    const mat = new HolographicMaterial(def.id);
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geometry, mat.material);
    mesh.renderOrder = 1;

    const wire = new THREE.Mesh(geometry, WireMaterial.instance());
    wire.renderOrder = 2;
    wire.scale.setScalar(1.0015);
    wire.visible = WireMaterial.enabled;

    // 模块锚点 = 几何体包围盒中心；pivot 放在锚点，mesh 反向偏移，
    // 这样 pivot 的位移/旋转都围绕模块自身中心，且拆解偏移量基于原始位置计算。
    geometry.computeBoundingBox();
    const anchor = new THREE.Vector3();
    geometry.boundingBox.getCenter(anchor);

    const pivot = new THREE.Group();
    pivot.position.copy(anchor);
    mesh.position.copy(anchor).negate();
    wire.position.copy(anchor).negate();
    pivot.add(mesh, wire);
    this.group.add(pivot);

    const module = {
      id: def.id,
      def,
      pivot,
      mesh,
      wire,
      anchor,               // 模型坐标中的原始锚点（世界坐标 = armorGroup 变换后）
      material: mat,
      basePosition: anchor.clone(),
      visible: true,
      explodeT: 0,          // 当前拆解进度 0..1
      revealT: 0,           // 数字化显现进度 0..1
      hoverT: 0,            // 悬停高亮（平滑过渡）
      selectT: 0,           // 选中高亮
      tris: geometry.getIndex().count / 3,
    };
    this.modules.set(def.id, module);
    return module;
  }

  /** 外部（如 ArcReactor）把程序化模块挂进管理系统 */
  attachProceduralModule(module) {
    this.modules.set(module.id, module);
    if (module.material) this.materials.push(module.material);
    this.group.add(module.pivot);
  }

  /** 每帧状态推进（悬停/选中高亮的平滑过渡 + 显现/扫描 uniforms） */
  update(dt, time) {
    for (const m of this.modules.values()) {
      const targetHover = this._hovered === m ? 1 : 0;
      const targetSelect = this._selected === m ? 1 : 0;
      m.hoverT += (targetHover - m.hoverT) * Math.min(1, dt * 10);
      m.selectT += (targetSelect - m.selectT) * Math.min(1, dt * 8);

      if (m.material) {
        m.material.setHighlight(m.hoverT, m.selectT);
        m.material.setReveal(m.revealT);
        m.material.updateTime(time);
      }
    }
  }

  get hovered() { return this._hovered; }
  get selected() { return this._selected; }

  setHovered(module) {
    if (this._hovered === module) return;
    this._hovered = module;
    document.body.style.cursor = module ? 'pointer' : '';
  }

  setSelected(module) {
    this._selected = module;
  }

  /** 模块可见性（隐藏时不参与拾取与指示线） */
  setModuleVisible(id, visible) {
    const m = this.modules.get(id);
    if (!m) return;
    m.visible = visible;
    m.pivot.visible = visible;
  }

  /** 隐所有模块（供"单独显示"） */
  setAllVisible(visible) {
    for (const m of this.modules.values()) this.setModuleVisible(m.id, visible);
  }

  /** 全息材质开/关（关闭 = 实体金属外观） */
  setHologram(on) {
    this.holo = on;
    for (const m of this.materials) m.setHologram(on);
    // 实体模式下隐藏线框叠加层，避免噪点；透明白模需要写深度
    for (const m of this.modules.values()) {
      if (m.wire) m.wire.visible = this.wireEnabled && on;
      if (m.material) m.material.material.depthWrite = !on;
    }
  }

  setWireframe(on) {
    WireMaterial.enabled = on;
    this.wireEnabled = on;
    for (const m of this.modules.values()) {
      if (m.wire) m.wire.visible = on && (this.holo !== false);
    }
  }

  setOpacity(v) {
    for (const m of this.materials) m.setOpacity(v);
  }

  setScanSpeed(norm) { this._scanSpeed = norm; }
  get scanSpeed() { return this._scanSpeed ?? 0.35; }

  /** 释放 GPU 资源 */
  dispose() {
    for (const m of this.modules.values()) {
      m.mesh.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    this.modules.clear();
  }
}

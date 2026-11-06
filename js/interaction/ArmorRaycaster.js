/**
 * ArmorRaycaster.js — 模块拾取
 *
 * 鼠标悬停高亮 / 点击选中 / 点击空处取消选中。
 * 区分"点击"与"拖拽"（OrbitControls 旋转）：按下与抬起位移 < 6px 视为点击。
 */
import * as THREE from 'three';

const CLICK_SLOP = 6;

export class ArmorRaycaster {
  /**
   * @param {HTMLElement} domElement 事件绑定的元素（canvas）
   * @param {import('../model/ArmorModel.js').ArmorModel} armor
   * @param {import('../core/SceneManager.js').SceneManager} sceneManager
   * @param {(module|null)=>void} onSelect 选中变化回调
   */
  constructor(domElement, armor, sceneManager, onSelect) {
    this.armor = armor;
    this.sceneManager = sceneManager;
    this.onSelect = onSelect;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.enabled = true;

    this._down = null;

    domElement.addEventListener('pointermove', (e) => this._onMove(e));
    domElement.addEventListener('pointerdown', (e) => { this._down = [e.clientX, e.clientY]; });
    domElement.addEventListener('pointerup', (e) => this._onUp(e));
  }

  /** 求鼠标指向的模块（考虑模块显隐） */
  pick(clientX, clientY) {
    const rect = this.sceneManager.canvas.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.sceneManager.camera);

    const targets = [];
    for (const m of this.armor.modules.values()) {
      if (!m.visible) continue;
      if (m.pickMesh) targets.push(m.pickMesh);
      else if (m.mesh) targets.push(m.mesh);
    }
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const obj = hits[0].object;
    for (const m of this.armor.modules.values()) {
      if (m.pickMesh === obj || m.mesh === obj) return m;
    }
    return null;
  }

  _onMove(e) {
    if (!this.enabled) return;
    this.armor.setHovered(this.pick(e.clientX, e.clientY));
  }

  _onUp(e) {
    if (!this.enabled || !this._down) return;
    const dx = e.clientX - this._down[0];
    const dy = e.clientY - this._down[1];
    this._down = null;
    if (dx * dx + dy * dy > CLICK_SLOP * CLICK_SLOP) return; // 拖拽旋转，不视为点击

    const hit = this.pick(e.clientX, e.clientY);
    this.armor.setSelected(hit);
    this.onSelect(hit);
  }
}

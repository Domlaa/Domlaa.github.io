/**
 * ArmorExplode.js — 拆解 / 组装 / 显现 / 溶解动画
 *
 * 关键约定：拆解位移永远基于模块 pivot 的 basePosition（原始位置）计算，
 *     pivot.position = basePosition + offset * H * progress
 * 重复触发不会累积偏移；进度目标在触发瞬间从当前值平滑过渡。
 */
import { Ease } from './TweenEngine.js';

export class ArmorExplode {
  /**
   * @param {import('../model/ArmorModel.js').ArmorModel} armor
   * @param {import('./TweenEngine.js').TweenEngine} tweens
   * @param {number} [offsetScale] 拆解位移倍率（宽体/高模按需收敛，避免飞出取景）
   */
  constructor(armor, tweens, offsetScale = 1) {
    this.armor = armor;
    this.tweens = tweens;
    this.offsetScale = offsetScale;
    this.exploded = false;
    this.explodeT = 0; // 全局拆解进度（用于按钮状态）
  }

  /** 一键拆解 */
  explode(duration = 1.6) {
    this._runTo(1, duration, 'outCubic');
    this.exploded = true;
  }

  /** 一键组装 */
  assemble(duration = 1.5) {
    this._runTo(0, duration, 'inOutCubic');
    this.exploded = false;
  }

  toggle() {
    if (this.exploded) this.assemble();
    else this.explode();
    return this.exploded;
  }

  _runTo(target, duration, ease) {
    const H = this.armor.height || 1.2;
    for (const m of this.armor.modules.values()) {
      const from = m.explodeT;
      const def = m.def;
      const off = def.explode ? new THREE_OFF(def.explode, H * this.offsetScale) : null;
      const rot = def.rotate || [0, 0, 0];
      const tag = `explode:${m.id}`;
      this.tweens.add({
        tag,
        duration: duration * (0.75 + 0.5 * Math.abs(target - from)),
        ease,
        delay: (def.stagger || 0) * (target === 1 ? 1 : 0.6),
        onUpdate: (_raw, e) => {
          const t = from + (target - from) * e;
          m.explodeT = t;
          if (off) {
            m.pivot.position.set(
              m.basePosition.x + off.x * t,
              m.basePosition.y + off.y * t,
              m.basePosition.z + off.z * t,
            );
          }
          m.pivot.rotation.set(rot[0] * t, rot[1] * t, rot[2] * t);
        },
      });
    }
  }

  /** 数字化显现（页面加载时） */
  materialize(totalDuration = 2.4) {
    for (const m of this.armor.modules.values()) {
      const delay = (m.def.stagger || 0) * 1.2;
      this.tweens.add({
        tag: `reveal:${m.id}`,
        duration: 1.1,
        ease: 'outCubic',
        delay,
        onUpdate: (_raw, e) => { m.revealT = e; },
      });
    }
  }

  /** 数字化溶解（可再次 materialize 重新显现） */
  dematerialize(totalDuration = 1.4) {
    for (const m of this.armor.modules.values()) {
      const from = m.revealT;
      this.tweens.add({
        tag: `reveal:${m.id}`,
        duration: 0.8,
        ease: 'inOutCubic',
        delay: (m.def.stagger || 0) * 0.5,
        onUpdate: (_raw, e) => { m.revealT = from * (1 - e); },
      });
    }
  }
}

/** [x,y,z] 比例偏移 × 模型高度 → 世界偏移 */
function THREE_OFF(ratio, H) {
  return { x: ratio[0] * H, y: ratio[1] * H, z: ratio[2] * H };
}

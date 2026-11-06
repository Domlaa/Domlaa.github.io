/**
 * TweenEngine.js — 轻量补间引擎
 *
 * 支持：暂停 / 恢复 / 按标签管理（同标签新补间自动顶替旧的，避免重复操作叠加）
 * 所有战甲动画（拆解、组装、显现、溶解、视角复位）都由此驱动。
 */
const Ease = {
  linear: (t) => t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  outBack: (t) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

export class TweenEngine {
  constructor() {
    this.tweens = new Set();
    this.paused = false;
  }

  /**
   * @param {object} opts
   * @param {string} [opts.tag] 同标签互斥
   * @param {number} opts.duration 秒
   * @param {string} [opts.ease]
   * @param {number} [opts.delay]
   * @param {(v:number, e:number)=>void} opts.onUpdate v=原始进度, e=eased 进度
   * @param {()=>void} [opts.onComplete]
   */
  add({ tag, duration, ease = 'inOutCubic', delay = 0, onUpdate, onComplete }) {
    if (tag) this.kill(tag);
    const tween = {
      tag, duration: Math.max(duration, 0.001), ease, delay,
      onUpdate, onComplete,
      elapsed: 0, done: false,
    };
    this.tweens.add(tween);
    return tween;
  }

  kill(tag) {
    for (const t of this.tweens) {
      if (t.tag === tag) {
        this.tweens.delete(t);
      }
    }
  }

  /** 标签是否仍有活动补间 */
  has(tag) {
    for (const t of this.tweens) if (t.tag === tag) return true;
    return false;
  }

  update(dt) {
    if (this.paused) return;
    for (const t of [...this.tweens]) {
      t.elapsed += dt;
      if (t.elapsed < t.delay) continue;
      const raw = Math.min((t.elapsed - t.delay) / t.duration, 1);
      const eased = (Ease[t.ease] || Ease.linear)(raw);
      t.onUpdate(raw, eased);
      if (raw >= 1) {
        this.tweens.delete(t);
        if (t.onComplete) t.onComplete();
      }
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  reset() { this.tweens.clear(); this.paused = false; }

  get activeCount() { return this.tweens.size; }
}

export { Ease };

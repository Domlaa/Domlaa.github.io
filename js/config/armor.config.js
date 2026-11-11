/**
 * armor.config.js — armor module configuration
 *
 * Split thresholds are expressed in normalized space (t = y/H with H the model height,
 * x = left/right, z = front/back, model faces +z). Swapping the model only requires
 * retuning the thresholds; the render pipeline stays untouched.
 */

export const MODEL_URL = './assets/models/hulk-buster2_optimized.glb';

export const ARMOR_NAME = 'MARK XLIV';
export const ARMOR_SUB = 'HULK BUSTER';

/**
 * Arc reactor mount point, as ratios of the model height H.
 *
 * The Hulk Buster's reactor bay is a circular recess on the sternum, not a raised plate:
 * its floor sits ~0.11 behind the chest plate and spans ~0.08 across. Measured by
 * ray-casting the chest front surface on a 5 mm grid, then taking the centroid of the
 * cavity floor. The model's own mid-line is not x = 0 (this suit is asymmetric), and the
 * head/torso are normalised by their bounding box, so the bay ends up slightly off-axis.
 * z is chosen to sit inside the recess, behind the surrounding plate.
 */
export const REACTOR_MOUNT = { x: -0.0155, y: 0.742, z: 0.158 };

/** Spatial split thresholds (t = y/H, x left-right, z front-back, model faces +z) */
export const SEGMENT_THRESHOLDS = {
  helmetTop: 0.885,   // above this t -> helmet
  armX: 0.255,        // |x| beyond this (within torso band) -> arm zone (Hulk Buster is wide)
  handTop: 0.50,      // inside arm zone, t below this -> hand (wrist cut)
  armMinT: 0.30,      // lowest arm height (fingertips)
  waist: 0.455,       // torso / thigh boundary (waist cut)
  backZ: -0.055,      // within torso band, z below this -> back unit
};

/**
 * Module definitions
 * explode: teardown offset as a ratio of model height H, [x, y, z]
 * rotate:  spin while exploded (radians, around the module anchor)
 * stagger: timing offset for the explode / reveal animation (seconds)
 */
export const MODULES = [
  {
    id: 'helmet', region: 'helmet',
    name: 'HELMET', sub: 'head unit',
    desc: 'Titanium composite laminate shell with a heads-up targeting array and full-band comms. The faceplate opens in 0.3 s.',
    stats: [
      ['PLATING', '4.2 mm', 0.62],
      ['IMPACT', '9.1 G', 0.91],
      ['SENSORS', '14 CH', 0.80],
    ],
    explode: [0, 0.34, 0], rotate: [0.16, 0, 0], stagger: 0.50,
  },
  {
    id: 'chest', region: 'chest',
    name: 'CHEST', sub: 'breastplate',
    desc: 'Primary load-bearing section. Houses life support and flight attitude control; the arc reactor bay sits on the front plate.',
    stats: [
      ['PLATING', '6.8 mm', 0.88],
      ['RIGIDITY', 'CLASS A', 0.95],
      ['MASS RATIO', '18.4%', 0.55],
    ],
    explode: [0, 0.02, 0.30], rotate: [0, 0, 0], stagger: 0.30,
  },
  {
    id: 'reactor', region: null, // procedural core, not carved out of the mesh
    name: 'ARC REACTOR', sub: 'energy core',
    desc: 'Palladium arc reactor rated 3.42 GJ/s, feeding the whole suit. Emits a characteristic cyan glow while running.',
    stats: [
      ['OUTPUT', '3.42 GJ/s', 0.97],
      ['CORE TEMP', '2400 K', 0.72],
      ['FUEL', '99.2%', 0.99],
    ],
    explode: [0, 0.02, 0.30], rotate: [0, 0, 0], stagger: 0.42,
    procedural: true,
  },
  {
    id: 'armL', region: 'armL',
    name: 'LEFT ARM', sub: 'upper limb L',
    desc: 'Dual-joint servo drive. Carries a micro missile bay and a laser induction unit along the forearm.',
    stats: [
      ['TORQUE', '820 N·m', 0.78],
      ['LATENCY', '2.1 ms', 0.86],
      ['HARDPOINTS', '2', 0.40],
    ],
    explode: [0.30, 0.04, 0], rotate: [0, 0, -0.20], stagger: 0.18,
  },
  {
    id: 'armR', region: 'armR',
    name: 'RIGHT ARM', sub: 'upper limb R',
    desc: 'Dual-joint servo drive. The forearm routes the repulsor waveguide, 2.1 GW peak output.',
    stats: [
      ['TORQUE', '820 N·m', 0.78],
      ['REPULSOR', '2.1 GW', 0.94],
      ['LATENCY', '2.1 ms', 0.86],
    ],
    explode: [-0.30, 0.04, 0], rotate: [0, 0, 0.20], stagger: 0.24,
  },
  {
    id: 'handL', region: 'handL',
    name: 'LEFT HAND', sub: 'manipulator L',
    desc: 'Five-finger fully actuated manipulator. Fingertip pressure arrays allow fine work and weapon triggering.',
    stats: [
      ['DOF', '21 DOF', 0.84],
      ['GRIP', '1.2 kN', 0.70],
      ['TACTILE', '96 PT', 0.60],
    ],
    explode: [0.42, -0.02, 0], rotate: [0, 0, -0.32], stagger: 0.10,
  },
  {
    id: 'handR', region: 'handR',
    name: 'RIGHT HAND', sub: 'manipulator R',
    desc: 'Five-finger fully actuated manipulator. The palm doubles as the repulsor emission window.',
    stats: [
      ['DOF', '21 DOF', 0.84],
      ['GRIP', '1.2 kN', 0.70],
      ['EMITTER', '1', 0.90],
    ],
    explode: [-0.42, -0.02, 0], rotate: [0, 0, 0.32], stagger: 0.14,
  },
  {
    id: 'legL', region: 'legL',
    name: 'LEFT LEG', sub: 'lower limb L',
    desc: 'Hybrid hydraulic / electromagnetic drive. The sole carries an auxiliary thruster and a landing damper.',
    stats: [
      ['DRIVE', '5.6 kW', 0.66],
      ['IMPULSE', '4.8 kN·s', 0.82],
      ['ARMOR', 'B+', 0.72],
    ],
    explode: [0.19, 0, 0], rotate: [0, 0, 0.10], stagger: 0.06,
  },
  {
    id: 'legR', region: 'legR',
    name: 'RIGHT LEG', sub: 'lower limb R',
    desc: 'Hybrid hydraulic / electromagnetic drive. The sole carries an auxiliary thruster and a landing damper.',
    stats: [
      ['DRIVE', '5.6 kW', 0.66],
      ['IMPULSE', '4.8 kN·s', 0.82],
      ['ARMOR', 'B+', 0.72],
    ],
    explode: [-0.19, 0, 0], rotate: [0, 0, -0.10], stagger: 0.03,
  },
  {
    id: 'back', region: 'back',
    name: 'BACK UNIT', sub: 'thruster pack',
    desc: 'Twin back-mounted thruster pack, 2×8.7 kN cruise thrust, with four vector trim nozzles.',
    stats: [
      ['THRUST', '2×8.7 kN', 0.90],
      ['ENDURANCE', '38 min', 0.58],
      ['NOZZLES', '4', 0.76],
    ],
    explode: [0, 0.02, -0.32], rotate: [-0.14, 0, 0], stagger: 0.36,
  },
];

/** Camera & scene */
export const SCENE_CONFIG = {
  cameraFov: 32,
  fitScale: 1.18,      // framing distance multiplier (wide models need a little more)
  explodeScale: 0.5,   // teardown offset multiplier (keeps parts inside the frame)
  explodeZoom: 1.46,   // camera pull-back while exploded
  autoSpin: 0.18,      // default idle spin, rad/s (slider 30/100)
  particles: 380,
  bg: 0x030912,
  /** Edge line / flow defaults */
  line: { strength: 0.95, width: 1.1, flow: 0.9, speed: 0.22, surface: 0.30, color: '#9fe8ff' },
};

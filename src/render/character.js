import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { toon, withOutline, makeCanvas, canvasTexture, shade } from './materials.js';

const SKIN = ['#f1c27d', '#c68642', '#8d5524', '#5c3a21'];
const HAIR = ['#111111', '#3b2314', '#f2d16b', '#d8d8d8', '#c0392b', '#111111'];
const MAX_VISUAL_DT = 0.05;

// Put a Mixamo-rigged humanoid here: public/models/swimmer.glb. If the file is missing or
// fails to load, every swimmer silently falls back to the procedural rig below.
const MODEL_URL = 'models/swimmer.glb';

// Sim state -> Mixamo clip names (first case-insensitive substring match wins).
const CLIP_CANDIDATES = {
  idle: ['Idle', 'Tread Water', 'Breathing Idle', 'Standing'],
  swim: ['Swimming', 'Swim', 'Front Crawl', 'Fast Run', 'Running'],
  throw: ['Throw', 'Throwing', 'Overhand Throw', 'Punch'],
  volley: ['Swing', 'Soccer Kick', 'Kicking', 'Throw'],
  tackle: ['Sliding', 'Running Slide', 'Diving', 'Slide'],
  hit: ['Punch', 'Boxing', 'Push'],
  breach: ['Jump', 'Jumping', 'Jump Up'],
  save: ['Dive', 'Falling', 'Dodge'],
  stumble: ['Stumble', 'Dizzy', 'Walking Backward'],
  fallen: ['Falling', 'Getting Up', 'Death', 'Fall'],
  celebrate: ['Dancing', 'Victory', 'Clapping', 'Cheer'],
  trick: ['Dancing', 'Martial Arts', 'Twist', 'Spin'],
};

// Shared across every CharacterView: one download, skeleton clones per player.
const gltfLoader = new GLTFLoader();
let templatePromise = null;

function loadCharacterTemplate() {
  if (!templatePromise) {
    templatePromise = gltfLoader.loadAsync(MODEL_URL).then(
      (gltf) => gltf,
      (err) => {
        console.warn(`[character] ${MODEL_URL} not loaded — using procedural swimmers.`, err);
        return null;
      }
    );
  }
  return templatePromise;
}

function resolveClipMap(animations) {
  const lower = animations.map((c) => ({ clip: c, name: c.name.toLowerCase() }));
  const find = (names) => {
    for (const n of names) {
      const hit = lower.find((c) => c.name.includes(n.toLowerCase()));
      if (hit) return hit.clip;
    }
    return null;
  };
  const map = {};
  for (const key of Object.keys(CLIP_CANDIDATES)) map[key] = find(CLIP_CANDIDATES[key]);
  map.idle = map.idle || animations[0] || null;
  map.swim = map.swim || map.idle;
  return map;
}

function clipKeyFor(state, speed) {
  switch (state) {
    case 'shoot': case 'gbwind': case 'pass': return 'throw';
    case 'volley': return 'volley';
    case 'tackle': return 'tackle';
    case 'hit': return 'hit';
    case 'breach': return 'breach';
    case 'save': return 'save';
    case 'stumble': return 'stumble';
    case 'fallen': return 'fallen';
    case 'celebrate': return 'celebrate';
    case 'trick': return 'trick';
    case 'gbdrive': return 'swim';
    case 'catch': return 'idle';
    default: return speed > 0.06 ? 'swim' : 'idle';
  }
}

/**
 * Blitzball swimmer view. Presents a GLTF/Mixamo skinned model when one is available and
 * falls back to the procedural rig otherwise. Public API is unchanged from the original:
 * new CharacterView(data, team), update(p, sim, dt, ballHeldByMe), handWorld(), leftHandWorld().
 */
export class CharacterView {
  constructor(playerData, team) {
    this.data = playerData;
    this.team = team;
    this.root = new THREE.Group();
    this.root.name = `player_${playerData.id}`;
    this.t = 0;
    this.poseReady = false;
    // GLTF state
    this.mixer = null;
    this.actions = null;
    this.clipFor = null;
    this.currentClip = '';
    this.handBone = null;
    this.modelActive = false;
    this.build();
    loadCharacterTemplate().then((template) => {
      if (template) this.prepareModel(template);
    });
  }

  // ---------------------------------------------------------------------------
  // Shared presentation (used in both modes) + procedural rig
  // ---------------------------------------------------------------------------
  build() {
    const d = this.data;
    const team = this.team;
    const isGK = d.role === 'GK';
    const skinMat = toon(SKIN[safeIndex(d.skin, SKIN.length)]);
    const jerseyMat = toon(isGK ? team.accent : team.primary);
    const shortsMat = toon(team.secondary);
    const trimMat = toon(isGK ? team.primary : team.accent);
    const shoeMat = toon(shade(team.accent, -0.1));
    const hairMat = toon(HAIR[safeIndex(d.hair, HAIR.length)]);

    const body = new THREE.Group();
    body.name = 'body';
    this.body = body;
    this.root.add(body);

    this.hips = new THREE.Group();
    this.hips.position.y = 1.0;
    body.add(this.hips);
    this.torso = new THREE.Group();
    this.hips.add(this.torso);
    const torsoMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.42, 4, 10), jerseyMat);
    torsoMesh.position.y = 0.42;
    torsoMesh.scale.set(1.15, 1, 0.8);
    torsoMesh.castShadow = true;
    this.torso.add(withOutline(torsoMesh, 0.04));

    // Jersey number decals
    const decalMat = new THREE.MeshBasicMaterial({ map: this.numberTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), decalMat);
    front.position.set(0, 0.42, 0.215);
    this.torso.add(front);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), decalMat);
    back.position.set(0, 0.46, -0.215);
    back.rotation.y = Math.PI;
    this.torso.add(back);

    // Head + goggles
    this.neck = new THREE.Group();
    this.neck.position.y = 0.82;
    this.torso.add(this.neck);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 12), skinMat);
    head.position.y = 0.16;
    head.scale.set(0.95, 1.08, 0.95);
    head.castShadow = true;
    this.neck.add(withOutline(head, 0.035));
    const goggles = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.028, 8, 20, Math.PI * 1.1), new THREE.MeshBasicMaterial({ color: new THREE.Color(team.accent) }));
    goggles.rotation.x = Math.PI / 2;
    goggles.rotation.z = -Math.PI * 0.05;
    goggles.position.set(0, 0.19, 0);
    this.neck.add(goggles);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.06), new THREE.MeshBasicMaterial({ color: 0x8ff7ff }));
    visor.position.set(0, 0.19, 0.17);
    this.neck.add(visor);
    const hairStyle = safeIndex(d.hair, 6);
    if (hairStyle === 0 || hairStyle === 1) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(hairStyle ? 0.24 : 0.2, 12, 10, 0, Math.PI * 2, 0, hairStyle ? Math.PI * 0.55 : Math.PI * 0.5), hairMat);
      h.position.y = 0.19;
      this.neck.add(h);
    } else if (hairStyle === 2) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.035, 8, 16), trimMat);
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.22;
      this.neck.add(band);
    } else if (hairStyle === 3) {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.205, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), shortsMat);
      cap.position.y = 0.18;
      this.neck.add(cap);
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.03, 0.18), shortsMat);
      brim.position.set(0, 0.2, 0.25);
      this.neck.add(brim);
    } else if (hairStyle === 4) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.3), hairMat);
      h.position.y = 0.3;
      this.neck.add(h);
    } else {
      for (let i = 0; i < 6; i++) {
        const b = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.25, 3, 6), hairMat);
        const a = (i / 6) * Math.PI * 2;
        b.position.set(Math.cos(a) * 0.14, 0.12, Math.sin(a) * 0.14 - 0.05);
        b.rotation.z = Math.cos(a) * 0.5;
        b.rotation.x = -Math.sin(a) * 0.5;
        this.neck.add(b);
      }
      const top = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.45), hairMat);
      top.position.y = 0.19;
      this.neck.add(top);
    }

    // Arms (0 = left, 1 = right — the renderer attaches the ball to arms[1].hand)
    this.arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(s * 0.32, 0.66, 0);
      this.torso.add(shoulder);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.3, 4, 8), skinMat);
      upper.position.y = -0.2;
      shoulder.add(withOutline(upper, 0.03));
      const elbow = new THREE.Group();
      elbow.position.y = -0.38;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.3, 4, 8), skinMat);
      fore.position.y = -0.2;
      elbow.add(withOutline(fore, 0.03));
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 10), trimMat);
      band.position.y = -0.33;
      elbow.add(band);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.095, 10, 8), skinMat);
      hand.position.y = -0.42;
      hand.scale.set(1, 1.15, 0.7);
      elbow.add(withOutline(hand, 0.03));
      hand.name = 'hand';
      this.arms.push({ shoulder, elbow, hand, side: s });
    }

    // Legs
    this.legs = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(s * 0.14, 0.02, 0);
      this.hips.add(hip);
      const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.34, 4, 8), shortsMat);
      thigh.position.y = -0.22;
      hip.add(withOutline(thigh, 0.035));
      const knee = new THREE.Group();
      knee.position.y = -0.46;
      hip.add(knee);
      const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.34, 4, 8), skinMat);
      shin.position.y = -0.2;
      knee.add(withOutline(shin, 0.03));
      const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.14, 10), toon('#f5f5f5'));
      sock.position.y = -0.34;
      knee.add(sock);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.13, 0.34), shoeMat);
      shoe.position.set(0, -0.46, 0.06);
      knee.add(withOutline(shoe, 0.03));
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.04, 0.36), toon('#f5f5f5'));
      sole.position.set(0, -0.53, 0.06);
      knee.add(sole);
      this.legs.push({ hip, knee, side: s });
    }

    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.31, 0.16, 12), shortsMat);
    belt.scale.set(1.1, 1, 0.8);
    this.hips.add(withOutline(belt, 0.03));

    // Presentation shared by both rigs: contact shadow, control ring, turbo glow, nametag
    this.shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity: 0.55 }));
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    this.root.add(this.shadow);
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.62, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    this.root.add(this.ring);
    this.turboGlow = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.75, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(team.accent), transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    this.turboGlow.rotation.x = -Math.PI / 2;
    this.turboGlow.renderOrder = 2;
    this.root.add(this.turboGlow);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTexture(), transparent: true, depthWrite: false, depthTest: false }));
    this.tag.scale.set(1.7, 0.42, 1);
    this.tag.position.y = 2.4;
    this.tag.renderOrder = 20;
    this.root.add(this.tag);

    // Cached pose arrays for the procedural rig (no per-frame allocation)
    this.joints = [this.body, this.torso, this.hips, this.neck, this.arms[0].shoulder, this.arms[0].elbow, this.arms[1].shoulder, this.arms[1].elbow, this.legs[0].hip, this.legs[0].knee, this.legs[1].hip, this.legs[1].knee];
    this.poseFromX = new Float32Array(this.joints.length);
    this.poseFromY = new Float32Array(this.joints.length);
    this.poseFromZ = new Float32Array(this.joints.length);
  }

  // ---------------------------------------------------------------------------
  // GLTF model
  // ---------------------------------------------------------------------------
  prepareModel(template) {
    try {
      const model = cloneSkeleton(template.scene);
      const isGK = this.data.role === 'GK';
      // Normalize size + ground offset (Mixamo exports vary in scale)
      const box = new THREE.Box3().setFromObject(model);
      const height = Math.max(0.001, box.max.y - box.min.y);
      const s = 1.9 / height;
      model.scale.setScalar(s);
      model.position.y = -box.min.y * s;
      const tintBase = new THREE.Color(isGK ? this.team.accent : this.team.primary);
      const tint = tintBase.clone().lerp(new THREE.Color(0xffffff), isGK ? 0.35 : 0.55);
      model.traverse((o) => {
        if (o.isMesh || o.isSkinnedMesh) {
          o.castShadow = true;
          o.frustumCulled = false; // skinned meshes vanish at screen edges otherwise
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          o.material = mats.map((m) => {
            const c = m.clone();
            if (c.color) c.color.lerp(tint, 0.5);
            return c;
          });
        }
        if (o.isBone) {
          const n = o.name.toLowerCase();
          if (!this.handBone && (n.includes('righthand') || n.endsWith('hand_r'))) this.handBone = o;
          else if (!this.offHandBone && (n.includes('lefthand') || n.endsWith('hand_l'))) this.offHandBone = o;
        }
      });
      this.mixer = new THREE.AnimationMixer(model);
      this.clipFor = resolveClipMap(template.animations || []);
      this.actions = {};
      for (const key in this.clipFor) {
        if (this.clipFor[key]) this.actions[key] = this.mixer.clipAction(this.clipFor[key]);
      }
      this.gltfModel = model;
      this.root.add(model);
      this.body.visible = false; // procedural rig sleeps, stays as fallback
      this.modelActive = true;
    } catch (err) {
      console.warn('[character] model prepare failed — procedural fallback stays.', err);
      this.modelActive = false;
    }
  }

  playClip(key, timeScale = 1, fade = 0.2) {
    const next = this.actions && this.actions[key];
    if (!next) {
      // Missing clip: fall back to locomotion instead of freezing.
      const fb = this.actions[key === 'idle' ? 'swim' : 'idle'];
      if (!fb) return;
      if (this.currentClip === (key === 'idle' ? 'swim' : 'idle')) return;
      key = key === 'idle' ? 'swim' : 'idle';
      return this.playClip(key, timeScale, fade);
    }
    if (this.currentClip === key) {
      next.setEffectiveTimeScale(timeScale);
      return;
    }
    const prev = this.currentClip ? this.actions[this.currentClip] : null;
    next.reset().setEffectiveTimeScale(timeScale).setEffectiveWeight(1).fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    this.currentClip = key;
  }

  // ---------------------------------------------------------------------------
  // Per-frame update — both rigs + shared widgets
  // ---------------------------------------------------------------------------
  update(p, sim, dt, ballHeldByMe) {
    const visualDt = Number.isFinite(dt) ? Math.max(0, Math.min(MAX_VISUAL_DT, dt)) : 0;
    this.t += visualDt;
    this.root.position.set(p.pos.x, p.y, p.pos.z);
    this.root.rotation.y = p.facing;
    const speed = Math.max(0, Math.min(1, Number.isFinite(p.speedNorm) ? p.speedNorm : 0));
    const state = p.state || 'idle';

    if (this.modelActive && this.mixer) {
      this.mixer.update(visualDt);
      const key = clipKeyFor(state, speed);
      this.playClip(key, key === 'swim' ? 0.8 + speed * 0.8 : 1);
    } else {
      this.updateProcedural(p, sim, visualDt, ballHeldByMe, speed, state);
    }

    // Turn banking (procedural rig only — the GLB clip carries its own body language)
    if (!this.modelActive && (state === 'swim' || state === 'idle') && speed > 0.2) {
      let d = p.facing - (p.prevFacing ?? p.facing);
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.torso.rotation.z += -Math.sin(d) * 0.5;
    }
    p.prevFacing = p.facing;

    // Shared widgets
    const h = Number.isFinite(p.y) ? p.y : 0;
    const sc = Math.max(0.35, 1 - h * 0.18);
    this.shadow.scale.setScalar(this.modelActive ? sc * 1.25 : sc);
    this.shadow.position.y = 0.012 - h;
    this.shadow.material.opacity = 0.4 * sc;
    this.ring.position.y = 0.02 - h;
    this.turboGlow.position.y = 0.03 - h;
    this.ring.visible = !!p.controlled && sim.userTeam !== null && sim.userTeam === p.team;
    if (this.ring.visible) {
      this.ring.scale.setScalar(0.85 + Math.sin(this.t * 6) * 0.15);
      this.ring.material.opacity = 0.75;
    }
    const tg = this.turboGlow.material;
    tg.opacity += ((p.turboActive || state === 'gbdrive' ? 0.85 : 0) - tg.opacity) * smoothFactor(visualDt, 10);
    this.turboGlow.rotation.z += visualDt * 4;
    this.turboGlow.scale.setScalar(1 + Math.sin(this.t * 14) * 0.08);
  }

  // ---------------------------------------------------------------------------
  // Procedural fallback rig (compact port of the original character.js poses)
  // ---------------------------------------------------------------------------
  updateProcedural(p, sim, dt, ballHeldByMe, speed, state) {
    const arms = this.arms;
    const legs = this.legs;
    const joints = this.joints;
    const fromX = this.poseFromX;
    const fromY = this.poseFromY;
    const fromZ = this.poseFromZ;
    const prevBodyY = this.body.position.y;
    const prevBodyZ = this.body.position.z;
    const prevHipsY = this.hips.position.y;
    for (let i = 0; i < joints.length; i++) {
      fromX[i] = joints[i].rotation.x;
      fromY[i] = joints[i].rotation.y;
      fromZ[i] = joints[i].rotation.z;
      joints[i].rotation.set(0, 0, 0);
    }
    this.body.position.set(0, 0, 0);
    let hipY = 1.0;
    const time = Number.isFinite(p.anim?.t) ? p.anim.t : this.t;
    const stateTime = Math.max(0, Number.isFinite(p.stateTime) ? p.stateTime : 0);
    const stateDur = Math.max(0.01, Number.isFinite(p.stateDur) ? p.stateDur : 0.01);
    const u = (n) => Math.min(1, stateTime / n);
    const wave = (n) => Math.sin(u(n) * Math.PI);

    switch (state) {
      case 'idle': case 'swim': case 'catch': case 'gbdrive': {
        const pitch = Math.min(1.25, speed * 1.6 + (state === 'gbdrive' ? 1.2 : 0));
        if (speed > 0.06 || state === 'gbdrive') this.applySwimCycle(time, 0.5 + speed * 0.9, 6 + speed * 8, pitch);
        else hipY = this.applyTreadWater(time);
        if (ballHeldByMe || state === 'catch') this.applyTuckBall();
        if (state === 'catch') { arms[0].shoulder.rotation.x = -1.6; arms[0].elbow.rotation.x = -1.4; }
        break;
      }
      case 'gbwind': {
        const k = u(0.6);
        this.applyTreadWater(time);
        this.body.rotation.x = -0.25 * k;
        hipY = 1.0 + k * 0.2;
        arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -2.9 * k;
        arms[0].shoulder.rotation.z = -0.4; arms[1].shoulder.rotation.z = 0.4;
        arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.4;
        this.neck.rotation.x = -0.4 * k;
        break;
      }
      case 'trick': {
        this.applySwimCycle(time, 0.6, 12, 0.9);
        this.applyTuckBall();
        const id = p.trick?.def?.id ?? 0;
        const t01 = u(stateDur);
        if (id === 0) this.body.rotation.y = t01 * Math.PI * 2;
        else if (id === 1) this.body.rotation.z = t01 * Math.PI * 2;
        else if (id === 2) {
          this.body.rotation.x = 0.9 + Math.sin(t01 * Math.PI * 2) * 0.7;
          legs[0].hip.rotation.x = legs[1].hip.rotation.x = Math.sin(t01 * Math.PI * 4) * 0.9;
          legs[0].knee.rotation.x = legs[1].knee.rotation.x = Math.max(0, Math.cos(t01 * Math.PI * 4));
          arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -Math.PI;
          arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.1;
          this.applyTuckBall();
        } else if (id === 3) {
          this.body.rotation.z = t01 * Math.PI * 2;
          this.body.rotation.y = Math.sin(t01 * Math.PI) * 0.8;
        } else if (id === 4) this.body.rotation.x = 0.9 - t01 * Math.PI * 2;
        else {
          this.body.rotation.x = 1.3;
          legs[0].hip.rotation.x = legs[1].hip.rotation.x = Math.sin(time * 26) * 0.35;
          arms[0].shoulder.rotation.x = -Math.PI;
          arms[0].elbow.rotation.x = -0.05;
          this.body.rotation.z = Math.sin(t01 * Math.PI * 3) * 0.4;
        }
        break;
      }
      case 'shoot': {
        const wind = p.shot && Number.isFinite(p.shot.wind) ? Math.max(0.01, p.shot.wind) : 0.75;
        const rel = !!p.shot?.released;
        this.applyTreadWater(time);
        if (!rel) {
          const w = Math.min(1, stateTime / wind);
          this.torso.rotation.y = -0.6 * w;
          this.body.rotation.x = -0.15 * w;
          arms[1].shoulder.rotation.x = -2.4 - w * 0.6;
          arms[1].shoulder.rotation.z = 0.5;
          arms[1].elbow.rotation.x = -1.8;
          arms[0].shoulder.rotation.x = -1.5;
          arms[0].shoulder.rotation.z = -0.2;
          arms[0].elbow.rotation.x = -0.2;
          legs[1].hip.rotation.x = -0.5 * w;
          legs[0].hip.rotation.x = 0.4 * w;
          hipY = 1.0 + w * 0.12;
        } else {
          const r = u(0.3);
          this.torso.rotation.y = 0.5 * r;
          this.body.rotation.x = 0.55 * r;
          arms[1].shoulder.rotation.x = -2.9 + r * 2.4;
          arms[1].shoulder.rotation.z = 0.2;
          arms[1].elbow.rotation.x = -0.1;
          arms[0].shoulder.rotation.x = 0.3;
          arms[0].shoulder.rotation.z = -0.9;
          legs[0].hip.rotation.x = -0.6 * r;
          legs[1].hip.rotation.x = 0.7 * r;
          legs[1].knee.rotation.x = 0.8 * r;
          this.neck.rotation.x = 0.2 * r;
        }
        break;
      }
      case 'volley': {
        const k = wave(0.45);
        this.body.rotation.x = -0.4 + k * 0.9;
        legs[1].hip.rotation.x = -1.8 * k;
        legs[1].knee.rotation.x = 0.2;
        legs[0].hip.rotation.x = 0.9 * k;
        legs[0].knee.rotation.x = 1.2 * k;
        arms[0].shoulder.rotation.x = -2.4;
        arms[1].shoulder.rotation.x = 0.8;
        arms[0].shoulder.rotation.z = -0.5;
        arms[1].shoulder.rotation.z = 0.7;
        this.torso.rotation.y = -0.4 * k;
        break;
      }
      case 'breach': {
        const stretch = p.vy > 0 ? 1 : 0.6;
        this.body.rotation.x = -0.15;
        arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -Math.PI * stretch;
        arms[0].shoulder.rotation.z = -0.15; arms[1].shoulder.rotation.z = 0.15;
        arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.1;
        legs[0].hip.rotation.x = legs[1].hip.rotation.x = 0.1;
        legs[0].knee.rotation.x = legs[1].knee.rotation.x = p.vy > 0 ? 0.15 : 0.9;
        this.neck.rotation.x = -0.4;
        if (ballHeldByMe) this.applyTuckBall();
        break;
      }
      case 'pass': {
        const k = u(0.22);
        this.applyTreadWater(time);
        this.body.rotation.x = 0.3 + k * 0.2;
        arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -1.5 - k * 0.3;
        arms[0].shoulder.rotation.z = -0.2; arms[1].shoulder.rotation.z = 0.2;
        arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -1.3 + k * 1.3;
        break;
      }
      case 'tackle': {
        const l = wave(0.4);
        this.body.rotation.x = 0.6 + l * 0.9;
        this.body.position.y = -l * 0.35;
        this.body.position.z = l * 0.3;
        arms[1].shoulder.rotation.x = -Math.PI + 0.2;
        arms[1].elbow.rotation.x = -0.1;
        arms[0].shoulder.rotation.x = -2.3;
        arms[0].elbow.rotation.x = -0.6;
        legs[0].hip.rotation.x = -0.5 * l;
        legs[1].hip.rotation.x = 0.6 * l;
        legs[1].knee.rotation.x = 0.6 * l;
        this.neck.rotation.x = -0.5;
        break;
      }
      case 'hit': {
        const l = wave(0.42);
        this.body.rotation.x = 0.35 * l;
        this.torso.rotation.y = 0.7 * l;
        arms[1].shoulder.rotation.x = -1.2 * l;
        arms[1].shoulder.rotation.z = 0.9 * l;
        arms[1].elbow.rotation.x = -1.6;
        arms[0].shoulder.rotation.x = 0.6 * l;
        arms[0].shoulder.rotation.z = -0.5;
        legs[0].hip.rotation.x = 0.5 * l;
        legs[1].hip.rotation.x = -0.4 * l;
        legs[0].knee.rotation.x = 0.8 * l;
        break;
      }
      case 'save': {
        const dive = Math.sin(Math.min(1, u(0.55) * 1.4) * Math.PI * 0.5);
        const side = (p.knockDir?.z ?? 0) >= 0 ? 1 : -1;
        this.body.rotation.z = side * dive * 1.3;
        this.body.position.y = dive * 0.2;
        arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -Math.PI + 0.1;
        arms[0].shoulder.rotation.z = -0.1; arms[1].shoulder.rotation.z = 0.1;
        arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.05;
        legs[0].hip.rotation.x = -0.2;
        legs[1].hip.rotation.x = 0.4 * dive;
        legs[1].knee.rotation.x = 0.7 * dive;
        this.neck.rotation.x = -0.3;
        break;
      }
      case 'stumble': {
        this.applyTreadWater(time);
        const k = u(stateDur);
        this.body.rotation.x = 0.8 * Math.sin(k * Math.PI);
        this.body.rotation.z = 0.6 * Math.sin(k * Math.PI * 2);
        this.body.rotation.y = Math.sin(k * Math.PI) * 1.2;
        arms[0].shoulder.rotation.z = -1.6;
        arms[1].shoulder.rotation.z = 1.6;
        break;
      }
      case 'fallen': {
        const k = u(stateDur);
        const rec = k > 0.7 ? (k - 0.7) / 0.3 : 0;
        this.body.rotation.x = Math.min(1, k * 1.8) * Math.PI * 2 * (1 - rec);
        this.body.rotation.z = Math.sin(k * Math.PI) * 0.8 * (1 - rec);
        this.body.position.y = -Math.sin(k * Math.PI) * 0.5;
        arms[0].shoulder.rotation.z = -1.4 * (1 - rec);
        arms[1].shoulder.rotation.z = 1.4 * (1 - rec);
        arms[0].shoulder.rotation.x = arms[1].shoulder.rotation.x = -0.5;
        legs[0].hip.rotation.x = -0.3; legs[1].hip.rotation.x = 0.5;
        legs[1].knee.rotation.x = 0.9; legs[0].knee.rotation.x = 0.4;
        if (rec > 0) this.applyTreadWater(time);
        break;
      }
      case 'celebrate': {
        const bounce = Math.abs(Math.sin(p.stateTime * 7));
        this.applyTreadWater(time);
        hipY = 1.0 + bounce * 0.15;
        const s = Math.sin(p.stateTime * 9) * 0.3;
        arms[0].shoulder.rotation.x = -2.8 + s;
        arms[1].shoulder.rotation.x = -2.8 - s;
        arms[0].shoulder.rotation.z = -0.5; arms[1].shoulder.rotation.z = 0.5;
        arms[0].elbow.rotation.x = arms[1].elbow.rotation.x = -0.6;
        this.neck.rotation.x = -0.35;
        this.body.rotation.x = -0.1;
        break;
      }
      default:
        hipY = this.applyTreadWater(time);
        break;
    }

    this.hips.position.y = hipY;

    // Pose easing (identical contract to the original file)
    const firstPose = !this.poseReady;
    const poseBlend = firstPose ? 1 : smoothFactor(dt, 18);
    for (let i = 0; i < joints.length; i++) {
      joints[i].rotation.x = dampAngle(fromX[i], joints[i].rotation.x, poseBlend);
      joints[i].rotation.y = dampAngle(fromY[i], joints[i].rotation.y, poseBlend);
      joints[i].rotation.z = dampAngle(fromZ[i], joints[i].rotation.z, poseBlend);
    }
    const posBlend = firstPose ? 1 : smoothFactor(dt, 14);
    this.body.position.y = blendNumber(prevBodyY, this.body.position.y, posBlend);
    this.body.position.z = blendNumber(prevBodyZ, this.body.position.z, posBlend);
    this.hips.position.y = blendNumber(prevHipsY, hipY, posBlend);
    this.poseReady = true;
  }

  applySwimCycle(time, amp, freq, pitch) {
    const A = this.arms;
    const L = this.legs;
    const ph = time * freq;
    const s = Math.sin(ph);
    const c = Math.cos(ph);
    this.body.rotation.x = pitch;
    this.body.position.y = -pitch * 0.35;
    this.body.position.z = pitch * 0.25;
    L[0].hip.rotation.x = s * amp * 0.5;
    L[1].hip.rotation.x = -s * amp * 0.5;
    L[0].knee.rotation.x = Math.max(0, -c) * amp * 0.6 + 0.1;
    L[1].knee.rotation.x = Math.max(0, c) * amp * 0.6 + 0.1;
    const strokeL = ph * 0.5;
    const strokeR = strokeL + Math.PI;
    const cl = Math.cos(strokeL);
    const cr = Math.cos(strokeR);
    A[0].shoulder.rotation.x = -Math.PI + Math.sin(strokeL) * 1.4;
    A[1].shoulder.rotation.x = -Math.PI + Math.sin(strokeR) * 1.4;
    A[0].shoulder.rotation.z = -0.35 - Math.max(0, cl) * 0.5;
    A[1].shoulder.rotation.z = 0.35 + Math.max(0, cr) * 0.5;
    A[0].elbow.rotation.x = -0.3 - Math.max(0, cl) * 0.9;
    A[1].elbow.rotation.x = -0.3 - Math.max(0, cr) * 0.9;
    this.hips.rotation.y = s * 0.15 * amp;
    this.torso.rotation.z = Math.sin(strokeL) * 0.15;
    this.neck.rotation.x = -pitch * 0.8;
  }

  applyTreadWater(time) {
    const A = this.arms;
    const L = this.legs;
    this.body.rotation.x = 0.12;
    L[0].hip.rotation.x = 0.25 + Math.sin(time * 4) * 0.2;
    L[1].hip.rotation.x = 0.25 - Math.sin(time * 4) * 0.2;
    L[0].knee.rotation.x = L[1].knee.rotation.x = 0.55;
    L[0].hip.rotation.z = 0.12;
    L[1].hip.rotation.z = -0.12;
    A[0].shoulder.rotation.z = -1.1 + Math.sin(time * 2.6) * 0.15;
    A[1].shoulder.rotation.z = 1.1 - Math.sin(time * 2.6) * 0.15;
    A[0].shoulder.rotation.x = A[1].shoulder.rotation.x = -0.4;
    A[0].elbow.rotation.x = A[1].elbow.rotation.x = -0.9;
    return 1.0 + Math.sin(time * 2.2) * 0.03;
  }

  applyTuckBall() {
    const right = this.arms[1];
    right.shoulder.rotation.x = -0.9;
    right.shoulder.rotation.z = 0.25;
    right.elbow.rotation.x = -1.9;
  }

  // ---------------------------------------------------------------------------
  // Textures + ball attachment
  // ---------------------------------------------------------------------------
  numberTexture() {
    const c = makeCanvas(128, 128);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, 128, 128);
    ctx.font = '900 92px "Barlow Condensed", Impact, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 12;
    ctx.strokeStyle = this.team.secondary;
    ctx.strokeText(String(this.data.number ?? ''), 64, 70);
    ctx.fillStyle = this.team.accent;
    ctx.fillText(String(this.data.number ?? ''), 64, 70);
    return canvasTexture(c);
  }

  tagTexture() {
    const c = makeCanvas(256, 64);
    const ctx = c.getContext('2d');
    const label = String(this.data.nick || this.data.name || this.data.id || '').toUpperCase();
    ctx.font = '700 34px "Barlow Condensed", Impact, sans-serif';
    const w = Math.min(246, ctx.measureText(label).width + 44);
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(128 - w / 2, 8, w, 44, 8);
    else ctx.rect(128 - w / 2, 8, w, 44);
    ctx.fill();
    ctx.fillStyle = this.team.primary;
    ctx.fillRect(128 - w / 2 + 8, 16, 4, 28);
    ctx.fillStyle = '#f2f6fa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 132, 31);
    return canvasTexture(c);
  }

  /** World position of the right hand: hand bone when the model is live, mesh otherwise. */
  handWorld(target) {
    const node = this.modelActive && this.handBone ? this.handBone : this.arms[1].hand;
    node.getWorldPosition(target);
    return target;
  }

  leftHandWorld(target) {
    const node = this.modelActive && this.offHandBone ? this.offHandBone : this.arms[0].hand;
    node.getWorldPosition(target);
    return target;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function dampAngle(from, to, blend) {
  let delta = to - from;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return from + delta * blend;
}

function blendNumber(from, to, blend) {
  return from + (to - from) * blend;
}

function smoothFactor(dt, rate) {
  if (!Number.isFinite(dt) || !Number.isFinite(rate) || dt <= 0 || rate <= 0) return 0;
  return 1 - Math.exp(-Math.min(dt, MAX_VISUAL_DT) * rate);
}

function safeIndex(value, length) {
  if (!Number.isFinite(value) || length <= 0) return 0;
  const i = Math.trunc(value) % length;
  return i < 0 ? i + length : i;
}

let sharedBlobShadowTexture = null;
function blobShadowTexture() {
  if (sharedBlobShadowTexture) return sharedBlobShadowTexture;
  const c = makeCanvas(128, 128);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 10, 64, 64, 60);
  g.addColorStop(0, 'rgba(0,0,0,0.9)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  sharedBlobShadowTexture = canvasTexture(c);
  return sharedBlobShadowTexture;
}

import * as THREE from 'three';
import { clamp } from './noise.js';

/**
 * Orbit rig that doubles as the aiming device.
 *
 * `aimYaw` / `aimPitch` are the gun. Left-drag moves them (horizontal = turn,
 * vertical = elevation) and the camera follows so you're always looking down the
 * barrel. Right-drag adds a temporary look-around offset that doesn't disturb
 * the aim.
 */
export class CameraRig {
  constructor(camera, terrain) {
    this.camera = camera;
    this.terrain = terrain;

    this.aimYaw = 0;
    this.aimPitch = 0.45;
    this.yawOffset = 0;
    this.pitchOffset = 0;

    // Where the camera is actually looking, eased toward aimYaw/aimPitch each
    // frame (see update()) rather than snapping straight there. aimYaw/aimPitch
    // stay instantaneous — the shot direction always matches the mouse exactly
    // — but the camera easing into position (instead of cutting) is what makes
    // the big jump at the start of a new aim (see Game's aim-start reset) read
    // as the camera swinging into place instead of a jarring teleport.
    this.viewYaw = 0;
    this.viewPitch = 0.3;
    this.viewAimPitch = 0.45; // eased copy of aimPitch, for the look-at lift below

    // Remote aim target while watching another player's turn — see
    // Game.applyPose(). Null means "not being driven remotely right now."
    this.netAimYaw = null;
    this.netAimPitch = null;

    this.distance = 24;
    this.targetDistance = 24;
    this.target = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.shake = 0;
    this.followSpeed = 6;
  }

  reset(target) {
    this.target.copy(target);
    this.desired.copy(target);
    this.yawOffset = 0;
    this.pitchOffset = 0;
    this.aimPitch = 0.45;
    this.targetDistance = 24;
    this.snapView();
  }

  /** Point the camera at a fresh blob, keeping a sensible starting heading. */
  faceFrom(position, lookAt) {
    const dx = lookAt.x - position.x;
    const dz = lookAt.z - position.z;
    this.aimYaw = Math.atan2(dx, dz);
    this.aimPitch = 0.5;
    this.yawOffset = 0;
    this.pitchOffset = 0;
    this.snapView();
  }

  /** Elevation angle for the camera's own position — see update(). */
  targetCamPitch() {
    return clamp(0.3 + this.aimPitch * 0.12 + this.pitchOffset, -0.15, 1.0);
  }

  /** Jump the camera's view straight to the current aim, no easing. */
  snapView() {
    this.viewYaw = this.aimYaw + this.yawOffset;
    this.viewPitch = this.targetCamPitch();
    this.viewAimPitch = this.aimPitch;
  }

  /**
   * `lockYaw` is set while a firearm is equipped: those weapons get their
   * horizontal aim from the blob's own facing (turned with A/D) instead of the
   * mouse, so the drag is left with only elevation to give it.
   */
  handleDrag({ dx, dy, button }, { lockYaw = false } = {}) {
    if (!button) return;
    if (button === 1) {
      if (!lockYaw) this.aimYaw -= dx * 0.005;
      this.aimPitch = clamp(this.aimPitch - dy * 0.004, -0.35, 1.25);
    } else {
      this.yawOffset = clamp(this.yawOffset - dx * 0.005, -2.2, 2.2);
      this.pitchOffset = clamp(this.pitchOffset - dy * 0.004, -0.5, 1.0);
    }
  }

  zoom(steps) {
    this.targetDistance = clamp(this.targetDistance + steps * 2.4, 7, 70);
  }

  recenter() {
    this.yawOffset = 0;
    this.pitchOffset = 0;
  }

  addShake(amount) {
    this.shake = Math.min(2.2, this.shake + amount);
  }

  /** Unit vector the current shot would travel along. */
  aimDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.aimPitch);
    return out.set(Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), Math.cos(this.aimYaw) * cp);
  }

  setTarget(v, snap = false) {
    this.desired.copy(v);
    if (snap) this.target.copy(v);
  }

  update(dt) {
    this.target.lerp(this.desired, Math.min(1, dt * this.followSpeed));
    this.distance += (this.targetDistance - this.distance) * Math.min(1, dt * 6);

    // Ease the camera's view toward the current aim rather than snapping
    // straight to it — the shortest way around for yaw, same as the remote
    // pose stream does, so a big change (like the aim-start reset) reads as
    // the camera swinging into place instead of a jump cut.
    const k = Math.min(1, dt * 14);
    this.viewYaw += shortestAngle(this.viewYaw, this.aimYaw + this.yawOffset) * k;
    this.viewPitch += (this.targetCamPitch() - this.viewPitch) * k;
    this.viewAimPitch += (this.aimPitch - this.viewAimPitch) * k;

    // The camera's own climb responds only lightly to aim pitch — at the old
    // 0.34 coupling, aiming for a high, far shot lifted the camera high
    // enough above the blob that camera.lookAt (still pointed at the blob
    // below) had to tilt sharply down to keep it in frame, so the highest
    // shots left you staring at the ground instead of toward the sky the
    // shot was headed into. The rest of "aim higher, see higher" now comes
    // from the look-at target below, which climbs toward the aim direction
    // instead of staying pinned to the blob.
    const cp = Math.cos(this.viewPitch);
    const pos = _v.set(
      this.target.x - Math.sin(this.viewYaw) * cp * this.distance,
      this.target.y + Math.sin(this.viewPitch) * this.distance + 1.6,
      this.target.z - Math.cos(this.viewYaw) * cp * this.distance
    );

    // Don't let the camera burrow into the island.
    const floor = this.terrain.heightAt(pos.x, pos.z) + 2.2;
    if (pos.y < floor) pos.y = floor;
    if (pos.y < 1.5) pos.y = 1.5;

    if (this.shake > 0.001) {
      this.shake *= Math.pow(0.0009, dt);
      const s = this.shake;
      pos.x += (Math.random() - 0.5) * s;
      pos.y += (Math.random() - 0.5) * s;
      pos.z += (Math.random() - 0.5) * s;
    } else {
      this.shake = 0;
    }

    this.camera.position.copy(pos);
    // Look toward where the shot is actually heading rather than always at
    // the blob's fixed head height, so dragging for a higher/further shot
    // tilts the view up and out along the trajectory instead of down at it.
    const lift = Math.max(0, this.viewAimPitch) * 11;
    this.camera.lookAt(this.target.x, this.target.y + 1.2 + lift, this.target.z);
  }
}

const _v = new THREE.Vector3();

function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

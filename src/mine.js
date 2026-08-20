import * as THREE from 'three';
import { CFG } from './config.js';

/**
 * A planted mine. Unlike a projectile it survives turn changes, so it lives in
 * its own list and is updated outside the turn state machine — otherwise the
 * "wait for everything to stop moving" check would never pass.
 */
export class Mine {
  constructor(game, weapon, position, owner) {
    this.game = game;
    this.weapon = weapon;
    this.owner = owner;
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.age = 0;
    this.armed = false;
    this.dead = false;
    this.grounded = false;

    this.group = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0x2e3440, roughness: 0.6, metalness: 0.4 })
    );
    body.castShadow = true;
    this.group.add(body);

    this.lightMat = new THREE.MeshBasicMaterial({ color: 0x552222 });
    this.light = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), this.lightMat);
    this.light.position.y = 0.55;
    this.group.add(this.light);

    this.group.position.copy(this.position);
    game.scene.add(this.group);
  }

  update(dt) {
    if (this.dead) return;
    this.age += dt;

    if (!this.grounded) {
      this.velocity.y -= CFG.physics.gravity * dt;
      this.position.addScaledVector(this.velocity, dt);
      const gh = this.game.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y - 0.55 <= gh) {
        this.position.y = gh + 0.55;
        this.velocity.set(0, 0, 0);
        this.grounded = true;
      }
      if (this.position.y < CFG.terrain.waterLevel) return void this.remove();
      this.group.position.copy(this.position);
    } else {
      // The ground can be blown out from under a planted mine.
      const gh = this.game.terrain.heightAt(this.position.x, this.position.z);
      if (this.position.y - 0.55 > gh + 0.3) this.grounded = false;
      if (this.position.y < CFG.terrain.waterLevel) return void this.remove();
    }

    if (!this.armed && this.age >= this.weapon.armTime) {
      this.armed = true;
      this.game.audio.tick();
    }

    if (this.armed) {
      const blink = Math.sin(this.age * 9) > 0;
      this.lightMat.color.setHex(blink ? 0xff3b30 : 0x551111);
      for (const blob of this.game.blobs) {
        if (!blob.alive) continue;
        if (blob.position.distanceTo(this.position) < this.weapon.trigger) {
          this.detonate();
          return;
        }
      }
    }
  }

  detonate() {
    if (this.dead) return;
    const at = this.position.clone();
    this.remove();
    this.game.detonate(at, this.weapon.radius, this.weapon.damage, this.owner, 'a land mine');
  }

  remove() {
    if (this.dead) return;
    this.dead = true;
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

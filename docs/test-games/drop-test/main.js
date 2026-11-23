import * as THREE from 'three/webgpu';
import RAPIER from '@dimforge/rapier3d-compat';
await RAPIER.init();
const r = new THREE.WebGPURenderer({ antialias: true });
await r.init();
console.log('backend', r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2');
r.setPixelRatio(Math.min(devicePixelRatio, 2)); r.setSize(innerWidth, innerHeight);
r.shadowMap.enabled = true; document.body.append(r.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1d1c1a);
const cam = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100); cam.position.set(0, 9, 16); cam.lookAt(0, 1, 0);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x202030, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5); sun.position.set(5, 12, 6); sun.castShadow = true; scene.add(sun);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const floor = new THREE.Mesh(new THREE.BoxGeometry(14, 0.5, 8), new THREE.MeshStandardMaterial({ color: 0xe9c46a }));
floor.receiveShadow = true; scene.add(floor); world.createCollider(RAPIER.ColliderDesc.cuboid(7, 0.25, 4));
const bodies = [];
const colors = [0xe76f51, 0x2a9d8f, 0xf4a261, 0x264653, 0x8ab17d];
function drop(x) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: colors[bodies.length % 5], roughness: 0.4 }));
  m.castShadow = true; scene.add(m);
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 8, (Math.random() - 0.5) * 3).setAngvel({ x: Math.random(), y: Math.random(), z: 1 }));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setRestitution(0.3), b);
  bodies.push([m, b]);
}
for (let i = 0; i < 8; i++) drop((i - 4) * 1.2);
addEventListener('pointerdown', (e) => drop((e.clientX / innerWidth - 0.5) * 12));
let frames = 0, t0 = performance.now();
r.setAnimationLoop(() => {
  world.step();
  for (const [m, b] of bodies) { m.position.copy(b.translation()); m.quaternion.copy(b.rotation()); }
  r.render(scene, cam);
  if (++frames === 120) { console.log('fps', Math.round(120000 / (performance.now() - t0))); }
});

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { World } from '../world/world';
import { nearestCell, type CellHit } from '../world/sphereMesh';
import { ARROW_SCALE, plateVelocity } from '../world/plates';
import { cellColor, type Layer } from './colors';
import type { Vec3 } from '../core/math';

const TO_LINEAR = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});

/** Globe radius units per metre at relief 1 (8 km ≈ 3% of the radius, heavily exaggerated). */
const RELIEF_PER_METRE = 0.03 / 8000;

export class GlobeView {
  readonly canvas: HTMLCanvasElement;
  visible = true;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  private controls: OrbitControls;
  private globe: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  private arrows = new THREE.Group();
  private cursor: THREE.Mesh;
  private raycaster = new THREE.Raycaster();
  private lastCell = 0;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.canvas = this.renderer.domElement;
    container.appendChild(this.canvas);

    this.scene.background = new THREE.Color(0x0a0d13);
    this.camera.position.set(0, 0.9, 3.6);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 1.15;
    this.controls.maxDistance = 10;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    // Slow rotation down as the camera nears the surface.
    this.controls.addEventListener('change', () => {
      this.controls.rotateSpeed = Math.min(1, (this.camera.position.length() - 1) * 0.45);
    });

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(-2, 2, 3);
    this.camera.add(sun);
    this.scene.add(this.camera);

    this.globe = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.cursor = new THREE.Mesh(
      new THREE.RingGeometry(0.93, 1, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
    );
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.scene.add(this.globe, this.arrows, this.cursor);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      if (!this.visible) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setWorld(world: World): void {
    const n = world.mesh.n;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geometry.setIndex(new THREE.BufferAttribute(world.mesh.triangles, 1));
    this.globe.geometry.dispose();
    this.globe.geometry = geometry;
    this.lastCell = 0;
  }

  updateColors(world: World, layer: Layer): void {
    const attr = this.globe.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const rgb = [0, 0, 0];
    const darkenBorders = layer === 'plates' || layer === 'crust';
    const type = world.boundaries.type;
    for (let i = 0; i < world.mesh.n; i++) {
      cellColor(world, layer, i, rgb);
      const f = darkenBorders && type[i] ? 0.5 : 1;
      arr[i * 3] = TO_LINEAR[(rgb[0] * f) | 0];
      arr[i * 3 + 1] = TO_LINEAR[(rgb[1] * f) | 0];
      arr[i * 3 + 2] = TO_LINEAR[(rgb[2] * f) | 0];
    }
    attr.needsUpdate = true;
  }

  /** Displace vertices by elevation; oceans are compressed so the sea surface reads as flat. */
  updatePositions(world: World, relief: number): void {
    const geometry = this.globe.geometry;
    const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    const { xyz } = world.mesh;
    const k = relief * RELIEF_PER_METRE, sea = world.params.seaLevel;
    for (let i = 0; i < world.mesh.n; i++) {
      const h = world.elevation[i] - sea;
      const r = 1 + (h > 0 ? h : h * 0.15) * k;
      pos[i * 3] = xyz[i * 3] * r;
      pos[i * 3 + 1] = xyz[i * 3 + 1] * r;
      pos[i * 3 + 2] = xyz[i * 3 + 2] * r;
    }
    attr.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }

  updateArrows(world: World, show: boolean): void {
    for (const child of this.arrows.children) (child as THREE.ArrowHelper).dispose();
    this.arrows.clear();
    if (!show) return;
    world.plates.plates.forEach((plate, i) => {
      const c = world.centroid(i);
      if (Math.hypot(...c) < 0.5) return;
      const v = plateVelocity(plate, ...c);
      const speed = Math.hypot(...v);
      if (speed < 1e-3) return;
      const len = speed * ARROW_SCALE;
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(...v).normalize(),
        new THREE.Vector3(...c).multiplyScalar(1.045),
        len,
        0xffffff,
        Math.min(0.035, len * 0.5),
        Math.min(0.022, len * 0.35),
      );
      this.arrows.add(arrow);
    });
  }

  setNavigate(navigate: boolean): void {
    this.controls.mouseButtons.LEFT = navigate ? THREE.MOUSE.ROTATE : null;
  }

  /** Ray–unit-sphere intersection (ignores relief, which is tiny) → nearest cell. */
  pick(clientX: number, clientY: number, world: World): CellHit | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin: o, direction: d } = this.raycaster.ray;
    const b = o.dot(d), c = o.lengthSq() - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    if (t < 0) return null;
    const p = o.clone().addScaledVector(d, t).normalize();
    this.lastCell = nearestCell(world.mesh, p.x, p.y, p.z, this.lastCell);
    return { cell: this.lastCell, point: [p.x, p.y, p.z] };
  }

  setCursor(point: Vec3 | null, radius: number): void {
    this.cursor.visible = point !== null;
    if (!point) return;
    const p = new THREE.Vector3(...point);
    this.cursor.position.copy(p).multiplyScalar(Math.cos(radius) * 1.035);
    this.cursor.scale.setScalar(Math.sin(radius) * 1.035);
    this.cursor.lookAt(p.multiplyScalar(2));
  }
}

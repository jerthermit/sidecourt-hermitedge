import * as THREE from 'three';

const forest = '#245c46';
const ink = '#192f26';
const cream = '#edf3ed';
const motionDuration = 2800;
const inspectionDuration = 220;

/** A local still life: finite state gestures and bounded, fine-pointer inspection. */
export function mountEquipmentScene(container: HTMLElement): {
  setPlaying(playing: boolean): void;
  dispose(): void;
} {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.4, 1.4, .9, -.9, .1, 20);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  let renderer: THREE.WebGLRenderer | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let intersectionObserver: IntersectionObserver | undefined;
  let animation = 0;
  let startedAt = 0;
  let phase: 'idle' | 'gesture' | 'inspection' = 'idle';
  let inspectionX = 0;
  let inspectionY = 0;
  let inspectionFromX = 0;
  let inspectionFromY = 0;
  let inspectionTargetX = 0;
  let inspectionTargetY = 0;
  let playing = false;
  let disposed = false;
  let contextLost = false;
  let intersecting = true;
  let width = 0;
  let height = 0;
  const paddle = new THREE.Group();
  const ball = new THREE.Group();
  const ballShadow = new THREE.Group();

  function material<T extends THREE.Material>(value: T): T {
    materials.add(value);
    return value;
  }
  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], parent: THREE.Object3D) {
    geometries.add(geometry);
    for (const item of Array.isArray(material) ? material : [material]) materials.add(item);
    const result = new THREE.Mesh(geometry, material);
    parent.add(result);
    return result;
  }
  function restingPose() {
    paddle.rotation.set(-.15, -.48, -.31);
    ball.position.set(.82, -.32, .3);
    ball.rotation.set(.16, -.24, .1);
    ballShadow.scale.set(1, 1, 1);
  }
  function stop() {
    cancelAnimationFrame(animation);
    animation = 0;
    phase = 'idle';
    inspectionX = inspectionY = inspectionFromX = inspectionFromY = inspectionTargetX = inspectionTargetY = 0;
    restingPose();
  }
  function canDraw() {
    return !disposed && !contextLost && intersecting && !document.hidden && width > 0 && height > 0;
  }
  function draw() {
    if (!renderer || !canDraw()) return;
    try {
      renderer.render(scene, camera);
      if (contextLost || disposed) return;
      renderer.domElement.style.visibility = 'visible';
      container.dataset.rendered = 'true';
    } catch {
      dispose();
    }
  }
  function tick(now: number) {
    animation = 0;
    if (!canDraw() || reducedMotion.matches) { stop(); return; }
    if (phase === 'inspection') {
      if (!finePointer.matches) { stop(); draw(); return; }
      const progress = Math.min(1, Math.max(0, (now - startedAt) / inspectionDuration));
      const ease = 1 - (1 - progress) ** 3;
      inspectionX = inspectionFromX + (inspectionTargetX - inspectionFromX) * ease;
      inspectionY = inspectionFromY + (inspectionTargetY - inspectionFromY) * ease;
      restingPose();
      paddle.rotation.x -= inspectionY * .075;
      paddle.rotation.y += inspectionX * .18;
      paddle.rotation.z += inspectionX * .025;
      ball.rotation.y -= inspectionX * .1;
      draw();
      if (progress < 1 && canDraw()) animation = requestAnimationFrame(tick);
      else phase = 'idle';
      return;
    }
    if (phase !== 'gesture' || !playing) { stop(); return; }
    const progress = Math.min(1, Math.max(0, (now - startedAt) / motionDuration));
    const arc = Math.sin(Math.PI * progress);
    paddle.rotation.z = -.31 + Math.sin(progress * Math.PI * 2) * arc * .07;
    paddle.rotation.y = -.48 + arc * .1;
    ball.position.set(.82 - arc * .12, -.32 + arc * .46, .3 + arc * .12);
    ball.rotation.set(.16 + arc * .42, -.24 + arc * .7, .1 + arc * .24);
    ballShadow.scale.setScalar(1 - arc * .15);
    if (progress === 1) { restingPose(); phase = 'idle'; }
    draw();
    if (progress < 1 && canDraw()) animation = requestAnimationFrame(tick);
  }
  function inspect(x: number, y: number) {
    if (!canDraw() || reducedMotion.matches || !finePointer.matches || phase === 'gesture') return;
    const targetX = Math.max(-1, Math.min(1, x));
    const targetY = Math.max(-1, Math.min(1, y));
    if (targetX === inspectionTargetX && targetY === inspectionTargetY) return;
    inspectionFromX = inspectionX;
    inspectionFromY = inspectionY;
    inspectionTargetX = targetX;
    inspectionTargetY = targetY;
    startedAt = performance.now();
    phase = 'inspection';
    if (!animation) animation = requestAnimationFrame(tick);
  }
  function pointerMoved(event: PointerEvent) {
    if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    inspect((event.clientX - bounds.left) / bounds.width * 2 - 1,
      (event.clientY - bounds.top) / bounds.height * 2 - 1);
  }
  function pointerLeft() { inspect(0, 0); }
  function resize() {
    if (!renderer || disposed) return;
    try {
      const bounds = container.getBoundingClientRect();
      width = Math.round(bounds.width);
      height = Math.round(bounds.height);
      if (width <= 0 || height <= 0) { stop(); return; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height, false);
      const aspect = width / height;
      const viewHeight = Math.max(1.8, 2.8 / aspect);
      camera.left = -viewHeight * aspect / 2;
      camera.right = viewHeight * aspect / 2;
      camera.top = viewHeight / 2;
      camera.bottom = -viewHeight / 2;
      camera.updateProjectionMatrix();
      draw();
    } catch { dispose(); }
  }
  function visibilityChanged() { stop(); draw(); }
  function lost(event: Event) {
    event.preventDefault();
    contextLost = true;
    stop();
    if (renderer) renderer.domElement.style.visibility = 'hidden';
    delete container.dataset.rendered;
    dispose();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    delete container.dataset.rendered;
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', visibilityChanged);
    reducedMotion.removeEventListener('change', visibilityChanged);
    finePointer.removeEventListener('change', visibilityChanged);
    container.removeEventListener('pointermove', pointerMoved);
    container.removeEventListener('pointerleave', pointerLeft);
    container.removeEventListener('pointercancel', pointerLeft);
    renderer?.domElement.removeEventListener('webglcontextlost', lost);
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    scene.clear();
    if (renderer) {
      renderer.domElement.remove();
      try { renderer.dispose(); renderer.forceContextLoss(); } catch { /* Keep the fallback usable. */ }
    }
  }

  try {
    // The constructor throws without a usable WebGL context; the host keeps its SVG fallback.
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(ink, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const canvas = renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
    canvas.addEventListener('webglcontextlost', lost);
    container.appendChild(canvas);
    camera.position.set(0, .06, 6);
    camera.lookAt(0, .06, 0);
    scene.add(new THREE.AmbientLight(cream, 1.05));
    const light = new THREE.DirectionalLight(cream, 3.1);
    light.position.set(-3, 5, 7);
    scene.add(light);
    const fill = new THREE.DirectionalLight(cream, .85);
    fill.position.set(3, .5, 4);
    const rim = new THREE.DirectionalLight(cream, 1.2);
    rim.position.set(2, 3, -4);
    scene.add(fill, rim);
    // A deterministic micro-weave supplies surface relief, never remote imagery.
    const weaveSize = 64;
    const weavePixels = new Uint8Array(weaveSize * weaveSize * 4);
    for (let y = 0; y < weaveSize; y += 1) for (let x = 0; x < weaveSize; x += 1) {
      const over = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
      const strand = over ? y % 4 : x % 4;
      const height = [220, 238, 238, 220][strand];
      const index = (y * weaveSize + x) * 4;
      weavePixels.set([height, height, height, 255], index);
    }
    const weave = new THREE.DataTexture(weavePixels, weaveSize, weaveSize, THREE.RGBAFormat);
    weave.wrapS = weave.wrapT = THREE.RepeatWrapping;
    weave.repeat.set(4, 4);
    weave.magFilter = THREE.LinearFilter;
    weave.minFilter = THREE.LinearMipmapLinearFilter;
    weave.generateMipmaps = true;
    weave.needsUpdate = true;
    textures.add(weave);
    const face = material(new THREE.MeshPhysicalMaterial({ color: forest, roughness: .76,
      metalness: .025, clearcoat: .12, clearcoatRoughness: .55, bumpMap: weave, bumpScale: .009,
      roughnessMap: weave }));
    const edge = material(new THREE.MeshStandardMaterial({ color: cream, roughness: .55, metalness: .035 }));
    const dark = material(new THREE.MeshStandardMaterial({ color: ink, roughness: .88 }));
    const ballSurface = material(new THREE.MeshPhysicalMaterial({ color: cream, roughness: .5,
      clearcoat: .08, clearcoatRoughness: .6 }));
    scene.add(paddle, ball, ballShadow);
    paddle.position.set(-.16, -.02, 0);
    paddle.scale.setScalar(.79);

    const outline = new THREE.Shape();
    outline.moveTo(-.43, -.05);
    outline.quadraticCurveTo(-.55, .02, -.55, .18);
    outline.lineTo(-.55, .66);
    outline.bezierCurveTo(-.55, .96, -.33, 1.05, 0, 1.05);
    outline.bezierCurveTo(.33, 1.05, .55, .96, .55, .66);
    outline.lineTo(.55, .18);
    outline.quadraticCurveTo(.55, .02, .43, -.05);
    outline.lineTo(.14, -.26);
    outline.quadraticCurveTo(0, -.31, -.14, -.26);
    outline.closePath();
    mesh(new THREE.ExtrudeGeometry(outline, { depth: .115, steps: 1,
      bevelEnabled: true, bevelThickness: .018, bevelSize: .018, bevelSegments: 3, curveSegments: 20 }), [edge, dark], paddle);
    const front = mesh(new THREE.ShapeGeometry(outline, 20), face, paddle);
    front.scale.set(.918, .925, 1);
    front.position.set(0, .027, .136);
    const back = mesh(new THREE.ShapeGeometry(outline, 20), face, paddle);
    back.scale.copy(front.scale);
    back.rotation.y = Math.PI;
    back.position.set(0, .027, -.021);

    const grip = mesh(new THREE.CylinderGeometry(.095, .09, .57, 16), dark, paddle);
    grip.position.set(0, -.56, .055);
    const wrap = Array.from({ length: 129 }, (_, index) => {
      const angle = index / 128 * Math.PI * 14;
      return new THREE.Vector3(Math.cos(angle) * .096, -.3 - index / 128 * .52, .055 + Math.sin(angle) * .096);
    });
    mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wrap), 128, .009, 5, false), edge, paddle);
    for (const y of [-.28, -.86]) {
      const cap = mesh(new THREE.CylinderGeometry(.104, .104, .038, 20), edge, paddle);
      cap.position.set(0, y, .055);
    }

    mesh(new THREE.SphereGeometry(.215, 40, 28), ballSurface, ball);
    const holeMaterial = material(new THREE.MeshBasicMaterial({ color: ink }));
    const holeGeometry = new THREE.CircleGeometry(.028, 18);
    // Thirty-two shallow, tangent apertures stay legible at the header's small size.
    for (let index = 0; index < 32; index += 1) {
      const y = 1 - (index + .5) * 2 / 32;
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const radius = Math.sqrt(1 - y * y);
      const normal = new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      const hole = mesh(holeGeometry, holeMaterial, ball);
      hole.position.copy(normal).multiplyScalar(.2156);
      hole.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    }
    const shadowMaterial = material(new THREE.MeshBasicMaterial({ color: ink, transparent: true, opacity: .08, depthWrite: false }));
    const shadow = mesh(new THREE.CircleGeometry(.65, 48), shadowMaterial, scene);
    shadow.position.set(-.1, -.74, -.3);
    shadow.scale.set(1.15, .085, 1);
    ballShadow.position.set(.82, -.69, -.25);
    const smallShadow = mesh(new THREE.CircleGeometry(.22, 32), shadowMaterial, ballShadow);
    smallShadow.scale.set(1.1, .2, 1);
    restingPose();

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    intersectionObserver = new IntersectionObserver(([entry]) => {
      intersecting = entry?.isIntersecting ?? false;
      if (!intersecting) stop();
      draw();
    });
    intersectionObserver.observe(container);
    document.addEventListener('visibilitychange', visibilityChanged);
    reducedMotion.addEventListener('change', visibilityChanged);
    finePointer.addEventListener('change', visibilityChanged);
    container.addEventListener('pointermove', pointerMoved);
    container.addEventListener('pointerleave', pointerLeft);
    container.addEventListener('pointercancel', pointerLeft);
    resize();
    if (disposed) throw new Error('The equipment scene could not render.');
  } catch (error) {
    dispose();
    throw error;
  }

  return {
    setPlaying(nextPlaying) {
      if (disposed || playing === nextPlaying) return;
      playing = nextPlaying;
      stop();
      if (playing && canDraw() && !reducedMotion.matches) {
        startedAt = performance.now();
        phase = 'gesture';
        animation = requestAnimationFrame(tick);
      } else draw();
    },
    dispose,
  };
}

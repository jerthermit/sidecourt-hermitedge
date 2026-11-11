import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountEquipmentScene } from './equipmentScene';

interface RendererStub {
  domElement: HTMLCanvasElement;
  render: ReturnType<typeof vi.fn<(scene: THREE.Scene, camera: THREE.OrthographicCamera) => void>>;
  setPixelRatio: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  forceContextLoss: ReturnType<typeof vi.fn>;
}
const rendererState = vi.hoisted(() => ({ unavailable: false, renderFails: false, instances: [] as RendererStub[] }));
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: vi.fn(function () {
    if (rendererState.unavailable) throw new Error('WebGL unavailable');
    const canvas = Object.assign(new EventTarget(), { style: { cssText: '', visibility: '' },
      setAttribute: vi.fn(), remove: vi.fn() });
    vi.spyOn(canvas, 'addEventListener');
    vi.spyOn(canvas, 'removeEventListener');
    const renderer = { domElement: canvas as unknown as HTMLCanvasElement, setClearColor: vi.fn(),
      setPixelRatio: vi.fn(), setSize: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn(),
      render: vi.fn(() => { if (rendererState.renderFails) throw new Error('Render failed'); }) };
    rendererState.instances.push(renderer);
    return renderer;
  }),
}));

const observer = () => ({ observe: vi.fn(), disconnect: vi.fn() });
const eventSurface = () => {
  const surface = new EventTarget();
  vi.spyOn(surface, 'addEventListener');
  vi.spyOn(surface, 'removeEventListener');
  return surface;
};
let container: HTMLElement;
let bounds: { width: number; height: number; left?: number; top?: number };
let documentSurface: EventTarget & { hidden: boolean };
let media: EventTarget & { matches: boolean };
let pointerMedia: EventTarget & { matches: boolean };
let resizeObserver: ReturnType<typeof observer>;
let intersectionObserver: ReturnType<typeof observer>;
let onResize: () => void;
let onIntersect: (entries: Array<{ isIntersecting: boolean }>) => void;
let frames: Map<number, FrameRequestCallback>;
let now: number;
let mounted: ReturnType<typeof mountEquipmentScene> | undefined;
const renderer = () => rendererState.instances[0];
const renderedScene = () => renderer().render.mock.calls[0][0];
const step = (elapsed: number) => {
  now = 100 + elapsed;
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(now));
};
const assets = (scene: THREE.Scene) => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  for (const material of materials) for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value);
  }
  return { geometries, materials, textures };
};
const movePointer = (clientX: number, clientY: number, pointerType = 'mouse') => {
  container.dispatchEvent(Object.assign(new Event('pointermove'), { clientX, clientY, pointerType }));
};
const scenePaddle = () => renderedScene().children.find((object) => object.children.some(
  (child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.ExtrudeGeometry))!;

beforeEach(() => {
  rendererState.instances.length = 0;
  rendererState.unavailable = false;
  rendererState.renderFails = false;
  mounted = undefined;
  now = 100;
  let frameId = 0;
  frames = new Map();
  bounds = { width: 280, height: 180 };
  container = Object.assign(eventSurface(), { dataset: {}, appendChild: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, ...bounds }) }) as unknown as HTMLElement;
  documentSurface = Object.assign(eventSurface(), { hidden: false });
  media = Object.assign(eventSurface(), { matches: false });
  pointerMedia = Object.assign(eventSurface(), { matches: true });
  resizeObserver = observer();
  intersectionObserver = observer();
  vi.stubGlobal('document', documentSurface);
  vi.stubGlobal('window', { devicePixelRatio: 3,
    matchMedia: vi.fn((query: string) => query.includes('prefers-reduced-motion') ? media : pointerMedia) });
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id); }));
  vi.stubGlobal('ResizeObserver', vi.fn(function (callback: () => void) { onResize = callback; return resizeObserver; }));
  vi.stubGlobal('IntersectionObserver', vi.fn(function (callback: typeof onIntersect) { onIntersect = callback; return intersectionObserver; }));
  vi.spyOn(performance, 'now').mockImplementation(() => now);
});
afterEach(() => { mounted?.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('procedural equipment scene lifecycle', () => {
  it('survives 100 rapid playing-state toggles without accumulating frame loops', () => {
    mounted = mountEquipmentScene(container);
    for (let index = 0; index < 100; index += 1) {
      mounted.setPlaying(true);
      expect(frames.size).toBe(1);
      step(index * 20 + 10);
      expect(frames.size).toBeLessThanOrEqual(1);
      mounted.setPlaying(false);
      expect(frames.size).toBe(0);
    }
    mounted.setPlaying(true);
    step(10000);
    expect(frames.size).toBe(0);
    expect(container.dataset.rendered).toBe('true');
    mounted.dispose();
    expect(renderer().dispose).toHaveBeenCalledOnce();
  });

  it('settles a zero-sized scene on the next frame and restores its still pose after resize', () => {
    mounted = mountEquipmentScene(container);
    mounted.setPlaying(true);
    bounds = { width: 0, height: 0 };
    onResize();
    step(700);
    expect(frames.size).toBe(0);
    const renders = renderer().render.mock.calls.length;
    bounds = { width: 150, height: 94 };
    onResize();
    expect(renderer().setSize).toHaveBeenLastCalledWith(150, 94, false);
    expect(renderer().render).toHaveBeenCalledTimes(renders + 1);
    expect(frames.size).toBe(0);
    expect(container.dataset.rendered).toBe('true');
  });

  it('renders a static transparent scene with real geometry, 32 apertures, palette and capped DPR', () => {
    mounted = mountEquipmentScene(container);
    expect(THREE.WebGLRenderer).toHaveBeenLastCalledWith({ alpha: true, antialias: true, powerPreference: 'low-power' });
    expect(renderer().setPixelRatio).toHaveBeenCalledWith(1.5);
    expect(renderer().setSize).toHaveBeenCalledWith(280, 180, false);
    expect(renderer().render).toHaveBeenCalledOnce();
    expect(container.dataset.rendered).toBe('true');
    expect(frames.size).toBe(0);
    const scene = renderedScene();
    const camera = renderer().render.mock.calls[0][1];
    expect(camera).toBeInstanceOf(THREE.OrthographicCamera);
    expect(camera.right - camera.left).toBeCloseTo(2.8);
    expect(camera.top - camera.bottom).toBeCloseTo(1.8);
    const { geometries, materials } = assets(scene);
    expect([...geometries].map((geometry) => geometry.type)).toEqual(expect.arrayContaining(['ExtrudeGeometry', 'TubeGeometry', 'SphereGeometry']));
    const ball = scene.children.find((object) => object.children.some((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry))!;
    expect(ball.children.filter((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.CircleGeometry)).toHaveLength(32);
    expect(new Set([...materials].map((material) => (material as THREE.MeshStandardMaterial).color.getHexString())))
      .toEqual(new Set(['245c46', '192f26', 'edf3ed']));
    expect(resizeObserver.observe).toHaveBeenCalledWith(container);
    expect(intersectionObserver.observe).toHaveBeenCalledWith(container);
    bounds = { width: 100, height: 100 };
    onResize();
    expect(renderer().setSize).toHaveBeenLastCalledWith(100, 100, false);
    expect(camera.top - camera.bottom).toBeCloseTo(2.8);
    expect(frames.size).toBe(0);
  });

  it('runs one finite gesture per state change and settles without an idle frame loop', () => {
    mounted = mountEquipmentScene(container);
    const scene = renderedScene();
    const ball = scene.children.find((object) => object.children.some((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.SphereGeometry))!;
    const resting = ball.position.clone();
    mounted.setPlaying(true);
    expect(frames.size).toBe(1);
    mounted.setPlaying(true);
    expect(frames.size).toBe(1);
    step(1400);
    expect(ball.position.y).toBeGreaterThan(resting.y);
    expect(frames.size).toBe(1);
    step(3200);
    expect(ball.position.equals(resting)).toBe(true);
    expect(frames.size).toBe(0);
    const renders = renderer().render.mock.calls.length;
    mounted.setPlaying(true);
    step(6400);
    expect(renderer().render).toHaveBeenCalledTimes(renders);
    mounted.setPlaying(false);
    mounted.setPlaying(true);
    expect(frames.size).toBe(1);
  });

  it('uses one local, mipmapped surface weave and controlled lighting without loading images', () => {
    mounted = mountEquipmentScene(container);
    const { materials, textures } = assets(renderedScene());
    expect(textures.size).toBe(1);
    const weave = [...textures][0] as THREE.DataTexture;
    expect(weave).toBeInstanceOf(THREE.DataTexture);
    expect(weave.image.width).toBe(64);
    expect(weave.image.height).toBe(64);
    expect(weave.image.data).toHaveLength(64 * 64 * 4);
    expect(weave.repeat.toArray()).toEqual([4, 4]);
    expect(weave.wrapS).toBe(THREE.RepeatWrapping);
    expect(weave.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(weave.generateMipmaps).toBe(true);
    const face = [...materials].find((material) => material instanceof THREE.MeshPhysicalMaterial
      && material.bumpMap === weave) as THREE.MeshPhysicalMaterial;
    expect(face.roughnessMap).toBe(weave);
    expect(face.bumpScale).toBeLessThan(.01);
    expect(renderedScene().children.filter((child) => child instanceof THREE.DirectionalLight)).toHaveLength(3);
    expect(frames.size).toBe(0);
  });

  it('caps inspection to a small local rotation, coalesces moves and stops once settled', () => {
    bounds = { width: 280, height: 180, left: 40, top: 20 };
    mounted = mountEquipmentScene(container);
    const paddle = scenePaddle();
    const resting = paddle.rotation.clone();
    movePointer(100000, -100000);
    movePointer(100000, -100000);
    expect(frames.size).toBe(1);
    step(110);
    expect(paddle.rotation.y).toBeGreaterThan(resting.y);
    expect(paddle.rotation.y).toBeLessThan(resting.y + .18);
    step(220);
    expect(paddle.rotation.y).toBeCloseTo(resting.y + .18);
    expect(paddle.rotation.x).toBeCloseTo(resting.x + .075);
    expect(paddle.rotation.z).toBeCloseTo(resting.z + .025);
    expect(frames.size).toBe(0);
    const renders = renderer().render.mock.calls.length;
    movePointer(100000, -100000);
    step(440);
    expect(renderer().render).toHaveBeenCalledTimes(renders);
    container.dispatchEvent(new Event('pointerleave'));
    expect(frames.size).toBe(1);
    step(660);
    expect(paddle.rotation.equals(resting)).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('maps pointer coordinates relative to the equipment and returns on cancellation', () => {
    bounds = { width: 280, height: 180, left: 40, top: 20 };
    mounted = mountEquipmentScene(container);
    const paddle = scenePaddle();
    const resting = paddle.rotation.clone();
    movePointer(40, 110);
    step(220);
    expect(paddle.rotation.y).toBeCloseTo(resting.y - .18);
    expect(paddle.rotation.x).toBeCloseTo(resting.x);
    container.dispatchEvent(new Event('pointercancel'));
    step(440);
    expect(paddle.rotation.equals(resting)).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('lets the finite playing gesture take priority and permits inspection only after it settles', () => {
    mounted = mountEquipmentScene(container);
    const paddle = scenePaddle();
    const resting = paddle.rotation.clone();
    movePointer(280, 0);
    step(110);
    mounted.setPlaying(true);
    expect(paddle.rotation.equals(resting)).toBe(true);
    movePointer(0, 180);
    step(1400);
    expect(paddle.rotation.y).toBeCloseTo(resting.y + .1 * Math.sin(Math.PI * 1290 / 2800));
    expect(frames.size).toBe(1);
    step(3200);
    expect(paddle.rotation.equals(resting)).toBe(true);
    expect(frames.size).toBe(0);
    movePointer(280, 0);
    step(3420);
    expect(paddle.rotation.y).toBeCloseTo(resting.y + .18);
    expect(frames.size).toBe(0);
    mounted.setPlaying(true);
    expect(frames.size).toBe(0);
  });

  it('disables inspection for reduced motion, coarse pointers and touch events with live updates', () => {
    media.matches = true;
    mounted = mountEquipmentScene(container);
    const paddle = scenePaddle();
    const resting = paddle.rotation.clone();
    movePointer(280, 0);
    expect(frames.size).toBe(0);
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    pointerMedia.matches = false;
    pointerMedia.dispatchEvent(new Event('change'));
    movePointer(280, 0);
    expect(frames.size).toBe(0);
    pointerMedia.matches = true;
    pointerMedia.dispatchEvent(new Event('change'));
    movePointer(280, 0, 'touch');
    expect(frames.size).toBe(0);
    movePointer(280, 0);
    expect(frames.size).toBe(1);
    step(110);
    expect(paddle.rotation.equals(resting)).toBe(false);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    expect(paddle.rotation.equals(resting)).toBe(true);
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    movePointer(280, 0);
    step(330);
    pointerMedia.matches = false;
    pointerMedia.dispatchEvent(new Event('change'));
    expect(paddle.rotation.equals(resting)).toBe(true);
    expect(frames.size).toBe(0);
  });

  it.each(['hidden', 'offscreen', 'zero-sized'])('cancels inspection when %s without replaying it on return', (gate) => {
    mounted = mountEquipmentScene(container);
    const paddle = scenePaddle();
    const resting = paddle.rotation.clone();
    movePointer(280, 0);
    step(110);
    if (gate === 'hidden') { documentSurface.hidden = true; documentSurface.dispatchEvent(new Event('visibilitychange')); }
    else if (gate === 'offscreen') onIntersect([{ isIntersecting: false }]);
    else { bounds = { width: 0, height: 0 }; onResize(); }
    expect(frames.size).toBe(0);
    expect(paddle.rotation.equals(resting)).toBe(true);
    if (gate === 'hidden') { documentSurface.hidden = false; documentSurface.dispatchEvent(new Event('visibilitychange')); }
    else if (gate === 'offscreen') onIntersect([{ isIntersecting: true }]);
    else { bounds = { width: 280, height: 180 }; onResize(); }
    expect(frames.size).toBe(0);
  });

  it('stays static for reduced motion and stops an active gesture when that preference changes', () => {
    media.matches = true;
    mounted = mountEquipmentScene(container);
    mounted.setPlaying(true);
    expect(frames.size).toBe(0);
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    mounted.setPlaying(false);
    mounted.setPlaying(true);
    expect(frames.size).toBe(1);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    expect(container.dataset.rendered).toBe('true');
  });

  it.each(['hidden', 'offscreen'])('pauses when %s and returns to a static pose without restarting', (gate) => {
    mounted = mountEquipmentScene(container);
    mounted.setPlaying(true);
    step(700);
    if (gate === 'hidden') { documentSurface.hidden = true; documentSurface.dispatchEvent(new Event('visibilitychange')); }
    else onIntersect([{ isIntersecting: false }]);
    expect(frames.size).toBe(0);
    const renders = renderer().render.mock.calls.length;
    mounted.setPlaying(false);
    mounted.setPlaying(true);
    expect(frames.size).toBe(0);
    expect(renderer().render).toHaveBeenCalledTimes(renders);
    if (gate === 'hidden') { documentSurface.hidden = false; documentSurface.dispatchEvent(new Event('visibilitychange')); }
    else onIntersect([{ isIntersecting: true }]);
    expect(renderer().render).toHaveBeenCalledTimes(renders + 1);
    expect(frames.size).toBe(0);
  });

  it('disposes each real geometry/material, frame, observer, renderer and listener exactly once', () => {
    mounted = mountEquipmentScene(container);
    const resources = assets(renderedScene());
    const disposals = [...resources.geometries, ...resources.materials, ...resources.textures].map((resource) => {
      const listener = vi.fn(); resource.addEventListener('dispose', listener); return listener;
    });
    mounted.setPlaying(true);
    const canvas = renderer().domElement;
    mounted.dispose();
    mounted.dispose();
    expect(frames.size).toBe(0);
    disposals.forEach((listener) => expect(listener).toHaveBeenCalledOnce());
    expect(renderer().dispose).toHaveBeenCalledOnce();
    expect(renderer().forceContextLoss).toHaveBeenCalledOnce();
    expect(canvas.remove).toHaveBeenCalledOnce();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(intersectionObserver.disconnect).toHaveBeenCalledOnce();
    for (const surface of [documentSurface, media, pointerMedia, container, canvas]) {
      for (const [name, listener] of vi.mocked(surface.addEventListener).mock.calls) {
        expect(surface.removeEventListener).toHaveBeenCalledWith(name, listener);
      }
    }
    expect(container.dataset.rendered).toBeUndefined();
    mounted.setPlaying(false);
    mounted.setPlaying(true);
    movePointer(280, 0);
    expect(frames.size).toBe(0);
  });

  it('restores the SVG fallback and releases the scene after WebGL context loss', () => {
    mounted = mountEquipmentScene(container);
    mounted.setPlaying(true);
    const event = new Event('webglcontextlost', { cancelable: true });
    renderer().domElement.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(renderer().domElement.style.visibility).toBe('hidden');
    expect(container.dataset.rendered).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(renderer().dispose).toHaveBeenCalledOnce();
    expect(renderer().domElement.remove).toHaveBeenCalledOnce();
  });

  it('throws cleanly without appending a canvas when WebGL is unavailable', () => {
    rendererState.unavailable = true;
    expect(() => mountEquipmentScene(container)).toThrow('WebGL unavailable');
    expect(container.appendChild).not.toHaveBeenCalled();
    expect(container.dataset.rendered).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(resizeObserver.observe).not.toHaveBeenCalled();
    expect(documentSurface.addEventListener).not.toHaveBeenCalled();
  });

  it('cleans up a renderer failure before exposing the canvas as rendered', () => {
    rendererState.renderFails = true;
    const geometryDisposal = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDisposal = vi.spyOn(THREE.Material.prototype, 'dispose');
    expect(() => mountEquipmentScene(container)).toThrow('could not render');
    expect(container.dataset.rendered).toBeUndefined();
    expect(geometryDisposal).toHaveBeenCalled();
    expect(materialDisposal).toHaveBeenCalled();
    expect(renderer().dispose).toHaveBeenCalledOnce();
    expect(renderer().domElement.remove).toHaveBeenCalledOnce();
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce();
    expect(intersectionObserver.disconnect).toHaveBeenCalledOnce();
  });
});

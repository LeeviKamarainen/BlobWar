/**
 * Keyboard + mouse state. Frame code polls `keys`; edge events go through
 * `onPress` handlers.
 */
export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.pressHandlers = new Map();
    this.releaseHandlers = new Map();
    this.dragging = 0; // 0 = none, 1 = left (aim), 2 = right (free look)
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    this.enabled = true;

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = normalize(e);
      if (HANDLED.has(k)) e.preventDefault();
      if (!this.enabled) return;
      this.keys.add(k);
      const h = this.pressHandlers.get(k);
      if (h) h(e);
    });

    window.addEventListener('keyup', (e) => {
      const k = normalize(e);
      this.keys.delete(k);
      if (!this.enabled) return;
      const h = this.releaseHandlers.get(k);
      if (h) h(e);
    });

    window.addEventListener('blur', () => {
      this.keys.clear();
      this.dragging = 0;
    });

    domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    domElement.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      this.dragging = e.button === 2 ? 2 : 1;
      domElement.setPointerCapture(e.pointerId);
    });

    domElement.addEventListener('pointerup', (e) => {
      this.dragging = 0;
      if (domElement.hasPointerCapture(e.pointerId)) domElement.releasePointerCapture(e.pointerId);
    });

    domElement.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      this.dx += e.movementX || 0;
      this.dy += e.movementY || 0;
      // Remembered so a drag that ends mid-frame still applies its last motion.
      this.lastButton = this.dragging;
    });

    domElement.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: false }
    );
  }

  onPress(key, fn) {
    this.pressHandlers.set(key, fn);
  }

  onRelease(key, fn) {
    this.releaseHandlers.set(key, fn);
  }

  down(...keys) {
    return keys.some((k) => this.keys.has(k));
  }

  /** Read and reset accumulated pointer movement. */
  takeDrag() {
    const out = { dx: this.dx, dy: this.dy, button: this.dragging || this.lastButton || 0 };
    this.dx = 0;
    this.dy = 0;
    this.lastButton = 0;
    return out;
  }

  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
}

function normalize(e) {
  if (e.code === 'Space') return 'space';
  if (e.code.startsWith('Arrow')) return e.code.slice(5).toLowerCase();
  if (e.code.startsWith('Digit')) return e.code.slice(5);
  if (e.code.startsWith('Key')) return e.code.slice(3).toLowerCase();
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') return 'shift';
  if (e.code === 'Tab') return 'tab';
  if (e.code === 'Escape') return 'escape';
  if (e.code === 'Enter') return 'enter';
  return e.key.toLowerCase();
}

const HANDLED = new Set(['space', 'up', 'down', 'left', 'right', 'tab']);

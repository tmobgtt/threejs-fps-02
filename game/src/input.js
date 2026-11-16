// input.js - raw keyboard and mouse state, nothing more.
// The player controller and the menus read this; the simulation never
// touches the DOM itself. Pointer lock is requested on the canvas by
// main.js; mouse movement accumulates here between frames and is
// consumed (and zeroed) by whoever steers the camera.

export const keys = new Set();
export const mouse = { dx: 0, dy: 0, down: false, rightDown: false, clicked: false, rightClicked: false };
let wheelDelta = 0;

export function initInput(canvas) {
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (['Tab', 'Space', 'KeyB'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); mouse.down = false; mouse.rightDown = false; });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === canvas) {
      mouse.dx += e.movementX || 0;
      mouse.dy += e.movementY || 0;
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== canvas) return;
    if (e.button === 0) { mouse.down = true; mouse.clicked = true; }
    if (e.button === 2) { mouse.rightDown = true; mouse.rightClicked = true; }
  });
  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouse.down = false;
    if (e.button === 2) mouse.rightDown = false;
  });
  document.addEventListener('wheel', (e) => { wheelDelta += Math.sign(e.deltaY); }, { passive: true });
  document.addEventListener('contextmenu', (e) => {
    if (document.pointerLockElement === canvas) e.preventDefault();
  });
}

// Called once per rendered frame by the consumer of the deltas.
export function consumeMouse() {
  const out = { dx: mouse.dx, dy: mouse.dy, clicked: mouse.clicked, rightClicked: mouse.rightClicked, wheel: wheelDelta, rightDown: mouse.rightDown, down: mouse.down };
  mouse.dx = 0; mouse.dy = 0; mouse.clicked = false; mouse.rightClicked = false; wheelDelta = 0;
  return out;
}

export function down(code) { return keys.has(code); }

// One-shot key presses: main.js polls this set each frame and clears it.
export const pressed = new Set();
window.addEventListener('keydown', (e) => { if (!e.repeat) pressed.add(e.code); });
export function takePress(code) {
  if (pressed.has(code)) { pressed.delete(code); return true; }
  return false;
}
export function clearPresses() { pressed.clear(); }

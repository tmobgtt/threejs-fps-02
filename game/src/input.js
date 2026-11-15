// input.js — keyboard and pointer-lock mouse, nothing else.
//
// The game polls `keys` every simulation step and drains the accumulated
// mouse movement once per step, so input timing follows the fixed-step
// simulation rather than the frame rate. Edge presses (reload, buy keys,
// weapon slots) are queued as keydown events with their code.

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.presses = []; // key codes pressed since the last drain
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.firing = false;
    this.aiming = false; // right mouse held (sniper scope)
    this.locked = false;
    this.wheel = 0; // signed wheel steps since the last drain
    this.dom = dom;

    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this.presses.push(e.code);
      if (["Tab", "Space", "KeyB"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => {
      this.keys.clear();
      this.firing = false;
      this.aiming = false;
    });

    dom.addEventListener("click", () => {
      if (!this.locked) dom.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === dom;
      if (!this.locked) {
        this.firing = false;
        this.aiming = false;
      }
    });
    addEventListener("mousemove", (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    addEventListener("mousedown", (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.firing = true;
      if (e.button === 2) this.aiming = true;
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.firing = false;
      if (e.button === 2) this.aiming = false;
    });
    addEventListener("contextmenu", (e) => e.preventDefault());
    addEventListener("wheel", (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
  }

  down(code) { return this.keys.has(code); }

  // Drain the per-step accumulators.
  takeMouse() {
    const dx = this.mouseDX, dy = this.mouseDY;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return [dx, dy];
  }
  takePresses() {
    const p = this.presses;
    this.presses = [];
    return p;
  }
  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
}

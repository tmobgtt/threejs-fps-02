// hud.js — everything drawn over the 3D view: vitals, ammunition, money,
// the clock and score, killfeed, banners, the buy menu and the scoreboard.
//
// Pure presentation: main feeds it numbers and events, it owns the DOM.

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.root = $("hud");
    this.healthNum = $("health-num");
    this.healthFill = $("health-fill");
    this.armorFill = $("armor-fill");
    this.armorNum = $("armor-num");
    this.ammoBox = $("ammo");
    this.ammoMag = $("ammo-mag");
    this.ammoRes = $("ammo-res");
    this.weaponName = $("weapon-name");
    this.money = $("money");
    this.grenades = $("grenades");
    this.timer = $("timer");
    this.roundLabel = $("round-label");
    this.scoreAtk = $("score-atk");
    this.scoreDef = $("score-def");
    this.pipsAtk = $("pips-atk");
    this.pipsDef = $("pips-def");
    this.killfeed = $("killfeed");
    this.banner = $("banner");
    this.bannerMain = $("banner-main");
    this.bannerSub = $("banner-sub");
    this.hint = $("hint");
    this.channel = $("channel");
    this.channelLabel = $("channel-label");
    this.channelFill = $("channel-fill");
    this.hitmark = $("hitmarker");
    this.vignette = $("damage-vignette");
    this.dmgDir = $("damage-dir");
    this.flashEl = $("flash");
    this.scopeEl = $("scope");
    this.crosshair = $("crosshair");
    this.buyMenu = $("buy-menu");
    this.buyGrid = $("buy-grid");
    this.buyMoney = $("buy-money");
    this.scoreboard = $("scoreboard");
    this.sbRows = $("sb-rows");
    this.bombState = $("bomb-state");
    this.hitT = 0;
    this.vigT = 0;
    this.bannerUntil = 0;
    for (const parent of [this.pipsAtk, this.pipsDef]) {
      for (let i = 0; i < 4; i++) {
        const p = document.createElement("div");
        p.className = "pip alive " + (parent === this.pipsAtk ? "atk" : "def");
        parent.appendChild(p);
      }
    }
  }

  show() { this.root.classList.remove("hidden"); }
  hide() { this.root.classList.add("hidden"); }

  setVitals(hp, armor) {
    this.healthNum.textContent = Math.max(0, Math.ceil(hp));
    this.healthFill.style.width = `${Math.max(0, hp)}%`;
    this.healthFill.style.background = hp <= 30 ? "#e5484d" : "#d8dfd2";
    this.armorFill.style.width = `${Math.max(0, armor)}%`;
    this.armorNum.textContent = Math.max(0, Math.ceil(armor));
  }

  setAmmo(gun, weaponName, grenades, hasBomb) {
    const def = gun.def;
    this.weaponName.textContent = weaponName;
    if (def.magSize === Infinity) {
      this.ammoMag.textContent = "—";
      this.ammoRes.textContent = "";
    } else {
      this.ammoMag.textContent = gun.mag;
      this.ammoRes.textContent = gun.reserve;
    }
    this.ammoBox.classList.toggle("low", def.magSize !== Infinity && gun.mag <= Math.ceil(def.magSize * 0.25));
    const parts = [];
    if (grenades.he) parts.push(`HE ×${grenades.he}`);
    if (grenades.flash) parts.push(`FLASH ×${grenades.flash}`);
    if (grenades.smoke) parts.push(`SMOKE ×${grenades.smoke}`);
    if (hasBomb) parts.push("◆ CHARGE");
    this.grenades.textContent = parts.join("   ");
  }

  setMoney(m) { this.money.textContent = `$${m}`; }

  setClock(seconds, label, low) {
    const s = Math.max(0, Math.ceil(seconds));
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    this.timer.classList.toggle("low", !!low);
    this.roundLabel.textContent = label;
  }

  setScore(score, round) {
    this.scoreAtk.textContent = score.atk;
    this.scoreDef.textContent = score.def;
  }

  setPips(aliveAtk, aliveDef) {
    [...this.pipsAtk.children].forEach((p, i) => p.classList.toggle("alive", i < aliveAtk));
    [...this.pipsDef.children].forEach((p, i) => p.classList.toggle("alive", i < aliveDef));
  }

  feed(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    this.killfeed.prepend(div);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild.remove();
    setTimeout(() => div.remove(), 4200);
  }

  showBanner(main, sub = "", ms = 2600) {
    this.bannerMain.textContent = main;
    this.bannerSub.textContent = sub;
    this.banner.classList.remove("hidden");
    this.bannerUntil = performance.now() + ms;
  }

  setHint(text) { this.hint.textContent = text || ""; }

  setChannel(frac, label) {
    if (frac === null) {
      this.channel.classList.add("hidden");
      return;
    }
    this.channel.classList.remove("hidden");
    this.channelLabel.textContent = label;
    this.channelFill.style.width = `${Math.round(frac * 100)}%`;
  }

  hitmarker(head = false) {
    this.hitmark.classList.toggle("head", head);
    this.hitmark.style.opacity = 1;
    this.hitT = 0.14;
  }

  hurt(angleRad) {
    this.vigT = 0.55;
    this.vignette.style.opacity = 0.95;
    if (angleRad !== null && angleRad !== undefined) {
      this.dmgDir.style.transform = `rotate(${angleRad}rad)`;
      this.dmgDir.style.opacity = 0.95;
    }
  }

  setFlash(amount) { this.flashEl.style.opacity = Math.max(0, Math.min(1, amount)); }
  setScope(on) { this.scopeEl.style.opacity = on ? 1 : 0; this.crosshair.style.opacity = on ? 0 : 1; }
  setSpread(px) { this.crosshair.style.setProperty("--sp", `${Math.round(px)}px`); }
  setBombState(text) { this.bombState.textContent = text || ""; }

  // Buy menu: items are { key, label, price, owned, cant }.
  renderBuy(items, money, onBuy) {
    this.buyMoney.textContent = `$${money}`;
    this.buyGrid.innerHTML = "";
    for (const it of items) {
      const div = document.createElement("div");
      div.className = "buy-item" + (it.owned ? " owned" : "") + (it.cant ? " cant" : "");
      div.innerHTML = `<span><span class="b-key">${it.key}</span>${it.label}${it.owned ? " ✓" : ""}</span><span class="b-price">$${it.price}</span>`;
      if (!it.cant && !it.owned) div.addEventListener("click", () => onBuy(it.id));
      this.buyGrid.appendChild(div);
    }
  }
  showBuy() { this.buyMenu.classList.remove("hidden"); }
  hideBuy() { this.buyMenu.classList.add("hidden"); }
  buyOpen() { return !this.buyMenu.classList.contains("hidden"); }

  renderScoreboard(rows) {
    this.sbRows.innerHTML = rows.map((r) =>
      `<div class="sb-row${r.alive ? "" : " dead"}"><span class="sb-name ${r.team}">${r.name}</span><span>${r.kills} / ${r.deaths}</span><span>$${r.money}</span></div>`
    ).join("");
  }
  showScoreboard() { this.scoreboard.classList.remove("hidden"); }
  hideScoreboard() { this.scoreboard.classList.add("hidden"); }

  // Per-frame fades, driven from the render loop (never the simulation).
  update(dt) {
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hitmark.style.opacity = 0;
    }
    if (this.vigT > 0) {
      this.vigT -= dt;
      const o = Math.max(0, this.vigT / 0.55) * 0.95;
      this.vignette.style.opacity = o;
      this.dmgDir.style.opacity = o;
    }
    if (this.bannerUntil && performance.now() > this.bannerUntil) {
      this.banner.classList.add("hidden");
      this.bannerUntil = 0;
    }
  }
}

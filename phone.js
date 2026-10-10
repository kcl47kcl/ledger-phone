// TeraFinn phone app. Opens encrypted .ledger files made on your Mac and shows the dashboard.
// Everything happens on the phone: no network requests, no analytics, no third-party code.
// The decryption key is derived once from the pairing code and kept as a non-extractable
// WebCrypto key in this app's storage. The file itself is stored still encrypted.
"use strict";

(() => {
  const { el, dollars, monthName } = window.LedgerDash;
  const page = document.getElementById("page");
  const tabs = document.getElementById("tabs");
  const fileInput = document.getElementById("file");
  const FORMAT = "ledger-phone", VERSION = 1, SALT = "ledger-phone-v1", ITER = 200000;
  const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let snap = null;          // decrypted snapshot (memory only)
  const view = { month: null, books: "household", q: "", shown: 150 };

  // --- storage (IndexedDB) ---------------------------------------------------------------
  const db = () => new Promise((res, rej) => {
    const r = indexedDB.open("ledger-phone", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function kv(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  const get = (k) => kv("readonly", (s) => s.get(k));
  const put = (k, v) => kv("readwrite", (s) => s.put(v, k));
  const wipe = () => kv("readwrite", (s) => s.clear());

  // --- crypto ----------------------------------------------------------------------------
  const enc = new TextEncoder();
  function normalize(code) {
    const c = code.toUpperCase().replace(/[\s-]/g, "");
    if (c.length !== 26 || [...c].some((ch) => !B32.includes(ch))) throw new Error("That doesn't look like a pairing code. It has 26 letters and numbers, like ABCD-EFGH-…");
    return c;
  }
  async function pairingId(code) {
    const h = await crypto.subtle.digest("SHA-256", enc.encode("ledger-pair|" + code));
    return [...new Uint8Array(h)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function deriveKey(code) {
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt: enc.encode(SALT), iterations: ITER, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  }
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function decrypt(envText) {
    let env;
    try { env = JSON.parse(envText); } catch { throw new Error("That file isn't a TeraFinn file."); }
    if (env.format !== FORMAT) throw new Error("That file isn't a TeraFinn file.");
    if (env.v !== VERSION) throw new Error("This file was made by a newer TeraFinn. Update the phone app.");
    const key = await get("key"), pid = await get("pairing_id");
    if (!key) throw new Error("Pair this phone first.");
    if (env.pairing_id !== pid) throw new Error("This file was made for a different pairing. Pair again with the code shown on your Mac.");
    const aad = enc.encode(`${env.format}|${env.v}|${env.pairing_id}|${env.created_at}`);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv), additionalData: aad }, key, unb64(env.data)); }
    catch { throw new Error("This file couldn't be opened. It may be damaged, or the pairing changed."); }
    const text = await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    return JSON.parse(text);
  }

  // --- ui helpers ------------------------------------------------------------------------
  let toastTimer;
  function toast(msg, bad = false) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ""; }, bad ? 6000 : 3000);
  }
  const shortDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { month: "short", day: "numeric" }); };
  function freshness() {
    const f = document.getElementById("fresh");
    if (!snap) { f.textContent = ""; return; }
    const made = new Date(snap.created_at);
    const days = Math.floor((Date.now() - made) / 86400000);
    f.textContent = days < 1 ? `Updated ${made.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : `Updated ${made.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    f.className = "fresh" + (days >= 7 ? " stale" : "");
  }

  // --- screens ---------------------------------------------------------------------------
  // --- QR scanning from a photo -------------------------------------------------------
  // Tapping "Scan" opens the camera through a file input (capture="environment"). The photo
  // never leaves the phone and isn't stored: it is decoded in memory with jsQR and dropped.
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fall through */ }
      try { return await createImageBitmap(file); } catch { /* fall through */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await img.decode();
      return img;
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }
  function decodeAt(src, maxSide, crop) {
    const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    const [cx, cy, cw, ch] = crop ? [sw * crop, sh * crop, sw * (1 - 2 * crop), sh * (1 - 2 * crop)] : [0, 0, sw, sh];
    const scale = Math.min(1, maxSide / Math.max(cw, ch));
    const w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(src, cx, cy, cw, ch, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const hit = window.jsQR(data.data, w, h, { inversionAttempts: "attemptBoth" });
    canvas.width = canvas.height = 0;
    return hit ? hit.data : null;
  }
  async function scanPhoto(file) {
    if (!window.jsQR) throw new Error("The scanner didn't load. Reload the app and try again.");
    const bmp = await loadBitmap(file);
    try {
      // Several sizes and a centre crop: phone photos of a screen vary a lot.
      for (const [side, crop] of [[1000, 0], [1600, 0], [700, 0], [1200, 0.2], [2400, 0]]) {
        const text = decodeAt(bmp, side, crop);
        if (text) return text;
        await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive
      }
      return null;
    } finally { if (bmp.close) bmp.close(); }
  }

  function pairScreen() {
    const input = el("input", { type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "ABCD-EFGH-…", "aria-label": "Pairing code", class: "code-input" });
    const err = el("p", { class: "error", role: "alert" });
    const btn = el("button", { type: "submit", class: "primary wide" }, "Pair this phone");
    const camera = el("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, "aria-hidden": "true", tabindex: "-1" });
    const scanBtn = el("button", { type: "button", class: "scan-btn", onclick: () => { err.textContent = ""; camera.click(); } },
      el("span", { class: "scan-icon", "aria-hidden": "true" }),
      el("span", {}, el("strong", {}, "Tap to scan the code"), el("span", { class: "scan-sub" }, "Opens the camera. Snap the QR code on your Mac.")));
    const manual = el("div", { class: "manual", hidden: true },
      el("label", {}, "Pairing code", el("span", { class: "hint" }, "On your Mac: Settings, Phone, Show pairing code. Type it or paste it here."), input), btn);
    const showManual = el("button", { type: "button", class: "link", onclick: (e) => { manual.hidden = false; e.currentTarget.hidden = true; input.focus(); } }, "Type or paste the code instead");

    async function pair(raw) {
      const code = normalize(raw);
      await put("key", await deriveKey(code));
      await put("pairing_id", await pairingId(code));
      input.value = "";
      toast("Paired. Now open a TeraFinn file from your Mac.");
      route();
    }
    camera.addEventListener("change", async () => {
      const f = camera.files && camera.files[0];
      camera.value = "";
      if (!f) return;
      scanBtn.disabled = true;
      scanBtn.querySelector("strong").textContent = "Reading the code…";
      try {
        const text = await scanPhoto(f);
        if (!text) throw new Error("Couldn't find a QR code in that photo. Fill the frame with the code, hold steady, and try again. Or type it instead.");
        await pair(text);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        scanBtn.disabled = false;
        scanBtn.querySelector("strong").textContent = "Tap to scan the code";
      }
    });

    const form = el("form", { class: "card-form", onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      try { btn.disabled = true; btn.textContent = "Pairing…"; await pair(input.value); }
      catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; btn.textContent = "Pair this phone"; }
    } }, scanBtn, camera, err, showManual, manual);
    return [el("h1", {}, "Your finances, on this phone"),
      el("p", { class: "lede" }, "This app shows an encrypted copy of your TeraFinn dashboard made on your Mac. It never connects to your bank or to any server."),
      installHint(),
      el("p", { class: "small muted" }, "On your Mac, open TeraFinn, then Settings, Phone, and Pair a phone to show the code."),
      form];
  }

  function installHint() {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) return null;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    return el("p", { class: "note" }, ios
      ? "Add TeraFinn to your Home Screen first: tap Share, then Add to Home Screen. Then pair inside the installed app. Safari and the Home Screen app keep separate data."
      : "Install TeraFinn first: open the browser menu and choose Install app or Add to Home screen.");
  }

  function openScreen() {
    return [el("h1", {}, "Open your latest file"),
      el("p", { class: "lede" }, "On your Mac, choose Export for phone in Settings, then AirDrop or share the file to this phone."),
      el("button", { type: "button", class: "primary wide", onclick: () => fileInput.click() }, "Open a TeraFinn file"),
      el("p", { class: "small muted" }, "On iPhone, AirDropped files are in Files, in Downloads.")];
  }

  function dashboard() {
    const month = view.month && snap.dashboards[view.books][view.month] ? view.month : (snap.default_month || snap.months[snap.months.length - 1]);
    view.month = month;
    const data = snap.dashboards[view.books][month];
    const nodes = window.LedgerDash.render(data, {
      onMonth: (m) => { if (snap.dashboards[view.books][m]) { view.month = m; render(); } },
      onBooks: (b) => { view.books = b; render(); },
      monthsAvailable: snap.months,
    });
    return [el("div", { class: "dash" }, nodes)];
  }

  function transactions() {
    const q = view.q.trim().toLowerCase();
    const rows = snap.transactions.filter((t) => !q || t.m.toLowerCase().includes(q) || t.r.toLowerCase().includes(q));
    const search = el("input", { type: "search", placeholder: "Search", value: view.q, "aria-label": "Search transactions" });
    let tmr;
    search.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(() => { view.q = search.value; view.shown = 150; render(); setTimeout(() => { const s = page.querySelector('input[type="search"]'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 250); });
    const list = el("ul", { class: "tx-list" }, rows.slice(0, view.shown).map((t) => el("li", {},
      el("div", { class: "tx-main" }, el("span", { class: "tx-m" }, t.m, t.p ? el("span", { class: "tag" }, "Pending") : null, t.t ? el("span", { class: "tag" }, "Transfer") : null),
        el("span", { class: "tx-sub" }, `${shortDate(t.d)}, ${t.acct}`)),
      el("span", { class: "tx-a" + (t.a > 0 ? " in" : "") }, dollars(t.a, { sign: true })))));
    return [el("h1", {}, "Transactions"), search,
      el("p", { class: "small muted" }, `${rows.length.toLocaleString()} transactions in this copy`), list,
      rows.length > view.shown ? el("button", { type: "button", class: "wide", onclick: () => { view.shown += 150; render(); } }, "Show more") : null];
  }

  function accounts() {
    const assets = snap.accounts.filter((a) => !["credit_card", "loan"].includes(a.type)).reduce((n, a) => n + (a.balance_cents || 0), 0);
    const owed = snap.accounts.filter((a) => ["credit_card", "loan"].includes(a.type)).reduce((n, a) => n + (a.balance_cents || 0), 0);
    return [el("h1", {}, "Accounts"),
      el("div", { class: "totals" }, [["Cash and investments", assets], ["Cards and loans", owed], ["Net position", assets + owed]].map(([k, v]) =>
        el("section", { class: "kpi" }, el("div", { class: "kpi-label" }, k), el("div", { class: "kpi-value" }, dollars(v, { cents: false }))))),
      el("ul", { class: "tx-list" }, snap.accounts.map((a) => el("li", {},
        el("div", { class: "tx-main" }, el("span", { class: "tx-m" }, a.name + (a.mask ? ` ••${a.mask}` : "")), el("span", { class: "tx-sub" }, a.type.replace("_", " "))),
        el("span", { class: "tx-a" }, dollars(a.balance_cents))))),
      el("p", { class: "small muted" }, `Balances as of ${new Date(snap.created_at).toLocaleString()}.`)];
  }

  function settings() {
    return [el("h1", {}, "Settings"),
      el("div", { class: "sheet set-list" },
        el("p", {}, snap ? `Showing a copy made ${new Date(snap.created_at).toLocaleString()}.` : "No file opened yet."),
        el("button", { type: "button", class: "primary wide", onclick: () => fileInput.click() }, "Open a newer file"),
        el("button", { type: "button", class: "wide danger-outline", onclick: async () => {
          if (!confirm("Unpair this phone and erase TeraFinn's data from it?")) return;
          await wipe(); snap = null; toast("Erased. This phone is no longer paired."); location.hash = ""; route();
        } }, "Unpair and erase this phone")),
      el("p", { class: "small muted" }, "Privacy: this app makes no network requests. Your file stays encrypted on the phone and is decrypted only while the app is open. Protect the phone with a passcode.")];
  }

  // --- router ----------------------------------------------------------------------------
  const pages = { dashboard, transactions, accounts, settings };
  function render() {
    window.LedgerDash.hideTip();
    const name = location.hash.slice(1) || "dashboard";
    tabs.querySelectorAll("a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.page === name));
    page.replaceChildren(...(pages[name] || dashboard)().flat().filter(Boolean));
    window.scrollTo(0, 0);
  }
  async function route() {
    const key = await get("key");
    if (!key) { tabs.hidden = true; page.replaceChildren(...pairScreen().filter(Boolean)); freshness(); return; }
    if (!snap) {
      const env = await get("file");
      if (env) {
        try { snap = await decrypt(env); } catch (e) { toast(e.message, true); }
      }
    }
    if (!snap) { tabs.hidden = true; page.replaceChildren(...openScreen()); freshness(); return; }
    tabs.hidden = false; freshness(); render();
  }

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { toast("That file is too large to be a TeraFinn file.", true); return; }
    try {
      const text = await f.text();
      const fresh = await decrypt(text);
      if (snap && fresh.created_at < snap.created_at && !confirm("This file is older than the one already open. Use it anyway?")) return;
      await put("file", text);
      snap = fresh; view.month = null;
      toast("Up to date.");
      location.hash = "#dashboard"; route();
    } catch (e) { toast(e.message, true); }
  });
  window.addEventListener("hashchange", () => { if (snap) render(); });

  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  route().catch((e) => toast(e.message, true));
})();

// TeraFinn dashboard renderer, shared by the Mac app and the phone app.
// Pure rendering from a data payload (see ledger/analytics.py); no network, no storage.
// Safety rule: bank text (merchants, categories) only ever becomes text nodes.
"use strict";

(function () {
  // --- helpers -------------------------------------------------------------------------
  function el(tag, attrs, ...children) {
    const svg = ["svg", "g", "rect", "line", "path", "circle", "text", "title", "defs", "pattern", "polyline", "tspan"].includes(tag);
    const node = svg ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.setAttribute("class", v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  const dollars = (c, opts = {}) => {
    if (c === null || c === undefined) return "—";
    const v = Math.abs(c) / 100;
    const whole = opts.cents === false || v >= 1000;
    const s = v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 });
    return (c < 0 ? "−" : (opts.sign && c > 0 ? "+" : "")) + s;
  };
  const compact = (c) => {
    const v = Math.abs(c) / 100;
    const s = v >= 1000 ? "$" + (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : "$" + Math.round(v);
    return (c < 0 ? "−" : "") + s;
  };
  const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 1000) / 10}%`);
  const monthName = (key, style = "long") => {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", style === "short" ? { month: "short" } : { month: "long", year: "numeric" });
  };
  const addMonths = (key, n) => {
    const [y, m] = key.split("-").map(Number);
    const i = y * 12 + (m - 1) + n;
    return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
  };

  // --- tooltip (one per page) -------------------------------------------------------------
  let tip = null;
  function showTip(evt, lines) {
    if (!tip) { tip = el("div", { class: "dash-tip", role: "tooltip" }); document.body.append(tip); }
    tip.replaceChildren(...lines.map((l, i) => el("div", { class: i === 0 ? "tip-head" : "tip-row" }, ...(Array.isArray(l) ? l : [l]))));
    tip.style.display = "block";
    const pad = 12, r = tip.getBoundingClientRect();
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
    tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { if (tip) tip.style.display = "none"; }
  const swatch = (cls) => el("span", { class: `sw ${cls}` });

  // --- the allocation strip: where each dollar that came in went -------------------------
  function strip(s, { goalPct, big = true, onGoal } = {}) {
    const income = Math.max(0, s.income);
    const spent = Math.max(0, s.spending);
    const total = Math.max(income, spent, 1);
    const parts = [
      { key: "essential", cls: "seg-essential", label: "Essentials", v: s.essential },
      { key: "optional", cls: "seg-optional", label: "Optional", v: s.optional },
      { key: "unsorted", cls: "seg-unsorted", label: "Not sorted yet", v: s.unsorted },
    ].filter((p) => p.v > 0);
    const kept = income - spent;
    const bar = el("div", { class: "strip" + (big ? " strip-big" : "") });
    for (const p of parts) {
      bar.append(el("div", { class: `seg ${p.cls}`, style: { flexGrow: String(p.v / total) },
        onmousemove: (e) => showTip(e, [p.label, dollars(p.v, { cents: false })]), onmouseleave: hideTip }));
    }
    if (kept > 0) {
      bar.append(el("div", { class: "seg seg-kept", style: { flexGrow: String(kept / total) },
        onmousemove: (e) => showTip(e, ["Kept", dollars(kept, { cents: false })]), onmouseleave: hideTip }));
    }
    const wrap = el("div", { class: "strip-wrap" }, bar);
    if (kept < 0 && income > 0) {
      // Overspent: mark where income ran out; the part past it is hatched.
      const at = (income / total) * 100;
      wrap.append(el("div", { class: "over-zone", style: { left: `${at}%` } }));
      wrap.append(el("div", { class: "income-mark", style: { left: `${at}%` } }));
    }
    if (big && goalPct && income > 0) {
      const at = Math.min(100, Math.max(0, (1 - goalPct / 100) * (income / total) * 100));
      const lbl = el("button", { type: "button", class: "goal-label", style: { left: `${at}%` }, onclick: onGoal || null, disabled: !onGoal },
        `Goal: keep ${goalPct}%`);
      wrap.append(el("div", { class: "goal-mark", style: { left: `${at}%` } }), lbl);
    }
    return wrap;
  }

  // --- columns: 12 months of spending (stacked) with income as a line ---------------------
  function monthColumns(allMonths, selected, onSelect) {
    const narrow = window.matchMedia("(max-width: 600px)").matches;
    const months = narrow ? allMonths.slice(-6) : allMonths;
    const W = narrow ? 360 : 1120, H = narrow ? 200 : 260, L = narrow ? 40 : 52, R = 8, T = 12, B = 28;
    const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.spending)));
    const step = niceStep(max);
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const bw = (W - L - R) / months.length;
    const barW = Math.min(32, bw * 0.5);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Income and spending by month" });
    for (let v = 0; v <= top; v += step) {
      svg.append(el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
      svg.append(el("text", { x: L - 8, y: y(v) + 4, class: "tick", "text-anchor": "end" }, compact(v)));
    }
    const pts = [];
    months.forEach((m, i) => {
      const cx = L + bw * i + bw / 2;
      const x0 = cx - barW / 2;
      const g = el("g", { class: "col" + (m.month === selected ? " col-sel" : ""), tabindex: "0", role: "button",
        "aria-label": `${monthName(m.month)}: income ${dollars(m.income, { cents: false })}, spending ${dollars(m.spending, { cents: false })}` });
      let base = 0;
      const stack = [["seg-essential", m.essential], ["seg-optional", m.optional], ["seg-unsorted", m.unsorted]].filter(([, v]) => v > 0);
      stack.forEach(([cls, v], k) => {
        const h = Math.max(0, y(base) - y(base + v));
        const isTop = k === stack.length - 1;
        // 2px surface gap between stacked segments.
        g.append(el("path", { class: `${cls}-fill`, d: roundTop(x0, y(base + v), barW, h - (k > 0 ? 2 : 0), isTop ? 4 : 0) }));
        base += v;
      });
      g.append(el("rect", { x: L + bw * i, y: T, width: bw, height: H - T - B, class: "hit" }));
      g.append(el("text", { x: cx, y: H - 8, class: "tick" + (m.month === selected ? " tick-sel" : ""), "text-anchor": "middle" }, monthName(m.month, "short")));
      const tipLines = [monthName(m.month), [swatch("sw-income"), `Came in ${dollars(m.income, { cents: false })}`],
        [swatch("seg-essential"), `Essentials ${dollars(m.essential, { cents: false })}`],
        [swatch("seg-optional"), `Optional ${dollars(m.optional, { cents: false })}`],
        [swatch("seg-kept"), `Kept ${dollars(m.kept, { cents: false })} (${pct(m.savings_rate)})`]];
      g.addEventListener("mousemove", (e) => showTip(e, tipLines));
      g.addEventListener("mouseleave", hideTip);
      if (onSelect) {
        g.addEventListener("click", () => onSelect(m.month));
        g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(m.month); } });
      }
      svg.append(g);
      if (m.income > 0) pts.push([cx, y(m.income)]);
    });
    if (pts.length > 1) svg.append(el("polyline", { class: "income-line", points: pts.map((p) => p.join(",")).join(" ") }));
    for (const [px, py] of pts) svg.append(el("circle", { cx: px, cy: py, r: 4, class: "income-dot" }));
    return svg;
  }
  function roundTop(x, y, w, h, r) {
    if (h <= 0) return "";
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function niceStep(max) {
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }

  function sparkline(series) {
    const vals = series.filter((p) => p.net_cents !== null);
    if (vals.length < 2) return null;
    const W = 240, H = 56, P = 6;
    const xs = (i) => P + (W - 2 * P) * (i / (series.length - 1));
    const min = Math.min(...vals.map((p) => p.net_cents)), max = Math.max(...vals.map((p) => p.net_cents));
    const ys = (v) => H - P - (H - 2 * P) * ((v - min) / Math.max(1, max - min));
    const pts = series.map((p, i) => (p.net_cents === null ? null : [xs(i), ys(p.net_cents)])).filter(Boolean);
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "spark", role: "img", "aria-label": "Net position over 12 months" },
      el("polyline", { class: "spark-line", points: pts.map((p) => p.join(",")).join(" ") }),
      el("circle", { class: "spark-dot", cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1], r: 4 }));
    return svg;
  }


  // --- pie (donut) charts: spending by category group, then inside a group ----------------
  // Colors follow the entity, never its rank: the server names the groups (and, per group,
  // the categories) that own the five color slots, chosen by 12-month spending. Everything
  // else folds into "Other"; "Not sorted yet" is grey with a texture. Every pie carries a
  // value table (names, amounts, shares), so color never has to carry meaning alone.
  const SLOTS = ["f-s1", "f-s2", "f-s3", "f-s4", "f-s5"];
  const UNSORTED = "Not sorted yet";

  function pieSegments(items, owners) {
    const named = [], folded = [];
    let unsorted = null;
    for (const it of items) {
      if (it.amount <= 0 && !(it.previous > 0)) continue;
      if (it.name === UNSORTED) { unsorted = { ...it, cls: "f-unsorted" }; continue; }
      const i = owners.indexOf(it.name);
      if (i >= 0) named.push({ ...it, cls: SLOTS[i] }); else folded.push(it);
    }
    named.sort((a, b) => b.amount - a.amount);
    folded.sort((a, b) => b.amount - a.amount);
    const out = named;
    if (folded.length === 1) out.push({ ...folded[0], cls: "f-other" });
    else if (folded.length) {
      out.push({ name: "Other", cls: "f-other", other: true, members: folded,
        amount: folded.reduce((n, f) => n + Math.max(0, f.amount), 0),
        previous: folded.reduce((n, f) => n + (f.previous || 0), 0) });
    }
    if (unsorted) out.push(unsorted);
    return out;
  }

  function arcPath(cx, cy, r0, r1, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (r, a) => `${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}`;
    return `M${p(r1, a0)}A${r1},${r1} 0 ${large} 1 ${p(r1, a1)}L${p(r0, a1)}A${r0},${r0} 0 ${large} 0 ${p(r0, a0)}Z`;
  }

  function donut(segs, { total, center, label, selected, onPick }) {
    const S = 200, c = S / 2, R1 = 96, R0 = 60;
    const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "pie" + (selected ? " has-sel" : ""), role: "img", "aria-label": label },
      el("defs", {}, el("pattern", { id: "tf-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
        el("rect", { width: 6, height: 6, style: { fill: "var(--s-unsorted)" } }),
        el("line", { x1: 0, y1: 0, x2: 0, y2: 6, style: { stroke: "var(--s-other)", strokeWidth: "2" } }))));
    const shown = segs.filter((s) => s.amount > 0);
    const sum = shown.reduce((n, s) => n + s.amount, 0);
    let a = 0;
    for (const sg of shown) {
      const frac = sg.amount / sum;
      let a1 = a + frac * Math.PI * 2;
      if (frac >= 0.9999) a1 = a + Math.PI * 2 - 0.0001;
      const share = Math.round(frac * 1000) / 10;
      const path = el("path", { d: arcPath(c, c, R0, R1, a, a1), class: `slice ${sg.cls}` + (selected === sg.name ? " is-sel" : ""),
        tabindex: onPick ? "0" : null, role: onPick ? "button" : null,
        "aria-label": `${sg.name}: ${dollars(sg.amount, { cents: false })}, ${share}%` });
      path.addEventListener("mousemove", (e) => showTip(e, [sg.name, `${dollars(sg.amount, { cents: false })} · ${share}%`,
        sg.previous !== undefined ? `Before: ${dollars(sg.previous || 0, { cents: false })}` : null].filter(Boolean)));
      path.addEventListener("mouseleave", hideTip);
      if (onPick) {
        path.addEventListener("click", () => { hideTip(); onPick(sg); });
        path.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(sg); } });
      }
      svg.append(path);
      a = a1;
    }
    if (!shown.length) svg.append(el("circle", { cx: c, cy: c, r: (R0 + R1) / 2, style: { fill: "none", stroke: "var(--rule)", strokeWidth: String(R1 - R0) } }));
    svg.append(el("text", { x: c, y: c + 2, "text-anchor": "middle", class: "hole-value" }, dollars(total, { cents: false })));
    svg.append(el("text", { x: c, y: c + 20, "text-anchor": "middle", class: "hole-label" }, center));
    return svg;
  }

  function pieTable(segs, { total, prevLabel, selected, onPick }) {
    const share = (v) => (total > 0 ? `${Math.round((v / total) * 1000) / 10}%` : "—");
    const change = (s) => {
      if (s.previous === undefined) return "";
      const d = s.amount - (s.previous || 0);
      if (Math.abs(d) < 100) return "—";
      return `${d > 0 ? "▲" : "▼"} ${dollars(Math.abs(d), { cents: false })}`;
    };
    const row = (s, sub) => el("tr", { class: (onPick && !sub ? "row-btn" : sub && onPick ? "row-btn" : "") + (selected === s.name ? " is-sel" : ""),
      onclick: onPick ? () => onPick(s) : null },
      el("td", {}, el("span", { class: "name" }, sub ? el("span", { class: "sw", style: { visibility: "hidden" } }) : el("span", { class: `sw ${s.cls}` }),
        el("span", {}, sub ? `↳ ${s.name}` : s.name))),
      el("td", { class: "num" }, dollars(s.amount, { cents: false })),
      el("td", { class: "num" }, share(s.amount)),
      el("td", { class: "num chg" }, change(s)));
    const rows = [];
    for (const s of segs) {
      rows.push(row(s, false));
      if (s.other) for (const m of s.members) if (m.amount > 0) rows.push(row({ ...m, cls: "f-other" }, true));
    }
    return el("table", { class: "pie-table" },
      el("thead", {}, el("tr", {}, el("th", {}, "Category"), el("th", { class: "num" }, "Spent"), el("th", { class: "num" }, "Share"),
        el("th", { class: "num" }, prevLabel ? `vs ${prevLabel}` : ""))),
      el("tbody", {}, rows));
  }

  // groups: [{group, group_id, amount_cents, previous_cents, categories: [{category_id, category, amount_cents, previous_cents}]}]
  function categoryPies(groups, palette, { prevLabel, onCategory, onGroup, periodWord = "this period" }) {
    const pal = palette || { groups: [], categories: {} };
    const total = groups.reduce((n, g) => n + Math.max(0, g.amount_cents), 0);
    const items = groups.map((g) => ({ name: g.group, amount: g.amount_cents, previous: g.previous_cents, group: g }));
    const segs = pieSegments(items, pal.groups);
    const named = segs.filter((s) => s.group && s.name !== UNSORTED);
    let picked = named.length ? named[0].name : (segs[0] ? segs[0].name : null);
    const wrap = el("div", { class: "dash-grid" });
    const draw = () => {
      const left = el("section", { class: "card pie-card span-6" },
        el("div", { class: "section-head" }, el("h2", {}, "Spending by category"), el("span", { class: "fine" }, "Choose a slice to look inside it.")),
        total > 0 || segs.length ? el("div", { class: "pie-body" },
          donut(segs, { total, center: `spent ${periodWord}`, label: "Spending by category group", selected: picked, onPick: pick }),
          pieTable(segs, { total, prevLabel, selected: picked, onPick: pick })) : el("p", { class: "pie-empty" }, "No spending in this period."));
      wrap.replaceChildren(left, inside());
    };
    function pick(sg) {
      if (sg.other) { picked = sg.members[0] ? sg.members[0].name : picked; } else picked = sg.name;
      draw();
    }
    function inside() {
      const g = groups.find((x) => x.group === picked);
      const card = el("section", { class: "card pie-card span-6" });
      if (!g) { card.append(el("h2", {}, "Inside a category"), el("p", { class: "pie-empty" }, "Choose a slice on the left.")); return card; }
      const gTotal = Math.max(0, g.amount_cents);
      const owners = (pal.categories || {})[g.group] || [];
      const citems = g.categories.map((c) => ({ name: c.category, amount: c.amount_cents, previous: c.previous_cents, cat: c }));
      const csegs = g.group === UNSORTED ? citems.map((c) => ({ ...c, cls: "f-unsorted" })) : pieSegments(citems, owners);
      const openCat = onCategory ? (sg) => {
        const c = sg.cat || (sg.other ? null : null);
        if (c && c.category_id) onCategory(c.category_id);
        else if (sg.other && onGroup && g.group_id) onGroup(g.group_id);
      } : null;
      card.append(
        el("div", { class: "section-head" }, el("h2", {}, `Inside ${g.group}`),
          onGroup && (g.group_id || g.group === UNSORTED) ? el("button", { type: "button", class: "link small", onclick: () => onGroup(g.group_id, g.group === UNSORTED) }, "See transactions") : null),
        el("div", { class: "pie-body" },
          donut(csegs, { total: gTotal, center: g.group.length > 16 ? "in this group" : `on ${g.group.toLowerCase()}`, label: `Spending inside ${g.group}`, onPick: openCat }),
          pieTable(csegs, { total: gTotal, prevLabel, onPick: openCat })),
        onCategory ? el("p", { class: "fine" }, "Choose a category to see its transactions.") : null);
      return card;
    }
    draw();
    return wrap;
  }

  // Month payload (dashboard): categories → groups for the pies.
  function groupsFromCategories(cats) {
    const by = new Map();
    for (const c of cats) {
      const gname = c.group || UNSORTED;
      const g = by.get(gname) || { group: gname, group_id: null, amount_cents: 0, previous_cents: 0, categories: [] };
      g.amount_cents += c.amount_cents; g.previous_cents += c.previous_cents || 0;
      g.categories.push({ category_id: c.category_id, category: c.category, amount_cents: c.amount_cents, previous_cents: c.previous_cents || 0 });
      by.set(gname, g);
    }
    return [...by.values()].sort((a, b) => b.amount_cents - a.amount_cents);
  }

  // --- deltas: direction x whether that direction is good ---------------------------------
  function delta(now, before, { goodWhenUp, label, asPoints = false }) {
    if (before === null || before === undefined) return null;
    const d = now - before;
    if (asPoints) {
      const pts = Math.round(d * 1000) / 10;
      if (Math.abs(pts) < 0.5) return el("span", { class: "delta flat" }, `Same as ${label}`);
      const good = (pts > 0) === goodWhenUp;
      return el("span", { class: `delta ${good ? "good" : "watch"}` }, `${pts > 0 ? "▲" : "▼"} ${Math.abs(pts)} pts vs ${label}`);
    }
    if (Math.abs(d) < 100) return el("span", { class: "delta flat" }, `Same as ${label}`);
    const good = (d > 0) === goodWhenUp;
    const rel = before ? ` (${Math.round(Math.abs(d) / Math.abs(before) * 100)}%)` : "";
    return el("span", { class: `delta ${good ? "good" : "watch"}` }, `${d > 0 ? "▲" : "▼"} ${dollars(Math.abs(d), { cents: false })}${rel} vs ${label}`);
  }

  // --- render ---------------------------------------------------------------------------
  function render(data, opts = {}) {
    const { onMonth, onBooks, onNecessity, onGoal, onCategory, onGroup, booksAvailable = ["household", "rental", "combined"], monthsAvailable, headless = false } = opts;
    const s = data.selected, p = data.previous, a = data.average6;
    const prevLabel = data.previous_is_same_period ? `${monthName(addMonths(data.month, -1), "short")} at this point` : monthName(addMonths(data.month, -1), "short");
    const out = [];

    // Controls
    const canBack = monthsAvailable ? monthsAvailable.includes(addMonths(data.month, -1)) : (!data.first_month || addMonths(data.month, -1) >= data.first_month);
    const canFwd = monthsAvailable ? monthsAvailable.includes(addMonths(data.month, 1)) : addMonths(data.month, 1) <= data.as_of.slice(0, 7);
    const booksNames = { household: "Household", rental: "Rental", combined: "Both" };
    if (!headless) out.push(el("div", { class: "dash-head" },
      el("div", { class: "month-nav" },
        el("button", { type: "button", class: "icon-btn", "aria-label": "Previous month", disabled: !canBack || !onMonth, onclick: () => onMonth(addMonths(data.month, -1)) }, "‹"),
        el("h1", {}, monthName(data.month), data.is_partial ? el("span", { class: "so-far" }, " so far") : null),
        el("button", { type: "button", class: "icon-btn", "aria-label": "Next month", disabled: !canFwd || !onMonth, onclick: () => onMonth(addMonths(data.month, 1)) }, "›")),
      onBooks ? el("div", { class: "seg-control", role: "group", "aria-label": "Books" },
        booksAvailable.map((b) => el("button", { type: "button", "aria-pressed": String(b === data.books), onclick: () => onBooks(b) }, booksNames[b]))) : null));

    // Hero: the one sentence that matters
    const rate = s.savings_rate;
    const hero = el("section", { class: "hero" });
    if (s.income > 0) {
      hero.append(el("p", { class: "hero-line" },
        s.kept >= 0 ? "You kept " : "You spent ",
        el("strong", {}, dollars(Math.abs(s.kept), { cents: false })),
        s.kept >= 0 ? " of the " : " more than the ",
        el("strong", {}, dollars(s.income, { cents: false })),
        data.is_partial ? " that has come in." : " that came in."));
    } else {
      hero.append(el("p", { class: "hero-line" }, "No income recorded ", data.is_partial ? "yet this month." : "this month."));
    }
    hero.append(el("div", { class: "hero-meta" },
      rate !== null ? el("span", { class: "rate" }, `${pct(rate)} kept`) : null,
      p && p.income > 0 ? delta(rate || 0, p.savings_rate || 0, { goodWhenUp: true, label: prevLabel, asPoints: true }) : null,
      rate !== null && rate * 100 >= data.goal_pct ? el("span", { class: "delta good" }, `✓ Goal of ${data.goal_pct}% reached`) : null,
      data.optional_streak >= 2 ? el("span", { class: "delta good" }, `✓ Optional spending at or below usual ${data.optional_streak} months running`) : null));
    hero.append(strip(s, { goalPct: data.goal_pct, onGoal }));
    const kept = s.income - s.spending;
    hero.append(el("ul", { class: "legend" },
      el("li", {}, swatch("seg-essential"), "Essentials ", el("b", {}, dollars(s.essential, { cents: false }))),
      el("li", {}, swatch("seg-optional"), "Optional ", el("b", {}, dollars(s.optional, { cents: false }))),
      s.unsorted > 0 ? el("li", {}, swatch("seg-unsorted"), "Not sorted yet ", el("b", {}, dollars(s.unsorted, { cents: false }))) : null,
      kept >= 0 ? el("li", {}, swatch("seg-kept"), "Kept ", el("b", {}, dollars(kept, { cents: false })))
        : el("li", {}, swatch("seg-over"), "Over by ", el("b", {}, dollars(-kept, { cents: false })))));
    if (s.moved_to_savings > 0) hero.append(el("p", { class: "fine" }, `${dollars(s.moved_to_savings, { cents: false })} of what you kept went into savings or investments.`));
    if (data.is_partial && data.pending_cents > 0) hero.append(el("p", { class: "fine" }, `${dollars(data.pending_cents, { cents: false })} in pending charges isn't counted until it posts.`));
    out.push(hero);

    // Recent months at a glance: small multiples of the same strip
    const recent = data.months.slice(-6).reverse();
    out.push(el("section", { class: "glance" },
      el("h2", {}, "The last six months"),
      el("div", { class: "glance-rows" }, recent.map((m) => el("div", {
        class: "glance-row" + (m.month === data.month ? " is-sel" : ""), role: onMonth ? "button" : null, tabindex: onMonth ? "0" : null,
        onclick: onMonth ? () => onMonth(m.month) : null,
        onkeydown: onMonth ? (e) => { if (e.key === "Enter") onMonth(m.month); } : null },
        el("span", { class: "glance-month" }, monthName(m.month, "short")),
        m.income || m.spending ? strip(m, { big: false }) : el("div", { class: "strip-empty" }, "No data"),
        el("span", { class: "glance-rate" }, m.savings_rate === null ? "—" : pct(m.savings_rate)))))));

    // Tiles
    const tile = (label, value, d, extra) => el("div", { class: "tile" }, el("div", { class: "tile-label" }, label), el("div", { class: "tile-value" }, value), d, extra);
    const usual = a.months ? `usual ${dollars(a.optional, { cents: false })}` : null;
    out.push(el("section", { class: "tiles" },
      tile("Came in", dollars(s.income, { cents: false }), delta(s.income, p.income, { goodWhenUp: true, label: prevLabel })),
      tile("Spent", dollars(s.spending, { cents: false }), delta(s.spending, p.spending, { goodWhenUp: false, label: prevLabel })),
      tile("Optional", dollars(s.optional, { cents: false }), delta(s.optional, p.optional, { goodWhenUp: false, label: prevLabel }),
        usual ? el("div", { class: "tile-sub" }, a.optional && s.optional <= a.optional ? `Under your ${usual}` : `Your ${usual}`) : null),
      tile("Kept", dollars(s.kept, { cents: false }), delta(s.kept, p.kept, { goodWhenUp: true, label: prevLabel }))));

    // Pies: spending by category group, and inside the chosen group
    if (data.categories && data.categories.length) {
      out.push(categoryPies(groupsFromCategories(data.categories), data.palette,
        { prevLabel, onCategory, onGroup, periodWord: data.is_partial ? "so far" : `in ${monthName(data.month, "short")}` }));
    }

    // Room to save
    if (data.books !== "rental") {
      const ops = data.opportunities;
      const sec = el("section", { class: "room" }, el("h2", {}, "Room to save"));
      if (!ops.length) {
        sec.append(el("p", { class: "calm" }, "Nothing stands out this month: optional spending is in line with your usual. That's the goal."));
      } else {
        const yearTotal = ops.reduce((n, o) => n + o.annual_cents, 0);
        sec.append(el("p", { class: "lede-small" }, ops.length === 1 ? "This one change would keep about " : `These ${ops.length} changes would keep about `, el("strong", {}, dollars(yearTotal, { cents: false })), " a year."));
        sec.append(el("div", { class: "cards" }, ops.map((o) => el("article", { class: "op" },
          el("h3", {}, o.title),
          el("p", {}, o.detail),
          o.items && o.items.length ? el("ul", { class: "op-items" }, o.items.map((it) => el("li", {},
            el("span", {}, it.merchant, it.is_new ? el("span", { class: "tag-new" }, "New") : null),
            el("span", { class: "num" }, `${dollars(it.monthly_cents)}/mo`, it.price_change_cents > 0 ? el("span", { class: "up" }, ` +${dollars(it.price_change_cents)}`) : null)))) : null,
          el("div", { class: "op-grow" },
            el("div", {}, el("span", { class: "op-k" }, "A year"), el("span", { class: "op-v" }, dollars(o.annual_cents, { cents: false }))),
            el("div", {}, el("span", { class: "op-k" }, `Invested for ${data.assumptions.fv_years} years`), el("span", { class: "op-v grow" }, "≈ " + dollars(o.future_value_cents, { cents: false })))),
          o.category_id && onCategory ? el("button", { type: "button", class: "link", onclick: () => onCategory(o.category_id) }, "See these transactions") : null))));
        sec.append(el("p", { class: "fine" }, `"Invested" assumes ${Math.round(data.assumptions.fv_rate * 100)}% a year, compounded monthly. It's an illustration, not a forecast.`));
      }
      out.push(sec);
    }

    // Month by month
    out.push(el("section", { class: "trend" },
      el("div", { class: "section-head" }, el("h2", {}, "Month by month"),
        el("ul", { class: "legend small" },
          el("li", {}, swatch("seg-essential"), "Essentials"), el("li", {}, swatch("seg-optional"), "Optional"),
          el("li", {}, swatch("seg-unsorted"), "Not sorted"), el("li", {}, swatch("sw-income"), "Came in"))),
      el("div", { class: "chart-wrap" }, monthColumns(data.months, data.month, onMonth)),
      el("p", { class: "fine" }, onMonth ? "Click a month to open it." : "")));

    // Where it went
    const cats = data.categories.filter((c) => c.amount_cents > 0 || c.previous_cents > 0);
    if (cats.length) {
      const max = Math.max(...cats.map((c) => Math.max(c.amount_cents, c.previous_cents, c.average_cents)), 1);
      const rows = (list) => list.map((c) => {
        const cls = c.necessity === "optional" ? "seg-optional" : c.necessity === "essential" ? "seg-essential" : "seg-unsorted";
        const d = c.amount_cents - c.previous_cents;
        const toggle = onNecessity && c.category_id ? el("button", { type: "button", class: "link small",
          onclick: () => onNecessity(c.category_id, c.necessity === "optional" ? "essential" : "optional") },
          c.necessity === "optional" ? "Mark essential" : "Mark optional") : null;
        return el("div", { class: "cat-row" },
          el("div", { class: "cat-name" }, onCategory && c.category_id ? el("button", { type: "button", class: "plain", onclick: () => onCategory(c.category_id) }, c.category) : c.category, toggle),
          el("div", { class: "cat-bar", onmousemove: (e) => showTip(e, [c.category, `This month ${dollars(c.amount_cents)}`, `${prevLabel} ${dollars(c.previous_cents)}`, `Usual ${dollars(c.average_cents)}`]), onmouseleave: hideTip },
            el("div", { class: `bar ${cls}`, style: { width: `${(c.amount_cents / max) * 100}%` } }),
            c.average_cents > 0 ? el("div", { class: "avg-tick", style: { left: `${(c.average_cents / max) * 100}%` }, title: "Your usual" }) : null),
          el("div", { class: "cat-amt num" }, dollars(c.amount_cents, { cents: false }),
            Math.abs(d) >= 100 ? el("span", { class: `cat-d ${(d > 0) === (c.necessity !== "optional") ? "flat" : d > 0 ? "watch" : "good"}` }, `${d > 0 ? "▲" : "▼"} ${dollars(Math.abs(d), { cents: false })}`) : null));
      });
      const opt = cats.filter((c) => c.necessity === "optional");
      const ess = cats.filter((c) => c.necessity !== "optional");
      const essRows = rows(ess);
      const SHOW = 6;
      const more = essRows.length > SHOW ? el("button", { type: "button", class: "link show-more", onclick: (e) => {
        essRows.slice(SHOW).forEach((r) => { r.hidden = false; }); e.currentTarget.remove(); } }, `Show all ${essRows.length}`) : null;
      essRows.slice(SHOW).forEach((r) => { r.hidden = true; });
      out.push(el("section", { class: "where" },
        el("div", { class: "section-head" }, el("h2", {}, "Where it went"),
          el("span", { class: "fine" }, "Bars show this month. The thin mark is your usual (6-month average); arrows compare with " + prevLabel + ".")),
        opt.length ? el("h3", { class: "cat-group" }, swatch("seg-optional"), `Optional ${dollars(s.optional, { cents: false })}`) : null,
        rows(opt),
        el("h3", { class: "cat-group" }, swatch("seg-essential"), `Essentials and not sorted ${dollars(s.essential + s.unsorted, { cents: false })}`),
        essRows, more));
    }

    // Net position
    const spark = sparkline(data.net_position);
    if (spark) {
      const last = data.net_position.filter((x) => x.net_cents !== null).slice(-1)[0];
      out.push(el("section", { class: "net" }, el("h2", {}, "Net position"),
        el("div", { class: "net-row" }, el("div", { class: "net-value" }, dollars(last.net_cents, { cents: false })), spark),
        el("p", { class: "fine" }, "Balances across linked accounts at each month end; cards and loans count as owed.")));
    }
    return out;
  }


  // --- any date range ---------------------------------------------------------------------
  const fmtDate = (iso, withYear = true) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("en-US", withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  };
  const rangeText = (a, b) => (a.slice(0, 4) === b.slice(0, 4) ? `${fmtDate(a, false)} – ${fmtDate(b)}` : `${fmtDate(a)} – ${fmtDate(b)}`);

  function renderPeriod(p, opts = {}) {
    const { onMonth, onCategory, onGroup, onGoal } = opts;
    const t = p.totals, b = p.previous;
    const prevLabel = "the period before";
    const out = [];

    const hero = el("section", { class: "hero" });
    hero.append(el("p", { class: "hero-line" },
      t.income > 0 ? [t.kept >= 0 ? "You kept " : "You spent ", el("strong", {}, dollars(Math.abs(t.kept), { cents: false })),
        t.kept >= 0 ? " of the " : " more than the ", el("strong", {}, dollars(t.income, { cents: false })), " that came in."]
        : "No income recorded in this period."));
    hero.append(el("div", { class: "hero-meta" },
      t.savings_rate !== null ? el("span", { class: "rate" }, `${pct(t.savings_rate)} kept`) : null,
      b.income > 0 ? delta(t.savings_rate || 0, b.savings_rate || 0, { goodWhenUp: true, label: prevLabel, asPoints: true }) : null,
      t.savings_rate !== null && t.savings_rate * 100 >= p.goal_pct ? el("span", { class: "delta good" }, `✓ Goal of ${p.goal_pct}% reached`) : null));
    hero.append(strip(t, { goalPct: p.goal_pct, onGoal }));
    hero.append(el("ul", { class: "legend" },
      el("li", {}, swatch("seg-essential"), "Essentials ", el("b", {}, dollars(t.essential, { cents: false }))),
      el("li", {}, swatch("seg-optional"), "Optional ", el("b", {}, dollars(t.optional, { cents: false }))),
      t.unsorted > 0 ? el("li", {}, swatch("seg-unsorted"), "Not sorted yet ", el("b", {}, dollars(t.unsorted, { cents: false }))) : null,
      t.kept >= 0 ? el("li", {}, swatch("seg-kept"), "Kept ", el("b", {}, dollars(t.kept, { cents: false })))
        : el("li", {}, swatch("seg-over"), "Over by ", el("b", {}, dollars(-t.kept, { cents: false })))));
    hero.append(el("p", { class: "fine" }, `Compared with ${rangeText(p.previous_start, p.previous_end)}.`
      + (t.moved_to_savings > 0 ? ` ${dollars(t.moved_to_savings, { cents: false })} of what you kept went into savings or investments.` : "")));
    out.push(hero);

    const tile = (label, value, d, extra) => el("div", { class: "tile" }, el("div", { class: "tile-label" }, label), el("div", { class: "tile-value" }, value), d, extra);
    const perMonth = p.days >= 56 ? el("div", { class: "tile-sub" }, `≈ ${dollars(Math.round(t.spending / (p.days / 30.44)), { cents: false })} a month`) : null;
    out.push(el("section", { class: "tiles" },
      tile("Came in", dollars(t.income, { cents: false }), delta(t.income, b.income, { goodWhenUp: true, label: prevLabel })),
      tile("Spent", dollars(t.spending, { cents: false }), delta(t.spending, b.spending, { goodWhenUp: false, label: prevLabel }), perMonth),
      tile("Optional", dollars(t.optional, { cents: false }), delta(t.optional, b.optional, { goodWhenUp: false, label: prevLabel })),
      tile("Kept", dollars(t.kept, { cents: false }), delta(t.kept, b.kept, { goodWhenUp: true, label: prevLabel }))));

    out.push(categoryPies(p.groups, p.palette, { prevLabel: "before", onCategory, onGroup, periodWord: "in this period" }));

    if (p.months.length >= 2) {
      const chart = monthColumns(p.months, null, onMonth);
      chart.classList.add("all-sel");
      out.push(el("section", { class: "trend" },
        el("div", { class: "section-head" }, el("h2", {}, "Month by month"),
          el("ul", { class: "legend small" },
            el("li", {}, swatch("seg-essential"), "Essentials"), el("li", {}, swatch("seg-optional"), "Optional"),
            el("li", {}, swatch("seg-unsorted"), "Not sorted"), el("li", {}, swatch("sw-income"), "Came in"))),
        el("div", { class: "chart-wrap" }, chart),
        el("p", { class: "fine" }, (p.months.length && (p.start.slice(8) !== "01" || p.includes_today) ? "The first or last month is only partly in this period. " : "") + (onMonth ? "Click a month to open it." : ""))));
    }
    return out;
  }

  window.LedgerDash = { render, renderPeriod, el, dollars, monthName, addMonths, hideTip, rangeText, fmtDate };
})();

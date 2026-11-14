/* Draws a clean chart from a traced spec onto a canvas. Shared by the page and the example build. */
(function (root) {
  function niceStep(span) { const r = span / 6, p = Math.pow(10, Math.floor(Math.log10(r))); const m = r / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; }
  function drawChart(spec, opts) {
    opts = opts || {};
    const S = opts.scale || 3;                         // supersampling for print quality
    const aspect = Math.max(0.3, Math.min(4, +spec.aspect || 1.5));
    const H0 = 300, W0 = Math.round(H0 * aspect);
    const c = (opts.canvas || document.createElement("canvas")); c.width = W0 * S; c.height = H0 * S;
    const g = c.getContext("2d"); g.scale(S, S);
    g.fillStyle = "#fff"; g.fillRect(0, 0, W0, H0);
    const X = spec.x || {}, Y = spec.y || {};
    const xmin = +X.min || 0, xmax = (X.max != null ? +X.max : 10), ymin = +Y.min || 0, ymax = (Y.max != null ? +Y.max : 10);
    const font = '"Arial", "Helvetica", sans-serif';
    const L = Y.label ? 40 : 28, R = 10, T = 10, B = X.label ? 34 : (X.ticks === false ? 12 : 22);
    const pw = W0 - L - R, ph = H0 - T - B;
    const px = v => L + (v - xmin) / (xmax - xmin || 1) * pw;
    const py = v => T + ph - (v - ymin) / (ymax - ymin || 1) * ph;
    const color = (s, d) => (typeof s === "string" && /^#?[0-9a-f]{3,8}$|^[a-z]+$/i.test(s) ? (s[0] === "#" || /^[a-z]+$/i.test(s) ? s : "#" + s) : d);

    // grid
    const xs = +X.step || niceStep(xmax - xmin), ys = +Y.step || niceStep(ymax - ymin);
    g.lineWidth = 0.6; g.strokeStyle = "#e4e4e4";
    if (spec.grid !== false) {
      for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + 1e-9; v += xs) { g.beginPath(); g.moveTo(px(v), T); g.lineTo(px(v), T + ph); g.stroke(); }
      for (let v = Math.ceil(ymin / ys) * ys; v <= ymax + 1e-9; v += ys) { g.beginPath(); g.moveTo(L, py(v)); g.lineTo(L + pw, py(v)); g.stroke(); }
    }
    g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
    // areas
    for (const a of spec.areas || []) {
      const pts = (a.points || []).filter(p => Array.isArray(p) && p.length >= 2); if (pts.length < 3) continue;
      g.globalAlpha = a.opacity != null ? +a.opacity : 0.35; g.fillStyle = color(a.color, "#9a9a9a");
      g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(px(p[0]), py(p[1])) : g.moveTo(px(p[0]), py(p[1]))); g.closePath(); g.fill();
      g.globalAlpha = 1;
    }
    // reference lines
    for (const h of spec.hlines || []) { g.strokeStyle = color(h.color, "#000"); g.lineWidth = +h.width || 1.2; g.beginPath(); g.moveTo(L, py(+h.y)); g.lineTo(L + pw, py(+h.y)); g.stroke(); }
    for (const v of spec.vlines || []) { g.strokeStyle = color(v.color, "#000"); g.lineWidth = +v.width || 1.2; g.beginPath(); g.moveTo(px(+v.x), T); g.lineTo(px(+v.x), T + ph); g.stroke(); }
    // series
    for (const s of spec.series || []) {
      const pts = (s.points || []).filter(p => Array.isArray(p) && p.length >= 2 && isFinite(p[0]) && isFinite(p[1])); if (pts.length < 2) continue;
      g.strokeStyle = color(s.color, "#000"); g.lineWidth = +s.width || 1.6; g.lineJoin = "round"; g.lineCap = "round";
      g.setLineDash(s.dash ? [5, 4] : []);
      g.beginPath();
      // smooth with Catmull-Rom unless "sharp"
      const P = pts.map(p => [px(+p[0]), py(+p[1])]);
      g.moveTo(P[0][0], P[0][1]);
      for (let i = 0; i < P.length - 1; i++) {
        if (s.smooth === false) { g.lineTo(P[i + 1][0], P[i + 1][1]); continue; }
        const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
        g.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
      }
      g.stroke(); g.setLineDash([]);
    }
    // markers
    for (const m of spec.markers || []) {
      g.strokeStyle = color(m.color, "#000"); g.lineWidth = 1.6; g.beginPath();
      if (m.shape === "square") g.rect(px(+m.x) - 4, py(+m.y) - 4, 8, 8); else g.arc(px(+m.x), py(+m.y), 4.2, 0, Math.PI * 2);
      if (m.fill) { g.fillStyle = g.strokeStyle; g.fill(); } g.stroke();
    }
    g.restore();
    // frame & ticks
    g.strokeStyle = "#8a8a8a"; g.lineWidth = 1; g.strokeRect(L + .5, T + .5, pw - 1, ph - 1);
    g.fillStyle = "#555"; g.font = `9.5px ${font}`; g.textAlign = "right"; g.textBaseline = "middle";
    const fmt = v => (Math.abs(v) < 1e-9 ? "0" : String(+v.toFixed(4)));
    if (Y.ticks !== false) for (let v = Math.ceil(ymin / ys) * ys; v <= ymax + 1e-9; v += ys) g.fillText(fmt(v), L - 4, py(v));
    g.textAlign = "center"; g.textBaseline = "top";
    if (X.ticks !== false) for (let v = Math.ceil(xmin / xs) * xs; v <= xmax + 1e-9; v += xs) g.fillText(fmt(v), px(v), T + ph + 4);
    g.font = `10px ${font}`; g.fillStyle = "#333";
    if (X.label) { g.textBaseline = "bottom"; g.fillText(X.label, L + pw / 2, H0 - 2); }
    if (Y.label) { g.save(); g.translate(11, T + ph / 2); g.rotate(-Math.PI / 2); g.textBaseline = "middle"; g.fillText(Y.label, 0, 0); g.restore(); }
    if (spec.corner) { g.font = `bold 9.5px ${font}`; g.textAlign = "right"; g.textBaseline = "top"; g.fillStyle = "#555"; g.fillText(spec.corner, L + pw - 6, T + 5);
      const w = g.measureText(spec.corner).width; g.fillRect(L + pw - 6 - w, T + 16, w, 0.8); }
    // legend
    let lx = L + 10; const ly = (spec.legendPos === "top" ? T + 14 : T + ph - 12);
    if (spec.legendPos === "right") lx = L + pw - 10 - (spec.legend || []).reduce((a, it) => a + g.measureText(it.text || "").width + 30, 0);
    g.font = `9.5px ${font}`; g.textAlign = "left"; g.textBaseline = "middle";
    for (const it of spec.legend || []) {
      g.strokeStyle = color(it.color, "#000"); g.lineWidth = 1.5;
      if (it.shape === "circle") { g.beginPath(); g.arc(lx + 5, ly, 4, 0, Math.PI * 2); g.stroke(); lx += 13; }
      else if (it.shape === "area") { g.globalAlpha = .35; g.fillStyle = color(it.color, "#9a9a9a"); g.fillRect(lx, ly - 5, 14, 10); g.globalAlpha = 1; lx += 18; }
      else { g.beginPath(); g.moveTo(lx, ly); g.lineTo(lx + 16, ly); g.stroke(); lx += 20; }
      g.fillStyle = "#222"; g.fillText(it.text || "", lx, ly); lx += g.measureText(it.text || "").width + 14;
    }
    return c;
  }
  root.drawChart = drawChart;
})(typeof window !== "undefined" ? window : globalThis);

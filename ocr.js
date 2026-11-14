/* Free in-browser recognition: Tesseract (ukr+rus+eng) + own page analysis.
   Turns a page picture into the same block list the rest of the app uses:
   paragraphs with bbox / lines / font / bold, and tables with merged cells. */
(function (root) {
  const OCR = {};
  const here = () => new URL(".", location.href).href;
  let workerP = null, scriptP = null;

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("не удалось загрузить " + src)); document.head.append(s); });
  }
  OCR.worker = async function (onProgress) {
    if (!scriptP) scriptP = window.Tesseract ? Promise.resolve() : loadScript(here() + "tess/tesseract.min.js");
    await scriptP;
    if (!workerP) workerP = (async () => {
      const w = await window.Tesseract.createWorker(["ukr", "rus", "eng"], 1, {
        workerPath: here() + "tess/worker.min.js", corePath: here() + "tess/core", langPath: here() + "tess/lang", gzip: true,
        logger: m => { if (OCR._onProgress) OCR._onProgress(m); } });
      await w.setParameters({ preserve_interword_spaces: "1" });
      return w;
    })().catch(e => { workerP = null; throw e; });
    OCR._onProgress = onProgress;
    return workerP;
  };

  /* ---------- helpers ---------- */
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function inkMap(canvas) {
    // adaptive binarisation: ink = clearly darker than the local mean (31 px window)
    const W = canvas.width, H = canvas.height, d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
    const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) g[i] = .299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2];
    const IW = W + 1, I = new Float64Array(IW * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += g[y * W + x]; I[(y + 1) * IW + x + 1] = I[y * IW + x + 1] + row; } }
    const R = 15, ink = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const ya = Math.max(0, y - R), yb = Math.min(H - 1, y + R);
      for (let x = 0; x < W; x++) { const xa = Math.max(0, x - R), xb = Math.min(W - 1, x + R);
        const n = (yb - ya + 1) * (xb - xa + 1), s = I[(yb + 1) * IW + xb + 1] - I[ya * IW + xb + 1] - I[(yb + 1) * IW + xa] + I[ya * IW + xa];
        const v = g[y * W + x]; if (v < s / n - 22 && v < 190) ink[y * W + x] = 1; } }
    return { W, H, ink, gray: g };
  }
  // stroke thickness relative to letter height: mean length of horizontal and vertical ink runs
  function stroke(M, b, norm) {
    const ink = M.ink2 || M.ink;
    const x0 = Math.max(0, b.x0 | 0), x1 = Math.min(M.W, b.x1 | 0), y0 = Math.max(0, b.y0 | 0), y1 = Math.min(M.H, b.y1 | 0);
    let runs = 0, len = 0;
    for (let y = y0; y < y1; y++) { let r = 0; for (let x = x0; x <= x1; x++) { const on = x < x1 && ink[y * M.W + x]; if (on) r++; else if (r) { if (r < (y1 - y0)) { runs++; len += r; } r = 0; } } }
    for (let x = x0; x < x1; x++) { let r = 0; for (let y = y0; y <= y1; y++) { const on = y < y1 && ink[y * M.W + x]; if (on) r++; else if (r) { if (r < (y1 - y0) * 0.3) { runs++; len += r; } r = 0; } } }
    return runs ? len / runs / Math.max(1, norm || (y1 - y0)) : 0;
  }
  function density(M, b) {
    const x0 = Math.max(0, b.x0 | 0), x1 = Math.min(M.W, b.x1 | 0), y0 = Math.max(0, b.y0 | 0), y1 = Math.min(M.H, b.y1 | 0);
    let c = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { n++; c += M.ink[y * M.W + x]; }
    return n ? c / n : 0;
  }

  /* ---------- ruling lines and tables ---------- */
  function findLines(M) {
    const { W, H, ink } = M, hl = [], vl = [];
    const minH = Math.max(40, W * 0.05), minV = Math.max(30, H * 0.025);
    for (let y = 0; y < H; y++) { let s = -1, gap = 0;
      for (let x = 0; x <= W; x++) { const on = x < W && ink[y * W + x];
        if (on) { if (s < 0) s = x; gap = 0; } else if (s >= 0) { if (++gap > 2 || x === W) { const e = x - gap; if (e - s >= minH) hl.push({ y, x0: s, x1: e }); s = -1; gap = 0; } } } }
    for (let x = 0; x < W; x++) { let s = -1, gap = 0;
      for (let y = 0; y <= H; y++) { const on = y < H && ink[y * W + x];
        if (on) { if (s < 0) s = y; gap = 0; } else if (s >= 0) { if (++gap > 2 || y === H) { const e = y - gap; if (e - s >= minV) vl.push({ x, y0: s, y1: e }); s = -1; gap = 0; } } } }
    // merge runs on neighbouring rows / columns into lines
    const merge = (runs, a, lo, hi) => { runs.sort((p, q) => p[a] - q[a]); const out = [];
      for (const r of runs) { const m = out.find(o => r[a] - o.last <= 2 && r[lo] < o[hi] && r[hi] > o[lo]);
        if (m) { m.last = r[a]; m[lo] = Math.min(m[lo], r[lo]); m[hi] = Math.max(m[hi], r[hi]); m.sum += r[a]; m.n++; }
        else out.push({ [lo]: r[lo], [hi]: r[hi], last: r[a], first: r[a], sum: r[a], n: 1 }); }
      return out.map(o => ({ [a]: o.sum / o.n, [lo]: o[lo], [hi]: o[hi], t: o.last - o.first + 1 })); };
    const H2 = merge(hl, "y", "x0", "x1").filter(l => l.t <= Math.max(8, H * 0.005));
    const V2 = merge(vl, "x", "y0", "y1").filter(l => l.t <= Math.max(8, W * 0.005));
    return { h: H2, v: V2 };
  }
  function findTables(M, lines) {
    const { h, v } = lines, tol = 6;
    const n = h.length + v.length, par = [...Array(n).keys()], f = i => par[i] === i ? i : (par[i] = f(par[i]));
    for (let i = 0; i < h.length; i++) for (let j = 0; j < v.length; j++) {
      const a = h[i], b = v[j];
      if (b.x >= a.x0 - tol && b.x <= a.x1 + tol && a.y >= b.y0 - tol && a.y <= b.y1 + tol) par[f(i)] = f(h.length + j);
    }
    const groups = {};
    for (let i = 0; i < n; i++) (groups[f(i)] = groups[f(i)] || []).push(i);
    const tables = [];
    for (const g of Object.values(groups)) {
      const hs = g.filter(i => i < h.length).map(i => h[i]), vs = g.filter(i => i >= h.length).map(i => v[i - h.length]);
      if (hs.length < 2 || vs.length < 2) continue;
      const box = { x0: Math.min(...hs.map(l => l.x0), ...vs.map(l => l.x)), x1: Math.max(...hs.map(l => l.x1), ...vs.map(l => l.x)),
                    y0: Math.min(...vs.map(l => l.y0), ...hs.map(l => l.y)), y1: Math.max(...vs.map(l => l.y1), ...hs.map(l => l.y)) };
      if (box.x1 - box.x0 < M.W * 0.12 || box.y1 - box.y0 < M.H * 0.02) continue;
      const cl = (vals, eps) => { vals.sort((p, q) => p - q); const o = []; for (const x of vals) { if (o.length && x - o[o.length - 1].v <= eps) { const c = o[o.length - 1]; c.s += x; c.n++; c.v = c.s / c.n; } else o.push({ v: x, s: x, n: 1 }); } return o.map(c => c.v); };
      const ys = cl(hs.map(l => l.y).concat([box.y0, box.y1]), 7), xs = cl(vs.map(l => l.x).concat([box.x0, box.x1]), 7);
      if (ys.length < 2 || xs.length < 2) continue;
      tables.push({ box, ys, xs });
    }
    return tables;
  }
  // is there a drawn border between two cells?
  function borderV(M, x, ya, yb) { let hit = 0, tot = 0; for (let y = Math.round(ya) + 3; y < yb - 3; y++) { tot++; for (let dx = -3; dx <= 3; dx++) { const xx = Math.round(x) + dx; if (xx >= 0 && xx < M.W && M.ink[y * M.W + xx]) { hit++; break; } } } return tot ? hit / tot : 1; }
  function borderH(M, y, xa, xb) { let hit = 0, tot = 0; for (let x = Math.round(xa) + 3; x < xb - 3; x++) { tot++; for (let dy = -3; dy <= 3; dy++) { const yy = Math.round(y) + dy; if (yy >= 0 && yy < M.H && M.ink[yy * M.W + x]) { hit++; break; } } } return tot ? hit / tot : 1; }

  function wordsToText(ws) {
    // words -> lines (by vertical overlap) -> text with \n
    ws = ws.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
    const lines = [];
    for (const w of ws) { const cy = (w.y0 + w.y1) / 2; const L = lines.find(l => cy > l.y0 && cy < l.y1); if (L) { L.ws.push(w); L.y0 = Math.min(L.y0, w.y0); L.y1 = Math.max(L.y1, w.y1); } else lines.push({ y0: w.y0, y1: w.y1, ws: [w] }); }
    lines.sort((a, b) => a.y0 - b.y0);
    return lines.map(l => joinWords(l.ws.sort((a, b) => a.x0 - b.x0))).join("\n");
  }
  function joinWords(ws) {
    if (!ws.length) return "";
    const h = median(ws.map(w => w.y1 - w.y0)) || 10;
    let out = "", bold = false;
    ws.forEach((w, i) => {
      if (i) { const gap = ws[i].x0 - ws[i - 1].x1; const n = gap > 0.9 * h ? Math.min(14, Math.max(2, Math.round(gap / (0.3 * h)))) : 1; out += " ".repeat(n); }
      let t = w.text;
      if (w.low) t = "{{?" + t + "}}";
      out += (w.bold && !ws._allBold) ? "**" + t + "**" : t;
    });
    return out.replace(/\*\*( +)\*\*/g, "$1");   // join neighbouring bold words
  }

  /* ---------- serif or sans: compare the printed line with both fonts rendered ---------- */
  const tcv = document.createElement("canvas"), tctx = tcv.getContext("2d");
  function fontScore(M, seg, text, family, bold) {
    const w = seg.x1 - seg.x0, h = seg.y1 - seg.y0; if (w < 20 || h < 6 || !text.trim()) return 0;
    const TH = 28, TW = Math.max(8, Math.min(900, Math.round(w * TH / h)));
    const A = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) { const sx = Math.min(M.W - 1, Math.round(seg.x0 + x * w / TW)), sy = Math.min(M.H - 1, Math.round(seg.y0 + y * h / TH)); A[y * TW + x] = M.ink[sy * M.W + sx]; }
    tcv.width = Math.ceil(TW * 3); tcv.height = 140; tctx.fillStyle = "#fff"; tctx.fillRect(0, 0, tcv.width, tcv.height);
    tctx.fillStyle = "#000"; tctx.font = (bold ? "bold " : "") + "80px " + family; tctx.textBaseline = "alphabetic";
    tctx.fillText(text, 4, 100);
    const d = tctx.getImageData(0, 0, tcv.width, tcv.height).data;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let y = 0; y < tcv.height; y++) for (let x = 0; x < tcv.width; x++) if (d[(y * tcv.width + x) * 4] < 128) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    if (bx1 < 0) return 0;
    let inter = 0, uni = 0;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const sx = Math.round(bx0 + x * (bx1 - bx0 + 1) / TW), sy = Math.round(by0 + y * (by1 - by0 + 1) / TH);
      const b = sx < tcv.width && sy < tcv.height && d[(sy * tcv.width + sx) * 4] < 128 ? 1 : 0, a = A[y * TW + x];
      if (a && b) inter++; if (a || b) uni++; }
    return uni ? inter / uni : 0;
  }

  /* photo preparation: enough resolution for small print + even lighting (for recognition only) */
  function upscale(canvas) {
    const k = canvas.width < 2000 ? Math.min(2.5, 2400 / canvas.width) : 1;
    if (k <= 1.05) return canvas;
    const c = document.createElement("canvas"); c.width = Math.round(canvas.width * k); c.height = Math.round(canvas.height * k);
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(canvas, 0, 0, c.width, c.height); return c;
  }
  function flatten(canvas) {
    // divide by a blurred estimate of the paper brightness -> white paper, dark text, no shadows
    const W = canvas.width, H = canvas.height, k = 1 / 16;
    const s = document.createElement("canvas"); s.width = Math.max(4, Math.round(W * k)); s.height = Math.max(4, Math.round(H * k));
    const sg = s.getContext("2d"); sg.drawImage(canvas, 0, 0, s.width, s.height);
    const sd = sg.getImageData(0, 0, s.width, s.height); const L = new Float32Array(s.width * s.height);
    for (let i = 0; i < L.length; i++) L[i] = .299 * sd.data[i * 4] + .587 * sd.data[i * 4 + 1] + .114 * sd.data[i * 4 + 2];
    const R = 3, bgc = new Float32Array(L.length);     // local max ~ paper level
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) { let m = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < s.height && xx >= 0 && xx < s.width && L[yy * s.width + xx] > m) m = L[yy * s.width + xx]; }
      bgc[y * s.width + x] = Math.max(40, m); }
    const out = document.createElement("canvas"); out.width = W; out.height = H; const og = out.getContext("2d"); og.drawImage(canvas, 0, 0);
    const im = og.getImageData(0, 0, W, H), d = im.data;
    for (let y = 0; y < H; y++) { const fy = Math.min(s.height - 1, Math.max(0, y * k - .5)); const y0 = Math.floor(fy), y1 = Math.min(s.height - 1, y0 + 1), ay = fy - y0;
      for (let x = 0; x < W; x++) { const fx = Math.min(s.width - 1, Math.max(0, x * k - .5)); const x0 = Math.floor(fx), x1 = Math.min(s.width - 1, x0 + 1), ax = fx - x0;
        const b = (bgc[y0 * s.width + x0] * (1 - ax) + bgc[y0 * s.width + x1] * ax) * (1 - ay) + (bgc[y1 * s.width + x0] * (1 - ax) + bgc[y1 * s.width + x1] * ax) * ay;
        const i = (y * W + x) * 4; const v = (.299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]) / b * 255;
        const o = v >= 235 ? 255 : Math.max(0, Math.pow(v / 235, 1.5) * 235); d[i] = d[i + 1] = d[i + 2] = o; } }
    og.putImageData(im, 0, 0); return out;
  }

  /* ---------- main ---------- */
  OCR.page = async function (canvas0, onProgress) {
    const w = await OCR.worker(onProgress);
    const canvas = upscale(canvas0);
    const prep = flatten(canvas);
    const { data } = await w.recognize(prep, { rotateAuto: true }, { blocks: true, imageColor: false, imageGrey: false, rotateRadians: true });
    let work = canvas;
    if (data.rotateRadians && Math.abs(data.rotateRadians) > 0.002) {
      // Tesseract reports word boxes in its rotated frame: rotate the colour picture the same way (around the centre, same size)
      work = document.createElement("canvas"); work.width = canvas.width; work.height = canvas.height;
      const g = work.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, work.width, work.height);
      g.translate(work.width / 2, work.height / 2); g.rotate(data.rotateRadians); g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    }
    const W = work.width, H = work.height;
    const M = inkMap(work);
    // all words
    const words = [];
    for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
      const t = (wd.text || "").trim(); if (!t) continue;
      const bb = wd.bbox; if (bb.x1 - bb.x0 < 2 || bb.y1 - bb.y0 < 4) continue;
      // drop garbage: tiny low-confidence specks
      words.push({ text: t, x0: bb.x0, y0: bb.y0, x1: bb.x1, y1: bb.y1, conf: wd.confidence, line: l });
    }
    // words printed in colour (logo lettering) stay in the picture layer
    { const cd = work.getContext("2d").getImageData(0, 0, work.width, work.height).data, WW = work.width;
      for (const wd of words) {
        // colour of the letters themselves = mean of the darkest quarter of the pixels (background tint does not count)
        const px = [];
        for (let y = wd.y0 | 0; y < wd.y1; y += 2) for (let x = wd.x0 | 0; x < wd.x1; x += 2) { const i = (y * WW + x) * 4; px.push([cd[i] + cd[i + 1] + cd[i + 2], cd[i], cd[i + 1], cd[i + 2]]); }
        px.sort((p, q) => p[0] - q[0]); const k = Math.max(3, Math.floor(px.length * 0.25)); let r = 0, g2 = 0, b2 = 0;
        for (let i = 0; i < k && i < px.length; i++) { r += px[i][1]; g2 += px[i][2]; b2 += px[i][3]; }
        r /= k; g2 /= k; b2 /= k; const mx = Math.max(r, g2, b2), mn = Math.min(r, g2, b2);
        wd.sat = mx > 0 ? (mx - mn) / mx : 0; wd.colour = px.length > 8 && mx > 40 && wd.sat > 0.155; } }
    OCR._dbg = words.map(q => [q.text, +q.sat.toFixed(2), Math.round(q.conf), Math.round(q.x0), Math.round(q.y0), q.colour]);
    // garbage: very unsure words, and lines that are mostly unsure / symbol noise (from drawings, logos, stains)
    const lineWords = new Map(); for (const wd of words) { if (!lineWords.has(wd.line)) lineWords.set(wd.line, []); lineWords.get(wd.line).push(wd); }
    const keep = new Set();
    for (const ws of lineWords.values()) {
      const vis = ws.filter(q => !q.colour);
      const lettersV = vis.map(q => q.text.replace(/[^\p{L}\d]/gu, "")).join("");
      const meanV = vis.reduce((s2, q) => s2 + q.conf * q.text.length, 0) / Math.max(1, vis.reduce((s2, q) => s2 + q.text.length, 0));
      // judge every word: real words survive even when the rest of the "line" is noise from a drawing
      const good = vis.filter(q => { const L = q.text.replace(/[^\p{L}\d]/gu, "").length;
        if (!L && meanV >= 60 && q.conf >= 50 && q.text.length <= 3) { q.low = true; q.forceLow = true; return true; }
        return (q.conf >= 30 && L >= 1) || (q.conf >= 20 && L >= 3) || (meanV >= 60 && q.conf >= 10 && L >= 1); });
      if (good.map(q => q.text.replace(/[^\p{L}\d]/gu, "")).join("").length < 2) continue;
      for (const q of good) keep.add(q);
    }
    for (let i = words.length - 1; i >= 0; i--) if (!keep.has(words[i])) words.splice(i, 1);

    // bold: ink density compared with the page median
    // global (Otsu) ink map for stroke width: the adaptive one thins strokes inside dense bold text
    { const hist = new Float64Array(256); for (let i = 0; i < M.gray.length; i++) hist[Math.min(255, M.gray[i] | 0)]++;
      const tot = M.gray.length; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
      let sB = 0, wB = 0, best = 0, thr = 128; for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += t * hist[t];
        const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2; if (v > best) { best = v; thr = t; } }
      M.ink2 = new Uint8Array(tot); for (let i = 0; i < tot; i++) M.ink2[i] = M.gray[i] < thr ? 1 : 0; }
    const lineH = new Map();
    for (const wd of words) { if (!lineH.has(wd.line)) lineH.set(wd.line, []); lineH.get(wd.line).push(wd.y1 - wd.y0); }
    for (const [k, v] of lineH) lineH.set(k, median(v));
    for (const wd of words) wd.sw = stroke(M, wd, lineH.get(wd.line));
    const medS = median(words.filter(x => x.text.length > 3).map(x => x.sw)) || 0.1;
    for (const wd of words) wd.low = wd.forceLow || (wd.conf < 55 && /[\p{L}\d]/u.test(wd.text));
    // bold = clearly thicker strokes; decide per line run so single short words do not flicker
    const medLH = median([...lineH.values()]) || 1;
    for (const wd of words) { const big = (lineH.get(wd.line) || 0) > medLH * 1.25;   // headings: larger letters, somewhat thicker strokes
      wd.bold = wd.text.replace(/[^\p{L}\d]/gu, "").length >= 2 && (wd.sw > medS * 1.32 || (big && wd.sw > medS * 1.12)); }

    // tables
    const tables = findTables(M, findLines(M));
    const blocks = [], used = new Set();
    for (const T of tables) {
      const { ys, xs, box } = T, R = ys.length - 1, C = xs.length - 1;
      const par = [...Array(R * C).keys()], f = i => par[i] === i ? i : (par[i] = f(par[i]));
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
        if (c + 1 < C && borderV(M, xs[c + 1], ys[r], ys[r + 1]) < 0.55) par[f(r * C + c)] = f(r * C + c + 1);
        if (r + 1 < R && borderH(M, ys[r + 1], xs[c], xs[c + 1]) < 0.55) par[f(r * C + c)] = f((r + 1) * C + c);
      }
      const reg = {};
      for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) { const k = f(r * C + c); const g = reg[k] || (reg[k] = { r0: r, r1: r, c0: c, c1: c, ws: [] }); g.r0 = Math.min(g.r0, r); g.r1 = Math.max(g.r1, r); g.c0 = Math.min(g.c0, c); g.c1 = Math.max(g.c1, c); }
      const regs = Object.values(reg);
      const cellOf = (x, y) => { let c = -1, r = -1; for (let i = 0; i < C; i++) if (x >= xs[i] && x < xs[i + 1]) c = i; for (let i = 0; i < R; i++) if (y >= ys[i] && y < ys[i + 1]) r = i; return r < 0 || c < 0 ? null : regs.find(g => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1); };
      words.forEach((wd, i) => { const cx = (wd.x0 + wd.x1) / 2, cy = (wd.y0 + wd.y1) / 2; if (cx < box.x0 || cx > box.x1 || cy < box.y0 || cy > box.y1) return; const g = cellOf(cx, cy); if (g) { g.ws.push(wd); used.add(i); } });
      const covered = new Set(); const rows = [];
      for (let r = 0; r < R; r++) { const row = [];
        for (let c = 0; c < C; c++) { if (covered.has(r * C + c)) continue;
          const g = regs.find(q => q.r0 === r && q.c0 === c); if (!g) continue;
          for (let rr = g.r0; rr <= g.r1; rr++) for (let cc = g.c0; cc <= g.c1; cc++) covered.add(rr * C + cc);
          const cell = { text: wordsToText(g.ws) };
          if (g.c1 > g.c0) cell.colspan = g.c1 - g.c0 + 1; if (g.r1 > g.r0) cell.rowspan = g.r1 - g.r0 + 1;
          if (g.ws.length) { const cx = g.ws.reduce((s, q) => s + (q.x0 + q.x1) / 2, 0) / g.ws.length, mid = (xs[g.c0] + xs[g.c1 + 1]) / 2, half = (xs[g.c1 + 1] - xs[g.c0]) / 2;
            const lx = Math.min(...g.ws.map(q => q.x0)) - xs[g.c0], rx = xs[g.c1 + 1] - Math.max(...g.ws.map(q => q.x1));
            if (Math.abs(cx - mid) < half * 0.12 && lx > 8 && rx > 8) cell.align = "center"; else if (rx < lx * 0.5 && lx > half * 0.6) cell.align = "right"; }
          row.push(cell); }
        rows.push(row); }
      const tw = words.filter((_, i) => used.has(i));
      const hh = median(tw.map(q => q.y1 - q.y0)) || (ys[1] - ys[0]) * 0.5;
      blocks.push({ type: "table", borders: "all", header: 0, rows, widths: xs.slice(1).map((x, i) => x - xs[i]),
        bbox: [box.x0 / W, box.y0 / H, box.x1 / W, box.y1 / H], size: Math.max(6, Math.min(14, Math.round(hh / 0.95 * 841.89 / H * 2) / 2)), font: "serif" });
    }

    // free text: split each Tesseract line at wide gaps into segments
    const segs = [];
    const byLine = new Map();
    words.forEach((wd, i) => { if (used.has(i)) return; if (!byLine.has(wd.line)) byLine.set(wd.line, []); byLine.get(wd.line).push(wd); });
    for (const ws of byLine.values()) {
      ws.sort((a, b) => a.x0 - b.x0);
      const h = median(ws.map(q => q.y1 - q.y0)) || 10;
      let cur = [ws[0]];
      const flush = () => { if (!cur.length) return; segs.push({ ws: cur, x0: Math.min(...cur.map(q => q.x0)), x1: Math.max(...cur.map(q => q.x1)), y0: Math.min(...cur.map(q => q.y0)), y1: Math.max(...cur.map(q => q.y1)), h: median(cur.map(q => q.y1 - q.y0)) }); cur = []; };
      for (let i = 1; i < ws.length; i++) { if (ws[i].x0 - ws[i - 1].x1 > Math.max(2.2 * h, W * 0.06)) flush(); cur.push(ws[i]); }
      flush();
    }
    // glue pieces of one printed line that Tesseract returned as separate lines (watermarks, columns detection)
    for (let changed = true; changed;) { changed = false;
      segs.sort((p, q) => p.x0 - q.x0);
      outer: for (let i = 0; i < segs.length; i++) for (let j = 0; j < segs.length; j++) { if (i === j) continue;
        const A = segs[i], B = segs[j]; const h = Math.max(A.h, B.h);
        const ov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0); if (ov < 0.6 * Math.min(A.y1 - A.y0, B.y1 - B.y0)) continue;
        const gap = B.x0 - A.x1; if (gap < -0.3 * h || gap > Math.max(2.2 * h, W * 0.06)) continue;
        const ws = A.ws.concat(B.ws).sort((p, q) => p.x0 - q.x0);
        segs[i] = { ws, x0: Math.min(A.x0, B.x0), x1: Math.max(A.x1, B.x1), y0: Math.min(A.y0, B.y0), y1: Math.max(A.y1, B.y1), h: median(ws.map(q => q.y1 - q.y0)) };
        segs.splice(j, 1); changed = true; break outer; } }
    // stack segments into blocks (same column, normal line spacing)
    segs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const groups = [];
    for (const s of segs) {
      let best = null;
      for (const g of groups) { const L = g[g.length - 1];
        const gap = s.y0 - L.y1, hh = Math.max(s.h, L.h);
        if (gap > 1.1 * hh || gap < -0.5 * hh) continue;
        if (Math.max(s.h, L.h) / Math.min(s.h, L.h) > 1.35) continue;
        const left = Math.abs(s.x0 - L.x0) < 1.5 * hh, center = Math.abs((s.x0 + s.x1) / 2 - (L.x0 + L.x1) / 2) < 1.5 * hh && Math.abs(s.x0 - L.x0) > 1.5 * hh;
        const overlap = Math.min(s.x1, L.x1) - Math.max(s.x0, L.x0) > 0;
        if ((left || center) && overlap) { best = g; break; } }
      if (best) best.push(s); else groups.push([s]);
    }
    // font family vote
    let votes = 0;
    const fam = { serif: '"Times New Roman","Liberation Serif",Times,serif', sans: 'Arial,"Liberation Sans",Helvetica,sans-serif' };
    const famOf = [];
    for (const g of groups) {
      const s = g.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
      const txt = s.ws.map(q => q.text).join(" "); const bold = s.ws.every(q => q.bold);
      const sv = fontScore(M, s, txt, fam.serif, bold), sa = fontScore(M, s, txt, fam.sans, bold);
      famOf.push(sv - sa); votes += (sv - sa) * Math.min(60, txt.length);
    }
    const pageFont = votes >= 0 ? "serif" : "sans";
    groups.forEach((g, k) => {
      // smooth bold over a printed line: most of it bold -> the whole line is bold
      for (const s of g) { const tot = s.ws.reduce((a, q) => a + q.text.length, 0), b = s.ws.filter(q => q.bold).reduce((a, q) => a + q.text.length, 0);
        if (tot && b / tot >= 0.6) s.ws.forEach(q => { q.bold = true; }); }
      const allBold = g.every(s => s.ws.every(q => q.bold));
      const lines = g.map(s => { s.ws._allBold = allBold; return joinWords(s.ws); });
      const d = famOf[k];
      const font = Math.abs(d) > 0.14 ? (d > 0 ? "serif" : "sans") : pageFont;
      const lh = g.length > 1 ? (g[g.length - 1].y0 - g[0].y0) / (g.length - 1) : null;
      // alignment
      const xs0 = g.map(s => s.x0), xs1 = g.map(s => s.x1);
      let align = "left";
      if (g.length > 1 && Math.max(...xs0) - Math.min(...xs0) > g[0].h * 1.5 && Math.max(...xs1) - Math.min(...xs1) < g[0].h * 1.5) align = "right";
      else if (g.length === 1 && g[0].x0 > W * 0.25 && W - g[0].x1 < W * 0.25 && Math.abs((g[0].x0 + g[0].x1) / 2 - W / 2) < W * 0.04) align = "center";
      blocks.push({ type: "paragraph", text: lines.join("\n"), lines: g.length, font, bold: allBold, align,
        bbox: [Math.min(...xs0) / W, g[0].y0 / H, Math.max(...xs1) / W, g[g.length - 1].y1 / H], _ocr: true,
        _pitchF: lh ? lh / H : null, _lineWF: g.map(s => (s.x1 - s.x0) / W), _lastFill: (g[g.length - 1].x1 - g[g.length - 1].x0) / Math.max(1, Math.max(...xs1) - Math.min(...xs0)),
        _hF: median(g.map(s => s.h)) / H });
    });
    blocks.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    const lowCount = words.filter(x => x.low).length;
    const meanConf = words.length ? words.reduce((a, q) => a + q.conf, 0) / words.length : 0;
    return { canvas: work, blocks, rotated: work !== canvas0, words: words.length, lowCount, pageFont, meanConf, poor: words.length < 15 || meanConf < 70 || lowCount > words.length * 0.2 };
  };

  root.OCR = OCR;
})(window);

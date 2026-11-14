/* Shared .docx builder: turns a simple block list into a Word document.
   Works in the browser (window.docx) and in Node (require('docx')).
   doc.layout = true: exact page layout. Blocks carry box:[x0,y0,x1,y1] (fractions of the page),
   "pagebg" blocks put a full-page background picture behind the text. */
(function (root) {
  function buildDocx(D, doc) {
    const PAGE_W = 11906, PAGE_H = 16838, LAYOUT = !!doc.layout;
    const MARGIN = LAYOUT ? 0 : (doc.margin || 850);
    const TEXT_W = PAGE_W - 2 * MARGIN;            // DXA
    const TEXT_PX = Math.round(TEXT_W / 1440 * 96); // px at 96 dpi
    const FONT = doc.font || "Arial";
    const BASE = doc.size || 10;                    // pt
    const FONTS = { serif: "Times New Roman", sans: "Arial", mono: "Courier New" };

    const AL = { left: D.AlignmentType.LEFT, center: D.AlignmentType.CENTER,
                 right: D.AlignmentType.RIGHT, justify: D.AlignmentType.JUSTIFIED };
    const al = a => AL[a] || undefined;

    // "**bold**, *italic*, ^^handwritten^^" -> runs
    function parseInline(text) {
      const res = []; const re = /(\^\^[^^]+\^\^|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g; let last = 0, m;
      text = String(text ?? "").replace(/\{\{\?([^}]*)\}\}/g, "$1");
      while ((m = re.exec(text))) {
        if (m.index > last) res.push({ text: text.slice(last, m.index) });
        const s = m[0];
        if (s.startsWith("^^")) res.push({ text: s.slice(2, -2), hand: true });
        else if (s.startsWith("**")) res.push({ text: s.slice(2, -2), bold: true });
        else res.push({ text: s.slice(1, -1), italic: true });
        last = m.index + s.length;
      }
      if (last < text.length) res.push({ text: text.slice(last) });
      return res;
    }

    function runs(src, extra) {
      const list = Array.isArray(src) ? src : parseInline(src);
      return list.flatMap(r => String(r.text ?? "").split("\n").map((piece, k) => ({ ...r, text: piece, _br: k > 0 }))).map(r => {
        const hand = !!(r.hand || extra?.hand);
        return new D.TextRun({
          break: r._br ? 1 : undefined,
          text: String(r.text ?? ""), bold: !!(r.bold || extra?.bold), italics: !!(r.italic || extra?.italic || hand),
          underline: (r.underline || extra?.underline) ? {} : undefined,
          size: Math.round(2 * (r.size || extra?.size || BASE)), font: r.font || extra?.font || FONT,
          color: hand ? "1F3A93" : (String(r.color || extra?.color || "").replace("#", "") || undefined),
        });
      });
    }

    function imageRun(img, maxPx, wpxForce) {
      const wpx = wpxForce || Math.max(10, Math.round((img.w || 50) / 100 * TEXT_PX));
      const w = Math.min(wpx, maxPx || 2000);
      const h = Math.round(w * img.px.h / img.px.w);
      return new D.ImageRun({ type: img.kind || "png", data: img.data, transformation: { width: w, height: h } });
    }

    // exact layout: absolute position of a block (frame) from its box (fractions of the page)
    const ASC = { serif: [0.891, 0.216, 0.662], sans: [0.905, 0.212, 0.716], mono: [0.833, 0.300, 0.571] };
    function lay(b) {
      const [x0, y0, x1, y1] = b.box.map(Number); const lines = Math.max(1, +b.lines || 1);
      let fs = +b.fs, lhPt = +b.lh;
      if (!(fs > 3 && lhPt > 3)) { lhPt = (y1 - y0) * 841.89 / Math.max(0.85, lines - 0.15); fs = lhPt / 1.15; }
      const m = ASC[b.font] || ASC.serif;
      const offPt = Math.max(0, (lhPt - (m[0] + m[1]) * fs) / 2 + (m[0] - m[2]) * fs);   // line-box top above the ink top
      const slack = b.br ? 0.08 : 0.03;
      return { x0, y0, x1, y1, lines,
        lh: Math.round(lhPt * 20), fs: Math.max(4, Math.round(fs * 2) / 2),
        x: Math.max(0, Math.round(x0 * PAGE_W)), y: Math.max(0, Math.round(y0 * PAGE_H - offPt * 20)),
        w: Math.round(Math.min(1 - x0, x1 - x0 + slack) * PAGE_W), h: Math.round(lines * lhPt * 20),
        font: FONTS[b.font] || FONTS.serif };
    }
    const frameOf = L => ({ type: "absolute", position: { x: L.x, y: L.y }, width: L.w, height: L.h,
      anchor: { horizontal: D.FrameAnchorType.PAGE, vertical: D.FrameAnchorType.PAGE } });

    function para(b, L) {
      const extra = { size: L ? L.fs : b.size, bold: b.bold, italic: b.italic, color: b.color, font: L ? L.font : (FONTS[b.font] || undefined) };
      const children = runs(b.runs || b.text || "", extra);
      if (L) return new D.Paragraph({ alignment: al(b.align), children, frame: frameOf(L),
        spacing: { before: 0, after: 0, line: L.lh, lineRule: D.LineRuleType.EXACT } });
      return new D.Paragraph({ alignment: al(b.align), children,
        spacing: { before: b.before ?? 0, after: b.after ?? 80 }, keepNext: !!b.keepNext });
    }
    function spacer(gapTw) {
      return new D.Paragraph({ spacing: { before: 0, after: 0, line: Math.max(20, gapTw), lineRule: D.LineRuleType.EXACT },
        children: [new D.TextRun({ text: "", size: 2 })] });
    }

    const NONE = { style: D.BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const LINE = { style: D.BorderStyle.SINGLE, size: 4, color: "808080" };

    // Lay rows out on a grid. Cells covered by an earlier rowspan are omitted in later rows (as in HTML).
    function layout(rows) {
      const grid = []; const pend = [];
      for (const row of rows) {
        const items = []; let c = 0; const queue = (row || []).slice();
        const take = () => { const raw = queue.shift(); return (raw && typeof raw === "object") ? raw : { text: raw == null ? "" : String(raw) }; };
        const pendingAhead = () => pend.some((p, i) => i >= c && p && p.left > 0);
        while (queue.length || pendingAhead()) {
          if (pend[c] && pend[c].left > 0) { const p = pend[c]; items.push({ cont: true, col: c, span: p.span }); p.left--; c += p.span; continue; }
          if (!queue.length) { c++; continue; }
          const cell = take(); const span = Math.max(1, +cell.colspan || 1), rs = Math.max(1, +cell.rowspan || 1);
          items.push({ cell, col: c, span });
          if (rs > 1) pend[c] = { left: rs - 1, span };
          c += span;
        }
        grid.push(items);
      }
      const ncol = Math.max(1, ...grid.map(r => r.reduce((m, it) => Math.max(m, it.col + it.span), 0)));
      return { grid, ncol };
    }

    function table(b, totalW, indent, font, L) {
      totalW = totalW || TEXT_W;
      const rows = b.rows || [];
      const { grid, ncol } = layout(rows);
      const rel = (b.widths && b.widths.length === ncol) ? b.widths.map(Number) : Array(ncol).fill(1);
      const tot = rel.reduce((a, c) => a + c, 0) || 1;
      const widths = rel.map(x => Math.floor(x / tot * totalW));
      widths[widths.length - 1] += totalW - widths.reduce((a, c) => a + c, 0);
      const mode = b.borders || "all";
      const header = b.header ?? 0;
      const size = b.size || (ncol > 8 ? BASE - 1 : BASE);
      const VA = { top: D.VerticalAlign.TOP, bottom: D.VerticalAlign.BOTTOM, center: D.VerticalAlign.CENTER };

      const trs = grid.map((items, ri) => {
        const full = []; let c = 0;
        for (const it of items.slice().sort((a, z) => a.col - z.col)) {
          while (c < it.col) { full.push({ cell: { text: "" }, col: c, span: 1 }); c++; }
          full.push(it); c = it.col + it.span;
        }
        while (c < ncol) { full.push({ cell: { text: "" }, col: c, span: 1 }); c++; }
        const isHead = ri < header;
        const cells = full.map(it => {
          const w = widths.slice(it.col, it.col + it.span).reduce((a, x) => a + x, 0);
          let borders;
          if (mode === "none") borders = { top: NONE, bottom: NONE, left: NONE, right: NONE };
          else if (mode === "horizontal") borders = {
            top: ri === 0 ? LINE : NONE, left: NONE, right: NONE,
            bottom: (ri === header - 1 || ri === grid.length - 1) ? LINE : NONE };
          else borders = { top: LINE, bottom: LINE, left: LINE, right: LINE };
          const common = { width: { size: w, type: D.WidthType.DXA }, columnSpan: it.span > 1 ? it.span : undefined, borders,
            margins: { top: 30, bottom: 30, left: 70, right: 70 } };
          if (it.cont) return new D.TableCell({ ...common, verticalMerge: D.VerticalMergeType.CONTINUE, children: [new D.Paragraph({ children: [] })] });
          const cl = it.cell;
          const lines = String(cl.text ?? "").split("\n");
          const children = lines.map(line => new D.Paragraph({
            alignment: al(cl.align || b.align),
            spacing: { before: 0, after: 0 },
            children: runs(line, { bold: cl.bold || (isHead && b.headerBold !== false), italic: cl.italic, hand: cl.hand, size: cl.size || size, font }),
          }));
          if (cl.image) children.push(new D.Paragraph({ alignment: al(cl.align), children: [imageRun(cl.image, Math.round(w / 1440 * 96))] }));
          return new D.TableCell({ ...common,
            verticalMerge: (+cl.rowspan > 1) ? D.VerticalMergeType.RESTART : undefined,
            verticalAlign: VA[cl.valign] || D.VerticalAlign.CENTER,
            shading: (cl.shade || (isHead && b.headerShade)) ? { fill: String(cl.shade || b.headerShade).replace("#", ""), type: D.ShadingType.CLEAR, color: "auto" } : undefined,
            children });
        });
        return new D.TableRow({ children: cells, tableHeader: isHead && header < grid.length,
          height: (L && L.rowH) ? { value: L.rowH, rule: D.HeightRule.ATLEAST } : b.rowHeight ? { value: b.rowHeight, rule: D.HeightRule.ATLEAST } : undefined });
      });
      return new D.Table({ width: { size: totalW, type: D.WidthType.DXA }, columnWidths: widths, rows: trs,
        indent: (!L && indent) ? { size: indent, type: D.WidthType.DXA } : undefined,
        float: L ? { horizontalAnchor: D.TableAnchorType.PAGE, verticalAnchor: D.TableAnchorType.PAGE,
                     absoluteHorizontalPosition: Math.round(L.x0 * PAGE_W), absoluteVerticalPosition: Math.round(L.y0 * PAGE_H),
                     leftFromText: 0, rightFromText: 0, topFromText: 0, bottomFromText: 0 } : undefined });
    }

    const out = [];
    let pageNo = 0;
    for (const b of doc.blocks || []) {
      const L = (LAYOUT && Array.isArray(b.box) && b.box.length === 4) ? lay(b) : null;
      switch (b.type) {
        case "pagebg": {
          const img = b.image;
          const bgRun = img ? new D.ImageRun({ type: img.kind || "jpg", data: img.data,
            transformation: { width: 794, height: 1123 },
            floating: { horizontalPosition: { relative: D.HorizontalPositionRelativeFrom.PAGE, offset: 0 },
                        verticalPosition: { relative: D.VerticalPositionRelativeFrom.PAGE, offset: 0 },
                        behindDocument: true, allowOverlap: true, lockAnchor: true,
                        wrap: { type: D.TextWrappingType.NONE } } }) : null;
          out.push(new D.Paragraph({ pageBreakBefore: pageNo > 0, spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT },
            children: bgRun ? [bgRun, new D.TextRun({ text: "", size: 2 })] : [new D.TextRun({ text: "", size: 2 })] }));
          pageNo++;
          break;
        }
        case "heading": {
          if (L) { out.push(para({ ...b, bold: b.bold !== false }, L)); break; }
          const sz = { 1: BASE + 6, 2: BASE + 3, 3: BASE + 1 }[b.level || 2] || BASE + 3;
          out.push(new D.Paragraph({ alignment: al(b.align), keepNext: true,
            spacing: { before: 160, after: 80 },
            border: b.rule ? { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "000000", space: 2 } } : undefined,
            children: runs(b.text, { bold: true, size: sz, underline: b.underline }) }));
          break;
        }
        case "paragraph":
          if (L) out.push(para(b, L));
          else if (LAYOUT) out.push(new D.Paragraph({ alignment: al(b.align), children: runs(b.runs || b.text || "", { size: b.size || 11, bold: b.bold, italic: b.italic, font: FONTS[b.font] || FONTS.serif }),
              spacing: { before: 0, after: 0 }, indent: { left: 1000, right: 1000 } }));
          else out.push(para(b));
          break;
        case "table":
          if (L) {
            const nrows = (b.rows || []).length || 1;
            L.rowH = Math.max(200, Math.round((L.y1 - L.y0) * PAGE_H / nrows));
            out.push(table({ ...b, size: b.size || Math.max(6, Math.min(12, Math.round(L.rowH / 20 * 0.62 * 2) / 2)) },
              Math.max(1000, Math.round((L.x1 - L.x0) * PAGE_W)), 0, L.font, L));
            out.push(new D.Paragraph({ spacing: { before: 0, after: 0, line: 20, lineRule: D.LineRuleType.EXACT }, children: [new D.TextRun({ text: "", size: 2 })] }));
          } else { out.push(table(b)); out.push(new D.Paragraph({ spacing: { after: 60 }, children: [] })); }
          break;
        case "images": {
          if (LAYOUT) break;      // in exact layout graphics live in the page background
          out.push(new D.Paragraph({ alignment: al(b.align || "center"), spacing: { after: 80 },
            children: (b.items || []).flatMap((it, i) => i ? [new D.TextRun({ text: "   " }), imageRun(it, TEXT_PX)] : [imageRun(it, TEXT_PX)]) }));
          break;
        }
        case "line":
          if (LAYOUT) break;
          out.push(new D.Paragraph({ border: { bottom: { style: D.BorderStyle.SINGLE, size: 6, color: "000000", space: 1 } }, children: [] }));
          break;
        case "cut":
          if (LAYOUT) break;
          out.push(new D.Paragraph({ spacing: { before: 60, after: 60 }, border: { bottom: { style: D.BorderStyle.DASHED, size: 6, color: "808080", space: 1 } }, children: [] }));
          break;
        case "pagebreak": if (!LAYOUT) out.push(new D.Paragraph({ children: [new D.PageBreak()] })); break;
      }
    }

    return new D.Document({
      creator: "Відновлення документів",
      styles: { default: { document: { run: { font: LAYOUT ? FONTS.serif : FONT, size: BASE * 2 } } } },
      sections: [{ properties: { page: { size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 0, footer: 0 } } }, children: out }],
    });
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { buildDocx };
  else root.buildDocx = buildDocx;
})(typeof window !== "undefined" ? window : globalThis);

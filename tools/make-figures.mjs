#!/usr/bin/env node
// Regenerates the figures in RESEARCH-REPORT.md.
//
// The numbers below are transcribed from the test suites, which are the source
// of truth — test/test_question_matcher.js for the radius sweep and
// test/test_no_bookmarks.js for the ablation. Keeping the figures in a script
// rather than hand-drawn SVG means they can be re-derived when a measurement
// changes, and that the values a reader sees are the values that were measured.
//
//   node tools/make-figures.mjs
//
// Output is static SVG. GitHub renders it through <img>, which cannot run
// script, so there is no hover layer: every series is directly labelled and the
// report carries the same data as a table beside each figure.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'figures');
mkdirSync(OUT, { recursive: true });

// Validated two-slot categorical palette, light and dark steps of the same
// hues. Both modes pass all six checks (lightness band, chroma floor, CVD
// separation, normal-vision floor, contrast) — worst adjacent CVD ΔE 24.7
// light / 26.8 dark against a target of 8.
const C = {
  s1: { light: '#2a78d6', dark: '#3987e5' },   // slot 1, blue
  s2: { light: '#eb6834', dark: '#d95926' },   // slot 2, orange
  critical: '#d03b3b',                          // status, never a series
  surface: { light: '#fcfcfb', dark: '#1a1a19' },
  ink: { light: '#0b0b0b', dark: '#ffffff' },
  muted: { light: '#52514e', dark: '#c3c2b7' },
  grid: { light: '#e6e5e1', dark: '#333331' },
};

/** Theme-aware CSS: the media query for OS preference, so it works inside <img>. */
function style(extra = '') {
  return `
  <style>
    .surface { fill: ${C.surface.light}; }
    .ink   { fill: ${C.ink.light}; }
    .muted { fill: ${C.muted.light}; }
    .grid  { stroke: ${C.grid.light}; }
    .s1f { fill: ${C.s1.light}; } .s1s { stroke: ${C.s1.light}; }
    .s2f { fill: ${C.s2.light}; } .s2s { stroke: ${C.s2.light}; }
    .crit { fill: ${C.critical}; stroke: ${C.critical}; }
    text { font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    .title { font-size: 15px; font-weight: 600; }
    .sub   { font-size: 12px; }
    .lab   { font-size: 12px; }
    .tick  { font-size: 11px; }
    .val   { font-size: 11px; font-weight: 600; }
    .grid  { stroke-width: 1; }
    .axis  { stroke-width: 1.5; }
    @media (prefers-color-scheme: dark) {
      .surface { fill: ${C.surface.dark}; }
      .ink   { fill: ${C.ink.dark}; }
      .muted { fill: ${C.muted.dark}; }
      .grid  { stroke: ${C.grid.dark}; }
      .s1f { fill: ${C.s1.dark}; } .s1s { stroke: ${C.s1.dark}; }
      .s2f { fill: ${C.s2.dark}; } .s2s { stroke: ${C.s2.dark}; }
    }
    ${extra}
  </style>`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = (w, h, body, extra) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img">`
  + style(extra) + `<rect width="${w}" height="${h}" class="surface"/>` + body + '</svg>\n';


// ── Figure: the stage cascade ───────────────────────────────────────────────
// Drawn rather than left to Mermaid so the report renders the same way offline,
// in a plain Markdown viewer, and on GitHub.
function cascade() {
  const W = 760, H = 470;
  let b = '';
  const box = (x, y, w, h, cls, lines, opts = {}) => {
    const r = opts.diamond ? 0 : 6;
    let o = opts.diamond
      ? `<path d="M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z" class="${cls}"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="${cls}"/>`;
    const n = lines.length;
    lines.forEach((t, i) => {
      const fw = i === 0 && opts.bold ? ' font-weight="600"' : '';
      o += `<text x="${x + w / 2}" y="${y + h / 2 - (n - 1) * 7 + i * 14 + 4}" text-anchor="middle"`
        + ` class="${opts.onFill ? 'tick' : 'tick muted'}"${fw}`
        + `${opts.onFill ? ' fill="#ffffff"' : ''}>${esc(t)}</text>`;
    });
    return o;
  };
  const arrow = (x1, y1, x2, y2, label, side) => {
    let o = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="grid" stroke-width="1.5"`
      + ` marker-end="url(#ah)"/>`;
    if (label) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      o += `<text x="${mx + (side === 'left' ? -8 : 8)}" y="${my - 2}"`
        + ` text-anchor="${side === 'left' ? 'end' : 'start'}" class="tick muted">${esc(label)}</text>`;
    }
    return o;
  };

  b += `<defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6"`
    + ` orient="auto"><path d="M0,0 L8,4 L0,8 z" class="grid" fill="currentColor" stroke="none"/></marker></defs>`;

  const cx = 250, dw = 210, dh = 74;
  const stages = [
    { y: 60,  t: ['Stage 0', 'exact hierarchical id in', 'both bookmark trees?'] },
    { y: 168, t: ['Stage 1', 'chapters alignable?', 'monotonic, depth-aware'] },
    { y: 276, t: ['Stage 2', 'content decisive?', 'operator context'] },
    { y: 384, t: ['Stage 3', 'position established', 'by neighbours?'] },
  ];
  b += box(cx - 90, 8, 180, 30, 'grid', ['question on the current page'], { onFill: false });
  b += `<rect x="${cx - 90}" y="8" width="180" height="30" rx="6" fill="none" class="grid" stroke-width="1.5"/>`;
  b += arrow(cx, 38, cx, 56);

  stages.forEach((st, i) => {
    b += box(cx - dw / 2, st.y, dw, dh, 'grid', st.t, { diamond: true, bold: true });
    b += `<path d="M${cx},${st.y} L${cx + dw / 2},${st.y + dh / 2} L${cx},${st.y + dh}`
      + ` L${cx - dw / 2},${st.y + dh / 2} Z" fill="none" class="grid" stroke-width="1.5"/>`;
    if (i < stages.length - 1) b += arrow(cx, st.y + dh, cx, stages[i + 1].y - 4, 'no', 'left');
  });

  // Accepting exits on the right, refusal at the bottom.
  const exits = [
    { y: 60,  cls: 's1f', t: ['HIGH', 'exact id'], lab: 'yes — 508/508 here' },
    { y: 276, cls: 's1f', t: ['MEDIUM', 'content agrees'], lab: 'one clearly ahead' },
    { y: 384, cls: 's2f', t: ['LOW / MEDIUM', 'positional support'], lab: 'bracketed' },
  ];
  for (const e of exits) {
    b += arrow(cx + dw / 2, e.y + dh / 2, 540, e.y + dh / 2, e.lab, 'right');
    b += box(548, e.y + dh / 2 - 21, 170, 42, e.cls, e.t, { onFill: true, bold: true });
  }
  b += arrow(cx, 384 + dh, cx, 440);
  b += box(cx - 130, 440, 260, 30, 'crit', ['NONE — refused, with candidates and reason'],
    { onFill: true });

  b += `<text x="20" y="26" class="title ink">Four stages; a question exits at the first that can justify an answer</text>`;
  return svg(W, H, b);
}

// ── Figure: operator-context window radius sweep ────────────────────────────
// Source: test/test_question_matcher.js, group 1c.
function radiusSweep() {
  const W = 760, H = 400;
  const L = 62, R = 210, T = 58, B = 56;
  const pw = W - L - R, ph = H - T - B;

  const radii = [1, 2, 3, 4, 5, 6];
  const mean = [0.291, 0.452, 0.652, 0.524, 0.540, 0.338];
  const worst = [0.167, 0.250, 0.500, 0.333, 0.333, 0.000];
  const baselines = [
    { y: 0.145, label: 'plain similarity' },
    { y: 0.184, label: 'fragment bigrams' },
  ];

  const yMax = 0.70;
  const x = (i) => L + (pw * i) / (radii.length - 1);
  const y = (v) => T + ph - (ph * v) / yMax;

  let b = '';
  // Gridlines and y ticks.
  for (let v = 0; v <= yMax + 1e-9; v += 0.1) {
    b += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${L + pw}" y2="${y(v).toFixed(1)}" class="grid"/>`;
    b += `<text x="${L - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick muted">${v.toFixed(1)}</text>`;
  }
  // Baselines: what the window is being compared against.
  for (const bl of baselines) {
    b += `<line x1="${L}" y1="${y(bl.y).toFixed(1)}" x2="${L + pw}" y2="${y(bl.y).toFixed(1)}"`
      + ` class="grid" stroke-dasharray="5 4"/>`;
    b += `<text x="${L + pw + 8}" y="${(y(bl.y) + 4).toFixed(1)}" class="tick muted">${esc(bl.label)} ${bl.y}</text>`;
  }
  // Chosen radius, marked behind the data.
  b += `<rect x="${(x(2) - 26).toFixed(1)}" y="${T}" width="52" height="${ph}" fill="currentColor"`
    + ` class="s1f" opacity="0.07"/>`;
  b += `<text x="${x(2).toFixed(1)}" y="${T - 14}" text-anchor="middle" class="val s1f">chosen</text>`;

  const path = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  b += `<path d="${path(mean)}" fill="none" class="s1s" stroke-width="2"/>`;
  b += `<path d="${path(worst)}" fill="none" class="s2s" stroke-width="2"/>`;
  for (let i = 0; i < radii.length; i++) {
    b += `<circle cx="${x(i).toFixed(1)}" cy="${y(mean[i]).toFixed(1)}" r="4.5" class="s1f"`
      + ` stroke="${C.surface.light}" stroke-width="2"/>`;
    b += `<circle cx="${x(i).toFixed(1)}" cy="${y(worst[i]).toFixed(1)}" r="4.5" class="s2f"`
      + ` stroke="${C.surface.light}" stroke-width="2"/>`;
  }
  // The inversion at radius 6 — a status colour, labelled, never colour alone.
  b += `<circle cx="${x(5).toFixed(1)}" cy="${y(0).toFixed(1)}" r="7" fill="none" class="crit" stroke-width="2"/>`;
  b += `<text x="${(x(5) - 4).toFixed(1)}" y="${(y(0) - 16).toFixed(1)}" text-anchor="end" class="val crit">`
    + `1 pair inverts</text>`;

  // Direct labels at the right end, so identity is never colour-alone.
  b += `<text x="${(x(5) + 12).toFixed(1)}" y="${(y(mean[5]) + 4).toFixed(1)}" class="lab s1f">mean margin</text>`;
  b += `<text x="${(x(5) + 12).toFixed(1)}" y="${(y(worst[5]) + 18).toFixed(1)}" class="lab s2f">worst case</text>`;

  // Axes and x ticks.
  b += `<line x1="${L}" y1="${T + ph}" x2="${L + pw}" y2="${T + ph}" class="grid axis"/>`;
  for (let i = 0; i < radii.length; i++) {
    b += `<text x="${x(i).toFixed(1)}" y="${T + ph + 20}" text-anchor="middle" class="tick muted">${radii[i]}</text>`;
  }
  b += `<text x="${(L + pw / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="lab muted">`
    + `operator context window radius (characters either side)</text>`;
  b += `<text x="${L - 46}" y="${(T + ph / 2).toFixed(1)}" transform="rotate(-90 ${L - 46} ${(T + ph / 2).toFixed(1)})"`
    + ` text-anchor="middle" class="lab muted">margin (correct − best wrong)</text>`;
  b += `<text x="${L}" y="26" class="title ink">Discrimination margin peaks at radius 3</text>`;
  b += `<text x="${L}" y="44" class="sub muted">Five near-identical question pairs; higher is better separation</text>`;

  return svg(W, H, b);
}

// ── Figure: precision holds while refusal climbs ────────────────────────────
// Source: test/test_no_bookmarks.js.
function ablation() {
  const W = 760, H = 380;
  const L = 62, R = 24, T = 62, B = 96;
  const pw = W - L - R, ph = H - T - B;

  const regimes = [
    { name: 'both\nbookmarked', precision: 100, refused: 8.9, n: '794 accepted' },
    { name: 'key not\nbookmarked', precision: 100, refused: 17.8, n: '717 accepted' },
    { name: 'exercise not\nbookmarked', precision: 100, refused: 98.0, n: '2 accepted †' },
    { name: 'neither\nbookmarked', precision: 100, refused: 10.2, n: '44 accepted †' },
  ];

  const y = (v) => T + ph - (ph * v) / 100;
  const band = pw / regimes.length;
  const bw = 34, gap = 2;

  let b = '';
  for (let v = 0; v <= 100; v += 25) {
    b += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${L + pw}" y2="${y(v).toFixed(1)}" class="grid"/>`;
    b += `<text x="${L - 10}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick muted">${v}%</text>`;
  }

  regimes.forEach((r, i) => {
    const cx = L + band * i + band / 2;
    const x1 = cx - bw - gap / 2, x2 = cx + gap / 2;
    // 4px rounded data-ends, anchored to the baseline.
    const bar = (x, v, cls) => {
      const h = Math.max(0, (ph * v) / 100);
      if (h < 1) return `<line x1="${x}" y1="${(T + ph).toFixed(1)}" x2="${x + bw}" y2="${(T + ph).toFixed(1)}"`
        + ` stroke-width="2" class="${cls.replace('f', 's')}"/>`;
      return `<path d="M${x},${T + ph} L${x},${(y(v) + 4).toFixed(1)} Q${x},${y(v).toFixed(1)} ${x + 4},${y(v).toFixed(1)}`
        + ` L${x + bw - 4},${y(v).toFixed(1)} Q${x + bw},${y(v).toFixed(1)} ${x + bw},${(y(v) + 4).toFixed(1)}`
        + ` L${x + bw},${T + ph} Z" class="${cls}"/>`;
    };
    b += bar(x1, r.precision, 's1f');
    b += bar(x2, r.refused, 's2f');
    b += `<text x="${(x1 + bw / 2).toFixed(1)}" y="${(y(r.precision) - 8).toFixed(1)}" text-anchor="middle" class="val ink">${r.precision}%</text>`;
    b += `<text x="${(x2 + bw / 2).toFixed(1)}" y="${(y(r.refused) - 8).toFixed(1)}" text-anchor="middle" class="val ink">${r.refused}%</text>`;
    r.name.split('\n').forEach((line, k) => {
      b += `<text x="${cx.toFixed(1)}" y="${T + ph + 20 + k * 14}" text-anchor="middle" class="tick muted">${esc(line)}</text>`;
    });
    b += `<text x="${cx.toFixed(1)}" y="${T + ph + 52}" text-anchor="middle" class="tick muted">${esc(r.n)}</text>`;
  });

  b += `<line x1="${L}" y1="${T + ph}" x2="${L + pw}" y2="${T + ph}" class="grid axis"/>`;
  // Legend — always present for two series.
  b += `<rect x="${L}" y="38" width="11" height="11" rx="2" class="s1f"/>`;
  b += `<text x="${L + 17}" y="48" class="lab muted">precision of accepted matches</text>`;
  b += `<rect x="${L + 222}" y="38" width="11" height="11" rx="2" class="s2f"/>`;
  b += `<text x="${L + 239}" y="48" class="lab muted">share of attempts refused</text>`;
  b += `<text x="${L}" y="24" class="title ink">Precision does not move; the engine refuses instead</text>`;
  b += `<text x="${L}" y="${H - 10}" class="tick muted">† page-sampled. Zero wrong answers in every regime.</text>`;

  return svg(W, H, b);
}

// ── Figure: per-page latency by regime ──────────────────────────────────────
//
// Read from figures/latency-by-regime.data.json, which tools/measure-regimes.mjs
// produces. The values were hardcoded here once and went stale the moment the
// retrieval path changed — the figure claimed 507 ms for a regime then measuring
// 327, and nothing flagged it. Deriving them from a committed artifact means a
// stale figure is a stale file with a date on it rather than a number nobody
// rechecks.
//
// The artifact holds counts only. Refresh it with:
//   node tools/measure-regimes.mjs <corpus> --json tmp/regimes.json
//   node tools/make-figures.mjs --from tmp/regimes.json
function latencyData() {
  const fromArg = process.argv.indexOf('--from');
  if (fromArg > 0 && process.argv[fromArg + 1]) {
    const raw = JSON.parse(readFileSync(process.argv[fromArg + 1], 'utf-8'));
    const rows = (raw.results ?? []).filter(r => r.pair !== '2025 (scanned Q)');
    const key = (r) => (r.qBm && r.aBm ? 'both'
      : r.qBm && !r.aBm ? 'ansNone'
        : !r.qBm && r.aBm ? 'exNone' : 'neither');
    const label = {
      both: 'both bookmarked',
      ansNone: 'answer key not bookmarked',
      exNone: 'exercise book not bookmarked',
      neither: 'neither bookmarked',
    };
    const by = new Map();
    for (const r of rows) {
      if (!by.has(key(r))) by.set(key(r), []);
      by.get(key(r)).push({ pair: r.pair, p95: r.p95 });
    }
    const regimes = ['both', 'ansNone', 'exNone', 'neither'].map(k => ({
      key: k,
      label: label[k],
      pairs: by.get(k) ?? [],
      minP95: Math.min(...(by.get(k) ?? [{ p95: 0 }]).map(x => x.p95)),
      maxP95: Math.max(...(by.get(k) ?? [{ p95: 0 }]).map(x => x.p95)),
    }));
    const out = {
      generatedAt: new Date().toISOString(),
      source: 'tools/measure-regimes.mjs',
      note: 'p95 per-page matching latency, full book, no sampling. Derived counts only.',
      deadlineMs: 1500,
      targetMs: 150,
      regimes,
    };
    writeFileSync(join(OUT, 'latency-by-regime.data.json'), `${JSON.stringify(out, null, 2)}\n`);
    return out;
  }
  return JSON.parse(readFileSync(join(OUT, 'latency-by-regime.data.json'), 'utf-8'));
}

function latency() {
  const data = latencyData();
  const W = 760, H = 340;
  const L = 190, R = 78, T = 62, B = 54;
  const pw = W - L - R, ph = H - T - B;

  const rows = data.regimes;
  const xMax = 1800;
  const x = (v) => L + (pw * v) / xMax;
  const step = ph / rows.length;
  const bh = 12;

  let b = '';
  for (let v = 0; v <= xMax; v += 300) {
    b += `<line x1="${x(v).toFixed(1)}" y1="${T}" x2="${x(v).toFixed(1)}" y2="${T + ph}" class="grid"/>`;
    b += `<text x="${x(v).toFixed(1)}" y="${T + ph + 18}" text-anchor="middle" class="tick muted">${v}</text>`;
  }

  // The alignment deadline. Reaching it means results come from expiry rather
  // than from a decision, which is why it is drawn as a status threshold.
  b += `<line x1="${x(data.deadlineMs).toFixed(1)}" y1="${T - 8}" x2="${x(data.deadlineMs).toFixed(1)}" y2="${T + ph}"`
    + ` class="crit" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  b += `<text x="${(x(data.deadlineMs) - 6).toFixed(1)}" y="${T - 12}" text-anchor="end" class="val crit">${data.deadlineMs} ms alignment deadline</text>`;

  // The single-question responsiveness target.
  b += `<line x1="${x(data.targetMs).toFixed(1)}" y1="${T}" x2="${x(data.targetMs).toFixed(1)}" y2="${T + ph}"`
    + ` class="s2s" stroke-width="1.2" stroke-dasharray="3 3"/>`;
  b += `<text x="${(x(data.targetMs) + 6).toFixed(1)}" y="${(T + ph + 36).toFixed(1)}" class="tick s2f">${data.targetMs} ms target</text>`;

  rows.forEach((r, i) => {
    const cy = T + step * i + step / 2;
    const x0 = x(r.minP95);
    const x1 = x(r.maxP95);
    const w = Math.max(2, x1 - x0);

    // The range across the three matched pairs, not a single number: the same
    // regime costs 61 ms on one pair and 808 on another, and a lone bar would
    // hide which.
    b += `<rect x="${x0.toFixed(1)}" y="${(cy - bh / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${bh}" rx="${bh / 2}" class="s1f" opacity="0.32"/>`;
    for (const pair of r.pairs) {
      b += `<circle cx="${x(pair.p95).toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" class="s1f"/>`;
    }
    b += `<text x="${L - 12}" y="${(cy + 4).toFixed(1)}" text-anchor="end" class="lab muted">${esc(r.label)}</text>`;
    const text = r.minP95 === r.maxP95 ? `${r.maxP95} ms` : `${r.minP95}–${r.maxP95} ms`;
    b += `<text x="${(x1 + 8).toFixed(1)}" y="${(cy + 4).toFixed(1)}" class="val ink">${text}</text>`;
  });

  b += `<line x1="${L}" y1="${T}" x2="${L}" y2="${T + ph}" class="grid axis"/>`;
  b += `<text x="${(L + pw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" class="lab muted">95th-percentile per-page matching latency (ms), range across the three matched pairs</text>`;
  b += `<text x="20" y="24" class="title ink">Without bookmarks, the worst pair reaches the deadline</text>`;
  b += `<text x="20" y="42" class="sub muted">Bookmarked pages resolve at stage 0 and never reach content scoring; each dot is one pair</text>`;

  return svg(W, H, b);
}

const figures = {
  'cascade.svg': cascade(),
  'radius-sweep.svg': radiusSweep(),
  'ablation-precision-refusal.svg': ablation(),
  'latency-by-regime.svg': latency(),
};

for (const [name, content] of Object.entries(figures)) {
  writeFileSync(join(OUT, name), content);
  console.log(`  ${name.padEnd(34)} ${content.length} bytes`);
}
console.log(`\nwrote ${Object.keys(figures).length} figures to figures/`);

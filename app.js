/* Ashford & Vere — dashboard runtime
 * - Seeded RNG so the session feels deterministic on load but ticks live.
 * - SVG charts drawn by hand (performance, sparklines, donut).
 * - Live prices drift on a realistic walk; P&L and KPIs recompute.
 */
(() => {
  'use strict';

  // ── Deterministic RNG ─────────────────────────────────────────────
  const mulberry32 = (s) => () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rnd = mulberry32(4242);

  // ── Formatters ────────────────────────────────────────────────────
  const fmtUSD = (n, frac = 0) => n.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: frac, maximumFractionDigits: frac,
  });
  const fmtNum = (n, frac = 2) => n.toLocaleString('en-US', {
    minimumFractionDigits: frac, maximumFractionDigits: frac,
  });
  const fmtPct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
  const fmtDelta = (n) => (n >= 0 ? '▲ ' : '▼ ') + fmtUSD(Math.abs(n));
  const signCls = (n) => (n >= 0 ? 'up' : 'down');

  // ── Seed data: holdings ───────────────────────────────────────────
  // sensitivities: beta (to equity market), dur (bond duration years),
  // fx (fraction of non-USD exposure), gold (1 if physical gold).
  const holdings = [
    { sym: 'NVDA',  name: 'NVIDIA Corp.',           sector: 'Semiconductors',   qty:  6800, cost: 612.40, px: 892.40, beta: 1.55, dur: 0,    fx: 0,   gold: 0 },
    { sym: 'MSFT',  name: 'Microsoft Corp.',        sector: 'Software',         qty: 12400, cost: 318.10, px: 422.75, beta: 1.05, dur: 0,    fx: 0,   gold: 0 },
    { sym: 'AAPL',  name: 'Apple Inc.',             sector: 'Hardware',         qty: 18600, cost: 164.20, px: 208.90, beta: 1.20, dur: 0,    fx: 0,   gold: 0 },
    { sym: 'LVMH',  name: 'LVMH Moët Hennessy',     sector: 'Luxury · Paris',   qty:  9200, cost: 642.00, px: 748.40, beta: 0.90, dur: 0,    fx: 1,   gold: 0 },
    { sym: 'NESN',  name: 'Nestlé SA',              sector: 'Staples · SIX',    qty: 14800, cost:  98.70, px: 104.12, beta: 0.55, dur: 0,    fx: 1,   gold: 0 },
    { sym: 'BRK.B', name: 'Berkshire Hathaway B',   sector: 'Conglomerate',     qty:  8400, cost: 312.20, px: 408.30, beta: 0.85, dur: 0,    fx: 0,   gold: 0 },
    { sym: 'ASML',  name: 'ASML Holding',           sector: 'Semi Equip · AEX', qty:  3100, cost: 642.10, px: 910.20, beta: 1.40, dur: 0,    fx: 1,   gold: 0 },
    { sym: 'UST10', name: 'US Treasury 4.25% 2034', sector: 'Govt Bond',        qty: 75000, cost:  99.10, px: 101.42, beta: 0,    dur: 9.5,  fx: 0,   gold: 0 },
    { sym: 'GOLD',  name: 'Physical Gold (LBMA)',   sector: 'Commodity · oz',   qty:  8200, cost: 1980.0, px: 2342.10, beta: 0.1,  dur: 0,    fx: 0.3, gold: 1 },
    { sym: 'TSLA',  name: 'Tesla Inc.',             sector: 'Autos',            qty:  5400, cost: 242.80, px: 174.60, beta: 1.95, dur: 0,    fx: 0,   gold: 0 },
  ];

  // Watchlist (separate from holdings)
  const watchlist = [
    { sym: 'SPX',  name: 'S&P 500 Index',       px: 5284.12, pct:  0.31 },
    { sym: 'SX5E', name: 'Euro Stoxx 50',       px: 5010.44, pct:  0.22 },
    { sym: 'NKY',  name: 'Nikkei 225',          px: 39412.7, pct: -0.18 },
    { sym: 'BTC',  name: 'Bitcoin · USD',       px: 71248.0, pct:  1.42 },
    { sym: 'GOLD', name: 'Gold Spot · oz',      px: 2342.10, pct:  0.64 },
    { sym: 'CL',   name: 'WTI Crude · bbl',     px:   83.12, pct: -0.44 },
    { sym: 'DXY',  name: 'US Dollar Index',     px:  104.21, pct: -0.08 },
    { sym: 'UST10',name: 'US 10Y Yield',        px:    4.28, pct:  0.02, isYield: true },
  ];

  // Single-name concentration limits (bank-set max weights). The live % is
  // derived from positions at tick time.
  const concentrationLimits = {
    'NVDA':  10,
    'LVMH':   7,
    'MSFT':   7,
    'ASML':   5,
    'BRK.B':  6,
  };
  const flagBySym = {
    'NVDA': '🇺🇸', 'MSFT': '🇺🇸', 'AAPL': '🇺🇸', 'BRK.B': '🇺🇸', 'TSLA': '🇺🇸',
    'LVMH': '🇫🇷', 'NESN': '🇨🇭', 'ASML': '🇳🇱', 'UST10': '🇺🇸', 'GOLD': '🌐',
  };

  // Upcoming events (next 14 days)
  const events = [
    { d: 22, m: 'Apr', tag: 'CALL', cls: 'call', label: 'Capital call · Carlyle Partners VIII',         meta: 'Wire $420,000 · T+3 settle' },
    { d: 23, m: 'Apr', tag: 'CPN',  cls: 'cpn',  label: 'Coupon · UST 4.25% 2034',                      meta: 'Expected $1,593 per $100k notional' },
    { d: 25, m: 'Apr', tag: 'DIV',  cls: 'div',  label: 'Ex‑dividend · Microsoft',                      meta: 'Estimated $9,300 · payable 13 May' },
    { d: 28, m: 'Apr', tag: 'DIV',  cls: 'div',  label: 'Ex‑dividend · Nestlé',                         meta: 'CHF 3.00 per share · payable 06 May' },
    { d: 30, m: 'Apr', tag: 'CALL', cls: 'call', label: 'Capital call · Blackstone RE Partners X',      meta: 'Wire $1.1M · confirm IRS W‑8' },
    { d:  2, m: 'May', tag: 'MAT',  cls: 'mat',  label: 'Bond maturity · UBS Subordinated 3.5% 2026',   meta: 'Redemption $2.0M · redeploy?' },
    { d:  5, m: 'May', tag: 'RV',   cls: '',     label: 'Rebalance review with Eleanor Marchetti',      meta: '14:00 GMT+2 · Geneva office' },
  ];

  // Geographic + currency exposure (look-through)
  const geographic = [
    { name: 'North America', flag: '🇺🇸', current: 48, target: 45 },
    { name: 'Europe ex-UK',  flag: '🇪🇺', current: 18, target: 20 },
    { name: 'Switzerland',   flag: '🇨🇭', current:  9, target:  8 },
    { name: 'United Kingdom',flag: '🇬🇧', current:  7, target:  7 },
    { name: 'Japan',         flag: '🇯🇵', current:  6, target:  7 },
    { name: 'Asia ex-Japan', flag: '🇸🇬', current:  8, target:  9 },
    { name: 'Emerging Mkts', flag: '🌐', current:  4, target:  4 },
  ];
  const currency = [
    { name: 'US Dollar',     flag: '🇺🇸', current: 52, target: 50 },
    { name: 'Swiss Franc',   flag: '🇨🇭', current: 14, target: 15 },
    { name: 'Euro',          flag: '🇪🇺', current: 12, target: 13 },
    { name: 'Pound Sterling',flag: '🇬🇧', current:  8, target:  8 },
    { name: 'Japanese Yen',  flag: '🇯🇵', current:  6, target:  7 },
    { name: 'Other',         flag: '🌐', current:  8, target:  7 },
  ];

  // Allocation (strategic vs current)
  const allocation = [
    { name: 'Public Equities',     current: 42, target: 40, color: '#c8a86b' },
    { name: 'Fixed Income',        current: 22, target: 25, color: '#8ba9d6' },
    { name: 'Private Markets',     current: 16, target: 18, color: '#a78bd6' },
    { name: 'Hedge Funds',         current:  8, target:  7, color: '#d68ba9' },
    { name: 'Real Assets',         current:  6, target:  6, color: '#6faf86' },
    { name: 'Cash & Equivalents',  current:  6, target:  4, color: '#7a7466' },
  ];

  // Portfolio performance series (YTD, ~80 trading days)
  const perfSeries = (() => {
    const days = 80;
    const mk = (mu, sigma) => {
      const arr = [100];
      for (let i = 1; i < days; i++) {
        const z = (rnd() + rnd() + rnd() - 1.5) * 2; // ~N(0,1)
        arr.push(arr[i - 1] * (1 + mu + sigma * z));
      }
      return arr;
    };
    const port = mk(0.00148, 0.0055);
    const bm   = mk(0.00092, 0.0048);
    const acwi = mk(0.00078, 0.0061);
    // Anchor endpoints to headline numbers
    const scale = (a, end) => a.map((v) => (v / a[a.length - 1]) * end);
    return {
      port: scale(port, 111.74),
      bm:   scale(bm,   107.12),
      acwi: scale(acwi, 105.93),
    };
  })();

  // ── DOM helpers ───────────────────────────────────────────────────
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(ns, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  // ── Holdings table ────────────────────────────────────────────────
  const holdingsBody = $('#holdings tbody');
  const renderHoldings = () => {
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    holdingsBody.innerHTML = '';
    holdings.forEach((h) => {
      const mv    = h.qty * h.px;
      const pnl   = (h.px - h.cost) * h.qty;
      const pnlPc = ((h.px / h.cost) - 1) * 100;
      const dayPc = h.dayPct ?? 0;
      const dayAbs = mv * (dayPc / 100);
      const weight = (mv / totalMV) * 100;

      const tr = document.createElement('tr');
      tr.dataset.sym = h.sym;
      tr.innerHTML = `
        <td>
          <div class="ticker">
            <div class="ticker__sym">${h.sym.slice(0, 3)}</div>
            <div class="ticker__meta">
              <strong>${h.sym}</strong>
              <span>${h.name} · ${h.sector}</span>
            </div>
          </div>
        </td>
        <td class="num">${fmtNum(h.qty, 0)}</td>
        <td class="num" data-field="px">${fmtNum(h.px, 2)}</td>
        <td class="num ${signCls(dayPc)}" data-field="day">
          ${fmtPct(dayPc)}<br><span class="small">${fmtDelta(dayAbs)}</span>
        </td>
        <td class="num" data-field="mv">${fmtUSD(mv)}</td>
        <td class="num ${signCls(pnl)}" data-field="pnl">
          ${fmtDelta(pnl)}<br><span class="small">${fmtPct(pnlPc)}</span>
        </td>
        <td class="num">${weight.toFixed(1)}%</td>
        <td class="row-actions">
          <button class="row-remove" title="Remove position" aria-label="Remove ${h.sym}" data-remove="${h.sym}">
            <svg viewBox="0 0 20 20" width="12" height="12" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg>
          </button>
        </td>`;
      holdingsBody.appendChild(tr);
    });
  };

  // ── Watchlist ─────────────────────────────────────────────────────
  const watchList = $('#watchlist');
  const renderWatch = () => {
    watchList.innerHTML = '';
    watchlist.forEach((w) => {
      const li = document.createElement('li');
      li.dataset.sym = w.sym;
      const mini = sparkPath(64, makeWalk(24, w.pct));
      li.innerHTML = `
        <div class="sym">${w.sym.slice(0, 3)}</div>
        <div class="meta"><strong>${w.sym}</strong><span>${w.name}</span></div>
        <svg class="mini" viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true">
          <path d="${mini}" fill="none" stroke="${w.pct >= 0 ? 'var(--up)' : 'var(--down)'}" stroke-width="1.3"/>
        </svg>
        <div>
          <div class="price" data-field="px">${w.isYield ? w.px.toFixed(2) + '%' : fmtNum(w.px, 2)}</div>
          <div class="change ${signCls(w.pct)}" data-field="pct">${fmtPct(w.pct)}</div>
        </div>`;
      watchList.appendChild(li);
    });
  };

  // ── Small helpers for SVG paths ───────────────────────────────────
  function makeWalk(n, bias = 0) {
    const out = [50];
    for (let i = 1; i < n; i++) {
      const drift = bias * 0.08;
      out.push(out[i - 1] + (rnd() - 0.5 + drift) * 4);
    }
    return out;
  }
  function sparkPath(width, arr, height = 24, pad = 2) {
    const min = Math.min(...arr), max = Math.max(...arr);
    const span = max - min || 1;
    const step = (width - pad * 2) / (arr.length - 1);
    return arr.map((v, i) => {
      const x = pad + i * step;
      const y = height - pad - ((v - min) / span) * (height - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  // ── KPI sparklines ────────────────────────────────────────────────
  const renderKpiSparks = () => {
    const specs = [
      { sel: '[data-spark="aum"]',  color: 'var(--gold)',   bias: 0.9 },
      { sel: '[data-spark="pnl"]',  color: 'var(--up)',     bias: 0.7 },
      { sel: '[data-spark="ytd"]',  color: 'var(--gold)',   bias: 0.9 },
    ];
    specs.forEach(({ sel, color, bias }) => {
      const svg = $(sel); if (!svg) return;
      svg.innerHTML = '';
      const arr = makeWalk(40, bias);
      const d = sparkPath(120, arr, 36, 2);
      // area fill
      const last = `L120,36 L0,36 Z`;
      svg.appendChild(svgEl('path', { d: d + ' ' + last, fill: color, opacity: 0.12, stroke: 'none' }));
      svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    });
  };

  // ── Performance chart ─────────────────────────────────────────────
  const perfChart = $('#perf-chart');
  const perfTip   = $('#perf-tip');
  let perfGeom = null; // populated by renderPerf so the hover handler can use it
  const renderPerf = () => {
    const W = 800, H = 300, pad = { l: 44, r: 16, t: 14, b: 28 };
    perfChart.innerHTML = '';
    perfChart.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const { port, bm, acwi } = perfSeries;
    const all = [...port, ...bm, ...acwi];
    const min = Math.min(...all) - 1;
    const max = Math.max(...all) + 1;
    const xOf = (i, n) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
    const yOf = (v)    => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);

    // Gridlines + y labels
    const gridG = svgEl('g');
    for (let k = 0; k <= 4; k++) {
      const y = pad.t + (k / 4) * (H - pad.t - pad.b);
      gridG.appendChild(svgEl('line', {
        x1: pad.l, x2: W - pad.r, y1: y, y2: y,
        stroke: 'var(--line-soft)', 'stroke-dasharray': '2 4',
      }));
      const value = max - (k / 4) * (max - min);
      const t = svgEl('text', {
        x: pad.l - 8, y: y + 4, 'text-anchor': 'end',
        'font-family': 'JetBrains Mono, monospace', 'font-size': 10,
        fill: 'var(--ink-3)',
      });
      t.textContent = value.toFixed(1);
      gridG.appendChild(t);
    }
    // X labels (months)
    const months = ['Jan', 'Feb', 'Mar', 'Apr'];
    months.forEach((m, i) => {
      const x = pad.l + (i / (months.length - 1)) * (W - pad.l - pad.r);
      const t = svgEl('text', {
        x, y: H - 8, 'text-anchor': 'middle',
        'font-family': 'Inter, sans-serif', 'font-size': 10,
        fill: 'var(--ink-3)', 'letter-spacing': '.14em',
      });
      t.textContent = m.toUpperCase();
      gridG.appendChild(t);
    });
    perfChart.appendChild(gridG);

    // Baseline at 100
    const baseY = yOf(100);
    perfChart.appendChild(svgEl('line', {
      x1: pad.l, x2: W - pad.r, y1: baseY, y2: baseY,
      stroke: 'var(--line)', 'stroke-width': 1,
    }));

    const pathFor = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i, arr.length).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');

    // Gradient for portfolio area
    const defs = svgEl('defs');
    defs.innerHTML = `
      <linearGradient id="portGrad" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%"  stop-color="#c8a86b" stop-opacity=".35"/>
        <stop offset="100%" stop-color="#c8a86b" stop-opacity="0"/>
      </linearGradient>`;
    perfChart.appendChild(defs);

    // ACWI (alt)
    perfChart.appendChild(svgEl('path', {
      d: pathFor(acwi), fill: 'none', stroke: 'var(--accent)',
      'stroke-width': 1.2, opacity: 0.85,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // Benchmark 60/40 (muted, dashed)
    perfChart.appendChild(svgEl('path', {
      d: pathFor(bm), fill: 'none', stroke: 'var(--ink-2)',
      'stroke-width': 1.1, 'stroke-dasharray': '4 4', opacity: 0.9,
    }));
    // Portfolio area
    const lastX = xOf(port.length - 1, port.length);
    const areaD = pathFor(port) + ` L${lastX.toFixed(1)},${(H - pad.b).toFixed(1)} L${pad.l},${(H - pad.b).toFixed(1)} Z`;
    perfChart.appendChild(svgEl('path', { d: areaD, fill: 'url(#portGrad)', stroke: 'none' }));
    // Portfolio line
    perfChart.appendChild(svgEl('path', {
      d: pathFor(port), fill: 'none', stroke: 'var(--gold)',
      'stroke-width': 1.8, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    // End-marker
    const endY = yOf(port[port.length - 1]);
    perfChart.appendChild(svgEl('circle', { cx: lastX, cy: endY, r: 4, fill: 'var(--gold)' }));
    perfChart.appendChild(svgEl('circle', { cx: lastX, cy: endY, r: 8, fill: 'var(--gold)', opacity: 0.2 }));
    const lbl = svgEl('text', {
      x: lastX - 6, y: endY - 10, 'text-anchor': 'end',
      'font-family': 'JetBrains Mono, monospace', 'font-size': 11,
      fill: 'var(--gold-soft)',
    });
    lbl.textContent = '+11.74%';
    perfChart.appendChild(lbl);

    // Hover crosshair + focus markers (hidden until mousemove)
    const crossG = svgEl('g', { id: 'perf-cross', opacity: 0 });
    crossG.appendChild(svgEl('line', {
      id: 'perf-cross-line',
      x1: 0, x2: 0, y1: pad.t, y2: H - pad.b,
      stroke: 'var(--gold)', 'stroke-width': 1, 'stroke-dasharray': '2 4', opacity: 0.7,
    }));
    ['port', 'bm', 'acwi'].forEach((k) => {
      const fill = k === 'port' ? 'var(--gold)' : k === 'bm' ? 'var(--ink-2)' : 'var(--accent)';
      crossG.appendChild(svgEl('circle', { id: `perf-dot-${k}`, cx: 0, cy: 0, r: 3.5, fill }));
    });
    perfChart.appendChild(crossG);

    perfGeom = { W, H, pad, xOf, yOf };
  };

  // ── Performance chart interactivity ──────────────────────────────
  const baseDate = new Date(2026, 0, 2); // trading days start 2 Jan
  const dayLabel = (i) => {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + Math.round(i * 1.45)); // sparse trading-day feel
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };

  const onPerfMove = (ev) => {
    if (!perfGeom) return;
    const { W, pad, xOf, yOf } = perfGeom;
    const rect = perfChart.getBoundingClientRect();
    const scaleX = rect.width / W;
    const px = (ev.clientX - rect.left) / scaleX; // svg-space x
    const { port, bm, acwi } = perfSeries;
    const n = port.length;
    const t = Math.max(pad.l, Math.min(W - 16, px));
    const i = Math.round(((t - pad.l) / (W - pad.l - 16)) * (n - 1));
    const idx = Math.max(0, Math.min(n - 1, i));

    const cx = xOf(idx, n);
    $('#perf-cross').setAttribute('opacity', 1);
    $('#perf-cross-line').setAttribute('x1', cx);
    $('#perf-cross-line').setAttribute('x2', cx);
    $('#perf-dot-port').setAttribute('cx', cx); $('#perf-dot-port').setAttribute('cy', yOf(port[idx]));
    $('#perf-dot-bm').setAttribute('cx', cx);   $('#perf-dot-bm').setAttribute('cy', yOf(bm[idx]));
    $('#perf-dot-acwi').setAttribute('cx', cx); $('#perf-dot-acwi').setAttribute('cy', yOf(acwi[idx]));

    perfTip.innerHTML = `
      <div class="tooltip__date">${dayLabel(idx)}</div>
      <div class="tooltip__row"><span class="sw" style="background:var(--gold)"></span><span>Portfolio</span><span class="v ${signCls(port[idx] - 100)}">${fmtPct(port[idx] - 100)}</span></div>
      <div class="tooltip__row"><span class="sw" style="background:var(--ink-2)"></span><span>60/40</span><span class="v ${signCls(bm[idx] - 100)}">${fmtPct(bm[idx] - 100)}</span></div>
      <div class="tooltip__row"><span class="sw" style="background:var(--accent)"></span><span>MSCI ACWI</span><span class="v ${signCls(acwi[idx] - 100)}">${fmtPct(acwi[idx] - 100)}</span></div>`;
    perfTip.classList.add('is-visible');
    perfTip.setAttribute('aria-hidden', 'false');
    perfTip.style.left = `${(cx / W) * 100}%`;
    perfTip.style.top  = `${(yOf(port[idx]) / perfGeom.H) * 100}%`;
  };
  const onPerfLeave = () => {
    const cross = $('#perf-cross');
    if (cross) cross.setAttribute('opacity', 0);
    perfTip.classList.remove('is-visible');
    perfTip.setAttribute('aria-hidden', 'true');
  };
  perfChart.addEventListener('mousemove', onPerfMove);
  perfChart.addEventListener('mouseleave', onPerfLeave);

  // ── Donut allocation chart ───────────────────────────────────────
  const renderDonut = () => {
    const svg = $('#donut');
    const legend = $('#alloc-legend');
    const cx = 80, cy = 80, rOuter = 68, rInner = 48;
    svg.innerHTML = '';
    legend.innerHTML = '';

    const total = allocation.reduce((s, a) => s + a.current, 0);
    let angle = -Math.PI / 2;

    allocation.forEach((a) => {
      const share = a.current / total;
      const slice = share * Math.PI * 2;
      const a0 = angle, a1 = angle + slice;
      angle = a1;
      const large = slice > Math.PI ? 1 : 0;

      const x0 = cx + rOuter * Math.cos(a0);
      const y0 = cy + rOuter * Math.sin(a0);
      const x1 = cx + rOuter * Math.cos(a1);
      const y1 = cy + rOuter * Math.sin(a1);
      const x2 = cx + rInner * Math.cos(a1);
      const y2 = cy + rInner * Math.sin(a1);
      const x3 = cx + rInner * Math.cos(a0);
      const y3 = cy + rInner * Math.sin(a0);

      const d = [
        `M${x0.toFixed(2)},${y0.toFixed(2)}`,
        `A${rOuter},${rOuter} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`,
        `L${x2.toFixed(2)},${y2.toFixed(2)}`,
        `A${rInner},${rInner} 0 ${large} 0 ${x3.toFixed(2)},${y3.toFixed(2)}`,
        'Z',
      ].join(' ');

      const p = svgEl('path', { d, fill: a.color, opacity: 0.92 });
      p.style.transition = 'opacity .2s';
      p.addEventListener('mouseenter', () => (p.style.opacity = 1));
      p.addEventListener('mouseleave', () => (p.style.opacity = 0.92));
      svg.appendChild(p);

      const drift = a.current - a.target;
      const driftCls = drift > 0 ? 'up' : drift < 0 ? 'down' : 'muted';
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="sw" style="background:${a.color}"></span>
        <span>${a.name}<br><span class="drift">Target ${a.target}% · drift <span class="${driftCls}">${drift >= 0 ? '+' : ''}${drift}pp</span></span></span>
        <span class="w">${a.current}%</span>
        <span class="drift">${fmtUSD(248_614_902 * (a.current / 100), 0)}</span>`;
      legend.appendChild(li);
    });

    // Centre label
    const centre1 = svgEl('text', {
      x: cx, y: cy - 4, 'text-anchor': 'middle',
      'font-family': 'Inter, sans-serif', 'font-size': 9,
      fill: 'var(--ink-3)', 'letter-spacing': '.16em',
    });
    centre1.textContent = 'AUM';
    svg.appendChild(centre1);
    const centre2 = svgEl('text', {
      x: cx, y: cy + 12, 'text-anchor': 'middle',
      'font-family': 'Fraunces, serif', 'font-size': 15,
      fill: 'var(--ink-0)', 'font-weight': 500,
    });
    centre2.textContent = '$248.6M';
    svg.appendChild(centre2);
  };

  // ── Exposure bars (geographic + currency) ─────────────────────────
  const renderBars = (rootSel, data) => {
    const root = $(rootSel);
    const max = Math.max(...data.map((d) => Math.max(d.current, d.target)));
    root.innerHTML = '';
    data.forEach((d, i) => {
      const drift = d.current - d.target;
      const driftCls = drift > 0 ? 'up' : drift < 0 ? 'down' : 'muted';
      const fillPct   = (d.current / max) * 100;
      const targetPct = (d.target / max) * 100;
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="name"><span class="flag">${d.flag}</span>${d.name}</div>
        <div class="rail">
          <span class="rail__fill" style="width:0%"></span>
          <span class="rail__target" style="left:${targetPct}%"></span>
        </div>
        <div class="w">${d.current}%</div>
        <div class="drift ${driftCls}">${drift >= 0 ? '+' : ''}${drift}pp</div>`;
      root.appendChild(li);
      // animate the fill in on next frame
      requestAnimationFrame(() => {
        li.querySelector('.rail__fill').style.width = fillPct + '%';
      });
    });
  };

  // Snapshot of the anchors the user can restore to (pre-override prices)
  const seedPx = new Map(holdings.map((h) => [h.sym, h.px]));

  // ── Inline price editing ─────────────────────────────────────────
  let paused = false;
  const setPaused = (v) => {
    paused = v;
    document.body.classList.toggle('ticks-paused', paused);
  };

  // Commit a manual price override. `isManual` sticks so random ticks
  // stop drifting away from the user's chosen level.
  const commitPrice = (sym, nextPx) => {
    const h = holdings.find((x) => x.sym === sym);
    if (!h || !Number.isFinite(nextPx) || nextPx <= 0) return false;
    h.px = nextPx;
    anchors.set(sym, nextPx);           // mean-revert to the new anchor
    h.isManual = true;
    persistManualPrices();
    renderHoldings();                   // re-render so % columns are consistent
    applyRowTags();
    recomputeAnalytics();
    liveTick();                         // refresh KPI totals immediately
    return true;
  };

  const applyRowTags = () => {
    holdings.forEach((h) => {
      const tr = holdingsBody.querySelector(`tr[data-sym="${h.sym}"]`);
      if (!tr) return;
      tr.classList.toggle('is-manual', !!h.isManual);
      const cell = tr.querySelector('[data-field="px"]');
      if (cell) cell.classList.toggle('is-manual', !!h.isManual);
    });
  };

  const beginEdit = (cell) => {
    if (cell.classList.contains('is-edit')) return;
    const tr = cell.closest('tr');
    const sym = tr.dataset.sym;
    const h = holdings.find((x) => x.sym === sym);
    const orig = cell.textContent;
    cell.classList.add('is-edit');
    cell.innerHTML = `<input class="px-input" type="number" step="0.01" min="0" value="${h.px.toFixed(2)}" />`;
    const inp = cell.querySelector('input');
    inp.focus(); inp.select();
    // While a cell is open, ticks are paused so the input doesn't get stomped.
    const wasPaused = paused;
    setPaused(true);

    const finish = (save) => {
      cell.classList.remove('is-edit');
      if (save) {
        const v = parseFloat(inp.value);
        if (!commitPrice(sym, v)) cell.textContent = orig;
      } else {
        cell.textContent = orig;
      }
      if (!wasPaused) setPaused(false);
    };

    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')      { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true), { once: true });
  };

  holdingsBody.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('td[data-field="px"]');
    if (cell) beginEdit(cell);
  });
  // Also allow a single click on the manual-override dot to edit
  holdingsBody.addEventListener('click', (e) => {
    const cell = e.target.closest('td[data-field="px"]');
    if (!cell) return;
    if (e.detail === 2) return; // dblclick handler takes over
  });

  // ── Pause / resume ticks ─────────────────────────────────────────
  $('#pause-ticks')?.addEventListener('click', () => setPaused(!paused));

  // ── Reset manual overrides ──────────────────────────────────────
  $('#reset-prices')?.addEventListener('click', () => {
    holdings.forEach((h) => {
      const orig = seedPx.get(h.sym);
      if (orig != null) { h.px = orig; anchors.set(h.sym, orig); }
      h.isManual = false;
    });
    persistManualPrices();
    renderHoldings();
    applyRowTags();
    recomputeAnalytics();
    liveTick();
  });

  // ── Bulk-update modal ────────────────────────────────────────────
  const modal       = $('#bulk-modal');
  const bulkInput   = $('#bulk-input');
  const bulkTickers = $('#bulk-tickers');
  const bulkStatus  = $('#bulk-status');
  const bulkApply   = $('#bulk-apply');

  if (bulkTickers) {
    bulkTickers.innerHTML = holdings.map((h) => `<span>${h.sym}</span>`).join('');
  }

  const openModal = () => {
    modal.hidden = false;
    setTimeout(() => bulkInput.focus(), 50);
  };
  const closeModal = () => { modal.hidden = true };

  $('#bulk-edit')?.addEventListener('click', openModal);
  modal?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.hidden) closeModal();
  });

  const parseBulk = (raw) => {
    const results = [];
    const errors  = [];
    raw.split(/\r?\n/).forEach((line, idx) => {
      const l = line.trim();
      if (!l) return;
      const parts = l.split(/[\s,\t]+/).filter(Boolean);
      if (parts.length < 2) { errors.push(`Line ${idx + 1}: need ticker and price`); return; }
      const sym = parts[0].toUpperCase().replace(/[^\w.-]/g, '');
      const px  = parseFloat(parts[1].replace(/[^\d.\-]/g, ''));
      if (!sym || !Number.isFinite(px) || px <= 0) {
        errors.push(`Line ${idx + 1}: could not parse "${l}"`); return;
      }
      const held = holdings.find((h) => h.sym === sym);
      if (!held) { errors.push(`Line ${idx + 1}: ${sym} is not in the book`); return; }
      results.push({ sym, px });
    });
    return { results, errors };
  };

  const updateBulkStatus = () => {
    if (!bulkInput) return;
    const { results, errors } = parseBulk(bulkInput.value);
    bulkStatus.className = 'modal__status';
    if (!results.length && !errors.length) {
      bulkStatus.classList.add('muted');
      bulkStatus.textContent = 'Awaiting input.';
    } else if (errors.length && !results.length) {
      bulkStatus.classList.add('err');
      bulkStatus.textContent = errors[0];
    } else if (errors.length) {
      bulkStatus.classList.add('ok');
      bulkStatus.textContent = `Ready to apply ${results.length} · ${errors.length} line(s) will be skipped`;
    } else {
      bulkStatus.classList.add('ok');
      bulkStatus.textContent = `Ready to apply ${results.length} price${results.length > 1 ? 's' : ''}`;
    }
  };
  bulkInput?.addEventListener('input', updateBulkStatus);

  bulkApply?.addEventListener('click', () => {
    const { results, errors } = parseBulk(bulkInput.value);
    if (!results.length) {
      bulkStatus.classList.remove('ok', 'muted');
      bulkStatus.classList.add('err');
      bulkStatus.textContent = errors[0] || 'Nothing to apply.';
      return;
    }
    results.forEach(({ sym, px }) => commitPrice(sym, px));
    bulkStatus.classList.remove('err', 'muted');
    bulkStatus.classList.add('ok');
    bulkStatus.textContent = `Applied ${results.length} price${results.length > 1 ? 's' : ''}.`;
    setTimeout(closeModal, 600);
  });

  // ── Transaction store (persisted to localStorage) ────────────────
  const TX_KEY = 'av-transactions-v1';
  const PX_KEY = 'av-manual-prices-v1';
  const storageGet = (k, fallback) => {
    try {
      const raw = localStorage.getItem(k);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  };
  const storageSet = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  };

  const seedTx = [
    { id: 't-seed-1', date: '2026-04-20', type: 'BUY',  symbol: 'NVDA', qty: 1200, price: 892.40, fee: 0,   ccy: 'USD', broker: 'Morgan Stanley',     notes: '' },
    { id: 't-seed-2', date: '2026-04-20', type: 'SELL', symbol: 'META', qty: 4500, price: 512.10, fee: 0,   ccy: 'USD', broker: 'Goldman Sachs',      notes: 'Trim' },
    { id: 't-seed-3', date: '2026-04-18', type: 'DIV',  symbol: 'MSFT', qty: 0,    price: 0,      fee: 0,   ccy: 'USD', broker: 'JPM',                notes: 'Cash dividend $18,420' },
    { id: 't-seed-4', date: '2026-04-17', type: 'FX',   symbol: 'CHFUSD', qty: 1000000, price: 1.1042, fee: 0, ccy: 'USD', broker: 'Pictet & Cie',    notes: 'CHF→USD' },
    { id: 't-seed-5', date: '2026-04-16', type: 'CALL', symbol: 'CARLYLE8', qty: 0, price: 420000, fee: 0,   ccy: 'USD', broker: 'Carlyle',            notes: 'Capital call · T+3' },
  ];
  let transactions = storageGet(TX_KEY, null);
  if (!Array.isArray(transactions)) {
    transactions = seedTx.slice();
    storageSet(TX_KEY, transactions);
  }

  // Restore manual price overrides from last session
  const manualPrices = storageGet(PX_KEY, {}) || {};
  Object.entries(manualPrices).forEach(([sym, px]) => {
    const h = holdings.find((x) => x.sym === sym);
    if (h && Number.isFinite(px) && px > 0) { h.px = px; h.isManual = true; anchors.set(sym, px); }
  });

  const persistManualPrices = () => {
    const map = {};
    holdings.forEach((h) => { if (h.isManual) map[h.sym] = h.px; });
    storageSet(PX_KEY, map);
  };
  const persistTx = () => storageSet(TX_KEY, transactions);

  // ── Live tick engine ─────────────────────────────────────────────
  // Each security gets a mean-reverting random walk around its anchor px.
  const anchors = new Map(holdings.map((h) => [h.sym, h.px]));
  const watchAnchors = new Map(watchlist.map((w) => [w.sym, w.px]));
  const dayOpen = new Map(holdings.map((h) => [h.sym, h.px * (1 - (rnd() - 0.5) * 0.01)]));

  const liveTick = () => {
    if (paused) return;
    // Holdings
    holdings.forEach((h) => {
      let next;
      if (h.isManual) {
        // Respect manual overrides — don't drift away from the user's price.
        next = h.px;
      } else {
        const anchor = anchors.get(h.sym);
        const meanRev = (anchor - h.px) * 0.02;
        const shock   = (rnd() - 0.5) * h.px * 0.0025;
        next    = Math.max(0.01, h.px + meanRev + shock);
      }
      const prev    = h.px;
      h.px = next;
      h.dayPct = ((h.px / dayOpen.get(h.sym)) - 1) * 100;

      const tr = holdingsBody.querySelector(`tr[data-sym="${h.sym}"]`);
      if (!tr) return;
      tr.querySelector('[data-field="px"]').textContent = fmtNum(h.px, 2);
      const mv = h.qty * h.px;
      tr.querySelector('[data-field="mv"]').textContent = fmtUSD(mv);

      const dayCell = tr.querySelector('[data-field="day"]');
      const dayAbs = mv * (h.dayPct / 100);
      dayCell.className = 'num ' + signCls(h.dayPct);
      dayCell.innerHTML = `${fmtPct(h.dayPct)}<br><span class="small">${fmtDelta(dayAbs)}</span>`;

      const pnl   = (h.px - h.cost) * h.qty;
      const pnlPc = ((h.px / h.cost) - 1) * 100;
      const pnlCell = tr.querySelector('[data-field="pnl"]');
      pnlCell.className = 'num ' + signCls(pnl);
      pnlCell.innerHTML = `${fmtDelta(pnl)}<br><span class="small">${fmtPct(pnlPc)}</span>`;

      if (next > prev) tr.classList.remove('flash-down'), tr.classList.add('flash-up');
      else if (next < prev) tr.classList.remove('flash-up'), tr.classList.add('flash-down');
      setTimeout(() => tr.classList.remove('flash-up', 'flash-down'), 900);
    });

    // Recompute portfolio weights
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    holdings.forEach((h) => {
      const tr = holdingsBody.querySelector(`tr[data-sym="${h.sym}"]`);
      if (!tr) return;
      const lastCell = tr.lastElementChild;
      lastCell.textContent = ((h.qty * h.px / totalMV) * 100).toFixed(1) + '%';
    });

    // Hero KPIs — the listed positions are the tracked book; the remainder
    // reflects private markets, hedge funds, real assets and cash & equivalents
    // (consolidated from multiple custodians). These sleeves are held flat
    // intraday because they don't tick with public markets.
    const OTHER_SLEEVE_VAL  = 191_000_000;   // non-equity book
    const OTHER_SLEEVE_COST = 162_300_000;   // weighted cost of the sleeve
    const costBasis = holdings.reduce((s, h) => s + h.cost * h.qty, 0) + OTHER_SLEEVE_COST;
    const aum       = totalMV + OTHER_SLEEVE_VAL;
    const pnl       = aum - costBasis;
    const dayPnl    = holdings.reduce((s, h) => s + h.qty * h.px * ((h.dayPct || 0) / 100), 0);
    const dayPct    = (dayPnl / (aum - dayPnl)) * 100;

    $('[data-anim="aum"]').textContent = fmtUSD(aum);
    $('[data-anim="pnl"]').textContent = (pnl >= 0 ? '+' : '') + fmtUSD(pnl);
    $('[data-anim="pnl"]').className = 'kpi__value ' + signCls(pnl);
    $('[data-anim="day"]').textContent = (dayPnl >= 0 ? '+' : '') + fmtUSD(dayPnl);
    $('[data-anim="day"]').className = 'kpi__value ' + signCls(dayPnl);
    $('#kpi-aum-delta').className = signCls(dayPnl);
    $('#kpi-aum-delta').textContent = (dayPnl >= 0 ? '▲ ' : '▼ ') + fmtUSD(Math.abs(dayPnl)) + ' today';
    const hero = $('#hero-day-return');
    hero.textContent = fmtPct(dayPct);
    hero.className = signCls(dayPct);

    // Watchlist
    watchlist.forEach((w) => {
      const anchor = watchAnchors.get(w.sym);
      const meanRev = (anchor - w.px) * 0.02;
      const mag = w.isYield ? 0.0006 : 0.002;
      const shock = (rnd() - 0.5) * w.px * mag;
      const next = Math.max(0.01, w.px + meanRev + shock);
      const prev = w.px;
      w.px = next;
      w.pct += (rnd() - 0.5) * 0.05;

      const li = watchList.querySelector(`li[data-sym="${w.sym}"]`);
      if (!li) return;
      const priceEl = li.querySelector('[data-field="px"]');
      const pctEl   = li.querySelector('[data-field="pct"]');
      priceEl.textContent = w.isYield ? w.px.toFixed(2) + '%' : fmtNum(w.px, 2);
      pctEl.textContent   = fmtPct(w.pct);
      pctEl.className     = 'change ' + signCls(w.pct);

      if (next > prev) li.classList.remove('flash-down'), li.classList.add('flash-up');
      else if (next < prev) li.classList.remove('flash-up'), li.classList.add('flash-down');
      setTimeout(() => li.classList.remove('flash-up', 'flash-down'), 900);
    });

    recomputeAnalytics();
  };

  // ── Segmented range: re-scale performance series visually ────────
  $$('.segmented button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.segmented button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      // Fake range change: mutate the series endpoint to reflect a different horizon.
      const range = btn.dataset.range;
      const mult  = { '1M': 0.32, '3M': 0.68, 'YTD': 1, '1Y': 1.42, '5Y': 3.1, 'ALL': 4.8 }[range] || 1;
      perfSeries.port = perfSeries.port.map((v, i, a) => 100 + (v - 100) * mult * (0.9 + 0.2 * i / a.length));
      perfSeries.bm   = perfSeries.bm.map  ((v, i, a) => 100 + (v - 100) * mult * 0.8);
      perfSeries.acwi = perfSeries.acwi.map((v, i, a) => 100 + (v - 100) * mult * 0.7);
      renderPerf();
    });
  });

  // ── Top-holdings tabs (visual only; Equities is the populated view) ─
  $$('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  // ── Boot ─────────────────────────────────────────────────────────
  renderHoldings();
  renderWatch();
  renderKpiSparks();
  renderPerf();
  renderDonut();
  renderBars('#geo-bars', geographic);
  renderBars('#fx-bars', currency);

  // ── Analytics (concentration, VaR, stress) ───────────────────────
  const recomputeAnalytics = () => {
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    const OTHER_SLEEVE_VAL = 191_000_000;
    const aum = totalMV + OTHER_SLEEVE_VAL;

    // Top 5 single-name concentration (by MV, with limit markers)
    const ranked = holdings
      .map((h) => ({
        sym: h.sym,
        name: h.name.split(/[,·]/)[0].replace(/ Corp\.| Inc\.| Holding| SA| Partners.*/, '').trim(),
        flag: flagBySym[h.sym] || '🌐',
        current: +(h.qty * h.px / aum * 100).toFixed(2),
        target: concentrationLimits[h.sym] || 5,
      }))
      .sort((a, b) => b.current - a.current)
      .slice(0, 5);
    renderBars('#risk-bars', ranked);

    // Portfolio daily vol from the perf series (approx)
    const port = perfSeries.port;
    const rets = [];
    for (let i = 1; i < port.length; i++) rets.push(port[i] / port[i - 1] - 1);
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mu) ** 2, 0) / rets.length;
    const sigma = Math.sqrt(variance); // daily
    const z95 = 1.645, cvarZ = 2.063;
    const varUsd  = z95 * sigma * aum;
    const cvarUsd = cvarZ * sigma * aum;
    $('#risk-var').textContent  = fmtUSD(varUsd);
    $('#risk-var-pct').textContent = fmtPct(varUsd / aum * 100).replace('+', '') + ' of AUM';
    $('#risk-cvar').textContent = fmtUSD(cvarUsd);
    $('#risk-cvar-pct').textContent = fmtPct(cvarUsd / aum * 100).replace('+', '') + ' · tail loss';

    const annVol = sigma * Math.sqrt(252);
    $('#risk-te').textContent = (annVol * 0.38 * 100).toFixed(1) + '%'; // TE ~ active vol
    const sharpe = annVol > 0 ? ((0.1174 - 0.04) / annVol).toFixed(2) : '—';
    $('#risk-ir').textContent = sharpe;

    // Stress scenarios computed from per-position sensitivities
    const spxShock    = holdings.reduce((s, h) => s + h.qty * h.px * (-0.10 * h.beta), 0);
    const ratesShock  = holdings.reduce((s, h) => s + h.qty * h.px * (-0.01 * h.dur), 0)
                      + holdings.reduce((s, h) => s + h.qty * h.px * (-0.003 * h.beta), 0) * 0.3;
    const usdShock    = holdings.reduce((s, h) => s + h.qty * h.px * (0.05 * h.fx + 0.03 * h.gold), 0);
    const creditShock = holdings.reduce((s, h) => s + h.qty * h.px * (-0.005 * (h.dur > 0 ? 0.6 : 0.02)), 0);

    const setStress = (key, v) => {
      const el = $(`[data-stress="${key}"]`);
      if (!el) return;
      el.textContent = (v >= 0 ? '+' : '−') + fmtUSD(Math.abs(v));
      el.className = 'num ' + signCls(v);
    };
    setStress('rates',  ratesShock);
    setStress('spx',    spxShock);
    setStress('usd',    usdShock);
    setStress('credit', creditShock);
  };

  // ── Events list ──────────────────────────────────────────────────
  const eventsList = $('#events');
  if (eventsList) {
    eventsList.innerHTML = events.map((e) => `
      <li>
        <div class="date"><span class="d">${e.d}</span><span class="m">${e.m}</span></div>
        <div class="label"><strong>${e.label}</strong><span>${e.meta}</span></div>
        <span class="badge-tag ${e.cls}">${e.tag}</span>
      </li>`).join('');
  }

  // ── Transaction feed / CRUD ──────────────────────────────────────
  const txModal   = $('#tx-modal');
  const txForm    = $('#tx-form');
  const txTitle   = $('#tx-title');
  const txSubtitle= $('#tx-subtitle');
  const txIdInput = $('#tx-id');
  const txDate    = $('#tx-date');
  const txType    = $('#tx-type');
  const txSymbol  = $('#tx-symbol');
  const txQty     = $('#tx-qty');
  const txPrice   = $('#tx-price');
  const txFee     = $('#tx-fee');
  const txCcy     = $('#tx-ccy');
  const txBroker  = $('#tx-broker');
  const txNotes   = $('#tx-notes');
  const txStatus  = $('#tx-status');
  const txDelete  = $('#tx-delete');
  const txSymbolsList = $('#tx-symbols');

  // Populate the symbol datalist with the current book + common FX pairs
  if (txSymbolsList) {
    const symbolHints = [
      ...holdings.map((h) => h.sym),
      'META','AMZN','GOOG','UNH','JNJ','V','MA','KO','PEP','SAP','ROG','NOVN','BABA','TSM',
      'CHFUSD','EURUSD','GBPUSD','USDJPY','USDSGD',
      'CARLYLE8','BXP10','SEQUOIA4',
    ];
    txSymbolsList.innerHTML = [...new Set(symbolHints)].map((s) => `<option value="${s}"></option>`).join('');
  }

  const fmtDateShort = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(+d) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  };
  const fmtDateLong = (iso) => {
    const d = new Date(iso + 'T00:00:00');
    return isNaN(+d) ? iso : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const dotClassFor = (type) => ({ BUY: 'up', SELL: 'down' }[type] || '');
  const describeTx = (t) => {
    const n = (v, f = 2) => Number.isFinite(+v) ? (+v).toLocaleString('en-US', { minimumFractionDigits: f, maximumFractionDigits: f }) : v;
    switch (t.type) {
      case 'BUY':  return `Bought ${n(t.qty, 0)} ${t.symbol} @ ${t.ccy} ${n(t.price)}`;
      case 'SELL': return `Sold ${n(t.qty, 0)} ${t.symbol} @ ${t.ccy} ${n(t.price)}`;
      case 'DIV':  return `Dividend · ${t.symbol}${t.price ? ` ${t.ccy} ${n(t.price, 0)}` : ''}`;
      case 'CPN':  return `Coupon · ${t.symbol}${t.price ? ` ${t.ccy} ${n(t.price, 2)}` : ''}`;
      case 'CALL': return `Capital call · ${t.symbol} ${t.ccy} ${n(t.price, 0)}`;
      case 'FX':   return `${t.symbol} ${n(t.qty, 0)} @ ${n(t.price, 4)}`;
      case 'TRF':  return `Transfer · ${t.symbol} ${n(t.qty, 0)}`;
      default:     return `${t.type} · ${t.symbol}`;
    }
  };
  const txMeta = (t) => [t.broker, fmtDateLong(t.date), t.notes].filter(Boolean).join(' · ');

  const feedEl  = $('#feed');
  const txCount = $('#tx-count');
  const txLast  = $('#tx-last');

  const renderFeed = () => {
    if (!feedEl) return;
    if (!transactions.length) {
      feedEl.innerHTML = `<li class="empty"><span class="big">No transactions yet</span><span>Use <strong>+ New</strong> to record a trade, dividend or capital event.</span></li>`;
    } else {
      const sorted = transactions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''));
      feedEl.innerHTML = sorted.map((t) => `
        <li data-id="${t.id}">
          <span class="feed__dot ${dotClassFor(t.type)}">${t.type}</span>
          <div>
            <strong>${describeTx(t)}</strong>
            <span class="muted">${txMeta(t)}</span>
          </div>
        </li>`).join('');
    }
    txCount.textContent = transactions.length;
    txLast.textContent  = transactions.length ? fmtDateLong(transactions.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0].date) : 'never';
  };

  feedEl?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    openTxModal(li.dataset.id);
  });

  const openTxModal = (id = null) => {
    txForm.reset();
    if (id) {
      const t = transactions.find((x) => x.id === id);
      if (!t) return;
      txTitle.textContent = 'Edit transaction';
      txSubtitle.textContent = `Transaction ${t.id}`;
      txIdInput.value  = t.id;
      txDate.value     = t.date || '';
      txType.value     = t.type || 'BUY';
      txSymbol.value   = t.symbol || '';
      txQty.value      = t.qty ?? '';
      txPrice.value    = t.price ?? '';
      txFee.value      = t.fee ?? '';
      txCcy.value      = t.ccy || 'USD';
      txBroker.value   = t.broker || '';
      txNotes.value    = t.notes || '';
      txDelete.hidden  = false;
    } else {
      txTitle.textContent = 'New transaction';
      txSubtitle.textContent = 'Record a buy, sell, dividend, FX or capital event';
      txIdInput.value = '';
      txDate.value    = new Date().toISOString().slice(0, 10);
      txType.value    = 'BUY';
      txCcy.value     = 'USD';
      txDelete.hidden = true;
    }
    txStatus.className = 'modal__status muted';
    txStatus.textContent = 'Fills Notional = Qty × Price − Fee · all figures can be edited later.';
    txModal.hidden = false;
    setTimeout(() => txSymbol.focus(), 60);
  };
  const closeTxModal = () => { txModal.hidden = true };

  $('#tx-new')?.addEventListener('click', () => openTxModal(null));
  txModal?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeTxModal));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && txModal && !txModal.hidden) closeTxModal();
  });

  // Apply a transaction's effect to the positions book.
  // For un-booked symbols (e.g. META, TSM) we only record the transaction —
  // we don't silently create a new holding row unless it's a BUY on a known
  // symbol, which keeps the book consistent.
  const applyToBook = (t) => {
    const h = holdings.find((x) => x.sym === t.symbol);
    if (!h) return;
    const qty = +t.qty || 0;
    const px  = +t.price || 0;
    const fee = +t.fee || 0;
    if (t.type === 'BUY' && qty > 0) {
      const oldNotional = h.qty * h.cost;
      const newNotional = oldNotional + qty * px + fee;
      h.qty  = h.qty + qty;
      h.cost = h.qty > 0 ? newNotional / h.qty : h.cost;
    } else if (t.type === 'SELL' && qty > 0) {
      h.qty = Math.max(0, h.qty - qty);
    }
    // Dividends, coupons, capital calls don't change qty/cost here;
    // they'd flow through the cash ledger in a real system.
  };

  txForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = {
      id:      txIdInput.value || ('t-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)),
      date:    txDate.value,
      type:    txType.value,
      symbol:  (txSymbol.value || '').trim().toUpperCase(),
      qty:     txQty.value === '' ? 0 : +txQty.value,
      price:   txPrice.value === '' ? 0 : +txPrice.value,
      fee:     txFee.value === '' ? 0 : +txFee.value,
      ccy:     txCcy.value,
      broker:  txBroker.value.trim(),
      notes:   txNotes.value.trim(),
    };
    if (!data.date) { txStatus.className = 'modal__status err'; txStatus.textContent = 'Please pick a date.'; return; }
    if (!data.symbol) { txStatus.className = 'modal__status err'; txStatus.textContent = 'Please enter a symbol.'; return; }

    const existingIdx = transactions.findIndex((x) => x.id === data.id);
    const isEdit = existingIdx >= 0;
    if (isEdit) transactions[existingIdx] = data;
    else        transactions.push(data);

    persistTx();
    // Only apply the book-level effect on create; editing a past trade
    // shouldn't double-count against qty/cost. Users can adjust the book
    // directly through inline price edits or a reversing transaction.
    if (!isEdit) applyToBook(data);
    renderFeed();
    renderHoldings();
    applyRowTags();
    recomputeAnalytics();
    liveTick();

    txStatus.className = 'modal__status ok';
    txStatus.textContent = isEdit ? 'Transaction updated.' : 'Transaction saved.';
    setTimeout(closeTxModal, 500);
  });

  txDelete?.addEventListener('click', () => {
    const id = txIdInput.value;
    if (!id) return;
    if (!confirm('Delete this transaction? This cannot be undone.')) return;
    transactions = transactions.filter((x) => x.id !== id);
    persistTx();
    renderFeed();
    closeTxModal();
  });

  // ── Import / Export JSON ─────────────────────────────────────────
  $('#tx-export')?.addEventListener('click', () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      source: 'Ashford & Vere Dashboard',
      transactions,
      manualPrices,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `av-transactions-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 250);
  });

  $('#tx-import')?.addEventListener('click', () => $('#tx-import-file').click());
  $('#tx-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const incoming = Array.isArray(parsed) ? parsed : parsed.transactions;
        if (!Array.isArray(incoming)) throw new Error('No transactions array found.');
        if (!confirm(`Import ${incoming.length} transactions? This will merge with the ${transactions.length} already saved.`)) return;
        // Merge by id; imported rows overwrite duplicates.
        const byId = new Map(transactions.map((t) => [t.id, t]));
        incoming.forEach((t) => { if (t && t.id) byId.set(t.id, t); });
        transactions = Array.from(byId.values());
        persistTx();
        // Optional: replay BUY/SELL effects on the book? We don't re-apply on
        // import to avoid double-counting seeded positions; the user can
        // reset prices + edit holdings manually if needed.
        renderFeed();
      } catch (err) {
        alert('Could not read JSON file: ' + err.message);
      } finally {
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  // ── Theme toggle ────────────────────────────────────────────────
  const themeBtn = $('#theme-toggle');
  const savedTheme = localStorage.getItem('av-theme');
  if (savedTheme) document.body.dataset.theme = savedTheme;
  themeBtn?.addEventListener('click', () => {
    const next = document.body.dataset.theme === 'day' ? 'night' : 'day';
    document.body.dataset.theme = next;
    localStorage.setItem('av-theme', next);
    // Re-render SVG charts so stroke/fill custom-property values recompute
    renderKpiSparks();
    renderPerf();
    renderDonut();
  });

  // ── Sidebar navigation: smooth scroll + active-state tracking ────
  const navLinks = $$('.nav__item[data-scroll]');
  const sectionMap = Object.fromEntries(
    navLinks.map((a) => [a.dataset.scroll, a])
  );
  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top, behavior: 'smooth' });
    history.replaceState(null, '', '#' + id);
  };
  navLinks.forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      scrollToSection(a.dataset.scroll);
    });
  });
  // If the URL already has a hash, honour it on load
  if (location.hash && document.getElementById(location.hash.slice(1))) {
    setTimeout(() => scrollToSection(location.hash.slice(1)), 100);
  }
  // Active state via IntersectionObserver
  const sections = Object.keys(sectionMap)
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if ('IntersectionObserver' in window && sections.length) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          navLinks.forEach((a) => a.classList.toggle('is-active', a.dataset.scroll === id));
        }
      });
    }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });
    sections.forEach((s) => io.observe(s));
  }

  // ── Notifications popover ────────────────────────────────────────
  const notifBtn = $('#notif-btn');
  const notifPop = $('#notif-popover');
  const notifList = $('#notif-list');
  const notifBadge = $('#notif-badge');
  const NOTIF_KEY = 'av-notif-read-v1';
  const readNotifs = new Set(storageGet(NOTIF_KEY, []));

  const buildNotifications = () => {
    const out = [];
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    const aum = totalMV + 191_000_000;
    // Concentration breaches
    holdings.forEach((h) => {
      const limit = concentrationLimits[h.sym];
      if (!limit) return;
      const wt = h.qty * h.px / aum * 100;
      if (wt > limit) {
        out.push({
          id: 'conc-' + h.sym,
          tone: 'down',
          title: `${h.sym} concentration ${wt.toFixed(1)}% exceeds ${limit}% limit`,
          meta: 'Risk policy · single-name cap',
          time: 'Now',
        });
      }
    });
    // Upcoming capital calls
    events.filter((e) => e.cls === 'call').slice(0, 2).forEach((e) => {
      out.push({
        id: 'ev-' + e.d + e.m,
        tone: '',
        title: e.label,
        meta: e.meta,
        time: `${e.d} ${e.m}`,
      });
    });
    // Allocation drift > 2pp
    allocation.forEach((a) => {
      const drift = a.current - a.target;
      if (Math.abs(drift) > 2) {
        out.push({
          id: 'drift-' + a.name,
          tone: drift > 0 ? 'up' : 'down',
          title: `${a.name} is ${drift > 0 ? '+' : ''}${drift}pp vs target`,
          meta: `Current ${a.current}% · Target ${a.target}%`,
          time: 'Today',
        });
      }
    });
    return out;
  };
  const renderNotifs = () => {
    const items = buildNotifications();
    const unread = items.filter((i) => !readNotifs.has(i.id)).length;
    notifBadge.textContent = unread;
    notifBadge.style.display = unread ? '' : 'none';
    if (!items.length) {
      notifList.innerHTML = `<li class="empty">All clear · no open alerts</li>`;
      return;
    }
    notifList.innerHTML = items.map((i) => `
      <li data-id="${i.id}" class="${readNotifs.has(i.id) ? 'read' : ''}">
        <span class="pin ${i.tone}"></span>
        <div><strong>${i.title}</strong><span class="muted">${i.meta}</span></div>
        <span class="time">${i.time}</span>
      </li>`).join('');
  };
  const toggleNotif = (open) => {
    const next = open ?? notifPop.hidden;
    notifPop.hidden = !next;
    notifBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
    document.body.classList.toggle('notif-open', next);
    if (next) renderNotifs();
  };
  notifBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotif();
  });
  document.addEventListener('click', (e) => {
    if (!notifPop || notifPop.hidden) return;
    if (!notifPop.contains(e.target) && e.target !== notifBtn) toggleNotif(false);
  });
  $('#notif-clear')?.addEventListener('click', () => {
    buildNotifications().forEach((i) => readNotifs.add(i.id));
    storageSet(NOTIF_KEY, Array.from(readNotifs));
    renderNotifs();
  });
  notifList?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    readNotifs.add(li.dataset.id);
    storageSet(NOTIF_KEY, Array.from(readNotifs));
    renderNotifs();
  });

  // ── Command palette (⌘K / Ctrl+K) ────────────────────────────────
  const cmdModal = $('#cmd-modal');
  const cmdInput = $('#cmd-input');
  const cmdList  = $('#cmd-list');
  let cmdActiveIdx = 0;
  let cmdResults = [];

  const baseCommands = () => {
    const out = [];
    // Sections
    [
      ['overview', 'Go to Overview', 'Section'],
      ['performance', 'Go to Performance', 'Section'],
      ['allocation', 'Go to Allocation', 'Section'],
      ['holdings-section', 'Go to Holdings', 'Section'],
      ['watchlist-card', 'Go to Watchlist', 'Section'],
      ['exposure', 'Go to Exposure', 'Section'],
      ['risk', 'Go to Risk & Analytics', 'Section'],
      ['events', 'Go to Events', 'Section'],
      ['private-markets', 'Go to Private Markets', 'Section'],
      ['cash', 'Go to Cash & FX', 'Section'],
      ['activity', 'Go to Activity', 'Section'],
    ].forEach(([id, label, group]) => out.push({ kind: 'scroll', target: id, label, group, k: id.slice(0, 2).toUpperCase() }));
    // Actions
    out.push({ kind: 'action', label: 'New transaction',            group: 'Action', k: '+',  act: () => openTxModal(null) });
    out.push({ kind: 'action', label: 'Add position',               group: 'Action', k: '+',  act: () => openPosModal() });
    out.push({ kind: 'action', label: 'Bulk update prices',         group: 'Action', k: '¶',  act: () => $('#bulk-edit').click() });
    out.push({ kind: 'action', label: 'Reset manual prices',        group: 'Action', k: '↺',  act: () => $('#reset-prices').click() });
    out.push({ kind: 'action', label: 'Pause / resume live ticks',  group: 'Action', k: '⏸',  act: () => setPaused(!paused) });
    out.push({ kind: 'action', label: 'Rebalance proposal',         group: 'Action', k: '⇄',  act: () => openRebalance() });
    out.push({ kind: 'action', label: 'Export statement (CSV)',     group: 'Action', k: '↓',  act: () => exportStatementCSV() });
    out.push({ kind: 'action', label: 'Export transactions (JSON)', group: 'Action', k: '↓',  act: () => $('#tx-export').click() });
    out.push({ kind: 'action', label: 'Import transactions (JSON)', group: 'Action', k: '↑',  act: () => $('#tx-import').click() });
    out.push({ kind: 'action', label: 'Toggle day / night theme',   group: 'Action', k: '☼',  act: () => themeBtn.click() });
    // Holdings
    holdings.forEach((h) => out.push({
      kind: 'holding', sym: h.sym, label: `${h.sym} · ${h.name}`, group: 'Holding', k: h.sym.slice(0, 2),
      meta: `Qty ${fmtNum(h.qty, 0)} · last ${fmtNum(h.px, 2)}`,
      act: () => {
        scrollToSection('holdings-section');
        setTimeout(() => {
          const tr = holdingsBody.querySelector(`tr[data-sym="${h.sym}"]`);
          if (!tr) return;
          tr.classList.add('flash-up');
          setTimeout(() => tr.classList.remove('flash-up'), 900);
          tr.querySelector('[data-field="px"]')?.scrollIntoView({ block: 'center' });
        }, 350);
      },
    }));
    // Watchlist
    watchlist.forEach((w) => out.push({
      kind: 'watch', sym: w.sym, label: `${w.sym} · ${w.name}`, group: 'Watchlist', k: w.sym.slice(0, 2),
      meta: `Last ${fmtNum(w.px, 2)}`,
      act: () => scrollToSection('watchlist-card'),
    }));
    return out;
  };

  const filterCommands = (q) => {
    const needle = q.trim().toLowerCase();
    const all = baseCommands();
    if (!needle) return all.slice(0, 30);
    const scored = [];
    all.forEach((c) => {
      const hay = (c.label + ' ' + (c.sym || '') + ' ' + c.group).toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx >= 0) scored.push({ c, score: idx });
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.c).slice(0, 50);
  };

  const renderCmd = () => {
    cmdResults = filterCommands(cmdInput.value);
    if (!cmdResults.length) {
      cmdList.innerHTML = `<li class="group">No matches</li>`;
      return;
    }
    // Group-by insertion order, with separators
    const html = [];
    let lastGroup = '';
    cmdResults.forEach((c, i) => {
      if (c.group !== lastGroup) {
        html.push(`<li class="group">${c.group}</li>`);
        lastGroup = c.group;
      }
      html.push(`
        <li data-idx="${i}" class="${i === cmdActiveIdx ? 'is-active' : ''}">
          <span class="k">${c.k || '·'}</span>
          <div><strong>${c.label}</strong>${c.meta ? `<div class="meta">${c.meta}</div>` : ''}</div>
          <span class="hint">↵</span>
        </li>`);
    });
    cmdList.innerHTML = html.join('');
  };

  const runCmd = (c) => {
    if (!c) return;
    if (c.kind === 'scroll') scrollToSection(c.target);
    else if (c.act) c.act();
    closeCmd();
  };
  const openCmd = () => {
    cmdModal.hidden = false;
    cmdInput.value = '';
    cmdActiveIdx = 0;
    renderCmd();
    setTimeout(() => cmdInput.focus(), 30);
  };
  const closeCmd = () => { cmdModal.hidden = true };

  cmdInput?.addEventListener('input', () => { cmdActiveIdx = 0; renderCmd(); });
  cmdInput?.addEventListener('keydown', (e) => {
    const visible = cmdResults.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); cmdActiveIdx = Math.min(visible - 1, cmdActiveIdx + 1); renderCmd(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); cmdActiveIdx = Math.max(0, cmdActiveIdx - 1); renderCmd(); }
    else if (e.key === 'Enter')     { e.preventDefault(); runCmd(cmdResults[cmdActiveIdx]); }
    else if (e.key === 'Escape')    { e.preventDefault(); closeCmd(); }
  });
  cmdList?.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (!li) return;
    runCmd(cmdResults[+li.dataset.idx]);
  });
  cmdModal?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeCmd));
  $('#nav-search')?.addEventListener('click', (e) => { e.preventDefault(); openCmd(); });
  $('#nav-advisor')?.addEventListener('click', (e) => {
    e.preventDefault();
    const adv = document.querySelector('.card--advisor');
    if (adv) {
      adv.scrollIntoView({ behavior: 'smooth', block: 'center' });
      adv.animate([{ boxShadow: '0 0 0 3px rgba(200,168,107,.6)' }, { boxShadow: '0 0 0 0 rgba(200,168,107,0)' }], { duration: 1100 });
    }
  });
  // Advisor inline buttons
  $$('.card--advisor .btn').forEach((b) => b.addEventListener('click', () => {
    alert('A secure message has been queued for Eleanor Marchetti. She typically responds within 2 hours.');
  }));

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const inForm = target && /INPUT|TEXTAREA|SELECT/.test(target.tagName) && !target.closest('#cmd-modal');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (cmdModal.hidden) openCmd(); else closeCmd();
      return;
    }
    if (inForm) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === '1' || e.key === '2' || e.key === '3')) {
      e.preventDefault();
      const map = { '1': 'overview', '2': 'holdings-section', '3': 'performance' };
      scrollToSection(map[e.key]);
    }
  });

  // ── Watchlist CRUD ───────────────────────────────────────────────
  const WATCH_KEY = 'av-watchlist-v1';
  const savedWatch = storageGet(WATCH_KEY, null);
  if (Array.isArray(savedWatch) && savedWatch.length) {
    watchlist.length = 0;
    savedWatch.forEach((w) => watchlist.push(w));
  }
  const persistWatch = () => storageSet(WATCH_KEY, watchlist);
  const wrapRender = () => { renderWatch(); bindWatchRemove(); };
  const bindWatchRemove = () => {
    $$('#watchlist li').forEach((li) => {
      if (li.querySelector('.remove')) return;
      const btn = document.createElement('button');
      btn.className = 'remove';
      btn.innerHTML = `<svg viewBox="0 0 20 20" width="12" height="12" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round"><path d="M5 5l10 10M15 5 5 15"/></svg>`;
      btn.title = 'Remove from watchlist';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = li.dataset.sym;
        const i = watchlist.findIndex((w) => w.sym === sym);
        if (i >= 0) watchlist.splice(i, 1);
        persistWatch();
        wrapRender();
      });
      li.appendChild(btn);
    });
  };
  // Re-run the binding whenever the list is rendered
  const origRenderWatch = renderWatch;
  // (shadow — use a wrapper to keep behaviour but bind removes)
  const wForm = $('#watch-add-form');
  $('#watch-add')?.addEventListener('click', () => {
    wForm.hidden = !wForm.hidden;
    if (!wForm.hidden) setTimeout(() => $('#watch-sym').focus(), 40);
  });
  $('#watch-cancel')?.addEventListener('click', () => {
    wForm.hidden = true; wForm.reset();
  });
  wForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const sym = ($('#watch-sym').value || '').trim().toUpperCase();
    const name = ($('#watch-name').value || '').trim() || sym;
    const px = parseFloat($('#watch-px').value);
    if (!sym || !Number.isFinite(px) || px <= 0) return;
    if (watchlist.some((w) => w.sym === sym)) return;
    watchlist.push({ sym, name, px, pct: 0 });
    watchAnchors.set(sym, px);
    persistWatch();
    wrapRender();
    wForm.hidden = true; wForm.reset();
  });
  // Initial bind
  bindWatchRemove();

  // ── Positions CRUD ───────────────────────────────────────────────
  const posModal = $('#pos-modal');
  const posForm  = $('#pos-form');
  const openPosModal = () => {
    posForm.reset();
    $('#pos-beta').value = 1;
    $('#pos-dur').value = 0;
    $('#pos-fx').value = 0;
    $('#pos-gold').value = 0;
    posModal.hidden = false;
    setTimeout(() => $('#pos-sym').focus(), 50);
  };
  const closePosModal = () => { posModal.hidden = true };
  posModal?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closePosModal));
  $('#add-position')?.addEventListener('click', openPosModal);

  posForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const sym = $('#pos-sym').value.trim().toUpperCase();
    if (!sym) return;
    if (holdings.some((h) => h.sym === sym)) { alert(`${sym} is already in the book.`); return; }
    const pos = {
      sym,
      name:   $('#pos-name').value.trim()   || sym,
      sector: $('#pos-sector').value.trim() || 'Custom',
      qty:    parseFloat($('#pos-qty').value)   || 0,
      cost:   parseFloat($('#pos-cost').value)  || 0,
      px:     parseFloat($('#pos-px').value)    || 0,
      beta:   parseFloat($('#pos-beta').value)  || 0,
      dur:    parseFloat($('#pos-dur').value)   || 0,
      fx:     parseFloat($('#pos-fx').value)    || 0,
      gold:   parseFloat($('#pos-gold').value)  || 0,
    };
    holdings.push(pos);
    anchors.set(sym, pos.px);
    dayOpen.set(sym, pos.px);
    seedPx.set(sym, pos.px);
    renderHoldings();
    bindRowRemove();
    applyRowTags();
    recomputeAnalytics();
    liveTick();
    closePosModal();
  });

  const bindRowRemove = () => {
    $$('#holdings tbody .row-remove').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.remove;
        if (!confirm(`Remove ${sym} from the book?`)) return;
        const i = holdings.findIndex((h) => h.sym === sym);
        if (i >= 0) holdings.splice(i, 1);
        anchors.delete(sym); dayOpen.delete(sym); seedPx.delete(sym);
        renderHoldings();
        bindRowRemove();
        applyRowTags();
        recomputeAnalytics();
        liveTick();
      });
    });
  };

  // ── Export statement (CSV) ──────────────────────────────────────
  const exportStatementCSV = () => {
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    const headers = ['Symbol','Instrument','Sector','Quantity','Cost','Last','Market Value','Unrealised P&L','% Port'];
    const rows = holdings.map((h) => {
      const mv = h.qty * h.px;
      const pnl = (h.px - h.cost) * h.qty;
      const wt = mv / totalMV * 100;
      return [h.sym, h.name, h.sector, h.qty, h.cost.toFixed(4), h.px.toFixed(4), mv.toFixed(2), pnl.toFixed(2), wt.toFixed(2) + '%'];
    });
    const csv = [headers, ...rows]
      .map((r) => r.map((v) => {
        const s = String(v);
        return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `av-statement-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  };
  $('#export-statement')?.addEventListener('click', exportStatementCSV);

  // ── Rebalance proposal ──────────────────────────────────────────
  const openRebalance = () => {
    const totalMV = holdings.reduce((s, h) => s + h.qty * h.px, 0);
    const aum = totalMV + 191_000_000;
    const rows = allocation.map((a) => {
      const drift = a.current - a.target;
      const shift = -drift / 100 * aum;
      return { name: a.name, current: a.current, target: a.target, drift, shift };
    });
    const body = $('#reb-body');
    body.innerHTML = `
      <p class="muted" style="margin:0 0 10px">Proposed trades to return to strategic weights on <strong>${fmtUSD(aum, 0)}</strong> of AUM.</p>
      <table class="reb-table">
        <thead><tr>
          <th>Asset class</th>
          <th class="num">Current</th>
          <th class="num">Target</th>
          <th class="num">Drift</th>
          <th class="num">Trade</th>
          <th>Action</th>
        </tr></thead>
        <tbody>
          ${rows.map((r) => {
            const act = Math.abs(r.drift) < 0.5 ? 'hold' : (r.drift > 0 ? 'sell' : 'buy');
            const actLabel = act === 'hold' ? 'HOLD' : (act === 'buy' ? 'BUY' : 'SELL');
            return `<tr>
              <td>${r.name}</td>
              <td class="num">${r.current}%</td>
              <td class="num">${r.target}%</td>
              <td class="num ${r.drift > 0 ? 'up' : r.drift < 0 ? 'down' : 'muted'}">${r.drift >= 0 ? '+' : ''}${r.drift}pp</td>
              <td class="num">${r.shift === 0 ? '—' : (r.shift > 0 ? '+' : '−') + fmtUSD(Math.abs(r.shift), 0)}</td>
              <td><span class="action ${act}">${actLabel}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
    $('#reb-modal').hidden = false;
  };
  $('#rebalance-btn')?.addEventListener('click', openRebalance);
  $('#drift-alerts')?.addEventListener('click', openRebalance);
  $('#reb-modal')?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => $('#reb-modal').hidden = true));
  $('#reb-send')?.addEventListener('click', () => {
    $('#reb-modal').hidden = true;
    alert('Proposal sent to Eleanor Marchetti. You will receive confirmation from the desk.');
  });

  // ── Calendar / .ics download ────────────────────────────────────
  $('#calendar-download')?.addEventListener('click', () => {
    const pad = (n) => String(n).padStart(2, '0');
    const year = 2026;
    const monthNum = { 'Jan':1,'Feb':2,'Mar':3,'Apr':4,'May':5,'Jun':6,'Jul':7,'Aug':8,'Sep':9,'Oct':10,'Nov':11,'Dec':12 };
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ashford & Vere//EN'];
    events.forEach((e, i) => {
      const m = monthNum[e.m];
      const dt = `${year}${pad(m)}${pad(e.d)}`;
      const dtEnd = `${year}${pad(m)}${pad(e.d + 1)}`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:ev-${i}@ashford-vere`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${dt}`,
        `DTEND;VALUE=DATE:${dtEnd}`,
        `SUMMARY:${e.label}`,
        `DESCRIPTION:${(e.meta || '').replace(/\n/g, ' ')}`,
        'END:VEVENT'
      );
    });
    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'av-events.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 200);
  });

  // Run one tick immediately so % figures align with live state
  renderFeed();
  recomputeAnalytics();
  liveTick();
  bindRowRemove();
  renderNotifs();
  setInterval(() => {
    liveTick();
    bindRowRemove();
    if (!notifPop.hidden) renderNotifs();
  }, 1600);

  // Re-render perf chart on resize (keeps end-marker aligned)
  let r;
  window.addEventListener('resize', () => {
    clearTimeout(r); r = setTimeout(renderPerf, 120);
  });
})();

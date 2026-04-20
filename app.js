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
        <td class="num">${weight.toFixed(1)}%</td>`;
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
  // Run one tick immediately so % figures align with live state
  recomputeAnalytics();
  liveTick();
  setInterval(liveTick, 1600);

  // Re-render perf chart on resize (keeps end-marker aligned)
  let r;
  window.addEventListener('resize', () => {
    clearTimeout(r); r = setTimeout(renderPerf, 120);
  });
})();

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
  const holdings = [
    { sym: 'NVDA',  name: 'NVIDIA Corp.',           sector: 'Semiconductors',   qty:  6800, cost: 612.40, px: 892.40 },
    { sym: 'MSFT',  name: 'Microsoft Corp.',        sector: 'Software',         qty: 12400, cost: 318.10, px: 422.75 },
    { sym: 'AAPL',  name: 'Apple Inc.',             sector: 'Hardware',         qty: 18600, cost: 164.20, px: 208.90 },
    { sym: 'LVMH',  name: 'LVMH Moët Hennessy',     sector: 'Luxury · Paris',   qty:  9200, cost: 642.00, px: 748.40 },
    { sym: 'NESN',  name: 'Nestlé SA',              sector: 'Staples · SIX',    qty: 14800, cost:  98.70, px: 104.12 },
    { sym: 'BRK.B', name: 'Berkshire Hathaway B',   sector: 'Conglomerate',     qty:  8400, cost: 312.20, px: 408.30 },
    { sym: 'ASML',  name: 'ASML Holding',           sector: 'Semi Equip · AEX', qty:  3100, cost: 642.10, px: 910.20 },
    { sym: 'UST10', name: 'US Treasury 4.25% 2034', sector: 'Govt Bond',        qty: 75000, cost:  99.10, px: 101.42 },
    { sym: 'GOLD',  name: 'Physical Gold (LBMA)',   sector: 'Commodity · oz',   qty:  8200, cost: 1980.0, px: 2342.10 },
    { sym: 'TSLA',  name: 'Tesla Inc.',             sector: 'Autos',            qty:  5400, cost: 242.80, px: 174.60 },
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
  };

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

  // ── Live tick engine ─────────────────────────────────────────────
  // Each security gets a mean-reverting random walk around its anchor px.
  const anchors = new Map(holdings.map((h) => [h.sym, h.px]));
  const watchAnchors = new Map(watchlist.map((w) => [w.sym, w.px]));
  const dayOpen = new Map(holdings.map((h) => [h.sym, h.px * (1 - (rnd() - 0.5) * 0.01)]));

  const liveTick = () => {
    // Holdings
    holdings.forEach((h) => {
      const anchor = anchors.get(h.sym);
      const meanRev = (anchor - h.px) * 0.02;
      const shock   = (rnd() - 0.5) * h.px * 0.0025;
      const next    = Math.max(0.01, h.px + meanRev + shock);
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
  // Run one tick immediately so % figures align with live state
  liveTick();
  setInterval(liveTick, 1600);

  // Re-render perf chart on resize (keeps end-marker aligned)
  let r;
  window.addEventListener('resize', () => {
    clearTimeout(r); r = setTimeout(renderPerf, 120);
  });
})();

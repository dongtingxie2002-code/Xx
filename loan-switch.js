/* Currency Loan Switch — Xie Family Office
 * A USD Lombard loan can be re-denominated into a lower-yielding funding
 * currency to harvest interest carry, at the cost of FX risk on principal
 * and a collateral haircut for the currency mismatch. This drives the
 * inputs -> scenario engine -> cards / breakeven matrix on loan-switch.html.
 *
 * Conventions
 *  - Spot is quoted as FOREIGN UNITS PER 1 USD (USD/CHF = 0.7824, USD/HKD = 7.8338).
 *  - All-in rate = reference rate + bank spread (decimal internally).
 *  - "Appreciation" a of the funding currency means it strengthens vs USD,
 *    so repaying the foreign principal costs Principal x (1 + a) in USD.
 *  - Carry benefit over tenor = P x (r_usd - r_c) x T  (simple interest).
 *  - Net benefit = carry benefit - FX loss on principal (= P x a).
 *  - Breakeven appreciation a* = (r_usd - r_c) x T.
 */
(() => {
  'use strict';

  const STORE = 'xfo-loan-switch-v1';
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // ── Default currency universe (editable assumptions) ──────────────
  // ref / spread / haircut in PERCENT; spot = foreign units per USD.
  const DEFAULTS = {
    facility: { client: 'Xie Family Office', principal: 994276.45, tenor: 1, equity: 25000 },
    stress: 0,
    rows: [
      { code: 'USD', name: 'US Dollar',        ref: 3.85,   spread: 0.25, spot: 1,        haircut: 0,  color: '#6aa0e0', base: true,  on: false },
      { code: 'HKD', name: 'Hong Kong Dollar', ref: 3.15,   spread: 0.25, spot: 7.8338,   haircut: 0,  color: '#e0556a', base: false, on: true  },
      { code: 'CHF', name: 'Swiss Franc',      ref: 0.60,   spread: 0.25, spot: 0.7824,   haircut: 10, color: '#d8b24c', base: false, on: true  },
      { code: 'SGD', name: 'Singapore Dollar', ref: 1.2746, spread: 0.25, spot: 1.2774,   haircut: 10, color: '#4cb787', base: false, on: true  },
      { code: 'EUR', name: 'Euro',             ref: 2.40,   spread: 0.25, spot: 0.9180,   haircut: 10, color: '#8ba9d6', base: false, on: false },
      { code: 'GBP', name: 'Pound Sterling',   ref: 4.20,   spread: 0.25, spot: 0.7890,   haircut: 10, color: '#b08cd6', base: false, on: false },
      { code: 'JPY', name: 'Japanese Yen',     ref: 0.55,   spread: 0.25, spot: 156.20,   haircut: 12, color: '#d68c6a', base: false, on: false },
      { code: 'AUD', name: 'Australian Dollar',ref: 3.80,   spread: 0.25, spot: 1.5210,   haircut: 12, color: '#6ad6c2', base: false, on: false },
    ],
  };

  // ── State (deep clone of defaults, then overlay saved) ────────────
  let state = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved && saved.rows) {
      state.facility = { ...state.facility, ...saved.facility };
      state.stress = saved.stress ?? 0;
      // merge by code so new currencies survive an old save
      state.rows = DEFAULTS.rows.map((d) => {
        const s = saved.rows.find((r) => r.code === d.code);
        return s ? { ...d, ref: s.ref, spread: s.spread, spot: s.spot, haircut: s.haircut, on: s.on } : d;
      });
    }
  } catch {}

  const save = () => localStorage.setItem(STORE, JSON.stringify(state));

  // ── Formatters ────────────────────────────────────────────────────
  const usd = (n, frac = 0) => (n < 0 ? '−' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
  const sUsd = (n, frac = 0) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: frac, maximumFractionDigits: frac });
  const pct = (n, frac = 2) => n.toFixed(frac) + '%';
  const sPct = (n, frac = 2) => (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(frac) + '%';
  const bps = (n) => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)) + ' bps';

  const baseRow = () => state.rows.find((r) => r.base);
  const allIn = (r) => r.ref + r.spread;                 // percent
  const num = (v, d = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

  // ── Scenario engine ───────────────────────────────────────────────
  function scenario(row, stressPct) {
    const P = num(state.facility.principal);
    const T = Math.max(num(state.facility.tenor), 0.01);
    const E = num(state.facility.equity);
    const rUsd = allIn(baseRow()) / 100;
    const rC = allIn(row) / 100;
    const a = stressPct / 100;                            // funding-ccy appreciation

    const annualSaving = P * (rUsd - rC);                // USD per year
    const carry = annualSaving * T;                      // over tenor
    const fxLoss = P * a;                                // appreciation costs the borrower
    const net = carry - fxLoss;
    const breakeven = (rUsd - rC) * T * 100;             // appreciation %% that wipes carry
    const haircutCost = P * (row.haircut / 100);
    const headroom = E - haircutCost;
    const foreignPrincipal = P * row.spot;               // drawn amount in foreign units

    return {
      row, allInPct: allIn(row), annualSaving, carry, fxLoss, net, breakeven,
      haircutCost, headroom, breached: headroom < 0, foreignPrincipal,
      bpsVsUsd: (rC - rUsd) * 10000,
    };
  }

  // ── Render: rates table ───────────────────────────────────────────
  function renderRates() {
    const tb = $('#rates-tbl tbody');
    tb.innerHTML = state.rows.map((r, i) => {
      const ai = allIn(r);
      const isBase = r.base;
      return `<tr data-i="${i}">
        <td class="pickcol">${isBase ? '<span class="pill flag">base</span>'
          : `<input class="pick" type="checkbox" data-k="on" ${r.on ? 'checked' : ''} aria-label="switch to ${r.code}">`}</td>
        <td><span class="ccy-flag"><span class="dot" style="background:${r.color}"></span><b>${r.code}</b>
            <span class="muted small">${r.name}</span></span></td>
        <td><input class="cellinp" type="number" step="0.01" data-k="ref" value="${r.ref}"></td>
        <td><input class="cellinp" type="number" step="0.01" data-k="spread" value="${r.spread}"></td>
        <td class="allin">${ai.toFixed(2)}%</td>
        <td>${isBase ? '<span class="base">1.0000</span>'
          : `<input class="cellinp fx" type="number" step="0.0001" data-k="spot" value="${r.spot}">`}</td>
        <td>${isBase ? '<span class="base">0.0</span>'
          : `<input class="cellinp" type="number" step="0.5" data-k="haircut" value="${r.haircut}">`}</td>
      </tr>`;
    }).join('');

    $$('#rates-tbl tbody input').forEach((inp) => {
      const i = +inp.closest('tr').dataset.i, k = inp.dataset.k;
      inp.addEventListener(k === 'on' ? 'change' : 'input', () => {
        state.rows[i][k] = k === 'on' ? inp.checked : num(inp.value);
        if (k === 'ref' || k === 'spread') {           // live all-in cell
          inp.closest('tr').querySelector('.allin').textContent = allIn(state.rows[i]).toFixed(2) + '%';
        }
        save(); renderAll();
      });
    });
  }

  // ── Render: scenario cards ────────────────────────────────────────
  function renderCards(scs) {
    const wrap = $('#cards');
    if (!scs.length) {
      wrap.innerHTML = `<p class="muted">No currencies selected. Tick one or more in the table above to model a switch.</p>`;
      return;
    }
    const maxAbs = Math.max(1, ...scs.map((s) => Math.abs(s.net)));
    wrap.innerHTML = scs.map((s, idx) => {
      const r = s.row, good = s.net >= 0;
      const best = idx === 0 && good;
      const w = Math.min(100, (Math.abs(s.net) / maxAbs) * 100);
      const col = good ? 'var(--up)' : 'var(--down)';
      return `<div class="card ${best ? 'best' : ''} ${good ? '' : 'loss'}">
        <div class="card__rank">#${idx + 1}</div>
        <div class="card__ccy"><span class="dot" style="background:${r.color}"></span><h3>${r.code}</h3>
          ${best ? '<span class="pill go">best carry</span>' : (good ? '' : '<span class="pill no">net loss</span>')}</div>
        <div class="card__sub">${r.name} · all-in ${s.allInPct.toFixed(2)}% · ${bps(s.bpsVsUsd)} vs USD</div>
        <div class="card__hero" style="color:${col}">${sUsd(s.net)}</div>
        <div class="card__herolab">Net benefit over ${state.facility.tenor}y @ ${sPct(state.stress)} FX</div>
        <div class="card__rows">
          <div class="card__row"><span>Interest saving / yr</span><b class="${s.annualSaving>=0?'up':'down'}">${sUsd(s.annualSaving)}</b></div>
          <div class="card__row"><span>Carry over tenor</span><b class="${s.carry>=0?'up':'down'}">${sUsd(s.carry)}</b></div>
          <div class="card__row"><span>FX loss on principal</span><b>${s.fxLoss===0?'—':'−'+usd(Math.abs(s.fxLoss))}</b></div>
          <div class="card__row"><span>Breakeven move</span><b class="flag" style="color:var(--gold-soft)">${s.breakeven>=0?'+':''}${s.breakeven.toFixed(2)}%</b></div>
          <div class="card__row"><span>Drawn principal</span><b>${r.code} ${s.foreignPrincipal.toLocaleString('en-US',{maximumFractionDigits:0})}</b></div>
          <div class="card__row"><span>Mismatch haircut</span><b>${r.haircut===0?'none':usd(s.haircutCost)+' ('+r.haircut+'%)'}</b></div>
          <div class="card__row"><span>Collateral headroom</span><b class="${s.breached?'down':'up'}">${s.breached?'breach '+usd(s.headroom):usd(s.headroom)}</b></div>
        </div>
        <div class="bar"><i style="width:${w}%;background:${col}"></i></div>
      </div>`;
    }).join('');
  }

  // ── Render: recommendation banner ─────────────────────────────────
  function renderReco(scs) {
    const box = $('#reco'), txt = $('#reco-txt'), icon = box.querySelector('.reco__icon');
    box.classList.remove('warn', 'neutral');
    if (!scs.length) {
      box.classList.add('neutral'); icon.textContent = '⟳';
      txt.innerHTML = 'Select one or more currencies above to compare switch scenarios.';
      return;
    }
    const top = scs[0];
    if (top.net <= 0) {
      box.classList.add('warn'); icon.textContent = '⚠';
      txt.innerHTML = `At <b>${sPct(state.stress)}</b> FX stress no selected currency beats staying in USD — the carry no longer covers the FX risk. Stay in <b>USD</b> or revisit the stress assumption.`;
      return;
    }
    icon.textContent = '✓';
    const warn = top.breached
      ? ` — but the ${top.row.code} switch needs <b>${usd(Math.abs(top.headroom))}</b> more free equity to clear the mismatch haircut.`
      : '';
    if (top.breached) box.classList.add('warn');
    txt.innerHTML = `Switching <b>${usd(num(state.facility.principal))}</b> into <b>${top.row.code}</b> harvests
      <b>${sUsd(top.annualSaving)}/yr</b> of carry (<b>${sUsd(top.net)}</b> net over ${state.facility.tenor}y at ${sPct(state.stress)} FX).
      ${top.row.code} can appreciate up to <b>${top.breakeven.toFixed(2)}%</b> before the trade breaks even${warn}`;
  }

  // ── Render: breakeven / stress matrix ─────────────────────────────
  const STRESS_COLS = [-10, -5, -2, 0, 2, 5, 10];
  function renderMatrix(selected) {
    const head = $('#matrix-head'), body = $('#matrix-body');
    if (!selected.length) { head.innerHTML = ''; body.innerHTML = `<tr><td class="muted">—</td></tr>`; return; }
    head.innerHTML = `<th>Currency</th><th>Breakeven</th>` +
      STRESS_COLS.map((c) => `<th>${c > 0 ? '+' : ''}${c}%</th>`).join('');
    body.innerHTML = selected.map((row) => {
      const be = scenario(row, 0).breakeven;
      const cells = STRESS_COLS.map((c) => {
        const net = scenario(row, c).net;
        const col = net >= 0 ? 'var(--up)' : 'var(--down)';
        return `<td style="color:${col}">${sUsd(net)}</td>`;
      }).join('');
      return `<tr><td><span class="ccy-flag"><span class="dot" style="background:${row.color};display:inline-block;width:8px;height:8px;border-radius:50%"></span> ${row.code}</span></td>
        <td style="color:var(--gold-soft)">◆ ${be>=0?'+':''}${be.toFixed(2)}%</td>${cells}</tr>`;
    }).join('');
  }

  // ── Master render ─────────────────────────────────────────────────
  function renderAll() {
    const selected = state.rows.filter((r) => !r.base && r.on);
    const scs = selected.map((r) => scenario(r, state.stress)).sort((a, b) => b.net - a.net);
    renderCards(scs);
    renderReco(scs);
    renderMatrix(selected);
  }

  // ── Wire facility inputs + stress + buttons ───────────────────────
  function bind(id, key, isNum = true) {
    const el = $(id);
    el.addEventListener('input', () => { state.facility[key] = isNum ? num(el.value) : el.value; save(); renderAll(); });
  }
  function init() {
    $('#f-client').value = state.facility.client;
    $('#f-principal').value = state.facility.principal;
    $('#f-tenor').value = state.facility.tenor;
    $('#f-equity').value = state.facility.equity;
    bind('#f-client', 'client', false);
    bind('#f-principal', 'principal');
    bind('#f-tenor', 'tenor');
    bind('#f-equity', 'equity');

    const sl = $('#stress'), sv = $('#stress-val');
    sl.value = state.stress;
    sv.textContent = sPct(state.stress, 1);
    sl.addEventListener('input', () => {
      state.stress = num(sl.value);
      sv.textContent = sPct(state.stress, 1);
      save(); renderAll();
    });

    $('#btn-reset').addEventListener('click', () => {
      if (!confirm('Reset all rates, FX, haircuts and facility inputs to defaults?')) return;
      localStorage.removeItem(STORE);
      state = structuredClone(DEFAULTS);
      $('#f-client').value = state.facility.client;
      $('#f-principal').value = state.facility.principal;
      $('#f-tenor').value = state.facility.tenor;
      $('#f-equity').value = state.facility.equity;
      sl.value = 0; sv.textContent = '+0.0%';
      renderRates(); renderAll();
    });
    $('#btn-print').addEventListener('click', () => window.print());

    renderRates();
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

// Seed data for Xie Family Office portfolio mockups.
// Deterministic fake data tuned to a total portfolio value of ~$12.4M.
// Shared across v1-pictet.html, v2-rothschild.html, v3-modern.html.

(function (global) {
  const SEED_PRICES = {
    AAPL: 228.42,
    MSFT: 445.10,
    NVDA: 138.25,
    VOO:  548.90,
    VT:   124.55,
    BTC:  68420.00,
    ETH:  3520.00,
    SOL:  172.40,
    CASH: 1.00,
  };

  const HOLDINGS = [
    { symbol: "AAPL", name: "Apple Inc.",                class: "US Equity", qty:  7800,     seedPrice: SEED_PRICES.AAPL, sector: "Technology" },
    { symbol: "MSFT", name: "Microsoft Corp.",           class: "US Equity", qty:  4700,     seedPrice: SEED_PRICES.MSFT, sector: "Technology" },
    { symbol: "NVDA", name: "NVIDIA Corp.",              class: "US Equity", qty:  13000,    seedPrice: SEED_PRICES.NVDA, sector: "Semiconductors" },
    { symbol: "VOO",  name: "Vanguard S&P 500 ETF",      class: "US Equity ETF", qty: 3100, seedPrice: SEED_PRICES.VOO,  sector: "Broad Market" },
    { symbol: "VT",   name: "Vanguard Total World ETF",  class: "Global Equity ETF", qty: 6500, seedPrice: SEED_PRICES.VT, sector: "Broad Market" },
    { symbol: "BTC",  name: "Bitcoin",                   class: "Digital Assets", qty:  28,   seedPrice: SEED_PRICES.BTC,  sector: "Crypto" },
    { symbol: "ETH",  name: "Ether",                     class: "Digital Assets", qty: 240,   seedPrice: SEED_PRICES.ETH,  sector: "Crypto" },
    { symbol: "SOL",  name: "Solana",                    class: "Digital Assets", qty: 2400,  seedPrice: SEED_PRICES.SOL,  sector: "Crypto" },
    { symbol: "CASH", name: "Cash & Equivalents (USD)",  class: "Cash",       qty:  1050000,  seedPrice: SEED_PRICES.CASH, sector: "Cash" },
  ];

  // Seeded PRNG so every mockup renders identical history.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Simulate 252 trading days (~12 months) per symbol, ending at seedPrice.
  function simulateSeries(symbol, seedPrice, days, drift, vol, rngSeed) {
    const rng = mulberry32(rngSeed);
    const series = new Array(days);
    // Walk backward from seedPrice to construct a plausible history.
    series[days - 1] = seedPrice;
    for (let i = days - 2; i >= 0; i--) {
      const z = Math.sqrt(-2 * Math.log(rng() + 1e-9)) * Math.cos(2 * Math.PI * rng());
      const shock = drift / days + vol * z / Math.sqrt(days);
      series[i] = series[i + 1] / (1 + shock);
    }
    return series;
  }

  const DAYS = 252;
  const today = new Date();
  const dates = [];
  {
    const d = new Date(today);
    for (let i = DAYS - 1; i >= 0; i--) {
      const dt = new Date(d);
      dt.setDate(d.getDate() - i);
      dates.push(dt);
    }
  }

  const SIM_PARAMS = {
    AAPL: { drift: 0.18,  vol: 0.26, seed: 101 },
    MSFT: { drift: 0.14,  vol: 0.22, seed: 102 },
    NVDA: { drift: 1.05,  vol: 0.55, seed: 103 },
    VOO:  { drift: 0.11,  vol: 0.15, seed: 104 },
    VT:   { drift: 0.09,  vol: 0.14, seed: 105 },
    BTC:  { drift: 0.75,  vol: 0.60, seed: 106 },
    ETH:  { drift: 0.45,  vol: 0.70, seed: 107 },
    SOL:  { drift: 1.30,  vol: 0.95, seed: 108 },
    CASH: { drift: 0.00,  vol: 0.00, seed: 109 },
  };

  const priceSeries = {};
  for (const h of HOLDINGS) {
    const p = SIM_PARAMS[h.symbol];
    priceSeries[h.symbol] = simulateSeries(h.symbol, h.seedPrice, DAYS, p.drift, p.vol, p.seed);
  }

  // Portfolio NAV history using constant holdings (simplified for mockup).
  const navSeries = new Array(DAYS);
  const classSeries = {}; // { "US Equity": [..], "Digital Assets": [..], ... }
  for (let i = 0; i < DAYS; i++) {
    let total = 0;
    for (const h of HOLDINGS) {
      const v = priceSeries[h.symbol][i] * h.qty;
      total += v;
      classSeries[h.class] = classSeries[h.class] || new Array(DAYS).fill(0);
      classSeries[h.class][i] += v;
    }
    navSeries[i] = total;
  }

  const totalValue = navSeries[navSeries.length - 1];

  // Analytics.
  function dailyReturns(series) {
    const r = new Array(series.length - 1);
    for (let i = 1; i < series.length; i++) r[i - 1] = series[i] / series[i - 1] - 1;
    return r;
  }
  function stdev(arr) {
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }
  function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

  const navReturns = dailyReturns(navSeries);
  const annVol = stdev(navReturns) * Math.sqrt(252);
  const annRet = (navSeries[navSeries.length - 1] / navSeries[0]) - 1;
  const rf = 0.045; // assumed risk-free
  const sharpe = (annRet - rf) / annVol;

  // YTD — use Jan 1 as boundary.
  const yearStart = new Date(today.getFullYear(), 0, 1);
  let ytdIdx = dates.findIndex(d => d >= yearStart);
  if (ytdIdx < 0) ytdIdx = 0;
  const ytdReturn = navSeries[navSeries.length - 1] / navSeries[ytdIdx] - 1;

  // Max drawdown.
  let peak = -Infinity, maxDD = 0;
  for (const v of navSeries) {
    if (v > peak) peak = v;
    const dd = v / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }

  // Beta vs VT (proxy for market).
  const mktReturns = dailyReturns(priceSeries.VT);
  const covMean = mean(navReturns.map((r, i) => (r - mean(navReturns)) * (mktReturns[i] - mean(mktReturns))));
  const mktVar = stdev(mktReturns) ** 2;
  const beta = covMean / mktVar;

  // 95% parametric VaR (1-day) in dollars.
  const dailyVol = stdev(navReturns);
  const var95 = 1.645 * dailyVol * totalValue;

  // Correlation matrix between symbols (excluding cash).
  const corrSymbols = HOLDINGS.filter(h => h.symbol !== "CASH").map(h => h.symbol);
  const symReturns = {};
  for (const s of corrSymbols) symReturns[s] = dailyReturns(priceSeries[s]);
  function correlation(a, b) {
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da  += (a[i] - ma) ** 2;
      db  += (b[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  }
  const correlationMatrix = corrSymbols.map(r =>
    corrSymbols.map(c => correlation(symReturns[r], symReturns[c]))
  );

  global.XFO_DATA = {
    HOLDINGS,
    SEED_PRICES,
    dates,
    priceSeries,
    navSeries,
    classSeries,
    totalValue,
    metrics: {
      annVol,
      annRet,
      sharpe,
      ytdReturn,
      maxDD,
      beta,
      var95,
    },
    correlation: {
      symbols: corrSymbols,
      matrix: correlationMatrix,
    },
    fmt: {
      money(v, digits = 0) {
        return v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
      },
      moneyShort(v) {
        if (Math.abs(v) >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
        if (Math.abs(v) >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
        if (Math.abs(v) >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
        return "$" + v.toFixed(0);
      },
      pct(v, digits = 2) { return (v * 100).toFixed(digits) + "%"; },
      signedPct(v, digits = 2) { const s = v >= 0 ? "+" : "−"; return s + Math.abs(v * 100).toFixed(digits) + "%"; },
    },
  };
})(window);

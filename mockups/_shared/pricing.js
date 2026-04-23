// Live pricing for Xie Family Office mockups.
// Crypto: CoinGecko simple/price (public, no key).
// Equities: Yahoo Finance v7 via public CORS proxy (corsproxy.io).
// Both fail gracefully to seeded prices if the network is unreachable.

(function (global) {
  const EQUITY_SYMBOLS = ["AAPL", "MSFT", "NVDA", "VOO", "VT"];
  const CRYPTO_MAP = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };
  const REFRESH_MS = 60_000;

  const listeners = new Set();
  const state = {
    prices: Object.assign({}, global.XFO_DATA.SEED_PRICES),
    lastUpdated: null,
    source: { equity: "seed", crypto: "seed" },
    error: null,
  };

  async function fetchEquities() {
    const symbols = EQUITY_SYMBOLS.join(",");
    const target = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbols;
    const url = "https://corsproxy.io/?" + encodeURIComponent(target);
    const res = await fetch(url, { headers: { "accept": "application/json" } });
    if (!res.ok) throw new Error("equity http " + res.status);
    const body = await res.json();
    const rows = (body && body.quoteResponse && body.quoteResponse.result) || [];
    const out = {};
    for (const r of rows) {
      if (typeof r.regularMarketPrice === "number") out[r.symbol] = r.regularMarketPrice;
    }
    if (Object.keys(out).length === 0) throw new Error("equity empty");
    return out;
  }

  async function fetchCrypto() {
    const ids = Object.values(CRYPTO_MAP).join(",");
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=" + ids + "&vs_currencies=usd";
    const res = await fetch(url);
    if (!res.ok) throw new Error("crypto http " + res.status);
    const body = await res.json();
    const out = {};
    for (const [sym, id] of Object.entries(CRYPTO_MAP)) {
      if (body[id] && typeof body[id].usd === "number") out[sym] = body[id].usd;
    }
    if (Object.keys(out).length === 0) throw new Error("crypto empty");
    return out;
  }

  async function refresh() {
    const results = await Promise.allSettled([fetchEquities(), fetchCrypto()]);
    const [eqRes, cxRes] = results;

    if (eqRes.status === "fulfilled") {
      Object.assign(state.prices, eqRes.value);
      state.source.equity = "yahoo";
    } else {
      state.source.equity = state.source.equity === "yahoo" ? "yahoo (stale)" : "seed";
    }
    if (cxRes.status === "fulfilled") {
      Object.assign(state.prices, cxRes.value);
      state.source.crypto = "coingecko";
    } else {
      state.source.crypto = state.source.crypto === "coingecko" ? "coingecko (stale)" : "seed";
    }

    state.lastUpdated = new Date();
    state.error = (eqRes.status === "rejected" && cxRes.status === "rejected")
      ? "Both feeds unavailable — showing seed prices."
      : null;
    emit();
  }

  function emit() {
    for (const fn of listeners) {
      try { fn(state); } catch (_) { /* swallow */ }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(state); // replay current
    return () => listeners.delete(fn);
  }

  function start() {
    refresh();
    setInterval(refresh, REFRESH_MS);
  }

  global.XFO_PRICING = { subscribe, refresh, start, state };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})(window);

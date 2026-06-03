"""
Decumulator pricer — Monte Carlo under risk-neutral GBM.

A DECUMULATOR is the mirror image of the better-known ACCUMULATOR. It lets a
HOLDER of a stock sell a fixed quantity on each daily fixing at a STRIKE set
ABOVE today's price (an enhanced, above-market exit), for as long as the stock
stays ABOVE a lower KNOCK-OUT (KO) barrier. Two catches:

  * GEARING: on any fixing where the stock closes ABOVE the strike, the holder
    must sell DOUBLE the daily quantity at the strike (sell into strength at a
    now below-market price). This tail is UNBOUNDED on the upside.
  * KNOCK-OUT: if the stock closes AT or BELOW the KO barrier on a fixing, the
    whole programme terminates early (the run of premium selling stops).

The note trades at ZERO upfront cost. The "price" is the fair STRIKE — solved so
the present value of all the embedded cashflows is zero at inception, for a
chosen KO barrier, tenor, gearing and an initial guaranteed (no-KO) window.

Per-fixing economics to the holder, measured against simply selling in the
market that day, are: quantity * (Strike - S_t).

Speed: the Brownian path matrix is generated ONCE; every strike/KO is then
re-priced as a cheap vectorised pass, so the fair-strike solve is fast.
"""
import numpy as np

# ----- Real market inputs (sourced 2026-06-03) ---------------------------------
S0    = 221.79     # NVDA spot, 3 Jun 2026 (stockanalysis.com)
r     = 0.0383     # 1-year US Treasury yield (US Treasury / FRED, 1 Jun 2026)
q     = 0.0002     # NVDA dividend yield (~$0.04/sh — negligible)
sigma = 0.43       # 1-year ATM implied volatility (30d IV ~38%, upward term str.)
T     = 1.0        # tenor, years
N     = 252        # daily fixings
PATHS = 120_000
GUARANTEED_DAYS = 21   # ~1 month: KO not observed during this initial window
GEARING = 2.0
SEED = 7

rng = np.random.default_rng(SEED)

# ---- generate the price-path matrix ONCE -------------------------------------
dt = T / N
drift = (r - q - 0.5 * sigma**2) * dt
vol = sigma * np.sqrt(dt)
shocks = rng.standard_normal((PATHS, N))
logpaths = np.log(S0) + np.cumsum(drift + vol * shocks, axis=1)
S = np.exp(logpaths).astype(np.float64)          # (PATHS, N) closing prices
disc = np.exp(-r * np.arange(1, N + 1) * dt)      # (N,) discount factors


def price(strike, ko, base_qty=1.0):
    """Vectorised valuation for a strike & KO over the pre-built path matrix."""
    # KO test only after the guaranteed window; find first KO fixing per path.
    below = S <= ko
    below[:, :GUARANTEED_DAYS] = False
    ko_idx = np.where(below.any(axis=1), below.argmax(axis=1), N)  # first KO day
    knocked = ko_idx < N

    fix = np.arange(N)[None, :]
    # A fixing trades while the structure is alive; on the KO day itself it does
    # NOT trade (programme has terminated on that close).
    active = fix < ko_idx[:, None]

    qty = np.where(S > strike, GEARING * base_qty, base_qty) * active
    pnl = qty * (strike - S)                       # economics vs. selling at mkt
    pv_path = (pnl * disc[None, :]).sum(axis=1)

    shares = qty.sum(axis=1)
    proceeds = (qty * strike).sum(axis=1)
    geared = ((S > strike) & active).sum(axis=1)   # geared fixings per path

    return dict(
        pv=pv_path.mean(),
        pv_path=pv_path,
        prob_ko=knocked.mean(),
        exp_shares=shares.mean(),
        avg_sale=proceeds.sum() / shares.sum(),
        exp_ko_day=ko_idx[knocked].mean() if knocked.any() else float('nan'),
        exp_geared=geared.mean(),
        shares_path=shares,
        terminal=S[:, -1],
    )


def fair_strike(ko, lo=1.0, hi=1.30):
    """Bisection for the strike multiple (x spot) that zeroes PV."""
    for _ in range(46):
        mid = 0.5 * (lo + hi)
        if price(S0 * mid, ko)['pv'] > 0:   # too rich for holder -> lower strike
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


if __name__ == "__main__":
    print(f"Spot {S0}  vol {sigma:.0%}  r {r:.2%}  q {q:.3%}  T {T}  fixings {N}")
    print(f"Paths {PATHS:,}  guaranteed window {GUARANTEED_DAYS}d  gearing {GEARING}x\n")
    print(" KO%   KO px | fair strike            |   P(KO) | avg sale | E[geared] | E[KO day]")
    for ko_pct in (0.99, 0.975, 0.96, 0.95, 0.93, 0.90):
        ko = S0 * ko_pct
        k = fair_strike(ko)
        d = price(S0 * k, ko)
        print(f"{ko_pct:5.1%} {ko:6.2f} | {k:.4f}x  {(k-1)*100:+5.2f}% {S0*k:7.2f} | "
              f"{d['prob_ko']:6.1%} | {d['avg_sale']:7.2f} | {d['exp_geared']:7.1f}  | "
              f"{d['exp_ko_day']:.0f}")

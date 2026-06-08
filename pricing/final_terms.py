"""Final locked design — 3-month daily decumulator on NVDA — full analytics.

Design: tenor 3m (63 fixings), gearing 2x above strike, KO at -5% of spot,
1-week guaranteed (no-KO) window, base size 500 shares/fixing.
Solves the fair (zero-cost) enhanced sale price, then reports the full outcome
distribution and three illustrative deterministic paths for the one-pager.
"""
import numpy as np

S0, r, q, sigma = 221.79, 0.0383, 0.0002, 0.43
T, N = 0.25, 63
GEARING, GUARD = 2.0, 5
KO = S0 * 0.95
BASE = 500            # base shares per fixing
POSITION = 120_000    # family's NVDA holding (shares)
PATHS, SEED = 300_000, 11
CAL_DAYS = 365 * T    # calendar days in tenor (~91)

rng = np.random.default_rng(SEED)
dt = T / N
drift = (r - q - 0.5 * sigma**2) * dt
vol = sigma * np.sqrt(dt)
shocks = rng.standard_normal((PATHS, N))
S = np.exp(np.log(S0) + np.cumsum(drift + vol * shocks, axis=1))
disc = np.exp(-r * np.arange(1, N + 1) * dt)


def evaluate(strike, base=1.0):
    below = S <= KO
    below[:, :GUARD] = False
    ko_idx = np.where(below.any(axis=1), below.argmax(axis=1), N)
    knocked = ko_idx < N
    active = np.arange(N)[None, :] < ko_idx[:, None]
    qty = np.where(S > strike, GEARING * base, base) * active
    pnl = qty * (strike - S)
    pv = (pnl * disc[None, :]).sum(axis=1)
    shares = qty.sum(axis=1)
    return dict(pv=pv.mean(), pv_path=pv, knocked=knocked, ko_idx=ko_idx,
                shares=shares, active=active, qty=qty)


def fair_strike(lo=1.0, hi=1.30):
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if evaluate(S0 * mid)['pv'] > 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


k_mult = fair_strike()
K = S0 * k_mult
d = evaluate(K, base=BASE)

shares = d['shares']
proceeds = shares * K                      # all sales execute at the strike K
ko_cal = (d['ko_idx'][d['knocked']] / N) * CAL_DAYS

# Benchmark: value of selling those same shares at the prevailing market instead
below = S <= KO; below[:, :GUARD] = False
active = d['active']
qty = d['qty']
market_value = (qty * S).sum(axis=1)        # what those shares were worth at sale
enhancement = proceeds - market_value       # cash the structure added vs market

pct = lambda a, p: np.percentile(a, p)

print("="*70)
print("NVDA 3-MONTH DAILY DECUMULATOR — INDICATIVE TERMS (priced 2026-06-03)")
print("="*70)
print(f"Spot                : ${S0:.2f}")
print(f"Implied vol (1Q)    : {sigma:.0%}")
print(f"Risk-free (3m)      : {r:.2%}   Dividend yield: {q:.3%}")
print(f"3-month forward     : ${S0*np.exp((r-q)*T):.2f}  (+{ (np.exp((r-q)*T)-1)*100:.2f}%)")
print("-"*70)
print(f"FAIR ENHANCED SALE PRICE (strike): ${K:.2f}   = +{(k_mult-1)*100:.2f}% vs spot")
print(f"                                          = +{(K/(S0*np.exp((r-q)*T))-1)*100:.2f}% vs 3m forward")
print(f"Knock-out barrier   : ${KO:.2f}  (-5.00%)   Gearing: {GEARING:.0f}x above strike")
print(f"Tenor / fixings     : 3 months / {N} daily fixings   Guaranteed window: {GUARD} fixings")
print(f"Base size           : {BASE} sh/fixing  (geared {2*BASE} sh)   Residual cost (PV): {d['pv']:.4f}")
print("-"*70)
print(f"P(knock-out within 3m)        : {d['knocked'].mean():.1%}")
print(f"E[knock-out day] (calendar)   : {ko_cal.mean():.0f} days")
print(f"Avg realized SALE PRICE       : ${proceeds.sum()/shares.sum():.2f}  (= strike, always +{(k_mult-1)*100:.1f}%)")
print(f"E[shares sold]                : {shares.mean():,.0f}   (max if never KO: {2*BASE*N:,})")
print(f"  shares sold  p5 / p50 / p95 : {pct(shares,5):,.0f} / {pct(shares,50):,.0f} / {pct(shares,95):,.0f}")
print(f"E[proceeds]                   : ${proceeds.mean():,.0f}")
print(f"  proceeds p5 / p50 / p95     : ${pct(proceeds,5):,.0f} / ${pct(proceeds,50):,.0f} / ${pct(proceeds,95):,.0f}")
print(f"E[cash added vs selling at mkt]: ${enhancement.mean():,.0f}   (this is ~0 by construction; check)")
print(f"  p5 / p50 / p95              : ${pct(enhancement,5):,.0f} / ${pct(enhancement,50):,.0f} / ${pct(enhancement,95):,.0f}")
print(f"Share of position decumulated : {shares.mean()/POSITION:.1%} (expected)")
print("="*70)

# ----- three illustrative deterministic paths -----------------------------
def walk(label, path):
    """path: list of N closing prices (len<=N). Apply rules deterministically."""
    alive = True; sold = 0; cash = 0.0; geared_days = 0; ko_day = None
    for i, s in enumerate(path):
        if not alive: break
        if i >= GUARD and s <= KO:
            ko_day = i + 1; alive = False; break
        g = 2 if s > K else 1
        if g == 2: geared_days += 1
        sold += g*BASE; cash += g*BASE*K
    avg = cash/sold if sold else 0
    end = "KO day %d" % ko_day if ko_day else "ran full term"
    print(f"\n{label}")
    print(f"  outcome: {end};  sold {sold:,} sh at ${K:.2f} = ${cash:,.0f};  geared on {geared_days} days")
    return sold, cash

print("\nILLUSTRATIVE SCENARIOS (deterministic, for the narrative)")
# A: drifts down ~ -5% over 18 fixings then KO
pa = list(np.linspace(S0, KO-0.5, 19))
walk("A  Eases lower → knocks out (~3.5 weeks): NVDA drifts to the -5% floor", pa)
# B: sideways around spot, mostly below strike, a few pokes above
rng2 = np.random.default_rng(3)
pb = S0 + rng2.normal(0, 4, N).cumsum()*0.0 + rng2.uniform(-6, 6, N)
pb = np.clip(pb, KO+1, K+6)
walk("B  Chops sideways: stays between floor and strike for the quarter", list(pb))
# C: rallies hard, no KO, full term geared
pc = list(np.linspace(S0, S0*1.40, N))
walk("C  Rallies hard (+40%): sells 2x at the strike all the way up", pc)
print()

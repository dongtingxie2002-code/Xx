"""Scan decumulator designs to find one that prices to a clean POSITIVE premium.

Re-uses the pricing logic but lets tenor (N), gearing and the guaranteed window
vary. For each design we solve the fair strike (zero-PV) and report it.
"""
import numpy as np

S0, r, q, sigma = 221.79, 0.0383, 0.0002, 0.43
PATHS, SEED = 120_000, 7
rng = np.random.default_rng(SEED)


def build_paths(N, T):
    dt = T / N
    drift = (r - q - 0.5 * sigma**2) * dt
    vol = sigma * np.sqrt(dt)
    shocks = rng.standard_normal((PATHS, N))
    S = np.exp(np.log(S0) + np.cumsum(drift + vol * shocks, axis=1))
    disc = np.exp(-r * np.arange(1, N + 1) * dt)
    return S, disc


def price(S, disc, N, strike, ko, gearing, guard):
    below = S <= ko
    below[:, :guard] = False
    ko_idx = np.where(below.any(axis=1), below.argmax(axis=1), N)
    knocked = ko_idx < N
    active = np.arange(N)[None, :] < ko_idx[:, None]
    qty = np.where(S > strike, gearing, 1.0) * active
    pv = (qty * (strike - S) * disc[None, :]).sum(axis=1)
    return dict(pv=pv.mean(), prob_ko=knocked.mean(),
                exp_ko_day=ko_idx[knocked].mean() if knocked.any() else np.nan,
                exp_geared=((S > strike) & active).sum(axis=1).mean(),
                exp_alive=active.sum(axis=1).mean())


def fair(S, disc, N, ko, gearing, guard, lo=0.90, hi=1.30):
    for _ in range(44):
        mid = 0.5 * (lo + hi)
        if price(S, disc, N, S0 * mid, ko, gearing, guard)['pv'] > 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


designs = [
    # label, months, fixings, gearing, guard_days, ko_pct
    ("12m  2.0x  KO-5%", 12, 252, 2.0, 21, 0.95),
    ("6m   2.0x  KO-5%",  6, 126, 2.0, 10, 0.95),
    ("3m   2.0x  KO-5%",  3,  63, 2.0,  5, 0.95),
    ("3m   2.0x  KO-7%",  3,  63, 2.0,  5, 0.93),
    ("3m   1.5x  KO-5%",  3,  63, 1.5,  5, 0.95),
    ("6m   1.5x  KO-7%",  6, 126, 1.5, 10, 0.93),
    ("12m  1.5x  KO-7%", 12, 252, 1.5, 21, 0.93),
    ("12m  1.5x  KO-10%",12, 252, 1.5, 21, 0.90),
]

print(f"NVDA  S0={S0}  vol={sigma:.0%}  r={r:.2%}\n")
print(f"{'design':18} | fair strike          |  P(KO) | E[geared] | E[alive] | E[KOday]")
cacheT = {}
for label, months, N, g, guard, kop in designs:
    T = months / 12
    key = (N, round(T, 4))
    if key not in cacheT:
        cacheT[key] = build_paths(N, T)
    S, disc = cacheT[key]
    ko = S0 * kop
    k = fair(S, disc, N, ko, g, guard)
    d = price(S, disc, N, S0 * k, ko, g, guard)
    print(f"{label:18} | {k:.4f}x {(k-1)*100:+6.2f}% {S0*k:7.2f} | "
          f"{d['prob_ko']:5.1%} | {d['exp_geared']:7.1f}  | {d['exp_alive']:6.1f}  | "
          f"{d['exp_ko_day']:.0f}")

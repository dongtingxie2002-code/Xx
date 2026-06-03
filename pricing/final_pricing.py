"""Final pricing & risk statistics for the chosen client example:

  3-month DECUMULATOR on NVIDIA (NVDA), 2x gearing, lower knock-out at -5%,
  first trading week guaranteed (no KO), physically settled.

Outputs every figure quoted in the one-pager. Zero-cost: the enhanced sale
price (strike) is solved so the risk-neutral PV of the note is ~0.
"""
import numpy as np
import json

# ----- Real market inputs (sourced 2026-06-03) ------------------------------
S0, r, q, sigma = 221.79, 0.0383, 0.0002, 0.43
T, N = 0.25, 63          # 3 months, ~daily fixings
GEAR, GUARD = 2.0, 5     # 2x gearing; first 5 fixings (1 week) no KO
KO = round(S0 * 0.95, 2) # 210.70  (-5%)
DAILY = 1_000            # base shares sold per fixing (2,000 when geared)
PATHS, SEED = 400_000, 11

rng = np.random.default_rng(SEED)
dt = T / N
drift = (r - q - 0.5 * sigma**2) * dt
vol = sigma * np.sqrt(dt)
shocks = rng.standard_normal((PATHS, N))
S = np.exp(np.log(S0) + np.cumsum(drift + vol * shocks, axis=1))
disc = np.exp(-r * np.arange(1, N + 1) * dt)


def evaluate(strike):
    below = S <= KO
    below[:, :GUARD] = False
    ko_idx = np.where(below.any(axis=1), below.argmax(axis=1), N)
    knocked = ko_idx < N
    active = np.arange(N)[None, :] < ko_idx[:, None]
    geared_mask = (S > strike) & active
    qty = np.where(S > strike, GEAR, 1.0) * active            # in "clips"
    pv = (qty * (strike - S) * disc[None, :]).sum(axis=1)     # per 1-share clip
    shares = qty.sum(axis=1) * DAILY
    proceeds = (qty * strike).sum(axis=1) * DAILY
    return dict(pv=pv, ko_idx=ko_idx, knocked=knocked, active=active,
                geared=geared_mask.sum(axis=1), shares=shares,
                proceeds=proceeds, term=S[:, -1])


def fair_strike(lo=1.0, hi=1.40):
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if evaluate(S0 * mid)['pv'].mean() > 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


k_mult = fair_strike()
K = S0 * k_mult
d = evaluate(K)

shares = d['shares']
proceeds = d['proceeds']
avg_sale = proceeds.sum() / shares.sum()           # blended realised sale px
twap_like = S.mean()                               # rough market-average ref

out = {
    "as_of": "2026-06-03",
    "underlying": "NVIDIA Corp (NVDA)",
    "spot": S0, "r": r, "q": q, "sigma": sigma,
    "tenor_months": 3, "fixings": N, "gearing": GEAR,
    "guaranteed_fixings": GUARD,
    "ko_price": KO, "ko_pct": round((KO / S0 - 1) * 100, 2),
    "base_daily_shares": DAILY,
    "fair_strike_mult": round(k_mult, 4),
    "enhanced_sale_price": round(K, 2),
    "enhanced_premium_pct": round((k_mult - 1) * 100, 2),
    "residual_pv_per_clip": round(float(d['pv'].mean()), 4),
    "prob_knockout": round(float(d['knocked'].mean()) * 100, 1),
    "prob_full_term": round(float((~d['knocked']).mean()) * 100, 1),
    "exp_ko_fixing": round(float(d['ko_idx'][d['knocked']].mean()), 1),
    "exp_active_fixings": round(float(d['active'].sum(axis=1).mean()), 1),
    "exp_geared_fixings": round(float(d['geared'].mean()), 1),
    "exp_shares_sold": int(round(float(shares.mean()), 0)),
    "max_shares_possible": GEAR * DAILY * N,
    "exp_proceeds_musd": round(float(proceeds.mean()) / 1e6, 2),
    "blended_avg_sale_px": round(float(avg_sale), 2),
    "blended_vs_spot_pct": round((avg_sale / S0 - 1) * 100, 2),
    # outcome buckets on terminal price
    "p_term_below_ko": round(float((d['term'] < KO).mean()) * 100, 1),
    "p_term_above_strike": round(float((d['term'] > K).mean()) * 100, 1),
    # percentiles of shares sold
    "shares_p10": int(np.percentile(shares, 10)),
    "shares_p50": int(np.percentile(shares, 50)),
    "shares_p90": int(np.percentile(shares, 90)),
}

# ---- three illustrative scenarios (conditional averages) -------------------
term = d['term']
def bucket(mask, label):
    m = mask & (shares > 0)
    return {
        "label": label,
        "prob_pct": round(float(mask.mean()) * 100, 1),
        "avg_shares": int(round(float(shares[m].mean()), 0)) if m.any() else 0,
        "avg_proceeds_musd": round(float(proceeds[m].mean()) / 1e6, 2) if m.any() else 0,
        "avg_term_px": round(float(term[m].mean()), 2) if m.any() else 0,
    }

scenarios = [
    bucket(d['knocked'] & (term <= KO * 1.02), "Drifts lower → early end"),
    bucket((~d['knocked']) & (term <= K), "Stays in range to maturity"),
    bucket(term > K, "Rallies through strike"),
]
out["scenarios"] = scenarios

print(json.dumps(out, indent=2))

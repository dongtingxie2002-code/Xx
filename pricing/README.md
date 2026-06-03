# Decumulator pricing — methodology

Pricing engine behind the client one-pager in [`../onepager/`](../onepager/).

## What a decumulator is

A **decumulator** is the mirror image of the better-known **accumulator**. It
helps a *holder* of a stock **sell down** ("decumulate") a position gradually,
at a price set **above** today's market.

On each daily fixing, the holder sells a fixed quantity of shares at a fixed
**enhanced sale price** (the strike, struck *above* spot), for as long as the
stock stays *above* a lower **knock-out (KO) barrier**. Two catches:

1. **Gearing** — on any fixing where the stock closes **above** the strike, the
   holder must sell **double** the daily quantity at the strike (i.e. sell into
   strength at a now below-market price). This tail is **unbounded** on the
   upside.
2. **Knock-out** — if the stock closes **at or below** the KO barrier, the whole
   programme **terminates early**; the holder keeps whatever shares remain.

The note is **zero-cost** at inception. The "price" we solve for is the fair
**enhanced sale price** (strike) such that the risk-neutral present value of all
embedded cashflows is ~0, for the chosen KO, tenor, gearing and guaranteed
window.

## Why decumulators are rarer than accumulators

An accumulator's pain tail is **bounded** — a stock cannot fall below zero, so
the forced "double-buy on the way down" has a floor. A decumulator's pain tail
is the **unbounded upside** (forced "double-sell" into an unlimited rally). On a
high-volatility name this tail is expensive, which is why a long-dated, heavily
geared decumulator on a 40%+ vol stock needs an eye-watering headline strike to
be fair — and why shorter tenors are the sensible client design.

## Model

* Risk-neutral **geometric Brownian motion**, daily fixings, Monte Carlo.
* Drift `r − q`, volatility `σ` (1-year ATM implied vol), discounting at `r`.
* KO observed on the daily close, disabled during an initial *guaranteed*
  window. On the KO fixing itself the structure terminates (no trade that day).
* Per-fixing economics to the holder, measured against selling in the market
  that day: `quantity × (strike − S_t)`.
* The fair strike is found by **bisection** on the zero-PV condition. The
  Brownian path matrix is generated **once** and re-priced for each candidate
  strike, so the solve is fast.

## Real market inputs (as of 2026-06-03)

| Input | Value | Source |
|---|---|---|
| NVDA spot | $221.79 | stockanalysis.com |
| 1-yr ATM implied vol | 43% | 30-day IV ≈ 38% (Market Chameleon / AlphaQuery), term-structure adjusted |
| 1-yr US Treasury | 3.83% | US Treasury / FRED (1 Jun 2026) |
| Dividend yield | ~0.02% | NVDA ~$0.04/sh annual |

## Files

| File | Purpose |
|---|---|
| `decumulator_pricer.py` | Core pricer + KO grid (fair strike vs. KO width) |
| `scan_designs.py` | Scan tenor / gearing / KO designs to find the marketable one |
| `final_pricing.py` | High-resolution pricing + risk stats for the chosen 3-month example |

Reproduce:

```bash
pip install numpy
python3 pricing/final_pricing.py
```

> Indicative and for discussion only. Not an offer, price, or investment advice.
> A live trade would use a desk's full implied-vol surface (skew/term structure),
> borrow cost, and credit/funding adjustments.

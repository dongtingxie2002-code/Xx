"""Daily market brief generator (Claude Opus 4.7 curation + Gmail SMTP).

07:30 SGT via GitHub Actions cron. Workflow: prices from Yahoo Finance,
news curated by Claude with the web_search tool (multi-source, cross-
referenced), 2-page color-coded HTML emailed to the configured inbox.

Env vars required: GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO, ANTHROPIC_API_KEY.
Optional: BRIEF_DRY_RUN=1 to write brief.html and skip SMTP.
"""

from __future__ import annotations

import html
import json
import logging
import os
import re
import smtplib
import ssl
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

logging.getLogger("yfinance").setLevel(logging.CRITICAL)

SGT = ZoneInfo("Asia/Singapore")
REPO_ROOT = Path(__file__).resolve().parent

# ─────────────────────────── Universe ────────────────────────────────────────

INDICES = [
    ("Dow Jones",        "^DJI"),
    ("S&P 500",          "^GSPC"),
    ("Nasdaq Composite", "^IXIC"),
    ("Russell 2000",     "^RUT"),
    ("Nikkei 225",       "^N225"),
    ("Hang Seng",        "^HSI"),
    ("Kospi",            "^KS11"),
    ("STI",              "^STI"),
    ("DAX",              "^GDAXI"),
    ("FTSE 100",         "^FTSE"),
    ("VIX",              "^VIX"),
]
YIELDS = [("US 10Y", "^TNX"), ("US 30Y", "^TYX")]
COMMODITIES = [
    ("Brent (front)", "BZ=F"),
    ("WTI (front)",   "CL=F"),
    ("Gold (front)",  "GC=F"),
]
FX = [
    ("USD/JPY", "JPY=X"),
    ("USD/CNH", "CNH=X"),
    ("DXY",     "DX-Y.NYB"),
    ("EUR/USD", "EURUSD=X"),
]

# ─────────────────────────── Yahoo Finance ───────────────────────────────────


@dataclass
class Quote:
    symbol: str
    label: str
    price: float | None = None
    prev_close: float | None = None
    change_pct: float | None = None
    error: str | None = None


def yahoo_quote(symbol: str, label: str) -> Quote:
    import yfinance as yf
    q = Quote(symbol=symbol, label=label)
    try:
        t = yf.Ticker(symbol)
        hist = t.history(period="7d", auto_adjust=False, raise_errors=False)
        if hist is None or hist.empty:
            q.error = "no history"
            return q
        closes = [float(c) for c in hist["Close"].tolist() if c == c]
        if len(closes) >= 2:
            q.price = closes[-1]
            q.prev_close = closes[-2]
            q.change_pct = (q.price / q.prev_close - 1) * 100
        elif closes:
            q.price = closes[-1]
    except Exception as e:  # noqa: BLE001
        q.error = str(e)
    return q


def fetch_quotes(universe: list[tuple[str, str]]) -> list[Quote]:
    out: list[Quote] = []
    for label, sym in universe:
        out.append(yahoo_quote(sym, label))
        time.sleep(0.08)
    return out


# ─────────────────────────── Holidays ────────────────────────────────────────


def load_holidays() -> dict[str, Any]:
    return json.loads((REPO_ROOT / "holidays.json").read_text())


def holidays_for_week(now_sgt: datetime) -> list[dict[str, Any]]:
    monday = (now_sgt - timedelta(days=now_sgt.weekday())).date()
    sunday = monday + timedelta(days=6)
    data = load_holidays()
    years = {str(monday.year), str(sunday.year)}
    block = [h for y in years for h in data.get(y, [])]
    out: list[dict[str, Any]] = []
    for h in block:
        if h.get("_comment"):
            continue
        try:
            d = datetime.strptime(h["date"], "%Y-%m-%d").date()
        except (KeyError, ValueError):
            continue
        if monday <= d <= sunday:
            out.append({**h, "_date": d})
    out.sort(key=lambda x: x["_date"])
    return out


# ─────────────────────────── Claude curation ─────────────────────────────────


def _snapshot_for_prompt(quotes: list[Quote]) -> str:
    lines: list[str] = []
    for q in quotes:
        if q.price is None:
            continue
        move = f"{q.change_pct:+.2f}%" if q.change_pct is not None else "n/a"
        lines.append(f"  {q.label:<18s} {q.symbol:<11s} {q.price:>12,.2f}  {move}")
    return "\n".join(lines)


CURATE_SYSTEM = """You are a senior market strategist writing a daily "Market Pulse" brief for an investor based in Singapore (SGT, UTC+8).

The brief is delivered at 07:30 Singapore time. At this moment:
- US cash markets just closed for the day (evening NY).
- Asia is in pre-open or early session.
- Europe opens in ~7 hours.

Your task: select the FIVE most market-moving news items from the past 24 hours, plus THREE forward-looking developments to watch in the next 24-48 hours.

Coverage guidance — pick from these areas (do NOT force one item per area; pick what actually moved markets):
- Geopolitics (wars, ceasefires, tariffs, sanctions, OPEC, Strait of Hormuz)
- Macro (Fed/ECB/BoJ, CPI/PCE/payrolls, GDP, yields, recession risk)
- Tech / AI / mega caps (Nvidia, AAPL/MSFT/GOOGL/META/AMZN/TSLA, TSMC, Samsung, SK Hynix, AI infrastructure, IPOs)
- Asia (Japan, Korea, China, HK, Singapore — including Asia-listed earnings, FX, regulatory)
- Earnings and corporate (major beats/misses, guidance, M&A, buybacks)

For each story:
- Quote concrete numbers, names, prices, dates.
- Identify the specific Yahoo-Finance-format tickers most affected (e.g. NVDA, 005930.KS for Samsung, 0992.HK for Lenovo, BZ=F for Brent, ^TNX for US 10Y).
- Write a one-line "market reaction" that explains the price move or expected impact.

Process: use web_search to pull headlines from REUTERS, BLOOMBERG, WSJ, FT, CNBC, NIKKEI ASIA, AP, BARRON'S. Cross-reference each story across at least two of those sources before including it. Verify numbers. Do not include rumors or single-source items.

Return your final answer as a single JSON object wrapped in <brief>...</brief> tags. No prose before or after the tags. Be terse — this is meant to be read in 2 minutes."""


CURATE_SCHEMA_HINT = """{
  "stories": [
    {
      "rank": 1,
      "category": "GEOPOLITICS" | "MACRO" | "TECH" | "EARNINGS" | "ASIA" | "FX" | "COMMODITIES" | "CREDIT",
      "headline": "Short factual headline (one line, ≤ 110 chars)",
      "summary": "1-2 sentences with specific numbers/names. Be terse.",
      "market_reaction": "1 sentence on how markets responded or will respond.",
      "tickers": ["NVDA", "TSM"],          // 1-6 entries, Yahoo Finance format
      "sources": ["Reuters", "Bloomberg"]  // 2+ entries; the wires you cross-referenced
    }
  ],                                       // exactly 5 entries, ranked by market-moving importance
  "forward": [
    {
      "when": "Wed 27 May, 10:00 KST",
      "event": "Samsung union vote result",
      "why": "1 sentence on what to watch and which way it moves the tape.",
      "tickers": ["005930.KS"]
    }
  ]                                        // exactly 3 entries
}"""


def curate_with_claude(quotes: list[Quote], now_sgt: datetime, holiday_today: bool) -> dict[str, Any]:
    """Call Claude Opus 4.7 with web_search to produce the curated brief."""
    import anthropic

    client = anthropic.Anthropic()

    user_msg = f"""Today: {now_sgt.strftime('%A %-d %B %Y · %H:%M SGT')}

Market snapshot (last completed daily close per Yahoo Finance):

{_snapshot_for_prompt(quotes)}

{"Note: today is a major-market holiday — US/UK/EU/HK/KR are closed. Liquidity is thinner so weigh ASIA-trading-today themes appropriately." if holiday_today else ""}

Search the web now, cross-reference, and return the brief.

JSON schema:
{CURATE_SCHEMA_HINT}

Wrap the JSON in <brief>...</brief>. No prose outside the tags."""

    # Stream because we may use many web_search iterations + adaptive thinking.
    with client.messages.stream(
        model="claude-opus-4-7",
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=CURATE_SYSTEM,
        messages=[{"role": "user", "content": user_msg}],
        tools=[{
            "type": "web_search_20260209",
            "name": "web_search",
            "max_uses": 12,
        }],
    ) as stream:
        final = stream.get_final_message()

    # Extract the JSON from the final text block(s).
    text_chunks = [b.text for b in final.content if b.type == "text"]
    full_text = "\n".join(text_chunks)

    m = re.search(r"<brief>(.*?)</brief>", full_text, re.DOTALL)
    if not m:
        m = re.search(r"\{[\s\S]*\}", full_text)
        if not m:
            print(f"[warn] no JSON in Claude response; raw text head: {full_text[:500]}",
                  file=sys.stderr)
            return {"stories": [], "forward": []}
        raw = m.group(0)
    else:
        raw = m.group(1).strip()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"[warn] JSON parse failed: {e}\n--- raw ---\n{raw[:800]}", file=sys.stderr)
        return {"stories": [], "forward": []}

    data.setdefault("stories", [])
    data.setdefault("forward", [])
    return data


# ─────────────────────────── HTML rendering (tight 2-page) ───────────────────

CATEGORY_COLORS = {
    "GEOPOLITICS": "#7c2d12",
    "MACRO":       "#1e3a8a",
    "TECH":        "#3730a3",
    "EARNINGS":    "#065f46",
    "ASIA":        "#9a3412",
    "FX":          "#374151",
    "COMMODITIES": "#78350f",
    "CREDIT":      "#581c87",
}

MARKETS_DISPLAY = {
    "NYSE":     ("USA",         "NYSE"),
    "Nasdaq":   ("USA",         "Nasdaq"),
    "US Bond":  ("USA",         "US Bond (Treasury/SIFMA)"),
    "LSE":      ("UK",          "LSE"),
    "HKEX":     ("Hong Kong",   "HKEX cash"),
    "KRX":      ("South Korea", "KRX"),
    "TSE":      ("Japan",       "TSE"),
    "SGX":      ("Singapore",   "SGX"),
    "Euronext": ("Europe",      "Euronext"),
    "SIX":      ("Switzerland", "SIX Swiss"),
    "Xetra":    ("Germany",     "Xetra"),
}


def esc(s: str) -> str:
    return html.escape(s or "", quote=False)


def fmt_pct(p: float | None) -> str:
    return f"{p:+.2f}%" if p is not None else "n/a"


def fmt_num(v: float | None) -> str:
    if v is None:
        return "n/a"
    if abs(v) >= 1000:
        return f"{v:,.2f}"
    return f"{v:.2f}"


def move_class(p: float | None) -> str:
    if p is None:
        return "flat"
    if p > 0.05:
        return "up"
    if p < -0.05:
        return "down"
    return "flat"


def render_hero(qmap: dict[str, Quote]) -> str:
    layout = [
        ("^GSPC", "S&P 500"), ("^IXIC", "Nasdaq"), ("^DJI", "Dow"),
        ("^N225", "Nikkei"), ("^HSI", "Hang Seng"), ("^TNX", "US 10Y"),
    ]
    cells: list[str] = []
    for sym, lbl in layout:
        q = qmap.get(sym)
        if not q or q.price is None:
            continue
        cls = move_class(q.change_pct)
        cells.append(
            f'<div class="hero-cell"><div class="lbl">{esc(lbl)}</div>'
            f'<div class="val">{fmt_num(q.price)}</div>'
            f'<div class="sub {cls}">{fmt_pct(q.change_pct)}</div></div>'
        )
    return f'<div class="hero-grid">{"".join(cells)}</div>'


def render_compact_markets(quotes: list[Quote]) -> str:
    """Single compact 2-column table covering indices/rates/commods/FX."""
    rows = [q for q in quotes if q.price is not None and q.error is None]
    if not rows:
        return ""
    half = (len(rows) + 1) // 2
    left, right = rows[:half], rows[half:]

    def row(q: Quote) -> str:
        cls = move_class(q.change_pct)
        return (
            f'<tr><td class="lbl">{esc(q.label)}</td>'
            f'<td class="num">{fmt_num(q.price)}</td>'
            f'<td class="num {cls}"><b>{fmt_pct(q.change_pct)}</b></td></tr>'
        )

    def col(items: list[Quote]) -> str:
        return f'<table class="mkt"><tbody>{"".join(row(q) for q in items)}</tbody></table>'

    return f'<div class="mkt-cols"><div>{col(left)}</div><div>{col(right)}</div></div>'


def render_story(s: dict[str, Any], qmap: dict[str, Quote]) -> str:
    cat = (s.get("category") or "").upper().strip()
    cat_color = CATEGORY_COLORS.get(cat, "#374151")
    rank = s.get("rank") or "?"
    headline = esc(s.get("headline") or "")
    summary = esc(s.get("summary") or "")
    reaction = esc(s.get("market_reaction") or "")
    sources = s.get("sources") or []
    src_line = " · ".join(esc(x) for x in sources)

    chips: list[str] = []
    for t in (s.get("tickers") or [])[:6]:
        t = str(t).strip()
        if not t:
            continue
        q = qmap.get(t)
        if q and q.change_pct is not None:
            cls = move_class(q.change_pct)
            chips.append(
                f'<span class="chip {cls}">{esc(t)} <b>{fmt_pct(q.change_pct)}</b></span>'
            )
        else:
            chips.append(f'<span class="chip">{esc(t)}</span>')

    chips_html = '<div class="chips">' + " ".join(chips) + "</div>" if chips else ""

    return f"""
<div class="story">
  <div class="story-head">
    <span class="rank">{esc(str(rank))}</span>
    <span class="cat" style="background:{cat_color}">{esc(cat or "—")}</span>
    <span class="hl">{headline}</span>
  </div>
  <div class="body">{summary} <span class="reaction"><b>↳ Read-through:</b> {reaction}</span></div>
  {chips_html}
  <div class="sources">{src_line}</div>
</div>
"""


def render_forward(items: list[dict[str, Any]], qmap: dict[str, Quote]) -> str:
    if not items:
        return '<div class="fwd-empty">No qualifying forward-looking items.</div>'
    rows: list[str] = []
    for f in items:
        when = esc(f.get("when") or "")
        event = esc(f.get("event") or "")
        why = esc(f.get("why") or "")
        tickers = (f.get("tickers") or [])[:5]
        chips = " ".join(
            f'<span class="chip-sm">{esc(str(t))}</span>' for t in tickers if str(t).strip()
        )
        rows.append(
            f'<li><b>{when}</b> — {event} {chips}<div class="why">{why}</div></li>'
        )
    return f'<ol class="forward">{"".join(rows)}</ol>'


def render_holiday_table(items: list[dict[str, Any]]) -> str:
    if not items:
        return ""
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for h in items:
        by_date[h["date"]].append(h)

    enumerated = ["NYSE", "Nasdaq", "US Bond", "LSE", "Euronext", "SIX", "Xetra",
                  "TSE", "HKEX", "KRX", "SGX"]
    blocks: list[str] = []
    for date_str in sorted(by_date.keys()):
        same_day = by_date[date_str]
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
        names = sorted({h["name"] for h in same_day})
        heading = f"{d.strftime('%a %-d %b')} — " + " / ".join(names)
        closed_map: dict[str, str] = {}
        for h in same_day:
            for mk in h.get("markets", []):
                closed_map.setdefault(mk, h["name"])
        rows: list[str] = []
        for mk in enumerated:
            region, full = MARKETS_DISPLAY.get(mk, (mk, mk))
            if mk in closed_map:
                rows.append(
                    f'<tr><td>{esc(full)}</td><td>{esc(region)}</td>'
                    f'<td><span class="pill closed">CLOSED</span></td>'
                    f'<td>{esc(closed_map[mk])}</td></tr>'
                )
            else:
                rows.append(
                    f'<tr><td>{esc(full)}</td><td>{esc(region)}</td>'
                    f'<td><span class="pill open">OPEN</span></td>'
                    f'<td class="muted">Normal</td></tr>'
                )
        blocks.append(
            f'<tr class="hdr"><td colspan="4">{esc(heading)}</td></tr>' + "".join(rows)
        )
    return f"""
<table class="hol">
  <thead><tr><th>Market</th><th>Region</th><th>Status</th><th>Notes</th></tr></thead>
  <tbody>{''.join(blocks)}</tbody>
</table>
"""


CSS = """
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:#111; background:#fff; margin:0; padding:18px; line-height:1.38; font-size:13px; }
.wrap { max-width: 820px; margin: 0 auto; }
h1 { font-size:20px; margin:0; }
.subhead { color:#555; font-size:11.5px; margin: 2px 0 12px; }
.banner { background:#b91c1c; color:#fff; padding:5px 10px; font-size:11px; border-radius:3px; margin-bottom:10px; }
.section { background:#1f2937; color:#fff; padding:6px 10px; font-weight:600; font-size:12px; margin:14px 0 6px; border-radius:3px; }
.hero-grid { display:grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap:6px; margin:8px 0 12px; }
.hero-cell { border:1px solid #e5e7eb; padding:6px 8px; border-radius:4px; background:#fafafa; }
.hero-cell .lbl { font-size:10px; color:#6b7280; text-transform:uppercase; letter-spacing:0.4px; }
.hero-cell .val { font-size:15px; font-weight:700; margin-top:1px; font-variant-numeric: tabular-nums; }
.hero-cell .sub { font-size:11.5px; font-weight:600; font-variant-numeric: tabular-nums; }
.up { color:#047857; }
.down { color:#b91c1c; }
.flat { color:#6b7280; }
.mkt-cols { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
table.mkt { width:100%; border-collapse: collapse; font-size:12px; }
table.mkt td { border-bottom:1px solid #f1f5f9; padding:3px 6px; }
table.mkt td.lbl { color:#111; font-weight:500; }
table.mkt td.num { text-align:right; font-variant-numeric: tabular-nums; }
.story { border-left: 4px solid #1f2937; padding: 6px 10px; margin: 7px 0; background:#fafafa; border-radius: 0 3px 3px 0; }
.story-head { display:flex; align-items:center; gap:7px; margin-bottom:3px; flex-wrap:wrap; }
.story-head .rank { font-weight:700; color:#1f2937; font-size:13px; }
.story-head .cat { color:#fff; font-size:9.5px; font-weight:700; padding:1px 6px; border-radius:2px; letter-spacing:0.4px; }
.story-head .hl { font-weight:600; font-size:13px; flex:1; min-width:0; }
.story .body { font-size:12px; color:#111; margin: 2px 0; }
.story .reaction { color:#374151; }
.story .sources { color:#6b7280; font-size:10.5px; margin-top:3px; font-style:italic; }
.chips { margin-top: 4px; }
.chip { display:inline-block; border:1px solid #d1d5db; border-radius:10px; padding:1px 7px; font-size:10.5px; margin: 2px 3px 0 0; background:#fff; font-variant-numeric: tabular-nums; }
.chip.up { border-color:#a7f3d0; background:#ecfdf5; color:#047857; }
.chip.down { border-color:#fecaca; background:#fef2f2; color:#b91c1c; }
.chip-sm { display:inline-block; border:1px solid #d1d5db; border-radius:8px; padding:0 6px; font-size:10px; background:#fff; margin-left:4px; color:#374151; }
ol.forward { margin: 4px 0; padding-left: 20px; font-size:12px; }
ol.forward li { margin-bottom: 4px; }
ol.forward .why { color:#374151; font-size:11.5px; margin-top:1px; }
.fwd-empty { color:#6b7280; font-style:italic; font-size:11.5px; }
.hol { width:100%; border-collapse: collapse; font-size:11.5px; margin: 4px 0 8px; }
.hol th, .hol td { border:1px solid #e5e7eb; padding:3px 6px; text-align:left; }
.hol th { background:#f3f4f6; font-size:11px; font-weight:600; }
.hol .hdr td { background:#1f2937; color:#fff; font-weight:600; }
.hol .muted { color:#6b7280; }
.pill { display:inline-block; padding:0 6px; border-radius:2px; font-size:10px; font-weight:700; letter-spacing:0.3px; }
.pill.closed { background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; }
.pill.open   { background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; }
.footer { color:#6b7280; font-size:10.5px; border-top:1px solid #e5e7eb; padding-top:6px; margin-top:14px; }
"""


def render_brief(quotes: list[Quote], curated: dict[str, Any],
                 holiday_items: list[dict[str, Any]],
                 now_sgt: datetime) -> tuple[str, str]:
    qmap = {q.symbol: q for q in quotes}

    title = f"Market Pulse · {now_sgt.strftime('%a %-d %b %Y')} · 07:30 SGT"
    hero = render_hero(qmap)
    mkt_table = render_compact_markets(quotes)
    holiday_html = render_holiday_table(holiday_items)
    stories = curated.get("stories") or []
    forward = curated.get("forward") or []

    stories_html = "".join(render_story(s, qmap) for s in stories[:5])
    if not stories_html:
        stories_html = '<div class="fwd-empty">News curation unavailable this run — check ANTHROPIC_API_KEY.</div>'

    forward_html = render_forward(forward[:3], qmap)
    holiday_section = ('<div class="section">Market closures · this week</div>' + holiday_html) if holiday_html else ""

    body = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{esc(title)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
  <div class="banner">For information only · Not investment advice · Prices via Yahoo Finance (last close) · News curated by Claude with web search across reputable wires</div>
  <h1>{esc(title)}</h1>
  <div class="subhead">Global Markets · Geopolitics · Macro · Asia Watch · Tech &amp; AI</div>

  {hero}

  <div class="section">Markets at a glance · last close</div>
  {mkt_table}

  {holiday_section}

  <div class="section">Top 5 market-moving stories · last 24h</div>
  {stories_html}

  <div class="section">3 forward-looking developments · next 24–48h</div>
  {forward_html}

  <div class="footer">Generated {esc(now_sgt.strftime('%Y-%m-%d %H:%M %Z'))} · Prices via yfinance · Curation via Claude Opus 4.7 with web search across Reuters, Bloomberg, WSJ, FT, CNBC, Nikkei Asia, AP.</div>
</div></body></html>"""

    plain = title + "\n\nThis brief is HTML — view in an HTML-capable mail client.\n\n"
    for s in stories[:5]:
        plain += f"  {s.get('rank', '?')}. [{s.get('category', '')}] {s.get('headline', '')}\n"
    plain += "\nForward-looking:\n"
    for f in forward[:3]:
        plain += f"  · {f.get('when', '')} — {f.get('event', '')}\n"

    return body, plain


# ─────────────────────────── Email ───────────────────────────────────────────


def send_email(subject: str, html_body: str, text_body: str) -> None:
    sender = os.environ["GMAIL_USER"]
    app_pw = os.environ["GMAIL_APP_PASSWORD"]
    to = os.environ.get("EMAIL_TO", sender)

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to
    msg.set_content(text_body)
    msg.add_alternative(html_body, subtype="html")

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx, timeout=30) as s:
        s.login(sender, app_pw)
        s.send_message(msg)


# ─────────────────────────── Main ────────────────────────────────────────────


def main() -> int:
    now_sgt = datetime.now(SGT)

    universe = INDICES + YIELDS + COMMODITIES + FX
    print(f"[info] fetching {len(universe)} quotes", file=sys.stderr)
    quotes = fetch_quotes(universe)

    holiday_items = holidays_for_week(now_sgt)
    holiday_today = any(h["_date"] == now_sgt.date() for h in holiday_items)

    if os.environ.get("ANTHROPIC_API_KEY"):
        print("[info] curating with Claude Opus 4.7 + web_search", file=sys.stderr)
        try:
            curated = curate_with_claude(quotes, now_sgt, holiday_today)
        except Exception as e:  # noqa: BLE001
            print(f"[error] Claude curation failed: {e}", file=sys.stderr)
            curated = {"stories": [], "forward": []}
    else:
        print("[warn] ANTHROPIC_API_KEY not set; brief will render without news", file=sys.stderr)
        curated = {"stories": [], "forward": []}

    # Fetch quotes for any tickers Claude tagged that we don't already have.
    extra: list[tuple[str, str]] = []
    seen = {q.symbol for q in quotes}
    for s in (curated.get("stories") or [])[:5]:
        for t in (s.get("tickers") or [])[:6]:
            t = str(t).strip()
            if t and t not in seen:
                extra.append((t, t))
                seen.add(t)
    if extra:
        print(f"[info] fetching {len(extra)} story-tagged tickers", file=sys.stderr)
        quotes.extend(fetch_quotes(extra[:30]))

    html_doc, plain = render_brief(quotes, curated, holiday_items, now_sgt)

    subject = f"Market Pulse · {now_sgt.strftime('%a %-d %b %Y')} · 07:30 SGT"

    if os.environ.get("BRIEF_DRY_RUN") == "1":
        out = REPO_ROOT / "brief.html"
        out.write_text(html_doc)
        print(f"[ok] dry run — wrote {out}", file=sys.stderr)
        return 0

    send_email(subject, html_doc, plain)
    print(f"[ok] sent: {subject}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

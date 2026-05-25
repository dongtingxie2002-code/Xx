"""Daily market brief generator.

Runs from GitHub Actions at 07:30 SGT. Pulls prices from Yahoo Finance,
news from Finnhub and/or MarketAux, ranks stories by source weight +
recency + cross-source confirmation, and emails an HTML brief via Gmail
SMTP. Layout matches the supplied Market Pulse sample.

Required env vars:
  GMAIL_USER, GMAIL_APP_PASSWORD, EMAIL_TO
At least one of:
  FINNHUB_API_KEY, MARKETAUX_API_KEY
Optional:
  BRIEF_DRY_RUN=1   -> write brief.html locally, skip SMTP
"""

from __future__ import annotations

import html
import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import logging
logging.getLogger("yfinance").setLevel(logging.CRITICAL)

SGT = ZoneInfo("Asia/Singapore")
NY = ZoneInfo("America/New_York")
UA = "Mozilla/5.0 (compatible; XieMarketBrief/1.0)"

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

# Source reputation weights (higher = more credible / market-moving).
SOURCE_WEIGHTS = {
    "reuters": 10, "reuters.com": 10,
    "bloomberg": 10, "bloomberg.com": 10,
    "wsj": 10, "wsj.com": 10, "wall street journal": 10,
    "ft": 9, "ft.com": 9, "financial times": 9,
    "cnbc": 8, "cnbc.com": 8,
    "nikkei": 8, "nikkei.com": 8, "asia.nikkei.com": 8,
    "scmp": 7, "scmp.com": 7,
    "the information": 9, "theinformation.com": 9,
    "ap": 7, "ap news": 7, "apnews.com": 7,
    "axios": 6, "axios.com": 6,
    "marketwatch": 6, "marketwatch.com": 6,
    "yahoo": 5, "yahoo finance": 5, "finance.yahoo.com": 5,
    "fox business": 5, "foxbusiness.com": 5,
    "seeking alpha": 5, "seekingalpha.com": 5,
    "barron's": 7, "barrons.com": 7,
    "the economist": 8, "economist.com": 8,
}

# Keyword weight bumps for market-moving terms.
HIGH_IMPACT_KEYWORDS = {
    # Macro / Fed
    "fed": 6, "fomc": 7, "powell": 5, "warsh": 5, "rate cut": 6, "rate hike": 6,
    "inflation": 4, "cpi": 6, "pce": 6, "ppi": 4, "payrolls": 6, "jobs report": 5,
    "gdp": 4, "recession": 5, "treasury": 3, "yield": 3,
    # Geopolitics
    "iran": 6, "russia": 5, "ukraine": 4, "china": 4, "taiwan": 5, "north korea": 4,
    "tariff": 6, "sanction": 4, "missile": 5, "strike": 4, "ceasefire": 5,
    "oil": 4, "opec": 5, "strait of hormuz": 6,
    # Tech / AI
    "nvidia": 6, "openai": 5, "anthropic": 4, "ai": 3, "chip": 4, "semiconductor": 4,
    "tsmc": 5, "samsung": 5, "sk hynix": 5, "asml": 5, "broadcom": 4,
    "earnings": 5, "guidance": 5, "beat": 3, "miss": 4, "raises": 3, "cuts forecast": 5,
    # Big single names
    "apple": 4, "microsoft": 4, "google": 4, "alphabet": 4, "amazon": 4,
    "meta": 4, "tesla": 4, "berkshire": 3, "jpmorgan": 3,
    # IPOs / corporate events
    "ipo": 4, "spinoff": 3, "merger": 4, "acquisition": 4, "buyback": 3, "dividend": 2,
    # Crypto
    "bitcoin": 3, "ethereum": 3, "etf": 3,
}

# Forward-looking phrase markers (used to pick the 3 "developments to watch").
FORWARD_PHRASES = [
    "expected", "to release", "to report", "ahead of", "next week", "this week",
    "preview", "to announce", "upcoming", "scheduled", "set to", "watch for",
    "kicks off", "deadline", "to vote", "to decide", "due", "in focus",
]

# Light entity → ticker map (used to enrich impacted-ticker callouts when the
# news API doesn't tag tickers itself).
ENTITY_TICKERS = {
    "nvidia": "NVDA", "amd": "AMD", "intel": "INTC", "broadcom": "AVGO",
    "tsmc": "TSM", "asml": "ASML", "micron": "MU",
    "samsung": "005930.KS", "sk hynix": "000660.KS", "lenovo": "0992.HK",
    "apple": "AAPL", "microsoft": "MSFT", "google": "GOOGL", "alphabet": "GOOGL",
    "amazon": "AMZN", "meta": "META", "facebook": "META", "tesla": "TSLA",
    "berkshire": "BRK-B", "jpmorgan": "JPM", "goldman": "GS",
    "exxon": "XOM", "chevron": "CVX", "occidental": "OXY",
    "boeing": "BA", "spacex": "SPCX", "openai": "(private)",
    "dell": "DELL", "hp": "HPQ", "lenovo group": "0992.HK",
    "uber": "UBER", "airbnb": "ABNB", "palantir": "PLTR",
    "bitcoin": "BTC-USD", "ethereum": "ETH-USD",
}

# ─────────────────────────── HTTP helper ─────────────────────────────────────


def http_get(url: str, *, timeout: int = 20, retries: int = 2) -> bytes:
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/html"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET failed for {url}: {last_err}")


def http_json(url: str, **kw) -> Any:
    return json.loads(http_get(url, **kw).decode("utf-8", errors="replace"))


# ─────────────────────────── Yahoo Finance ───────────────────────────────────


@dataclass
class Quote:
    symbol: str
    label: str
    price: float | None = None
    prev_close: float | None = None
    change: float | None = None
    change_pct: float | None = None
    market_time: int | None = None       # epoch seconds
    market_state: str | None = None      # PRE / REGULAR / POST / CLOSED
    currency: str | None = None
    error: str | None = None

    @property
    def is_up(self) -> bool:
        return (self.change_pct or 0) > 0

    @property
    def is_down(self) -> bool:
        return (self.change_pct or 0) < 0


def yahoo_quote(symbol: str, label: str) -> Quote:
    """yfinance handles Yahoo's cookie/crumb handshake — plain HTTP gets 403'd."""
    import yfinance as yf  # local import: dependency only loaded when needed
    q = Quote(symbol=symbol, label=label)
    try:
        t = yf.Ticker(symbol)
        hist = t.history(period="7d", auto_adjust=False, raise_errors=False)
        if hist is None or hist.empty:
            q.error = "no history"
            return q
        closes = [float(c) for c in hist["Close"].tolist() if c == c]  # drop NaN
        if len(closes) >= 2:
            last, prev = closes[-1], closes[-2]
            q.price = last
            q.prev_close = prev
            q.change = last - prev
            q.change_pct = (last / prev - 1) * 100
        elif closes:
            q.price = closes[-1]
        # Best-effort metadata; failures here are non-fatal.
        try:
            info = t.fast_info
            q.currency = getattr(info, "currency", None)
        except Exception:  # noqa: BLE001
            pass
    except Exception as e:  # noqa: BLE001
        q.error = str(e)
    return q


def fetch_quotes(universe: list[tuple[str, str]]) -> list[Quote]:
    out: list[Quote] = []
    for label, sym in universe:
        out.append(yahoo_quote(sym, label))
        time.sleep(0.10)  # gentle pacing
    return out


# ─────────────────────────── News APIs ───────────────────────────────────────


@dataclass
class Article:
    title: str
    url: str
    source: str
    summary: str = ""
    published: int = 0           # epoch seconds, UTC
    tickers: list[str] = field(default_factory=list)
    sentiment: float | None = None
    raw_source_api: str = ""
    score: float = 0.0
    cluster: int = -1


def _norm_source(s: str | None) -> str:
    return (s or "").strip().lower()


def fetch_finnhub() -> list[Article]:
    key = os.environ.get("FINNHUB_API_KEY")
    if not key:
        return []
    out: list[Article] = []
    try:
        url = f"https://finnhub.io/api/v1/news?category=general&token={key}"
        items = http_json(url) or []
        for it in items[:120]:
            out.append(Article(
                title=(it.get("headline") or "").strip(),
                url=it.get("url") or "",
                source=_norm_source(it.get("source") or ""),
                summary=(it.get("summary") or "").strip(),
                published=int(it.get("datetime") or 0),
                tickers=[t for t in (it.get("related") or "").split(",") if t],
                raw_source_api="finnhub",
            ))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] finnhub fetch failed: {e}", file=sys.stderr)
    return out


def fetch_marketaux() -> list[Article]:
    key = os.environ.get("MARKETAUX_API_KEY")
    if not key:
        return []
    out: list[Article] = []
    try:
        url = (
            "https://api.marketaux.com/v1/news/all"
            f"?api_token={key}&language=en&filter_entities=true&limit=50"
        )
        data = http_json(url) or {}
        for it in (data.get("data") or [])[:80]:
            entities = it.get("entities") or []
            tickers = [e.get("symbol") for e in entities if e.get("symbol")]
            sents = [e.get("sentiment_score") for e in entities if isinstance(e.get("sentiment_score"), (int, float))]
            sent = sum(sents) / len(sents) if sents else None
            pub = 0
            try:
                pub = int(datetime.fromisoformat((it.get("published_at") or "").replace("Z", "+00:00")).timestamp())
            except Exception:  # noqa: BLE001
                pass
            out.append(Article(
                title=(it.get("title") or "").strip(),
                url=it.get("url") or "",
                source=_norm_source(it.get("source") or ""),
                summary=(it.get("description") or it.get("snippet") or "").strip(),
                published=pub,
                tickers=tickers,
                sentiment=sent,
                raw_source_api="marketaux",
            ))
    except Exception as e:  # noqa: BLE001
        print(f"[warn] marketaux fetch failed: {e}", file=sys.stderr)
    return out


# ─────────────────────────── Ranking / Clustering ────────────────────────────

WORD_RX = re.compile(r"[A-Za-z][A-Za-z0-9'&]+")
STOP = {
    "the","a","an","and","or","but","of","to","in","on","at","for","with","by",
    "is","are","was","were","be","been","being","as","that","this","it","its",
    "from","into","over","after","before","amid","amidst","up","down","says","say",
    "said","new","near","via","plus","minus","could","may","might","will","would",
}


def tokenset(text: str) -> set[str]:
    return {w.lower() for w in WORD_RX.findall(text or "") if w.lower() not in STOP and len(w) > 2}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = a & b
    union = a | b
    return len(inter) / len(union)


def score_article(a: Article, now_utc: int) -> float:
    src_w = SOURCE_WEIGHTS.get(a.source, 3)
    # Recency: linear decay over 36h.
    age_h = max(0, (now_utc - (a.published or now_utc)) / 3600)
    recency = max(0.0, 1.0 - age_h / 36.0)
    body = f"{a.title} {a.summary}".lower()
    kw = sum(w for term, w in HIGH_IMPACT_KEYWORDS.items() if term in body)
    tic = min(len(a.tickers), 4)
    return src_w * 1.0 + kw * 0.8 + recency * 8.0 + tic * 1.5


def cluster_articles(arts: list[Article]) -> list[list[Article]]:
    """Greedy single-pass clustering by title token Jaccard ≥ 0.35."""
    clusters: list[list[Article]] = []
    cluster_tokens: list[set[str]] = []
    for a in arts:
        toks = tokenset(a.title)
        placed = False
        for i, ct in enumerate(cluster_tokens):
            if jaccard(toks, ct) >= 0.35:
                clusters[i].append(a)
                cluster_tokens[i] = ct | toks
                placed = True
                break
        if not placed:
            clusters.append([a])
            cluster_tokens.append(toks)
    return clusters


def is_forward_looking(a: Article) -> bool:
    body = f"{a.title} {a.summary}".lower()
    return any(p in body for p in FORWARD_PHRASES)


def select_stories(arts: list[Article]) -> tuple[list[list[Article]], list[Article]]:
    """Return (top5 clusters for 'Today's Drivers', 3 forward-looking articles)."""
    now_utc = int(datetime.now(timezone.utc).timestamp())
    for a in arts:
        a.score = score_article(a, now_utc)
    arts_sorted = sorted(arts, key=lambda x: x.score, reverse=True)

    clusters = cluster_articles(arts_sorted)
    # Cluster strength = sum of top-3 article scores + bonus for source diversity.
    def cluster_strength(c: list[Article]) -> float:
        c_sorted = sorted(c, key=lambda x: x.score, reverse=True)
        base = sum(x.score for x in c_sorted[:3])
        srcs = len({x.source for x in c if x.source})
        return base + srcs * 1.5

    clusters_sorted = sorted(clusters, key=cluster_strength, reverse=True)
    top5 = clusters_sorted[:5]

    used_titles = {a.title for c in top5 for a in c}
    forward = [a for a in arts_sorted if is_forward_looking(a) and a.title not in used_titles]
    return top5, forward[:3]


# ─────────────────────────── Holidays ────────────────────────────────────────


def load_holidays() -> dict[str, Any]:
    path = REPO_ROOT / "holidays.json"
    return json.loads(path.read_text())


def holidays_for_week(now_sgt: datetime) -> list[dict[str, Any]]:
    """Return all market closures inside this week (Mon-Sun)."""
    monday = (now_sgt - timedelta(days=now_sgt.weekday())).date()
    sunday = monday + timedelta(days=6)
    data = load_holidays()
    years = {str(monday.year), str(sunday.year)}
    year_block = [h for y in years for h in data.get(y, [])]
    out: list[dict[str, Any]] = []
    for h in year_block:
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


# ─────────────────────────── HTML rendering ──────────────────────────────────

MARKETS_DISPLAY = {
    "NYSE":     ("USA",         "NYSE — New York Stock Exchange"),
    "Nasdaq":   ("USA",         "Nasdaq"),
    "US Bond":  ("USA",         "US Bond Market (Treasury / SIFMA)"),
    "LSE":      ("UK",          "LSE — London Stock Exchange"),
    "HKEX":     ("Hong Kong",   "HKEX — Hong Kong Exchange (cash)"),
    "KRX":      ("South Korea", "KRX — Korea Exchange"),
    "TSE":      ("Japan",       "TSE — Tokyo Stock Exchange"),
    "SGX":      ("Singapore",   "SGX — Singapore Exchange"),
    "Euronext": ("Europe",      "Euronext (Paris/Amsterdam/etc.)"),
    "SIX":      ("Switzerland", "SIX Swiss Exchange"),
    "Xetra":    ("Germany",     "Xetra / Frankfurt"),
}


def fmt_pct(p: float | None) -> str:
    if p is None:
        return "n/a"
    return f"{p:+.2f}%"


def fmt_num(v: float | None, *, digits: int = 2) -> str:
    if v is None:
        return "n/a"
    if abs(v) >= 1000:
        return f"{v:,.{digits}f}"
    return f"{v:.{digits}f}"


def move_class(p: float | None) -> str:
    if p is None:
        return "flat"
    if p > 0.05:
        return "up"
    if p < -0.05:
        return "down"
    return "flat"


def esc(s: str) -> str:
    return html.escape(s or "", quote=False)


def render_quote_row(q: Quote) -> str:
    cls = move_class(q.change_pct)
    pct_html = f'<span class="move {cls}">{fmt_pct(q.change_pct)}</span>'
    price_html = fmt_num(q.price)
    return (
        f'<tr><td class="asset">{esc(q.label)}</td>'
        f'<td class="num">{price_html}</td>'
        f'<td class="num">{pct_html}</td>'
        f'<td class="basis">{esc(q.symbol)}</td></tr>'
    )


def render_market_table(title: str, quotes: list[Quote]) -> str:
    rows = "\n".join(render_quote_row(q) for q in quotes if q.error is None)
    if not rows:
        return ""
    return f"""
<table class="mkt">
  <thead><tr><th>{esc(title)}</th><th class="num">Latest</th><th class="num">Move</th><th>Symbol</th></tr></thead>
  <tbody>{rows}</tbody>
</table>
"""


def render_holiday_table(items: list[dict[str, Any]], now_sgt: datetime) -> str:
    if not items:
        return ""
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for h in items:
        by_date[h["date"]].append(h)

    # Markets to enumerate on every closure day, in display order.
    enumerated = ["NYSE", "Nasdaq", "US Bond", "LSE", "Euronext", "SIX", "Xetra",
                  "TSE", "HKEX", "KRX", "SGX"]

    blocks: list[str] = []
    for date_str in sorted(by_date.keys()):
        same_day = by_date[date_str]
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
        dow = d.strftime("%a")
        names = sorted({h["name"] for h in same_day})
        heading = f"{dow} · {d.strftime('%-d %b %Y')} — " + " / ".join(names)
        # Build closure map: market → holiday name
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
                    f'<td class="basis">Normal trading</td></tr>'
                )
        blocks.append(
            f'<tr class="hdr"><td colspan="4">{esc(heading)}</td></tr>' + "".join(rows)
        )

    return f"""
<table class="hol">
  <thead><tr><th>Market / Exchange</th><th>Region</th><th>Status</th><th>Holiday / Notes</th></tr></thead>
  <tbody>{''.join(blocks)}</tbody>
</table>
"""


def render_story(idx: int, cluster: list[Article], quote_lookup: dict[str, Quote]) -> str:
    lead = max(cluster, key=lambda a: a.score)
    other_sources = sorted({a.source for a in cluster if a.source and a.source != lead.source})
    src_line = lead.source.upper() if lead.source else ""
    if other_sources:
        src_line += " · cross-ref: " + ", ".join(s.upper() for s in other_sources[:3])

    # Impacted tickers: union of API-tagged + entity-match from text.
    body = f"{lead.title} {lead.summary}".lower()
    tickers: list[str] = []
    seen: set[str] = set()
    for a in cluster:
        for t in a.tickers:
            if t and t not in seen:
                tickers.append(t); seen.add(t)
    for ent, tk in ENTITY_TICKERS.items():
        if ent in body and tk not in seen:
            tickers.append(tk); seen.add(tk)
    tickers = tickers[:8]

    ticker_chips: list[str] = []
    for t in tickers:
        q = quote_lookup.get(t)
        if q and q.change_pct is not None:
            cls = move_class(q.change_pct)
            ticker_chips.append(
                f'<span class="chip {cls}">{esc(t)} {fmt_pct(q.change_pct)}</span>'
            )
        else:
            ticker_chips.append(f'<span class="chip">{esc(t)}</span>')

    pub_label = ""
    if lead.published:
        pub_dt = datetime.fromtimestamp(lead.published, tz=timezone.utc).astimezone(SGT)
        pub_label = pub_dt.strftime("%-d %b · %H:%M SGT")

    body_para = esc(lead.summary or lead.title)

    return f"""
<div class="story">
  <div class="story-head">
    <span class="num-tag">{idx}.</span>
    <a class="story-title" href="{esc(lead.url)}">{esc(lead.title)}</a>
  </div>
  <div class="story-meta">{esc(src_line)}{' · ' + esc(pub_label) if pub_label else ''}</div>
  <div class="story-body">{body_para}</div>
  {('<div class="chips">' + ' '.join(ticker_chips) + '</div>') if ticker_chips else ''}
</div>
"""


def render_forward(arts: list[Article]) -> str:
    if not arts:
        return ""
    items = []
    for a in arts:
        pub_label = ""
        if a.published:
            pub_dt = datetime.fromtimestamp(a.published, tz=timezone.utc).astimezone(SGT)
            pub_label = pub_dt.strftime("%-d %b · %H:%M SGT")
        items.append(
            f'<li><a href="{esc(a.url)}">{esc(a.title)}</a>'
            f' <span class="meta">— {esc(a.source.upper())}{" · " + esc(pub_label) if pub_label else ""}</span>'
            f'<div class="story-body">{esc(a.summary)}</div></li>'
        )
    return f'<ul class="forward">{"".join(items)}</ul>'


CSS = """
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color:#1a1a1a; background:#fff; margin:0; padding:24px; line-height:1.45; font-size:13.5px; }
.wrap { max-width: 880px; margin: 0 auto; }
h1 { font-size:22px; margin:0 0 4px 0; letter-spacing:0.2px; }
.subhead { color:#555; font-size:12.5px; margin-bottom:18px; }
.section-title { background:#1f2937; color:#fff; padding:8px 12px; font-weight:600; margin:20px 0 8px 0; font-size:13px; }
.banner-red { background:#b91c1c; color:#fff; padding:6px 12px; font-size:12px; }
.hero-grid { display:grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap:8px; margin:12px 0 16px; }
.hero-cell { border:1px solid #e5e7eb; padding:8px 10px; border-radius:4px; }
.hero-cell .lbl { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px; }
.hero-cell .val { font-size:16px; font-weight:600; margin-top:2px; }
.hero-cell .sub { font-size:11px; margin-top:2px; }
.up   { color:#047857; }
.down { color:#b91c1c; }
.flat { color:#6b7280; }
table { width:100%; border-collapse: collapse; font-size:12.5px; margin: 4px 0 14px; }
th, td { border:1px solid #e5e7eb; padding:6px 8px; text-align:left; vertical-align:top; }
th { background:#f3f4f6; font-weight:600; font-size:12px; }
td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; }
td.asset { font-weight:500; }
td.basis { color:#6b7280; font-size:11.5px; }
.move { font-weight:600; font-variant-numeric: tabular-nums; }
.story { border-left:4px solid #1f2937; padding: 6px 12px 10px; margin: 10px 0; background:#fafafa; }
.story-head { display:flex; gap:6px; align-items:baseline; margin-bottom:2px; }
.num-tag { font-weight:700; color:#1f2937; }
.story-title { color:#0b3a82; font-weight:600; text-decoration:none; font-size:13.5px; }
.story-title:hover { text-decoration: underline; }
.story-meta { color:#6b7280; font-size:11px; margin-bottom:6px; }
.story-body { font-size:12.5px; color:#111; }
.chips { margin-top:6px; }
.chip { display:inline-block; border:1px solid #d1d5db; border-radius:12px; padding:1px 8px; font-size:11px; margin: 2px 4px 2px 0; background:#fff; }
.chip.up { border-color:#a7f3d0; background:#ecfdf5; color:#047857; }
.chip.down { border-color:#fecaca; background:#fef2f2; color:#b91c1c; }
.forward { padding-left: 18px; }
.forward li { margin-bottom: 10px; }
.forward .meta { color:#6b7280; font-size:11px; }
.hol .hdr td { background:#1f2937; color:#fff; font-weight:600; }
.pill { display:inline-block; padding:1px 7px; border-radius:3px; font-size:11px; font-weight:600; }
.pill.closed { background:#fee2e2; color:#b91c1c; border:1px solid #fecaca; }
.pill.open   { background:#d1fae5; color:#065f46; border:1px solid #a7f3d0; }
.pill.partial{ background:#fef3c7; color:#92400e; border:1px solid #fde68a; }
.footer { color:#6b7280; font-size:11px; border-top:1px solid #e5e7eb; padding-top:10px; margin-top:20px; }
a { color:#0b3a82; }
"""


def render_hero(quotes: dict[str, Quote]) -> str:
    cells: list[tuple[str, str, str, str]] = []
    def cell(key: str, label: str) -> tuple[str, str, str, str] | None:
        q = quotes.get(key)
        if not q or q.price is None:
            return None
        cls = move_class(q.change_pct)
        return (label, fmt_num(q.price), f'<span class="{cls}">{fmt_pct(q.change_pct)}</span>', q.symbol)

    for key, lbl in [("^DJI","Dow Jones"), ("^GSPC","S&P 500"), ("^IXIC","Nasdaq"),
                     ("^N225","Nikkei 225"), ("^HSI","Hang Seng"), ("^TNX","US 10Y")]:
        c = cell(key, lbl)
        if c:
            cells.append(c)

    html_cells = []
    for lbl, val, sub, sym in cells:
        html_cells.append(
            f'<div class="hero-cell"><div class="lbl">{esc(lbl)}</div>'
            f'<div class="val">{val}</div><div class="sub">{sub} <span class="basis">· {esc(sym)}</span></div></div>'
        )
    return f'<div class="hero-grid">{"".join(html_cells)}</div>'


def render_brief(quotes_list: list[Quote], top5: list[list[Article]],
                 forward: list[Article], holiday_items: list[dict[str, Any]],
                 articles_all: list[Article], now_sgt: datetime) -> tuple[str, str]:
    quote_lookup = {q.symbol: q for q in quotes_list}
    # Also key by label for hero
    by_key = {q.symbol: q for q in quotes_list}

    title = f"Market Pulse · {now_sgt.strftime('%a %-d %b %Y')} · 07:30 SGT"
    subhead = "Global Markets · Geopolitics · Macro · Asia Watch · Tech & AI"

    hero_html = render_hero(by_key)

    idx_table = render_market_table("Indices · last close",
                                    [q for q in quotes_list if q.symbol in {s for _, s in INDICES}])
    yld_table = render_market_table("Rates · CMT",
                                    [q for q in quotes_list if q.symbol in {s for _, s in YIELDS}])
    cmd_table = render_market_table("Commodities · front-month",
                                    [q for q in quotes_list if q.symbol in {s for _, s in COMMODITIES}])
    fx_table  = render_market_table("FX",
                                    [q for q in quotes_list if q.symbol in {s for _, s in FX}])

    stories_html = "".join(render_story(i + 1, c, quote_lookup) for i, c in enumerate(top5)) \
        if top5 else '<div class="story-body">No qualifying news returned by the configured providers.</div>'

    forward_html = render_forward(forward)

    holiday_html = render_holiday_table(holiday_items, now_sgt)
    holiday_section = ""
    if holiday_html:
        holiday_section = (
            '<div class="section-title">Market Holiday Schedule · This week</div>'
            + holiday_html
        )

    src_used = sorted({a.source for a in articles_all if a.source})
    src_log = " · ".join(s.upper() for s in src_used) if src_used else ""

    html_doc = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{esc(title)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">
  <div class="banner-red">Latest fully-settled close + Asia preopen overlay · For information only · Not investment advice</div>
  <h1>{esc(title)}</h1>
  <div class="subhead">{esc(subhead)}</div>

  {hero_html}

  <div class="section-title">Markets at a Glance</div>
  {idx_table}
  {yld_table}
  {cmd_table}
  {fx_table}

  {holiday_section}

  <div class="section-title">Top News · Today's Drivers (5)</div>
  {stories_html}

  <div class="section-title">Developments to Watch · Next 24–48 Hours (3)</div>
  {forward_html or '<div class="story-body">No forward-looking items qualifying this morning.</div>'}

  <div class="footer">
    Sources used this brief: {esc(src_log)}<br>
    Prices via Yahoo Finance (last completed daily close). News via Finnhub / MarketAux.<br>
    Generated {esc(now_sgt.strftime('%Y-%m-%d %H:%M:%S %Z'))}. For information only. Not investment advice.
  </div>
</div></body></html>"""

    plain = (
        f"{title}\n{subhead}\n\n"
        "This brief is HTML — please view in an HTML-capable client.\n\n"
        "Top stories:\n"
        + "\n".join(f"  {i+1}. {max(c, key=lambda a: a.score).title}" for i, c in enumerate(top5))
        + "\n\nForward-looking:\n"
        + "\n".join(f"  · {a.title}" for a in forward)
    )
    return html_doc, plain


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

    # Also fetch quotes for tickers tagged in clustered stories (deferred).
    print("[info] fetching news", file=sys.stderr)
    arts = fetch_finnhub() + fetch_marketaux()
    # Drop empties / very old.
    cutoff = int((datetime.now(timezone.utc) - timedelta(hours=48)).timestamp())
    arts = [a for a in arts if a.title and (a.published == 0 or a.published >= cutoff)]
    print(f"[info] {len(arts)} articles after cutoff", file=sys.stderr)

    top5, forward = select_stories(arts)

    # Now pull quotes for tickers seen in the top stories.
    extra_tickers: list[str] = []
    seen = {q.symbol for q in quotes}
    for cluster in top5:
        for a in cluster:
            for t in a.tickers[:4]:
                if t and t not in seen:
                    extra_tickers.append(t); seen.add(t)
    if extra_tickers:
        extra = fetch_quotes([(t, t) for t in extra_tickers[:24]])
        quotes.extend(extra)

    holiday_items = holidays_for_week(now_sgt)

    html_doc, plain = render_brief(quotes, top5, forward, holiday_items, arts, now_sgt)

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

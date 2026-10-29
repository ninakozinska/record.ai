"""
record.ai: how long to EUR 1M ARR, and with how many people?

A Monte Carlo model: every run draws its own values for the uncertain numbers
(growth, conversion, churn, costs...) from the ranges below, then plays out
60 months. 10,000 runs per scenario give a spread instead of one guess.
When real numbers come in (from the A/B tests and the dashboard), narrow
the ranges and run it again:  python3 scripts/arr_simulation.py

ARR here = subscription revenue per year, without VAT (prices include VAT),
before store and payment fees, the way subscription businesses report it.
"""
import json
import sys

import numpy as np

N = 10_000          # runs per scenario
MONTHS = 60
TARGET_ARR = 1_000_000
VAT = 0.21          # average EU VAT inside the consumer price
STORE_FEE = 0.15    # Apple / Google small-business rate (under $1M a year)
WEB_FEE = 0.05      # Stripe: about 1.5% + EUR 0.25 on a EUR 5 payment


def tri(rng, lo, mode, hi, n=N):
    return rng.triangular(lo, mode, hi, n)


def draw(rng, s):
    """One value per run for every uncertain number. `s` = scenario overrides."""
    p = {
        # Growth: people who sign up on their own (store search, LinkedIn, word of mouth)
        "organic0": tri(rng, 150, 400, 900),          # sign-ups in month 1
        "organic_growth": tri(rng, 0.04, 0.09, 0.16),  # a month, until the ceiling
        "organic_cap": tri(rng, 8_000, 25_000, 60_000),  # sign-ups a month at most
        # Invites: new active people brought by each new active person (partner, family)
        "k": tri(rng, 0.08, 0.20, 0.40),
        # Paid ads: a share of last month's revenue goes back into ads
        "reinvest": np.full(N, s.get("reinvest", 0.25)),
        "cpa": tri(rng, 2.5, 4.5, 9.0),                # EUR per sign-up from ads
        # Funnel
        "activation": tri(rng, 0.35, 0.50, 0.65),      # sign-ups still using it after week 1
        "free_churn": tri(rng, 0.05, 0.09, 0.14),      # active free people lost a month
        "conversion": tri(rng, 0.006, 0.012, 0.025),   # active free people who start paying, a month
        "paid_churn": tri(rng, 0.025, 0.045, 0.075),   # monthly-plan subscribers lost a month
        "family_share": tri(rng, 0.40, 0.55, 0.70),
        "annual_share": tri(rng, 0.30, 0.45, 0.60),
        "store_share": tri(rng, 0.50, 0.65, 0.80),     # subscriptions bought in the apps
        # Costs a month, EUR
        "ai_free": tri(rng, 0.008, 0.02, 0.05),        # per active free person
        "ai_paid": tri(rng, 0.04, 0.10, 0.25),         # per subscriber (briefings, reminders, photos)
        "infra_user": tri(rng, 0.002, 0.004, 0.010),   # servers, storage, email per active person
        "support_paid": tri(rng, 0.05, 0.12, 0.30),    # help desk time per subscriber
        "fixed": tri(rng, 60, 120, 300),               # tools, domains, accounts
        # Company plan (B2B): an HR benefit for working parents, EUR 3 per employee a month
        "b2b_deals": tri(rng, 0.5, 1.5, 3.5),          # companies signed a month, once it starts
        "b2b_seats": tri(rng, 60, 150, 400),           # employees covered per company
        "b2b_churn": tri(rng, 0.005, 0.01, 0.02),      # companies lost a month
        "b2b_cac": tri(rng, 500, 1500, 4000),          # EUR to win a company (time, demos, a commission)
    }
    for k, v in s.get("mult", {}).items():
        p[k] = p[k] * v
    for k, v in s.get("set", {}).items():
        p[k] = np.full(N, v)
    p["solo_price"] = s.get("solo_price", 3.99)
    p["family_price"] = s.get("family_price", 5.99)
    return p


def run(scenario, seed=7):
    rng = np.random.default_rng(seed)
    p = draw(rng, scenario)
    elasticity = scenario.get("price_elasticity", 0.0)  # conversion change for the price change
    conv = p["conversion"] * (1 + elasticity)

    # Revenue per subscriber a month, without VAT; annual plans cost 10 months.
    solo, fam = p["solo_price"], p["family_price"]
    mix = p["family_share"] * fam + (1 - p["family_share"]) * solo
    arpu = mix / (1 + VAT) * (1 - p["annual_share"] * (2 / 12))
    fee = p["store_share"] * STORE_FEE + (1 - p["store_share"]) * WEB_FEE
    # Annual subscribers leave about half as often.
    churn = p["paid_churn"] * (1 - p["annual_share"] * 0.5)

    free = np.zeros(N)
    paying = np.zeros(N)
    signups_total = np.zeros(N)
    ads_total = np.zeros(N)
    profit_total = np.zeros(N)
    cash_low = np.zeros(N)          # the lowest the running profit goes: the money needed up front
    revenue_prev = np.zeros(N)
    seats = np.zeros(N)
    ads_fixed = scenario.get("ads_fixed", 0.0)          # a set ad budget a month (EUR)
    ads_from = scenario.get("ads_from", 4)
    b2b_from = scenario.get("b2b_from")                 # month the company plan starts (None = never)
    b2b_price = 3.0
    hit = np.full(N, np.nan)
    at_hit = {k: np.full(N, np.nan) for k in ("free", "paying", "signups", "cost", "margin", "ads", "profit", "seats",
                                              "signups_month")}
    arr_by_month = np.zeros((MONTHS, N))
    new_active_prev = np.zeros(N)

    for m in range(MONTHS):
        organic = np.minimum(p["organic0"] * (1 + p["organic_growth"]) ** m, p["organic_cap"])
        ads = p["reinvest"] * revenue_prev + (ads_fixed if m + 1 >= ads_from else 0.0)
        # Ads get dearer as spend grows (the cheap audiences run out).
        cpa = p["cpa"] * (1 + ads / 20_000) ** 0.35
        paid_signups = ads / cpa
        signups = organic + paid_signups
        invited = p["k"] * new_active_prev
        new_active = signups * p["activation"] + invited
        upgrades = free * conv
        free = free * (1 - p["free_churn"]) - upgrades + new_active
        paying = paying * (1 - churn) + upgrades
        b2b_cost = 0.0
        if b2b_from is not None and m + 1 >= b2b_from:
            deals = rng.poisson(p["b2b_deals"])
            seats = seats * (1 - p["b2b_churn"]) + deals * p["b2b_seats"]
            b2b_cost = deals * p["b2b_cac"]
        b2b_revenue = seats * b2b_price             # invoiced to companies: no VAT, no store fee
        revenue = paying * arpu + b2b_revenue       # a month, without VAT
        cost = ((free * (p["ai_free"] + p["infra_user"]))
                + paying * (p["ai_paid"] + p["infra_user"] + p["support_paid"])
                + seats * 0.4 * (p["ai_paid"] + p["infra_user"])  # about 40% of covered employees use it
                + p["fixed"] + paying * arpu * fee + b2b_revenue * 0.02 + b2b_cost)
        profit_total += revenue - cost - ads
        cash_low = np.minimum(cash_low, profit_total)
        signups_total += signups + invited  # invited people sign up too
        ads_total += ads
        arr = revenue * 12
        arr_by_month[m] = arr
        newly = np.isnan(hit) & (arr >= TARGET_ARR)
        hit[newly] = m + 1
        for k, v in (("free", free), ("paying", paying), ("signups", signups_total), ("cost", cost),
                     ("margin", 1 - cost / np.maximum(revenue, 1)), ("ads", ads_total), ("profit", profit_total),
                     ("seats", seats), ("signups_month", signups + invited)):
            at_hit[k][newly] = v[newly]
        revenue_prev = revenue
        new_active_prev = new_active
    return {"hit": hit, "at_hit": at_hit, "arr": arr_by_month, "arpu": arpu, "fee": fee, "p": p, "cash_low": cash_low}


def pct(a, q):
    a = a[~np.isnan(a)]
    return float(np.percentile(a, q)) if len(a) else None


def summary(name, r):
    hit = r["hit"]
    reached = ~np.isnan(hit)
    out = {
        "scenario": name,
        "p_12": float(np.mean(hit <= 12)),
        "p_18": float(np.mean(hit <= 18)),
        "p_24": float(np.mean(hit <= 24)),
        "p_36": float(np.mean(hit <= 36)),
        "p_60": float(np.mean(reached)),
        "month_p10": pct(hit, 10), "month_p50": pct(hit, 50), "month_p90": pct(hit, 90),
    }
    for k in ("paying", "free", "signups", "cost", "margin", "ads", "profit", "seats", "signups_month"):
        out[k + "_p50"] = pct(r["at_hit"][k], 50)
        out[k + "_p10"] = pct(r["at_hit"][k], 10)
        out[k + "_p90"] = pct(r["at_hit"][k], 90)
    out["arpu_month"] = float(np.median(r["arpu"]))
    out["cash_need_p50"] = float(-np.percentile(r["cash_low"], 50))
    out["cash_need_p90"] = float(-np.percentile(r["cash_low"], 10))
    out["arr_m24_p10"] = float(np.percentile(r["arr"][23], 10))
    out["arr_m24_p50"] = float(np.percentile(r["arr"][23], 50))
    out["arr_m24_p90"] = float(np.percentile(r["arr"][23], 90))
    return out


SCENARIOS = {
    "base": {},
    "no_ads": {"reinvest": 0.0},
    "price_up": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15},
    "annual_push": {"mult": {"annual_share": 1.4}},
    "family_first": {"mult": {"k": 1.4, "family_share": 1.2}},
    "premium_features": {"mult": {"conversion": 1.3}},
    "retention": {"mult": {"paid_churn": 0.75, "free_churn": 0.85}},
    "plan": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15,
             "mult": {"k": 1.25, "family_share": 1.15, "conversion": 1.25, "paid_churn": 0.8, "free_churn": 0.9,
                      "annual_share": 1.25}},
    "plan_ads": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15, "reinvest": 0.4,
                 "ads_fixed": 8000.0, "ads_from": 4,
                 "mult": {"k": 1.25, "family_share": 1.15, "conversion": 1.25, "paid_churn": 0.8, "free_churn": 0.9,
                          "annual_share": 1.25}},
    "plan_b2b": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15, "b2b_from": 9,
                 "mult": {"k": 1.25, "family_share": 1.15, "conversion": 1.25, "paid_churn": 0.8, "free_churn": 0.9,
                          "annual_share": 1.25}},
    "plan_ads_b2b": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15, "reinvest": 0.4,
                     "ads_fixed": 8000.0, "ads_from": 4, "b2b_from": 9,
                     "mult": {"k": 1.25, "family_share": 1.15, "conversion": 1.25, "paid_churn": 0.8,
                              "free_churn": 0.9, "annual_share": 1.25}},
    "stretch": {"solo_price": 4.99, "family_price": 7.99, "price_elasticity": -0.15, "reinvest": 0.5,
                "ads_fixed": 25000.0, "ads_from": 3, "b2b_from": 6,
                "mult": {"k": 1.25, "family_share": 1.15, "conversion": 1.25, "paid_churn": 0.8,
                         "free_churn": 0.9, "annual_share": 1.25, "b2b_deals": 2.0}},
}

LABELS = {
    "base": "Today's plan (EUR 3.99 / 5.99, 25% of revenue to ads)",
    "no_ads": "No paid ads",
    "price_up": "Higher prices (4.99 / 7.99), 15% fewer upgrades",
    "annual_push": "Annual plan pushed (40% more annual)",
    "family_first": "Family first (more partner invites, more Family plans)",
    "premium_features": "Stronger Premium (reminders, briefing): 30% more upgrades",
    "retention": "Better retention (25% less subscriber churn)",
    "plan": "All product levers together (prices, family, Premium, retention)",
    "plan_ads": "Levers + EUR 8,000 a month on ads from month 4",
    "plan_b2b": "Levers + company plan from month 9",
    "plan_ads_b2b": "Levers + ads + company plan",
    "stretch": "Full time and funded: EUR 25,000 a month on ads, a salesperson for companies",
}


def median_month(r):
    return float(np.median(np.nan_to_num(r["hit"], nan=MONTHS + 1)))


def sensitivity(name="plan_ads_b2b", seed=7):
    """Each uncertain number pinned to its 10th, then its 90th percentile; all else random.
    Measured as the median month the target is reached (61 = not within 5 years)."""
    rng = np.random.default_rng(seed)
    base = draw(rng, SCENARIOS[name])
    rows = []
    keys = ["organic0", "organic_growth", "organic_cap", "k", "cpa", "activation", "free_churn",
            "conversion", "paid_churn", "family_share", "annual_share", "b2b_deals", "b2b_seats"]
    for k in keys:
        lo, hi = np.percentile(base[k], 10), np.percentile(base[k], 90)
        a = median_month(run({**SCENARIOS[name], "set": {k: float(lo)}}))
        b = median_month(run({**SCENARIOS[name], "set": {k: float(hi)}}))
        rows.append({"param": k, "low_value": float(lo), "high_value": float(hi), "month_at_low": a, "month_at_high": b})
    return sorted(rows, key=lambda r: -abs(r["month_at_high"] - r["month_at_low"]))


if __name__ == "__main__":
    results = {name: summary(name, run(s)) for name, s in SCENARIOS.items()}
    curve = run(SCENARIOS["plan_ads_b2b"])["arr"]
    base_curve = run(SCENARIOS["base"])["arr"]
    fan = [{"month": m + 1,
            "plan_p10": float(np.percentile(curve[m], 10)), "plan_p50": float(np.percentile(curve[m], 50)),
            "plan_p90": float(np.percentile(curve[m], 90)),
            "base_p50": float(np.percentile(base_curve[m], 50))} for m in range(MONTHS)]
    out = {"scenarios": results, "labels": LABELS, "fan": fan, "sensitivity": sensitivity()}
    json.dump(out, sys.stdout if len(sys.argv) < 2 else open(sys.argv[1], "w"), indent=1)

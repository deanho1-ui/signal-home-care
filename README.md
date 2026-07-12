# Signal — P&G Home Care

Two static dashboards, one repo:

1. **Social Trends** (`index.html`) — tracks social trends for each Home Care
   brand team (Cascade, Dawn, Febreze, Swiffer, Mr. Clean), flags what to
   respond to, and turns any trend into an influencer brief or branded post.
   Refreshes **weekly**.
2. **Retail Search Rank** (`rank.html`) — audits **Dawn's organic search
   position** on **Amazon** and **Walmart.com** across the top dish-care terms
   (dish soap, dish detergent, dishwashing liquid, dishwasher soap, …), scores
   Dawn vs. competitors with a focus on the **top-4 organic slots**, tracks a
   **scorecard over time**, and pre-writes **what to change to raise rank**.
   Refreshes **hourly**. See [Retail Search Rank](#retail-search-rank-dawn-on-amazon--walmart) below.

The two pages link to each other via the top nav.

- **Hosting:** GitHub Pages (free, static)
- **Auto-refresh:** a scheduled GitHub Action researches public sources once a
  week, writes `data/trends.json`, and commits it — the site reads that file.
- **Compliance:** public sources only (Google Trends, Reddit, TikTok, news,
  creator coverage). No Sprinklr / Brandwatch data is ever sent anywhere.

---

## Setup (about 10 minutes, one time)

1. **Create the repo.** Put these files at the root of a new GitHub repo:
   `index.html`, `data/trends.json`, `scripts/refresh.mjs`,
   `.github/workflows/refresh.yml`, `README.md`.

2. **Add your API key as a secret.**
   Get a key at <https://console.anthropic.com> (this is the *API*, billed
   separately from a Claude subscription). Then in the repo:
   **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: your key

3. **Turn on Pages.**
   **Settings → Pages → Build and deployment → Source: Deploy from a branch →
   Branch: `main` / `(root)` → Save.**
   Your site goes live at `https://<your-username>.github.io/<repo>/`.

4. **Enable Actions** (first time). Open the **Actions** tab and enable
   workflows if prompted. Two scheduled jobs run from this repo: **Weekly Signal
   refresh** (social trends, Mondays 12:00 UTC) and **Hourly retail search-rank
   refresh** (Dawn on Amazon & Walmart, every hour). Both use the same
   `ANTHROPIC_API_KEY` secret.

5. **Run the first refresh now** (optional): **Actions → Weekly Signal refresh →
   Run workflow** (social trends) and **Actions → Hourly retail search-rank
   refresh → Run workflow** (search rank). Each researches, pre-writes its
   recommendations/briefs, and commits its data file. Pages redeploys in a
   minute or two.

That's it — from then on it updates itself weekly with zero effort.

---

## Cost

Web search on the API is about **$10 per 1,000 searches** plus normal token
cost. One weekly run does roughly 15–25 searches plus brief drafting — on the
order of **a few cents to ~$1 a week**, depending on model. Swap the model in
`.github/workflows/refresh.yml` (`SIGNAL_MODEL`) or `scripts/refresh.mjs` —
`claude-sonnet-5` is the cost-effective default; `claude-opus-4-8` is stronger.

---

## Change the schedule

Edit the cron line in `.github/workflows/refresh.yml`:

```yaml
- cron: "0 12 * * 1"   # min hour day month weekday (UTC). Mon = 1.
```

Twice a week, for example: `0 12 * * 1,4` (Mon & Thu).

---

## How the tabs work

Primary tabs are **one per brand owner**, plus an **All brands** portfolio view
for leadership. Inside each brand tab, filter by signal type — **Owned**
(mentions of that brand), **Category**, **Competitor**, **Landscape** — plus
platform chips and a **Respond now** toggle. Competitor and landscape trends are
tagged to the brands they affect, so (e.g.) The Pink Stuff shows up under
Mr. Clean and hypochlorous-acid cleaners show up under Febreze and Mr. Clean.

---

## What each trend card shows

Every trend renders with:

- **Momentum + sentiment** — the signal meter and pos/neg/neu/mix tag.
- **52-week mentions trend line** — a sparkline of the weekly mention index over
  the past year with the % change (early-year vs. most-recent weeks), so you can
  see how big it is and whether it's climbing or fading.
- **3 example links** straight to **TikTok / Instagram**, each with a one-line
  note on what's most appealing about that content (hook, format, why it spreads).
- **Recommended response** — the concrete, tactical social move for P&G.
- **Generate brief** — expands the response into a full influencer brief or a
  ready-to-post branded post (see below).

These fields are produced by the weekly refresh (`scripts/refresh.mjs`) and stored
per trend in `data/trends.json`:

```jsonc
{
  "response":    "concrete recommended social response for P&G",
  "examples":  [ { "platform": "tiktok",    "url": "https://…", "appeal": "why it resonates" }, … 3 ],
  "mentions52w": [ 52 integers, oldest→newest — directional weekly mention index (0-100) ]
}
```

If a trend hasn't been refreshed yet (or predates these fields), the dashboard
falls back gracefully: it derives a directional trend line from the momentum
score and builds real TikTok / Instagram hashtag/search deep-links, then upgrades
to the curated posts and real index on the next weekly run. The mentions index is
a directional estimate for prioritization, not a licensed metric.

---

## Briefs

On the published site, briefs for **Respond-now** trends are generated during
the weekly job and stored in `trends.json`, so they open instantly with no
client-side key. Non-priority trends show a note.

### On-demand briefs (optional upgrade)

If teams want to draft a brief for *any* trend on demand from the live site,
add a tiny serverless endpoint (Cloudflare Worker or Vercel function) that holds
the API key and proxies one call to the Messages API, then point the app's
`callClaude()` at it instead of `api.anthropic.com`. That keeps the key off the
client while enabling live generation.

---

## Retail Search Rank (Dawn on Amazon & Walmart)

`rank.html` is a second dashboard focused on **where Dawn shows up in organic
search** on **Amazon** and **Walmart.com** for the terms shoppers actually
type, and **how that's trending vs. competitors** — especially the top-4 slots.

**What it shows**

- **Scorecard strip** — for the selected retailer(s): how many terms Dawn holds
  **#1 organic**, how many it's in the **top 4**, its **average best rank**, and
  its **top-4 share of voice**, each with a **▲/▼ vs. 7 days ago** delta.
- **Per-term cards** — Dawn's best organic position (big number), an in-top-4
  badge, the **top-4 slot ladder** (with Dawn highlighted and the #1 holder
  named), a **rank-over-time line** (top-4 zone shaded; a rising line = moving
  toward #1), the **change vs. 7 days ago**, an expandable **full top-8**, and a
  **"To improve rank"** recommendation specific to that term.
- **"How to raise Dawn's organic rank"** — 6 prioritized, portfolio-level levers
  (title/keyword, backend search terms, review velocity, conversion/A+ content,
  variation strategy, price/Buy-Box, paid→organic), each tagged with impact,
  effort, and the terms it affects.

**Search terms & competitors** are configured at the top of
`scripts/rank-refresh.mjs` (`TERMS`, `RETAILERS`, `COMPETITORS`) — edit that list
to change coverage. Dawn is detected via the `OWNED_RE` pattern.

**Data files** (written by the hourly job, read by the page):

- `data/ranks.json` — the latest snapshot (per retailer × term) + scorecard + recommendations.
- `data/rank-history.json` — the appended hourly time series that powers the
  scorecard deltas and the rank-over-time lines (trimmed to ~25 days per series).

**Schedule.** The refresh runs **hourly** via
`.github/workflows/rank-refresh.yml` (`cron: "17 * * * *"`). Change the cron to
adjust cadence, e.g. `"*/30 * * * *"` for every 30 min or `"17 */4 * * *"` for
every 4 hours.

**Cost note.** Hourly × 8 terms × 2 retailers is a lot of web search
(~$10 / 1,000 searches). Each run does roughly 20–30 searches, so hourly is on
the order of a few dollars a day. Trim `TERMS`, widen the cron interval, or set
`RANK_MODEL` to a cheaper model to control spend.

**Accuracy.** Retail SERPs are personalized, location-dependent and volatile, so
the ranks are a **directional audit signal for prioritization**, not a licensed
rank-tracking feed. Sponsored placements are flagged and excluded from the
organic rank. The repo ships with **seed data** so both pages render before the
first live refresh.

---

## Test locally

```bash
# preview the site (open index.html and rank.html)
npx serve .        # then open the printed URL

# run a refresh by hand (needs the key in your shell)
ANTHROPIC_API_KEY=sk-ant-... node scripts/refresh.mjs        # weekly social trends
ANTHROPIC_API_KEY=sk-ant-... node scripts/rank-refresh.mjs   # hourly retail search rank
```

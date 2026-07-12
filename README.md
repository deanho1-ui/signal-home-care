# Signal — Weekly Social Trends (P&G Home Care)

A static dashboard that tracks social trends for each Home Care brand team
(Cascade, Dawn, Febreze, Swiffer, Mr. Clean), flags what to respond to, and
turns any trend into an influencer brief or branded post.

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
   workflows if prompted. The refresh runs every **Monday 12:00 UTC**.

5. **Run the first refresh now** (optional): **Actions → Weekly Signal refresh
   → Run workflow.** It researches, pre-writes briefs for the respond-now
   trends, and commits `data/trends.json`. Pages redeploys in a minute or two.

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

## Test locally

```bash
# preview the site
npx serve .        # then open the printed URL

# run a refresh by hand (needs the key in your shell)
ANTHROPIC_API_KEY=sk-ant-... node scripts/refresh.mjs
```

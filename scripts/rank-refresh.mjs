#!/usr/bin/env node
/**
 * Signal — Retail Search Rank (hourly refresh)
 *
 * Audits ORGANIC search position for Dawn on Amazon and Walmart.com across the
 * top dish-care search terms (dish soap, dish detergent, dishwasher soap, …),
 * scores Dawn vs. competitors — especially the top-4 organic slots — appends an
 * hourly point to a time series, and pre-writes recommendations to raise rank.
 *
 * Runs server-side (GitHub Actions) where ANTHROPIC_API_KEY is a repo secret.
 * Uses public web search only. Retail SERPs are personalized/volatile, so the
 * ranks are a DIRECTIONAL audit signal, not a licensed rank-tracking feed.
 *
 * Writes:
 *   data/ranks.json         — latest snapshot (per retailer × term) + recs
 *   data/rank-history.json  — appended hourly time series (the scorecard)
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

const MODEL       = process.env.RANK_MODEL || process.env.SIGNAL_MODEL || "claude-sonnet-5";
const SEARCH_TOOL = "web_search_20260209";
const ENDPOINT    = "https://api.anthropic.com/v1/messages";

// The brand we are auditing, and how to detect it in a listing's brand/title.
const OWNED_RE = /\bdawn\b/i;

// Retailers to audit.
const RETAILERS = [
  { id: "amazon",  name: "Amazon",       domain: "amazon.com" },
  { id: "walmart", name: "Walmart.com",  domain: "walmart.com" },
];

// Top dish-care search terms shoppers use. Dawn is a hand-dish (liquid) brand;
// "dishwasher soap / detergent" is included because shoppers use it loosely and
// Dawn listings do surface there. Edit this list to change coverage.
const TERMS = [
  "dish soap",
  "dawn dish soap",
  "dish detergent",
  "dishwashing liquid",
  "liquid dish soap",
  "dish soap for grease",
  "dishwasher soap",
  "dawn powerwash",
];

// Known competitor brands in the dish-care set, for context in the prompt.
const COMPETITORS = [
  "Palmolive", "Ajax", "Joy", "Gain dish", "Seventh Generation", "Method",
  "Mrs. Meyer's", "Blueland", "Dr. Bronner's", "Puracy", "Aunt Fannie's",
  "Amazon Basics", "Solimo", "Great Value", "Member's Mark", "private label",
];

const HISTORY_RETAIN = 600; // points kept per (retailer|term) series (~25 days hourly)

async function anthropic(body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

function parseJSONArray(txt) {
  let s = txt.replace(/```json|```/g, "").trim();
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/** Research one retailer's SERPs for every term, return normalized term rows. */
async function researchRetailer(retailer) {
  const prompt =
`You are a retail-search / SEO analyst for P&G. Using web_search, determine the CURRENT
ORGANIC search-results ordering on ${retailer.name} (${retailer.domain}) for each of
these shopper search terms. Search the actual ${retailer.name} results pages (and recent
public rank/SEO write-ups) to read the top listings in order.

Search terms: ${TERMS.map(t => `"${t}"`).join(", ")}

For EACH term, report the top 10 ORGANIC results in rank order (position 1 = first).
- ORGANIC = the natural results. Mark clearly-labeled Sponsored/Ad placements with "sponsored":true
  and give them their visible slot, but position numbering should still reflect on-page order.
- Identify the brand for each result. The brand we care about is DAWN. Common competitors:
  ${COMPETITORS.join(", ")}.
- Be honest and directional: ${retailer.name} results are personalized and change often. Report
  the best current read you can source; do not invent ASINs/IDs you didn't see.

Return ONLY a JSON array (no prose, no code fences). One object per term:
{
 "term":"the search term",
 "results":[ up to 10 items, each {
    "pos": integer rank on the page (1-based),
    "brand":"brand name",
    "product":"short product title as shown",
    "sponsored": true|false,
    "url":"listing or search URL if you have it, else \\"\\""
 }],
 "dawnBestPos": integer organic position of Dawn's best-ranked listing for this term, or null if Dawn is not visible in the top results,
 "leader":"brand holding organic position 1",
 "recommendation":"one specific, tactical lever to raise DAWN's ORGANIC rank for THIS term on ${retailer.name} (title/keyword, review velocity, conversion, A+ / rich media, variation strategy, price/Buy-Box, etc.)"
}
Cover every term. Prefer real ${retailer.domain} URLs.`;

  const txt = await anthropic({
    model: MODEL,
    max_tokens: 6000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: 16 }],
  });

  return parseJSONArray(txt).map(row => normalizeTermRow(retailer, row)).filter(Boolean);
}

function cleanBrand(b) { return String(b || "").trim().replace(/\s+/g, " ").slice(0, 40); }

function normalizeTermRow(retailer, row) {
  const term = String(row?.term || "").trim().toLowerCase();
  if (!term) return null;

  const results = (Array.isArray(row.results) ? row.results : [])
    .slice(0, 12)
    .map((r, i) => ({
      pos: Math.max(1, parseInt(r?.pos) || i + 1),
      brand: cleanBrand(r?.brand) || "—",
      product: String(r?.product || "").slice(0, 140),
      sponsored: !!r?.sponsored,
      isDawn: OWNED_RE.test(`${r?.brand || ""} ${r?.product || ""}`),
      url: /^https?:\/\//.test(String(r?.url || "")) ? String(r.url).slice(0, 400) : "",
    }))
    .sort((a, b) => a.pos - b.pos);

  // Organic-only view (what "rank" means for SEO).
  const organic = results.filter(r => !r.sponsored);
  const organicRanked = organic.map((r, i) => ({ ...r, organicPos: i + 1 }));

  const dawnHits = organicRanked.filter(r => r.isDawn);
  const dawnBestPos = dawnHits.length ? Math.min(...dawnHits.map(r => r.organicPos)) : null;
  const top4 = organicRanked.slice(0, 4).map(r => ({ brand: r.brand, isDawn: r.isDawn }));
  const leader = organicRanked[0]?.brand || cleanBrand(row?.leader) || "—";

  return {
    term,
    retailer: retailer.id,
    results: organicRanked,
    dawnBestPos,
    dawnInTop4: dawnBestPos != null && dawnBestPos <= 4,
    dawnCount: dawnHits.length,
    top4,
    leader,
    recommendation: String(row?.recommendation || "").slice(0, 400),
  };
}

/** Portfolio-level recommendations synthesized from the observed gaps. */
async function portfolioRecs(rows) {
  const digest = rows.map(r =>
    `${r.retailer}/"${r.term}": Dawn best organic #${r.dawnBestPos ?? "—"}${r.dawnInTop4 ? " (top4)" : ""}; leader ${r.leader}; top4 [${r.top4.map(t => t.brand).join(", ")}]`
  ).join("\n");

  const prompt =
`You are a retail-media / SEO strategist for Dawn (P&G). Below is the current ORGANIC
search-rank audit for Dawn vs. competitors on Amazon and Walmart.com across the top
dish-care terms, focused on the top-4 organic slots.

${digest}

Give the 6 highest-leverage, PRIORITIZED actions to raise Dawn's ORGANIC rank — especially
to win/hold top-4 slots — over the next 1-2 quarters. Ground each in what the audit shows
(name the terms/retailers where it applies). Cover the real organic-rank levers as relevant:
listing title & keyword coverage, backend/hidden search terms, conversion-rate (main image,
A+/rich media, video, ratings & review velocity), variation/parentage strategy, price &
Buy-Box health, availability/OOS, and how paid (Sponsored) can be used to lift organic.

Return ONLY a JSON array (no prose, no code fences). Exactly 6 items, each:
{
 "priority": 1-6 (1 = do first),
 "title":"short imperative action (<9 words)",
 "detail":"2-3 sentences: what to do and the expected organic-rank effect",
 "terms":[the search terms this most affects],
 "effort":"low"|"med"|"high",
 "impact":"low"|"med"|"high"
}`;

  const txt = await anthropic({ model: MODEL, max_tokens: 2500, messages: [{ role: "user", content: prompt }] });
  const arr = parseJSONArray(txt);
  return arr.slice(0, 8).map((r, i) => ({
    priority: Math.max(1, parseInt(r?.priority) || i + 1),
    title: String(r?.title || "Untitled action").slice(0, 90),
    detail: String(r?.detail || "").slice(0, 500),
    terms: (Array.isArray(r?.terms) ? r.terms : []).map(t => String(t).toLowerCase().slice(0, 40)).slice(0, 8),
    effort: ["low", "med", "high"].includes(r?.effort) ? r.effort : "med",
    impact: ["low", "med", "high"].includes(r?.impact) ? r.impact : "med",
  })).sort((a, b) => a.priority - b.priority);
}

/** Aggregate scorecard KPIs from the current snapshot. */
function scorecard(rows) {
  const per = {};
  for (const rt of RETAILERS) {
    const rr = rows.filter(r => r.retailer === rt.id);
    const withDawn = rr.filter(r => r.dawnBestPos != null);
    const number1 = rr.filter(r => r.dawnBestPos === 1).length;
    const inTop4 = rr.filter(r => r.dawnInTop4).length;
    const totalTop4Slots = rr.reduce((n, r) => n + Math.min(4, r.top4.length), 0);
    const dawnTop4Slots = rr.reduce((n, r) => n + r.top4.filter(t => t.isDawn).length, 0);
    const avgBest = withDawn.length
      ? Math.round((withDawn.reduce((s, r) => s + r.dawnBestPos, 0) / withDawn.length) * 10) / 10
      : null;
    per[rt.id] = {
      terms: rr.length,
      number1,
      inTop4,
      avgBest,
      top4Share: totalTop4Slots ? Math.round((dawnTop4Slots / totalTop4Slots) * 100) : 0,
    };
  }
  return per;
}

/** Append this run's points to the rolling time series and trim per series. */
async function appendHistory(rows, at) {
  let hist = { points: [] };
  try { hist = JSON.parse(await readFile("data/rank-history.json", "utf8")); } catch { /* first run */ }
  if (!Array.isArray(hist.points)) hist.points = [];

  for (const r of rows) {
    hist.points.push({
      at,
      retailer: r.retailer,
      term: r.term,
      dawnBest: r.dawnBestPos,        // null = not in top results
      inTop4: r.dawnInTop4,
      leader: r.leader,
    });
  }

  // Trim: keep the most recent HISTORY_RETAIN points per (retailer|term).
  const byKey = {};
  for (const p of hist.points) (byKey[`${p.retailer}|${p.term}`] ??= []).push(p);
  const kept = [];
  for (const k of Object.keys(byKey)) {
    const arr = byKey[k].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    kept.push(...arr.slice(-HISTORY_RETAIN));
  }
  kept.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  hist.points = kept;
  hist.updatedAt = at;

  await writeFile("data/rank-history.json", JSON.stringify(hist, null, 0));
  console.log(`  history: +${rows.length} points, ${hist.points.length} total`);
}

async function main() {
  const at = new Date().toISOString();
  console.log("Rank refresh:", at, "· model", MODEL);

  const rows = [];
  for (const rt of RETAILERS) {
    try {
      const r = await researchRetailer(rt);
      console.log(`  ${rt.id}: ${r.length} terms`);
      rows.push(...r);
    } catch (e) {
      console.warn(`  ${rt.id} failed: ${e.message}`);
    }
  }

  if (!rows.length) { console.error("No rank rows returned — leaving existing data untouched."); process.exit(1); }

  let recommendations = [];
  try { recommendations = await portfolioRecs(rows); }
  catch (e) { console.warn(`  recommendations failed: ${e.message}`); }

  await mkdir("data", { recursive: true });
  await appendHistory(rows, at);

  const out = {
    generatedAt: at,
    updated: new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }),
    source: "public web search (Amazon & Walmart.com results) — directional audit, not a licensed rank feed",
    retailers: RETAILERS,
    terms: TERMS,
    scorecard: scorecard(rows),
    rows,
    recommendations,
    count: rows.length,
  };
  await writeFile("data/ranks.json", JSON.stringify(out, null, 2));
  console.log(`Wrote data/ranks.json — ${rows.length} term rows, ${recommendations.length} recs.`);
}

main().catch(e => { console.error(e); process.exit(1); });

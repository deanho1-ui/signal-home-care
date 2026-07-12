#!/usr/bin/env node
/**
 * Signal — weekly refresh
 * Runs server-side (GitHub Actions) where ANTHROPIC_API_KEY is a repo secret.
 * Researches public social trends, tags them per P&G Home Care brand,
 * pre-generates briefs for "respond now" trends, and writes data/trends.json.
 *
 * Public sources only (Google Trends, Reddit, TikTok, news, creator coverage) —
 * nothing from Sprinklr/Brandwatch is touched.
 */
import { writeFile, mkdir } from "node:fs/promises";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("Missing ANTHROPIC_API_KEY"); process.exit(1); }

const MODEL         = process.env.SIGNAL_MODEL || "claude-sonnet-5"; // swap to taste (e.g. claude-opus-4-8)
const SEARCH_TOOL   = "web_search_20260209";   // latest web search tool version
const ENDPOINT      = "https://api.anthropic.com/v1/messages";
const BRAND_IDS     = ["cascade", "dawn", "febreze", "swiffer", "mrclean"];

const AXES = {
  landscape: "the biggest ALL-social breakout trends this week across TikTok, Instagram, Facebook, Reddit, YouTube and X (general culture, not cleaning-specific).",
  category:  "the CLEANING & home-care product category conversation this week — CleanTok, cleaning hacks, detergents, dish, surface cleaners, air/odor, floor care, viral products and methods.",
  owned:     "P&G Home Care brands specifically — Cascade, Dawn, Febreze, Swiffer, Mr. Clean — mentions, hacks, praise, criticism or narratives about these exact brands this week.",
  competitor:"COMPETITOR / challenger cleaning brands vs Cascade, Dawn, Febreze, Swiffer, Mr. Clean — e.g. The Pink Stuff, Scrub Daddy, Force of Nature / hypochlorous-acid, Blueland, Method, Mrs Meyer's, Fabuloso, purple cleaners — that are gaining momentum this week."
};

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

async function researchAxis(type) {
  const prompt =
`You are a social-listening analyst for P&G Home Care. Research ${AXES[type]}

Use web_search across public sources. Find the 3-4 most significant CURRENT trends.
For each trend, also surface 3 concrete EXAMPLE posts (prefer direct TikTok or
Instagram links you actually found via search — real videos/reels/creators, not
guessed URLs) and note what makes each one appealing/shareable.
Return ONLY a JSON array (no prose, no code fences). Each item:
{
 "lbl":"short brand/theme label",
 "title":"headline, <9 words",
 "summary":"1-2 sentences on what's happening",
 "platforms":[subset of "tiktok","instagram","facebook","reddit","youtube","x"],
 "signal":50-99 momentum score,
 "sent":"pos"|"neg"|"neu"|"mix",
 "respond":true only if a P&G Home Care brand should act,
 "brands":[which of "cascade","dawn","febreze","swiffer","mrclean" this is relevant to; use ["all"] for portfolio-wide],
 "angle":"1 sentence on the strategic opportunity angle for P&G",
 "response":"the single recommended SOCIAL response for P&G — concrete and tactical (1-2 sentences: what to post/seed and where)",
 "examples":[ exactly 3 items, each {
     "platform":"tiktok"|"instagram",
     "url":"a real, working link straight to the post/reel/creator/hashtag you found on that platform",
     "appeal":"one line on what's most appealing about this specific content (hook, format, why it spreads)"
 }],
 "mentions52w":[52 integers oldest→newest — a directional weekly mention index (0-100) tracing this trend's trajectory over the past year, so its size and momentum are visible],
 "src":"one public source URL"
}
Only real, current trends you can source. Prefer tiktok.com / instagram.com links for the examples.`;

  const txt = await anthropic({
    model: MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: 8 }],
  });

  return parseJSONArray(txt).map(x => ({
    type,
    lbl: String(x.lbl || "—").slice(0, 40),
    title: String(x.title || "Untitled trend"),
    summary: String(x.summary || ""),
    platforms: (Array.isArray(x.platforms) ? x.platforms : []).filter(p =>
      ["tiktok","instagram","facebook","reddit","youtube","x"].includes(p)),
    signal: Math.min(99, Math.max(40, parseInt(x.signal) || 60)),
    sent: ["pos","neg","neu","mix"].includes(x.sent) ? x.sent : "neu",
    respond: !!x.respond,
    brands: normalizeBrands(x.brands, type),
    angle: String(x.angle || ""),
    response: String(x.response || x.angle || ""),
    examples: normalizeExamples(x.examples),
    mentions52w: normalizeSeries(x.mentions52w),
    src: String(x.src || ""),
  }));
}

// Keep only real TikTok/Instagram-style example links, capped at 3.
function normalizeExamples(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 3).map(e => ({
    platform: ["tiktok","instagram"].includes(String(e?.platform||"").toLowerCase())
      ? String(e.platform).toLowerCase() : "tiktok",
    url: String(e?.url || "").slice(0, 400),
    appeal: String(e?.appeal || "").slice(0, 240),
  })).filter(e => /^https?:\/\//.test(e.url));
}

// Coerce to exactly 52 integers in 0..100 (directional weekly mention index).
function normalizeSeries(raw) {
  let a = Array.isArray(raw) ? raw.map(n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)))) : [];
  if (a.length > 52) a = a.slice(a.length - 52);
  while (a.length < 52) a.unshift(a.length ? a[0] : 0);
  return a;
}

function normalizeBrands(raw, type) {
  let arr = Array.isArray(raw) ? raw.map(b => String(b).toLowerCase().replace(/[^a-z]/g,"")) : [];
  arr = arr.map(b => b === "mrclean" || b === "mrcleanmr" ? "mrclean" : b).filter(b => BRAND_IDS.includes(b) || b === "all");
  if (!arr.length) arr = (type === "landscape") ? ["all"] : ["all"];
  return [...new Set(arr)];
}

async function briefFor(trend, kind) {
  const shared =
`Trend: "${trend.title}"
Theme: ${trend.lbl}
What's happening: ${trend.summary}
Platforms: ${trend.platforms.join(", ")}
Sentiment: ${trend.sent}. Momentum: ${trend.signal}/99.
Response angle: ${trend.angle || "n/a"}
P&G Home Care brand(s): Cascade, Dawn, Febreze, Swiffer, or Mr. Clean as appropriate.`;

  const prompt = kind === "influencer"
    ? `You are a brand strategist at P&G Home Care. Write a tight CREATOR/INFLUENCER BRIEF.
${shared}

Section headers, each prefixed '## ':
## Objective
## Which P&G brand
## Target creators
## Key message
## Hook / opening
## Do
## Don't
## Suggested content
## Hashtags & CTA
## KPI
Specific, scannable, no preamble.`
    : `You are a social copywriter at P&G Home Care. Draft a BRANDED SOCIAL POST.
${shared}

'## ' headers:
## Platform & format
## Caption (ready to post)
## Hook (first line / first 2s)
## Visual direction
## Hashtags
## CTA
In-brand, punchy, no corporate stiffness. No preamble.`;

  return anthropic({ model: MODEL, max_tokens: 1200, messages: [{ role: "user", content: prompt }] });
}

async function main() {
  console.log("Signal refresh:", new Date().toISOString(), "· model", MODEL);
  const trends = [];

  for (const type of Object.keys(AXES)) {
    try {
      const rows = await researchAxis(type);
      console.log(`  ${type}: ${rows.length} trends`);
      trends.push(...rows);
    } catch (e) {
      console.warn(`  ${type} failed: ${e.message}`);
    }
  }

  if (!trends.length) { console.error("No trends returned — leaving existing data.json untouched."); process.exit(1); }

  // Pre-generate briefs for priority (respond-now) trends so the static site
  // can display them with no client-side API call.
  const priority = trends.filter(t => t.respond);
  console.log(`Pre-generating briefs for ${priority.length} respond-now trends…`);
  for (const t of priority) {
    try {
      const [influencer, post] = await Promise.all([briefFor(t, "influencer"), briefFor(t, "post")]);
      t.briefs = { influencer, post };
    } catch (e) {
      console.warn(`  brief failed for "${t.title}": ${e.message}`);
    }
  }

  const week = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const out = { week, generatedAt: new Date().toISOString(), source: "public web (Google Trends, Reddit, TikTok, news)", count: trends.length, trends };

  await mkdir("data", { recursive: true });
  await writeFile("data/trends.json", JSON.stringify(out, null, 2));
  console.log(`Wrote data/trends.json — ${trends.length} trends, week of ${week}.`);
}

main().catch(e => { console.error(e); process.exit(1); });

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
  landscape: "the biggest MAINSTREAM CULTURAL MOMENTS happening right now or in the next few weeks that a brand could newsjack — major sports (World Cup, Olympics, Super Bowl, playoffs, big matches), award shows, celebrity / creator news & viral comments, blockbuster releases, huge memes, and seasonal / holiday moments. These are NOT cleaning-specific — they are the tentpole culture P&G Home Care could tap into. For EACH, the value is the activation angle: which brand should ride it and how.",
  category:  "the CLEANING & home-care product category conversation this week — CleanTok, cleaning hacks, detergents, dish, surface cleaners, air/odor, floor care, viral products and methods.",
  owned:     "P&G Home Care brands specifically — Cascade, Dawn, Febreze, Swiffer, Mr. Clean — mentions, hacks, praise, criticism or narratives about these exact brands this week.",
  competitor:"COMPETITOR / challenger cleaning brands vs Cascade, Dawn, Febreze, Swiffer, Mr. Clean — e.g. The Pink Stuff, Scrub Daddy, Force of Nature / hypochlorous-acid, Blueland, Method, Mrs Meyer's, Fabuloso, purple cleaners — that are gaining momentum this week."
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function anthropic(body, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        // Retry transient server / rate-limit errors; fail fast on 4xx like auth.
        if ((res.status === 429 || res.status >= 500) && attempt < tries) {
          lastErr = new Error(`API ${res.status}: ${text}`);
          await sleep(1500 * attempt); continue;
        }
        throw new Error(`API ${res.status}: ${text}`);
      }
      const data = await res.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    } catch (e) {
      lastErr = e;
      if (attempt < tries) { await sleep(1500 * attempt); continue; }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Extract a JSON array from a model reply, tolerating stray prose, code fences,
// and (best-effort) a response that was truncated mid-array by the token limit.
function parseJSONArray(txt) {
  let s = txt.replace(/```json|```/g, "").trim();
  const a = s.indexOf("[");
  if (a < 0) throw new Error(`no JSON array in reply: ${s.slice(0, 60)}…`);
  const b = s.lastIndexOf("]");
  if (b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through to repair */ }
  }
  // Repair a truncated array: keep whole objects up to the last balanced brace.
  let depth = 0, lastComplete = -1;
  for (let i = a; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") { depth--; if (depth === 0) lastComplete = i; }
  }
  if (lastComplete > a) return JSON.parse(s.slice(a, lastComplete + 1) + "]");
  throw new Error("could not parse or repair JSON array");
}

async function researchAxis(type) {
  const prompt =
`You are a social-listening analyst for P&G Home Care. Research ${AXES[type]}

Use web_search across public sources. Find the 3-4 most significant CURRENT trends.
For each trend, also surface 3 concrete EXAMPLE posts (prefer direct TikTok or
Instagram links you actually found via search — real videos/reels/creators, not
guessed URLs) and note what makes each one appealing/shareable.

Output ONLY a JSON array — begin your reply with "[" and end with "]". No preamble,
no explanation, no markdown code fences. Each item:
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
 "trend":"surging"|"rising"|"steady"|"cooling"|"declining"  (its trajectory over the past ~12 months),
 "mentionsNow":0-100 (roughly how big the conversation is right now relative to its own yearly peak),
 "src":"one public source URL"
}
If a trend or moment is not itself about a P&G brand (e.g. a sports match, a
celebrity comment, a meme), STILL include it — set "brands" to ["all"] and put
the P&G relevance in "angle"/"response" (how Home Care should newsjack it).
Always return the JSON array even for non-cleaning culture; never reply with prose.
Only real, current trends you can source. Prefer tiktok.com / instagram.com links for the examples.`;

  const txt = await anthropic({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
    tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: 6 }],
  });

  let raw;
  try {
    raw = parseJSONArray(txt);
  } catch (e) {
    // The model sometimes answers in prose (esp. the culture axis). Salvage by
    // asking it to reformat its own reply into the array — no re-research needed.
    console.warn(`  ${type}: reply was not JSON (${e.message}); attempting reformat…`);
    const fixed = await anthropic({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: "user", content:
        `Convert the following into ONLY a JSON array of trend objects using the schema you were given ` +
        `(lbl, title, summary, platforms, signal, sent, respond, brands, angle, response, examples, trend, mentionsNow, src). ` +
        `Begin with "[" and end with "]". No prose. If it contains no usable trends, return [].\n\n${String(txt).slice(0, 12000)}` }],
    });
    raw = parseJSONArray(fixed);
  }

  return raw.map(x => {
    const signal = Math.min(99, Math.max(40, parseInt(x.signal) || 60));
    return {
      type,
      lbl: String(x.lbl || "—").slice(0, 40),
      title: String(x.title || "Untitled trend"),
      summary: String(x.summary || ""),
      platforms: (Array.isArray(x.platforms) ? x.platforms : []).filter(p =>
        ["tiktok","instagram","facebook","reddit","youtube","x"].includes(p)),
      signal,
      sent: ["pos","neg","neu","mix"].includes(x.sent) ? x.sent : "neu",
      respond: !!x.respond,
      brands: normalizeBrands(x.brands, type),
      angle: String(x.angle || ""),
      response: String(x.response || x.angle || ""),
      examples: normalizeExamples(x.examples),
      // Prefer an explicit series if the model provided one; otherwise synthesize
      // a directional 52-week curve from the trajectory + current volume.
      mentions52w: Array.isArray(x.mentions52w) && x.mentions52w.length >= 52
        ? normalizeSeries(x.mentions52w)
        : synthSeries(String(x.trend || "rising").toLowerCase(), parseInt(x.mentionsNow) || signal, String(x.title||"") + String(x.lbl||"")),
      src: String(x.src || ""),
    };
  });
}

/* ---- deterministic 52-week series synthesis (directional, not licensed) ---- */
function hashStr(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function rng(seed){let s=(seed>>>0)||1;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
function synthSeries(shape, now, seedStr){
  const r = rng(hashStr(seedStr || "x"));
  now = Math.max(10, Math.min(100, now || 60));
  // Where the year started, relative to the current level, per trajectory.
  const startFactor = {surging:0.22, rising:0.55, steady:0.9, cooling:1.2, declining:1.6}[shape] ?? 0.6;
  const start = Math.max(4, Math.min(100, now * startFactor));
  const exp = shape === "surging" ? 2.0 : shape === "rising" ? 1.4 : shape === "declining" ? 1.4 : 1.0;
  const out = [];
  for (let i = 0; i < 52; i++) {
    const base = start + (now - start) * Math.pow(i / 51, exp);
    const wobble = (r() - 0.5) * now * 0.12;
    out.push(Math.max(2, Math.min(100, Math.round(base + wobble))));
  }
  return out;
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

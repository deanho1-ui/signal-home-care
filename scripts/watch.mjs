#!/usr/bin/env node
/**
 * Signal — watch
 *
 * Point it at a video URL and it writes reconciled notes (and optionally an
 * agent spec) to notes/.
 *
 * Two independent readings, then a reconciliation:
 *   1. GEMINI actually watches the video. YouTube URLs go in natively; any
 *      other platform (TikTok, Reels, a local .mp4) is downloaded with yt-dlp
 *      and pushed through the Files API first.
 *   2. CLAUDE never sees the video. It takes Gemini's factual claims — tool
 *      names, commands, URLs, product names — and checks each one against the
 *      public web.
 *   3. Anything the two disagree on is flagged in a CONFLICTS section instead
 *      of being silently averaged away.
 *
 * Env:
 *   GEMINI_API_KEY     required  (free tier is fine — https://aistudio.google.com/apikey)
 *   ANTHROPIC_API_KEY  required unless --no-verify
 */
import { writeFile, mkdir, readFile, stat, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

const GEMINI_MODEL = process.env.WATCH_GEMINI_MODEL || "gemini-3.6-flash";
const CLAUDE_MODEL = process.env.WATCH_CLAUDE_MODEL || "claude-sonnet-5";
const SEARCH_TOOL  = "web_search_20260209";
const GEMINI_BASE  = "https://generativelanguage.googleapis.com/v1beta";
const CLAUDE_URL   = "https://api.anthropic.com/v1/messages";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------ arguments ------------------------------ */

function parseArgs(argv) {
  const opts = { url: "", ask: "", out: "notes", spec: false, verify: true, keep: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ask")            opts.ask = argv[++i] || "";
    else if (a === "--out")       opts.out = argv[++i] || "notes";
    else if (a === "--spec")      opts.spec = true;
    else if (a === "--no-verify") opts.verify = false;
    else if (a === "--keep")      opts.keep = true;
    else if (a.startsWith("--"))  die(`unknown flag ${a}`);
    else if (!opts.url)           opts.url = a;
    else                          die(`unexpected argument ${a}`);
  }
  return opts;
}

function die(msg) {
  console.error(`watch: ${msg}\n`);
  console.error(`usage: node scripts/watch.mjs <video-url> [--ask "focus"] [--spec] [--out DIR] [--no-verify] [--keep]`);
  process.exit(1);
}

/* ------------------------------ http helpers ------------------------------ */

async function retrying(label, fn, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (e.fatal || attempt === tries) break;
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

async function gemini(parts) {
  return retrying("gemini", async () => {
    const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      // 4xx other than rate-limiting won't get better by trying again.
      if (res.status < 500 && res.status !== 429) err.fatal = true;
      throw err;
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    if (!cand) throw new Error(`no candidate returned (${JSON.stringify(data).slice(0, 300)})`);
    const txt = (cand.content?.parts || []).map(p => p.text).filter(Boolean).join("\n").trim();
    if (!txt) throw new Error(`empty reply (finishReason: ${cand.finishReason || "unknown"})`);
    return txt;
  });
}

async function claude(body) {
  return retrying("claude", async () => {
    const res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      if (res.status < 500 && res.status !== 429) err.fatal = true;
      throw err;
    }
    const data = await res.json();
    return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  });
}

/* ------------------------------ json parsing ------------------------------ */

// Both models occasionally wrap JSON in prose or fences, or get cut off mid-object
// when they hit the token limit. Recover what we can rather than losing the run.
function parseJSONObject(txt, what = "reply") {
  const s = String(txt).replace(/```json|```/g, "").trim();
  const a = s.indexOf("{");
  if (a < 0) throw new Error(`no JSON object in ${what}: ${s.slice(0, 80)}…`);
  const b = s.lastIndexOf("}");
  if (b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through to repair */ }
  }

  // Scan once, recording every offset where a value had just finished, along
  // with the brackets still open at that point.
  const cuts = [];
  const stack = [];
  let inStr = false, esc = false;
  for (let i = a; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') {
      inStr = !inStr;
      if (!inStr) cuts.push([i + 1, [...stack]]);
      continue;
    }
    if (inStr) continue;
    if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") { stack.pop(); cuts.push([i + 1, [...stack]]); }
    else if (c === ",") cuts.push([i, [...stack]]);
  }

  // Truncate at the latest such point and close whatever is still open. A cut
  // inside an array can leave a dangling key, so walk back until one parses.
  for (let i = cuts.length - 1, tried = 0; i >= 0 && tried < 500; i--, tried++) {
    const [end, open] = cuts[i];
    if (!open.length) continue;              // already balanced — the fast path handled it
    const candidate = s.slice(a, end).replace(/,\s*$/, "") + open.reverse().join("");
    try { return JSON.parse(candidate); } catch { /* try an earlier cut */ }
  }
  throw new Error(`could not parse or repair JSON in ${what}`);
}

/* ------------------------------ video input ------------------------------ */

const YT_RE = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch|shorts|live|embed)|youtu\.be\/)/i;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("error", e => reject(new Error(`${cmd}: ${e.code === "ENOENT" ? "not installed" : e.message}`)));
    p.on("close", code => code === 0 ? resolve(out.trim())
      : reject(new Error(`${cmd} exited ${code}: ${(err || out).trim().slice(0, 300)}`)));
  });
}

// TikTok links are NOT convertible to YouTube links — the video only exists on
// TikTok. The real path is: pull the file down, then hand the bytes to Gemini.
async function downloadVideo(url) {
  const path = join(tmpdir(), `watch-${Date.now()}.mp4`);
  console.log("  not a YouTube URL — downloading with yt-dlp…");
  await run("yt-dlp", [
    "-f", "mp4/best[ext=mp4]/best",
    "-S", "res:720",             // 720p is plenty for reading on-screen text, and uploads fast
    "--no-playlist",
    "-o", path,
    url,
  ]);
  return path;
}

// Resumable upload, then poll until Gemini has finished processing the video.
async function uploadToGemini(path) {
  const { size } = await stat(path);
  console.log(`  uploading ${(size / 1e6).toFixed(1)} MB to the Files API…`);

  const start = await fetch(`${GEMINI_BASE}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(size),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "content-type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "watch-upload" } }),
  });
  if (!start.ok) throw new Error(`upload start failed: HTTP ${start.status} ${(await start.text()).slice(0, 300)}`);

  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("upload start returned no x-goog-upload-url header");

  const bytes = await readFile(path);
  const done = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!done.ok) throw new Error(`upload failed: HTTP ${done.status} ${(await done.text()).slice(0, 300)}`);

  let file = (await done.json()).file;
  for (let i = 0; file?.state === "PROCESSING" && i < 60; i++) {
    await sleep(2000);
    const poll = await fetch(`${GEMINI_BASE}/${file.name}`, { headers: { "x-goog-api-key": GEMINI_KEY } });
    if (!poll.ok) throw new Error(`file poll failed: HTTP ${poll.status}`);
    file = await poll.json();
  }
  if (file?.state !== "ACTIVE") throw new Error(`file never became ACTIVE (state: ${file?.state || "unknown"})`);
  return { fileUri: file.uri, mimeType: file.mimeType || "video/mp4" };
}

/* ------------------------------ pass 1: watch ------------------------------ */

const WATCH_PROMPT = ask => `You are watching this video end to end. Report ONLY what the video
itself shows or says — read on-screen text (terminal commands, URLs, menu
items, captions) carefully, since those are usually the part that matters.

${ask ? `The viewer specifically wants to know: ${ask}\n` : ""}
Reply with ONLY a JSON object, no prose and no code fences:
{
 "title": "the video's actual title if shown, else a descriptive one",
 "creator": "channel/account name if visible, else \\"\\"",
 "duration": "MM:SS or HH:MM:SS if determinable, else \\"\\"",
 "topic": "one sentence on what this video is teaching or showing",
 "timeline": [ { "t":"M:SS", "label":"short beat name", "detail":"what happens here" } ],
 "steps": [ { "n":1, "action":"an instruction the video gives, imperative mood", "t":"M:SS" } ],
 "claims": [ {
    "text":"a specific, checkable factual claim the video makes",
    "t":"M:SS",
    "kind":"command"|"url"|"tool"|"product"|"price"|"stat"|"other",
    "verbatim":"the exact on-screen or spoken wording, if you can read it"
 } ],
 "onScreenText": [ "exact strings read off the screen that a viewer would need to retype" ],
 "takeaways": [ "the things worth remembering, most important first" ],
 "unclear": [ "anything you could not read or make out — be honest here" ]
}

Rules:
- "claims" is the important one. Put every tool name, plugin name, install
  command, URL, price, product name and statistic there, with its timestamp.
- Transcribe commands and URLs character by character. If a string is blurry or
  partially covered, put your best reading in "verbatim" and also list it in
  "unclear" — do NOT quietly clean it up into something plausible.
- Never invent a timestamp. Omit "t" rather than guess.
- 6-12 timeline beats for a short video, up to 25 for a long one.`;

async function watchVideo(opts) {
  let videoPart, tmpPath = null;

  if (YT_RE.test(opts.url)) {
    console.log("  YouTube URL — sending straight to Gemini…");
    videoPart = { file_data: { file_uri: opts.url } };
  } else {
    tmpPath = await downloadVideo(opts.url);
    const { fileUri, mimeType } = await uploadToGemini(tmpPath);
    videoPart = { file_data: { file_uri: fileUri, mime_type: mimeType } };
  }

  try {
    const txt = await gemini([videoPart, { text: WATCH_PROMPT(opts.ask) }]);
    return parseJSONObject(txt, "Gemini's reading");
  } finally {
    if (tmpPath && !opts.keep) await rm(tmpPath, { force: true });
    else if (tmpPath) console.log(`  kept download at ${tmpPath}`);
  }
}

/* ------------------------------ pass 2: verify ------------------------------ */

async function verifyClaims(watched, url) {
  const claims = (watched.claims || []).slice(0, 20);
  if (!claims.length) return { verdicts: [], note: "The video reading surfaced no checkable claims." };

  const txt = await claude({
    model: CLAUDE_MODEL,
    max_tokens: 6000,
    messages: [{ role: "user", content:
`Another model watched a video at ${url} and extracted the factual claims below.
You have NOT seen the video. Your job is to check each claim against the public
web and say whether it holds up — misheard tool names, dead URLs, commands with
the wrong syntax and renamed products are exactly what you are hunting for.

CLAIMS:
${JSON.stringify(claims, null, 2)}

Use web_search. Then reply with ONLY a JSON object, no prose, no code fences:
{
 "verdicts": [ {
   "text": "the claim, copied verbatim from the input",
   "status": "confirmed" | "contradicted" | "unverified",
   "correction": "if contradicted, what the truth appears to be — else \\"\\"",
   "source": "a real URL you actually saw in a search result — else \\"\\""
 } ],
 "note": "one or two sentences on the overall reliability of this video's claims"
}

Rules:
- One verdict per input claim, same order, nothing dropped.
- "unverified" is a perfectly good answer and much better than a guess. Use it
  whenever search does not clearly settle the claim.
- Only mark "contradicted" when you found a source that actually disagrees.
- Never fabricate a URL for "source". Leave it empty if you have none.
- A plausible-sounding tool or plugin name that you cannot find anywhere is a
  strong signal it was misheard from the audio — say so in "correction".` }],
    tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: 8 }],
  });

  return parseJSONObject(txt, "Claude's verification");
}

/* ------------------------------ pass 3: reconcile ------------------------------ */

function reconcile(watched, verified) {
  const byText = new Map((verified.verdicts || []).map(v => [String(v.text).trim(), v]));
  const claims = (watched.claims || []).map(c => {
    const v = byText.get(String(c.text).trim()) || {};
    return {
      ...c,
      status: ["confirmed", "contradicted", "unverified"].includes(v.status) ? v.status : "unchecked",
      correction: v.correction || "",
      source: v.source || "",
    };
  });
  // Only score claims that were actually checked — otherwise a skipped or
  // failed cross-check reads as "0% confirmed", which looks like a damning
  // verdict rather than the absence of one.
  const checked = claims.filter(c => c.status !== "unchecked");
  return {
    claims,
    checked,
    conflicts: claims.filter(c => c.status === "contradicted"),
    unverified: claims.filter(c => c.status === "unverified"),
    confidence: checked.length
      ? Math.round(100 * checked.filter(c => c.status === "confirmed").length / checked.length)
      : null,
  };
}

/* ------------------------------ output ------------------------------ */

const STATUS_MARK = { confirmed: "✅", contradicted: "❌", unverified: "❓", unchecked: "•" };

function toMarkdown(watched, rec, verified, opts) {
  const L = [];
  const esc = s => String(s || "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

  L.push(`# ${watched.title || "Untitled video"}`, "");
  const meta = [watched.creator && `**${watched.creator}**`, watched.duration, `[source](${opts.url})`]
    .filter(Boolean).join(" · ");
  L.push(meta, "");
  if (watched.topic) L.push(`> ${watched.topic}`, "");
  if (opts.ask) L.push(`**Asked:** ${opts.ask}`, "");

  if (watched.takeaways?.length) {
    L.push("## Takeaways", "");
    watched.takeaways.forEach(t => L.push(`- ${t}`));
    L.push("");
  }

  if (watched.steps?.length) {
    L.push("## Steps", "");
    watched.steps.forEach((s, i) => L.push(`${s.n || i + 1}. ${s.action}${s.t ? `  _(${s.t})_` : ""}`));
    L.push("");
  }

  if (watched.timeline?.length) {
    L.push("## Timeline", "", "| Time | Beat | What happens |", "|---|---|---|");
    watched.timeline.forEach(b => L.push(`| ${esc(b.t) || "—"} | ${esc(b.label)} | ${esc(b.detail)} |`));
    L.push("");
  }

  if (rec.conflicts.length) {
    L.push("## ⚠️ Conflicts", "",
      "Gemini reported these from the video; Claude's web check disagrees. Resolve them before acting on anything below.", "");
    rec.conflicts.forEach(c => {
      L.push(`- **${esc(c.text)}**${c.t ? ` _(${c.t})_` : ""}`);
      L.push(`  - Correction: ${esc(c.correction) || "—"}`);
      if (c.source) L.push(`  - Source: ${c.source}`);
    });
    L.push("");
  }

  if (rec.claims.length) {
    L.push(rec.confidence === null ? "## Claims the video makes" : "## Claim check", "");
    if (rec.confidence === null) L.push("_Not cross-checked — nothing below has been independently verified._", "");
    else L.push(`${rec.confidence}% of ${rec.checked.length} checked claims confirmed.`, "");
    L.push("| | Claim | Time | Note |", "|---|---|---|---|");
    rec.claims.forEach(c => L.push(
      `| ${STATUS_MARK[c.status]} | ${esc(c.verbatim || c.text)} | ${esc(c.t) || "—"} | ${esc(c.correction) || (c.source ? `[src](${c.source})` : "—")} |`));
    L.push("");
    if (verified.note) L.push(`_${verified.note}_`, "");
  }

  if (watched.onScreenText?.length) {
    L.push("## On-screen text", "", "```text", ...watched.onScreenText.map(String), "```", "");
  }

  if (watched.unclear?.length) {
    L.push("## Couldn't make out", "");
    watched.unclear.forEach(u => L.push(`- ${u}`));
    L.push("");
  }

  L.push("---", "",
    `_Watched by ${GEMINI_MODEL}${opts.verify ? `, cross-checked by ${CLAUDE_MODEL}` : " (no cross-check)"} · ${new Date().toISOString().slice(0, 10)}_`);
  return L.join("\n");
}

/* ------------------------------ optional: agent spec ------------------------------ */

async function draftSpec(watched, rec, url) {
  const txt = await claude({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    messages: [{ role: "user", content:
`These are reconciled notes from a tutorial video at ${url}. Claims marked
"contradicted" or "unverified" did NOT survive a web check.

${JSON.stringify({ topic: watched.topic, steps: watched.steps, takeaways: watched.takeaways, claims: rec.claims }, null, 2)}

Draft a spec for a Claude Code skill that automates what this video teaches.
Reply with ONLY a JSON object, no prose, no code fences:
{
 "name": "kebab-case-skill-name",
 "description": "one line, written so a model can tell when to trigger it",
 "when_to_use": ["concrete trigger situations"],
 "inputs": [ { "name":"", "required":true, "description":"" } ],
 "procedure": ["numbered steps the skill should follow"],
 "prerequisites": ["accounts, keys, installed tools the user must have first"],
 "open_questions": ["what the video left ambiguous, or what the claim check flagged"],
 "excluded": ["anything from the video you deliberately left out, and why"]
}

Rules:
- Build ONLY on confirmed material. Anything resting on a contradicted or
  unverified claim goes in "open_questions" or "excluded" — never into
  "procedure" as though it were settled.
- If the video is not teaching a repeatable procedure, say so in "description"
  and leave "procedure" empty rather than inventing one.` }],
  });
  return parseJSONObject(txt, "the drafted spec");
}

/* ------------------------------ main ------------------------------ */

function slugify(s) {
  return String(s || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) die("no video URL given");
  if (!GEMINI_KEY) die("missing GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)");
  if (opts.verify && !CLAUDE_KEY) die("missing ANTHROPIC_API_KEY (or pass --no-verify)");

  console.log(`watch: ${opts.url}`);

  console.log("1/3 watching…");
  const watched = await watchVideo(opts);
  console.log(`  "${watched.title || "untitled"}" — ${(watched.claims || []).length} claims, ${(watched.timeline || []).length} beats`);

  let verified = { verdicts: [], note: "" };
  if (opts.verify) {
    console.log("2/3 cross-checking claims…");
    try {
      verified = await verifyClaims(watched, opts.url);
    } catch (e) {
      // A failed check must not look like a clean bill of health.
      console.warn(`  cross-check failed: ${e.message} — claims left unchecked`);
      verified = { verdicts: [], note: `Cross-check did not run (${e.message}). Claims below are unverified.` };
    }
  } else {
    console.log("2/3 cross-check skipped (--no-verify)");
  }

  const rec = reconcile(watched, verified);
  if (rec.conflicts.length) console.log(`  ⚠️  ${rec.conflicts.length} conflict(s) flagged`);

  console.log("3/3 writing…");
  await mkdir(opts.out, { recursive: true });
  const slug = slugify(watched.title);
  const mdPath = join(opts.out, `${slug}.md`);
  await writeFile(mdPath, toMarkdown(watched, rec, verified, opts));
  console.log(`  ${mdPath}`);

  if (opts.spec) {
    const spec = await draftSpec(watched, rec, opts.url);
    const specPath = join(opts.out, `${slug}.spec.json`);
    await writeFile(specPath, JSON.stringify({ source: opts.url, generatedAt: new Date().toISOString(), ...spec }, null, 2));
    console.log(`  ${specPath}`);
    console.log(`\nNext: hand ${specPath} to the skill-creator skill to generate the skill itself.`);
  }
}

// Only run when invoked directly, so the pure helpers above stay unit-testable.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(`\nwatch failed: ${e.message}`); process.exit(1); });
}

export { parseArgs, parseJSONObject, reconcile, toMarkdown, slugify };

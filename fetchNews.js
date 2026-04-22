import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ================= ENV =================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NEWS_API_KEY = process.env.NEWS_API_KEY;

// ================= CONFIG =================
const SIMILARITY_THRESHOLD = 0.45;
const TRENDING_BOOST = 5;
const DECAY_RATE = 0.9;

// ================= HELPERS =================

// --- Tokenize ---
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 2);
}

// --- Similarity ---
function similarity(a, b) {
  if (!a || !b) return 0;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  const setB = new Set(tokensB);
  const overlap = tokensA.filter(t => setB.has(t));

  return overlap.length / Math.max(tokensA.length, tokensB.length);
}

// ================= AUTO-TIGHTEN =================
function tighten(text) {
  let t = text;

  const fluff = [
    "in a dramatic turn",
    "in a surprising twist",
    "in a shocking development",
    "in a stunning move",
    "amid growing concerns",
    "raising questions about",
    "highlighting",
    "showcasing",
    "underscoring",
  ];

  fluff.forEach(p => {
    t = t.replace(new RegExp(p, "gi"), "");
  });

  t = t.replace(/\s+/g, " ").trim();

  if (!t.endsWith(".")) t += ".";

  return t;
}

// ================= AI =================

// --- LOGLINE ---
async function generateLogline(title, description) {
  const prompt = `
Write a tight, cinematic news logline.

RULES:
- Max 22 words
- One sentence only
- Start with the main subject
- Use strong verbs
- No fluff or filler
- No speculation or invented facts
- Grounded but engaging

ARTICLE:
Title: ${title}
Description: ${description}

Output only the logline.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return tighten(res.choices[0].message.content.trim());
}

// --- HEADLINE ---
async function generateHeadline(title) {
  const prompt = `
Rewrite this news headline to be punchy, concise, and engaging.

RULES:
- Max 12 words
- Keep factual accuracy
- Slight energy allowed, no clickbait
- No invented facts

HEADLINE:
${title}

Return only the improved headline.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

// ================= MAIN =================

async function fetchNews() {
  try {
    console.log("🚀 Fetching news...");

    const news = await fetch(
      `https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=${NEWS_API_KEY}`
    ).then(r => r.json());

    const { data: existing } = await supabase.from("stories").select("*");

    for (const article of news.articles) {
      const { title, description, url } = article;

      if (!title || !url) continue;

      console.log(`📰 ${title}`);

      // ================= FIND MATCH =================
      let bestMatch = null;
      let bestScore = 0;

      for (const story of existing || []) {
        const score = similarity(title, story.original_title || story.canonical_title);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

      // ================= UPDATE EXISTING =================
      if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
        const newScore = Math.round(bestMatch.trending_score * DECAY_RATE + TRENDING_BOOST);

        const updatedSources = Array.isArray(bestMatch.sources)
          ? [...bestMatch.sources, { title, url }]
          : [{ title, url }];

        await supabase
          .from("stories")
          .update({
            trending_score: newScore,
            sources: updatedSources,
            last_seen_at: new Date()
          })
          .eq("id", bestMatch.id);

        console.log(`🔥 Updated cluster → ${newScore}`);
        continue;
      }

      // ================= CREATE NEW =================
      const logline = await generateLogline(title, description);
      const headline = await generateHeadline(title);

      console.log(`✨ Logline: ${logline}`);

      await supabase.from("stories").insert({
        canonical_title: headline,
        original_title: title,
        logline,
        sources: [{ title, url }],
        trending_score: 10,
        last_seen_at: new Date()
      });

      console.log("✅ New canonical story created");
    }

    console.log("🎉 Done!");
  } catch (err) {
    console.error("❌ ERROR:", err);
    process.exit(1);
  }
}

fetchNews();
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ================= ENV =================
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ================= CLIENTS =================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= CONFIG =================
const SIMILARITY_THRESHOLD = 0.30;

// ================= TOKENIZER =================
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// ================= SIMILARITY =================
function similarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...tokensA, ...tokensB]).size;

  return union === 0 ? 0 : intersection / union;
}

// ================= DECAY FUNCTION =================
function applyDecay(score, hoursSinceSeen) {
  const decayRate = 0.08; // tweakable
  return score * Math.exp(-decayRate * hoursSinceSeen);
}

// ================= TRENDING SCORE =================
function calculateScore(story) {
  const now = new Date();
  const lastSeen = new Date(story.last_seen_at);
  const firstSeen = new Date(story.first_seen_at || story.last_seen_at);

  const hoursSinceSeen = (now - lastSeen) / (1000 * 60 * 60);
  const hoursSinceFirst = (now - firstSeen) / (1000 * 60 * 60);

  // --- DECAY ---
  const decayed = applyDecay(story.trending_score || 10, hoursSinceSeen);

  // --- VELOCITY ---
  const velocity = (story.source_count || 1) / Math.max(hoursSinceFirst, 1);

  // --- RECENCY BOOST ---
  const recencyBoost = hoursSinceSeen < 6 ? 1.5 : 1;

  // --- FINAL SCORE ---
  return decayed + velocity * 5 * recencyBoost;
}

// ================= AUTO-TIGHTEN =================
function tightenLogline(text) {
  let t = text;

  const fluff = [
    "in a dramatic turn",
    "in a surprising twist",
    "in a shocking development",
    "in a stunning move",
  ];

  fluff.forEach((f) => {
    t = t.replace(new RegExp(f, "gi"), "");
  });

  t = t.replace(/\s+/g, " ").trim();

  if (!t.endsWith(".")) t += ".";
  return t;
}

// ================= AI =================
async function generateLogline(title, description) {
  const prompt = `
Write a tight cinematic news logline.

- Max 22 words
- One sentence
- No fluff
- Strong verbs
- Fact-based

Title: ${title}
Description: ${description}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return tightenLogline(res.choices[0].message.content.trim());
}

async function generateHeadline(title) {
  const prompt = `
Rewrite this headline:

- Max 12 words
- Punchy, clean, slightly dramatic
- No clickbait

${title}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

// ================= MAIN =================
async function fetchNews() {
  try {
    console.log("🚀 Fetching news...");

    const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    const { data: existing } = await supabase.from("articles").select("*");

    for (const article of data.articles) {
      const { title, description, url } = article;
      if (!title || !url) continue;

      console.log(`📰 ${title}`);

      let bestMatch = null;
      let bestScore = 0;

      for (const story of existing || []) {
        const compareTitle = story.original_title || story.title;

        // 🚨 SELF-MATCH FIX
        if (compareTitle?.toLowerCase() === title.toLowerCase()) continue;

        const score = similarity(title, compareTitle);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

      // ================= CLUSTER =================
      if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
        const updatedSourceCount = (bestMatch.source_count || 1) + 1;

        const updatedScore = calculateScore({
          ...bestMatch,
          source_count: updatedSourceCount,
        });

        await supabase
          .from("articles")
          .update({
            trending_score: updatedScore,
            source_count: updatedSourceCount,
            last_seen_at: new Date().toISOString(),
          })
          .eq("id", bestMatch.id);

        console.log(
          `🔥 Clustered → sources: ${updatedSourceCount}, score: ${updatedScore.toFixed(2)}`
        );

        continue;
      }

      // ================= NEW STORY =================
      const logline = await generateLogline(title, description);
      const headline = await generateHeadline(title);

      console.log(`✨ Logline: ${logline}`);

      await supabase.from("articles").insert({
        title: headline,
        original_title: title,
        logline,
        url,
        trending_score: 10,
        source_count: 1,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      });

      console.log("✅ New canonical story created");
    }

    console.log("🎉 Done!");
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    process.exit(1);
  }
}

fetchNews();
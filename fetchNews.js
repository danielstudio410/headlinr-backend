import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

// ================= ENV =================
const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ================= CLIENTS =================
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= CONFIG =================
const SIMILARITY_THRESHOLD = 0.45;
const DECAY_RATE = 0.9;

// ================= HELPERS =================

// ✅ TOKENIZER (fixed)
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter((w) => w.length > 2);
}

// ✅ UPGRADED SIMILARITY (CRITICAL FIX)
function similarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));

  if (setA.size === 0 || setB.size === 0) return 0;

  const intersection = [...setA].filter((x) => setB.has(x));

  // 🔥 KEY CHANGE: MIN instead of MAX
  return intersection.length / Math.min(setA.size, setB.size);
}

// ================= AUTO-TIGHTEN =================

function tightenLogline(text) {
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
    "bringing attention to",
    "it is reported that",
  ];

  fluff.forEach((phrase) => {
    t = t.replace(new RegExp(phrase, "gi"), "");
  });

  const weakVerbs = [
    "is expected to",
    "is set to",
    "aims to",
    "seeks to",
    "moves to",
    "plans to",
    "continues to",
  ];

  weakVerbs.forEach((w) => {
    t = t.replace(new RegExp(w, "gi"), "");
  });

  t = t.replace(/\s+/g, " ").trim();

  if (!t.endsWith(".")) t += ".";

  return t;
}

// ================= AI =================

async function generateLogline(title, description) {
  const prompt = `
Write a tight, cinematic news logline.

RULES:
- Max 22 words
- One sentence
- Start with main subject
- Strong verbs only
- No fluff
- No speculation
- Grounded but cinematic

ARTICLE:
Title: ${title}
Description: ${description}

Return only the logline.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return tightenLogline(res.choices[0].message.content.trim());
}

async function generateHeadline(title) {
  const prompt = `
Rewrite this headline to be punchy and engaging.

RULES:
- Max 12 words
- Slight drama allowed
- No clickbait
- Stay factual

HEADLINE:
${title}

Return only headline.
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

    // ================= DECAY =================
    const { error: decayError } = await supabase.rpc("decay_scores", {
      decay: DECAY_RATE,
    });

    if (decayError) {
      console.log("⚠️ Decay skipped (function not found yet)");
    }

    // ================= FETCH NEWS =================
    const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=25&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const articles = data.articles;

    // ================= LOAD EXISTING =================
    const { data: existingStories } = await supabase
      .from("articles")
      .select("*");

    for (const article of articles) {
      const { title, description, url } = article;
      if (!title || !url) continue;

      console.log(`📰 ${title}`);

      let bestMatch = null;
      let bestScore = 0;

      // ================= SIMILARITY =================
      for (const story of existingStories || []) {
        const compareTitle = story.original_title || story.title;

        const score = similarity(title, compareTitle);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

      // ================= CLUSTER =================
      if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
        const newScore = bestMatch.trending_score + 5;

        await supabase
          .from("articles")
          .update({
            trending_score: newScore,
            last_seen_at: new Date(),
          })
          .eq("id", bestMatch.id);

        console.log(
          `🔥 Clustered → ${bestMatch.trending_score} → ${newScore}`
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
        logline: logline,
        url: url,
        trending_score: 10,
        last_seen_at: new Date(),
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
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
const SIMILARITY_THRESHOLD = 0.45;

// ================= HELPERS =================

// --- Improved tokenizer ---
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// --- Improved similarity ---
function similarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...tokensA, ...tokensB]).size;

  return union === 0 ? 0 : intersection / union;
}

// ================= ✨ AUTO-TIGHTENING =================

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
  ];

  fluff.forEach((phrase) => {
    t = t.replace(new RegExp(phrase, "gi"), "");
  });

  const weakVerbs = [
    "is expected to",
    "is set to",
    "aims to",
    "seeks to",
    "plans to",
    "continues to",
  ];

  weakVerbs.forEach((phrase) => {
    t = t.replace(new RegExp(phrase, "gi"), "");
  });

  t = t.replace(/\s+/g, " ").trim();

  if (!t.endsWith(".")) t += ".";

  return t;
}

// ================= AI =================

// --- Logline ---
async function generateLogline(title, description) {
  const prompt = `
Write a tight, cinematic news logline.

RULES:
- Max 22 words
- One sentence only
- Start with the subject
- Use strong verbs
- No filler or fluff
- No speculation
- Grounded but engaging

ARTICLE:
Title: ${title}
Description: ${description}

Output only the logline.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return tightenLogline(res.choices[0].message.content.trim());
}

// --- Headline ---
async function generateHeadline(title) {
  const prompt = `
Rewrite this headline.

RULES:
- Max 12 words
- Punchy, clean, slightly dramatic
- No clickbait
- No new facts

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

    const articles = data.articles;

    const { data: existingStories } = await supabase
      .from("articles")
      .select("*");

    for (const article of articles) {
      const { title, description, url } = article;

      if (!title || !url) continue;

      console.log(`📰 ${title}`);

      let bestMatch = null;
      let bestScore = 0;

      for (const story of existingStories || []) {
        const compareTitle = story.original_title || story.title;

        // 🚨 SELF-MATCH FIX
        if (
          compareTitle &&
          compareTitle.trim().toLowerCase() === title.trim().toLowerCase()
        ) {
          continue;
        }

        const score = similarity(title, compareTitle);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

      // ================= CLUSTER =================
      if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
        const newScore = (bestMatch.trending_score || 0) + 5;

        await supabase
          .from("articles")
          .update({
            trending_score: newScore,
            last_seen_at: new Date().toISOString(),
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
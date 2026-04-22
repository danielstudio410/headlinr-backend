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

// --- Clean + tokenize ---
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter((w) => w.length > 3);
}

// --- Cosine similarity ---
function similarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter((x) => setB.has(x));
  return intersection.length / Math.max(setA.size, setB.size);
}

// ================= ✨ AUTO-TIGHTENING LAYER =================

function tightenLogline(text) {
  let t = text;

  // --- Remove fluff phrases ---
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
    const regex = new RegExp(phrase, "gi");
    t = t.replace(regex, "");
  });

  // --- Verb sharpening ---
  const replacements = [
    ["is expected to", ""],
    ["is set to", ""],
    ["aims to", ""],
    ["seeks to", ""],
    ["moves to", ""],
    ["plans to", ""],
    ["continues to", ""],
    ["working to", ""],
    ["beginning to", ""],
    ["starting to", ""],
    ["has begun to", ""],
    ["has started to", ""],
  ];

  replacements.forEach(([weak, strong]) => {
    const regex = new RegExp(weak, "gi");
    t = t.replace(regex, strong);
  });

  // --- Remove trailing soft endings ---
  const softEndings = [
    "impacting",
    "affecting",
    "raising concerns",
    "prompting questions",
  ];

  softEndings.forEach((end) => {
    const regex = new RegExp(`${end}.*$`, "gi");
    t = t.replace(regex, "");
  });

  // --- Trim + clean spacing ---
  t = t.replace(/\s+/g, " ").trim();

  // --- Ensure sentence ends cleanly ---
  if (!t.endsWith(".")) t += ".";

  return t;
}

// ================= AI GENERATION =================

// --- Logline ---
async function generateLogline(title, description) {
  const prompt = `
Write a tight, cinematic news logline.

RULES:
- Max 22 words
- One sentence only
- Start with the main subject
- Use strong verbs (avoid: "is", "are", "shows", "highlights")
- No filler or fluff
- No speculation or added facts
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

  const raw = res.choices[0].message.content.trim();
  return tightenLogline(raw);
}

// --- Headline ---
async function generateHeadline(title) {
  const prompt = `
Rewrite this news headline to be punchy, concise, and engaging.

RULES:
- Max 12 words
- Keep factual accuracy
- Slightly dramatic but not clickbait
- No exaggeration or invented facts

HEADLINE:
${title}

Return only the improved headline.
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

    for (const article of articles) {
      const { title, description, url } = article;

      if (!title || !url) continue;

      console.log(`📰 ${title}`);

      // --- Check existing stories ---
      const { data: existingStories } = await supabase
        .from("stories")
        .select("*");

      let matched = null;
      let bestScore = 0;

      for (const story of existingStories || []) {
        const score = similarity(title, story.title);

        if (score > bestScore) {
          bestScore = score;
          matched = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

      if (matched && bestScore >= SIMILARITY_THRESHOLD) {
        const newScore = matched.trending_score + 5;

        await supabase
          .from("stories")
          .update({ trending_score: newScore })
          .eq("id", matched.id);

        console.log(`🔥 Clustered → ${matched.trending_score} → ${newScore}`);
        continue;
      }

      // --- Generate AI content ---
      const logline = await generateLogline(title, description);
      const headline = await generateHeadline(title);

      console.log(`✨ Logline: ${logline}`);

      // --- Insert ---
      await supabase.from("stories").insert({
        title: headline,
        original_title: title,
        logline: logline,
        url: url,
        trending_score: 10,
      });

      console.log("✅ New story created");
    }

    console.log("🎉 Done!");
  } catch (err) {
    console.error("❌ FULL ERROR:", err);
    process.exit(1);
  }
}

fetchNews();
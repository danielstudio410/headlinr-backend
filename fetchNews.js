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
const SIMILARITY_THRESHOLD = 0.5;

// ================= TOKENIZER =================
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3);
}

// ================= SIMILARITY =================
function similarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter((x) => setB.has(x));
  return intersection.length / Math.max(setA.size, setB.size);
}

// ================= ✨ AUTO-TIGHTEN =================
function tightenLogline(text) {
  let t = text;

  // Remove cinematic clichés
  const bannedPhrases = [
    "in a world",
    "must choose",
    "battle of",
    "haunted by",
    "on the brink",
    "teetering",
    "shadows of",
    "ultimate question",
  ];

  bannedPhrases.forEach((phrase) => {
    t = t.replace(new RegExp(phrase, "gi"), "");
  });

  // Remove fluff
  const fluff = [
    "in a dramatic turn",
    "in a surprising twist",
    "in a shocking development",
    "amid growing concerns",
    "raising questions about",
  ];

  fluff.forEach((phrase) => {
    t = t.replace(new RegExp(phrase, "gi"), "");
  });

  // Remove overly dramatic words
  const bannedWords = [
    "frenzy",
    "outrage",
    "electrifying",
    "surge",
    "critical",
    "dramatic",
  ];

  bannedWords.forEach((word) => {
    t = t.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  });

  // Replace weak verbs
  const weakVerbs = [
    ["approaches", "nears"],
    ["aims to", ""],
    ["seeks to", ""],
    ["addresses", ""],
  ];

  weakVerbs.forEach(([weak, strong]) => {
    t = t.replace(new RegExp(weak, "gi"), strong);
  });

  // Remove overly formal words
  const formalWords = ["initiate", "implement", "utilize"];

  formalWords.forEach((word) => {
    t = t.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  });

  // Clean spacing
  t = t.replace(/\s+/g, " ").trim();

  // ================= VALIDATION =================

  if (!t || t.length < 30) return null;

  if (t.includes(",.") || t.includes('".') || t.includes(",,")) return null;

  if (!t.endsWith(".")) return null;

  if (t.split(" ").length < 7) return null;

  return t;
}

// ================= AI =================

async function generateLogline(title, description) {
  const prompt = `
Write a tight, cinematic news logline.

STYLE:
- Feels like a premium news alert with energy and momentum
- Clear, factual, and grounded
- Engaging through strong phrasing and forward movement

RULES:
- Max 20 words
- One sentence only
- Start with the main subject
- Use strong, active verbs
- Emphasise the key event or outcome
- ONLY include verifiable facts from the article
- Do NOT add interpretation, speculation, or invented context
- Do not misidentify who was harmed, charged, or affected

STRICTLY AVOID:
- Exaggeration or emotional language
- Words like "frenzy", "outrage", "electrifying", "surge", "dramatic"
- Any invented consequences or implications

TONE:
- Cinematic = clarity + momentum
- Energetic but controlled
- Punchy, not theatrical

ARTICLE:
Title: ${title}
Description: ${description}

Return ONLY the logline.
`;

  for (let i = 0; i < 2; i++) {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = res.choices[0].message.content.trim();
    const cleaned = tightenLogline(raw);

    if (cleaned) return cleaned;
  }

  return title; // safe fallback
}

// --- HEADLINE ---
async function generateHeadline(title) {
  const prompt = `
Rewrite this news headline to be punchy and engaging.

RULES:
- Max 12 words
- Slightly dramatic but factual
- No exaggeration

HEADLINE:
${title}

Return only the headline.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return res.choices[0].message.content.trim();
}

// ================= DECAY =================
async function applyDecay() {
  console.log("⏳ Running decay pass...");

  const { data: stories } = await supabase.from("articles").select("*");

  for (const story of stories || []) {
    const hoursOld =
      (Date.now() - new Date(story.last_seen_at).getTime()) / 3600000;

    const decayFactor = Math.exp(-hoursOld / 24);
    const newScore = Math.max(1, story.trending_score * decayFactor);

    await supabase
      .from("articles")
      .update({ trending_score: newScore })
      .eq("id", story.id);
  }

  console.log("✅ Decay applied");
}

// ================= MAIN =================
async function fetchNews() {
  try {
    console.log("🚀 Fetching news...");

    await applyDecay();

    const url = `https://newsapi.org/v2/top-headlines?country=us&pageSize=20&apiKey=${NEWS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();

    for (const article of data.articles) {
      const { title, description, url } = article;
      if (!title) continue;

      console.log(`📰 ${title}`);

      const { data: existing } = await supabase
        .from("articles")
        .select("*");

      let bestMatch = null;
      let bestScore = 0;

      for (const story of existing || []) {
        if (!story.original_title) continue;

        const score = similarity(title, story.original_title);

        if (score > bestScore && score < 0.98) {
          bestScore = score;
          bestMatch = story;
        }
      }

      console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

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
          `🔥 Clustered → sources: +1, score: ${newScore.toFixed(2)}`
        );
        continue;
      }

      const logline = await generateLogline(title, description);
      const headline = await generateHeadline(title);

      console.log(`✨ Logline: ${logline}`);

      await supabase.from("articles").insert({
        title: headline,
        original_title: title,
        logline,
        url,
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
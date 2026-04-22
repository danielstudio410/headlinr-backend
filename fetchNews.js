import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const VALID_CATEGORIES = [
  "politics","business","tech","science","health","sports",
  "entertainment","lifestyle","world","crime","murder","environment"
];

// 🧠 Tokenize text
function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter(w => w.length > 3);
}

// 🧠 Similarity score
function similarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = [...setA].filter(x => setB.has(x));
  return intersection.length / Math.max(setA.size, setB.size);
}

// 🔥 Apply decay
function applyDecay(score, lastSeenAt) {
  const hours = (new Date() - new Date(lastSeenAt)) / (1000 * 60 * 60);
  return Math.max(0, Math.round(score - hours * 2));
}

// 🏷 Normalize category
function normalizeCategory(cat) {
  if (!cat) return "world";
  const c = cat.toLowerCase();

  if (VALID_CATEGORIES.includes(c)) return c;
  if (c.includes("murder") || c.includes("kill")) return "murder";
  if (c.includes("crime")) return "crime";
  if (c.includes("tech")) return "tech";
  if (c.includes("politic")) return "politics";
  if (c.includes("business")) return "business";

  return "world";
}

// 📈 Initial score
function initialScore(category) {
  const map = {
    murder: 25,
    crime: 20,
    politics: 18,
    world: 15,
    tech: 10,
    business: 10,
    entertainment: 12,
    sports: 10,
    health: 8,
    science: 8,
    lifestyle: 5,
    environment: 6
  };

  return map[category] || 10;
}

async function fetchNews() {
  console.log("🚀 Fetching news...");

  // 📰 Fetch latest news
  const newsRes = await fetch(
    `https://newsapi.org/v2/top-headlines?language=en&pageSize=50&apiKey=${NEWS_API_KEY}`
  );
  const newsData = await newsRes.json();

  // 🧠 Fetch existing articles
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/articles?select=*`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    }
  );

  const existingArticles = await existingRes.json();

  for (const article of newsData.articles) {
    if (!article.title || !article.url) continue;

    console.log(`📰 ${article.title}`);

    let bestMatch = null;
    let bestScore = 0;

    for (const existing of existingArticles) {

      // ❗ CRITICAL FIX: skip exact same article
      if (existing.url === article.url) continue;

      const score = similarity(article.title, existing.title);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = existing;
      }
    }

    console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

    // 🎯 If similar story found → cluster
    if (bestScore >= 0.45 && bestMatch) {
      const decayed = applyDecay(
        bestMatch.trending_score,
        bestMatch.last_seen_at
      );

      const newScore = Math.min(100, decayed + 8);

      console.log(
        `🔥 Clustered → ${bestMatch.trending_score} → ${newScore}`
      );

      await fetch(
        `${SUPABASE_URL}/rest/v1/articles?id=eq.${bestMatch.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            trending_score: newScore,
            last_seen_at: new Date().toISOString(),
            source_count: (bestMatch.source_count || 1) + 1
          })
        }
      );

      continue;
    }

    // 🤖 New story → OpenAI
    const aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Return JSON with logline, category (${VALID_CATEGORIES.join(
              ", "
            )}), country`
          },
          {
            role: "user",
            content: `Title: ${article.title}\nDescription: ${article.description}`
          }
        ],
        response_format: { type: "json_object" }
      })
    });

    const aiData = await aiRes.json();

    let parsed;
    try {
      parsed = JSON.parse(aiData.choices[0].message.content);
    } catch {
      console.log("❌ AI parse failed");
      continue;
    }

    let { logline, category, country } = parsed;

    category = normalizeCategory(category);
    const score = initialScore(category);

    await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: article.title,
        description: article.description,
        url: article.url,
        logline,
        category,
        country,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        trending_score: score,
        source_count: 1
      })
    });

    console.log("✅ New story");
  }

  console.log("🎉 Done!");
}

fetchNews();
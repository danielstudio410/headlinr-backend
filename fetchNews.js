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

function normalizeCategory(category) {
  if (!category) return "world";
  const clean = category.toLowerCase().trim();
  if (VALID_CATEGORIES.includes(clean)) return clean;

  if (clean.includes("tech")) return "tech";
  if (clean.includes("politic")) return "politics";
  if (clean.includes("business")) return "business";
  if (clean.includes("sport")) return "sports";
  if (clean.includes("entertain")) return "entertainment";
  if (clean.includes("health")) return "health";
  if (clean.includes("science")) return "science";
  if (clean.includes("crime")) return "crime";
  if (clean.includes("murder") || clean.includes("kill")) return "murder";

  return "world";
}

// ✅ FIXED decay using last_seen_at
function applyDecay(score, lastSeenAt) {
  const now = new Date();
  const lastSeen = new Date(lastSeenAt);

  const hoursOld = (now - lastSeen) / (1000 * 60 * 60);
  const decay = hoursOld * 2;

  return Math.max(0, Math.round(score - decay));
}

function initialScore(category) {
  const map = {
    murder: 25, crime: 20, politics: 18, world: 15,
    tech: 10, business: 10, entertainment: 12,
    sports: 10, health: 8, science: 8,
    lifestyle: 5, environment: 6
  };
  return map[category] || 10;
}

async function fetchNews() {
  console.log("🚀 Fetching news...");

  const res = await fetch(`https://newsapi.org/v2/top-headlines?language=en&pageSize=50&apiKey=${NEWS_API_KEY}`);
  const data = await res.json();

  for (const article of data.articles) {
    if (!article.title || !article.url) continue;

    console.log(`📰 Processing: ${article.title}`);

    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?url=eq.${encodeURIComponent(article.url)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const existing = await checkRes.json();

    if (existing.length > 0) {
      const item = existing[0];

      const decayed = applyDecay(
        item.trending_score,
        item.last_seen_at
      );

      const newScore = Math.min(100, decayed + 5);

      console.log(`🔥 Score: ${item.trending_score} → ${decayed} → ${newScore}`);

      await fetch(`${SUPABASE_URL}/rest/v1/articles?url=eq.${encodeURIComponent(article.url)}`, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          trending_score: newScore,
          last_seen_at: new Date().toISOString()
        })
      });

      continue;
    }

    // OpenAI
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
            content: `Return JSON with logline, category (ONLY from: ${VALID_CATEGORIES.join(", ")}), country`
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
        trending_score: score
      })
    });

    console.log("✅ Inserted");
  }

  console.log("🎉 Done!");
}

fetchNews();
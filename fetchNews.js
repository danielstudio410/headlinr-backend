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

// 🧠 Generate story key
function generateStoryKey(title) {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter(word => word.length > 3)
    .sort()
    .slice(0, 6)
    .join(" ");
}

// 🔥 Decay
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

    const storyKey = generateStoryKey(article.title);

    console.log(`📰 ${article.title}`);
    console.log(`🔑 Story Key: ${storyKey}`);

    // 🔍 Check for similar story
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/articles?story_key=eq.${encodeURIComponent(storyKey)}`,
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

      const decayed = applyDecay(item.trending_score, item.last_seen_at);
      const newScore = Math.min(100, decayed + 8); // bigger boost for multi-source

      console.log(`🔥 Cluster boost: ${item.trending_score} → ${newScore}`);

      await fetch(`${SUPABASE_URL}/rest/v1/articles?id=eq.${item.id}`, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          trending_score: newScore,
          last_seen_at: new Date().toISOString(),
          source_count: item.source_count + 1
        })
      });

      continue;
    }

    // 🤖 OpenAI for NEW story
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
            content: `Return JSON with logline, category (${VALID_CATEGORIES.join(", ")}), country`
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
        story_key: storyKey,
        source_count: 1,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        trending_score: score
      })
    });

    console.log("✅ New clustered story created");
  }

  console.log("🎉 Done!");
}

fetchNews();
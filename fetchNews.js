import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const VALID_CATEGORIES = [
  "politics",
  "business",
  "tech",
  "science",
  "health",
  "sports",
  "entertainment",
  "lifestyle",
  "world",
  "crime",
  "murder",
  "environment"
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
  if (clean.includes("environment")) return "environment";

  return "world";
}

function calculateTrendingScore({ publishedAt, duplicateCount, category }) {
  const now = new Date();
  const published = new Date(publishedAt);

  const hoursOld = (now - published) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 50 - hoursOld * 2);

  const duplicateScore = Math.min(40, duplicateCount * 10);

  const categoryBoostMap = {
    murder: 20,
    crime: 15,
    politics: 12,
    world: 10,
    tech: 6,
    business: 6,
    entertainment: 8,
    sports: 6,
    health: 5,
    science: 5,
    lifestyle: 3,
    environment: 4
  };

  const categoryScore = categoryBoostMap[category] || 0;

  const total = recencyScore + duplicateScore + categoryScore;
  return Math.round(Math.min(100, total));
}

async function fetchNews() {
  console.log("🚀 Fetching news...");

  const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=50&apiKey=${NEWS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  for (const article of data.articles) {
    if (!article.title || !article.url) continue;

    console.log(`📰 Processing: ${article.title}`);

    // 🔍 Check existing article
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

    // 🔥 IF EXISTS → UPDATE TRENDING
    if (existing.length > 0) {
      const existingArticle = existing[0];

      const newScore = Math.min(100, existingArticle.trending_score + 5);

      console.log(`🔥 Updating trending score: ${existingArticle.trending_score} → ${newScore}`);

      await fetch(`${SUPABASE_URL}/rest/v1/articles?url=eq.${encodeURIComponent(article.url)}`, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          trending_score: newScore,
          created_at: new Date().toISOString()
        })
      });

      console.log("🔄 Updated existing article");
      continue;
    }

    // 🤖 OpenAI for NEW articles only
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
            content: `You must return ONLY valid JSON.

Fields:
- logline: short cinematic summary
- category: MUST be one of these EXACT values:
${VALID_CATEGORIES.join(", ")}
- country: country name

Do not invent categories.`
          },
          {
            role: "user",
            content: `Title: ${article.title}
Description: ${article.description}`
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

    const trendingScore = calculateTrendingScore({
      publishedAt: article.publishedAt,
      duplicateCount: 1,
      category
    });

    console.log(`✨ Logline: ${logline}`);
    console.log(`🏷 Category: ${category}`);
    console.log(`🌍 Country: ${country}`);
    console.log(`🔥 Trending Score: ${trendingScore}`);

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        title: article.title,
        description: article.description,
        url: article.url,
        logline,
        category,
        country,
        created_at: new Date().toISOString(),
        trending_score: trendingScore
      })
    });

    if (!insertRes.ok) {
      console.log("❌ Insert failed");
    } else {
      console.log("✅ Inserted successfully");
    }
  }

  console.log("🎉 Done!");
}

fetchNews();
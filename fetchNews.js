import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const NEWS_API_KEY = process.env.NEWS_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const storyCounts = {};

function calculateTrendingScore({ publishedAt, duplicateCount, category }) {
  const now = new Date();
  const published = new Date(publishedAt);

  const hoursOld = (now - published) / (1000 * 60 * 60);
  const recencyScore = Math.max(0, 40 - hoursOld);

  const duplicateScore = Math.min(30, duplicateCount * 5);

  const categoryBoostMap = {
    murder: 20,
    crime: 15,
    politics: 10,
    world: 10,
    tech: 5,
    business: 5,
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

  const url = `https://newsapi.org/v2/top-headlines?language=en&pageSize=20&apiKey=${NEWS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();

  for (const article of data.articles) {
    if (!article.title || !article.url) continue;

    const key = article.title.toLowerCase();

    if (!storyCounts[key]) {
      storyCounts[key] = 0;
    }
    storyCounts[key]++;

    console.log(`📰 Processing: ${article.title}`);

    // 🔍 Check if already exists
    const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/articles?url=eq.${encodeURIComponent(article.url)}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`
      }
    });

    const existing = await checkRes.json();

    if (existing.length > 0) {
      console.log("⏭ Skipped (duplicate URL)");
      continue;
    }

    // 🧠 Call OpenAI ONLY for new articles
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
            content: "Return JSON with: logline, category, country"
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
    } catch (e) {
      console.log("❌ AI parse failed");
      continue;
    }

    const { logline, category, country } = parsed;

    const trendingScore = calculateTrendingScore({
      publishedAt: article.publishedAt,
      duplicateCount: storyCounts[key],
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
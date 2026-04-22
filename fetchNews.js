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

// 🧠 Clean headline
function cleanHeadline(title) {
  return title
    .replace(/ - [^-]+$/, "")
    .replace(/\|.*$/, "")
    .trim();
}

// 🧠 Tokenize
function tokenize(text) {
  return cleanHeadline(text)
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(" ")
    .filter(w => w.length > 3);
}

// 🧠 Similarity
function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  const overlap = [...A].filter(x => B.has(x));
  return overlap.length / Math.max(A.size, B.size);
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

// 🤖 AI HEADLINE GENERATOR (UPGRADED PROMPT)
async function generateHeadline(title, description) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
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
            content: `Write a concise, punchy news headline.

Rules:
- 8 to 14 words
- Use strong, active verbs (avoid "is", "are", "was", "were")
- Lead with the most important fact or action
- Make it sharp and engaging, but still factual
- Avoid passive or vague phrasing (e.g. "reports", "says", "witnesses say")
- Avoid filler words like "amid", "as", "after" where possible
- No exaggeration, hype, or clickbait
- No source names
- Should feel modern, tight, and slightly bold — like a premium news app`
          },
          {
            role: "user",
            content: `Title: ${title}\nDescription: ${description}`
          }
        ],
        temperature: 0.5
      })
    });

    const data = await res.json();
    return cleanHeadline(data.choices[0].message.content);
  } catch (err) {
    console.log("⚠️ Headline generation failed");
    return cleanHeadline(title);
  }
}

async function fetchNews() {
  console.log("🚀 Fetching news...");

  const newsRes = await fetch(
    `https://newsapi.org/v2/top-headlines?language=en&pageSize=50&apiKey=${NEWS_API_KEY}`
  );
  const newsData = await newsRes.json();

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
      if (existing.url === article.url) continue;

      const score = similarity(
        article.title,
        existing.canonical_title || existing.title
      );

      if (score > bestScore) {
        bestScore = score;
        bestMatch = existing;
      }
    }

    console.log(`🔍 Similarity: ${bestScore.toFixed(2)}`);

    // 🔁 EXISTING STORY (CLUSTER UPDATE)
    if (bestScore >= 0.45 && bestMatch) {
      const decayed = applyDecay(
        bestMatch.trending_score,
        bestMatch.last_seen_at
      );

      const newScore = Math.min(100, decayed + 8);

      const updatedSources = bestMatch.source_urls || [];
      if (!updatedSources.includes(article.url)) {
        updatedSources.push(article.url);
      }

      // 🤖 Generate improved headline
      const newHeadline = await generateHeadline(
        article.title,
        article.description
      );

      console.log(`🧠 AI Headline: ${newHeadline}`);

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
            source_count: updatedSources.length,
            source_urls: updatedSources,
            canonical_title: newHeadline
          })
        }
      );

      continue;
    }

    // 🆕 NEW STORY
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

    // 🤖 Generate canonical headline
    const headline = await generateHeadline(
      article.title,
      article.description
    );

    await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: article.title,
        canonical_title: headline,
        description: article.description,
        url: article.url,
        source_urls: [article.url],
        primary_source: article.url,
        logline,
        category,
        country,
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        trending_score: score,
        source_count: 1
      })
    });

    console.log("✅ New canonical story created");
  }

  console.log("🎉 Done!");
}

fetchNews();
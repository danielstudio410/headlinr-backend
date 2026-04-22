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

// 🤖 HEADLINE GENERATOR
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
- 8 to 12 words
- Use strong, active verbs
- Lead with the key event or outcome
- Keep it tight and clean
- Allow slight energy but stay credible
- No clickbait
- No source names`
          },
          {
            role: "user",
            content: `Title: ${title}\nDescription: ${description}`
          }
        ],
        temperature: 0.6
      })
    });

    const data = await res.json();
    return cleanHeadline(data.choices[0].message.content);
  } catch {
    return cleanHeadline(title);
  }
}

// 🎬 UPDATED LOGLINE GENERATOR (FIXED)
async function generateLogline(title, description) {
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
            content: `Write a cinematic but grounded news logline.

Rules:
- 1–2 sentences max
- 18–28 words total
- Focus on the core event and outcome
- Use strong, clear language (no fluff)
- Keep tone engaging but factual
- Avoid dramatic filler phrases (e.g. "in a shocking twist", "in a dramatic turn")
- Avoid exaggerated or emotional language unless explicitly supported by facts
- No speculation or added interpretation
- Make it feel sharp and story-driven, like a film synopsis grounded in reality`
          },
          {
            role: "user",
            content: `Title: ${title}\nDescription: ${description}`
          }
        ],
        temperature: 0.65
      })
    });

    const data = await res.json();
    return data.choices[0].message.content.trim();
  } catch {
    return description || "";
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

    // 🔁 EXISTING STORY (CLUSTER)
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
            source_urls: updatedSources
          })
        }
      );

      console.log(`🔥 Clustered → ${bestMatch.trending_score} → ${newScore}`);
      continue;
    }

    // 🆕 NEW STORY
    const headline = await generateHeadline(article.title, article.description);
    const logline = await generateLogline(article.title, article.description);

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
        logline,
        url: article.url,
        source_urls: [article.url],
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        trending_score: 10,
        source_count: 1
      })
    });

    console.log(`✨ Logline: ${logline}`);
    console.log("✅ New story created");
  }

  console.log("🎉 Done!");
}

fetchNews();
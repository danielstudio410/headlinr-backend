// ==============================
// 1. Load environment variables
// ==============================
import dotenv from "dotenv";
dotenv.config();

// ==============================
// 2. Imports
// ==============================
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// ==============================
// 3. Initialize clients
// ==============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ==============================
// 4. Constants
// ==============================
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const CATEGORIES = [
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
  "environment",
];

// ==============================
// 5. Helper: Clean AI JSON
// ==============================
function safeParseJSON(text) {
  try {
    // Remove code block formatting if AI adds it
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    return JSON.parse(cleaned);
  } catch (err) {
    console.error("JSON parse failed:", err.message);
    return null;
  }
}

// ==============================
// 6. Helper: Check duplicate URL
// ==============================
async function isDuplicate(url) {
  const { data, error } = await supabase
    .from("articles")
    .select("id")
    .eq("url", url)
    .limit(1);

  if (error) {
    console.error("Duplicate check error:", error.message);
    return false;
  }

  return data.length > 0;
}

// ==============================
// 7. Main function
// ==============================
async function fetchNews() {
  try {
    console.log("🚀 Fetching news...");

    const response = await fetch(
      `https://newsapi.org/v2/top-headlines?language=en&pageSize=20&apiKey=${NEWS_API_KEY}`
    );

    const data = await response.json();

    if (!data.articles || data.articles.length === 0) {
      console.error("❌ No articles returned.");
      return;
    }

    for (const article of data.articles) {
      const { title, description, url } = article;

      if (!title || !description || !url) continue;

      console.log(`\n📰 Processing: ${title}`);

      // ==============================
      // 7a. Skip duplicates
      // ==============================
      const exists = await isDuplicate(url);
      if (exists) {
        console.log("⏭ Skipped (duplicate)");
        continue;
      }

      // ==============================
      // 7b. AI Processing
      // ==============================
      let logline = title;
      let category = "world";
      let country = "global";

      try {
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You analyze news articles and return structured JSON only.",
            },
            {
              role: "user",
              content: `
Analyze this news article and return:

1. A sharp, factual, cinematic news logline (max 20 words)
2. A category from this list:
${CATEGORIES.join(", ")}
3. The most relevant country (e.g. US, UK, Australia)

IMPORTANT RULES:
- Use "murder" ONLY if the story involves a killing or homicide
- Use "crime" for all other criminal activity
- Be concise and factual (not clickbait)

Return ONLY valid JSON:
{
  "logline": "...",
  "category": "...",
  "country": "..."
}

Title: ${title}
Description: ${description}
              `,
            },
          ],
          max_tokens: 150,
        });

        const content = aiResponse.choices[0].message.content;

        const parsed = safeParseJSON(content);

        if (parsed) {
          logline = parsed.logline || title;
          category = CATEGORIES.includes(parsed.category)
            ? parsed.category
            : "world";
          country = parsed.country || "global";
        }

        console.log("✨ Logline:", logline);
        console.log("🏷 Category:", category);
        console.log("🌍 Country:", country);

      } catch (err) {
        console.error("🤖 OpenAI error:", err.message);
      }

      // ==============================
      // 7c. Metadata
      // ==============================
      const created_at = new Date();

      // Simple trending score (MVP)
      const trending_score = Math.floor(Math.random() * 100);

      // ==============================
      // 7d. Insert into Supabase
      // ==============================
      const { error } = await supabase.from("articles").insert([
        {
          title,
          description,
          url,
          logline,
          category,
          country,
          created_at,
          trending_score,
        },
      ]);

      if (error) {
        console.error("❌ Insert failed:", error.message);
      } else {
        console.log("✅ Inserted successfully");
      }
    }

    console.log("\n🎉 Done!");
  } catch (err) {
    console.error("🔥 Fatal error:", err.message);
  }
}

// ==============================
// 8. Run script
// ==============================
fetchNews();

import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function test() {
  const { data, error } = await supabase.from("articles").select("*").limit(1);
  if (error) console.error("Supabase error:", error);
  else console.log("Supabase success:", data);
}

test();

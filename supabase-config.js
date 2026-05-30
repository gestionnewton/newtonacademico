// supabase-config.js
const SUPABASE_URL = "https://icmhzqxzzmvsamxtrqtg.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImljbWh6cXh6em12c2FteHRycXRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2NDU3NTQsImV4cCI6MjA4NjIyMTc1NH0.YeWt96NOObnmpM6ca5AflThP95JUROx5yXXJkw3GTaY";

// Inicializamos el cliente de Supabase
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
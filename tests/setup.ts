// Unit tests need no env. Integration tests read the local Supabase settings if .env.local exists.
try {
  process.loadEnvFile(".env.local");
} catch {}

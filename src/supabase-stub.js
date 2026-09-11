// Swapped in for @supabase/supabase-js when a build has no account backend
// configured. Keeps 128 kB of SDK out of the published artifact, which has its
// own storage and could not reach Supabase anyway.
export function createClient() {
  return null;
}

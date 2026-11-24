// Who is signed in and which contacts they may work, decided by Supabase Row Level Security.
// Every Supabase call here uses the PERSON'S OWN login token with the publishable key, so Postgres
// applies the RLS policies in migrations/001_access.sql. Never use the secret key here: it skips RLS.
function createAccess({ url, publishableKey }) {
  const enabled = Boolean(url && publishableKey);

  async function call(path, token) {
    const res = await fetch(url.replace(/\/$/, "") + path, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
    });
    // An invalid or expired login token means "not signed in". Any other failure (e.g. a missing
    // grant) is a setup error and must fail loudly, not quietly show nobody any contacts.
    if (path.startsWith("/auth/") && (res.status === 401 || res.status === 403)) return null;
    if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]} returned ${res.status}`);
    return res.json();
  }

  // Returns { userId, email, name, role, allowed:Set<contact_id> }, or null if the token is missing or invalid.
  async function forToken(token) {
    if (!token) return null;
    const user = await call("/auth/v1/user", token); // Supabase checks the token's signature and expiry
    if (!user || !user.id) return null;
    const [members, rows] = await Promise.all([
      call(`/rest/v1/members?select=full_name,role&user_id=eq.${encodeURIComponent(user.id)}`, token),
      call("/rest/v1/contact_access?select=contact_id", token),
    ]);
    const me = (members && members[0]) || {};
    return {
      userId: user.id,
      email: user.email || "",
      name: me.full_name || "",
      role: me.role || "member",
      allowed: new Set((rows || []).map(r => r.contact_id)),
      token,
    };
  }

  // A Chen Institute member's outreach decision, so email access changes right away.
  // Runs as that person: RLS (migrations/003) lets only role 'chen' change the approval column.
  // Update the rows that exist, then insert the rest (no upsert: that would need UPDATE on contact_id).
  async function setApproval(token, contactIds, value) {
    const base = url.replace(/\/$/, "") + "/rest/v1/contact_access";
    const headers = { apikey: publishableKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" };
    const list = contactIds.map(id => `"${String(id).replace(/["\\]/g, "")}"`).join(",");
    const upd = await fetch(`${base}?contact_id=in.(${encodeURIComponent(list)})&select=contact_id`, {
      method: "PATCH", headers, body: JSON.stringify({ approval: value }),
    });
    if (!upd.ok) throw new Error(`Supabase approval update returned ${upd.status}`);
    const done = new Set((await upd.json()).map(r => r.contact_id));
    const missing = contactIds.filter(id => !done.has(id));
    if (!missing.length) return;
    const ins = await fetch(base + "?select=contact_id", {
      method: "POST", headers, body: JSON.stringify(missing.map(id => ({ contact_id: id, approval: value }))),
    });
    if (!ins.ok) throw new Error(`Supabase approval insert returned ${ins.status}`);
  }

  return { enabled, forToken, setApproval };
}

module.exports = { createAccess };

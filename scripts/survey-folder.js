// Lists every file under the SREC master folder (SREC_FOLDER_ID) so we can see what's there
// before building any extraction. Read-only, and it never opens a file: only names, types,
// dates and sizes come back from Drive. No AI is used.
// Usage: npm run survey
// Console: counts only (by vertical folder, file type and school year), no file names.
// Full list: a CSV saved next to the sign-in token (outside the repo and OneDrive), because
// file names can contain people's names.
const fs = require("fs");
const path = require("path");
const { auth, drive } = require("@googleapis/drive");

const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const TYPES = [
  ["Google Sheet", m => m === "application/vnd.google-apps.spreadsheet"],
  ["Excel/CSV", m => /spreadsheetml|ms-excel|text\/csv/.test(m)],
  ["Google Doc", m => m === "application/vnd.google-apps.document"],
  ["Word", m => /wordprocessingml|msword/.test(m)],
  ["PDF", m => m === "application/pdf"],
  ["Slides/PPT", m => /google-apps\.presentation|presentationml|ms-powerpoint/.test(m)],
  ["Image", m => m.startsWith("image/")],
  ["Google Form", m => m === "application/vnd.google-apps.form"],
];
const typeOf = m => (TYPES.find(([, test]) => test(m)) || ["Other"])[0];
// School year runs Aug–Jul: a file modified in Oct 2025 is "2025-26".
const schoolYear = iso => {
  const d = new Date(iso);
  const y = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
};
const csv = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;

(async () => {
  for (const k of ["GOOGLE_OAUTH_CLIENT_FILE", "GOOGLE_TOKEN_FILE", "SREC_FOLDER_ID"]) {
    if (!process.env[k]) throw new Error(`Set ${k} in .env`);
  }
  const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE, "utf8"));
  const c = raw.web || raw.installed;
  const client = new auth.OAuth2(c.client_id, c.client_secret);
  const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_FILE, "utf8"));
  if (!String(token.scope || "").includes("drive.readonly")) {
    console.error("The saved Google sign-in can't read Drive yet. Restart the app (npm start), open");
    console.error("http://localhost:3000/auth/google, allow Drive access, then run this again.");
    process.exit(1);
  }
  client.setCredentials(token);
  client.on("tokens", t => {
    fs.writeFileSync(process.env.GOOGLE_TOKEN_FILE, JSON.stringify({ ...token, ...t }, null, 2), { mode: 0o600 });
  });
  const api = drive({ version: "v3", auth: client });
  const shared = { supportsAllDrives: true, includeItemsFromAllDrives: true };

  const root = (await api.files.get({ fileId: process.env.SREC_FOLDER_ID, fields: "id,name,mimeType", ...shared })).data;
  if (root.mimeType !== FOLDER) throw new Error("SREC_FOLDER_ID is not a folder.");

  const files = [];
  const seen = new Set([root.id]);
  // Breadth-first walk. `vertical` = the first-level subfolder a file sits under.
  const queue = [{ id: root.id, path: "", vertical: "(top level)" }];
  let folders = 0;
  while (queue.length) {
    const dir = queue.shift();
    let pageToken;
    do {
      const res = await api.files.list({
        q: `'${dir.id}' in parents and trashed = false`,
        fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size,shortcutDetails)",
        pageSize: 1000,
        pageToken,
        ...shared,
      });
      for (const f of res.data.files) {
        let { id, mimeType } = f;
        if (mimeType === SHORTCUT && f.shortcutDetails) {
          id = f.shortcutDetails.targetId;
          mimeType = f.shortcutDetails.targetMimeType;
        }
        const p = dir.path ? `${dir.path}/${f.name}` : f.name;
        const vertical = dir.path ? dir.vertical : (mimeType === FOLDER ? f.name : "(top level)");
        if (mimeType === FOLDER) {
          if (!seen.has(id)) { seen.add(id); folders++; queue.push({ id, path: p, vertical }); }
          continue;
        }
        files.push({ vertical, path: p, type: typeOf(mimeType), mimeType, modified: f.modifiedTime,
          year: schoolYear(f.modifiedTime), sizeKB: f.size ? Math.round(f.size / 1024) : "", id });
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  }

  // Full list, saved privately.
  const out = path.join(path.dirname(process.env.GOOGLE_TOKEN_FILE), "srec-folder-survey.csv");
  const cols = ["vertical", "path", "type", "mimeType", "modified", "year", "sizeKB", "id"];
  fs.writeFileSync(out, "﻿" + [cols.join(","), ...files.map(f => cols.map(k => csv(f[k])).join(","))].join("\r\n"), "utf8");

  // Counts only on screen.
  const count = key => files.reduce((m, f) => m.set(f[key], (m.get(f[key]) || 0) + 1), new Map());
  const typeNames = [...count("type").keys()].sort();
  console.log(`Folder walked: ${folders} subfolders, ${files.length} files.\n`);
  console.log("By vertical folder and type:");
  const byV = new Map();
  for (const f of files) {
    if (!byV.has(f.vertical)) byV.set(f.vertical, new Map());
    byV.get(f.vertical).set(f.type, (byV.get(f.vertical).get(f.type) || 0) + 1);
  }
  console.table(Object.fromEntries([...byV].sort().map(([v, m]) =>
    [v, Object.fromEntries(typeNames.map(t => [t, m.get(t) || 0]))])));
  console.log("By file type:");
  console.table(Object.fromEntries([...count("type")].sort((a, b) => b[1] - a[1])));
  console.log("By school year (last modified):");
  console.table(Object.fromEntries([...count("year")].sort()));
  console.log(`Full list (file names, paths, IDs) saved privately to:\n  ${out}`);
})().catch(err => {
  const msg = String((err && err.message) || err);
  if (/insufficient|scope/i.test(msg)) console.error("Drive access was not granted. Sign in again at http://localhost:3000/auth/google.");
  else if (/has not been used|disabled/i.test(msg)) console.error("The Google Drive API isn't enabled in the Cloud project yet.");
  else if (/not found/i.test(msg)) console.error("Folder not found: check SREC_FOLDER_ID and that your NYU account can open it.");
  else console.error("Survey failed:", msg);
  process.exit(1);
});

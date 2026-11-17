// Second survey pass: for spreadsheet-like files that look like event or people lists
// (Google Sheets incl. Form responses, Excel, CSV), read each tab's header row and count
// its data rows. Nothing else from the files is printed or saved. No AI.
// Needs: npm run survey first (it reads that file list).
// Usage: npm run survey:headers
// Skips (by file name) student applications/resumes, budgets, credentials and the CRM's own sheet.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { auth, sheets } = require("@googleapis/sheets");
const { drive } = require("@googleapis/drive");

const SKIP = /application|resume|interview|budget|expense|invoice|reimburs|revenue|login|subscription|password|org chart|officer|board - present|swag|pricing|rent v|SRECRM|Sponsorship CRM|EMS Form|calendar|knowledge database|user count|template \(1\)|volunteer/i;
const WANT = /attend|antend|atend|regist|rsvp|sign.?in|sign up|responses|visitor|jrny|speaker|panel|outreach|tracker|alumni|contacts|directory|roster|guest|names|summit|symposium|conference|mentor|target list/i;
const EMAILISH = /@|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/;
const PEOPLE = { name: /name/i, email: /e-?mail/i, org: /company|firm|organi[sz]ation|employer|affiliation/i, title: /title|position|role/i };

// Google allows 60 Sheets reads a minute: pace calls and retry once after a minute if limited.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function paced(fn) {
  await sleep(1100);
  try { return await fn(); } catch (err) {
    if (!/quota|rate/i.test(String(err.message))) throw err;
    await sleep(61000);
    return fn();
  }
}
const str = v => (v == null ? "" : typeof v === "object" ? String(v.text || v.result || "") : String(v)).trim();
const csvCell = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
function parseCsvLine(l) {
  const o = []; let c = "", q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch;
  }
  o.push(c); return o;
}

// Header = first of the top 5 rows with at least 2 filled cells. Returns only headers + a count.
function summarize(rows) {
  rows = rows.map(r => (r || []).map(str));
  const h = rows.slice(0, 5).findIndex(r => r.filter(Boolean).length >= 2);
  if (h === -1) return { header: [], rows: 0, note: "empty or no header" };
  const header = rows[h].filter(Boolean);
  const dataRows = rows.slice(h + 1).filter(r => r.some(Boolean)).length;
  if (header.some(c => EMAILISH.test(c))) return { header: [], rows: dataRows + 1, note: "no header row (hidden: looks like data)" };
  const has = Object.fromEntries(Object.entries(PEOPLE).map(([k, re]) => [k, header.some(c => re.test(c))]));
  const people = has.name && (has.email || has.org || has.title);
  return { header: header.map(c => c.slice(0, 40)), rows: dataRows, people, has };
}

(async () => {
  const dir = path.dirname(process.env.GOOGLE_TOKEN_FILE);
  const listFile = path.join(dir, "srec-folder-survey.csv");
  if (!fs.existsSync(listFile)) throw new Error("Run `npm run survey` first.");
  const lines = fs.readFileSync(listFile, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const H = parseCsvLine(lines[0]);
  const files = lines.slice(1).map(parseCsvLine).map(r => Object.fromEntries(H.map((h, i) => [h, r[i]])))
    .filter(f => ["Google Sheet", "Excel/CSV"].includes(f.type))
    .filter(f => !SKIP.test(path.posix.basename(f.path)) && WANT.test(f.path));

  const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE, "utf8"));
  const c = raw.web || raw.installed;
  const client = new auth.OAuth2(c.client_id, c.client_secret);
  const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_FILE, "utf8"));
  client.setCredentials(token);
  client.on("tokens", t => fs.writeFileSync(process.env.GOOGLE_TOKEN_FILE, JSON.stringify({ ...token, ...t }, null, 2), { mode: 0o600 }));
  const sh = sheets({ version: "v4", auth: client });
  const dr = drive({ version: "v3", auth: client });

  const results = [];
  for (const f of files) {
    const tabs = [];
    try {
      if (f.type === "Google Sheet") {
        const meta = await paced(() => sh.spreadsheets.get({ spreadsheetId: f.id, fields: "sheets.properties.title" }));
        const titles = meta.data.sheets.map(s => s.properties.title);
        const res = await paced(() => sh.spreadsheets.values.batchGet({ spreadsheetId: f.id, ranges: titles.map(t => `'${t.replace(/'/g, "''")}'`) }));
        titles.forEach((t, i) => tabs.push({ tab: t, ...summarize(res.data.valueRanges[i].values || []) }));
      } else {
        const res = await dr.files.get({ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
        const buf = Buffer.from(res.data);
        if (/\.csv$/i.test(f.path) || f.mimeType === "text/csv") {
          const rows = buf.toString("utf8").replace(/^﻿/, "").split(/\r?\n/).map(parseCsvLine);
          tabs.push({ tab: "(csv)", ...summarize(rows) });
        } else {
          const wb = new ExcelJS.Workbook();
          await wb.xlsx.load(buf);
          wb.eachSheet(ws => {
            const rows = [];
            ws.eachRow({ includeEmpty: true }, (row, n) => { rows[n - 1] = row.values.slice(1); });
            tabs.push({ tab: ws.name, ...summarize(rows) });
          });
        }
      }
    } catch (err) {
      tabs.push({ tab: "", header: [], rows: 0, note: "could not read: " + String(err.message || err).slice(0, 80) });
    }
    for (const t of tabs) results.push({ ...f, ...t });
    process.stdout.write(".");
  }
  console.log("\n");

  const out = path.join(dir, "srec-folder-headers.csv");
  const cols = ["vertical", "path", "type", "tab", "rows", "people", "header", "note", "id"];
  fs.writeFileSync(out, "﻿" + [cols.join(","), ...results.map(r =>
    cols.map(k => csvCell(k === "header" ? (r.header || []).join(" | ") : r[k])).join(","))].join("\r\n"), "utf8");

  // On screen: file path, tab, row count, and header names only.
  const people = results.filter(r => r.people && r.rows > 0);
  console.log(`Checked ${files.length} files (${results.length} tabs). Tabs that look like people lists: ${people.length}, ${people.reduce((s, r) => s + r.rows, 0)} rows.\n`);
  for (const r of results.sort((a, b) => (b.people ? 1 : 0) - (a.people ? 1 : 0) || a.path.localeCompare(b.path))) {
    const mark = r.people ? "PEOPLE" : "      ";
    console.log(`${mark} ${String(r.rows).padStart(5)}  ${r.path.slice(0, 110)}${r.tab && r.tab !== "(csv)" ? "  [" + r.tab.slice(0, 30) + "]" : ""}`);
    console.log(`               ${r.note ? "(" + r.note + ")" : (r.header || []).join(" | ").slice(0, 220)}`);
  }
  console.log(`\nSaved privately to:\n  ${out}`);
})().catch(err => { console.error("Header survey failed:", String(err.message || err)); process.exit(1); });

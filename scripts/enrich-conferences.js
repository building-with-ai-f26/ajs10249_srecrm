// DRY RUN: proposes sheet changes from the four SREC conferences' speaker and registration
// lists in the SREC Drive folder. Writes NOTHING to the sheet.
// Usage: npm run enrich:dry   (needs `npm run survey` and `npm run survey:headers` first)
// Console: counts only. Proposed rows (with names) go to a private CSV next to the token.
// Rules (decided Nov 17, 2026):
//  - Current students are skipped. Alumni are kept; unmatched ones become alumni contacts.
//  - Registered and Attended are separate. No source has check-ins, so Attended = Unknown.
//  - Chen approval is not set from any source (Sam reviews first). New contacts: Owner blank (the club assigns).
//  - New contacts with a firm go to the "Firm" queue. Those without one (no firm given and an email
//    domain that matches no known firm) go to the "Unaffiliated" queue, listed with the events they
//    attended so they can be added to a firm later or invited to future conferences.
//  - Gender, dietary, accessibility, address and payment columns are never read into output.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { auth, sheets } = require("@googleapis/sheets");
const { drive } = require("@googleapis/drive");

const EVENTS = [
  { key: "power24", name: "NYU Real Estate: Powering the Future (2024)", date: "2024-09-27", isNew: true,
    speakers: [{ kind: "agenda", path: "2024 09 27 | SREC Power Conference /Speaker List Tracker", tab: "New Agenda" }],
    attendees: [] },
  { key: "lux25", name: "Icons & Avenues: Luxury & Lifestyle Real Estate Summit", date: "2025-11-07",
    speakers: [{ kind: "agenda", path: "Retail Real Estate Summit/Luxury & Lifestyle Real Estate Summit", tab: "Luxury 2025 Agenda" }],
    attendees: [
      { kind: "reg", path: "Registration List/Eventbrite Registration List.csv" },
      { kind: "reg", path: "Registration List/CG Registration List.csv" },
    ] },
  { key: "power26", name: "Powering the Future: AI-Driven Energy Systems & Urban Growth", date: "2026-03-06",
    speakers: [
      { kind: "flagged", path: "Power conference attendees.xlsx", tab: "Eventbrite", flag: r => /speaker/i.test(r.Speaker) },
      { kind: "tracker", path: "2026.03.06 Power Conference/Spring 2026 - Conference Prep", tab: "2026 Speaker planning" },
    ],
    attendees: [
      { kind: "reg", path: "Power conference attendees.xlsx", tab: "Eventbrite" },
      { kind: "reg", path: "Power conference attendees.xlsx", tab: "Campus Group" },
      { kind: "reg", path: "Power conference attendees.xlsx", tab: "CS Sponsored" },
    ] },
  { key: "lux26", name: "Luxury Lifestyle Conference 2026 (SREC w/ LARC)", date: "2026-11-06",
    speakers: [
      { kind: "agenda", path: "2026.11.06_Luxury Real Estate/Luxury Real Estate 2026 - Conference Prep", tab: "Agenda" },
      { kind: "flagged", path: "4_Volunteering & Run of Show/Attendance List", tab: "Registrants", flag: r => /^speaker$/i.test(r["Ticket Type"]) },
    ],
    attendees: [{ kind: "reg", path: "4_Volunteering & Run of Show/Attendance List", tab: "Registrants" }] },
];

// ---------- helpers ----------
const str = v => (v == null ? "" : typeof v === "object"
  ? String(v.text || v.result || (v.richText ? v.richText.map(t => t.text).join("") : "") || (v.hyperlink || ""))
  : String(v)).replace(/\s+/g, " ").trim();
const norm = s => str(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/\(.*?\)/g, " ").replace(/\b(jr|sr|ii|iii|iv|phd|mba|cfa|esq)\b\.?/g, " ").replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
const nameKey = (first, last) => { const f = norm(first).split(" ")[0] || ""; const l = norm(last).split(" ").pop() || ""; return f && l ? `${f} ${l}` : ""; };
const splitName = full => { const p = str(full).replace(/^(moderator|moderated by|keynote)\s*[:\-–]\s*/i, "").replace(/\(.*?\)/g, "").trim().split(" "); return { first: p[0] || "", last: p.length > 1 ? p.slice(1).join(" ") : "" }; };
const orgKey = s => norm(s).replace(/\b(llc|inc|lp|llp|corp|corporation|co|company|group|the|partners?|holdings?|capital|management|real estate|properties)\b/g, " ").replace(/\s+/g, " ").trim();
const email = s => { const m = str(s).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/); return m ? m[0] : ""; };
const isNyuEmail = e => /@([a-z0-9-]+\.)*nyu\.edu$/.test(e);
const parseCsv = text => {
  const rows = []; let row = [], c = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(c); c = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(c); rows.push(row); row = []; c = ""; }
    else c += ch;
  }
  if (c || row.length) { row.push(c); rows.push(row); }
  return rows;
};
// Agenda rows that are program items, not people.
// Firm values that aren't a firm.
const JUNK_ORG = /^(n\/?a|none|na|self|self-employed|retired|student|nyu|nyu stern|stern|-|\.|tbd|unemployed|independent|personal)$/i;
const PERSONAL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|comcast|verizon)\./;
const domainOf = e => (e.split("@")[1] || "").replace(/^(mail|email)\./, "");
const NOT_PERSON = /\b(break|lunch|breakfast|coffee|networking|reception|registration|check-in|remarks|welcome|closing|opening|q ?& ?a|tbd|tba|intermission|cocktail|happy hour|transition)\b/i;
// "JOHN SMITH" / "john smith" -> "John Smith"; mixed-case names are left alone.
const tidyName = s => (s && (s === s.toUpperCase() || s === s.toLowerCase())
  ? s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : s);
// Field values are joined with "|" in the proposal, so a "|" inside a value becomes "/".
const clean = s => str(s).replace(/\|/g, "/");
const csvCell = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DROP = /gender|dietary|accessib|address|home |zip|city|state|country|paid|fees|payment processing|order #|currency|disclosure|consent/i;

// Rows as objects keyed by header (first of the top 5 rows with 2+ filled cells). Duplicate
// header names keep the first occurrence. Sensitive columns are dropped on read.
function toObjects(values) {
  const rows = values.map(r => (r || []).map(str));
  const h = rows.slice(0, 5).findIndex(r => r.filter(Boolean).length >= 2);
  if (h === -1) return [];
  const header = rows[h];
  return rows.slice(h + 1).filter(r => r.some(Boolean)).map(r => {
    const o = {};
    header.forEach((name, i) => { if (name && !(name in o) && !DROP.test(name)) o[name] = r[i] || ""; });
    return o;
  });
}
const pick = (o, ...res) => { for (const re of res) { const k = Object.keys(o).find(k => re.test(k)); if (k && o[k]) return o[k]; } return ""; };

// Student or alumni, from account type / program / ticket / email. Returns "student", "alumni" or "".
function standing(r) {
  const type = pick(r, /^account type$/i, /^program \/ account type$/i);
  const ticket = pick(r, /^ticket type$/i), group = pick(r, /^group$/i), nyu = pick(r, /^nyu \/ external$/i);
  if (/alumni/i.test(type)) return "alumni";
  if (/mba|student|undergrad|exchange|msa|ms in|phd/i.test(type)) return "student";
  if (/student|club officers|other universit/i.test(ticket) || /other schools/i.test(group)) return "student";
  if (/^nyu$/i.test(nyu)) return "student";
  if (isNyuEmail(email(pick(r, /e-?mail/i)))) return "student";
  return "";
}
function alumniFields(r) {
  const type = pick(r, /^account type$/i, /^program \/ account type$/i);
  const prog = (type.match(/alumni \(([^)]+)\)/i) || [])[1] || "";
  const year = pick(r, /^year of graduation$/i) || (type.match(/\b(19|20)\d\d\b/) || [])[0] || "";
  const program = /full-time/i.test(prog) ? "Full-time MBA" : /part-time|langone/i.test(prog) ? "Part-time MBA"
    : /executive/i.test(prog) ? "Executive MBA" : /undergrad/i.test(prog) ? "Undergraduate" : "Other NYU";
  return { Stern_Alum: program === "Other NYU" ? "No" : "Yes", Stern_Program: program, Class_Year: year };
}

// ---------- main ----------
(async () => {
  const dir = path.dirname(process.env.GOOGLE_TOKEN_FILE);
  const listFile = path.join(dir, "srec-folder-headers.csv");
  if (!fs.existsSync(listFile)) throw new Error("Run `npm run survey` and `npm run survey:headers` first.");
  const L = parseCsv(fs.readFileSync(listFile, "utf8").replace(/^﻿/, "")).filter(r => r.length > 1);
  const files = L.slice(1).map(r => Object.fromEntries(L[0].map((h, i) => [h, r[i]])));
  const locate = (p, tab) => files.find(f => f.path.includes(p) && (!tab || f.tab === tab));

  const raw = JSON.parse(fs.readFileSync(process.env.GOOGLE_OAUTH_CLIENT_FILE, "utf8"));
  const k = raw.web || raw.installed;
  const client = new auth.OAuth2(k.client_id, k.client_secret);
  const token = JSON.parse(fs.readFileSync(process.env.GOOGLE_TOKEN_FILE, "utf8"));
  client.setCredentials(token);
  client.on("tokens", t => fs.writeFileSync(process.env.GOOGLE_TOKEN_FILE, JSON.stringify({ ...token, ...t }, null, 2), { mode: 0o600 }));
  const sh = sheets({ version: "v4", auth: client });
  const dr = drive({ version: "v3", auth: client });

  const bufCache = {};
  async function readSource(src) {
    const f = locate(src.path, src.tab);
    if (!f) throw new Error(`Source not found in survey: ${src.path} [${src.tab || ""}]`);
    let values;
    if (f.type === "Google Sheet") {
      await sleep(1100);
      values = (await sh.spreadsheets.values.get({ spreadsheetId: f.id, range: `'${f.tab.replace(/'/g, "''")}'` })).data.values || [];
    } else {
      if (!bufCache[f.id]) bufCache[f.id] = Buffer.from((await dr.files.get({ fileId: f.id, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" })).data);
      if (/\.csv$/i.test(f.path)) values = parseCsv(bufCache[f.id].toString("utf8").replace(/^﻿/, ""));
      else {
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(bufCache[f.id]);
        const ws = wb.getWorksheet(f.tab); values = [];
        ws.eachRow({ includeEmpty: true }, (row, n) => { values[n - 1] = row.values.slice(1); });
      }
    }
    return { rows: toObjects(values), file: f.path.split("/").pop(), tab: f.tab === "(csv)" ? "" : f.tab };
  }

  // Current sheet state (read only).
  const tabs = ["Contacts", "Organizations", "Events", "Panelists", "Event_Attendance"];
  const got = await sh.spreadsheets.values.batchGet({ spreadsheetId: process.env.GOOGLE_SHEET_ID, ranges: tabs.map(t => `'${t}'`) });
  const sheet = Object.fromEntries(tabs.map((t, i) => [t, toObjects(got.data.valueRanges[i].values || [])]));
  const byEmail = new Map(), byName = new Map();
  for (const c of sheet.Contacts) {
    const e = email(c.Email); if (e) byEmail.set(e, c);
    const nk = nameKey(c.First_Name, c.Last_Name); if (nk) byName.set(nk, [...(byName.get(nk) || []), c]);
  }
  const orgByKey = new Map(), orgByDomain = new Map();
  for (const o of sheet.Organizations) {
    if (o.Org_Name) orgByKey.set(orgKey(o.Org_Name), o.Org_Name);
    const d = str(o.Website).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
    if (d && o.Org_Name) orgByDomain.set(d, o.Org_Name);
  }
  const existingEvents = new Set(sheet.Events.map(e => e.Event_Name));
  const logged = (tab, ev) => new Set(sheet[tab].filter(r => r.Event_Name === ev).map(r => r.Contact_ID));

  const out = [];
  const newPeople = new Map(); // key -> proposed contact, shared across events
  const stats = {};
  const add = row => out.push(row);

  function match(p) {
    if (p.email && byEmail.has(p.email)) return { how: "email", c: byEmail.get(p.email) };
    const list = byName.get(nameKey(p.first, p.last)) || [];
    if (list.length === 1) {
      const c = list[0];
      if (!p.org || !c.Organization || orgKey(p.org) === orgKey(c.Organization) || orgKey(c.Organization).includes(orgKey(p.org)) || orgKey(p.org).includes(orgKey(c.Organization))) return { how: "name+org", c };
      return { how: "name only (different firm)", c, check: true };
    }
    if (list.length > 1) {
      const same = list.filter(c => p.org && orgKey(c.Organization) === orgKey(p.org));
      if (same.length === 1) return { how: "name+org", c: same[0] };
      return { how: "ambiguous name", c: null, check: true };
    }
    return { how: "none", c: null };
  }

  // Returns the Contact_ID (existing, or NEW-n for a proposed contact) and records proposals.
  function resolve(p, ev, src, role) {
    p = { ...p, first: clean(tidyName(p.first)), last: clean(tidyName(p.last)), title: clean(p.title), org: JUNK_ORG.test(str(p.org)) ? "" : clean(p.org) };
    const m = match(p);
    const S = stats[ev.key];
    const base = { Event: ev.name, Name: `${p.first} ${p.last}`.trim(), Organization: p.org, Title: p.title, Email: p.email, Source_File: src.file, Source_Tab: src.tab };
    if (m.c) {
      S.matched++;
      const fills = { Title: p.title, Organization: p.org, Email: p.email, ...(p.alumni || {}) };
      for (const [field, val] of Object.entries(fills)) {
        if (val && !str(m.c[field])) {
          add({ ...base, Action: "fill_blank", Target_Tab: "Contacts", Contact_ID: m.c.Contact_ID, Match: m.how, Field: field, Proposed: val, Note: m.check ? "CHECK: name matched but firm differs" : "" });
          S.fills++;
        }
      }
      if (m.check) S.checks++;
      return m.c.Contact_ID;
    }
    if (m.check) S.checks++;
    // Same new person seen in another event: same email, or same name with no conflicting
    // email and a compatible (or missing) firm.
    const nk = nameKey(p.first, p.last);
    const prior = [...newPeople.values()].find(q => (p.email && q.email === p.email) || (q.nk === nk &&
      (!p.email || !q.email || p.email === q.email) &&
      (!p.org || !q.org || orgKey(p.org) === orgKey(q.org) || orgKey(p.org).includes(orgKey(q.org)) || orgKey(q.org).includes(orgKey(p.org)))));
    if (!prior) {
      const id = `NEW-${newPeople.size + 1}`;
      const source = p.alumni && !p.org ? "Stern alumni" : role === "attendee" ? "Event attendee" : "Past panelist / speaker";
      const twin = [...newPeople.values()].find(q => q.nk === nk);
      if (twin) { m.check = true; m.how = `same name as ${twin.id} but different email or firm`; }
      const row = {};
      newPeople.set(id, { id, nk, email: p.email, org: p.org, row, p, source });
      Object.assign(row, { ...base, Action: "new_contact", Target_Tab: "Contacts", Contact_ID: id, Match: m.how,
        Field: "First_Name|Last_Name|Title|Organization|Email|Source|Owner|Stern_Alum|Stern_Program|Class_Year",
        Note: m.check ? "CHECK: " + m.how : "" });
      add(row);
      S.newContacts++;
      return id;
    }
    S.repeatNew++;
    if (!prior.email && p.email) prior.email = p.email;
    if (!prior.org && p.org) prior.org = p.org;
    return prior.id;
  }

  for (const ev of EVENTS) {
    const S = stats[ev.key] = { speakers: 0, attendeeRows: 0, students: 0, noName: 0, matched: 0, newContacts: 0, repeatNew: 0, fills: 0, checks: 0, panelists: 0, panelistsLogged: 0, attendance: 0, attendanceLogged: 0, alumni: 0 };
    if (!existingEvents.has(ev.name)) add({ Event: ev.name, Action: "new_event", Target_Tab: "Events", Field: "Event_Name|Event_Type|Date", Proposed: `${ev.name}|Conference|${ev.date}`, Note: ev.isNew ? "Not in Events yet" : "Name not found in Events: check spelling" });
    const pan = logged("Panelists", ev.name), att = logged("Event_Attendance", ev.name);
    const seen = new Set(); // per-event person keys, so the same person isn't added twice

    // Speakers
    for (const src of ev.speakers) {
      const { rows, file, tab } = await readSource(src);
      let session = "";
      for (const r of rows) {
        let p, role = "Panelist";
        if (src.kind === "agenda") {
          const name = r.Name, title = r.Title, company = r.Company;
          if (name && !title && !company) { session = name; continue; } // session header row
          if (!name || name.split(" ").length > 5 || NOT_PERSON.test(name)) continue;
          if (/[,&]| and /i.test(name)) { add({ Event: ev.name, Action: "skip", Name: name, Source_File: file, Source_Tab: tab, Note: "CHECK: several names in one cell" }); S.checks++; continue; }
          const n = splitName(name);
          p = { ...n, title: title.replace(/\(?moderator\)?/i, "").trim(), org: company, email: "" };
          role = /moderat/i.test(name + " " + title) ? "Moderator" : /keynote/i.test(session) ? "Keynote" : /fireside|remarks|welcome/i.test(session) ? "Speaker" : "Panelist";
        } else if (src.kind === "tracker") {
          if (!/^confirmed/i.test(r.Status)) continue;
          const n = splitName(r.Name);
          p = { ...n, title: /^https?:/.test(r.Role) ? "" : r.Role, org: r.Company, email: "" };
        } else { // flagged rows in a registration list
          if (!src.flag(r)) continue;
          p = { first: pick(r, /^first name$/i), last: pick(r, /^last name$/i), title: pick(r, /job title|^title$/i), org: pick(r, /organization|company/i), email: email(pick(r, /e-?mail/i)) };
        }
        if (!p.first || !p.last) { S.noName++; continue; }
        const key = nameKey(p.first, p.last);
        if (seen.has(key)) continue;
        seen.add(key); S.speakers++;
        const id = resolve(p, ev, { file, tab }, "speaker");
        const base = { Event: ev.name, Contact_ID: id, Name: `${p.first} ${p.last}`, Organization: p.org, Source_File: file, Source_Tab: tab };
        if (pan.has(id)) S.panelistsLogged++;
        else { add({ ...base, Action: "panelist", Target_Tab: "Panelists", Field: "Panel_Title|Role", Proposed: `${session}|${role}` }); S.panelists++; }
        if (!att.has(id)) { add({ ...base, Action: "attendance", Target_Tab: "Event_Attendance", Field: "Role|Registered|Attended", Proposed: `${role}|Yes|Unknown` }); S.attendance++; }
      }
    }

    // Attendees
    for (const src of ev.attendees) {
      const { rows, file, tab } = await readSource(src);
      for (const r of rows) {
        S.attendeeRows++;
        if (/not coming|not registered/i.test(pick(r, /payment status|^status$/i))) continue;
        const p = { first: pick(r, /^first name$/i), last: pick(r, /^last name$/i), title: pick(r, /job title|work title/i), org: pick(r, /^organization$|company name/i), email: email(pick(r, /e-?mail/i)) };
        if (!p.first || !p.last) { S.noName++; continue; }
        const st = standing(r);
        if (st === "student") { S.students++; continue; }
        if (st === "alumni") { p.alumni = alumniFields(r); S.alumni++; }
        const key = nameKey(p.first, p.last);
        if (seen.has(key)) continue; // already a speaker or listed in another export
        seen.add(key);
        const id = resolve(p, ev, { file, tab }, "attendee");
        if (att.has(id)) { S.attendanceLogged++; continue; }
        add({ Event: ev.name, Action: "attendance", Target_Tab: "Event_Attendance", Contact_ID: id, Name: `${p.first} ${p.last}`, Organization: p.org, Source_File: file, Source_Tab: tab, Field: "Role|Registered|Attended", Proposed: "Attendee|Yes|Unknown" });
        S.attendance++;
      }
    }
  }

  // Place each new contact in a queue now that all events are read (a later event may supply
  // the firm or email). Firm: named firm, or email domain of a firm already in Organizations.
  const eventsOf = new Map();
  for (const r of out) if ((r.Action === "attendance" || r.Action === "panelist") && /^NEW-/.test(r.Contact_ID)) {
    const set = eventsOf.get(r.Contact_ID) || new Set(); set.add(r.Event); eventsOf.set(r.Contact_ID, set);
  }
  const queues = { Firm: 0, Unaffiliated: 0 }, firmStatus = { "existing firm": 0, "firm not in Organizations yet": 0, "firm from email domain": 0 };
  for (const n of newPeople.values()) {
    const p = { ...n.p, email: n.email || n.p.email, org: n.org || n.p.org };
    const d = domainOf(p.email), personal = !d || PERSONAL.test(d) || /\.edu$/.test(d);
    let org = p.org, how = "";
    if (org) { const known = orgByKey.get(orgKey(org)); if (known) { org = known; how = "existing firm"; } else how = "firm not in Organizations yet"; }
    else if (!personal && orgByDomain.has(d)) { org = orgByDomain.get(d); how = "firm from email domain"; }
    const queue = org ? "Firm" : "Unaffiliated";
    queues[queue]++; if (how) firmStatus[how]++;
    Object.assign(n.row, {
      Queue: queue, Organization: org, Email: p.email,
      Suggested_Org: !org && !personal ? d : "",
      Events: [...(eventsOf.get(n.id) || [])].join("; "),
      Proposed: [p.first, p.last, p.title, org, p.email, n.source, "", ...(p.alumni ? [p.alumni.Stern_Alum, p.alumni.Stern_Program, p.alumni.Class_Year] : ["", "", ""])].join("|"),
      Note: [n.row.Note, how, !p.email ? "no email" : "", personal && p.email && !/\.edu$/.test(d) ? "personal email" : ""].filter(Boolean).join("; "),
    });
  }

  const stamp = new Date().toLocaleDateString("en-CA");
  const file = path.join(dir, `enrichment-dryrun-${stamp}.csv`);
  const cols = ["Event", "Action", "Queue", "Target_Tab", "Contact_ID", "Match", "Name", "Organization", "Suggested_Org", "Title", "Email", "Events", "Field", "Proposed", "Note", "Source_File", "Source_Tab"];
  fs.writeFileSync(file, "﻿" + [cols.join(","), ...out.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\r\n"), "utf8");

  console.log("DRY RUN: nothing was written to the sheet.\n");
  console.table(Object.fromEntries(EVENTS.map(ev => {
    const S = stats[ev.key];
    return [ev.key, {
      "speakers found": S.speakers, "new Panelists rows": S.panelists, "panelists already logged": S.panelistsLogged,
      "attendee rows read": S.attendeeRows, "students skipped": S.students, "alumni kept": S.alumni,
      "new attendance rows": S.attendance, "attendance already logged": S.attendanceLogged,
      "matched contacts": S.matched, "new contacts": S.newContacts, "blank fields to fill": S.fills, "need a check": S.checks,
    }];
  })));
  const actions = out.reduce((m, r) => (m[r.Action] = (m[r.Action] || 0) + 1, m), {});
  console.log("Proposed changes by type:", actions);
  console.log(`Unique new contacts across all four events: ${newPeople.size}`);
  console.log("  by queue:", queues);
  console.log("  firm:", firmStatus);
  console.log(`\nFull proposal (names included) saved privately to:\n  ${file}`);
})().catch(err => { console.error("Dry run failed:", String(err.message || err)); process.exit(1); });

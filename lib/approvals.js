// Chen Institute approvals. Every decision is one row in the Approval_Log tab:
//   Date | Time | Contact_ID | Contact | Tag (Outreach/Sponsorship) | Decision (Yes/No) | Note | Decided_By
// A contact's current status for a tag is its newest row (rows are appended in order).
// Before anyone has decided in the app, Outreach falls back to the sheet's Approval column.
const TAGS = ["Outreach", "Sponsorship"];
const DECISIONS = ["Yes", "No"];

// The sheet's Approval column (real sheet: Yes/No; sample: Approved/Pending/Do Not Contact).
function fromSheetApproval(value) {
  if (/^(yes|approved)$/i.test(value || "")) return "Yes";
  if (/^(no|do not contact)$/i.test(value || "")) return "No";
  return "";
}

// Adds an `Approvals` object to each contact: { Outreach: {Decision, Date, By, Note, From}, Sponsorship: {...} }
// and keeps `Approval` in step with the newest Outreach decision, so every existing badge and filter follows it.
function withApprovals(data) {
  const latest = new Map(); // "C001|Outreach" -> row
  for (const r of data.Approval_Log || []) {
    if (TAGS.includes(r.Tag) && DECISIONS.includes(r.Decision)) latest.set(`${r.Contact_ID}|${r.Tag}`, r);
  }
  const Contacts = data.Contacts.map(c => {
    const ids = [c.Contact_ID, ...(c.Alt_IDs || [])];
    const pick = tag => ids.map(id => latest.get(`${id}|${tag}`)).filter(Boolean)
      .sort((a, b) => `${b.Date} ${b.Time}`.localeCompare(`${a.Date} ${a.Time}`))[0];
    const approvals = {};
    for (const tag of TAGS) {
      const r = pick(tag);
      if (r) approvals[tag] = { Decision: r.Decision, Date: r.Date, By: r.Decided_By, Note: r.Note, From: "app" };
      else if (tag === "Outreach" && fromSheetApproval(c.Approval)) approvals[tag] = { Decision: fromSheetApproval(c.Approval), From: "sheet" };
      else approvals[tag] = { Decision: "" };
    }
    const out = { ...c, Approvals: approvals };
    if (approvals.Outreach.From === "app") out.Approval = approvals.Outreach.Decision;
    return out;
  });
  return { ...data, Contacts };
}

module.exports = { TAGS, DECISIONS, withApprovals };

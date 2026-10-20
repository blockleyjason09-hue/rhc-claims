/* Reading Hockey Club Claims — website logic.
   Talks to Supabase (login, database, receipt storage). Every rule about who can
   approve or pay is enforced by the database itself (see supabase/schema.sql). */
(function () {
"use strict";
const CFG = window.RHC_CONFIG || {};
const CLUB = CFG.clubName || "Reading Hockey Club";
const DEFAULT_AREAS = ["Coaching","Umpiring","Performance travel","Equipment","Pitch hire","Tournaments & events","Other"];
const TYPES = {
  expense:{label:"Out-of-pocket expense",short:"Expense",blurb:"You paid for something on the club's behalf and want it back.",attach:true,attachHint:"Upload a receipt for every item (photo or PDF).",
    cols:[{k:"date",l:"Date",t:"date"},{k:"item",l:"What was bought",t:"text"},{k:"supplier",l:"Supplier",t:"text",optional:true},{k:"amount",l:"Amount £",t:"money"}]},
  invoice:{label:"Coaching / umpiring invoice",short:"Invoice",blurb:"You're self-employed and invoice the club: hours, mileage, retainer or other costs.",attach:true,attachHint:"Upload your invoice (PDF preferred).",
    cols:[{k:"date",l:"Date",t:"date"},{k:"activity",l:"Activity",t:"activity"},{k:"session",l:"Session / match",t:"text"},{k:"hours",l:"Hours",t:"num"},{k:"rate",l:"Rate £/hr",t:"rate"},{k:"_amt",l:"Amount",t:"calc"}]},
  payroll:{label:"Coaching / umpiring payroll",short:"Payroll",blurb:"You're paid through club payroll: hours, mileage, retainer or other costs.",attach:false,
    cols:[{k:"date",l:"Date",t:"date"},{k:"activity",l:"Activity",t:"activity"},{k:"session",l:"Session / match",t:"text"},{k:"hours",l:"Hours",t:"num"},{k:"rate",l:"Rate £/hr",t:"rate"},{k:"_amt",l:"Amount",t:"calc"}]},
  mileage:{label:"Mileage",short:"Mileage",blurb:"You drove your own vehicle for club business.",attach:false,
    cols:[{k:"date",l:"Date",t:"date"},{k:"from",l:"From",t:"text"},{k:"to",l:"To",t:"text"},{k:"purpose",l:"Purpose",t:"text"},{k:"miles",l:"Miles (one way)",t:"num"},{k:"ret",l:"Return",t:"check"},{k:"chargeable_miles",l:"Claimable miles",t:"chg"},{k:"_amt",l:"Amount",t:"calc"}]}
};
TYPES.supplier = {label:"Supplier invoice",short:"Supplier",blurb:"Log an invoice from an external provider, such as a physio or pitch hire.",attach:true,attachHint:"Upload the supplier's invoice (PDF preferred).",
  cols:[{k:"item",l:"Description",t:"text"},{k:"net",l:"Amount £",t:"money"}],
  vatCols:[{k:"item",l:"Description",t:"text"},{k:"net",l:"Net £",t:"money"},{k:"vat_rate",l:"VAT rate",t:"vatrate"},{k:"vat",l:"VAT £",t:"vatcalc"},{k:"_amt",l:"Gross £",t:"calc"}]};
const colsFor = (t, vat) => (vat && TYPES[t].vatCols) ? TYPES[t].vatCols : TYPES[t].cols;
const DISPLAY_ONLY = ["calc","rate","chg","vatcalc"];
const NUMERIC_COLS = ["calc","money","num","rate","chg","vatcalc"];
const lineVat = l => l.vat_rate === "" || l.vat_rate == null ? Math.round(num(l.net) * 20) / 100 : Math.round(num(l.net) * num(l.vat_rate)) / 100;
const fmtSort = v => { v = String(v || "").replace(/\D/g, ""); return v.length === 6 ? v.slice(0,2) + "-" + v.slice(2,4) + "-" + v.slice(4) : v; };
const STATUS = {
  pending:{label:"Awaiting 1st approval",cls:"pending"},
  first_approved:{label:"Awaiting 2nd approval",cls:"pending"},
  approved:{label:"With bookkeeper",cls:"approved"},
  returned:{label:"Returned",cls:"returned"},
  processed:{label:"Paid",cls:"processed"},
  withdrawn:{label:"Withdrawn",cls:"withdrawn"}
};

const S = {sb:null,user:null,me:null,settings:{mileage_rate:null,budget_areas:DEFAULT_AREAS},claims:[],people:{},names:{},banks:{},payees:{},myBank:null,viewAsCoach:false,
  tab:null,draft:null,authView:"signin",authMsg:"",recovery:false,lastSubmitted:null,decideOpen:null,confirmWithdraw:null,
  bkFilter:"ready",bk:{month:"",type:"",area:"",section:"",q:"",sort:"new"},editingDetails:false,channel:null,loaded:false};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const gbp = n => "£" + (Math.round(num(n) * 100) / 100).toLocaleString("en-GB", {minimumFractionDigits:2, maximumFractionDigits:2});
const fmtH = n => (Math.round(num(n) * 100) / 100).toLocaleString("en-GB") + " h";
const fmtDate = s => { if (!s) return ""; const d = new Date(s); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-GB", {day:"numeric", month:"short", year:"numeric"}); };
const isoDay = s => (s || "").slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3200); }
function errText(e, fallback){ const m = e && (e.message || e.error_description); return m ? m.replace(/^.*?:\s*(?=[A-Z])/,"") : (fallback || "Something went wrong. Try again."); }
function personName(id){ const p = S.people[id]; return (p && p.full_name) || S.names[id] || "Club member"; }
function headline(c){ return c.type === "payroll" && !num(c.total) ? fmtH(c.hours) : gbp(c.total); }

/* ---------- roles ---------- */
const coachView = () => !!S.viewAsCoach;
const types = () => coachView() ? [] : ((S.me && S.me.approver_types) || []);
const sections = () => Array.isArray(S.settings.sections) ? S.settings.sections : [];
const sectionLabel = k => ((sections().find(x => x.key === k) || {}).label) || "";
const myCaptain = () => coachView() ? [] : ((S.me && S.me.captain_sections) || []);
const isFinance = () => !coachView() && !!(S.me && S.me.is_finance);
const sectionHasCaptain = k => Object.values(S.people).some(p => p.active && (p.captain_sections || []).includes(k));
const isApproverAny = () => myCaptain().length > 0 || isFinance();
function canFirstApprove(c){ return c.status === "pending" && !!c.section && (myCaptain().includes(c.section) || (isFinance() && !sectionHasCaptain(c.section))); }
function canSecondApprove(c){ return c.status === "first_approved" && isFinance() && c.first_approver !== S.me.id; }
const isBookkeeper = () => !coachView() && !!(S.me && S.me.is_bookkeeper);
const isAdmin = () => !coachView() && !!(S.me && S.me.is_admin);
const canLogSuppliers = () => !coachView() && !!(S.me && (S.me.is_admin || S.me.is_bookkeeper || S.me.can_log_suppliers));
function myRoles(){ const r = ["Coach"]; if (myCaptain().length) r.push("Captain"); if (isFinance()) r.push("Finance"); if (isBookkeeper()) r.push("Bookkeeper"); if (isAdmin()) r.push("Admin"); return r; }
function toApprove(){ return S.claims.filter(c => canFirstApprove(c) || canSecondApprove(c)); }
const readyToPay = () => S.claims.filter(c => c.status === "approved");
const pendingPeople = () => Object.values(S.people).filter(p => !p.active);
function homeTab(){
  if (isApproverAny() && toApprove().length) return "approve";
  if (isBookkeeper() && readyToPay().length) return "books";
  return S.claims.some(c => c.claimant === S.me.id) ? "mine" : "new";
}

/* ---------- calculations (display only; the database recalculates) ---------- */
function hourlyRate(activity){
  const k = activity === "Umpiring" ? "umpiring_rate" : "coaching_rate";
  const own = S.me && S.me[k], club = S.settings && S.settings[k];
  return own != null ? num(own) : club != null ? num(club) : null;
}
function missingRates(d){
  if (!d || !["invoice","payroll"].includes(d.type)) return [];
  const acts = [...new Set(d.lines.map(l => l.activity === "Umpiring" ? "Umpiring" : "Coaching"))];
  return acts.filter(a => hourlyRate(a) == null);
}
function mileageRules(src){
  const s = src || S.settings || {};
  return {rate: s.rate != null ? num(s.rate) : num(s.mileage_rate),
    free: s.free_miles != null ? num(s.free_miles) : (s.mileage_free_miles == null ? 50 : num(s.mileage_free_miles)),
    prate: 0,
    basis: s.basis || s.mileage_free_basis || "journey"};
}
function mileageLines(lines){
  const R = mileageRules(); let left = R.free;
  return lines.map(l => {
    const m = num(l.miles) * (l.ret ? 2 : 1);
    let ch; if (R.basis === "claim"){ ch = Math.max(0, m - left); left = Math.max(0, left - m); } else ch = Math.max(0, m - R.free);
    const pax = Math.max(0, Math.floor(num(l.passengers)));
    return {m, ch, amt: Math.round(ch * (R.rate + pax * R.prate) * 100) / 100};
  });
}
function rulesText(src){
  const R = mileageRules(src), pence = v => Math.round(v * 100) + "p";
  return `Mileage is paid at ${pence(R.rate)} a mile. ${R.free ? `The first ${R.free.toLocaleString("en-GB")} miles of each ${R.basis === "claim" ? "claim" : "journey (a return trip counts as one journey)"} aren't claimable. ` : ""}`;
}
/* ---------- payroll / invoice: mixed lines ---------- */
const ITEMS = {coaching:"Coaching hours", umpiring:"Umpiring", mileage:"Mileage", retainer:"Coaching retainer", other:"Other cost", activity:"Hours"};
const ACT_GROUPS = ["Junior coaching","Senior coaching","Programmes","Umpiring","Schools","Club duties"];
const acts = () => Array.isArray(S.settings.payroll_activities) ? S.settings.payroll_activities : [];
const actByKey = k => acts().find(a => a.key === k) || null;
const itemLabel = l => lineItem(l) === "activity" ? (l.activity || (actByKey(l.activity_key) || {}).label || "Hours") : ITEMS[lineItem(l)];
function activityRate(key){
  const a = actByKey(key); if (!a) return null;
  const mine = S.me && S.me.activity_rates && S.me.activity_rates[key];
  return blank(mine) ? null : num(mine);
}
const isMixed = t => t === "invoice" || t === "payroll";
const lineItem = l => l.item || (l.activity === "Umpiring" ? "umpiring" : "coaching");
const ownRates = () => !!(S.me && S.me.own_rates);
const blank = v => v == null || String(v).trim() === "";
const perSeason = () => !!(S.me && S.me.retainer_period === "season");
const seasonLabel = s => s ? s.replace("-", "–") : "";
function seasonOptions(){
  const n = new Date(), y = n.getMonth() >= 8 ? n.getFullYear() : n.getFullYear() - 1, f = a => `${a}-${String((a + 1) % 100).padStart(2, "0")}`;
  return [f(y - 1), f(y), f(y + 1)];
}
function claimedSeasons(exceptId){
  const out = new Set();
  for (const c of S.claims) if (S.me && c.claimant === S.me.id && c.status !== "withdrawn" && c.id !== exceptId) for (const l of (c.lines || [])) if (l.item === "retainer" && l.season) out.add(l.season);
  return out;
}
function itemRate(it, l){
  if (it === "activity") return ownRates() ? (num(l.rate) > 0 ? num(l.rate) : null) : activityRate(l.activity_key);
  if (it === "coaching" || it === "umpiring") return ownRates() ? (num(l.rate) > 0 ? num(l.rate) : null) : hourlyRate(it === "umpiring" ? "Umpiring" : "Coaching");
  if (it === "retainer"){ if (ownRates() && !blank(l.rate)) return num(l.rate); return S.me && S.me.retainer_amount != null ? num(S.me.retainer_amount) : null; }
  return null;
}
function mixedAmounts(lines){
  const R = mileageRules(); let left = R.free;
  return lines.map(l => {
    const it = lineItem(l);
    if (it === "mileage"){
      const m = num(l.miles) * (l.ret ? 2 : 1); let ch;
      if (R.basis === "claim"){ ch = Math.max(0, m - left); left = Math.max(0, left - m); } else ch = Math.max(0, m - R.free);
      const pax = Math.max(0, Math.floor(num(l.passengers)));
      return {it, m, ch, h:0, amt: Math.round(ch * (R.rate + pax * R.prate) * 100) / 100};
    }
    if (it === "coaching" || it === "umpiring" || it === "activity") return {it, m:0, ch:0, h:num(l.hours), amt: Math.round(num(l.hours) * num(itemRate(it, l)) * 100) / 100};
    if (it === "retainer") return {it, m:0, ch:0, h:0, amt: Math.round((perSeason() ? 1 : (num(l.qty) || 1)) * num(itemRate(it, l)) * 100) / 100};
    return {it, m:0, ch:0, h:0, amt: Math.round(num(l.amount) * 100) / 100};
  });
}
function rateProblems(d){
  if (!d || !isMixed(d.type)) return [];
  const used = new Set(d.lines.map(lineItem)), out = [];
  if (!ownRates()){
    if (used.has("coaching") && hourlyRate("Coaching") == null) out.push("Your coaching rate hasn't been set yet. Ask the club admin to add it.");
    if (used.has("umpiring") && hourlyRate("Umpiring") == null) out.push("Your umpiring rate hasn't been set yet. Ask the club admin to add it.");
    if (used.has("retainer") && (!S.me || S.me.retainer_amount == null)) out.push("Your coaching retainer hasn't been set yet. Ask the club admin to add it.");
    for (const k of new Set(d.lines.filter(l => lineItem(l) === "activity" && l.activity_key).map(l => l.activity_key))) if (activityRate(k) == null) out.push(`You don't have a rate for ${(actByKey(k) || {}).label || "that heading"} yet. Ask the club admin to add it in People.`);
  }
  if (used.has("mileage") && S.settings.mileage_rate == null) out.push("The club mileage rate hasn't been set yet. The club admin sets it in Settings.");
  return out;
}
function ratesNotice(type){
  if (type === "payroll"){
    const me = S.me || {}, ret = me.retainer_amount != null ? gbp(me.retainer_amount) + (perSeason() ? " a season, claimed once per season" : " a month") : null;
    return (ownRates() ? "You set your own rates: enter your hourly rate on each line." : "Pick the timesheet heading for each line. Your hourly rate for that heading is set by the club and shows on the line.")
      + (ret ? ` Your retainer is ${ret}.` : "") + (S.settings.mileage_rate != null ? " " + rulesText() : "");
  }
  const me = S.me || {}, ret = me.retainer_amount != null ? gbp(me.retainer_amount) + (perSeason() ? " a season, claimed once per season" : " a month") : null;
  const club = ownRates() ? `You set your own rates: enter your hourly rate on each coaching or umpiring line${ret ? `. Your retainer is ${ret} unless you enter a different amount` : ", and your retainer amount on a retainer line"}.`
    : `Your rates are set by the club: coaching ${hourlyRate("Coaching") != null ? gbp(hourlyRate("Coaching")) + "/hr" : "not set"}, umpiring ${hourlyRate("Umpiring") != null ? gbp(hourlyRate("Umpiring")) + "/hr" : "not set"}${ret ? `, retainer ${ret}` : ""}.`;
  return club + (S.settings.mileage_rate != null ? " " + rulesText() : "");
}
function mixedRow(l, i, total){
  const it = lineItem(l), id = k => `ln-${i}-${k}`, v = k => esc(l[k] == null ? "" : l[k]);
  const inp = (k, cap, type, cls, extra, ph) => `<label class="fld ${cls || ""}"><span>${esc(cap)}</span><input id="${id(k)}" type="${type || "text"}" data-line="${i}" data-k="${k}" value="${v(k)}" placeholder="${esc(ph || "")}" ${extra || ""}></label>`;
  const numIn = (k, cap, step, cls, ph) => inp(k, cap, "number", cls || "w-xs", `step="${step}" min="0" inputmode="decimal"`, ph);
  const rateTxt = (r, unit) => `<span class="sub rate-tag">${r == null ? "rate not set" : "@ " + gbp(r) + unit}</span>`;
  let f = "";
  if (it === "activity") f = inp("session", "Comment", "text", "wide", "", "Age group, training, home or away match") + numIn("hours", "Hours", "0.25") + (ownRates() ? numIn("rate", "Your rate £/hr", "0.01", "w-s") : rateTxt(itemRate(it, l), "/hr"));
  else if (it === "coaching" || it === "umpiring") f = inp("session", it === "umpiring" ? "Match" : "Session") + numIn("hours", "Hours", "0.25") + (ownRates() ? numIn("rate", "Your rate £/hr", "0.01", "w-s") : rateTxt(itemRate(it, l), "/hr"));
  else if (it === "mileage") f = inp("from", "From") + inp("to", "To") + inp("purpose", "Purpose") + numIn("miles", "Miles one way", "1", "w-s") + `<label class="chk"><input type="checkbox" id="${id("ret")}" data-line="${i}" data-k="ret" ${l.ret ? "checked" : ""}> Return</label>` + `<span class="sub rate-tag" id="${id("ch")}"></span>`;
  else if (it === "retainer" && perSeason()){ const done = claimedSeasons(S.draft && S.draft.editingId);
    f = `<label class="fld w-s"><span>Season</span><select id="${id("season")}" data-line="${i}" data-k="season"><option value="">Choose…</option>${seasonOptions().map(o => `<option value="${o}" ${l.season === o ? "selected" : ""} ${done.has(o) && l.season !== o ? "disabled" : ""}>${seasonLabel(o)}${done.has(o) ? " (claimed)" : ""}</option>`).join("")}</select></label>`
      + inp("description", "Note (optional)", "text", "", "", "e.g. Season retainer") + (ownRates() ? numIn("rate", "Amount £/season", "0.01", "w-s", S.me && S.me.retainer_amount != null ? String(S.me.retainer_amount) : "") : rateTxt(itemRate(it, l), "/season")); }
  else if (it === "retainer") f = inp("description", "Which month", "text", "", "", "e.g. November retainer") + numIn("qty", "Months", "1", "w-xs", "1") + (ownRates() ? numIn("rate", "Amount £/month", "0.01", "w-s", S.me && S.me.retainer_amount != null ? String(S.me.retainer_amount) : "") : rateTxt(itemRate(it, l), "/month"));
  else f = inp("description", "What it's for", "text", "", "", "e.g. Coaching course fee") + numIn("amount", "Amount £", "0.01", "w-s");
  return `<tr><td class="cap"><input id="${id("date")}" type="date" data-line="${i}" data-k="date" value="${v("date")}" aria-label="Date"></td>
    <td class="cap">${itemSelect(l, i)}</td>
    <td><div class="lineflds">${f}</div></td><td class="num calc capnum" id="${id("_amt")}">–</td>
    <td class="cap"><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove line" ${total < 2 ? "disabled" : ""}>✕</button></td></tr>`;
}
function itemSelect(l, i){
  const it = lineItem(l), payroll = !!(S.draft && isMixed(S.draft.type));
  if (!payroll) return `<select id="ln-${i}-item" data-line="${i}" data-k="item" aria-label="What you're claiming">${Object.entries(ITEMS).filter(([k]) => k !== "activity").map(([k, lab]) => `<option value="${k}" ${k === it ? "selected" : ""}>${lab}</option>`).join("")}</select>`;
  const cur = it === "activity" ? "a:" + (l.activity_key || "") : it;
  const groups = ACT_GROUPS.concat([...new Set(acts().map(a => a.group))].filter(g => !ACT_GROUPS.includes(g)));
  const opt = (v, lab) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(lab)}</option>`;
  return `<select id="ln-${i}-item" data-line="${i}" data-k="item" aria-label="Timesheet heading">${it === "activity" && !l.activity_key ? `<option value="a:" selected>Choose…</option>` : ""}${groups.map(g => { const list = acts().filter(a => (a.group || "Other") === g); return list.length ? `<optgroup label="${esc(g)}">${list.map(a => opt("a:" + a.key, a.label)).join("")}</optgroup>` : ""; }).join("")}<optgroup label="Other items">${opt("mileage", "Mileage")}${opt("retainer", "Coaching retainer")}${opt("other", "Other cost (£)")}</optgroup></select>`;
}
function mixedDetail(l){
  const it = lineItem(l);
  if (it === "mileage") return `${l.from || ""} to ${l.to || ""}${l.ret ? " and return" : ""}${l.purpose ? " – " + l.purpose : ""}`;
  if (it === "coaching" || it === "umpiring" || it === "activity") return l.session || "";
  if (it === "retainer" && l.season) return `Season ${seasonLabel(l.season)}${l.description ? " – " + l.description : ""}`;
  return l.description || "";
}
function mixedQty(l){
  const it = lineItem(l);
  if (it === "mileage") return `${num(l.chargeable_miles)} of ${num(l.miles) * (l.ret ? 2 : 1)} mi`;
  if (it === "coaching" || it === "umpiring" || it === "activity") return fmtH(l.hours);
  if (it === "retainer"){ if (l.period === "season" || l.season) return "1 season"; const q = num(l.qty) || 1; return `${q} month${q > 1 ? "s" : ""}`; }
  return "";
}
function mixedRate(l){
  const it = lineItem(l);
  if (it === "mileage") return num(l.chargeable_miles) > 0 ? `${Math.round(num(l.amount) / num(l.chargeable_miles) * 100)}p/mi` : (l.rate != null ? `${Math.round(num(l.rate) * 100)}p/mi` : "");
  if (it === "coaching" || it === "umpiring" || it === "activity") return l.rate != null ? gbp(l.rate) + "/hr" : "";
  if (it === "retainer") return l.rate != null ? gbp(l.rate) + (l.period === "season" || l.season ? "/season" : "/month") : "";
  return "";
}
function lineAmount(type, l, rate){
  if (type === "expense") return num(l.amount);
  if (type === "supplier") return Math.round((num(l.net) + (S.draft && S.draft.vat_invoice ? lineVat(l) : 0)) * 100) / 100;
  if (type === "invoice" || type === "payroll") return num(l.hours) * num(hourlyRate(l.activity));
  if (type === "mileage") return num(l.miles) * (l.ret ? 2 : 1) * num(rate);
  return 0;
}
function totals(type, lines, rate){
  let amount = 0, hours = 0, miles = 0;
  if (type === "mileage"){ const ml = mileageLines(lines); let ch = 0; for (const x of ml){ amount += x.amt; miles += x.m; ch += x.ch; } return {amount: Math.round(amount * 100) / 100, hours, miles, chargeable: ch}; }
  if (type === "supplier"){ let net = 0, vat = 0; const v = S.draft && S.draft.vat_invoice; for (const l of lines){ net += num(l.net); if (v) vat += lineVat(l); } net = Math.round(net * 100) / 100; vat = Math.round(vat * 100) / 100; return {amount: Math.round((net + vat) * 100) / 100, net, vat, hours, miles}; }
  for (const l of lines){ amount += lineAmount(type, l, rate); hours += num(l.hours); miles += num(l.miles) * (l.ret ? 2 : 1); }
  return {amount: Math.round(amount * 100) / 100, hours, miles};
}

/* ---------- header and tabs ---------- */
function tabsList(){
  if (!S.me || !S.me.active) return [];
  const t = [{id:"new",l:"New claim"},{id:"mine",l:"My claims"}];
  if (isApproverAny()) t.push({id:"approve",l:"To approve",n:toApprove().length});
  if (isBookkeeper() || isAdmin()) t.push({id:"books",l:"Bookkeeper",n:readyToPay().length});
  if (isAdmin()){ t.push({id:"people",l:"People",n:pendingPeople().length}); t.push({id:"settings",l:"Settings"}); }
  return t;
}
function renderHeader(){
  $("#clubTitle").textContent = CLUB + " · Claims";
  const list = tabsList();
  if (list.length && !list.some(t => t.id === S.tab)) S.tab = list[0].id;
  $("#tabs").innerHTML = list.map(t => `<button role="tab" data-act="tab" data-tab="${t.id}" aria-selected="${S.tab === t.id}">${esc(t.l)}${t.n ? `<span class="count">${t.n}</span>` : ""}</button>`).join("");
  $("#who").innerHTML = S.user ? `<span>${esc((S.me && S.me.full_name) || S.user.email)}</span>${S.me && S.me.active ? myRoles().map(r => `<span class="role">${esc(r)}</span>`).join("") : ""}${S.me && S.me.active && S.me.is_admin ? `<button class="signout" data-act="coach-view">${coachView() ? "Exit coach view" : "View as coach"}</button>` : ""}${S.me && S.me.active ? `<button class="signout" data-act="edit-details">My account</button>` : ""}<button class="signout" data-act="signout">Sign out</button>` : "";
}
function render(){
  renderHeader();
  const m = $("#main");
  if (S.recovery) { m.innerHTML = viewAuth("reset"); return; }
  if (!S.user) { m.innerHTML = viewAuth(S.authView); return; }
  if (!S.loaded) { m.innerHTML = `<div class="panel"><h2>Loading your claims</h2></div>`; return; }
  if (!S.me) { m.innerHTML = `<div class="panel"><h2>Account problem</h2><p class="lede">Your login worked, but your club profile is missing. Ask the club admin to check the setup.</p></div>`; return; }
  if (!S.me.active) { m.innerHTML = viewInactive(); return; }
  const v = {new:viewNew, mine:viewMine, approve:viewApprove, books:viewBooks, people:viewPeople, settings:viewSettings}[S.tab] || viewNew;
  m.innerHTML = (coachView() ? `<div class="notice ok row"><span style="flex:1"><strong>Coach view.</strong> You're seeing the site as a coach would: only New claim and My claims, with only your own claims.</span><button class="btn small" data-act="coach-view">Back to admin view</button></div>` : "") + (S.me.accepted_terms_at ? "" : `<div class="notice warn row"><span style="flex:1">Please read the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a> and <a href="terms.html" target="_blank" rel="noopener">terms of use</a> for the claims system.</span><button class="btn small primary" data-act="accept-terms">I've read and accept them</button></div>`) + v();
  if (S.tab === "new") recalc();
}
/* Refresh after live changes, without wiping a form someone is filling in */
function liveRender(){
  if (S.tab === "new" || S.tab === "settings") { renderHeader(); return; }
  const a = document.activeElement;
  if (a && a.matches("textarea,input,select") && a.closest("#main")) { renderHeader(); return; }
  render();
}

/* ---------- sign in / sign up ---------- */
function viewAuth(v){
  const msg = S.authMsg ? `<div class="notice ok">${esc(S.authMsg)}</div>` : "";
  const err = `<div class="notice bad" id="aErr" hidden></div>`;
  let body = "";
  if (v === "signin") body = `<h2>Sign in</h2><p class="lede">Submit claims and see where they are in the approval process.</p>${msg}
    <form data-form="signin" novalidate>
      <label>Email<input id="aEmail" type="email" autocomplete="email" required></label>
      <label>Password<input id="aPass" type="password" autocomplete="current-password" required></label>
      ${err}<button class="btn primary" type="submit">Sign in</button>
    </form>
    <div class="row" style="justify-content:space-between"><button class="link" data-act="auth" data-v="signup">Create an account</button><button class="link" data-act="auth" data-v="forgot">Forgot your password?</button></div>`;
  else if (v === "signup") body = `<h2>Create your account</h2><p class="lede">The club admin activates new accounts before you can submit claims.</p>
    <form data-form="signup" novalidate>
      <label>Full name<input id="aName" autocomplete="name" required></label>
      <label>Email<input id="aEmail" type="email" autocomplete="email" required></label>
      <label>Club role <span class="hint">e.g. U14 girls coach, umpire, treasurer</span><input id="aRole"></label>
      <label>Password <span class="hint">At least 8 characters</span><input id="aPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="aTerms"> <span>I've read the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a> and agree to the <a href="terms.html" target="_blank" rel="noopener">terms of use</a>.</span></label>
      ${err}<button class="btn primary" type="submit">Create account</button>
    </form>
    <button class="link" data-act="auth" data-v="signin">I already have an account</button>`;
  else if (v === "forgot") body = `<h2>Reset your password</h2><p class="lede">We'll email you a link to set a new password.</p>${msg}
    <form data-form="forgot" novalidate>
      <label>Email<input id="aEmail" type="email" autocomplete="email" required></label>
      ${err}<button class="btn primary" type="submit">Send reset link</button>
    </form>
    <button class="link" data-act="auth" data-v="signin">Back to sign in</button>`;
  else if (v === "reset") body = `<h2>Choose a new password</h2>
    <form data-form="reset" novalidate>
      <label>New password <span class="hint">At least 8 characters</span><input id="aPass" type="password" autocomplete="new-password" minlength="8" required></label>
      <label>Confirm new password<input id="aPass2" type="password" autocomplete="new-password" required></label>
      ${err}<button class="btn primary" type="submit">Save new password</button>
    </form>`;
  return `<section class="panel authwrap">${body}</section>`;
}
function showAuthErr(t){ const b = $("#aErr"); if (b){ b.textContent = t; b.hidden = false; } }
async function handleAuth(form){
  const btn = form.querySelector("button[type=submit]"); btn.disabled = true;
  const email = ($("#aEmail") || {}).value, pass = ($("#aPass") || {}).value;
  try {
    if (form.dataset.form === "signin"){
      const {error} = await S.sb.auth.signInWithPassword({email: email.trim(), password: pass});
      if (error) throw error;
    } else if (form.dataset.form === "signup"){
      const name = $("#aName").value.trim();
      if (!name) throw new Error("Add your full name.");
      if ((pass || "").length < 8) throw new Error("Use a password of at least 8 characters.");
      if (!$("#aTerms").checked) throw new Error("Tick the box to confirm you've read the privacy notice and terms.");
      const {data, error} = await S.sb.auth.signUp({email: email.trim(), password: pass,
        options: {data: {full_name: name, club_role: $("#aRole").value.trim(), accepted_terms: true}, emailRedirectTo: location.origin + location.pathname}});
      if (error) throw error;
      if (!data.session){ S.authView = "signin"; S.authMsg = "Check your email and click the confirmation link, then sign in here."; render(); }
    } else if (form.dataset.form === "forgot"){
      const {error} = await S.sb.auth.resetPasswordForEmail(email.trim(), {redirectTo: location.origin + location.pathname});
      if (error) throw error;
      S.authMsg = "If that email has an account, a reset link is on its way."; render();
    } else if (form.dataset.form === "reset"){
      if ((pass || "").length < 8) throw new Error("Use a password of at least 8 characters.");
      if (pass !== $("#aPass2").value) throw new Error("The two passwords don't match.");
      const {error} = await S.sb.auth.updateUser({password: pass});
      if (error) throw error;
      S.recovery = false; toast("Password changed"); history.replaceState(null, "", location.pathname); loadAll(true);
    }
  } catch (e) {
    const m = errText(e);
    showAuthErr(/invalid login/i.test(m) ? "That email and password don't match an account." : /not confirmed/i.test(m) ? "Confirm your email first: click the link we sent you, then sign in." : m);
  } finally { if (btn.isConnected) btn.disabled = false; }
}
function viewInactive(){
  return `<section class="panel"><h2>Account waiting for activation</h2>
    <p class="lede">Thanks, ${esc(S.me.full_name || "")}. The club admin has been told about your new account. You'll get an email once it's activated, and then you can submit claims here.</p>
    <div class="row"><button class="btn" data-act="reload">Check again</button></div></section>`;
}

/* ---------- details ---------- */
function detailsCard(){
  const me = S.me;
  return `<section class="panel">
    <div><h2>My account</h2><p class="lede">Your name appears on your claims so approvers and the bookkeeper know who to pay.</p></div>
    <div class="grid">
      <label>Full name<input id="pName" value="${esc(me.full_name)}" autocomplete="name"></label>
      <label>Club role<input id="pRole" value="${esc(me.club_role)}"></label>
    </div>
    <div class="row end"><button class="btn primary" data-act="save-details">Save details</button></div>
  </section>
  <section class="panel">
    <div><h3>Login email</h3><p class="sub" style="margin:4px 0 0">Currently <strong>${esc(S.user.email || me.email)}</strong>. We'll send a confirmation link to the new address${S.user.new_email ? `. A change to ${esc(S.user.new_email)} is waiting for confirmation` : ""}.</p></div>
    <div class="row"><input id="pEmail" type="email" autocomplete="email" placeholder="New email address" style="flex:1;min-width:200px"><button class="btn" data-act="change-email">Change email</button></div>
  </section>
  <section class="panel">
    <h3>Password</h3>
    <div class="grid">
      <label>New password <span class="hint">At least 8 characters</span><input id="pPass" type="password" autocomplete="new-password"></label>
      <label>Confirm new password<input id="pPass2" type="password" autocomplete="new-password"></label>
    </div>
    <div class="row end"><button class="btn" data-act="change-password">Change password</button></div>
  </section>
  <section class="panel">
    <div><h3>Bank details</h3><p class="sub" style="margin:4px 0 0">Where the club pays your expenses, invoices and mileage. Only you and the bookkeeper can see these. You and the bookkeeper are emailed whenever they change. The club will never ask for your bank details by email.</p></div>
    ${S.myBank ? `<div class="notice">Currently: <strong>${esc(S.myBank.account_name)}</strong>, sort code ${esc(fmtSort(S.myBank.sort_code))}, account ending ${esc(String(S.myBank.account_number).slice(-4))}. Last changed ${fmtDate(S.myBank.updated_at)}.</div>` : `<div class="notice warn">You haven't added bank details yet. You need them before submitting expenses, invoices or mileage.</div>`}
    <div class="grid">
      <label>Name on account<input id="bName" autocomplete="off" value="${esc(S.myBank ? S.myBank.account_name : me.full_name)}"></label>
      <label>Sort code<input id="bSort" inputmode="numeric" placeholder="12-34-56" autocomplete="off"></label>
      <label>Account number<input id="bAcct" inputmode="numeric" placeholder="8 digits" autocomplete="off"></label>
    </div>
    <div class="row end"><button class="btn primary" data-act="save-bank">${S.myBank ? "Update bank details" : "Save bank details"}</button></div>
  </section>
  <section class="panel">
    <div><h3>Your data</h3><p class="sub" style="margin:4px 0 0">Download a copy of your account details and every claim you've submitted. Read the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a> and <a href="terms.html" target="_blank" rel="noopener">terms of use</a>. To have your account closed, contact the club admin.</p></div>
    <div class="row"><button class="btn" data-act="download-data">Download my data</button><button class="btn" data-act="cancel-details">Back to my claims</button></div>
  </section>`;
}

/* ---------- new claim ---------- */
function blankDraft(type){ const d = blankDraftBase(type); if (isMixed(type)) d.lines = [{date: today(), item: "activity", activity_key: ""}]; return d; }
function lastSection(){ try { return localStorage.getItem("rhc-last-section") || ""; } catch (e) { return ""; } }
function blankDraftBase(type){ return {editingId:null,editingRef:"",type:type||null,section:lastSection(),budget_area:"",team:"",description:"",invoice_number:"",invoice_date:today(),pay_period:new Date().toISOString().slice(0,7),lines:[{date:today()}],attachments:[],declare:false,supplier_name:"",supplier_email:"",due_date:"",vat_invoice:false,supplier_vat_number:"",bank_name:"",bank_sort:"",bank_acct:""}; }
function viewNew(){
  if (S.lastSubmitted) return submittedView();
  if (!S.draft) S.draft = blankDraft();
  const d = S.draft;
  let h = `<section class="panel">
    <div><h2>${d.editingId ? "Edit and resubmit " + esc(d.editingRef) : "New claim"}</h2><p class="lede">Pick the kind of claim. It needs a first and a second approval, then it goes to the bookkeeper for payment.</p></div>
    <div class="types" role="group" aria-label="Claim type">${Object.entries(TYPES).filter(([k]) => k !== "supplier" || canLogSuppliers() || d.type === "supplier").map(([k,t]) => `<button class="type" data-act="type" data-type="${k}" aria-pressed="${d.type === k}" ${d.editingId ? "disabled" : ""}><b>${esc(t.short)}</b><span>${esc(t.blurb)}</span></button>`).join("")}</div>
  </section>`;
  if (!d.type) return h + inProgressHint();
  const T = TYPES[d.type], COLS = colsFor(d.type, d.vat_invoice), areas = (S.settings.budget_areas && S.settings.budget_areas.length) ? S.settings.budget_areas : DEFAULT_AREAS;
  const rate = S.settings.mileage_rate;
  h += `<section class="panel" id="claimForm">
    <div class="row"><h2 style="flex:1">${esc(T.label)}</h2><span class="sub">${d.type === "supplier" ? (d.supplier_name ? "Paying " + esc(d.supplier_name) : "Paying the supplier") : "Paying " + esc(S.me.full_name)}</span></div>
    ${rateProblems(d).length ? `<div class="notice warn">${rateProblems(d).map(esc).join("<br>")}</div>` : ""}
    ${d.type === "mileage" && rate != null ? `<div class="notice">${esc(rulesText())}</div>` : ""}
    ${d.type === "mileage" && rate == null ? `<div class="notice warn">The club mileage rate hasn't been set yet, so mileage claims can't be submitted. The club admin sets it in Settings.</div>` : ""}
    <div class="grid">
      <label>Budget area<select id="fArea" data-f="budget_area"><option value="">Choose…</option>${areas.map(a => `<option ${d.budget_area === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
      <label>Section <span class="hint">Select one. If the claim covers more than one, select the main one (the biggest part).</span><select id="fSection" data-f="section"><option value="">Choose…</option>${sections().map(x => `<option value="${esc(x.key)}" ${d.section === x.key ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>
      <label>Team / squad <span class="hint">e.g. U14 girls, Men's 2s</span><input id="fTeam" data-f="team" value="${esc(d.team)}"></label>
      ${d.type === "supplier" ? `<label>Supplier name<input id="fSupName" data-f="supplier_name" value="${esc(d.supplier_name)}" placeholder="e.g. Smith Physiotherapy Ltd"></label><label>Supplier email <span class="hint">Optional</span><input id="fSupEmail" type="email" data-f="supplier_email" value="${esc(d.supplier_email)}"></label><label>Invoice number<input id="fInvNo" data-f="invoice_number" value="${esc(d.invoice_number)}"></label><label>Invoice date<input id="fInvDate" type="date" data-f="invoice_date" value="${esc(d.invoice_date)}"></label><label>Payment due<input id="fDue" type="date" data-f="due_date" value="${esc(d.due_date)}"></label>` : ""}
      ${d.type === "invoice" ? `<label>Invoice number<input id="fInvNo" data-f="invoice_number" value="${esc(d.invoice_number)}"></label><label>Invoice date<input id="fInvDate" type="date" data-f="invoice_date" value="${esc(d.invoice_date)}"></label>` : ""}
      ${d.type === "payroll" ? `<label>Pay period<input id="fPeriod" type="month" data-f="pay_period" value="${esc(d.pay_period)}"></label>` : ""}
    </div>
    ${d.type === "supplier" ? `<label style="flex-direction:row;align-items:center;gap:10px"><input type="checkbox" id="fVat" data-f="vat_invoice" ${d.vat_invoice ? "checked" : ""}> This is a VAT invoice <span class="hint">(it shows the supplier's VAT number and a VAT amount)</span></label>${d.vat_invoice ? `<label style="max-width:320px">Supplier's VAT number<input id="fVatNo" data-f="supplier_vat_number" value="${esc(d.supplier_vat_number)}" placeholder="e.g. GB123456789"></label>` : ""}` : ""}
    <label>What is this claim for?<textarea id="fDesc" data-f="description" placeholder="${d.type === "mileage" ? "e.g. Driving to the U14 regional tournament" : d.type === "expense" ? "e.g. First-aid kit restock for match day" : "e.g. U14 girls Sunday sessions, October"}">${esc(d.description)}</textarea></label>
    <div>
      <h3 style="margin-bottom:8px">${d.type === "mileage" ? "Journeys" : d.type === "expense" ? "Items" : d.type === "supplier" ? "Invoice lines" : "What you're claiming"}</h3>
      ${isMixed(d.type) ? `<div class="tablebox"><table class="lines mixed"><thead><tr><th>Date</th><th>Item</th><th>Details</th><th class="num">Amount</th><th></th></tr></thead><tbody>${d.lines.map((l,i) => mixedRow(l, i, d.lines.length)).join("")}</tbody></table></div>` : `<div class="tablebox"><table class="lines"><thead><tr>${COLS.map(c => `<th class="${NUMERIC_COLS.includes(c.t) ? "num" : ""}">${esc(c.l)}</th>`).join("")}<th></th></tr></thead>
      <tbody>${d.lines.map((l,i) => `<tr>${COLS.map(c => lineCell(c,l,i)).join("")}<td><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove line" ${d.lines.length < 2 ? "disabled" : ""}>✕</button></td></tr>`).join("")}</tbody></table></div>`}
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="add-line">+ Add ${d.type === "mileage" ? "journey" : d.type === "expense" ? "item" : "line"}</button></div>
    </div>
    <div class="totals" id="totals"></div>
    ${T.attach ? `<div style="display:flex;flex-direction:column;gap:8px">
      <label for="fFile">${d.type === "invoice" || d.type === "supplier" ? "Invoice" : "Receipts"} <span class="hint">${esc(T.attachHint)}</span></label>
      <input type="file" id="fFile" multiple accept="image/*,application/pdf">
      <div class="files" id="fileList">${filesHtml(d.attachments, true)}</div>
    </div>` : ""}
    ${bankFormSection(d)}
    <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="fDeclare" data-f="declare" ${d.declare ? "checked" : ""}> <span>I confirm this claim is accurate, was incurred on ${esc(CLUB)} business, and hasn't been claimed before.</span></label>
    <div class="notice bad" id="formErr" hidden></div>
    <div class="row end">${d.editingId ? `<button class="btn" data-act="cancel-edit">Cancel</button>` : `<button class="btn" data-act="reset">Clear form</button>`}<button class="btn primary" data-act="submit" id="submitBtn">${d.editingId ? "Resubmit claim" : "Submit claim"}</button></div>
  </section>`;
  return h;
}
function bankFormSection(d){
  if (d.type === "payroll") return `<div class="notice">Payroll claims are paid through the club payroll, so no bank details are needed.</div>`;
  if (d.type === "supplier") return `<div style="display:flex;flex-direction:column;gap:10px"><div><h3>Supplier's bank details</h3><p class="sub" style="margin:4px 0 0">Copy these from the invoice. If a supplier tells you their bank details have changed, phone them on a number you already know to confirm before submitting.</p></div>
    <div class="grid"><label>Name on account<input id="fBankName" data-f="bank_name" value="${esc(d.bank_name)}" autocomplete="off"></label><label>Sort code<input id="fBankSort" data-f="bank_sort" value="${esc(d.bank_sort)}" inputmode="numeric" placeholder="12-34-56" autocomplete="off"></label><label>Account number<input id="fBankAcct" data-f="bank_acct" value="${esc(d.bank_acct)}" inputmode="numeric" placeholder="8 digits" autocomplete="off"></label></div></div>`;
  const b = S.myBank;
  return b ? `<div class="notice">Paid to <strong>${esc(b.account_name)}</strong>, account ending <strong>${esc(String(b.account_number).slice(-4))}</strong>. <button class="link" data-act="edit-details">Change bank details</button></div>`
    : `<div class="notice warn">Add your bank details before submitting, so the club knows where to pay you. <button class="btn small" data-act="edit-details">Add bank details</button></div>`;
}
function inProgressHint(){
  const open = S.claims.filter(c => c.claimant === S.me.id && ["pending","first_approved","returned","approved"].includes(c.status)).length;
  return open ? `<div class="notice">You have ${open} claim${open > 1 ? "s" : ""} in progress. <button class="btn small" data-act="tab" data-tab="mine">View my claims</button></div>` : "";
}
function lineCell(c, l, i){
  const id = `ln-${i}-${c.k}`, v = l[c.k] == null ? "" : l[c.k];
  if (DISPLAY_ONLY.includes(c.t)) return `<td class="num calc" id="${id}">–</td>`;
  if (c.t === "vatrate") return `<td><select id="${id}" data-line="${i}" data-k="${c.k}" aria-label="VAT rate">${[20,5,0].map(v => `<option value="${v}" ${String(v === 20 && (l.vat_rate == null || l.vat_rate === "") ? 20 : l.vat_rate) === String(v) ? "selected" : ""}>${v}%</option>`).join("")}</select></td>`;
  if (c.t === "check") return `<td style="text-align:center;padding-top:12px"><input type="checkbox" id="${id}" data-line="${i}" data-k="${c.k}" ${v ? "checked" : ""} aria-label="Return journey"></td>`;
  if (c.t === "activity") return `<td><select id="${id}" data-line="${i}" data-k="${c.k}" aria-label="Activity"><option ${v !== "Umpiring" ? "selected" : ""}>Coaching</option><option ${v === "Umpiring" ? "selected" : ""}>Umpiring</option></select></td>`;
  const type = c.t === "date" ? "date" : (c.t === "text" ? "text" : "number");
  const extra = c.t === "money" ? 'step="0.01" min="0" inputmode="decimal"' : c.t === "num" ? 'step="0.25" min="0" inputmode="decimal"' : "";
  return `<td><input id="${id}" type="${type}" ${extra} class="${c.t === "num" || c.t === "money" ? "w-s" : ""}" data-line="${i}" data-k="${c.k}" value="${esc(v)}" aria-label="${esc(c.l)}"></td>`;
}
function filesHtml(list, editable){
  if (!list || !list.length) return editable ? `<span class="sub">No files uploaded yet.</span>` : "";
  return list.map((a,i) => `<span class="file">📎 <button class="link" style="padding:0" data-act="open-file" data-path="${esc(a.path)}">${esc(a.name || "file")}</button>${editable ? `<button data-act="del-file" data-i="${i}" aria-label="Remove ${esc(a.name)}">×</button>` : ""}</span>`).join("");
}
function recalc(){
  const d = S.draft; if (!d || !d.type) return; const el = $("#totals"); if (!el) return;
  const rate = S.settings.mileage_rate;
  if (isMixed(d.type)){
    const ma = mixedAmounts(d.lines); let tot = 0, hrs = 0, ch = 0, anyMiles = false;
    ma.forEach((x, i) => { const c = $(`#ln-${i}-_amt`); if (c) c.textContent = gbp(x.amt); const cm = $(`#ln-${i}-ch`); if (cm) cm.textContent = `${x.ch.toLocaleString("en-GB")} claimable mi`; tot += x.amt; hrs += x.h; ch += x.ch; if (x.it === "mileage") anyMiles = true; });
    el.innerHTML = (hrs ? `<div><small>Hours</small><strong>${fmtH(hrs)}</strong></div>` : "") + (anyMiles ? `<div><small>Claimable miles</small><strong>${ch.toLocaleString("en-GB")}</strong></div>` : "") + `<div><small>Total claimed</small><strong>${gbp(Math.round(tot * 100) / 100)}</strong></div>`;
    return;
  }
  const ml = d.type === "mileage" ? mileageLines(d.lines) : null;
  d.lines.forEach((l,i) => { const c = $(`#ln-${i}-_amt`); if (c) c.textContent = gbp(ml ? ml[i].amt : lineAmount(d.type, l, rate)); const cm = $(`#ln-${i}-chargeable_miles`); if (cm && ml) cm.textContent = ml[i].ch.toLocaleString("en-GB"); const cv = $(`#ln-${i}-vat`); if (cv) cv.textContent = gbp(lineVat(l)); const r = $(`#ln-${i}-rate`); if (r){ const v = hourlyRate(l.activity); r.textContent = v == null ? "not set" : gbp(v); } });
  const t = totals(d.type, d.lines, rate);
  let out = "";
  if (d.type === "mileage") out += `<div><small>Miles driven</small><strong>${t.miles.toLocaleString("en-GB")}</strong></div><div><small>Claimable miles</small><strong>${t.chargeable.toLocaleString("en-GB")}</strong></div>`;
  if (d.type === "invoice" || d.type === "payroll") out += `<div><small>Total hours</small><strong>${fmtH(t.hours)}</strong></div>`;
  if (d.type === "supplier" && d.vat_invoice) out += `<div><small>Net</small><strong>${gbp(t.net)}</strong></div><div><small>VAT</small><strong>${gbp(t.vat)}</strong></div>`;
  out += `<div><small>${d.type === "supplier" ? "Total to pay" : "Total claimed"}</small><strong>${gbp(t.amount)}</strong></div>`;
  el.innerHTML = out;
}
function validate(d){
  const T = TYPES[d.type], COLS = colsFor(d.type, d.vat_invoice), errs = [];
  if (d.type === "supplier"){
    if (!d.supplier_name.trim()) errs.push("Add the supplier's name.");
    if (!d.invoice_number.trim()) errs.push("Add the invoice number.");
    if (d.vat_invoice && !d.supplier_vat_number.trim()) errs.push("Add the supplier's VAT number.");
    if (!d.bank_name.trim()) errs.push("Add the name on the supplier's bank account.");
    if (String(d.bank_sort).replace(/\D/g, "").length !== 6) errs.push("The supplier's sort code needs 6 digits.");
    if (String(d.bank_acct).replace(/\D/g, "").length !== 8) errs.push("The supplier's account number needs 8 digits.");
  }
  if (["expense","invoice","mileage"].includes(d.type) && !S.myBank) errs.push("Add your bank details in My account first.");
  if (!d.section || !sections().some(x => x.key === d.section)) errs.push("Choose the section this claim is for.");
  if (!d.budget_area) errs.push("Choose a budget area.");
  if (!d.description.trim()) errs.push("Say what the claim is for.");
  if (d.type === "invoice" && !d.invoice_number.trim()) errs.push("Add your invoice number.");
  if (d.type === "mileage" && S.settings.mileage_rate == null) errs.push("The club mileage rate isn't set yet.");
  for (const m of rateProblems(d)) errs.push(m);
  if (isMixed(d.type)) d.lines.forEach((l, i) => {
    const it = lineItem(l), n = `Line ${i + 1} (${(ITEMS[it] || "").toLowerCase()})`;
    if (blank(l.date)) errs.push(`${n}: add the date.`);
    if (it === "activity"){ const a = actByKey(l.activity_key); if (!a) errs.push(`Line ${i + 1}: choose the timesheet heading.`); else { const m = `Line ${i + 1} (${a.label})`; if (blank(l.session)) errs.push(`${m}: add a comment, e.g. age group, training, home or away match.`); if (num(l.hours) <= 0 || num(l.hours) > 24) errs.push(`${m}: hours must be between 0.25 and 24.`); if (ownRates() && num(l.rate) <= 0) errs.push(`${m}: enter your hourly rate.`); } return; }
    if (it === "coaching" || it === "umpiring"){ errs.push(`Line ${i + 1}: choose a timesheet heading.`); return; }
    if (false){ if (blank(l.session)) errs.push(`${n}: say which ${it === "umpiring" ? "match" : "session"}.`); if (num(l.hours) <= 0) errs.push(`${n}: add the hours.`); if (ownRates() && num(l.rate) <= 0) errs.push(`${n}: enter your hourly rate.`); }
    else if (it === "mileage"){ if (blank(l.from) || blank(l.to)) errs.push(`${n}: add where you drove from and to.`); if (blank(l.purpose)) errs.push(`${n}: add the purpose.`); if (num(l.miles) <= 0) errs.push(`${n}: add the miles.`); }
    else if (it === "retainer" && perSeason()){ if (blank(l.season)) errs.push(`${n}: choose the season.`); else if (claimedSeasons(d.editingId).has(l.season)) errs.push(`${n}: you've already claimed your ${seasonLabel(l.season)} season retainer.`); else if (d.lines.filter(x => lineItem(x) === "retainer" && x.season === l.season).length > 1) errs.push(`${n}: the ${seasonLabel(l.season)} retainer is on this claim twice.`); if (ownRates() && blank(l.rate) && (!S.me || S.me.retainer_amount == null)) errs.push(`${n}: enter the retainer amount.`); }
    else if (it === "retainer"){ if (blank(l.description)) errs.push(`${n}: say which month it's for.`); if (!blank(l.qty) && num(l.qty) <= 0) errs.push(`${n}: months must be at least 1.`); if (ownRates() && blank(l.rate) && (!S.me || S.me.retainer_amount == null)) errs.push(`${n}: enter the monthly amount.`); }
    else { if (blank(l.description)) errs.push(`${n}: describe what it's for.`); if (num(l.amount) <= 0) errs.push(`${n}: add the amount.`); }
  });
  const need = isMixed(d.type) ? [] : COLS.filter(c => !DISPLAY_ONLY.concat(["check","vatrate"]).includes(c.t) && !c.optional).map(c => c.k);
  d.lines.forEach((l,i) => { for (const k of need){ const v = l[k]; if (v == null || String(v).trim() === "" || (["amount","hours","miles","rate","net"].includes(k) && num(v) <= 0)){ errs.push(`Line ${i+1}: fill in ${COLS.find(c => c.k === k).l.toLowerCase()}.`); break; } } });
  if (T.attach && !d.attachments.length) errs.push(d.type === "invoice" ? "Upload your invoice." : d.type === "supplier" ? "Upload the supplier's invoice." : "Upload at least one receipt.");
  if (!d.declare) errs.push("Tick the confirmation box.");
  return errs;
}
async function submitDraft(){
  const d = S.draft, errs = validate(d), box = $("#formErr");
  if (errs.length){ box.innerHTML = errs.map(esc).join("<br>"); box.hidden = false; box.scrollIntoView({block:"nearest"}); return; }
  box.hidden = true; const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "Submitting…";
  const mixedLine = l => { const it = lineItem(l), o = {date: l.date, item: it};
    if (it === "activity"){ o.activity_key = l.activity_key; o.session = String(l.session || "").trim(); o.hours = num(l.hours); if (ownRates()) o.rate = num(l.rate); return o; }
    if (it === "coaching" || it === "umpiring"){ o.session = String(l.session || "").trim(); o.hours = num(l.hours); if (ownRates()) o.rate = num(l.rate); }
    else if (it === "mileage"){ o.from = String(l.from || "").trim(); o.to = String(l.to || "").trim(); o.purpose = String(l.purpose || "").trim(); o.miles = num(l.miles); o.ret = !!l.ret; o.passengers = 0; }
    else if (it === "retainer"){ o.description = String(l.description || "").trim(); if (perSeason()) o.season = l.season; else o.qty = num(l.qty) || 1; if (ownRates() && !blank(l.rate)) o.rate = num(l.rate); }
    else { o.description = String(l.description || "").trim(); o.amount = num(l.amount); }
    return o; };
  const lines = isMixed(d.type) ? d.lines.map(mixedLine) : d.lines.map(l => { const o = {}; for (const c of colsFor(d.type, d.vat_invoice)){ if (DISPLAY_ONLY.includes(c.t)) continue; if (c.t === "vatrate"){ o[c.k] = l[c.k] == null || l[c.k] === "" ? 20 : num(l[c.k]); continue; } o[c.k] = (c.t === "money" || c.t === "num") ? num(l[c.k]) : c.t === "check" ? !!l[c.k] : String(l[c.k] || (c.t === "activity" ? "Coaching" : "")).trim(); } return o; });
  try { localStorage.setItem("rhc-last-section", d.section || ""); } catch (e) {}
  const p = {type:d.type, section:d.section, budget_area:d.budget_area, team:d.team, description:d.description,
    invoice_number:["invoice","supplier"].includes(d.type) ? d.invoice_number : "", invoice_date:["invoice","supplier"].includes(d.type) ? d.invoice_date : "",
    supplier_name:d.supplier_name || "", supplier_email:d.supplier_email || "", due_date:d.type === "supplier" ? (d.due_date || "") : "",
    vat_invoice:d.type === "supplier" && !!d.vat_invoice, supplier_vat_number:d.vat_invoice ? (d.supplier_vat_number || "") : "",
    bank:d.type === "supplier" ? {account_name:d.bank_name, sort_code:d.bank_sort, account_number:d.bank_acct} : {},
    pay_period:d.type === "payroll" ? d.pay_period : "", lines, attachments:d.attachments};
  const {data, error} = await S.sb.rpc("submit_claim", {p, p_claim_id: d.editingId || null});
  if (error){ btn.disabled = false; btn.textContent = d.editingId ? "Resubmit claim" : "Submit claim"; box.textContent = errText(error, "The claim didn't save. Try again."); box.hidden = false; return; }
  S.draft = null; clearLocalDraft();
  await loadClaims();
  S.lastSubmitted = S.claims.find(c => c.id === data) || {id:data, ref:"your claim", type:d.type, total:0, hours:0};
  render(); window.scrollTo(0, 0);
}
function submittedView(){
  const c = S.lastSubmitted;
  return `<section class="panel">
    <div><h2>Claim ${esc(c.ref)} submitted</h2><p class="lede">${esc(TYPES[c.type].label)} for ${headline(c)}. The approvers have been emailed. You'll get an email when it's approved, paid or sent back.</p></div>
    <div class="row end"><button class="btn" data-act="tab" data-tab="mine">Track my claims</button><button class="btn primary" data-act="another">Submit another</button></div>
  </section>`;
}

/* ---------- claim card ---------- */
function stepsHtml(c){
  if (c.status === "withdrawn") return "";
  const paid = c.status === "processed";
  const steps = [
    ["Submitted", true, fmtDate(c.updated_at || c.submitted_at)],
    ["1st approval · captain", !!c.first_approver, c.first_approver ? personName(c.first_approver) + ", " + fmtDate(c.first_approved_at) : ""],
    ["2nd approval · finance", !!c.second_approver, c.second_approver ? personName(c.second_approver) + ", " + fmtDate(c.second_approved_at) : ""],
    ["Paid", paid, paid ? fmtDate(c.processed_at) : (c.status === "approved" ? "With bookkeeper" : "")]
  ];
  const next = c.status === "returned" ? -1 : steps.findIndex(x => !x[1]);
  return `<ol class="track" aria-label="Progress">${steps.map((x,i) => `<li class="${x[1] ? "done" : i === next ? "next" : ""}"><b>${x[1] ? "✓ " : ""}${esc(x[0])}</b>${x[2] ? esc(x[2]) : (i === next ? "Waiting" : "")}</li>`).join("")}</ol>`;
}
function hoursSummary(c){
  const rows = new Map();
  for (const l of (c.lines || [])){ const it = lineItem(l); if (!["activity","coaching","umpiring"].includes(it)) continue;
    const k = itemLabel(l) + "|" + num(l.rate), x = rows.get(k) || {label: itemLabel(l), rate: num(l.rate), h: 0, amt: 0}; x.h += num(l.hours); x.amt += num(l.amount); rows.set(k, x); }
  if (!rows.size) return "";
  const list = [...rows.values()], th = list.reduce((a, x) => a + x.h, 0), ta = list.reduce((a, x) => a + x.amt, 0);
  return `<div><h3 style="margin:4px 0 8px;font-size:.95rem">Hours by timesheet heading</h3><div class="tablebox"><table><thead><tr><th>Heading</th><th class="num">Total hours</th><th class="num">Hourly rate</th><th class="num">Total pay</th></tr></thead><tbody>${list.map(x => `<tr><td>${esc(x.label)}</td><td class="num">${esc(fmtH(x.h))}</td><td class="num">${gbp(x.rate)}</td><td class="num">${gbp(x.amt)}</td></tr>`).join("")}<tr><td><strong>Total</strong></td><td class="num"><strong>${esc(fmtH(th))}</strong></td><td></td><td class="num"><strong>${gbp(ta)}</strong></td></tr></tbody></table></div></div>`;
}
function claimDetail(c, open){
  const cols = colsFor(c.type, c.vat_invoice);
  const cell = (k, l) => {
    if (k.t === "calc") return `<td class="num">${gbp(l.amount)}</td>`;
    if (k.t === "rate") return `<td class="num">${gbp(l.rate)}</td>`;
    if (k.t === "vatcalc") return `<td class="num">${gbp(l.vat)}</td>`;
    if (k.t === "vatrate") return `<td>${esc(l.vat_rate)}%</td>`;
    if (k.t === "chg") return `<td class="num">${l.chargeable_miles == null ? "–" : esc(l.chargeable_miles)}</td>`;
    if (k.t === "money") return `<td class="num">${gbp(l[k.k])}</td>`;
    if (k.t === "num") return `<td class="num">${esc(l[k.k])}</td>`;
    if (k.t === "check") return `<td>${l[k.k] ? "Yes" : "No"}</td>`;
    if (k.t === "date") return `<td>${fmtDate(l[k.k])}</td>`;
    return `<td>${esc(l[k.k])}</td>`;
  };
  return `<details ${open ? "open" : ""}><summary>Claim details</summary>
    <div style="display:flex;flex-direction:column;gap:10px">
    <p style="margin:0">${esc(c.description)}</p>
    <div class="meta">${c.invoice_number ? `<span>Invoice ${esc(c.invoice_number)}${c.invoice_date ? " · " + fmtDate(c.invoice_date) : ""}</span>` : ""}${c.pay_period ? `<span>Pay period ${esc(c.pay_period)}</span>` : ""}${c.type === "supplier" ? `${c.due_date ? `<span>Due ${fmtDate(c.due_date)}</span>` : ""}${c.supplier_email ? `<span>${esc(c.supplier_email)}</span>` : ""}${c.vat_invoice ? `<span>VAT no. ${esc(c.supplier_vat_number)} · Net ${gbp(c.net_total)} + VAT ${gbp(c.vat_total)}</span>` : `<span>Not a VAT invoice</span>`}` : ""}${(c.type === "mileage" || (isMixed(c.type) && c.mileage_rules)) ? `<span>${esc(c.mileage_rules ? rulesText(c.mileage_rules) : "Rate " + gbp(c.mileage_rate) + "/mile")}</span>` : ""}</div>
    ${isMixed(c.type) ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Item</th><th>Details</th><th class="num">Quantity</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
    <tbody>${(c.lines || []).map(l => `<tr><td>${fmtDate(l.date)}</td><td>${esc(itemLabel(l))}${l.own_rate ? ` <span class="pill pending" title="Rate entered by the claimant">own rate</span>` : ""}</td><td>${esc(mixedDetail(l))}</td><td class="num">${esc(mixedQty(l))}</td><td class="num">${esc(mixedRate(l))}</td><td class="num">${gbp(l.amount)}</td></tr>`).join("")}</tbody></table></div>${c.type === "payroll" ? hoursSummary(c) : ""}`
    : `<div class="tablebox"><table><thead><tr>${cols.map(k => `<th class="${NUMERIC_COLS.includes(k.t) ? "num" : ""}">${esc(k.l)}</th>`).join("")}</tr></thead>
    <tbody>${(c.lines || []).map(l => `<tr>${cols.map(k => cell(k, l)).join("")}</tr>`).join("")}</tbody></table></div>`}
    ${c.attachments && c.attachments.length ? `<div class="files">${filesHtml(c.attachments, false)}</div>` : ""}
    </div></details>`;
}
function payeeLabel(c){ return c.type === "supplier" ? `Pay ${c.supplier_name} · logged by ${personName(c.claimant)}` : personName(c.claimant); }
function claimCard(c, actions, open){
  const st = STATUS[c.status] || STATUS.pending;
  return `<article class="claim">
    <div class="head"><span class="ref">${esc(c.ref)}</span><span class="pill ${st.cls}">${esc(st.label)}</span><span class="amt">${headline(c)}</span></div>
    <div class="meta"><span><strong>${esc(payeeLabel(c))}</strong></span><span>${esc(TYPES[c.type].label)}</span><span>${c.section_label ? esc(c.section_label) + " · " : ""}${esc(c.budget_area)}${c.team ? " · " + esc(c.team) : ""}</span><span>Submitted ${fmtDate(c.submitted_at)}${c.revision > 1 ? " · resubmitted " + fmtDate(c.updated_at) : ""}</span></div>
    ${stepsHtml(c)}
    ${c.status === "returned" ? `<div class="notice bad"><strong>${esc(personName(c.returned_by))} returned this claim:</strong> ${esc(c.returned_reason || "No reason given.")}</div>` : ""}
    ${c.status === "processed" && c.payment_ref ? `<div class="sub">Payment reference: ${esc(c.payment_ref)}</div>` : ""}
    ${claimDetail(c, open)}
    ${actions || ""}
  </article>`;
}

/* ---------- my claims ---------- */
function viewMine(){
  const mine = S.claims.filter(c => c.claimant === S.me.id);
  const head = `<div class="row"><div style="flex:1"><h2>My claims</h2><p class="lede">Everything you've submitted, newest first. You can see each approval as it happens.</p></div><button class="btn small" data-act="edit-details">My account</button></div>`;
  if (S.editingDetails) return head + detailsCard();
  if (!mine.length) return head + `<div class="empty">You haven't submitted any claims yet.<br><br><button class="btn primary" data-act="tab" data-tab="new">Start a claim</button></div>`;
  return head + `<div class="claims">${mine.map(c => {
    const can = ["pending","first_approved","returned","withdrawn"].includes(c.status);
    return claimCard(c, can ? `<div class="row end"><button class="btn small danger" data-act="delete-claim" data-id="${esc(c.id)}">Delete</button><button class="btn small primary" data-act="edit-claim" data-id="${esc(c.id)}">${c.status === "returned" ? "Fix and resubmit" : c.status === "withdrawn" ? "Edit and resubmit" : "Edit"}</button></div>${c.status === "first_approved" && S.confirmDelete !== c.id ? `<p class="sub" style="margin:0;text-align:right">Editing restarts both approvals.</p>` : ""}${S.confirmDelete === c.id ? `<div class="notice warn row"><span style="flex:1">Delete ${esc(c.ref)} for good? Its receipts are deleted too, and it can't be undone.</span><button class="btn small" data-act="delete-cancel">Keep it</button><button class="btn small danger" data-act="delete-yes" data-id="${esc(c.id)}">Delete claim</button></div>` : ""}` : `<p class="sub" style="margin:0;text-align:right">Fully approved claims can't be edited or deleted.</p>`);
  }).join("")}</div>`;
}

/* ---------- approvals ---------- */
function viewApprove(){
  const list = toApprove();
  const decided = S.claims.filter(c => c.first_approver === S.me.id || c.second_approver === S.me.id || c.returned_by === S.me.id).slice(0, 20);
  const caps = myCaptain().map(sectionLabel).filter(Boolean);
  const role = [caps.length ? `You give the 1st approval for ${caps.join(", ")}` : "", isFinance() ? `${caps.length ? "and" : "You give"} the 2nd (finance) approval for every section` : ""].filter(Boolean).join(" ");
  let h = `<div><h2>To approve</h2><p class="lede">${esc(role)}. The 1st approval comes from a section captain and the 2nd from a finance approver. You can approve your own claim, but the two approvals must come from two different people.</p></div>`;
  h += list.length ? `<div class="claims">${list.map(c => claimCard(c, decideBox(c), true)).join("")}</div>` : `<div class="empty">Nothing waiting for you. You'll get an email when a claim needs your approval.</div>`;
  if (decided.length) h += `<div><h3 style="margin:12px 0 8px">Recently decided by you</h3><div class="tablebox"><table><thead><tr><th>Claim</th><th>Claimant</th><th>Your decision</th><th>Now</th><th class="num">Value</th></tr></thead><tbody>${decided.map(c => {
    const what = c.returned_by === S.me.id ? "Returned " + fmtDate(c.returned_at) : c.first_approver === S.me.id ? "1st approval " + fmtDate(c.first_approved_at) : "2nd approval " + fmtDate(c.second_approved_at);
    const st = STATUS[c.status];
    return `<tr><td>${esc(c.ref)}</td><td>${esc(c.type === "supplier" ? c.supplier_name : personName(c.claimant))}</td><td>${what}</td><td><span class="pill ${st.cls}">${esc(st.label)}</span></td><td class="num">${headline(c)}</td></tr>`;
  }).join("")}</tbody></table></div></div>`;
  return h;
}
function decideBox(c){
  if (S.decideOpen === c.id) return `<div class="decide"><label>Reason for returning <span class="hint">The claimant sees this and can fix and resubmit.</span><textarea id="rejNote-${esc(c.id)}"></textarea></label><div class="row end"><button class="btn" data-act="reject-cancel">Cancel</button><button class="btn danger" data-act="reject-yes" data-id="${esc(c.id)}">Return claim</button></div></div>`;
  const second = c.status === "first_approved";
  return `<div class="decide row end" style="flex-direction:row">${c.claimant === S.me.id ? `<span class="sub" style="margin-right:auto">This is your own claim.</span>` : `<button class="btn danger" data-act="reject" data-id="${esc(c.id)}">Return to claimant</button>`}<button class="btn good" data-act="approve" data-id="${esc(c.id)}">${second ? "Give 2nd approval (finance)" : "Give 1st approval (captain)"} · ${headline(c)}</button></div>`;
}

/* ---------- bookkeeper ---------- */
function bkSet(f){ return f === "ready" ? readyToPay() : f === "processed" ? S.claims.filter(c => c.status === "processed") : S.claims; }
const BK_SORTS = [["new","Newest first"],["old","Oldest first"],["high","Amount: high to low"],["low","Amount: low to high"],["name","Claimant / payee A–Z"],["type","Claim type"]];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function claimMonth(c){
  if (c.type === "payroll" && /^\d{4}-\d{2}/.test(c.pay_period || "")) return c.pay_period.slice(0, 7);
  if ((c.type === "invoice" || c.type === "supplier") && c.invoice_date) return String(c.invoice_date).slice(0, 7);
  return String(c.submitted_at || "").slice(0, 7);
}
const monthLabel = m => m ? `${MONTHS.at(Number(m.slice(5, 7)) - 1)} ${m.slice(0, 4)}` : "";
const payeeName = c => c.type === "supplier" ? c.supplier_name : personName(c.claimant);
function bkFiltered(){
  const F = S.bk, q = (F.q || "").trim().toLowerCase();
  let list = bkSet(S.bkFilter).filter(c => (!F.month || claimMonth(c) === F.month) && (!F.type || c.type === F.type) && (!F.area || c.budget_area === F.area) && (!F.section || c.section === F.section)
    && (!q || [payeeName(c), personName(c.claimant), c.ref, c.description, c.team, c.invoice_number].join(" ").toLowerCase().includes(q)));
  const by = {new: (a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)), old: (a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)),
    high: (a, b) => num(b.total) - num(a.total), low: (a, b) => num(a.total) - num(b.total),
    name: (a, b) => String(payeeName(a)).localeCompare(String(payeeName(b))), type: (a, b) => TYPES[a.type].label.localeCompare(TYPES[b.type].label) || String(b.submitted_at).localeCompare(String(a.submitted_at))}[F.sort] || null;
  return by ? list.slice().sort(by) : list;
}
const bkActive = () => !!(S.bk.month || S.bk.type || S.bk.area || S.bk.section || (S.bk.q || "").trim());
function viewBooks(){
  const f = S.bkFilter, F = S.bk, base = bkSet(f), list = bkFiltered();
  const months = [...new Set(S.claims.map(claimMonth).filter(Boolean))].sort().reverse();
  const areas = [...new Set(S.claims.map(c => c.budget_area).filter(Boolean))].sort();
  const sel = (k, label, opts) => `<label>${label}<select data-bk-k="${k}" id="bk-${k}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${F[k] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  let h = `<div class="row"><div style="flex:1"><h2>Bookkeeper</h2><p class="lede">Claims with both approvals land here. Pay them, then mark each one as paid with your payment reference.</p></div>
    <div class="row"><button class="btn primary" data-act="export-all" ${S.claims.length ? "" : "disabled"}>Export all claims (CSV)</button></div></div>
    <div class="seg" role="group" aria-label="Status">${[["ready","Ready to pay"],["processed","Paid"],["all","All claims"]].map(([k,l]) => `<button data-act="bk" data-f="${k}" aria-pressed="${f === k}">${l} (${bkSet(k).length})</button>`).join("")}</div>
    <section class="panel bkfilters" style="padding:14px">
      <div class="bkgrid">
        ${sel("month", "Month", months.map(m => [m, monthLabel(m)]))}
        ${sel("type", "Claim type", Object.entries(TYPES).map(([k, t]) => [k, t.label]))}
        ${sel("section", "Section", sections().map(x => [x.key, x.label]))}
        ${sel("area", "Budget area", areas.map(a => [a, a]))}
        <label>Search<input id="bk-q" data-bk-k="q" type="search" value="${esc(F.q || "")}" placeholder="Name, ref, team, invoice no."></label>
        <label>Sort by<select data-bk-k="sort" id="bk-sort">${BK_SORTS.map(([v, l]) => `<option value="${v}" ${F.sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      <div class="row" style="justify-content:space-between">
        <span class="sub">Month means the pay period for payroll, the invoice date for invoices, and the date submitted for everything else.</span>
        <span class="row">${bkActive() ? `<button class="btn small" data-act="bk-clear">Clear filters</button>` : ""}<button class="btn small" data-act="export" ${list.length ? "" : "disabled"}>Export these ${list.length} (CSV)</button></span>
      </div>
    </section>`;
  if (list.length){
    const money = list.reduce((a, c) => a + num(c.total), 0), hrs = list.filter(c => c.type === "payroll").reduce((a, c) => a + num(c.hours), 0), vat = list.reduce((a, c) => a + num(c.vat_total), 0);
    const byType = Object.keys(TYPES).map(k => [k, list.filter(c => c.type === k)]).filter(([, l]) => l.length);
    h += `<div class="totals" style="justify-content:flex-start"><div style="align-items:flex-start"><small>${f === "ready" ? "To pay" : f === "processed" ? "Paid" : "Total"}${bkActive() ? " (filtered)" : ""}</small><strong>${gbp(money)}</strong></div><div style="align-items:flex-start"><small>Claims</small><strong>${list.length}${list.length !== base.length ? ` <span class="sub" style="font-size:.9rem">of ${base.length}</span>` : ""}</strong></div>${hrs ? `<div style="align-items:flex-start"><small>Payroll hours</small><strong>${fmtH(hrs)}</strong></div>` : ""}${vat ? `<div style="align-items:flex-start"><small>VAT included</small><strong>${gbp(vat)}</strong></div>` : ""}</div>
    ${byType.length > 1 ? `<div class="tablebox"><table><thead><tr><th>Claim type</th><th class="num">Claims</th><th class="num">Amount</th></tr></thead><tbody>${byType.map(([k, l]) => `<tr><td>${esc(TYPES[k].label)}</td><td class="num">${l.length}</td><td class="num">${gbp(l.reduce((a, c) => a + num(c.total), 0))}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${hrs ? `<p class="sub" style="margin:0">Payroll amounts are paid through wages.</p>` : ""}`;
  }
  if (!list.length) return h + `<div class="empty">${bkActive() ? "No claims match these filters." : f === "ready" ? "No approved claims are waiting. You'll get an email when one is ready." : "No claims here yet."}</div>`;
  return h + `<div class="claims">${list.map(c => claimCard(c, (isBookkeeper() && ["approved","processed"].includes(c.status) ? paymentBox(c) : "") + (c.status === "approved" ? `<div class="decide">${isBookkeeper() ? `<div class="row"><input id="payRef-${esc(c.id)}" placeholder="Payment reference (optional)" style="flex:1;min-width:180px"><button class="btn good" data-act="processed" data-id="${esc(c.id)}">Mark as paid</button></div>` : `<span class="sub">Only the bookkeeper can mark claims as paid.</span>`}</div>` : ""))).join("")}</div>`;
}
function payeeBank(c){ return c.type === "supplier" ? S.payees[c.id] : c.type === "payroll" ? null : S.banks[c.claimant]; }
function paymentBox(c){
  if (c.type === "payroll") return `<div class="notice">Pay through payroll: ${fmtH(c.hours)} for ${esc(personName(c.claimant))}.</div>`;
  const b = payeeBank(c);
  if (!b) return `<div class="notice warn">No bank details on file for ${esc(c.type === "supplier" ? c.supplier_name : personName(c.claimant))}. Ask them to add them in My account before paying.</div>`;
  const changed = new Date(b.updated_at), recent = (Date.now() - changed) < 30 * 864e5 || changed > new Date(c.submitted_at);
  const copy = (label, v) => `<span class="row" style="gap:6px"><span class="sub">${label}</span> <span class="copyable">${esc(v)}</span><button class="btn small" data-act="copy" data-text="${esc(v)}">Copy</button></span>`;
  return `<div class="panel" style="padding:12px;gap:8px;background:var(--surface-2)">
    <strong>Pay to</strong>
    <div class="row" style="gap:8px 18px">${copy("Name", b.account_name)}${copy("Sort code", fmtSort(b.sort_code))}${copy("Account", b.account_number)}${copy("Reference", c.ref)}</div>
    ${recent ? `<div class="notice warn" style="margin:0">These bank details were ${c.type === "supplier" ? "entered" : "changed"} on ${fmtDate(b.updated_at)}. Before paying, confirm them with ${esc(c.type === "supplier" ? c.supplier_name : personName(c.claimant))} by phone or in person, not by replying to an email.</div>` : ""}
  </div>`;
}
function csvCell(v){ v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
async function exportCsv(all){
  const f = all ? "all" : S.bkFilter, list = all ? S.claims : bkFiltered();
  const head = ["Ref","Status","Type","Claimant","Claimant email","Section","Budget area","Team","Description","Invoice no","Invoice date","Pay period","Submitted","1st approver","1st approved on","2nd approver","2nd approved on","Paid on","Payment ref","Line date","Line detail","Activity","Hours","Rate","Miles","Claimable miles","Line amount","Claim total","Attachments","Payee","Supplier VAT no","Due date","VAT invoice","Line net","Line VAT rate","Line VAT","Claim net","Claim VAT","Own rate"].concat(isBookkeeper() ? ["Pay to name","Sort code","Account number"] : []);
  const rows = [head];
  for (const c of list){
    const p = S.people[c.claimant] || {};
    for (const l of (c.lines || [])){
      const mix = isMixed(c.type), miles = c.type === "mileage" || (mix && lineItem(l) === "mileage");
      const detail = mix ? mixedDetail(l) : c.type === "supplier" ? l.item : c.type === "mileage" ? `${l.from} to ${l.to}${l.ret ? " and return" : ""} – ${l.purpose}` : c.type === "expense" ? `${l.item}${l.supplier ? " (" + l.supplier + ")" : ""}` : l.session;
      rows.push([c.ref, STATUS[c.status].label, TYPES[c.type].short, personName(c.claimant), p.email || "", c.section_label || "", c.budget_area, c.team, c.description, c.invoice_number, c.invoice_date || "", c.pay_period,
        isoDay(c.submitted_at), c.first_approver ? personName(c.first_approver) : "", isoDay(c.first_approved_at), c.second_approver ? personName(c.second_approver) : "", isoDay(c.second_approved_at),
        isoDay(c.processed_at), c.payment_ref || "", l.date, detail, mix ? itemLabel(l) : (l.activity || ""), mix && lineItem(l) === "retainer" ? "" : (l.hours || ""), l.rate ?? (miles ? c.mileage_rate : "") ?? "",
        miles ? num(l.miles) * (l.ret ? 2 : 1) : "", miles ? (l.chargeable_miles ?? "") : "", l.amount || 0, c.total, (c.attachments || []).map(a => a.name).join("; "),
        c.type === "supplier" ? c.supplier_name : personName(c.claimant), c.supplier_vat_number || "", c.due_date || "", c.vat_invoice ? "Yes" : "No",
        c.type === "supplier" ? (l.net ?? "") : "", c.vat_invoice ? (l.vat_rate ?? "") : "", c.vat_invoice ? (l.vat ?? "") : "", c.net_total ?? c.total, c.vat_total ?? 0, l.own_rate ? "Yes" : ""]
        .concat(isBookkeeper() ? (b => b ? [b.account_name, fmtSort(b.sort_code), b.account_number] : [c.type === "payroll" ? "Payroll" : "", "", ""])(payeeBank(c)) : []));
    }
  }
  const blob = new Blob(["﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `rhc-claims-${all ? "all" : [f, S.bk.month, S.bk.type, S.bk.area].filter(Boolean).join("-")}-${today()}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- admin: people ---------- */
function viewPeople(){
  const ppl = Object.values(S.people).sort((a,b) => (a.active - b.active) || (a.full_name || "").localeCompare(b.full_name || ""));
  const row = p => `<div class="personrow" data-person="${esc(p.id)}">
    <div><strong>${esc(p.full_name || "(no name)")}</strong>${p.active ? "" : ` <span class="pill pending">New</span>`}<div class="sub">${esc(p.email)}</div><div class="sub">${esc(p.club_role)}</div></div>
    <div class="checks">
      <label><input type="checkbox" data-r="active" ${p.active ? "checked" : ""}> Active</label>
      <label class="fin"><input type="checkbox" data-r="finance" ${p.is_finance ? "checked" : ""}> Finance approver (2nd approval)</label>
      <details class="actrates" ${(p.captain_sections || []).length ? "open" : ""}><summary>Section captain (1st approval)${(p.captain_sections || []).length ? `: ${esc((p.captain_sections || []).map(sectionLabel).filter(Boolean).join(", "))}` : ""}</summary>
        <div class="capgrid">${sections().map(x => `<label><input type="checkbox" data-r="cap" value="${esc(x.key)}" ${(p.captain_sections || []).includes(x.key) ? "checked" : ""}> ${esc(x.label)}</label>`).join("")}</div>
      </details>
      <label><input type="checkbox" data-r="books" ${p.is_bookkeeper ? "checked" : ""}> Bookkeeper</label>
      <label><input type="checkbox" data-r="sup" ${p.can_log_suppliers ? "checked" : ""}> Logs supplier invoices</label>
      <label><input type="checkbox" data-r="admin" ${p.is_admin ? "checked" : ""}> Admin</label>
      <label>Retainer £ <input type="number" step="0.01" min="0" inputmode="decimal" data-r="retainer" value="${p.retainer_amount == null ? "" : esc(p.retainer_amount)}" placeholder="none" style="width:7.5em"></label>
      <label>Paid <select data-r="retainer-period" style="width:auto"><option value="month" ${p.retainer_period !== "season" ? "selected" : ""}>per month</option><option value="season" ${p.retainer_period === "season" ? "selected" : ""}>once per season</option></select></label>
      <div class="payby"><span>Hourly rates</span>
        <label><input type="radio" name="payby-${esc(p.id)}" data-r="payby" value="heading" ${p.own_rates ? "" : "checked"}> Rates by timesheet heading</label>
        <label><input type="radio" name="payby-${esc(p.id)}" data-r="payby" value="own" ${p.own_rates ? "checked" : ""}> Sets own rates</label>
      </div>
      <details class="actrates" ${p.own_rates ? "hidden" : ""} data-r="heading-rates"><summary>Rates by timesheet heading${Object.keys(p.activity_rates || {}).length ? ` (${Object.keys(p.activity_rates).length} set)` : " (none set yet)"}</summary>
        <p class="sub" style="margin:6px 0">Enter this person's rate for each heading they work. They can only claim hours under headings that have a rate.</p>
        <div class="actgrid">${acts().map(a => `<label>${esc(a.label)}<input type="number" step="0.01" min="0" inputmode="decimal" data-actrate="${esc(a.key)}" value="${p.activity_rates && p.activity_rates[a.key] != null ? esc(p.activity_rates[a.key]) : ""}" placeholder="no rate"></label>`).join("")}</div>
      </details>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;align-items:stretch">
      <button class="btn small primary" data-act="save-person" data-id="${esc(p.id)}">Save</button>
      <button class="btn small" data-act="send-reset" data-id="${esc(p.id)}">Send password reset</button>
      <button class="btn small" data-act="email-edit" data-id="${esc(p.id)}">Change email</button>
    </div>
    ${S.emailEdit === p.id ? `<div class="row" style="grid-column:1/-1"><input id="newEmail-${esc(p.id)}" type="email" placeholder="New email for ${esc(p.full_name || "this person")}" style="flex:1;min-width:200px"><button class="btn small" data-act="email-cancel">Cancel</button><button class="btn small primary" data-act="email-save" data-id="${esc(p.id)}">Save new email</button></div>` : ""}
  </div>`;
  const noCap = sections().filter(x => !ppl.some(p => p.active && (p.captain_sections || []).includes(x.key))).map(x => x.label);
  const fin = ppl.filter(p => p.active && p.is_finance).length;
  return `<div><h2>People</h2><p class="lede">Activate new accounts, choose each section's captains (1st approval) and the finance approvers (2nd approval), and set how each coach is paid. A section can have several captains; any one of them can approve. Each person is paid hours either at rates you set per timesheet heading, or at their own rates (they type them; approvers see these flagged). Add a retainer for coaches paid a fixed amount, either per month or once per season (a season retainer can only be claimed once). Everyone active can submit claims.</p></div>
    ${fin < 2 ? `<div class="notice warn">${fin ? "Only one finance approver is set. Add a second (e.g. the Chairperson) so they can approve each other's claims." : "No finance approver is set yet, so no claim can get its 2nd approval."}</div>` : ""}
    ${noCap.length ? `<div class="notice warn">No captain yet for: ${esc(noCap.join(", "))}. Until one is set, a finance approver gives the 1st approval for these sections.</div>` : ""}
    <section class="panel" style="gap:0;padding-block:6px">${ppl.length ? ppl.map(row).join("") : `<p class="sub">Nobody has created an account yet.</p>`}</section>`;
}
const rateVal = v => { v = String(v || "").trim(); return v === "" ? null : num(v); };
async function savePerson(id){
  const r = document.querySelector(`[data-person="${CSS.escape(id)}"]`);
  const q = s => r.querySelector(s);
  const args = {p_user:id, p_active:q('[data-r="active"]').checked, p_is_admin:q('[data-r="admin"]').checked, p_is_bookkeeper:q('[data-r="books"]').checked,
    p_approver_types:[...r.querySelectorAll('[data-r="ap"]:checked')].map(i => i.value),
    p_coaching_rate: null, p_umpiring_rate: null, p_can_log_suppliers: q('[data-r="sup"]').checked,
    p_retainer_amount: rateVal(q('[data-r="retainer"]').value), p_own_rates: (r.querySelector('[data-r="payby"]:checked') || {}).value === "own", p_retainer_period: q('[data-r="retainer-period"]').value};
  const {error} = await S.sb.rpc("admin_update_user", args);
  if (error){ toast(errText(error)); return; }
  const ar = {}; r.querySelectorAll("[data-actrate]").forEach(i => { const v = String(i.value).trim(); if (v !== "") ar[i.dataset.actrate] = String(Math.round(num(v) * 100) / 100); });
  const e2 = (await S.sb.rpc("admin_set_activity_rates", {p_user: id, p_rates: ar})).error || (await S.sb.rpc("admin_set_approver_roles", {p_user: id, p_sections: [...r.querySelectorAll('[data-r="cap"]:checked')].map(i => i.value), p_finance: q('[data-r="finance"]').checked})).error;
  if (e2){ toast(errText(e2)); return; }
  toast("Saved " + (S.people[id] && S.people[id].full_name || "")); await loadAll(false);
}

/* ---------- admin: settings ---------- */
function viewSettings(){
  return `<div><h2>Settings</h2><p class="lede">Club-wide settings for claims.</p></div>
  <section class="panel"><div class="grid">
    <label>Club mileage rate (£ per mile)<input id="sRate" type="number" step="0.01" min="0" inputmode="decimal" value="${S.settings.mileage_rate == null ? "" : esc(S.settings.mileage_rate)}" placeholder="e.g. 0.30"></label>
    <label>Free miles not claimable<input id="sFree" type="number" step="1" min="0" inputmode="numeric" value="${S.settings.mileage_free_miles == null ? 50 : esc(S.settings.mileage_free_miles)}"></label>
    <label>Free miles apply<select id="sBasis"><option value="journey" ${S.settings.mileage_free_basis !== "claim" ? "selected" : ""}>Per journey (a return trip counts as one)</option><option value="claim" ${S.settings.mileage_free_basis === "claim" ? "selected" : ""}>Per claim</option></select></label>
    <label>Budget areas <span class="hint">One per line</span><textarea id="sAreas" rows="7">${esc((S.settings.budget_areas || DEFAULT_AREAS).join("\n"))}</textarea></label>
  </div><div class="row end"><button class="btn primary" data-act="save-settings">Save settings</button></div></section>
  <section class="panel" id="secEditor">
    <div><h3>Sections</h3><p class="sub" style="margin:4px 0 0">Every claim is for one section. That section's captains give the 1st approval; choose captains in People. A finance approver gives the 2nd approval for every section.</p></div>
    <div class="tablebox"><table class="lines"><thead><tr><th>Section</th><th>Captains</th><th></th></tr></thead><tbody>
    ${secDraft().map((x, i) => `<tr><td><input data-sec-i="${i}" value="${esc(x.label)}" aria-label="Section name"></td><td class="sub" style="padding-top:12px">${esc(Object.values(S.people).filter(p => p.active && (p.captain_sections || []).includes(x.key)).map(p => p.full_name).join(", ") || "None yet")}</td><td><button class="btn small danger" data-act="sec-del" data-i="${i}" aria-label="Remove section">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><button class="btn small" data-act="sec-add">+ Add section</button><button class="btn primary" data-act="sec-save">Save sections</button></div>
  </section>
  <section class="panel" id="actEditor">
    <div><h3>Timesheet headings</h3><p class="sub" style="margin:4px 0 0">The headings coaches claim hours under, on payroll and invoice claims. Each person's rate for each heading is set in People.</p></div>
    <div class="tablebox"><table class="lines"><thead><tr><th>Heading</th><th>Group</th><th></th></tr></thead><tbody>
    ${actDraft().map((a, i) => `<tr><td><input data-act-i="${i}" data-act-k="label" value="${esc(a.label)}" aria-label="Heading name"></td><td><select data-act-i="${i}" data-act-k="group" aria-label="Group">${ACT_GROUPS.concat(ACT_GROUPS.includes(a.group) || !a.group ? [] : [a.group]).map(g => `<option ${g === a.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></td><td><button class="btn small danger" data-act="act-del" data-i="${i}" aria-label="Remove heading">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><button class="btn small" data-act="act-add">+ Add heading</button><button class="btn primary" data-act="act-save">Save headings</button></div>
  </section>`;
}
function secDraft(){ if (!S.secDraft) S.secDraft = JSON.parse(JSON.stringify(sections())); return S.secDraft; }
function actDraft(){ if (!S.actDraft) S.actDraft = JSON.parse(JSON.stringify(acts())); return S.actDraft; }

/* ---------- uploads ---------- */
async function uploadFiles(files){
  const list = $("#fileList");
  for (const f of files){
    if (f.size > 20 * 1024 * 1024){ toast(`${f.name} is over 20 MB`); continue; }
    const tag = document.createElement("span"); tag.className = "file sub"; tag.textContent = "Uploading " + f.name + "…"; if (list) list.appendChild(tag);
    const safe = f.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${S.user.id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}-${safe}`;
    const {error} = await S.sb.storage.from("receipts").upload(path, f, {contentType: f.type || undefined});
    tag.remove();
    if (error){ toast(`${f.name} didn't upload: ${errText(error)}`); continue; }
    S.draft.attachments.push({path, name:f.name, size:f.size});
  }
  saveLocalDraft();
  const fl = $("#fileList"); if (fl) fl.innerHTML = filesHtml(S.draft.attachments, true);
  const fi = $("#fFile"); if (fi) fi.value = "";
}
async function openFile(path){
  const w = window.open("", "_blank");
  const {data, error} = await S.sb.storage.from("receipts").createSignedUrl(path, 600);
  if (error || !data){ if (w) w.close(); toast("That file couldn't be opened."); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}

/* ---------- local draft (this browser only) ---------- */
const DRAFT_KEY = () => "rhc-draft-" + (S.user ? S.user.id : "");
function saveLocalDraft(){ try { if (S.draft && !S.draft.editingId) localStorage.setItem(DRAFT_KEY(), JSON.stringify(S.draft)); } catch (e) {} }
function loadLocalDraft(){ try { const s = localStorage.getItem(DRAFT_KEY()); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
function clearLocalDraft(){ try { localStorage.removeItem(DRAFT_KEY()); } catch (e) {} }

/* ---------- data ---------- */
async function loadClaims(){
  const {data, error} = await S.sb.from("claims").select("*").order("submitted_at", {ascending:false}).limit(2000);
  if (!error) S.claims = data || [];
}
async function loadAll(first){
  const uid = S.user.id;
  const [p, s, pp, n, bd, cp] = await Promise.all([
    S.sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
    S.sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    S.sb.from("profiles").select("*"),
    S.sb.rpc("staff_names"),
    S.sb.from("bank_details").select("*"),
    S.sb.from("claim_payees").select("*")
  ]);
  S.me = p.data || null;
  if (s.data) S.settings = s.data;
  S.people = Object.fromEntries((pp.data || []).map(x => [x.id, x]));
  S.names = Object.fromEntries((n.data || []).map(x => [x.id, x.full_name]));
  S.banks = Object.fromEntries((bd.data || []).map(x => [x.user_id, x]));
  S.payees = Object.fromEntries((cp.data || []).map(x => [x.claim_id, x]));
  S.myBank = S.banks[uid] || null;
  await loadClaims();
  S.loaded = true;
  if (first){ S.tab = S.me && S.me.active ? homeTab() : "new"; S.draft = loadLocalDraft(); subscribe(); render(); }
  else liveRender();
}
let reloadTimer = null;
function scheduleReload(){ clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (S.user) loadAll(false); }, 500); }
function subscribe(){
  unsubscribe();
  S.channel = S.sb.channel("rhc-claims")
    .on("postgres_changes", {event:"*", schema:"public", table:"claims"}, scheduleReload)
    .on("postgres_changes", {event:"*", schema:"public", table:"profiles"}, scheduleReload)
    .subscribe();
}
function unsubscribe(){ if (S.channel){ S.sb.removeChannel(S.channel); S.channel = null; } }

async function rpc(name, args, okMsg){
  const {data, error} = await S.sb.rpc(name, args);
  if (error){ toast(errText(error)); return null; }
  if (okMsg) toast(typeof okMsg === "function" ? okMsg(data) : okMsg);
  await loadAll(false); render();
  return data == null ? true : data;
}

/* ---------- events ---------- */
document.addEventListener("submit", e => { const f = e.target.closest("form[data-form]"); if (!f) return; e.preventDefault(); handleAuth(f); });
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b || b.disabled) return;
  const a = b.dataset.act, id = b.dataset.id;
  const claim = () => S.claims.find(x => x.id === id);
  switch (a){
    case "auth": S.authView = b.dataset.v; S.authMsg = ""; render(); break;
    case "signout": await S.sb.auth.signOut(); break;
    case "reload": await loadAll(false); render(); break;
    case "tab": S.actDraft = null; S.secDraft = null; S.tab = b.dataset.tab; if (S.tab !== "new") S.lastSubmitted = null; S.editingDetails = false; render(); window.scrollTo(0,0); break;
    case "type": { const k = S.draft; S.draft = blankDraft(b.dataset.type); if (k){ S.draft.section = k.section || S.draft.section; S.draft.budget_area = k.budget_area; S.draft.team = k.team; S.draft.description = k.description; } saveLocalDraft(); render(); break; }
    case "add-line": { const last = S.draft.lines[S.draft.lines.length - 1] || {}; const n = {date: last.date || today()}; if (last.activity) n.activity = last.activity; if (last.item) n.item = last.item; if (last.item === "activity") n.activity_key = last.activity_key || ""; S.draft.lines.push(n); render(); break; }
    case "del-line": S.draft.lines.splice(+b.dataset.i, 1); render(); break;
    case "del-file": { const [gone] = S.draft.attachments.splice(+b.dataset.i, 1); $("#fileList").innerHTML = filesHtml(S.draft.attachments, true); saveLocalDraft();
      if (gone && !S.draft.editingId) S.sb.storage.from("receipts").remove([gone.path]); break; }
    case "open-file": openFile(b.dataset.path); break;
    case "reset": S.draft = blankDraft(S.draft && S.draft.type); saveLocalDraft(); render(); break;
    case "cancel-edit": S.draft = loadLocalDraft(); S.tab = "mine"; render(); break;
    case "submit": submitDraft(); break;
    case "another": S.lastSubmitted = null; S.draft = blankDraft(); render(); break;
    case "edit-details": S.tab = "mine"; S.editingDetails = true; render(); break;
    case "cancel-details": S.editingDetails = false; render(); break;
    case "change-email": {
      const email = $("#pEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ toast("Enter a valid email address"); break; }
      const {error} = await S.sb.auth.updateUser({email}, {emailRedirectTo: location.origin + location.pathname});
      if (error){ toast(errText(error)); break; }
      toast("Check your inbox to confirm the new email. You may need to confirm from your old address too."); break;
    }
    case "change-password": {
      const a1 = $("#pPass").value, a2 = $("#pPass2").value;
      if (a1.length < 8){ toast("Use a password of at least 8 characters"); break; }
      if (a1 !== a2){ toast("The two passwords don't match"); break; }
      const {error} = await S.sb.auth.updateUser({password: a1});
      if (error){ toast(errText(error)); break; }
      $("#pPass").value = $("#pPass2").value = ""; toast("Password changed"); break;
    }
    case "download-data": {
      const mine = S.claims.filter(c => c.claimant === S.me.id);
      const {id, email, full_name, club_role, created_at, accepted_terms_at, coaching_rate, umpiring_rate} = S.me;
      const data = {exported_at: new Date().toISOString(), account: {id, email, full_name, club_role, created_at, accepted_terms_at, coaching_rate, umpiring_rate}, bank_details: S.myBank, claims: mine};
      const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `my-claims-data-${today()}.json`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); break;
    }
    case "accept-terms": rpc("accept_terms", {}, "Thanks"); break;
    case "coach-view": S.viewAsCoach = !S.viewAsCoach; S.tab = S.viewAsCoach ? "mine" : homeTab(); S.editingDetails = false; render(); window.scrollTo(0,0); break;
    case "copy": { const t = b.dataset.text; try { await navigator.clipboard.writeText(t); toast("Copied " + t); } catch (e) { toast("Select the text and copy it"); } break; }
    case "save-bank": {
      const nm = $("#bName").value.trim(), sc = $("#bSort").value.replace(/\D/g, ""), an = $("#bAcct").value.replace(/\D/g, "");
      if (!nm){ toast("Add the name on the account"); break; }
      if (sc.length !== 6){ toast("A sort code has 6 digits, e.g. 12-34-56"); break; }
      if (an.length !== 8){ toast("A UK account number has 8 digits"); break; }
      const {error} = await S.sb.rpc("set_my_bank_details", {p_account_name: nm, p_sort_code: sc, p_account_number: an});
      if (error){ toast(errText(error)); break; }
      toast("Bank details saved"); await loadAll(false); render(); break;
    }
    case "send-reset": { const p = S.people[id]; if (!p) break; b.disabled = true;
      const {error} = await S.sb.auth.resetPasswordForEmail(p.email, {redirectTo: location.origin + location.pathname});
      b.disabled = false; toast(error ? errText(error) : `Password reset link sent to ${p.email}`); break; }
    case "email-edit": S.emailEdit = id; render(); { const t = $("#newEmail-" + CSS.escape(id)); if (t) t.focus(); } break;
    case "email-cancel": S.emailEdit = null; render(); break;
    case "email-save": {
      const t = $("#newEmail-" + CSS.escape(id)), email = t ? t.value.trim() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ toast("Enter a valid email address"); break; }
      b.disabled = true;
      const {data, error} = await S.sb.functions.invoke("admin-users", {body: {action: "change_email", user_id: id, email}});
      b.disabled = false;
      if (error){ let msg = errText(error); try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) {} toast(msg); break; }
      S.emailEdit = null; toast("Email changed. They can sign in with the new address straight away."); await loadAll(false); render(); break;
    }
    case "save-details": {
      const full_name = $("#pName").value.trim(), club_role = $("#pRole").value.trim();
      if (!full_name){ toast("Add your name"); break; }
      const {error} = await S.sb.from("profiles").update({full_name, club_role}).eq("id", S.user.id);
      if (error){ toast(errText(error)); break; }
      S.editingDetails = false; toast("Details saved"); await loadAll(false); render(); break;
    }
    case "edit-claim": { const c = claim(); if (!c) break;
      S.draft = {editingId:c.id, editingRef:c.ref, type:c.type, section:c.section || "", budget_area:c.budget_area, team:c.team || "", description:c.description, invoice_number:c.invoice_number || "", invoice_date:c.invoice_date || today(), pay_period:c.pay_period || "", lines:JSON.parse(JSON.stringify(c.lines || [])).map(l => isMixed(c.type) ? (["coaching","umpiring"].includes(lineItem(l)) ? {date: l.date, item: "activity", activity_key: "", session: l.session, hours: l.hours} : Object.assign(l, {item: lineItem(l)}, l.own_rate ? {} : {rate: undefined})) : l), attachments:(c.attachments || []).slice(), declare:false,
        supplier_name:c.supplier_name || "", supplier_email:c.supplier_email || "", due_date:c.due_date || "", vat_invoice:!!c.vat_invoice, supplier_vat_number:c.supplier_vat_number || "",
        bank_name:(S.payees[c.id] || {}).account_name || "", bank_sort:fmtSort((S.payees[c.id] || {}).sort_code), bank_acct:(S.payees[c.id] || {}).account_number || ""};
      S.tab = "new"; S.lastSubmitted = null; render(); window.scrollTo(0,0); break; }
    case "delete-claim": S.confirmDelete = id; render(); break;
    case "delete-cancel": S.confirmDelete = null; render(); break;
    case "delete-yes": { S.confirmDelete = null; b.disabled = true;
      const {data, error} = await S.sb.rpc("delete_claim", {p_claim_id: id});
      if (error){ toast(errText(error)); b.disabled = false; break; }
      const paths = (Array.isArray(data) ? data : []).map(a => a.path).filter(Boolean);
      if (paths.length) S.sb.storage.from("receipts").remove(paths);
      toast("Claim deleted"); await loadAll(false); render(); break; }
    case "approve": { b.disabled = true; const c = claim(); rpc("approve_claim", {p_claim_id:id}, r => r === "approved" ? `Second approval given. ${c ? c.ref : "The claim"} is now with the bookkeeper` : `First approval given for ${c ? c.ref : "the claim"}`); break; }
    case "reject": S.decideOpen = id; render(); { const t = $("#rejNote-" + CSS.escape(id)); if (t) t.focus(); } break;
    case "reject-cancel": S.decideOpen = null; render(); break;
    case "reject-yes": { const t = $("#rejNote-" + CSS.escape(id)), note = t ? t.value.trim() : "";
      if (!note){ toast("Add a reason so the claimant can fix it"); break; }
      S.decideOpen = null; rpc("return_claim", {p_claim_id:id, p_reason:note}, "Claim returned to the claimant"); break; }
    case "processed": { b.disabled = true; const inp = $("#payRef-" + CSS.escape(id)); rpc("mark_processed", {p_claim_id:id, p_payment_ref: inp ? inp.value.trim() : ""}, "Marked as paid"); break; }
    case "bk": S.bkFilter = b.dataset.f; render(); break;
    case "bk-clear": S.bk = {month:"", type:"", area:"", section:"", q:"", sort:S.bk.sort}; render(); break;
    case "export": exportCsv(false); break;
    case "export-all": exportCsv(true); break;
    case "save-person": savePerson(id); break;
    case "sec-add": secDraft().push({key: "", label: ""}); render(); { const ins = document.querySelectorAll("[data-sec-i]"); if (ins.length) ins[ins.length - 1].focus(); } break;
    case "sec-del": secDraft().splice(+b.dataset.i, 1); render(); break;
    case "sec-save": {
      const used = new Set(), list = [];
      for (const x of secDraft()){ const label = String(x.label || "").trim(); if (!label){ toast("Every section needs a name"); return; }
        let key = x.key || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 34) || "section";
        while (used.has(key)) key = key.slice(0, 34) + "_" + Math.random().toString(36).slice(2, 5);
        used.add(key); list.push({key, label}); }
      const {error} = await S.sb.rpc("admin_update_sections", {p_list: list});
      if (error){ toast(errText(error)); break; }
      S.secDraft = null; toast("Sections saved"); await loadAll(false); render(); break;
    }
    case "act-add": actDraft().push({key: "", label: "", group: "Programmes", rate: null}); render(); { const ins = document.querySelectorAll('[data-act-k="label"]'); if (ins.length) ins[ins.length - 1].focus(); } break;
    case "act-del": actDraft().splice(+b.dataset.i, 1); render(); break;
    case "act-save": {
      const used = new Set(), list = [];
      for (const a of actDraft()){ const label = String(a.label || "").trim(); if (!label){ toast("Every heading needs a name"); return; }
        let key = a.key || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 34) || "heading";
        while (used.has(key)) key = key.slice(0, 34) + "_" + Math.random().toString(36).slice(2, 5);
        used.add(key); list.push({key, label, group: a.group || "Programmes", rate: null}); }
      const {error} = await S.sb.rpc("admin_update_payroll_activities", {p_list: list});
      if (error){ toast(errText(error)); break; }
      S.actDraft = null; toast("Headings saved"); await loadAll(false); render(); break;
    }
    case "save-settings": { const rate = $("#sRate").value.trim();
      rpc("admin_update_settings", {p_mileage_rate: rate === "" ? null : num(rate), p_budget_areas: $("#sAreas").value.split("\n").map(x => x.trim()).filter(Boolean), p_coaching_rate: null, p_umpiring_rate: null, p_mileage_free_miles: num($("#sFree").value), p_mileage_passenger_rate: 0, p_mileage_free_basis: $("#sBasis").value}, "Settings saved"); break; }
  }
});
function onBkField(e){
  const t = e.target; if (!t.dataset || !t.dataset.bkK) return false;
  S.bk[t.dataset.bkK] = t.value;
  if (t.dataset.bkK === "q"){ if (e.type !== "input") return true; const pos = t.selectionStart; render(); const n = $("#bk-q"); if (n){ n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) {} } }
  else if (e.type === "change") render();
  return true;
}
function onPayBy(e){
  const t = e.target; if (!t.dataset || t.dataset.r !== "payby") return false;
  const row = t.closest("[data-person]"), d = row && row.querySelector('[data-r="heading-rates"]');
  if (d){ d.hidden = t.value === "own"; if (t.value !== "own") d.open = true; }
  return true;
}
function onField(e){
  if (onPayBy(e)) return;
  if (onBkField(e)) return;
  if (e.target.dataset && e.target.dataset.secI != null){ const row = secDraft()[+e.target.dataset.secI]; if (row) row.label = e.target.value; return; }
  if (e.target.dataset && e.target.dataset.actI != null){ const row = actDraft()[+e.target.dataset.actI]; if (row) row[e.target.dataset.actK] = e.target.value; return; }
  const t = e.target, d = S.draft; if (!d || !t.closest("#claimForm")) return;
  const val = t.type === "checkbox" ? t.checked : t.value;
  if (t.dataset.f) { d[t.dataset.f] = val; if (t.dataset.f === "vat_invoice" && e.type === "change"){ render(); return; } }
  else if (t.dataset.line != null){ const l = d.lines[+t.dataset.line]; if (l){ if (t.dataset.k === "item"){ if (String(val).startsWith("a:")){ l.item = "activity"; l.activity_key = String(val).slice(2); } else { l.item = val; delete l.activity_key; } saveLocalDraft(); render(); return; } l[t.dataset.k] = val; recalc(); } }
  clearTimeout(onField._t); onField._t = setTimeout(saveLocalDraft, 400);
}
document.addEventListener("input", onField);
document.addEventListener("change", e => { if (e.target.id === "fFile" && e.target.files && e.target.files.length) { uploadFiles([...e.target.files]); return; } onField(e); });

/* ---------- start ---------- */
function boot(){
  if (!window.supabase || !CFG.supabaseUrl || /YOUR-/.test(CFG.supabaseUrl + CFG.supabaseAnonKey)){
    $("#main").innerHTML = `<section class="panel"><h2>Not connected yet</h2><p class="lede">Add your Supabase project address and key to <code>config.js</code> (see SETUP.md, step 2), then reload this page.</p></section>`;
    return;
  }
  S.sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  S.sb.auth.onAuthStateChange((event, session) => {
    const u = session ? session.user : null;
    // Run outside the callback: Supabase calls made inside it can stall.
    setTimeout(() => {
      if (event === "PASSWORD_RECOVERY"){ S.recovery = true; S.user = u; render(); return; }
      if (S.recovery) return;
      if (u && (!S.user || S.user.id !== u.id)){ S.user = u; S.loaded = false; render(); loadAll(true); }
      else if (!u){ S.user = null; S.me = null; S.claims = []; S.people = {}; S.loaded = false; S.draft = null; S.lastSubmitted = null; unsubscribe(); render(); }
    }, 0);
  });
}
boot();
})();

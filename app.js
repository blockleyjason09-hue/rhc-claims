/* Reading Hockey Club Claims — website logic (version 2: timesheets and expense claims).
   Talks to Supabase (login, database, receipt storage). Every rule about who can
   approve or process is enforced by the database itself. */
(function () {
"use strict";
const CFG = window.RHC_CONFIG || {};
const CLUB = CFG.clubName || "Reading Hockey Club";
const LIBS = {
  exceljs: {url: "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js", ready: () => window.ExcelJS},
  jspdf: {url: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js", ready: () => window.jspdf}
};
const TYPES = {
  timesheet: {label: "Timesheet", short: "Timesheet", blurb: "Hours you coached, umpired or worked for the club. They go into the monthly payroll."},
  expense: {label: "Expense claim", short: "Expense claim", blurb: "You bought something for RHC or GARC, or drove on club business, and want it back."}
};
const STATUS = {
  timesheet: {pending: ["Awaiting approval", "pending"], approved: ["Approved · ready for payroll", "approved"], processed: ["In payroll", "processed"], returned: ["Returned", "returned"], withdrawn: ["Withdrawn", "withdrawn"]},
  expense: {pending: ["Awaiting finance approval", "pending"], approved: ["With bookkeeper", "approved"], processed: ["Processed", "processed"], returned: ["Returned", "returned"], withdrawn: ["Withdrawn", "withdrawn"]}
};
const st = c => { const x = (STATUS[c.type] || STATUS.expense)[c.status] || ["", "pending"]; return {label: x[0], cls: x[1]}; };
const ACT_GROUPS = ["Junior coaching","Senior coaching","Programmes","Umpiring","Schools","Club duties"];

const S = {sb:null,user:null,me:null,settings:{},claims:[],people:{},names:{},banks:{},myBank:null,viewAsCoach:false,
  tab:null,draft:null,authView:"signin",authMsg:"",recovery:false,lastSubmitted:null,decideOpen:null,confirmDelete:null,alloc:{},
  exFilter:"ready",ex:{month:"",entity:"",area:"",q:""},payMonth:"",confirmRun:false,editingDetails:false,channel:null,loaded:false};

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(num(n) * 100) / 100;
const gbp = n => "£" + r2(n).toLocaleString("en-GB", {minimumFractionDigits:2, maximumFractionDigits:2});
const fmtH = n => r2(n).toLocaleString("en-GB") + " h";
const fmtDate = s => { if (!s) return ""; const d = new Date(String(s).length === 10 ? s + "T12:00:00Z" : s); return isNaN(d) ? esc(s) : d.toLocaleDateString("en-GB", {day:"numeric", month:"short", year:"numeric"}); };
const isoDay = s => (s || "").slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const blank = v => v == null || String(v).trim() === "";
const fmtSort = v => { v = String(v || "").replace(/\D/g, ""); return v.length === 6 ? v.slice(0,2) + "-" + v.slice(2,4) + "-" + v.slice(4) : v; };
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 3600); }
function errText(e, fallback){ const m = e && (e.message || e.error_description); return m ? m.replace(/^.*?:\s*(?=[A-Z])/,"") : (fallback || "Something went wrong. Try again."); }
function personName(id){ const p = S.people[id]; return (p && p.full_name) || S.names[id] || "Club member"; }

/* ---------- months and the payroll calendar ---------- */
const addMonth = (m, k) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo - 1 + k, 1)).toISOString().slice(0, 7); };
const monthName = m => m ? new Date(m + "-15T12:00:00Z").toLocaleDateString("en-GB", {month:"long", year:"numeric"}) : "";
const monthShort = m => m ? new Date(m + "-15T12:00:00Z").toLocaleDateString("en-GB", {month:"long"}) : "";
const lastDay = m => new Date(Date.UTC(+m.slice(0,4), +m.slice(5,7), 0)).getUTCDate();
const dueDay = () => Math.min(28, Math.max(1, Math.round(num(S.settings.timesheet_due_day) || 10)));
const dueDate = m => `${addMonth(m, 1)}-${String(dueDay()).padStart(2, "0")}`;
/* Coaches are told an earlier deadline (the 7th); the cut-off for that month's payroll stays later (the 10th). */
const askDay = () => Math.min(dueDay(), Math.max(1, Math.round(num(S.settings.coach_deadline_day) || 7)));
const askDate = m => `${addMonth(m, 1)}-${String(askDay()).padStart(2, "0")}`;
const ordinal = n => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
const reminderDays = () => (Array.isArray(S.settings.reminder_days) && S.settings.reminder_days.length ? S.settings.reminder_days : [1, 5]).map(Number).sort((a, b) => a - b);
const holPct = () => S.settings.holiday_pay_pct == null ? 12.07 : num(S.settings.holiday_pay_pct);
const payCode = () => S.settings.payroll_code || "80501";
/* A timesheet for month M is due by the due day of the next month. If it arrives later,
   it rolls into the next payroll run that hasn't closed yet. */
function payrollMonthFor(work, submittedDay){ let m = work; while (submittedDay > dueDate(m)) m = addMonth(m, 1); return m; }
const thisMonth = () => today().slice(0, 7);
/* Mileage on expense claims: the first free miles of each journey aren't claimable (a return trip counts as one journey). */
const mileRate = () => S.settings.mileage_rate == null ? 0.30 : num(S.settings.mileage_rate);
const freeMiles = () => S.settings.mileage_free_miles == null ? 50 : num(S.settings.mileage_free_miles);
const isMile = l => l && l.kind === "mileage";
/* The club's mileage policy: the reason for a journey decides how it's paid. */
const BASIS = {coaching:"Coaching away from RHC", first_xi:"1st XI away match", chair:"Agreed in advance with the Chair", contract:"Under my contract"};
const minPlayers = () => S.settings.first_xi_min_players == null ? 3 : num(S.settings.first_xi_min_players);
const pence = v => `${r2(num(v) * 100)}p`;
function myBases(){ const m = S.me || {}; return m.contract_mileage ? ["contract","chair"] : [...(m.is_first_xi ? ["first_xi"] : []), "coaching", "chair"]; }
function basisRule(b){
  const m = S.me || {};
  if (b === "first_xi") return `Away matches only, with at least ${minPlayers()} players in the car. ${pence(mileRate())} a mile for the shorter of the round trip from the Club or from where you set off.`;
  if (b === "chair") return `Any other journey, only if the Chair agreed it before you drove. ${pence(mileRate())} for every mile.`;
  if (b === "contract") return `As set out in your contract: ${pence(m.contract_mileage_rate)} a mile${num(m.contract_free_miles) ? `; the first ${num(m.contract_free_miles)} miles of each journey aren't claimable` : ""}.`;
  return `Coaching you did away from Reading Hockey Club. ${pence(mileRate())} a mile; the first ${freeMiles()} miles of each journey aren't claimable (a return trip counts as one journey).`;
}
function mileCalc(l){
  const b = l.basis || "coaching", me = S.me || {};
  if (b === "first_xi"){ const a = num(l.rt_club), o = num(l.rt_origin), m = a && o ? Math.min(a, o) : (a || o); return {m, ch: m, rate: mileRate(), amt: r2(m * mileRate())}; }
  const m = num(l.miles) * (l.ret ? 2 : 1);
  if (b === "chair") return {m, ch: m, rate: mileRate(), amt: r2(m * mileRate())};
  if (b === "contract"){ const r = num(me.contract_mileage_rate), ch = Math.max(0, m - num(me.contract_free_miles)); return {m, ch, rate: r, amt: r2(ch * r)}; }
  const ch = Math.max(0, m - freeMiles()); return {m, ch, rate: mileRate(), amt: r2(ch * mileRate())};
}
const mileText = l => l.basis === "first_xi" ? `Mileage, 1st XI away match: ${l.purpose || ""} (${num(l.players)} players; round trip ${num(l.rt_club)} mi from Club, ${num(l.rt_origin)} mi from start)`
  : `Mileage, ${({coaching:"coaching away from RHC", chair:"agreed in advance with the Chair", contract:"under contract"})[l.basis || "coaching"] || ""}: ${l.from || ""} to ${l.to || ""}${l.ret ? " and back" : ""}${l.purpose ? " – " + l.purpose : ""}${l.basis === "chair" && l.chair_date ? ` (agreed ${fmtDate(l.chair_date)})` : ""}`;
const exLineText = l => isMile(l) ? `${mileText(l)}: ${num(l.claimable_miles)} mi at ${pence(l.rate)}` : l.item;
const needsReceipt = d => d.lines.some(l => !isMile(l));
const maxDay = () => S.settings.max_daily_hours == null ? 5 : num(S.settings.max_daily_hours);
/* Possible double claims: the same heading on the same day as another session, or more than the
   daily limit across all of someone's timesheets. The database runs the same check. */
function sessionChecks(lines, claimant, exceptId){
  const others = S.claims.filter(c => c.type === "timesheet" && c.claimant === claimant && c.id !== exceptId && ["pending","approved","processed"].includes(c.status));
  const out = [], perDay = {};
  for (const c of others) for (const l of c.lines || []){ if (l.date) perDay[l.date] = (perDay[l.date] || 0) + num(l.hours); }
  lines.forEach((l, i) => {
    if (!l.date || !l.activity_key) return;
    const label = (actByKey(l.activity_key) || {}).label || "that heading";
    for (const c of others) for (const o of c.lines || []) if (o.date === l.date && o.activity_key === l.activity_key)
      out.push({kind:"dup", date:l.date, i, text:`${fmtDate(l.date)}: ${label} is already claimed in ${c.ref} (${fmtH(o.hours)}${o.session ? ", " + o.session : ""}).`});
    const j = lines.findIndex((x, k) => k < i && x.date === l.date && x.activity_key === l.activity_key);
    if (j >= 0) out.push({kind:"dup", date:l.date, i, text:`${fmtDate(l.date)}: ${label} appears twice on this timesheet (sessions ${j + 1} and ${i + 1}).`});
  });
  const day = Object.assign({}, perDay);
  for (const l of lines) if (l.date) day[l.date] = (day[l.date] || 0) + num(l.hours);
  for (const [date, h] of Object.entries(day)) if (h > maxDay() && lines.some(l => l.date === date && num(l.hours) > 0))
    out.push({kind:"day", date, text:`${fmtDate(date)}: ${fmtH(h)} in total that day${perDay[date] ? ` (including ${fmtH(perDay[date])} on other timesheets)` : ""}, over the ${fmtH(maxDay())} daily limit.`});
  return out;
}

/* ---------- roles ---------- */
const coachView = () => !!S.viewAsCoach;
const sections = () => Array.isArray(S.settings.sections) ? S.settings.sections : [];
const sectionLabel = k => ((sections().find(x => x.key === k) || {}).label) || "";
const myCaptain = () => coachView() ? [] : ((S.me && S.me.captain_sections) || []);
const isDoH = () => !coachView() && !!(S.me && S.me.is_dofh);
const isFinance = () => !coachView() && !!(S.me && S.me.is_finance);
const isBookkeeper = () => !coachView() && !!(S.me && S.me.is_bookkeeper);
const isAdmin = () => !coachView() && !!(S.me && S.me.is_admin);
const isApproverAny = () => myCaptain().length > 0 || isDoH() || isFinance();
const canPayroll = () => isBookkeeper() || isDoH() || isAdmin();
function canApprove(c){
  if (c.status !== "pending" || c.claimant === S.me.id) return false;
  return c.type === "timesheet" ? (isDoH() || myCaptain().includes(c.section)) : isFinance();
}
const canReturn = canApprove;
function myRoles(){ const r = ["Coach"]; if (myCaptain().length) r.push("Captain"); if (isDoH()) r.push("Director of Hockey"); if (isFinance()) r.push("Finance"); if (isBookkeeper()) r.push("Bookkeeper"); if (isAdmin()) r.push("Admin"); return r; }
const toApprove = () => S.claims.filter(canApprove);
const readyToProcess = () => S.claims.filter(c => c.type === "expense" && c.status === "approved");
const pendingPeople = () => Object.values(S.people).filter(p => !p.active);
function homeTab(){
  if (isApproverAny() && toApprove().length) return "approve";
  if (isBookkeeper() && readyToProcess().length) return "expenses";
  return S.claims.some(c => c.claimant === S.me.id) ? "mine" : "new";
}

/* ---------- timesheet headings and rates ---------- */
const acts = () => Array.isArray(S.settings.payroll_activities) ? S.settings.payroll_activities : [];
const actByKey = k => acts().find(a => a.key === k) || null;
const actLabel = l => l.activity || (actByKey(l.activity_key) || {}).label || "Hours";
const ownRates = () => !!(S.me && S.me.own_rates);
function myRate(key){ const v = S.me && S.me.activity_rates && S.me.activity_rates[key]; return blank(v) ? null : num(v); }
function lineRate(l){ return ownRates() ? (num(l.rate) > 0 ? num(l.rate) : null) : myRate(l.activity_key); }
const actGroups = () => ACT_GROUPS.concat([...new Set(acts().map(a => a.group))].filter(g => g && !ACT_GROUPS.includes(g)));

/* ---------- budget lines ---------- */
const budgetLines = () => Array.isArray(S.settings.budget_lines) ? S.settings.budget_lines : [];
const blName = x => x ? (x.code ? x.code + " " : "") + x.label : "";
const blByKey = k => budgetLines().find(x => x.key === k);
/* The budget's areas: four under RHC, plus GARC. */
const AREAS = [["hockey","Hockey","RHC"],["camps","Camps","RHC"],["ta","Talent Academy","RHC"],["schools","School Partnerships","RHC"],["garc","GARC","GARC"]];
const areaEnt = k => (AREAS.find(a => a[0] === k) || [])[2] || "";
const areaName = k => { const a = AREAS.find(x => x[0] === k); return !a ? "" : a[2] === "GARC" ? "GARC" : "RHC – " + a[1]; };
const lineAreas = x => Array.isArray(x.areas) && x.areas.length ? x.areas : [...(x.rhc ? ["hockey"] : []), ...(x.garc ? ["garc"] : [])];
const chargeText = l => l && l.budget_label ? `${l.area ? areaName(l.area) : l.charge_to} · ${(l.budget_code ? l.budget_code + " " : "") + l.budget_label}` : "";
const ENTITY = {RHC: "Reading Hockey Club (RHC)", GARC: "GARC"};

/* ---------- files: download, libraries ---------- */
async function saveFile(filename, blob){
  let dl = null;
  try { if (window.claude && window.claude.use) dl = await window.claude.use("downloads"); } catch (e) { dl = null; }
  if (dl){
    try { await dl.save({filename, data: blob}); }
    catch (e) { if (!e || e.code !== "declined") toast("That file couldn't be saved here."); }
    return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const libLoads = {};
function loadLib(k){
  const L = LIBS[k]; if (L.ready()) return Promise.resolve(L.ready());
  if (!libLoads[k]) libLoads[k] = new Promise((res, rej) => { const s = document.createElement("script"); s.src = L.url; s.onload = () => res(L.ready()); s.onerror = () => { libLoads[k] = null; rej(new Error("Couldn't load " + k)); }; document.head.appendChild(s); });
  return libLoads[k];
}
async function downloadAttachment(a){
  const {data, error} = await S.sb.storage.from("receipts").download(a.path);
  if (error || !data){ toast("That file couldn't be downloaded."); return; }
  await saveFile(a.name || "receipt", data);
}
async function openFile(path){
  const w = window.open("", "_blank");
  const {data, error} = await S.sb.storage.from("receipts").createSignedUrl(path, 600);
  if (error || !data){ if (w) w.close(); toast("That file couldn't be opened."); return; }
  if (w) w.location = data.signedUrl; else location.href = data.signedUrl;
}

/* ---------- header and tabs ---------- */
function tabsList(){
  if (!S.me || !S.me.active) return [];
  const t = [{id:"new",l:"New claim"},{id:"mine",l:"My claims"}];
  if (isApproverAny()) t.push({id:"approve",l:"To approve",n:toApprove().length});
  if (isBookkeeper() || isAdmin()) t.push({id:"expenses",l:"Expenses",n:readyToProcess().length});
  if (canPayroll()) t.push({id:"payroll",l:"Payroll"});
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
  const v = {new:viewNew, mine:viewMine, approve:viewApprove, expenses:viewExpenses, payroll:viewPayroll, people:viewPeople, settings:viewSettings}[S.tab] || viewNew;
  m.innerHTML = (coachView() ? `<div class="notice ok row"><span style="flex:1"><strong>Coach view.</strong> You're seeing the site as a coach would: only New claim and My claims, with only your own claims.</span><button class="btn small" data-act="coach-view">Back to admin view</button></div>` : "") + (S.me.accepted_terms_at ? "" : `<div class="notice warn row"><span style="flex:1">Please read the <a href="privacy.html" target="_blank" rel="noopener">privacy notice</a> and <a href="terms.html" target="_blank" rel="noopener">terms of use</a> for the claims system.</span><button class="btn small primary" data-act="accept-terms">I've read and accept them</button></div>`) + v();
  if (S.tab === "new") recalc();
}
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
    <div><h3>Bank details</h3><p class="sub" style="margin:4px 0 0">Where the club pays your expense claims (timesheets go through payroll). Only you and the bookkeeper can see these. You and the bookkeeper are emailed whenever they change. The club will never ask for your bank details by email.</p></div>
    ${S.myBank ? `<div class="notice">Currently: <strong>${esc(S.myBank.account_name)}</strong>, sort code ${esc(fmtSort(S.myBank.sort_code))}, account ending ${esc(String(S.myBank.account_number).slice(-4))}. Last changed ${fmtDate(S.myBank.updated_at)}.</div>` : `<div class="notice warn">You haven't added bank details yet. You need them before submitting an expense claim.</div>`}
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
function blankDraft(type){
  const m = thisMonth();
  if (type === "timesheet") return {type, editingId:null, editingRef:"", section:lastSection(), work_month:m, description:"", lines:[{date:today(), activity_key:"", session:"", hours:""}], declare:false};
  if (type === "expense") return {type, editingId:null, editingRef:"", entity:"", description:"", team:"", lines:[{date:today(), item:"", supplier:"", amount:""}], attachments:[], declare:false};
  return {type:null};
}
function lastSection(){ try { return localStorage.getItem("rhc-last-section") || ""; } catch (e) { return ""; } }
function viewNew(){
  if (S.lastSubmitted) return submittedView();
  if (!S.draft) S.draft = blankDraft();
  const d = S.draft;
  let h = `<section class="panel">
    <div><h2>${d.editingId ? "Edit and resubmit " + esc(d.editingRef) : "New claim"}</h2><p class="lede">What would you like to claim?</p></div>
    <div class="types two" role="group" aria-label="Claim type">${Object.entries(TYPES).map(([k,t]) => `<button class="type" data-act="type" data-type="${k}" aria-pressed="${d.type === k}" ${d.editingId ? "disabled" : ""}><b>${esc(t.short)}</b><span>${esc(t.blurb)}</span></button>`).join("")}</div>
  </section>`;
  if (!d.type) return h + inProgressHint();
  if (d.type === "timesheet") return h + timesheetForm(d);
  if (!d.entity) return h + entityChooser();
  return h + expenseForm(d);
}
function inProgressHint(){
  const open = S.claims.filter(c => c.claimant === S.me.id && ["pending","returned","approved"].includes(c.status)).length;
  return open ? `<div class="notice">You have ${open} claim${open > 1 ? "s" : ""} in progress. <button class="btn small" data-act="tab" data-tab="mine">View my claims</button></div>` : "";
}
function contactLinks(){
  const c = [["the Chair", S.settings.chair_email], ["Finance", S.settings.finance_email]].filter(x => x[1]);
  if (!c.length) return "the Chair or Finance";
  return c.map(([n, e]) => `<a href="mailto:${esc(e)}?subject=${encodeURIComponent("Expense claim: RHC or GARC?")}">${esc(n)}</a>`).join(" or ");
}
function entityChooser(){
  return `<section class="panel" id="entityPick">
    <div><h2>Who is this expense for?</h2><p class="lede">Choose the organisation the money was spent for.</p></div>
    <div class="types two" role="group" aria-label="RHC or GARC">
      <button class="type" data-act="entity" data-entity="RHC"><b>RHC</b><span>Reading Hockey Club: teams, coaching, kit, equipment, travel, match costs.</span></button>
      <button class="type" data-act="entity" data-entity="GARC"><b>GARC</b><span>GARC: the clubhouse, grounds, Hungry Hut and facilities.</span></button>
    </div>
    <div class="notice warn"><strong>Not sure which?</strong> Email ${contactLinks()} before you claim, so it's charged to the right place.</div>
  </section>`;
}
function headingSelect(l, i){
  const opt = a => `<option value="${esc(a.key)}" ${a.key === l.activity_key ? "selected" : ""}>${esc(a.label)}${!ownRates() && myRate(a.key) == null ? " (no rate)" : ""}</option>`;
  return `<select id="ln-${i}-activity_key" data-line="${i}" data-k="activity_key" aria-label="Timesheet heading"><option value="">Choose heading…</option>${actGroups().map(g => { const list = acts().filter(a => (a.group || "Club duties") === g); return list.length ? `<optgroup label="${esc(g)}">${list.map(opt).join("")}</optgroup>` : ""; }).join("")}</select>`;
}
function monthOptions(cur){
  const m = thisMonth(), list = [addMonth(m, -2), addMonth(m, -1), m];
  if (cur && !list.includes(cur)) list.unshift(cur);
  return list.map(x => `<option value="${x}" ${x === cur ? "selected" : ""}>${monthName(x)}</option>`).join("");
}
function timesheetNote(d){
  const pm = payrollMonthFor(d.work_month, today()), late = pm !== d.work_month;
  if (late) return `<div class="notice warn" id="tsNote"><strong>This is a late timesheet.</strong> ${esc(monthName(d.work_month))} timesheets were due by ${fmtDate(askDate(d.work_month))} (final cut-off ${fmtDate(dueDate(d.work_month))}), so these sessions will go into the <strong>${esc(monthName(pm))}</strong> payroll.</div>`;
  if (today() > askDate(d.work_month)) return `<div class="notice warn" id="tsNote"><strong>Past the deadline.</strong> ${esc(monthName(d.work_month))} timesheets were due by ${fmtDate(askDate(d.work_month))}. Submit straight away: until ${fmtDate(dueDate(d.work_month))} they can still go into the ${esc(monthName(d.work_month))} payroll.</div>`;
  return `<div class="notice" id="tsNote">Payroll covers the 1st to the last day of each month. Your ${esc(monthName(d.work_month))} sessions are due by <strong>${fmtDate(askDate(d.work_month))}</strong> and go into the ${esc(monthName(d.work_month))} payroll. You can send sessions one at a time or several together; they're all added up into one payroll record. You'll get reminder emails on the ${reminderDays().map(ordinal).join(" and ")} of each month.</div>`;
}
function timesheetForm(d){
  const m = d.work_month, min = m + "-01", end = m + "-" + String(lastDay(m)).padStart(2, "0"), max = end < today() ? end : today();
  const missing = [...new Set(d.lines.map(l => l.activity_key).filter(k => k && !ownRates() && myRate(k) == null))].map(k => (actByKey(k) || {}).label).filter(Boolean);
  return `<section class="panel" id="claimForm">
    <div class="row"><h2 style="flex:1">Timesheet</h2><span class="sub">${esc(S.me.full_name)} · goes into payroll</span></div>
    <div class="grid">
      <label>Month worked<select id="fMonth" data-f="work_month">${monthOptions(m)}</select></label>
      <label>Section <span class="hint">Its captain or the Director of Hockey approves. If the sessions cover more than one, choose the main one.</span><select id="fSection" data-f="section"><option value="">Choose…</option>${sections().map(x => `<option value="${esc(x.key)}" ${d.section === x.key ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></label>
    </div>
    ${timesheetNote(d)}
    ${missing.length ? `<div class="notice warn">You don't have a rate for ${esc(missing.join(", "))} yet. Ask the club admin to add it before you submit.</div>` : ""}
    <div>
      <h3 style="margin-bottom:8px">Sessions</h3>
      <div class="tablebox"><table class="lines ts"><thead><tr><th>Date</th><th>Timesheet heading</th><th>Comment</th><th class="num">Hours</th>${ownRates() ? `<th class="num">Your rate £/hr</th>` : `<th class="num">Rate</th>`}<th class="num">Amount</th><th></th></tr></thead>
      <tbody>${d.lines.map((l, i) => `<tr>
        <td><input id="ln-${i}-date" type="date" min="${min}" max="${max}" data-line="${i}" data-k="date" value="${esc(l.date)}" aria-label="Date"></td>
        <td>${headingSelect(l, i)}</td>
        <td><input id="ln-${i}-session" data-line="${i}" data-k="session" value="${esc(l.session)}" aria-label="Comment" placeholder="Age group, training, home/away match"></td>
        <td><input id="ln-${i}-hours" class="w-s" type="number" step="0.25" min="0" inputmode="decimal" data-line="${i}" data-k="hours" value="${esc(l.hours)}" aria-label="Hours"></td>
        ${ownRates() ? `<td><input id="ln-${i}-rate" class="w-s" type="number" step="0.01" min="0" inputmode="decimal" data-line="${i}" data-k="rate" value="${esc(l.rate)}" aria-label="Your rate"></td>` : `<td class="num calc" id="ln-${i}-ratecell">–</td>`}
        <td class="num calc" id="ln-${i}-amt">–</td>
        <td><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove session" ${d.lines.length < 2 ? "disabled" : ""}>✕</button></td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="add-line">+ Add session</button></div>
    </div>
    <div class="totals" id="totals"></div>
    <div class="notice warn" id="tsChecks" hidden></div>
    <div class="flagconfirm" id="tsConfirm" ${d.flag_ok || d.flag_note ? "" : "hidden"}>
      <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="fFlagOk" data-f="flag_ok" ${d.flag_ok ? "checked" : ""}> <span>I've checked: these are separate sessions and the hours are right. My approver will see this flagged.</span></label>
      <label>Explain for your approver<input id="fFlagNote" data-f="flag_note" value="${esc(d.flag_note || "")}" placeholder="e.g. Morning and afternoon camp groups"></label>
    </div>
    <p class="sub" style="margin:0">Rates include holiday pay. Payroll works out your average hourly rate for the month and the ${esc(holPct())}% holiday pay inside the total.</p>
    <label>Note for your approver <span class="hint">Optional</span><input id="fDesc" data-f="description" value="${esc(d.description)}"></label>
    <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="fDeclare" data-f="declare" ${d.declare ? "checked" : ""}> <span>I confirm these sessions are accurate and haven't been claimed before.</span></label>
    <div class="notice bad" id="formErr" hidden></div>
    <div class="row end">${d.editingId ? `<button class="btn" data-act="cancel-edit">Cancel</button>` : `<button class="btn" data-act="reset">Clear form</button>`}<button class="btn primary" data-act="submit" id="submitBtn">${d.editingId ? "Resubmit timesheet" : "Submit timesheet"}</button></div>
  </section>`;
}
function expenseForm(d){
  const b = S.myBank;
  return `<section class="panel" id="claimForm">
    <div class="row"><h2 style="flex:1">Expense claim</h2><span class="pill approved">${esc(d.entity)}</span><button class="link" data-act="entity-change">Change</button></div>
    <div class="grid">
      <label>Team / squad <span class="hint">Optional, e.g. U14 girls, Men's 2s</span><input id="fTeam" data-f="team" value="${esc(d.team)}"></label>
    </div>
    <label>What is this claim for?<textarea id="fDesc" data-f="description" placeholder="e.g. First-aid kit restock for match day">${esc(d.description)}</textarea></label>
    <div>
      <h3 style="margin-bottom:8px">Items bought</h3>
      ${d.lines.some(l => !isMile(l)) ? `<div class="tablebox"><table class="lines"><thead><tr><th>Date</th><th>What was bought</th><th>Supplier <span class="hint">optional</span></th><th class="num">Amount £</th><th></th></tr></thead>
      <tbody>${d.lines.map((l, i) => isMile(l) ? "" : `<tr>
        <td><input id="ln-${i}-date" type="date" data-line="${i}" data-k="date" value="${esc(l.date)}" aria-label="Date"></td>
        <td><input id="ln-${i}-item" data-line="${i}" data-k="item" value="${esc(l.item)}" aria-label="What was bought"></td>
        <td><input id="ln-${i}-supplier" data-line="${i}" data-k="supplier" value="${esc(l.supplier)}" aria-label="Supplier"></td>
        <td><input id="ln-${i}-amount" class="w-s" type="number" step="0.01" min="0" inputmode="decimal" data-line="${i}" data-k="amount" value="${esc(l.amount)}" aria-label="Amount"></td>
        <td><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove item" ${d.lines.length < 2 ? "disabled" : ""}>✕</button></td></tr>`).join("")}</tbody></table></div>` : `<p class="sub" style="margin:0">No items. Add one if you bought something.</p>`}
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="add-line">+ Add item</button></div>
    </div>
    <div>
      <h3 style="margin-bottom:4px">Mileage</h3>
      <p class="sub" style="margin:0 0 8px">Driving your own car for the club. No receipt needed. Choose the reason for each journey: it decides how the miles are paid.</p>
      ${d.lines.map((l, i) => isMile(l) ? journeyCard(l, i, d) : "").join("")}
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="add-mileage">+ Add journey</button></div>
    </div>
    <div class="totals" id="totals"></div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <label for="fFile">Receipt or invoice <span class="hint">Required for items bought: a photo or PDF of every receipt or invoice. Not needed for mileage.</span></label>
      <input type="file" id="fFile" multiple accept="image/*,application/pdf">
      <div class="files" id="fileList">${filesHtml(d.attachments, true)}</div>
    </div>
    ${b ? `<div class="notice">Bank account: <strong>${esc(b.account_name)}</strong>, account ending <strong>${esc(String(b.account_number).slice(-4))}</strong>. <button class="link" data-act="edit-details">Change bank details</button></div>`
      : `<div class="notice warn">Add your bank details before submitting, so the club knows which account to use. <button class="btn small" data-act="edit-details">Add bank details</button></div>`}
    <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="fDeclare" data-f="declare" ${d.declare ? "checked" : ""}> <span>I confirm this claim is accurate, was spent on ${esc(d.entity)} business, and hasn't been claimed before.</span></label>
    <div class="notice bad" id="formErr" hidden></div>
    <div class="row end"><span class="sub" id="uploadHint" ${d.attachments.length || !needsReceipt(d) ? "hidden" : ""}>Upload the receipt or invoice to submit.</span>${d.editingId ? `<button class="btn" data-act="cancel-edit">Cancel</button>` : `<button class="btn" data-act="reset">Clear form</button>`}<button class="btn primary" data-act="submit" id="submitBtn" ${d.attachments.length || !needsReceipt(d) ? "" : "disabled"}>${d.editingId ? "Resubmit claim" : "Submit claim"}</button></div>
  </section>`;
}
function journeyCard(l, i, d){
  const b = l.basis || "coaching", opts = myBases().includes(b) ? myBases() : myBases().concat([b]), n = d.lines.slice(0, i + 1).filter(isMile).length;
  const f = (k, label, attrs, hint) => `<label>${label}${hint ? ` <span class="hint">${hint}</span>` : ""}<input id="ln-${i}-${k}" data-line="${i}" data-k="${k}" value="${esc(l[k] == null ? "" : l[k])}" ${attrs || ""}></label>`;
  const num_ = 'type="number" step="1" min="0" inputmode="decimal"';
  return `<div class="journey">
    <div class="row" style="justify-content:space-between"><strong>Journey ${n}</strong><span class="row" style="gap:12px"><span class="sub" id="ln-${i}-ch"></span><strong id="ln-${i}-amt">–</strong><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove journey ${n}" ${d.lines.length < 2 ? "disabled" : ""}>✕</button></span></div>
    <label>Reason for the journey<select id="ln-${i}-basis" data-line="${i}" data-k="basis">${opts.map(k => `<option value="${k}" ${k === b ? "selected" : ""}>${esc(BASIS[k])}</option>`).join("")}</select></label>
    <p class="sub" style="margin:0">${esc(basisRule(b))}</p>
    <div class="jgrid">
      ${f("date", "Date", `type="date" max="${today()}"`)}
      ${b === "first_xi" ? `${f("purpose", "Away match", 'placeholder="e.g. Women\'s 1s v Bath"')}
        ${f("players", "Players in the car", `${num_} max="9"`, "including you")}
        ${f("rt_club", "Round trip from the Club", num_, "miles")}
        ${f("rt_origin", "Round trip from where you set off", num_, "miles")}`
      : `${f("from", "From", 'placeholder="e.g. Reading"')}${f("to", "To", 'placeholder="e.g. Swindon"')}
        ${f("purpose", b === "coaching" ? "Coaching session" : "Purpose", 'placeholder="e.g. County U14 trials"')}
        ${f("miles", "Miles one way", num_)}
        <label class="chk"><input type="checkbox" id="ln-${i}-ret" data-line="${i}" data-k="ret" ${l.ret ? "checked" : ""}> Return journey</label>`}
    </div>
    ${b === "chair" ? `<div class="jgrid"><label class="chk"><input type="checkbox" id="ln-${i}-chair_ok" data-line="${i}" data-k="chair_ok" ${l.chair_ok ? "checked" : ""}> The Chair agreed this before I drove</label>${f("chair_date", "Date the Chair agreed it", `type="date" max="${today()}"`)}</div>` : ""}
  </div>`;
}
function filesHtml(list, editable){
  if (!list || !list.length) return editable ? `<span class="sub">No files uploaded yet.</span>` : "";
  return list.map((a,i) => `<span class="file">📎 <button class="link" style="padding:0" data-act="open-file" data-path="${esc(a.path)}">${esc(a.name || "file")}</button>${editable ? `<button data-act="del-file" data-i="${i}" aria-label="Remove ${esc(a.name)}">×</button>` : ""}</span>`).join("");
}
function syncUploadState(){
  const d = S.draft; if (!d || d.type !== "expense") return;
  const fl = $("#fileList"); if (fl) fl.innerHTML = filesHtml(d.attachments, true);
  const need = needsReceipt(d) && !d.attachments.length;
  const b = $("#submitBtn"); if (b) b.disabled = need;
  const h = $("#uploadHint"); if (h) h.hidden = !need;
}
function recalc(){
  const d = S.draft; if (!d || !d.type) return; const el = $("#totals"); if (!el) return;
  if (d.type === "timesheet"){
    let hrs = 0, tot = 0;
    d.lines.forEach((l, i) => { const r = lineRate(l), a = r == null ? 0 : r2(num(l.hours) * r); hrs += num(l.hours); tot += a;
      const rc = $(`#ln-${i}-ratecell`); if (rc) rc.textContent = !l.activity_key ? "–" : r == null ? "no rate" : gbp(r) + "/hr";
      const ac = $(`#ln-${i}-amt`); if (ac) ac.textContent = r == null || !num(l.hours) ? "–" : gbp(a); });
    const chk = sessionChecks(d.lines, S.me.id, d.editingId), box = $("#tsChecks"), conf = $("#tsConfirm");
    if (box){ box.hidden = !chk.length; box.innerHTML = chk.length ? `<strong>Check for double claims:</strong><ul style="margin:6px 0 0;padding-left:1.2em">${chk.map(x => `<li>${esc(x.text)}</li>`).join("")}</ul>` : ""; }
    if (conf) conf.hidden = !chk.length;
    d.lines.forEach((l, i) => { const row = $(`#ln-${i}-date`); if (row) row.closest("tr").classList.toggle("flagged", chk.some(x => x.i === i || (x.kind === "day" && x.date === l.date))); });
    el.innerHTML = `<div><small>Sessions</small><strong>${d.lines.length}</strong></div><div><small>Hours</small><strong>${fmtH(hrs)}</strong></div><div><small>Total (incl. holiday pay)</small><strong>${gbp(tot)}</strong></div>`;
    return;
  }
  let tot = 0, items = 0, miles = 0, ch = 0;
  d.lines.forEach((l, i) => { if (isMile(l)){ const x = mileCalc(l); tot += x.amt; miles += x.amt; ch += x.ch; const a = $(`#ln-${i}-amt`); if (a) a.textContent = gbp(x.amt); const c = $(`#ln-${i}-ch`); if (c) c.textContent = l.basis === "first_xi" ? (x.m ? `${x.m} mi round trip` : "") : x.m ? `${x.ch} of ${x.m} mi claimable` : ""; } else { tot += num(l.amount); items += num(l.amount); } });
  el.innerHTML = (d.lines.some(isMile) ? `${d.lines.some(l => !isMile(l)) ? `<div><small>Items</small><strong>${gbp(items)}</strong></div>` : ""}<div><small>Mileage (${ch} mi)</small><strong>${gbp(miles)}</strong></div>` : "") + `<div><small>Total claimed</small><strong>${gbp(tot)}</strong></div>`;
}
function validate(d){
  const errs = [];
  if (d.type === "timesheet"){
    if (!d.section || !sections().some(x => x.key === d.section)) errs.push("Choose the section.");
    const m = d.work_month;
    d.lines.forEach((l, i) => { const n = `Session ${i + 1}`;
      if (blank(l.date) || l.date.slice(0, 7) !== m) errs.push(`${n}: the date must be in ${monthName(m)}.`);
      else if (l.date > today()) errs.push(`${n}: the date can't be in the future.`);
      const a = actByKey(l.activity_key); if (!a) errs.push(`${n}: choose the timesheet heading.`);
      else if (!ownRates() && myRate(a.key) == null) errs.push(`${n}: you don't have a rate for ${a.label} yet. Ask the club admin.`);
      if (blank(l.session)) errs.push(`${n}: add a comment, e.g. age group, training, home or away match.`);
      if (num(l.hours) <= 0 || num(l.hours) > 24) errs.push(`${n}: hours must be between 0.25 and 24.`);
      if (ownRates() && num(l.rate) <= 0) errs.push(`${n}: enter your hourly rate.`); });
    if (sessionChecks(d.lines, S.me.id, d.editingId).length){ if (!d.flag_ok) errs.push("Some sessions look like double claims or go over the daily limit. Check them, then tick the box to confirm."); if (blank(d.flag_note)) errs.push("Explain the flagged sessions for your approver."); }
  } else {
    if (!d.entity) errs.push("Choose RHC or GARC.");
    if (!S.myBank) errs.push("Add your bank details in My account first.");
    if (!d.description.trim()) errs.push("Say what the claim is for.");
    let ni = 0, nj = 0;
    d.lines.forEach(l => { if (!blank(l.date) && l.date > today()) errs.push(`${isMile(l) ? "Journey" : "Item"} dates can't be in the future.`); });
    d.lines.forEach(l => { if (isMile(l)){ const n = `Journey ${++nj}`, b = l.basis || "coaching"; if (blank(l.date)) errs.push(`${n}: add the date.`);
        if (!myBases().includes(b)) errs.push(`${n}: choose a reason for the journey.`);
        if (b === "first_xi"){ if (blank(l.purpose)) errs.push(`${n}: say which away match.`); if (num(l.players) < minPlayers()) errs.push(`${n}: 1st XI mileage needs at least ${minPlayers()} players in the car.`); if (num(l.rt_club) <= 0 || num(l.rt_origin) <= 0) errs.push(`${n}: add both round-trip distances.`); }
        else { if (blank(l.from) || blank(l.to)) errs.push(`${n}: add where you drove from and to.`); if (blank(l.purpose)) errs.push(`${n}: add the purpose.`); if (num(l.miles) <= 0) errs.push(`${n}: add the miles.`); }
        if (b === "chair"){ if (!l.chair_ok) errs.push(`${n}: tick to confirm the Chair agreed it in advance.`); if (blank(l.chair_date) || (!blank(l.date) && l.chair_date > l.date)) errs.push(`${n}: add the date the Chair agreed it, on or before the journey.`); } }
      else { const n = `Item ${++ni}`; if (blank(l.date)) errs.push(`${n}: add the date.`); if (blank(l.item)) errs.push(`${n}: say what was bought.`); if (num(l.amount) <= 0) errs.push(`${n}: add the amount.`); } });
    if (needsReceipt(d) && !d.attachments.length) errs.push("Upload the receipt or invoice.");
    if (d.lines.length && d.lines.every(isMile) && d.lines.every(l => mileCalc(l).ch <= 0)) errs.push("None of these journeys has any claimable miles, so there's nothing to claim.");
  }
  if (!d.declare) errs.push("Tick the confirmation box.");
  return errs;
}
async function submitDraft(){
  const d = S.draft, errs = validate(d), box = $("#formErr");
  if (errs.length){ box.innerHTML = errs.map(esc).join("<br>"); box.hidden = false; box.scrollIntoView({block:"nearest"}); return; }
  box.hidden = true; const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "Submitting…";
  let p;
  if (d.type === "timesheet"){
    try { localStorage.setItem("rhc-last-section", d.section || ""); } catch (e) {}
    const flagged = sessionChecks(d.lines, S.me.id, d.editingId).length > 0;
    p = {type:"timesheet", section:d.section, work_month:d.work_month, description:String(d.description || "").trim(), flag_note: flagged ? String(d.flag_note || "").trim() : "",
      lines:d.lines.map(l => { const o = {date:l.date, activity_key:l.activity_key, session:String(l.session || "").trim(), hours:num(l.hours)}; if (ownRates()) o.rate = num(l.rate); return o; })};
  } else {
    p = {type:"expense", entity:d.entity, description:d.description.trim(), team:String(d.team || "").trim(),
      lines:d.lines.map(l => isMile(l) ? mileagePayload(l)
        : {kind:"item", date:l.date, item:String(l.item || "").trim(), supplier:String(l.supplier || "").trim(), amount:num(l.amount)}), attachments:d.attachments};
  }
  const {data, error} = await S.sb.rpc("submit_claim", {p, p_claim_id: d.editingId || null});
  if (error){ btn.disabled = false; btn.textContent = "Submit"; box.textContent = errText(error, "The claim didn't save. Try again."); box.hidden = false; return; }
  S.draft = null; clearLocalDraft();
  await loadClaims();
  S.lastSubmitted = S.claims.find(c => c.id === data) || {id:data, ref:"your claim", type:d.type, total:0, hours:0};
  render(); window.scrollTo(0, 0);
}
function mileagePayload(l){
  const b = l.basis || "coaching", o = {kind:"mileage", basis:b, date:l.date, purpose:String(l.purpose || "").trim()};
  if (b === "first_xi") return Object.assign(o, {players:num(l.players), rt_club:num(l.rt_club), rt_origin:num(l.rt_origin)});
  Object.assign(o, {from:String(l.from || "").trim(), to:String(l.to || "").trim(), miles:num(l.miles), ret:!!l.ret});
  if (b === "chair") Object.assign(o, {chair_ok:!!l.chair_ok, chair_date:l.chair_date || ""});
  return o;
}
function submittedView(){
  const c = S.lastSubmitted, ts = c.type === "timesheet";
  const same = ts ? S.claims.filter(x => x.type === "timesheet" && x.claimant === S.me.id && x.work_month === c.work_month && x.status !== "withdrawn").sort((p, q) => String(p.ref).localeCompare(String(q.ref))) : [];
  return `<section class="panel">
    <div><h2>${ts ? "Timesheet" : "Expense claim"} ${esc(c.ref)} submitted</h2>
    <p class="lede">${ts ? `${fmtH(c.hours)}, ${gbp(c.total)}. Your section captains and the Director of Hockey have been emailed to approve it. ${c.late ? `It's late, so it will go into the ${esc(monthName(c.payroll_month))} payroll.` : `Once approved it goes into the ${esc(monthName(c.payroll_month))} payroll.`}${same.length > 1 ? ` This is your ${same.length}${["th","st","nd","rd"][same.length % 10 > 3 || [11,12,13].includes(same.length % 100) ? 0 : same.length % 10]} timesheet for ${esc(monthName(c.work_month))} (${same.map(x => esc(x.ref)).join(", ")}). They'll all be added together into one payroll record.` : ""}`
      : `${gbp(c.total)}, charged to ${esc(c.entity)}. Finance has been emailed to approve it. Once approved it goes to the bookkeeper, and you'll get an email when it's processed.`}</p></div>
    <div class="row end"><button class="btn" data-act="tab" data-tab="mine">Track my claims</button><button class="btn primary" data-act="another">Submit another</button></div>
  </section>`;
}

/* ---------- claim cards ---------- */
function stepsHtml(c){
  const done = (who, at) => who ? personName(who) + ", " + fmtDate(at) : "";
  const steps = c.type === "timesheet" ? [
    ["Submitted", true, fmtDate(c.submitted_at)],
    ["Approved · captain or DoH", !!c.first_approver, done(c.first_approver, c.first_approved_at)],
    [`Payroll · ${monthShort(c.payroll_month)}`, c.status === "processed", c.status === "processed" ? "Processed in the " + monthName(c.payroll_run || c.payroll_month) + " payroll" : (c.status === "approved" ? "Waiting for the payroll run" : "")]
  ] : [
    ["Submitted", true, fmtDate(c.submitted_at)],
    ["Approved · finance", !!c.first_approver, done(c.first_approver, c.first_approved_at)],
    ["Processed", c.status === "processed", c.status === "processed" ? fmtDate(c.processed_at) : (c.status === "approved" ? "With bookkeeper" : "")]
  ];
  const next = c.status === "returned" ? -1 : steps.findIndex(x => !x[1]);
  return `<ol class="track three" aria-label="Progress">${steps.map((x,i) => `<li class="${x[1] ? "done" : i === next ? "next" : ""}"><b>${x[1] ? "✓ " : ""}${esc(x[0])}</b>${x[2] ? esc(x[2]) : (i === next ? "Waiting" : "")}</li>`).join("")}</ol>`;
}
function claimDetail(c, open){
  let body;
  if (c.type === "timesheet"){
    const by = new Map(); for (const l of c.lines || []){ const k = actLabel(l) + "|" + num(l.rate), x = by.get(k) || {label: actLabel(l), rate: num(l.rate), h: 0, a: 0}; x.h += num(l.hours); x.a += num(l.amount); by.set(k, x); }
    body = `<div class="tablebox"><table><thead><tr><th>Date</th><th>Heading</th><th>Comment</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${(c.lines || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).map(l => `<tr><td>${fmtDate(l.date)}</td><td>${esc(actLabel(l))}${l.own_rate ? ` <span class="pill pending">own rate</span>` : ""}</td><td>${esc(l.session)}</td><td class="num">${esc(fmtH(l.hours))}</td><td class="num">${gbp(l.rate)}</td><td class="num">${gbp(l.amount)}</td></tr>`).join("")}</tbody></table></div>
      ${by.size > 1 ? `<div class="tablebox"><table><thead><tr><th>By heading</th><th class="num">Hours</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>${[...by.values()].map(x => `<tr><td>${esc(x.label)}</td><td class="num">${esc(fmtH(x.h))}</td><td class="num">${gbp(x.rate)}</td><td class="num">${gbp(x.a)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  } else {
    const coded = (c.lines || []).some(l => l.budget_label);
    const items = (c.lines || []).filter(l => !isMile(l)), jn = (c.lines || []).filter(isMile);
    body = (items.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Item</th><th>Supplier</th><th class="num">Amount</th>${coded ? "<th>Charged to</th>" : ""}</tr></thead>
      <tbody>${items.map(l => `<tr><td>${fmtDate(l.date)}</td><td>${esc(l.item)}</td><td>${esc(l.supplier)}</td><td class="num">${gbp(l.amount)}</td>${coded ? `<td>${esc(chargeText(l))}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : "")
      + (jn.length ? `<div class="tablebox"><table><thead><tr><th>Date</th><th>Reason</th><th>Journey</th><th class="num">Miles</th><th class="num">Claimable</th><th class="num">Amount</th>${coded ? "<th>Charged to</th>" : ""}</tr></thead>
      <tbody>${jn.map(l => `<tr><td>${fmtDate(l.date)}</td><td>${esc(BASIS[l.basis || "coaching"])}${l.basis === "chair" && l.chair_date ? `<div class="sub">agreed ${fmtDate(l.chair_date)}</div>` : ""}</td><td>${l.basis === "first_xi" ? `${esc(l.purpose)}<div class="sub">${esc(num(l.players))} players · round trip ${esc(num(l.rt_club))} mi from Club, ${esc(num(l.rt_origin))} mi from start</div>` : `${esc(l.from)} to ${esc(l.to)}${l.ret ? " and back" : ""}<div class="sub">${esc(l.purpose)}</div>`}</td><td class="num">${esc(l.total_miles)}</td><td class="num">${esc(l.claimable_miles)} @ ${pence(l.rate)}</td><td class="num">${gbp(l.amount)}</td>${coded ? `<td>${esc(chargeText(l))}</td>` : ""}</tr>`).join("")}</tbody></table></div>` : "") + `
      ${c.attachments && c.attachments.length ? `<div class="files">${filesHtml(c.attachments, false)}</div>` : ""}`;
  }
  return `<details ${open ? "open" : ""}><summary>${c.type === "timesheet" ? "Sessions" : "Claim details"}</summary><div style="display:flex;flex-direction:column;gap:10px">${c.description ? `<p style="margin:0">${esc(c.description)}</p>` : ""}${body}</div></details>`;
}
function claimCard(c, actions, open){
  const s = st(c), ts = c.type === "timesheet";
  return `<article class="claim">
    <div class="head"><span class="ref">${esc(c.ref)}</span><span class="pill ${s.cls}">${esc(s.label)}</span>${ts && c.late ? `<span class="pill returned" title="Submitted after the deadline">Late · ${esc(monthShort(c.payroll_month))} payroll</span>` : ""}${ts && (c.flags || []).length ? `<span class="pill pending" title="Possible double claim or over the daily limit">⚠ Flagged</span>` : ""}<span class="amt">${gbp(c.total)}</span></div>
    <div class="meta"><span><strong>${esc(personName(c.claimant))}</strong></span><span>${ts ? `Timesheet · ${esc(monthName(c.work_month))} · ${esc(fmtH(c.hours))}` : `Expense claim · ${esc(c.entity)}`}</span>${ts ? `<span>${esc(c.section_label || sectionLabel(c.section))}</span>` : (c.team ? `<span>${esc(c.team)}</span>` : "")}<span>Submitted ${fmtDate(c.submitted_at)}${c.revision > 1 ? " · resubmitted" : ""}</span></div>
    ${stepsHtml(c)}
    ${ts && (c.flags || []).length && ["pending","returned"].includes(c.status) ? `<div class="notice warn"><strong>⚠ Possible double claim or long day:</strong><ul style="margin:6px 0;padding-left:1.2em">${c.flags.map(f => `<li>${esc(f.text)}</li>`).join("")}</ul>${c.flag_note ? `<div><strong>${esc(personName(c.claimant))} says:</strong> ${esc(c.flag_note)}</div>` : ""}</div>` : ""}
    ${c.status === "returned" ? `<div class="notice bad"><strong>${esc(personName(c.returned_by))} returned this:</strong> ${esc(c.returned_reason || "No reason given.")}</div>` : ""}
    ${c.status === "processed" && c.payment_ref ? `<div class="sub">Reference: ${esc(c.payment_ref)}</div>` : ""}
    ${claimDetail(c, open)}
    ${actions || ""}
  </article>`;
}

/* ---------- my claims ---------- */
function viewMine(){
  const mine = S.claims.filter(c => c.claimant === S.me.id);
  const head = `<div class="row"><div style="flex:1"><h2>My claims</h2><p class="lede">Your timesheets and expense claims, newest first. You can edit or delete anything that hasn't been approved yet.</p></div><button class="btn small" data-act="edit-details">My account</button></div>`;
  if (S.editingDetails) return head + detailsCard();
  if (!mine.length) return head + `<div class="empty">You haven't submitted anything yet.<br><br><button class="btn primary" data-act="tab" data-tab="new">Start a claim</button></div>`;
  return head + monthSummary(mine) + `<div class="claims">${mine.map(c => {
    const can = ["pending","returned","withdrawn"].includes(c.status);
    return claimCard(c, can ? `<div class="row end"><button class="btn small danger" data-act="delete-claim" data-id="${esc(c.id)}">Delete</button><button class="btn small primary" data-act="edit-claim" data-id="${esc(c.id)}">${c.status === "returned" ? "Fix and resubmit" : "Edit"}</button></div>${S.confirmDelete === c.id ? `<div class="notice warn row"><span style="flex:1">Delete ${esc(c.ref)} for good? ${c.type === "expense" ? "Its receipts are deleted too. " : ""}This can't be undone.</span><button class="btn small" data-act="delete-cancel">Keep it</button><button class="btn small danger" data-act="delete-yes" data-id="${esc(c.id)}">Delete</button></div>` : ""}`
      : `<p class="sub" style="margin:0;text-align:right">${c.status === "processed" ? (c.type === "timesheet" ? "Processed in the " + monthName(c.payroll_run || c.payroll_month) + " payroll." : "Processed. Payment is made in the next weekly payment run.") : "Approved, so it can no longer be edited or deleted."}</p>`);
  }).join("")}</div>`;
}

function monthSummary(mine){
  const ts = mine.filter(c => c.type === "timesheet" && c.status !== "withdrawn");
  const months = [...new Set(ts.map(c => c.work_month))].sort().reverse().slice(0, 3);
  if (!months.length) return "";
  const card = m => {
    const list = ts.filter(c => c.work_month === m).sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)));
    const ok = list.filter(c => ["approved","processed"].includes(c.status)), wait = list.filter(c => c.status === "pending"), back = list.filter(c => c.status === "returned");
    const sum = (l, k) => r2(l.reduce((t, c) => t + num(c[k]), 0));
    const paid = list.length && list.every(c => c.status === "processed");
    return `<div class="monthcard"><div class="row" style="justify-content:space-between"><strong>${esc(monthName(m))}</strong><span class="sub">${paid ? "Processed" : `Due by ${fmtDate(askDate(m))}`}</span></div>
      <div class="sub">${list.length} timesheet${list.length > 1 ? "s" : ""}: ${list.map(c => `${esc(c.ref)} <span class="pill ${st(c).cls}">${esc(c.status === "processed" ? "processed" : c.status === "approved" ? "approved" : c.status === "pending" ? "waiting" : "returned")}</span>`).join(" ")}</div>
      <div class="row" style="gap:4px 18px"><span><strong>${fmtH(sum(ok, "hours"))}</strong> · <strong>${gbp(sum(ok, "total"))}</strong> approved${paid ? " and processed" : " for payroll"}</span>${wait.length ? `<span class="sub">+ ${fmtH(sum(wait, "hours"))} (${gbp(sum(wait, "total"))}) waiting for approval</span>` : ""}${back.length ? `<span class="sub">${back.length} returned to fix</span>` : ""}</div>
      ${list.some(c => c.late) ? `<div class="sub">Late timesheets go into the following payroll.</div>` : ""}</div>`;
  };
  return `<section class="panel" style="gap:10px"><div><h3>Timesheets by month</h3><p class="sub" style="margin:2px 0 0">Send as many timesheets as you like for a month: one session at a time or several together. Every approved one is added together into a single payroll record for that month.</p></div><div class="monthgrid">${months.map(card).join("")}</div></section>`;
}

/* ---------- approvals ---------- */
function viewApprove(){
  const list = toApprove(), ts = list.filter(c => c.type === "timesheet"), ex = list.filter(c => c.type === "expense");
  const decided = S.claims.filter(c => c.first_approver === S.me.id || c.returned_by === S.me.id).slice(0, 15);
  const caps = myCaptain().map(sectionLabel).filter(Boolean);
  const role = [isDoH() ? "As Director of Hockey you approve timesheets for every section." : caps.length ? `You approve timesheets for ${caps.join(", ")}.` : "", isFinance() ? "As finance you approve expense claims and choose the budget line for each item." : ""].filter(Boolean).join(" ");
  const ownWaiting = S.claims.filter(c => c.claimant === S.me.id && c.status === "pending").length;
  let h = `<div><h2>To approve</h2><p class="lede">${esc(role)} Nobody can approve their own claim.</p></div>`;
  if (!list.length) h += `<div class="empty">Nothing waiting for you. You'll get an email when something needs your approval.</div>`;
  if (ts.length) h += `<h3>Timesheets (${ts.length})</h3><div class="claims">${ts.map(c => claimCard(c, decideBox(c), true)).join("")}</div>`;
  if (ex.length) h += `<h3>Expense claims (${ex.length})</h3><div class="claims">${ex.map(c => claimCard(c, decideBox(c), true)).join("")}</div>`;
  if (ownWaiting) h += `<p class="sub">You have ${ownWaiting} claim${ownWaiting > 1 ? "s" : ""} of your own waiting. Someone else has to approve ${ownWaiting > 1 ? "them" : "it"}.</p>`;
  if (decided.length) h += `<div><h3 style="margin:12px 0 8px">Recently decided by you</h3><div class="tablebox"><table><thead><tr><th>Ref</th><th>Who</th><th>What</th><th>Your decision</th><th>Now</th><th class="num">Value</th></tr></thead><tbody>${decided.map(c => {
    const s = st(c);
    return `<tr><td>${esc(c.ref)}</td><td>${esc(personName(c.claimant))}</td><td>${c.type === "timesheet" ? "Timesheet" : "Expense · " + esc(c.entity)}</td><td>${c.returned_by === S.me.id ? "Returned " + fmtDate(c.returned_at) : "Approved " + fmtDate(c.first_approved_at)}</td><td><span class="pill ${s.cls}">${esc(s.label)}</span></td><td class="num">${gbp(c.total)}</td></tr>`;
  }).join("")}</tbody></table></div></div>`;
  return h;
}
function decideBox(c){
  if (S.decideOpen === c.id) return `<div class="decide"><label>Reason for returning <span class="hint">The claimant sees this and can fix and resubmit.</span><textarea id="rejNote-${esc(c.id)}"></textarea></label><div class="row end"><button class="btn" data-act="reject-cancel">Cancel</button><button class="btn danger" data-act="reject-yes" data-id="${esc(c.id)}">Return</button></div></div>`;
  return `${c.type === "expense" ? allocBox(c) : ""}<div class="decide row end" style="flex-direction:row"><button class="btn danger" data-act="reject" data-id="${esc(c.id)}">Return to claimant</button><button class="btn good" data-act="approve" data-id="${esc(c.id)}">Approve · ${gbp(c.total)}</button></div>`;
}
function allocFor(c){
  const n = (c.lines || []).length;
  if (!S.alloc[c.id] || S.alloc[c.id].length !== n) S.alloc[c.id] = (c.lines || []).map(l => ({area: l.area || (c.entity === "GARC" ? "garc" : ""), line: l.budget_line || ""}));
  return S.alloc[c.id];
}
function allocOpts(area, cur){
  const opt = x => `<option value="${esc(x.key)}" ${x.key === cur ? "selected" : ""}>${esc(blName(x))}</option>`;
  if (!area) return `<option value="">Choose budget line…</option>` + budgetLines().map(opt).join("");
  const ent = areaEnt(area), mine = budgetLines().filter(x => lineAreas(x).includes(area)), other = budgetLines().filter(x => !lineAreas(x).includes(area) && lineAreas(x).some(a => areaEnt(a) === ent));
  return `<option value="">Choose budget line…</option><optgroup label="In the ${esc(areaName(area))} budget">${mine.map(opt).join("")}</optgroup>${other.length ? `<optgroup label="Other ${ent} lines">${other.map(opt).join("")}</optgroup>` : ""}`;
}
const areaOpts = cur => `<option value="">Choose area…</option>` + AREAS.map(([k]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(areaName(k))}</option>`).join("");
function allocBox(c){
  const a = allocFor(c), lines = c.lines || [], id = esc(c.id), left = a.filter(x => !x.area || !x.line).length;
  const all = lines.length > 1 ? `<tr class="allrow"><td colspan="2"><strong>All items</strong> <span class="sub">sets every item at once</span></td><td><select data-alloc="${id}" data-ai="all" data-ak="area" aria-label="Area for all items">${areaOpts("")}</select></td><td><select data-alloc="${id}" data-ai="all" data-ak="line" aria-label="Budget line for all items">${allocOpts(a.every(x => x.area === a[0].area) ? a[0].area : "", "")}</select></td></tr>` : "";
  return `<div class="alloc"><div><strong>Area and budget line</strong><p class="sub" style="margin:2px 0 0">${esc(personName(c.claimant))} chose <strong>${esc(c.entity)}</strong>. Choose the budget area (Hockey, Camps, Talent Academy, School Partnerships or GARC) and the budget line for each item. Lines in that area's budget are listed first.</p></div>
    <div class="tablebox"><table><thead><tr><th>Item</th><th class="num">Amount</th><th>Area</th><th>Budget line</th></tr></thead><tbody>${all}
    ${lines.map((l, i) => `<tr><td>${esc(isMile(l) ? exLineText(l) : l.item)}${!isMile(l) && l.supplier ? ` <span class="sub">(${esc(l.supplier)})</span>` : ""}</td><td class="num">${gbp(l.amount)}</td>
      <td><select data-alloc="${id}" data-ai="${i}" data-ak="area" aria-label="Item ${i + 1}: area">${areaOpts(a[i].area)}</select></td>
      <td><select data-alloc="${id}" data-ai="${i}" data-ak="line" aria-label="Item ${i + 1}: budget line">${allocOpts(a[i].area, a[i].line)}</select></td></tr>`).join("")}
    </tbody></table></div>
    <span class="sub">${left ? `${left} item${left > 1 ? "s" : ""} still need an area and budget line` : "✓ Every item has an area and budget line"}${a.some(x => x.area && areaEnt(x.area) !== c.entity) ? ` · ⚠ charged differently from the claimant's choice of ${esc(c.entity)}` : ""}</span></div>`;
}
function onAlloc(e){
  const t = e.target; if (!t.dataset || t.dataset.alloc == null) return false;
  if (e.type !== "change") return true;
  const c = S.claims.find(x => x.id === t.dataset.alloc); if (!c) return true;
  const a = allocFor(c), k = t.dataset.ak, v = t.value;
  const set = x => { if (k === "area"){ x.area = v; const b = blByKey(x.line); if (b && v && !lineAreas(b).some(z => areaEnt(z) === areaEnt(v))) x.line = ""; }
    else { x.line = v; const b = blByKey(v); if (b && (!x.area || !lineAreas(b).some(z => areaEnt(z) === areaEnt(x.area)))) x.area = lineAreas(b)[0]; } };
  if (t.dataset.ai === "all") a.forEach(set); else set(a[+t.dataset.ai]);
  render(); return true;
}

/* ---------- expenses (bookkeeper) ---------- */
function exSet(f){ const all = S.claims.filter(c => c.type === "expense" && ["approved","processed"].includes(c.status)); return f === "ready" ? all.filter(c => c.status === "approved") : f === "processed" ? all.filter(c => c.status === "processed") : all; }
function exFiltered(){
  const F = S.ex, q = (F.q || "").trim().toLowerCase();
  return exSet(S.exFilter).filter(c => (!F.month || isoDay(c.submitted_at).slice(0, 7) === F.month) && (!F.entity || c.entity === F.entity || (c.lines || []).some(l => l.charge_to === F.entity)) && (!F.area || (c.lines || []).some(l => l.area === F.area))
    && (!q || [personName(c.claimant), c.ref, c.description, c.team].join(" ").toLowerCase().includes(q)));
}
function viewExpenses(){
  const f = S.exFilter, F = S.ex, list = exFiltered();
  const months = [...new Set(S.claims.filter(c => c.type === "expense").map(c => isoDay(c.submitted_at).slice(0, 7)))].sort().reverse();
  const sel = (k, label, opts) => `<label>${label}<select data-ex-k="${k}"><option value="">All</option>${opts.map(([v, l]) => `<option value="${esc(v)}" ${F[k] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  let h = `<div class="row"><div style="flex:1"><h2>Expenses</h2><p class="lede">Expense claims approved by finance land here. ${isBookkeeper() ? "Download the receipt and the expense form, put it through the weekly payment run, then click Mark as processed at the bottom of the claim. The claimant is emailed when you do." : `The bookkeeper (${esc(bookkeeperNames())}) downloads the receipt and expense form, puts it through the weekly payment run, then marks it as processed. You can see these claims, but only the bookkeeper can mark them as processed.`}</p></div>
    <button class="btn" data-act="export-ex" ${list.length ? "" : "disabled"}>Export these (CSV)</button></div>
    <div class="seg" role="group" aria-label="Status">${[["ready","Ready to process"],["processed","Processed"],["all","All"]].map(([k,l]) => `<button data-act="ex" data-f="${k}" aria-pressed="${f === k}">${l} (${exSet(k).length})</button>`).join("")}</div>
    <section class="panel bkfilters" style="padding:14px"><div class="bkgrid">
      ${sel("month", "Submitted in", months.map(m => [m, monthName(m)]))}
      ${sel("entity", "RHC or GARC", [["RHC","RHC"],["GARC","GARC"]])}
      ${sel("area", "Budget area", AREAS.map(([k]) => [k, areaName(k)]))}
      <label>Search<input data-ex-k="q" id="ex-q" type="search" value="${esc(F.q || "")}" placeholder="Name, ref, team"></label>
    </div></section>`;
  if (list.length){
    const sum = e => list.reduce((t, c) => t + (c.lines || []).reduce((u, l) => u + ((l.charge_to || c.entity) === e ? num(l.amount) : 0), 0), 0);
    h += `<div class="totals" style="justify-content:flex-start"><div style="align-items:flex-start"><small>${f === "ready" ? "To process" : "Total"}</small><strong>${gbp(list.reduce((t, c) => t + num(c.total), 0))}</strong></div><div style="align-items:flex-start"><small>RHC</small><strong>${gbp(sum("RHC"))}</strong></div><div style="align-items:flex-start"><small>GARC</small><strong>${gbp(sum("GARC"))}</strong></div><div style="align-items:flex-start"><small>Claims</small><strong>${list.length}</strong></div></div>`;
  }
  if (!list.length) return h + `<div class="empty">${f === "ready" ? "Nothing waiting. You'll get an email when finance approves an expense claim." : "No claims here."}</div>`;
  return h + `<div class="claims">${list.map(c => claimCard(c, processBox(c))).join("")}</div>`;
}
function processBox(c){
  const b = S.banks[c.claimant];
  const copy = (label, v) => `<span class="row" style="gap:6px"><span class="sub">${label}</span> <span class="copyable">${esc(v)}</span><button class="btn small" data-act="copy" data-text="${esc(v)}">Copy</button></span>`;
  const bank = !b ? `<div class="notice warn">No bank details on file for ${esc(personName(c.claimant))}. Ask them to add them in My account.</div>`
    : `<div class="panel" style="padding:12px;gap:8px;background:var(--surface-2)"><strong>Bank details</strong><div class="row" style="gap:8px 18px">${copy("Name", b.account_name)}${copy("Sort code", fmtSort(b.sort_code))}${copy("Account", b.account_number)}${copy("Reference", c.ref)}</div>
      ${(Date.now() - new Date(b.updated_at)) < 30 * 864e5 || new Date(b.updated_at) > new Date(c.submitted_at) ? `<div class="notice warn" style="margin:0">These bank details were changed on ${fmtDate(b.updated_at)}. Confirm them with ${esc(personName(c.claimant))} by phone or in person before paying.</div>` : ""}</div>`;
  const files = `<div class="row">${(c.attachments || []).map((a, i) => `<button class="btn small" data-act="dl-file" data-id="${esc(c.id)}" data-i="${i}">⬇ ${esc(a.name)}</button>`).join("")}<button class="btn small" data-act="ex-pdf" data-id="${esc(c.id)}">⬇ Expense form (PDF)</button></div>`;
  return bank + files + (c.status === "approved" && isBookkeeper() ? `<div class="decide"><div class="row"><input id="payRef-${esc(c.id)}" placeholder="Reference (optional)" style="flex:1;min-width:180px"><button class="btn good" data-act="processed" data-id="${esc(c.id)}">Mark as processed</button></div></div>` : c.status === "approved" ? `<div class="decide"><span class="sub">Only the bookkeeper (${esc(bookkeeperNames())}) can mark this as processed.</span></div>` : "");
}
const bookkeeperNames = () => Object.values(S.people).filter(p => p.active && p.is_bookkeeper).map(p => p.full_name).join(" or ") || "not set yet";
const csvCell = v => { v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
async function exportExpenses(){
  const rows = [["Ref","Status","Claimant","Email","RHC/GARC chosen","Team","Description","Submitted","Approved by","Approved on","Processed on","Payment ref","Item date","Item","Supplier","Amount","Charged to","Area","Budget code","Budget line","Claim total","Receipts","Account name","Sort code","Account number"]];
  for (const c of exFiltered()){ const p = S.people[c.claimant] || {}, b = S.banks[c.claimant] || {};
    for (const l of c.lines || []) rows.push([c.ref, st(c).label, personName(c.claimant), p.email || "", c.entity, c.team, c.description, isoDay(c.submitted_at), c.first_approver ? personName(c.first_approver) : "", isoDay(c.first_approved_at), isoDay(c.processed_at), c.payment_ref || "", l.date, exLineText(l), isMile(l) ? "Mileage" : l.supplier, l.amount, l.charge_to || "", l.area ? (AREAS.find(a => a[0] === l.area) || [])[1] : "", l.budget_code || "", l.budget_label || "", c.total, (c.attachments || []).map(a => a.name).join("; "), b.account_name || "", fmtSort(b.sort_code), b.account_number || ""]); }
  await saveFile(`rhc-expenses-${S.exFilter}-${today()}.csv`, new Blob(["﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n")], {type:"text/csv"}));
}
async function expensePdf(c){
  let lib; try { lib = await loadLib("jspdf"); } catch (e) { toast("The PDF maker didn't load. Check your connection and try again."); return; }
  const doc = new lib.jsPDF({unit:"mm", format:"a4"}), W = 210, L = 16, R = W - 16; let y = 18;
  const p = S.people[c.claimant] || {}, b = S.banks[c.claimant];
  const ascii = t => String(t == null ? "" : t).replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\u00b7/g, "-").replace(/\u2026/g, "...");
  const text = (t, x, yy, o) => doc.text(Array.isArray(t) ? t.map(ascii) : ascii(t), x, yy, o || {});
  doc.setFillColor(29, 79, 145); doc.rect(0, 0, W, 26, "F"); doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(16); text(CLUB.toUpperCase(), L, 12); doc.setFontSize(11); doc.setFont("helvetica", "normal"); text("Expense claim form", L, 19); doc.setFont("helvetica", "bold"); doc.setFontSize(16); text(c.ref, R, 15, {align:"right"});
  doc.setTextColor(20); y = 36;
  const field = (k, v, x, w) => { doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(100); text(k.toUpperCase(), x, y); doc.setFont("helvetica", "normal"); doc.setFontSize(10.5); doc.setTextColor(20); const lines = doc.splitTextToSize(ascii(v || "-"), w); text(lines, x, y + 5); return lines.length; };
  let n = Math.max(field("Claimant", personName(c.claimant), L, 80), field("Email", p.email, 110, 84)); y += 6 + n * 5;
  n = Math.max(field("Charge to", ENTITY[c.entity] || c.entity, L, 80), field("Team / squad", c.team, 110, 84)); y += 6 + n * 5;
  n = field("What the claim is for", c.description, L, R - L); y += 6 + n * 5;
  n = Math.max(field("Submitted", fmtDate(c.submitted_at), L, 55), field("Approved by (finance)", c.first_approver ? personName(c.first_approver) + ", " + fmtDate(c.first_approved_at) : "Not yet approved", 75, 70), field("Status", st(c).label, 150, 44)); y += 8 + n * 5;
  const cols = [[L, "Date", 22], [L + 22, "Item", 52], [L + 74, "Supplier", 30], [L + 104, "Charged to / budget line", 50], [R, "Amount", 0]];
  doc.setFillColor(233, 238, 245); doc.rect(L, y - 5, R - L, 8, "F"); doc.setFont("helvetica", "bold"); doc.setFontSize(9);
  cols.forEach(([x, h, w], i) => text(h, i === 4 ? R - 2 : x + 2, y, i === 4 ? {align:"right"} : {})); y += 8; doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
  for (const l of c.lines || []){
    const cells = [fmtDate(l.date), isMile(l) ? exLineText(l) : l.item, isMile(l) ? "Mileage" : l.supplier || "", l.budget_label ? chargeText(l) : c.entity].map((v, i) => doc.splitTextToSize(ascii(v || ""), cols[i][2] - 3));
    const hgt = Math.max(...cells.map(x => x.length)) * 4.6;
    if (y + hgt > 260){ doc.addPage(); y = 20; }
    cells.forEach((v, i) => text(v, cols[i][0] + 2, y)); text(gbp(l.amount), R - 2, y, {align:"right"});
    y += hgt + 2; doc.setDrawColor(211, 219, 230); doc.line(L, y - 3.5, R, y - 3.5);
  }
  doc.setFont("helvetica", "bold"); doc.setFontSize(11); text("Total", R - 40, y + 3); text(gbp(c.total), R - 2, y + 3, {align:"right"}); y += 14;
  if (y > 230){ doc.addPage(); y = 20; }
  doc.setFontSize(10); text("Bank details", L, y); doc.setFont("helvetica", "normal"); y += 6;
  text(b ? `${b.account_name}    Sort code ${fmtSort(b.sort_code)}    Account ${b.account_number}    Reference ${c.ref}` : "No bank details on file", L, y); y += 8;
  doc.setFont("helvetica", "bold"); text("Receipts", L, y); doc.setFont("helvetica", "normal"); y += 6; text(doc.splitTextToSize((c.attachments || []).map(a => a.name).join(", ") || "None", R - L), L, y); y += 14;
  doc.setDrawColor(150); doc.setFont("helvetica", "bold"); text("For the bookkeeper", L, y); y += 9; doc.setFont("helvetica", "normal");
  text("Processed on", L, y); doc.line(L + 26, y + 1, L + 70, y + 1); text("Payment ref", L + 80, y); doc.line(L + 102, y + 1, R, y + 1); y += 10;
  if (c.status === "processed"){ text(fmtDate(c.processed_at), L + 28, y - 11); text(c.payment_ref || "", L + 104, y - 11); }
  doc.setFontSize(8); doc.setTextColor(120); text(`Generated ${new Date().toLocaleString("en-GB")} from the ${CLUB} claims system.`, L, 287);
  await saveFile(`${c.ref} expense form.pdf`, doc.output("blob"));
}

/* ---------- payroll ---------- */
const isTs = c => c.type === "timesheet";
function payrollCoaches(){
  return Object.values(S.people).filter(p => p.active && (p.own_rates || Object.keys(p.activity_rates || {}).length || p.is_coach));
}
function payrollRun(M){
  const closed = S.claims.some(c => isTs(c) && c.payroll_run === M);
  const run = S.claims.filter(c => isTs(c) && (closed ? c.payroll_run === M : (c.status === "approved" && c.payroll_month <= M)));
  const waiting = closed ? [] : S.claims.filter(c => isTs(c) && ["pending","returned"].includes(c.status) && c.payroll_month <= M);
  const ids = new Set(payrollCoaches().map(p => p.id)); run.forEach(c => ids.add(c.claimant));
  const H = 1 + holPct() / 100;
  const rows = [...ids].map(id => {
    const mine = run.filter(c => c.claimant === id), byHead = {}; let hours = 0, total = 0; const comments = [];
    for (const c of mine) for (const l of c.lines || []){ byHead[l.activity_key] = r2((byHead[l.activity_key] || 0) + num(l.amount)); hours += num(l.hours); total += num(l.amount); }
    total = r2(total); hours = r2(hours);
    const avg = hours ? r2(total / H / hours) : null, gross = hours ? r2(avg * hours) : 0, hol = r2(total - gross);
    if (!hours) comments.push(`No ${monthShort(M)} hours`);
    const late = [...new Set(mine.filter(c => c.payroll_month !== c.work_month || c.work_month !== M).map(c => monthShort(c.work_month)))];
    if (late.length) comments.push(`Includes late ${late.join(", ")} timesheet${late.length > 1 ? "s" : ""}`);
    const sessionNotes = [...new Set(mine.flatMap(c => (c.lines || []).map(l => l.session)).filter(Boolean))];
    return {id, name: personName(id), approver: [...new Set(mine.map(c => personName(c.first_approver)))].join(", "), hours, avg, gross, hol, total, byHead, comment: comments.join("; "), sessions: sessionNotes, claims: mine};
  }).sort((a, b) => a.name.localeCompare(b.name));
  const processed = closed;
  return {M, run, waiting, rows, processed, hours: r2(rows.reduce((t, r) => t + r.hours, 0)), gross: r2(rows.reduce((t, r) => t + r.gross, 0)), hol: r2(rows.reduce((t, r) => t + r.hol, 0)), total: r2(rows.reduce((t, r) => t + r.total, 0))};
}
function payrollMonths(){
  const set = new Set([addMonth(thisMonth(), -1), thisMonth()]);
  S.claims.filter(isTs).forEach(c => { if (c.payroll_month) set.add(c.payroll_month); if (c.payroll_run) set.add(c.payroll_run); });
  return [...set].sort().reverse();
}
function defaultPayMonth(){
  const open = S.claims.filter(c => isTs(c) && c.status === "approved").map(c => c.payroll_month).sort();
  return open[0] || addMonth(thisMonth(), -1);
}
function viewPayroll(){
  if (!S.payMonth) S.payMonth = defaultPayMonth();
  const R = payrollRun(S.payMonth), M = S.payMonth, withHours = R.rows.filter(r => r.hours);
  let h = `<div><h2>Payroll</h2><p class="lede">Payroll runs from the 1st to the last day of each month, and coaches are asked for timesheets by the ${ordinal(askDay())} of the next month (reminders go out on the ${reminderDays().map(ordinal).join(" and ")}). Anything submitted up to the ${ordinal(dueDay())} still goes into that month's payroll. Choose a month to collate every approved session into one record per coach, with their average hourly rate and the ${holPct()}% holiday pay worked out from the total.</p></div>
    <section class="panel" style="padding:14px"><div class="row">
      <label style="flex:1;min-width:200px">Payroll month<select data-act-change="pay-month" id="payMonth">${payrollMonths().map(m => `<option value="${m}" ${m === M ? "selected" : ""}>${monthName(m)}${S.claims.some(c => isTs(c) && c.payroll_run === m) ? " · processed" : ""}</option>`).join("")}</select></label>
      <button class="btn primary" data-act="gen-payroll">Generate payroll (Excel)</button>
    </div>
    <p class="sub" style="margin:0">Covers sessions from 1 to ${lastDay(M)} ${monthName(M)} (due ${fmtDate(askDate(M))}, final cut-off ${fmtDate(dueDate(M))}), plus any late timesheets that have rolled into this run.</p></section>`;
  if (R.waiting.length) h += `<div class="notice warn"><strong>${R.waiting.length} timesheet${R.waiting.length > 1 ? "s" : ""} for this payroll ${R.waiting.length > 1 ? "aren't" : "isn't"} approved yet:</strong> ${R.waiting.map(c => `${esc(c.ref)} (${esc(personName(c.claimant))}, ${esc(st(c).label.toLowerCase())})`).join(", ")}. ${R.waiting.length > 1 ? "They" : "It"} won't be included unless approved before you generate. If approved later, ${R.waiting.length > 1 ? "they roll" : "it rolls"} into the next payroll.</div>`;
  const fl = R.run.filter(c => (c.flags || []).length);
  if (fl.length) h += `<details class="notice warn"><summary style="color:inherit">${fl.length} timesheet${fl.length > 1 ? "s" : ""} in this payroll ${fl.length > 1 ? "were" : "was"} flagged as a possible double claim or long day, and approved anyway</summary><ul style="margin:6px 0 0;padding-left:1.2em">${fl.map(c => `<li><strong>${esc(c.ref)}</strong> ${esc(personName(c.claimant))}, approved by ${esc(personName(c.first_approver))}: ${c.flags.map(f => esc(f.text)).join(" ")}${c.flag_note ? ` <em>“${esc(c.flag_note)}”</em>` : ""}</li>`).join("")}</ul></details>`;
  h += `<div class="totals" style="justify-content:flex-start"><div style="align-items:flex-start"><small>Coaches with hours</small><strong>${withHours.length}</strong></div><div style="align-items:flex-start"><small>Hours</small><strong>${fmtH(R.hours)}</strong></div><div style="align-items:flex-start"><small>Gross</small><strong>${gbp(R.gross)}</strong></div><div style="align-items:flex-start"><small>Holiday pay</small><strong>${gbp(R.hol)}</strong></div><div style="align-items:flex-start"><small>Pay incl. holiday pay</small><strong>${gbp(R.total)}</strong></div></div>`;
  h += `<div class="tablebox"><table class="payroll"><thead><tr><th>Name</th><th>Approver</th><th class="num">Total hours</th><th class="num">Av rate/hr</th><th class="num">Total gross pay</th><th class="num">Hol pay</th><th class="num">Pay incl hol pay</th><th>Comments</th></tr></thead><tbody>
    ${R.rows.map(r => `<tr class="${r.hours ? "" : "muted"}"><td>${esc(r.name)}${r.claims.length ? `<div class="sub tsrefs">${r.claims.length} timesheet${r.claims.length > 1 ? "s" : ""}: ${r.claims.map(c => c.ref).sort().map(x => `<span style="white-space:nowrap">${esc(x)}</span>`).join(", ")}</div>` : ""}</td><td>${esc(r.approver)}</td><td class="num">${r.hours ? esc(r.hours) : "0"}</td><td class="num">${r.avg == null ? "–" : r2(r.avg).toFixed(2)}</td><td class="num">${r.gross.toFixed(2)}</td><td class="num">${r.hol.toFixed(2)}</td><td class="num ${r.total ? "paycell" : ""}">${r.total.toFixed(2)}</td><td>${esc(r.comment)}</td></tr>`).join("")}
    <tr class="tot"><td><strong>Totals</strong></td><td></td><td class="num"><strong>${esc(R.hours)}</strong></td><td></td><td class="num"><strong>${R.gross.toFixed(2)}</strong></td><td class="num"><strong>${R.hol.toFixed(2)}</strong></td><td class="num"><strong>${R.total.toFixed(2)}</strong></td><td></td></tr></tbody></table></div>`;
  if (R.processed) h += `<div class="notice ok">The ${esc(monthName(M))} payroll was marked as processed${(c => c ? ` by ${esc(personName(c.processed_by))} on ${fmtDate(c.processed_at)}` : "")(R.run[0])}. Its ${R.run.length} timesheets show as processed to the coaches.</div>`;
  else if (R.run.length && !isBookkeeper()) h += `<p class="sub" style="text-align:right">Only the bookkeeper (${esc(bookkeeperNames())}) can mark this payroll as processed.</p>`;
  else if (R.run.length && isBookkeeper()) h += S.confirmRun
    ? `<div class="notice warn row"><span style="flex:1">Mark ${R.run.length} approved timesheet${R.run.length > 1 ? "s" : ""} as processed in the ${esc(monthName(M))} payroll? Do this after you've sent the payroll. They can't be edited afterwards.</span><button class="btn small" data-act="run-cancel">Not yet</button><button class="btn small good" data-act="run-yes">Mark as processed</button></div>`
    : `<div class="row end"><button class="btn" data-act="run-confirm">Mark ${esc(monthName(M))} payroll as processed</button></div>`;
  return h;
}
async function generatePayroll(){
  const R = payrollRun(S.payMonth), M = S.payMonth;
  let ExcelJS; try { ExcelJS = await loadLib("exceljs"); } catch (e) { toast("The spreadsheet maker didn't load. Check your connection and try again."); return; }
  const heads = acts(), wb = new ExcelJS.Workbook(); wb.creator = CLUB;
  const ws = wb.addWorksheet(`Payroll ${monthShort(M).slice(0, 3)} ${M.slice(0, 4)}`, {views: [{state: "frozen", xSplit: 1, ySplit: 6}]});
  const col = n => { let s = ""; n++; while (n){ const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const H0 = 9, HL = H0 + heads.length - 1, CC = HL + 1, first = 7, last = first + R.rows.length - 1, totRow = last + 1;
  const yellow = {type: "pattern", pattern: "solid", fgColor: {argb: "FFFFFF00"}}, green = {type: "pattern", pattern: "solid", fgColor: {argb: "FF92D050"}}, grey = {type: "pattern", pattern: "solid", fgColor: {argb: "FFF2F2F2"}};
  const thin = {style: "thin", color: {argb: "FF999999"}};
  ws.getCell("A1").value = "Coaching (Hockey)"; ws.getCell("A1").font = {bold: true};
  ws.getCell("B1").value = `Payroll: ${monthName(M)} (1–${lastDay(M)} ${monthShort(M)})`; ws.getCell("B1").font = {bold: true, size: 12};
  ws.getCell("A4").value = "Code " + payCode();
  ws.getCell("C2").value = "Holiday pay"; ws.getCell("D2").value = holPct() / 100; ws.getCell("D2").numFmt = "0.00%";
  ws.getCell("B3").value = `Generated ${new Date().toLocaleString("en-GB")} · ${R.run.length} approved timesheets`; ws.getCell("B3").font = {italic: true, size: 9, color: {argb: "FF666666"}};
  for (let r = 1; r <= 4; r++) ws.getCell("A" + r).fill = yellow;
  const hdr = ["", "", "Total Hours", "Av rate/hr", "Total Gross Pay", "Hol pay", "Pay incl Hol Pay", "Comments", "Analysis"];
  hdr.forEach((t, i) => { if (t){ const c = ws.getCell(4, i + 1); c.value = t; c.font = {bold: true}; c.alignment = {wrapText: true, vertical: "bottom", horizontal: i === 7 ? "center" : "center"}; } });
  heads.forEach((a, i) => { const c = ws.getCell(4, H0 + 1 + i); c.value = a.label; c.alignment = {wrapText: true, vertical: "middle", horizontal: "center"}; c.border = {left: thin, right: thin, top: thin}; c.font = {size: 9}; });
  ws.getCell(4, CC + 1).value = "Comment - activity, e.g. age group training, home or away match"; ws.getCell(4, CC + 1).alignment = {wrapText: true, vertical: "middle"}; ws.getCell(4, CC + 1).font = {size: 9};
  ws.getRow(4).height = 64;
  ws.getCell(5, 8).value = "TOTALS"; ws.getCell(5, 8).font = {bold: true}; ws.getCell(5, 8).alignment = {horizontal: "right"};
  for (let k = H0 - 1; k <= HL; k++){ const L = col(k), c = ws.getCell(5, k + 1); const v = k === H0 - 1 ? R.total : r2(R.rows.reduce((t, r) => t + (r.byHead[heads[k - H0].key] || 0), 0)); c.value = R.rows.length ? {formula: `SUM(${L}${first}:${L}${last})`, result: v} : 0; c.numFmt = "#,##0.00"; c.font = {bold: true}; c.border = {top: thin, bottom: thin}; }
  ["Name", "Approver", "", "", "£", "", "£", "", ""].forEach((t, i) => { const c = ws.getCell(6, i + 1); c.value = t; c.font = {bold: true}; c.fill = grey; c.border = {bottom: thin}; });
  for (let k = H0; k <= CC; k++){ ws.getCell(6, k + 1).fill = grey; ws.getCell(6, k + 1).border = {bottom: thin}; }
  R.rows.forEach((r, i) => {
    const n = first + i, row = ws.getRow(n), ana = `I${n}`;
    row.getCell(1).value = r.name; row.getCell(2).value = r.approver;
    row.getCell(3).value = r.hours;
    row.getCell(4).value = {formula: `IF(C${n}=0,"",ROUND(G${n}/(1+$D$2)/C${n},2))`, result: r.avg == null ? "" : r.avg};
    row.getCell(5).value = {formula: `IF(C${n}=0,0,ROUND(C${n}*D${n},2))`, result: r.gross};
    row.getCell(6).value = {formula: `G${n}-E${n}`, result: r.hol};
    row.getCell(7).value = {formula: ana, result: r.total};
    row.getCell(8).value = r.comment;
    row.getCell(9).value = {formula: `SUM(${col(H0)}${n}:${col(HL)}${n})`, result: r.total};
    heads.forEach((a, j) => { const v = r.byHead[a.key]; if (v) row.getCell(H0 + 1 + j).value = v; });
    row.getCell(CC + 1).value = r.sessions.slice(0, 6).join("; ") + (r.sessions.length > 6 ? "; …" : "");
    [4, 5, 6, 7, 9].forEach(k => row.getCell(k).numFmt = "#,##0.00");
    for (let k = H0 + 1; k <= HL + 1; k++){ row.getCell(k).numFmt = '"£"#,##0.00;-"£"#,##0.00;""'; row.getCell(k).border = {left: thin, right: thin}; }
    if (r.total > 0) row.getCell(7).fill = green;
  });
  const tr = ws.getRow(totRow);
  [[3, R.hours], [5, R.gross], [6, R.hol], [7, R.total], [9, R.total]].forEach(([k, v]) => { const L = col(k - 1); tr.getCell(k).value = R.rows.length ? {formula: `SUM(${L}${first}:${L}${last})`, result: v} : 0; tr.getCell(k).font = {bold: true}; tr.getCell(k).numFmt = k === 3 ? "General" : "#,##0.00"; tr.getCell(k).border = {top: {style: "double"}}; });
  ws.autoFilter = {from: {row: 6, column: 1}, to: {row: Math.max(6, last), column: 2}};
  ws.getColumn(1).width = 24; ws.getColumn(2).width = 18; ws.getColumn(3).width = 9; ws.getColumn(4).width = 9; ws.getColumn(5).width = 11; ws.getColumn(6).width = 9; ws.getColumn(7).width = 11; ws.getColumn(8).width = 34; ws.getColumn(9).width = 11;
  for (let k = H0 + 1; k <= HL + 1; k++) ws.getColumn(k).width = 10.5; ws.getColumn(CC + 1).width = 50;
  const s2 = wb.addWorksheet("Sessions", {views: [{state: "frozen", ySplit: 1}]});
  s2.addRow(["Name", "Ref", "Date", "Timesheet heading", "Comment", "Hours", "Rate £/hr", "Amount £", "Month worked", "Late", "Submitted", "Approved by", "Approved on", "Section"]).font = {bold: true};
  for (const c of R.run.slice().sort((a, b) => personName(a.claimant).localeCompare(personName(b.claimant)) || String(a.ref).localeCompare(String(b.ref))))
    for (const l of (c.lines || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date))))
      s2.addRow([personName(c.claimant), c.ref, l.date, actLabel(l), l.session, num(l.hours), num(l.rate), num(l.amount), monthName(c.work_month), c.late ? "Yes" : "", isoDay(c.submitted_at), personName(c.first_approver), isoDay(c.first_approved_at), c.section_label || sectionLabel(c.section)]);
  [24, 10, 11, 30, 34, 7, 9, 10, 14, 6, 11, 18, 11, 22].forEach((w, i) => s2.getColumn(i + 1).width = w);
  s2.getColumn(7).numFmt = "0.00"; s2.getColumn(8).numFmt = "0.00";
  s2.autoFilter = {from: {row: 1, column: 1}, to: {row: 1, column: 14}};
  const buf = await wb.xlsx.writeBuffer();
  await saveFile(`RHC payroll ${monthName(M)}.xlsx`, new Blob([buf], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}));
}

/* ---------- admin: people ---------- */
function viewPeople(){
  const ppl = Object.values(S.people).sort((a,b) => (a.active - b.active) || (a.full_name || "").localeCompare(b.full_name || ""));
  const row = p => `<div class="personrow" data-person="${esc(p.id)}">
    <div><strong>${esc(p.full_name || "(no name)")}</strong>${p.active ? "" : ` <span class="pill pending">New</span>`}<div class="sub">${esc(p.email)}</div><div class="sub">${esc(p.club_role)}</div></div>
    <div class="checks">
      <label><input type="checkbox" data-r="active" ${p.active ? "checked" : ""}> Active</label>
      <label><input type="checkbox" data-r="dofh" ${p.is_dofh ? "checked" : ""}> Director of Hockey</label>
      <label><input type="checkbox" data-r="finance" ${p.is_finance ? "checked" : ""}> Finance (approves expenses)</label>
      <label><input type="checkbox" data-r="books" ${p.is_bookkeeper ? "checked" : ""}> Bookkeeper</label>
      <label><input type="checkbox" data-r="admin" ${p.is_admin ? "checked" : ""}> Admin</label>
      <label><input type="checkbox" data-r="firstxi" ${p.is_first_xi ? "checked" : ""}> 1st XI player (away-match mileage)</label>
      <div class="payby"><label><input type="checkbox" data-r="contract" ${p.contract_mileage ? "checked" : ""}> Mileage under contract:</label>
        <label>£ per mile <input type="number" step="0.01" min="0" data-r="crate" value="${p.contract_mileage_rate == null ? "" : esc(p.contract_mileage_rate)}" style="width:80px"></label>
        <label>free miles per journey <input type="number" step="1" min="0" data-r="cfree" value="${p.contract_free_miles == null ? "" : esc(p.contract_free_miles)}" style="width:70px"></label></div>
      <details class="actrates" ${(p.captain_sections || []).length ? "open" : ""}><summary>Section captain (approves timesheets)${(p.captain_sections || []).length ? `: ${esc((p.captain_sections || []).map(sectionLabel).filter(Boolean).join(", "))}` : ""}</summary>
        <div class="capgrid">${sections().map(x => `<label><input type="checkbox" data-r="cap" value="${esc(x.key)}" ${(p.captain_sections || []).includes(x.key) ? "checked" : ""}> ${esc(x.label)}</label>`).join("")}</div>
      </details>
      <div class="payby"><span>Timesheet rates</span>
        <label><input type="radio" name="payby-${esc(p.id)}" data-r="payby" value="heading" ${p.own_rates ? "" : "checked"}> Rates by timesheet heading</label>
        <label><input type="radio" name="payby-${esc(p.id)}" data-r="payby" value="own" ${p.own_rates ? "checked" : ""}> Sets own rates</label>
      </div>
      <details class="actrates" ${p.own_rates ? "hidden" : ""} data-r="heading-rates"><summary>Rates by timesheet heading${Object.keys(p.activity_rates || {}).length ? ` (${Object.keys(p.activity_rates).length} set)` : " (none set)"}</summary>
        <p class="sub" style="margin:6px 0">Hourly rates including holiday pay. They can only claim under headings that have a rate.</p>
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
  const fin = ppl.filter(p => p.active && p.is_finance).length, doh = ppl.filter(p => p.active && p.is_dofh).length;
  return `<div><h2>People</h2><p class="lede">Activate new accounts and give people their roles. Timesheets are approved by the Director of Hockey or the captain of the section; expense claims by finance. Nobody can approve their own claim. Set each coach's hourly rate for every timesheet heading they work, or tick "Sets own rates".</p></div>
    ${fin < 2 ? `<div class="notice warn">${fin ? "Only one finance approver is set. Add a second (e.g. the Chair) so finance's own expense claims can be approved." : "No finance approver is set yet, so no expense claim can be approved."}</div>` : ""}
    ${!doh ? `<div class="notice warn">No Director of Hockey is set. Timesheets can only be approved by section captains.</div>` : ""}
    <section class="panel" style="gap:0;padding-block:6px">${ppl.length ? ppl.map(row).join("") : `<p class="sub">Nobody has created an account yet.</p>`}</section>`;
}
async function savePerson(id){
  const r = document.querySelector(`[data-person="${CSS.escape(id)}"]`), q = s => r.querySelector(s);
  const ar = {}; r.querySelectorAll("[data-actrate]").forEach(i => { const v = String(i.value).trim(); if (v !== "") ar[i.dataset.actrate] = String(r2(v)); });
  if (q('[data-r="contract"]').checked && !(num(q('[data-r="crate"]').value) > 0)){ toast("Enter the contract mileage rate in £ per mile"); return; }
  const p = {active:q('[data-r="active"]').checked, is_dofh:q('[data-r="dofh"]').checked, is_finance:q('[data-r="finance"]').checked, is_bookkeeper:q('[data-r="books"]').checked, is_admin:q('[data-r="admin"]').checked,
    captain_sections:[...r.querySelectorAll('[data-r="cap"]:checked')].map(i => i.value),
    is_first_xi:q('[data-r="firstxi"]').checked, contract_mileage:q('[data-r="contract"]').checked,
    contract_mileage_rate:blank(q('[data-r="crate"]').value) ? null : num(q('[data-r="crate"]').value), contract_free_miles:blank(q('[data-r="cfree"]').value) ? 0 : num(q('[data-r="cfree"]').value), own_rates:(r.querySelector('[data-r="payby"]:checked') || {}).value === "own", activity_rates:ar};
  const {error} = await S.sb.rpc("admin_update_person", {p_user:id, p});
  if (error){ toast(errText(error)); return; }
  toast("Saved " + (S.people[id] && S.people[id].full_name || "")); await loadAll(false);
}

/* ---------- admin: settings ---------- */
function viewSettings(){
  const s = S.settings;
  return `<div><h2>Settings</h2><p class="lede">Club-wide settings for timesheets and expense claims.</p></div>
  <section class="panel"><h3>Payroll and contacts</h3><div class="grid">
    <label>Timesheet deadline told to coaches <span class="hint">day of the following month</span><input id="sAsk" type="number" min="1" max="28" step="1" value="${esc(askDay())}"></label>
    <label>Final cut-off for that month's payroll <span class="hint">day; later timesheets roll into the next payroll</span><input id="sDue" type="number" min="1" max="28" step="1" value="${esc(dueDay())}"></label>
    <label>Reminder emails to coaches <span class="hint">days of the month, e.g. 1, 5</span><input id="sRem" value="${esc(reminderDays().join(", "))}"></label>
    <label>Mileage rate (£ per mile)<input id="sRate" type="number" min="0" step="0.01" value="${esc(mileRate())}"></label>
    <label>Coaching mileage: free miles per journey <span class="hint">not claimable</span><input id="sFree" type="number" min="0" step="1" value="${esc(freeMiles())}"></label>
    <label>1st XI mileage: minimum players in the car<input id="sMinPl" type="number" min="1" max="9" step="1" value="${esc(minPlayers())}"></label>
    <label>Daily hours limit <span class="hint">more than this in one day gets flagged</span><input id="sMaxDay" type="number" min="1" max="24" step="0.5" value="${esc(maxDay())}"></label>
    <label>Holiday pay % <span class="hint">included in the hourly rates</span><input id="sHol" type="number" min="0" step="0.01" value="${esc(holPct())}"></label>
    <label>Payroll budget code <span class="hint">shown on the payroll spreadsheet</span><input id="sCode" value="${esc(payCode())}"></label>
    <label>Chair's email <span class="hint">for "RHC or GARC?" questions</span><input id="sChair" type="email" value="${esc(s.chair_email || "")}"></label>
    <label>Finance email<input id="sFin" type="email" value="${esc(s.finance_email || "")}"></label>
  </div><div class="row end"><button class="btn primary" data-act="save-settings">Save settings</button></div></section>
  <section class="panel" id="secEditor">
    <div><h3>Sections</h3><p class="sub" style="margin:4px 0 0">Every timesheet is for one section. Its captains (or the Director of Hockey) approve it. Choose captains in People.</p></div>
    <div class="tablebox"><table class="lines"><thead><tr><th>Section</th><th>Captains</th><th></th></tr></thead><tbody>
    ${secDraft().map((x, i) => `<tr><td><input data-sec-i="${i}" value="${esc(x.label)}" aria-label="Section name"></td><td class="sub" style="padding-top:12px">${esc(Object.values(S.people).filter(p => p.active && (p.captain_sections || []).includes(x.key)).map(p => p.full_name).join(", ") || "None yet")}</td><td><button class="btn small danger" data-act="sec-del" data-i="${i}" aria-label="Remove section">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><button class="btn small" data-act="sec-add">+ Add section</button><button class="btn primary" data-act="sec-save">Save sections</button></div>
  </section>
  <section class="panel" id="actEditor">
    <div><h3>Timesheet headings</h3><p class="sub" style="margin:4px 0 0">The headings coaches claim hours under. They become the columns of the payroll spreadsheet, in this order. Each person's rate for each heading is set in People.</p></div>
    <div class="tablebox"><table class="lines"><thead><tr><th>Heading</th><th>Group</th><th></th></tr></thead><tbody>
    ${actDraft().map((a, i) => `<tr><td><input data-act-i="${i}" data-act-k="label" value="${esc(a.label)}" aria-label="Heading name"></td><td><select data-act-i="${i}" data-act-k="group" aria-label="Group">${ACT_GROUPS.concat(ACT_GROUPS.includes(a.group) || !a.group ? [] : [a.group]).map(g => `<option ${g === a.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></td><td><button class="btn small danger" data-act="act-del" data-i="${i}" aria-label="Remove heading">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><button class="btn small" data-act="act-add">+ Add heading</button><button class="btn primary" data-act="act-save">Save headings</button></div>
  </section>
  <section class="panel" id="blEditor">
    <div><h3>Budget lines</h3><p class="sub" style="margin:4px 0 0">When finance approves an expense claim, they choose one of these for each item. Tick the budget areas each line appears in; finance sees those lines first for that area.</p></div>
    <div class="tablebox"><table class="lines"><thead><tr><th style="width:7em">Code</th><th>Budget line</th>${AREAS.map(([k, n]) => `<th title="${esc(areaName(k))}">${esc(k === "schools" ? "Schools" : k === "ta" ? "TA" : n)}</th>`).join("")}<th></th></tr></thead><tbody>
    ${blDraft().map((x, i) => `<tr><td><input data-bl-i="${i}" data-bl-k="code" value="${esc(x.code || "")}" aria-label="Code" placeholder="none"></td><td><input data-bl-i="${i}" data-bl-k="label" value="${esc(x.label)}" aria-label="Budget line name"></td>${AREAS.map(([k]) => `<td><input type="checkbox" data-bl-i="${i}" data-bl-k="area:${k}" ${lineAreas(x).includes(k) ? "checked" : ""} aria-label="${esc(areaName(k))}"></td>`).join("")}<td><button class="btn small danger" data-act="bl-del" data-i="${i}" aria-label="Remove budget line">✕</button></td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><button class="btn small" data-act="bl-add">+ Add budget line</button><button class="btn primary" data-act="bl-save">Save budget lines</button></div>
  </section>`;
}
function blDraft(){ if (!S.blDraft) S.blDraft = JSON.parse(JSON.stringify(budgetLines())); return S.blDraft; }
function secDraft(){ if (!S.secDraft) S.secDraft = JSON.parse(JSON.stringify(sections())); return S.secDraft; }
function actDraft(){ if (!S.actDraft) S.actDraft = JSON.parse(JSON.stringify(acts())); return S.actDraft; }
function keyFrom(x, used, fallback){ let key = x.key || String(x.code || x.label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 34) || fallback; while (used.has(key)) key = key.slice(0, 34) + "_" + Math.random().toString(36).slice(2, 5); used.add(key); return key; }

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
  saveLocalDraft(); syncUploadState();
  const fi = $("#fFile"); if (fi) fi.value = "";
}

/* ---------- local draft (this browser only) ---------- */
const DRAFT_KEY = () => "rhc-draft2-" + (S.user ? S.user.id : "");
function saveLocalDraft(){ try { if (S.draft && !S.draft.editingId) localStorage.setItem(DRAFT_KEY(), JSON.stringify(S.draft)); } catch (e) {} }
function loadLocalDraft(){ try { const s = localStorage.getItem(DRAFT_KEY()); const d = s ? JSON.parse(s) : null; return d && TYPES[d.type] ? d : null; } catch (e) { return null; } }
function clearLocalDraft(){ try { localStorage.removeItem(DRAFT_KEY()); } catch (e) {} }

/* ---------- data ---------- */
async function loadClaims(){
  const {data, error} = await S.sb.from("claims").select("*").order("submitted_at", {ascending:false}).limit(3000);
  if (!error) S.claims = (data || []).filter(c => TYPES[c.type]);
}
async function loadAll(first){
  const uid = S.user.id;
  const [p, s, pp, n, bd] = await Promise.all([
    S.sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
    S.sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    S.sb.from("profiles").select("*"),
    S.sb.rpc("staff_names"),
    S.sb.from("bank_details").select("*")
  ]);
  S.me = p.data || null;
  if (s.data) S.settings = s.data;
  S.people = Object.fromEntries((pp.data || []).map(x => [x.id, x]));
  S.names = Object.fromEntries((n.data || []).map(x => [x.id, x.full_name]));
  S.banks = Object.fromEntries((bd.data || []).map(x => [x.user_id, x]));
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
  if (error){ toast(errText(error)); render(); return null; }
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
    case "tab": S.actDraft = S.secDraft = S.blDraft = null; S.confirmRun = false; S.tab = b.dataset.tab; if (S.tab !== "new") S.lastSubmitted = null; S.editingDetails = false; render(); window.scrollTo(0,0); break;
    case "type": if (!S.draft || S.draft.type !== b.dataset.type){ S.draft = blankDraft(b.dataset.type); saveLocalDraft(); } render(); break;
    case "entity": S.draft.entity = b.dataset.entity; saveLocalDraft(); render(); { const t = $("#fDesc"); if (t) t.focus(); } break;
    case "entity-change": S.draft.entity = ""; render(); break;
    case "add-line": { const d = S.draft, last = d.lines[d.lines.length - 1] || {};
      d.lines.push(d.type === "timesheet" ? {date: last.date || d.work_month + "-01", activity_key: last.activity_key || "", session: "", hours: ""} : {date: last.date || today(), item: "", supplier: "", amount: ""}); render(); break; }
    case "add-mileage": { const d = S.draft, last = [...d.lines].reverse().find(isMile) || {}; d.lines.push({kind:"mileage", basis: myBases().includes(last.basis) ? last.basis : myBases()[0], date: today(), from: last.from || "", to: "", purpose: "", miles: "", ret: true}); render(); { const t = $(`#ln-${d.lines.length - 1}-basis`); if (t) t.focus(); } break; }
    case "del-line": S.draft.lines.splice(+b.dataset.i, 1); render(); break;
    case "del-file": { const [gone] = S.draft.attachments.splice(+b.dataset.i, 1); syncUploadState(); saveLocalDraft();
      if (gone && !S.draft.editingId) S.sb.storage.from("receipts").remove([gone.path]); break; }
    case "open-file": openFile(b.dataset.path); break;
    case "dl-file": { const c = claim(), f = c && (c.attachments || [])[+b.dataset.i]; if (f) downloadAttachment(f); break; }
    case "ex-pdf": { const c = claim(); if (c){ b.disabled = true; await expensePdf(c); b.disabled = false; } break; }
    case "reset": S.draft = blankDraft(S.draft && S.draft.type); if (S.draft.type === "expense") S.draft.entity = ""; saveLocalDraft(); render(); break;
    case "cancel-edit": S.draft = loadLocalDraft(); S.tab = "mine"; render(); break;
    case "submit": submitDraft(); break;
    case "another": S.lastSubmitted = null; S.draft = blankDraft(); render(); break;
    case "edit-details": S.tab = "mine"; S.editingDetails = true; render(); break;
    case "cancel-details": S.editingDetails = false; render(); break;
    case "change-email": {
      const email = $("#pEmail").value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ toast("Enter a valid email address"); break; }
      const {error} = await S.sb.auth.updateUser({email}, {emailRedirectTo: location.origin + location.pathname});
      toast(error ? errText(error) : "Check your inbox to confirm the new email. You may need to confirm from your old address too."); break;
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
      const {id: uid, email, full_name, club_role, created_at, accepted_terms_at} = S.me;
      await saveFile(`my-claims-data-${today()}.json`, new Blob([JSON.stringify({exported_at: new Date().toISOString(), account: {id: uid, email, full_name, club_role, created_at, accepted_terms_at}, bank_details: S.myBank, claims: mine}, null, 2)], {type: "application/json"})); break;
    }
    case "accept-terms": rpc("accept_terms", {}, "Thanks"); break;
    case "coach-view": S.viewAsCoach = !S.viewAsCoach; S.tab = S.viewAsCoach ? "mine" : homeTab(); S.editingDetails = false; render(); window.scrollTo(0,0); break;
    case "copy": { const t = b.dataset.text; try { await navigator.clipboard.writeText(t); toast("Copied " + t); } catch (err) { toast("Select the text and copy it"); } break; }
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
      const {error} = await S.sb.functions.invoke("admin-users", {body: {action: "change_email", user_id: id, email}});
      b.disabled = false;
      if (error){ let msg = errText(error); try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (err) {} toast(msg); break; }
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
      S.draft = c.type === "timesheet"
        ? {type:"timesheet", editingId:c.id, editingRef:c.ref, section:c.section || "", work_month:c.work_month, description:c.description || "", flag_note:c.flag_note || "", flag_ok:false, lines:(c.lines || []).map(l => ({date:l.date, activity_key:l.activity_key, session:l.session, hours:l.hours, rate:l.own_rate ? l.rate : undefined})), declare:false}
        : {type:"expense", editingId:c.id, editingRef:c.ref, entity:c.entity, description:c.description || "", team:c.team || "", lines:(c.lines || []).map(l => isMile(l) ? {kind:"mileage", basis:l.basis || "coaching", date:l.date, from:l.from, to:l.to, purpose:l.purpose, miles:l.miles, ret:!!l.ret, players:l.players, rt_club:l.rt_club, rt_origin:l.rt_origin, chair_ok:!!l.chair_ok, chair_date:l.chair_date} : {kind:"item", date:l.date, item:l.item, supplier:l.supplier, amount:l.amount}), attachments:(c.attachments || []).slice(), declare:false};
      S.tab = "new"; S.lastSubmitted = null; render(); window.scrollTo(0,0); break; }
    case "delete-claim": S.confirmDelete = id; render(); break;
    case "delete-cancel": S.confirmDelete = null; render(); break;
    case "delete-yes": { S.confirmDelete = null; b.disabled = true;
      const {data, error} = await S.sb.rpc("delete_claim", {p_claim_id: id});
      if (error){ toast(errText(error)); b.disabled = false; break; }
      const paths = (Array.isArray(data) ? data : []).map(x => x.path).filter(Boolean);
      if (paths.length) S.sb.storage.from("receipts").remove(paths);
      toast("Deleted"); await loadAll(false); render(); break; }
    case "approve": { const c = claim(); if (!c) break; const args = {p_claim_id:id};
      if (c.type === "expense"){ const al = allocFor(c), miss = al.findIndex(x => !x.area || !x.line);
        if (miss >= 0){ toast(`Item ${miss + 1}: choose the area and budget line`); break; }
        args.p_allocations = al.map(x => ({area: x.area, entity: areaEnt(x.area), line: x.line})); }
      b.disabled = true; rpc("approve_claim", args, `${c.ref} approved. ${c.type === "expense" ? "The bookkeeper has been emailed." : "It's ready for the " + monthName(c.payroll_month) + " payroll."}`); break; }
    case "reject": S.decideOpen = id; render(); { const t = $("#rejNote-" + CSS.escape(id)); if (t) t.focus(); } break;
    case "reject-cancel": S.decideOpen = null; render(); break;
    case "reject-yes": { const t = $("#rejNote-" + CSS.escape(id)), note = t ? t.value.trim() : "";
      if (!note){ toast("Add a reason so they can fix it"); break; }
      S.decideOpen = null; rpc("return_claim", {p_claim_id:id, p_reason:note}, "Returned. They've been emailed."); break; }
    case "processed": { b.disabled = true; const inp = $("#payRef-" + CSS.escape(id)); rpc("mark_processed", {p_claim_id:id, p_payment_ref: inp ? inp.value.trim() : ""}, "Marked as processed. The claimant has been emailed."); break; }
    case "ex": S.exFilter = b.dataset.f; render(); break;
    case "export-ex": exportExpenses(); break;
    case "gen-payroll": b.disabled = true; b.textContent = "Generating…"; try { await generatePayroll(); } catch (err) { toast("The spreadsheet couldn't be made: " + errText(err)); } b.disabled = false; b.textContent = "Generate payroll (Excel)"; break;
    case "run-confirm": S.confirmRun = true; render(); break;
    case "run-cancel": S.confirmRun = false; render(); break;
    case "run-yes": S.confirmRun = false; rpc("process_payroll", {p_month: S.payMonth}, `${monthName(S.payMonth)} payroll marked as processed`); break;
    case "save-person": savePerson(id); break;
    case "sec-add": secDraft().push({key: "", label: ""}); render(); break;
    case "sec-del": secDraft().splice(+b.dataset.i, 1); render(); break;
    case "sec-save": { const used = new Set(), list = [];
      for (const x of secDraft()){ const label = String(x.label || "").trim(); if (!label){ toast("Every section needs a name"); return; } list.push({key: keyFrom({key: x.key, label}, used, "section"), label}); }
      const {error} = await S.sb.rpc("admin_update_sections", {p_list: list}); if (error){ toast(errText(error)); break; }
      S.secDraft = null; toast("Sections saved"); await loadAll(false); render(); break; }
    case "act-add": actDraft().push({key: "", label: "", group: "Programmes"}); render(); break;
    case "act-del": actDraft().splice(+b.dataset.i, 1); render(); break;
    case "act-save": { const used = new Set(), list = [];
      for (const x of actDraft()){ const label = String(x.label || "").trim(); if (!label){ toast("Every heading needs a name"); return; } list.push({key: keyFrom({key: x.key, label}, used, "heading"), label, group: x.group || "Programmes", rate: null}); }
      const {error} = await S.sb.rpc("admin_update_payroll_activities", {p_list: list}); if (error){ toast(errText(error)); break; }
      S.actDraft = null; toast("Headings saved"); await loadAll(false); render(); break; }
    case "bl-add": blDraft().push({key: "", code: "", label: "", areas: ["hockey"], rhc: true, garc: false}); render(); break;
    case "bl-del": blDraft().splice(+b.dataset.i, 1); render(); break;
    case "bl-save": { const used = new Set(), list = [];
      for (const x of blDraft()){ const label = String(x.label || "").trim(), code = String(x.code || "").trim(); if (!label){ toast("Every budget line needs a name"); return; } const areas = AREAS.map(a => a[0]).filter(k => lineAreas(x).includes(k)); if (!areas.length){ toast(`Tick at least one area for ${label}`); return; }
        list.push({key: keyFrom({key: x.key, code, label}, used, "line"), code, label, areas, rhc: areas.some(a => a !== "garc"), garc: areas.includes("garc")}); }
      const {error} = await S.sb.rpc("admin_update_budget_lines", {p_list: list}); if (error){ toast(errText(error)); break; }
      S.blDraft = null; toast("Budget lines saved"); await loadAll(false); render(); break; }
    case "save-settings": rpc("admin_update_settings", {p: {timesheet_due_day: Math.round(num($("#sDue").value)) || 10, coach_deadline_day: Math.round(num($("#sAsk").value)) || 7,
      reminder_days: [...new Set(String($("#sRem").value).split(/[^0-9]+/).filter(Boolean).map(Number).filter(n => n >= 1 && n <= 28))].sort((a, b) => a - b), max_daily_hours: num($("#sMaxDay").value) || 5, mileage_rate: num($("#sRate").value), mileage_free_miles: Math.max(0, num($("#sFree").value)), first_xi_min_players: Math.max(1, Math.round(num($("#sMinPl").value)) || 3), holiday_pay_pct: num($("#sHol").value), payroll_code: $("#sCode").value.trim(), chair_email: $("#sChair").value.trim(), finance_email: $("#sFin").value.trim()}}, "Settings saved"); break;
  }
});
function onExField(e){
  const t = e.target; if (!t.dataset || !t.dataset.exK) return false;
  S.ex[t.dataset.exK] = t.value;
  if (t.dataset.exK === "q"){ if (e.type !== "input") return true; const pos = t.selectionStart; render(); const n = $("#ex-q"); if (n){ n.focus(); try { n.setSelectionRange(pos, pos); } catch (x) {} } }
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
  const t = e.target;
  if (onAlloc(e) || onPayBy(e) || onExField(e)) return;
  if (t.id === "payMonth"){ if (e.type === "change"){ S.payMonth = t.value; S.confirmRun = false; render(); } return; }
  if (t.dataset && t.dataset.blI != null){ const row = blDraft()[+t.dataset.blI]; if (!row) return; const k = t.dataset.blK;
    if (k.startsWith("area:")){ const a = k.slice(5), cur = lineAreas(row).filter(z => z !== a); row.areas = t.checked ? cur.concat([a]) : cur; } else row[k] = t.type === "checkbox" ? t.checked : t.value; return; }
  if (t.dataset && t.dataset.secI != null){ const row = secDraft()[+t.dataset.secI]; if (row) row.label = t.value; return; }
  if (t.dataset && t.dataset.actI != null){ const row = actDraft()[+t.dataset.actI]; if (row) row[t.dataset.actK] = t.value; return; }
  const d = S.draft; if (!d || !t.closest("#claimForm")) return;
  const val = t.type === "checkbox" ? t.checked : t.value;
  if (t.dataset.f){ d[t.dataset.f] = val;
    if (t.dataset.f === "work_month" && e.type === "change"){ d.lines.forEach(l => { if (!l.date || l.date.slice(0, 7) !== val) l.date = val + "-01"; }); saveLocalDraft(); render(); return; } }
  else if (t.dataset.line != null){ const l = d.lines[+t.dataset.line]; if (l){ l[t.dataset.k] = val; if ((t.dataset.k === "activity_key" || t.dataset.k === "basis") && e.type === "change"){ saveLocalDraft(); render(); return; } recalc(); } }
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

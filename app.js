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
  invoice:{label:"Coaching / umpiring invoice",short:"Invoice",blurb:"You're self-employed and invoicing the club for hours.",attach:true,attachHint:"Upload your invoice (PDF preferred).",
    cols:[{k:"date",l:"Date",t:"date"},{k:"activity",l:"Activity",t:"activity"},{k:"session",l:"Session / match",t:"text"},{k:"hours",l:"Hours",t:"num"},{k:"rate",l:"Rate £/hr",t:"money"},{k:"_amt",l:"Amount",t:"calc"}]},
  payroll:{label:"Coaching / umpiring payroll",short:"Payroll",blurb:"You're paid through club payroll. Log your hours for this pay period.",attach:false,
    cols:[{k:"date",l:"Date",t:"date"},{k:"activity",l:"Activity",t:"activity"},{k:"session",l:"Session / match",t:"text"},{k:"hours",l:"Hours",t:"num"}]},
  mileage:{label:"Mileage",short:"Mileage",blurb:"You drove your own vehicle for club business.",attach:false,
    cols:[{k:"date",l:"Date",t:"date"},{k:"from",l:"From",t:"text"},{k:"to",l:"To",t:"text"},{k:"purpose",l:"Purpose",t:"text"},{k:"miles",l:"Miles (one way)",t:"num"},{k:"ret",l:"Return",t:"check"},{k:"_amt",l:"Amount",t:"calc"}]}
};
const STATUS = {
  pending:{label:"Awaiting 1st approval",cls:"pending"},
  first_approved:{label:"Awaiting 2nd approval",cls:"pending"},
  approved:{label:"With bookkeeper",cls:"approved"},
  returned:{label:"Returned",cls:"returned"},
  processed:{label:"Paid",cls:"processed"},
  withdrawn:{label:"Withdrawn",cls:"withdrawn"}
};

const S = {sb:null,user:null,me:null,settings:{mileage_rate:null,budget_areas:DEFAULT_AREAS},claims:[],people:{},names:{},
  tab:null,draft:null,authView:"signin",authMsg:"",recovery:false,lastSubmitted:null,decideOpen:null,confirmWithdraw:null,
  bkFilter:"ready",editingDetails:false,channel:null,loaded:false};

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
function headline(c){ return c.type === "payroll" ? fmtH(c.hours) : gbp(c.total); }

/* ---------- roles ---------- */
const types = () => (S.me && S.me.approver_types) || [];
const isApproverFor = t => types().includes(t);
const isApproverAny = () => types().length > 0;
const isBookkeeper = () => !!(S.me && S.me.is_bookkeeper);
const isAdmin = () => !!(S.me && S.me.is_admin);
function myRoles(){ const r = ["Coach"]; if (isApproverAny()) r.push("Approver"); if (isBookkeeper()) r.push("Bookkeeper"); if (isAdmin()) r.push("Admin"); return r; }
function toApprove(){
  return S.claims.filter(c => c.claimant !== S.me.id && isApproverFor(c.type) &&
    (c.status === "pending" || (c.status === "first_approved" && c.first_approver !== S.me.id)));
}
const readyToPay = () => S.claims.filter(c => c.status === "approved");
const pendingPeople = () => Object.values(S.people).filter(p => !p.active);
function homeTab(){
  if (isApproverAny() && toApprove().length) return "approve";
  if (isBookkeeper() && readyToPay().length) return "books";
  return S.claims.some(c => c.claimant === S.me.id) ? "mine" : "new";
}

/* ---------- calculations (display only; the database recalculates) ---------- */
function lineAmount(type, l, rate){
  if (type === "expense") return num(l.amount);
  if (type === "invoice") return num(l.hours) * num(l.rate);
  if (type === "mileage") return num(l.miles) * (l.ret ? 2 : 1) * num(rate);
  return 0;
}
function totals(type, lines, rate){
  let amount = 0, hours = 0, miles = 0;
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
  $("#who").innerHTML = S.user ? `<span>${esc((S.me && S.me.full_name) || S.user.email)}</span>${S.me && S.me.active ? myRoles().map(r => `<span class="role">${esc(r)}</span>`).join("") : ""}<button class="signout" data-act="signout">Sign out</button>` : "";
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
  m.innerHTML = v();
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
      const {data, error} = await S.sb.auth.signUp({email: email.trim(), password: pass,
        options: {data: {full_name: name, club_role: $("#aRole").value.trim()}, emailRedirectTo: location.origin + location.pathname}});
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
    <div><h2>Your details</h2><p class="lede">These appear on your claims so approvers and the bookkeeper know who to pay. Your login email is ${esc(me.email)}.</p></div>
    <div class="grid">
      <label>Full name<input id="pName" value="${esc(me.full_name)}" autocomplete="name"></label>
      <label>Club role<input id="pRole" value="${esc(me.club_role)}"></label>
    </div>
    <div class="row end"><button class="btn" data-act="cancel-details">Cancel</button><button class="btn primary" data-act="save-details">Save my details</button></div>
  </section>`;
}

/* ---------- new claim ---------- */
function blankDraft(type){ return {editingId:null,editingRef:"",type:type||null,budget_area:"",team:"",description:"",invoice_number:"",invoice_date:today(),pay_period:new Date().toISOString().slice(0,7),lines:[{date:today()}],attachments:[],declare:false}; }
function viewNew(){
  if (S.lastSubmitted) return submittedView();
  if (!S.draft) S.draft = blankDraft();
  const d = S.draft;
  let h = `<section class="panel">
    <div><h2>${d.editingId ? "Edit and resubmit " + esc(d.editingRef) : "New claim"}</h2><p class="lede">Pick the kind of claim. It needs a first and a second approval, then it goes to the bookkeeper for payment.</p></div>
    <div class="types" role="group" aria-label="Claim type">${Object.entries(TYPES).map(([k,t]) => `<button class="type" data-act="type" data-type="${k}" aria-pressed="${d.type === k}" ${d.editingId ? "disabled" : ""}><b>${esc(t.short)}</b><span>${esc(t.blurb)}</span></button>`).join("")}</div>
  </section>`;
  if (!d.type) return h + inProgressHint();
  const T = TYPES[d.type], areas = (S.settings.budget_areas && S.settings.budget_areas.length) ? S.settings.budget_areas : DEFAULT_AREAS;
  const rate = S.settings.mileage_rate;
  h += `<section class="panel" id="claimForm">
    <div class="row"><h2 style="flex:1">${esc(T.label)}</h2><span class="sub">Paying ${esc(S.me.full_name)}</span></div>
    ${d.type === "mileage" && rate == null ? `<div class="notice warn">The club mileage rate hasn't been set yet, so mileage claims can't be submitted. The club admin sets it in Settings.</div>` : ""}
    <div class="grid">
      <label>Budget area<select id="fArea" data-f="budget_area"><option value="">Choose…</option>${areas.map(a => `<option ${d.budget_area === a ? "selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
      <label>Team / squad <span class="hint">e.g. U14 girls, Men's 2s</span><input id="fTeam" data-f="team" value="${esc(d.team)}"></label>
      ${d.type === "invoice" ? `<label>Invoice number<input id="fInvNo" data-f="invoice_number" value="${esc(d.invoice_number)}"></label><label>Invoice date<input id="fInvDate" type="date" data-f="invoice_date" value="${esc(d.invoice_date)}"></label>` : ""}
      ${d.type === "payroll" ? `<label>Pay period<input id="fPeriod" type="month" data-f="pay_period" value="${esc(d.pay_period)}"></label>` : ""}
    </div>
    <label>What is this claim for?<textarea id="fDesc" data-f="description" placeholder="${d.type === "mileage" ? "e.g. Driving to the U14 regional tournament" : d.type === "expense" ? "e.g. First-aid kit restock for match day" : "e.g. U14 girls Sunday sessions, October"}">${esc(d.description)}</textarea></label>
    <div>
      <h3 style="margin-bottom:8px">${d.type === "mileage" ? "Journeys" : d.type === "expense" ? "Items" : "Hours"}</h3>
      <div class="tablebox"><table class="lines"><thead><tr>${T.cols.map(c => `<th class="${["calc","money","num"].includes(c.t) ? "num" : ""}">${esc(c.l)}</th>`).join("")}<th></th></tr></thead>
      <tbody>${d.lines.map((l,i) => `<tr>${T.cols.map(c => lineCell(c,l,i)).join("")}<td><button class="btn small danger" data-act="del-line" data-i="${i}" aria-label="Remove line" ${d.lines.length < 2 ? "disabled" : ""}>✕</button></td></tr>`).join("")}</tbody></table></div>
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="add-line">+ Add ${d.type === "mileage" ? "journey" : d.type === "expense" ? "item" : "session"}</button></div>
    </div>
    <div class="totals" id="totals"></div>
    ${T.attach ? `<div style="display:flex;flex-direction:column;gap:8px">
      <label for="fFile">${d.type === "invoice" ? "Invoice" : "Receipts"} <span class="hint">${esc(T.attachHint)}</span></label>
      <input type="file" id="fFile" multiple accept="image/*,application/pdf">
      <div class="files" id="fileList">${filesHtml(d.attachments, true)}</div>
    </div>` : ""}
    <label style="flex-direction:row;align-items:flex-start;gap:10px;font-weight:400"><input type="checkbox" id="fDeclare" data-f="declare" ${d.declare ? "checked" : ""}> <span>I confirm this claim is accurate, was incurred on ${esc(CLUB)} business, and hasn't been claimed before.</span></label>
    <div class="notice bad" id="formErr" hidden></div>
    <div class="row end">${d.editingId ? `<button class="btn" data-act="cancel-edit">Cancel</button>` : `<button class="btn" data-act="reset">Clear form</button>`}<button class="btn primary" data-act="submit" id="submitBtn">${d.editingId ? "Resubmit claim" : "Submit claim"}</button></div>
  </section>`;
  return h;
}
function inProgressHint(){
  const open = S.claims.filter(c => c.claimant === S.me.id && ["pending","first_approved","returned","approved"].includes(c.status)).length;
  return open ? `<div class="notice">You have ${open} claim${open > 1 ? "s" : ""} in progress. <button class="btn small" data-act="tab" data-tab="mine">View my claims</button></div>` : "";
}
function lineCell(c, l, i){
  const id = `ln-${i}-${c.k}`, v = l[c.k] == null ? "" : l[c.k];
  if (c.t === "calc") return `<td class="num calc" id="${id}">–</td>`;
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
  d.lines.forEach((l,i) => { const c = $(`#ln-${i}-_amt`); if (c) c.textContent = gbp(lineAmount(d.type, l, rate)); });
  const t = totals(d.type, d.lines, rate);
  let out = "";
  if (d.type === "mileage") out += `<div><small>Miles</small><strong>${t.miles.toLocaleString("en-GB")}</strong></div><div><small>Rate</small><strong>${rate != null ? gbp(rate) + "/mi" : "–"}</strong></div>`;
  if (d.type === "invoice" || d.type === "payroll") out += `<div><small>Total hours</small><strong>${fmtH(t.hours)}</strong></div>`;
  if (d.type !== "payroll") out += `<div><small>Total claimed</small><strong>${gbp(t.amount)}</strong></div>`;
  el.innerHTML = out;
}
function validate(d){
  const T = TYPES[d.type], errs = [];
  if (!d.budget_area) errs.push("Choose a budget area.");
  if (!d.description.trim()) errs.push("Say what the claim is for.");
  if (d.type === "invoice" && !d.invoice_number.trim()) errs.push("Add your invoice number.");
  if (d.type === "mileage" && S.settings.mileage_rate == null) errs.push("The club mileage rate isn't set yet.");
  const need = T.cols.filter(c => !["calc","check"].includes(c.t) && !c.optional).map(c => c.k);
  d.lines.forEach((l,i) => { for (const k of need){ const v = l[k]; if (v == null || String(v).trim() === "" || (["amount","hours","miles","rate"].includes(k) && num(v) <= 0)){ errs.push(`Line ${i+1}: fill in ${T.cols.find(c => c.k === k).l.toLowerCase()}.`); break; } } });
  if (T.attach && !d.attachments.length) errs.push(d.type === "invoice" ? "Upload your invoice." : "Upload at least one receipt.");
  if (!d.declare) errs.push("Tick the confirmation box.");
  return errs;
}
async function submitDraft(){
  const d = S.draft, errs = validate(d), box = $("#formErr");
  if (errs.length){ box.innerHTML = errs.map(esc).join("<br>"); box.hidden = false; box.scrollIntoView({block:"nearest"}); return; }
  box.hidden = true; const btn = $("#submitBtn"); btn.disabled = true; btn.textContent = "Submitting…";
  const lines = d.lines.map(l => { const o = {}; for (const c of TYPES[d.type].cols){ if (c.t === "calc") continue; o[c.k] = (c.t === "money" || c.t === "num") ? num(l[c.k]) : c.t === "check" ? !!l[c.k] : String(l[c.k] || (c.t === "activity" ? "Coaching" : "")).trim(); } return o; });
  const p = {type:d.type, budget_area:d.budget_area, team:d.team, description:d.description,
    invoice_number:d.type === "invoice" ? d.invoice_number : "", invoice_date:d.type === "invoice" ? d.invoice_date : "",
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
    ["1st approval", !!c.first_approver, c.first_approver ? personName(c.first_approver) + ", " + fmtDate(c.first_approved_at) : ""],
    ["2nd approval", !!c.second_approver, c.second_approver ? personName(c.second_approver) + ", " + fmtDate(c.second_approved_at) : ""],
    ["Paid", paid, paid ? fmtDate(c.processed_at) : (c.status === "approved" ? "With bookkeeper" : "")]
  ];
  const next = c.status === "returned" ? -1 : steps.findIndex(x => !x[1]);
  return `<ol class="track" aria-label="Progress">${steps.map((x,i) => `<li class="${x[1] ? "done" : i === next ? "next" : ""}"><b>${x[1] ? "✓ " : ""}${esc(x[0])}</b>${x[2] ? esc(x[2]) : (i === next ? "Waiting" : "")}</li>`).join("")}</ol>`;
}
function claimDetail(c, open){
  const cols = TYPES[c.type].cols;
  const cell = (k, l) => {
    if (k.t === "calc") return `<td class="num">${gbp(l.amount)}</td>`;
    if (k.t === "money") return `<td class="num">${gbp(l[k.k])}</td>`;
    if (k.t === "num") return `<td class="num">${esc(l[k.k])}</td>`;
    if (k.t === "check") return `<td>${l[k.k] ? "Yes" : "No"}</td>`;
    if (k.t === "date") return `<td>${fmtDate(l[k.k])}</td>`;
    return `<td>${esc(l[k.k])}</td>`;
  };
  return `<details ${open ? "open" : ""}><summary>Claim details</summary>
    <div style="display:flex;flex-direction:column;gap:10px">
    <p style="margin:0">${esc(c.description)}</p>
    <div class="meta">${c.invoice_number ? `<span>Invoice ${esc(c.invoice_number)}${c.invoice_date ? " · " + fmtDate(c.invoice_date) : ""}</span>` : ""}${c.pay_period ? `<span>Pay period ${esc(c.pay_period)}</span>` : ""}${c.type === "mileage" ? `<span>Rate ${gbp(c.mileage_rate)}/mile</span>` : ""}</div>
    <div class="tablebox"><table><thead><tr>${cols.map(k => `<th class="${["money","num","calc"].includes(k.t) ? "num" : ""}">${esc(k.l)}</th>`).join("")}</tr></thead>
    <tbody>${(c.lines || []).map(l => `<tr>${cols.map(k => cell(k, l)).join("")}</tr>`).join("")}</tbody></table></div>
    ${c.attachments && c.attachments.length ? `<div class="files">${filesHtml(c.attachments, false)}</div>` : ""}
    </div></details>`;
}
function claimCard(c, actions, open){
  const st = STATUS[c.status] || STATUS.pending;
  return `<article class="claim">
    <div class="head"><span class="ref">${esc(c.ref)}</span><span class="pill ${st.cls}">${esc(st.label)}</span><span class="amt">${headline(c)}</span></div>
    <div class="meta"><span><strong>${esc(personName(c.claimant))}</strong></span><span>${esc(TYPES[c.type].label)}</span><span>${esc(c.budget_area)}${c.team ? " · " + esc(c.team) : ""}</span><span>Submitted ${fmtDate(c.submitted_at)}${c.revision > 1 ? " · resubmitted " + fmtDate(c.updated_at) : ""}</span></div>
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
  const head = `<div class="row"><div style="flex:1"><h2>My claims</h2><p class="lede">Everything you've submitted, newest first. You can see each approval as it happens.</p></div><button class="btn small" data-act="edit-details">My details</button></div>`;
  if (S.editingDetails) return head + detailsCard();
  if (!mine.length) return head + `<div class="empty">You haven't submitted any claims yet.<br><br><button class="btn primary" data-act="tab" data-tab="new">Start a claim</button></div>`;
  return head + `<div class="claims">${mine.map(c => {
    const can = ["pending","first_approved","returned"].includes(c.status);
    return claimCard(c, can ? `<div class="row end"><button class="btn small danger" data-act="withdraw" data-id="${esc(c.id)}">Withdraw</button><button class="btn small primary" data-act="edit-claim" data-id="${esc(c.id)}">${c.status === "returned" ? "Fix and resubmit" : "Edit"}</button></div>${S.confirmWithdraw === c.id ? `<div class="notice warn row"><span style="flex:1">Withdraw ${esc(c.ref)}? Approvers will no longer see it.</span><button class="btn small" data-act="withdraw-cancel">Keep it</button><button class="btn small danger" data-act="withdraw-yes" data-id="${esc(c.id)}">Withdraw claim</button></div>` : ""}` : "");
  }).join("")}</div>`;
}

/* ---------- approvals ---------- */
function viewApprove(){
  const list = toApprove();
  const decided = S.claims.filter(c => c.first_approver === S.me.id || c.second_approver === S.me.id || c.returned_by === S.me.id).slice(0, 20);
  const tnames = types().map(k => TYPES[k].short.toLowerCase());
  let h = `<div><h2>To approve</h2><p class="lede">You approve ${esc(tnames.join(", "))} claims. Each claim needs a first and a second approval from two different people. You can't approve your own claims.</p></div>`;
  h += list.length ? `<div class="claims">${list.map(c => claimCard(c, decideBox(c), true)).join("")}</div>` : `<div class="empty">Nothing waiting for you. You'll get an email when a claim needs your approval.</div>`;
  if (decided.length) h += `<div><h3 style="margin:12px 0 8px">Recently decided by you</h3><div class="tablebox"><table><thead><tr><th>Claim</th><th>Claimant</th><th>Your decision</th><th>Now</th><th class="num">Value</th></tr></thead><tbody>${decided.map(c => {
    const what = c.returned_by === S.me.id ? "Returned " + fmtDate(c.returned_at) : c.first_approver === S.me.id ? "1st approval " + fmtDate(c.first_approved_at) : "2nd approval " + fmtDate(c.second_approved_at);
    const st = STATUS[c.status];
    return `<tr><td>${esc(c.ref)}</td><td>${esc(personName(c.claimant))}</td><td>${what}</td><td><span class="pill ${st.cls}">${esc(st.label)}</span></td><td class="num">${headline(c)}</td></tr>`;
  }).join("")}</tbody></table></div></div>`;
  return h;
}
function decideBox(c){
  if (S.decideOpen === c.id) return `<div class="decide"><label>Reason for returning <span class="hint">The claimant sees this and can fix and resubmit.</span><textarea id="rejNote-${esc(c.id)}"></textarea></label><div class="row end"><button class="btn" data-act="reject-cancel">Cancel</button><button class="btn danger" data-act="reject-yes" data-id="${esc(c.id)}">Return claim</button></div></div>`;
  const second = c.status === "first_approved";
  return `<div class="decide row end" style="flex-direction:row"><button class="btn danger" data-act="reject" data-id="${esc(c.id)}">Return to claimant</button><button class="btn good" data-act="approve" data-id="${esc(c.id)}">${second ? "Give second approval" : "Give first approval"} · ${headline(c)}</button></div>`;
}

/* ---------- bookkeeper ---------- */
function bkSet(f){ return f === "ready" ? readyToPay() : f === "processed" ? S.claims.filter(c => c.status === "processed") : S.claims; }
function viewBooks(){
  const f = S.bkFilter, list = bkSet(f);
  let h = `<div class="row"><div style="flex:1"><h2>Bookkeeper</h2><p class="lede">Claims with both approvals land here. Pay them, then mark each one as processed with your payment reference.</p></div>
    <div class="row">${f !== "all" && list.length ? `<button class="btn" data-act="export">Export ${f === "ready" ? "ready to pay" : "processed"} (CSV)</button>` : ""}<button class="btn primary" data-act="export-all" ${S.claims.length ? "" : "disabled"}>Export all claims (CSV)</button></div></div>
    <div class="seg" role="group" aria-label="Filter">${[["ready","Ready to pay"],["processed","Paid"],["all","All claims"]].map(([k,l]) => `<button data-act="bk" data-f="${k}" aria-pressed="${f === k}">${l} (${bkSet(k).length})</button>`).join("")}</div>`;
  if (f === "ready" && list.length){
    const money = list.filter(c => c.type !== "payroll").reduce((s,c) => s + num(c.total), 0), hrs = list.filter(c => c.type === "payroll").reduce((s,c) => s + num(c.hours), 0);
    h += `<div class="totals" style="justify-content:flex-start"><div style="align-items:flex-start"><small>To pay</small><strong>${gbp(money)}</strong></div>${hrs ? `<div style="align-items:flex-start"><small>Payroll hours</small><strong>${fmtH(hrs)}</strong></div>` : ""}</div>`;
  }
  if (!list.length) return h + `<div class="empty">${f === "ready" ? "No approved claims are waiting. You'll get an email when one is ready." : "No claims here yet."}</div>`;
  return h + `<div class="claims">${list.map(c => claimCard(c, c.status === "approved" ? `<div class="decide">${isBookkeeper() ? `<div class="row"><input id="payRef-${esc(c.id)}" placeholder="Payment reference (optional)" style="flex:1;min-width:180px"><button class="btn good" data-act="processed" data-id="${esc(c.id)}">Mark as paid</button></div>` : `<span class="sub">Only the bookkeeper can mark claims as paid.</span>`}</div>` : "")).join("")}</div>`;
}
function csvCell(v){ v = v == null ? "" : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
async function exportCsv(all){
  const f = all ? "all" : S.bkFilter, list = bkSet(f);
  const head = ["Ref","Status","Type","Claimant","Claimant email","Budget area","Team","Description","Invoice no","Invoice date","Pay period","Submitted","1st approver","1st approved on","2nd approver","2nd approved on","Paid on","Payment ref","Line date","Line detail","Activity","Hours","Rate","Miles","Line amount","Claim total","Attachments"];
  const rows = [head];
  for (const c of list){
    const p = S.people[c.claimant] || {};
    for (const l of (c.lines || [])){
      const detail = c.type === "mileage" ? `${l.from} to ${l.to}${l.ret ? " and return" : ""} – ${l.purpose}` : c.type === "expense" ? `${l.item}${l.supplier ? " (" + l.supplier + ")" : ""}` : l.session;
      rows.push([c.ref, STATUS[c.status].label, TYPES[c.type].short, personName(c.claimant), p.email || "", c.budget_area, c.team, c.description, c.invoice_number, c.invoice_date || "", c.pay_period,
        isoDay(c.submitted_at), c.first_approver ? personName(c.first_approver) : "", isoDay(c.first_approved_at), c.second_approver ? personName(c.second_approver) : "", isoDay(c.second_approved_at),
        isoDay(c.processed_at), c.payment_ref || "", l.date, detail, l.activity || "", l.hours || "", l.rate || c.mileage_rate || "",
        c.type === "mileage" ? num(l.miles) * (l.ret ? 2 : 1) : "", l.amount || 0, c.type === "payroll" ? "" : c.total, (c.attachments || []).map(a => a.name).join("; ")]);
    }
  }
  const blob = new Blob(["﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n")], {type:"text/csv;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `rhc-claims-${f}-${today()}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- admin: people ---------- */
function viewPeople(){
  const ppl = Object.values(S.people).sort((a,b) => (a.active - b.active) || (a.full_name || "").localeCompare(b.full_name || ""));
  const row = p => `<div class="personrow" data-person="${esc(p.id)}">
    <div><strong>${esc(p.full_name || "(no name)")}</strong>${p.active ? "" : ` <span class="pill pending">New</span>`}<div class="sub">${esc(p.email)}</div><div class="sub">${esc(p.club_role)}</div></div>
    <div class="checks">
      <label><input type="checkbox" data-r="active" ${p.active ? "checked" : ""}> Active</label>
      ${Object.entries(TYPES).map(([k,t]) => `<label><input type="checkbox" data-r="ap" value="${k}" ${(p.approver_types || []).includes(k) ? "checked" : ""}> Approves ${esc(t.short.toLowerCase())}</label>`).join("")}
      <label><input type="checkbox" data-r="books" ${p.is_bookkeeper ? "checked" : ""}> Bookkeeper</label>
      <label><input type="checkbox" data-r="admin" ${p.is_admin ? "checked" : ""}> Admin</label>
    </div>
    <button class="btn small primary" data-act="save-person" data-id="${esc(p.id)}">Save</button>
  </div>`;
  const counts = Object.keys(TYPES).map(k => [k, ppl.filter(p => p.active && (p.approver_types || []).includes(k)).length]);
  const thin = counts.filter(([,n]) => n < 3).map(([k]) => TYPES[k].short.toLowerCase());
  return `<div><h2>People</h2><p class="lede">Activate new accounts and choose who approves each claim type. Everyone active can submit claims. A claim needs two different approvers for its type, so give each type at least three, in case one of them is the claimant.</p></div>
    ${thin.length ? `<div class="notice warn">Fewer than three approvers for: ${esc(thin.join(", "))}.</div>` : ""}
    <section class="panel" style="gap:0;padding-block:6px">${ppl.length ? ppl.map(row).join("") : `<p class="sub">Nobody has created an account yet.</p>`}</section>`;
}
async function savePerson(id){
  const r = document.querySelector(`[data-person="${CSS.escape(id)}"]`);
  const q = s => r.querySelector(s);
  const args = {p_user:id, p_active:q('[data-r="active"]').checked, p_is_admin:q('[data-r="admin"]').checked, p_is_bookkeeper:q('[data-r="books"]').checked,
    p_approver_types:[...r.querySelectorAll('[data-r="ap"]:checked')].map(i => i.value)};
  const {error} = await S.sb.rpc("admin_update_user", args);
  if (error){ toast(errText(error)); return; }
  toast("Saved " + (S.people[id] && S.people[id].full_name || "")); await loadAll(false);
}

/* ---------- admin: settings ---------- */
function viewSettings(){
  return `<div><h2>Settings</h2><p class="lede">Club-wide settings for claims.</p></div>
  <section class="panel"><div class="grid">
    <label>Club mileage rate (£ per mile)<input id="sRate" type="number" step="0.01" min="0" inputmode="decimal" value="${S.settings.mileage_rate == null ? "" : esc(S.settings.mileage_rate)}" placeholder="e.g. 0.30"></label>
    <label>Budget areas <span class="hint">One per line</span><textarea id="sAreas" rows="7">${esc((S.settings.budget_areas || DEFAULT_AREAS).join("\n"))}</textarea></label>
  </div><div class="row end"><button class="btn primary" data-act="save-settings">Save settings</button></div></section>`;
}

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
  const [p, s, pp, n] = await Promise.all([
    S.sb.from("profiles").select("*").eq("id", uid).maybeSingle(),
    S.sb.from("settings").select("*").eq("id", 1).maybeSingle(),
    S.sb.from("profiles").select("*"),
    S.sb.rpc("staff_names")
  ]);
  S.me = p.data || null;
  if (s.data) S.settings = s.data;
  S.people = Object.fromEntries((pp.data || []).map(x => [x.id, x]));
  S.names = Object.fromEntries((n.data || []).map(x => [x.id, x.full_name]));
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
    case "tab": S.tab = b.dataset.tab; if (S.tab !== "new") S.lastSubmitted = null; S.editingDetails = false; render(); window.scrollTo(0,0); break;
    case "type": { const k = S.draft; S.draft = blankDraft(b.dataset.type); if (k){ S.draft.budget_area = k.budget_area; S.draft.team = k.team; S.draft.description = k.description; } saveLocalDraft(); render(); break; }
    case "add-line": { const last = S.draft.lines[S.draft.lines.length - 1] || {}; const n = {date: last.date || today()}; if (last.activity) n.activity = last.activity; if (last.rate) n.rate = last.rate; S.draft.lines.push(n); render(); break; }
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
    case "save-details": {
      const full_name = $("#pName").value.trim(), club_role = $("#pRole").value.trim();
      if (!full_name){ toast("Add your name"); break; }
      const {error} = await S.sb.from("profiles").update({full_name, club_role}).eq("id", S.user.id);
      if (error){ toast(errText(error)); break; }
      S.editingDetails = false; toast("Details saved"); await loadAll(false); render(); break;
    }
    case "edit-claim": { const c = claim(); if (!c) break;
      S.draft = {editingId:c.id, editingRef:c.ref, type:c.type, budget_area:c.budget_area, team:c.team || "", description:c.description, invoice_number:c.invoice_number || "", invoice_date:c.invoice_date || today(), pay_period:c.pay_period || "", lines:JSON.parse(JSON.stringify(c.lines || [])), attachments:(c.attachments || []).slice(), declare:false};
      S.tab = "new"; S.lastSubmitted = null; render(); window.scrollTo(0,0); break; }
    case "withdraw": S.confirmWithdraw = id; render(); break;
    case "withdraw-cancel": S.confirmWithdraw = null; render(); break;
    case "withdraw-yes": S.confirmWithdraw = null; rpc("withdraw_claim", {p_claim_id:id}, "Claim withdrawn"); break;
    case "approve": { b.disabled = true; const c = claim(); rpc("approve_claim", {p_claim_id:id}, r => r === "approved" ? `Second approval given. ${c ? c.ref : "The claim"} is now with the bookkeeper` : `First approval given for ${c ? c.ref : "the claim"}`); break; }
    case "reject": S.decideOpen = id; render(); { const t = $("#rejNote-" + CSS.escape(id)); if (t) t.focus(); } break;
    case "reject-cancel": S.decideOpen = null; render(); break;
    case "reject-yes": { const t = $("#rejNote-" + CSS.escape(id)), note = t ? t.value.trim() : "";
      if (!note){ toast("Add a reason so the claimant can fix it"); break; }
      S.decideOpen = null; rpc("return_claim", {p_claim_id:id, p_reason:note}, "Claim returned to the claimant"); break; }
    case "processed": { b.disabled = true; const inp = $("#payRef-" + CSS.escape(id)); rpc("mark_processed", {p_claim_id:id, p_payment_ref: inp ? inp.value.trim() : ""}, "Marked as paid"); break; }
    case "bk": S.bkFilter = b.dataset.f; render(); break;
    case "export": exportCsv(false); break;
    case "export-all": exportCsv(true); break;
    case "save-person": savePerson(id); break;
    case "save-settings": { const rate = $("#sRate").value.trim();
      rpc("admin_update_settings", {p_mileage_rate: rate === "" ? null : num(rate), p_budget_areas: $("#sAreas").value.split("\n").map(x => x.trim()).filter(Boolean)}, "Settings saved"); break; }
  }
});
function onField(e){
  const t = e.target, d = S.draft; if (!d || !t.closest("#claimForm")) return;
  const val = t.type === "checkbox" ? t.checked : t.value;
  if (t.dataset.f) d[t.dataset.f] = val;
  else if (t.dataset.line != null){ const l = d.lines[+t.dataset.line]; if (l){ l[t.dataset.k] = val; recalc(); } }
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

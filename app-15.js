// Duka Debt — app logic
// A shopkeeper signs in, adds customers, records what they owe, and can
// remind them over WhatsApp or SMS. All data is scoped to the signed-in
// owner via Supabase Row Level Security (see schema.sql).

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SMS_FUNCTION_URL = 'https://vghnfzgjfnvsbsaucitt.supabase.co/functions/v1/send-sms';

const root = document.getElementById('app');

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let state = {
  session: null,
  authMode: 'signin', // 'signin' | 'signup'
  authError: '',
  tab: 'debt',         // 'debt' | 'chama'
  customers: [],      // [{id, name, phone, debts: [...]}]
  loading: true,
  openCustomerId: null,
  showAddCustomer: false,
  showAbout: false,

  chama: {
    members: [],        // [{id, name, fixed_amount, created_at}]
    years: [],           // [{id, year}]
    payments: [],         // [{id, member_id, year, month, paid, amount, paid_at}]
    selectedYear: null,
    selectedMonth: new Date().getMonth() + 1,
    view: 'month',        // 'month' | 'overview'
    showAddMember: false,
    showAddYear: false,
    showMembers: false,
    showExport: false,
    openCell: null,        // {memberId, month, year}
    bulkMode: false,        // true while selecting members for bulk payment recording
    bulkSelected: new Set(), // member ids selected in the current bulk session
    bulkDefaultAmount: '',  // shared amount used for selected members with no fixed contribution
  },
};

function money(n) {
  return 'KSh ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0 });
}

function debtRemaining(d) {
  const paidAmount = Number(d.paid_amount || 0);
  return Math.max(0, Number(d.amount) - paidAmount);
}

function totalOwed(customer) {
  return customer.debts.reduce((sum, d) => sum + debtRemaining(d), 0);
}

function grandTotal() {
  return state.customers.reduce((sum, c) => sum + totalOwed(c), 0);
}

function allDebts() {
  return state.customers.flatMap(c => c.debts);
}

function weeklySummary() {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const debts = allDebts();

  const newDebtsTotal = debts
    .filter(d => d.created_at && new Date(d.created_at).getTime() >= weekAgo)
    .reduce((sum, d) => sum + Number(d.amount), 0);

  const collectedTotal = debts
    .filter(d => d.paid && d.paid_at && new Date(d.paid_at).getTime() >= weekAgo)
    .reduce((sum, d) => sum + Number(d.amount), 0);

  return { newDebtsTotal, collectedTotal };
}

function findPayment(memberId, year, month) {
  return state.chama.payments.find(p => p.member_id === memberId && p.year === year && p.month === month) || null;
}

function chamaMemberYearTotal(memberId, year) {
  return state.chama.payments
    .filter(p => p.member_id === memberId && p.year === year && p.paid)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function chamaMonthTotal(year, month) {
  return state.chama.payments
    .filter(p => p.year === year && p.month === month && p.paid)
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
}

function chamaMonthPaidCount(year, month) {
  return state.chama.payments.filter(p => p.year === year && p.month === month && p.paid).length;
}

function getShopName() {
  return state.session?.user?.user_metadata?.shop_name || null;
}

function getChamaName() {
  return state.session?.user?.user_metadata?.chama_name || null;
}

// ---------- Data loading ----------

async function loadCustomers() {
  const owner = state.session.user.id;

  const { data: customers, error: cErr } = await sb
    .from('customers')
    .select('id, name, phone, created_at')
    .eq('owner_id', owner)
    .order('created_at', { ascending: false });

  if (cErr) { console.error(cErr); return; }

  const { data: debts, error: dErr } = await sb
    .from('debts')
    .select('id, customer_id, amount, paid_amount, description, paid, paid_at, created_at')
    .eq('owner_id', owner)
    .order('created_at', { ascending: false });

  if (dErr) { console.error(dErr); return; }

  state.customers = customers.map(c => ({
    ...c,
    debts: debts.filter(d => d.customer_id === c.id),
  }));
}

async function loadChama() {
  const owner = state.session.user.id;

  const [membersRes, yearsRes, paymentsRes] = await Promise.all([
    sb.from('chama_members').select('id, name, fixed_amount, created_at')
      .eq('owner_id', owner).order('created_at', { ascending: true }),
    sb.from('chama_years').select('id, year')
      .eq('owner_id', owner).order('year', { ascending: false }),
    sb.from('chama_payments').select('id, member_id, year, month, paid, amount, paid_at')
      .eq('owner_id', owner),
  ]);

  if (membersRes.error) { console.error(membersRes.error); return; }
  if (yearsRes.error) { console.error(yearsRes.error); return; }
  if (paymentsRes.error) { console.error(paymentsRes.error); return; }

  state.chama.members = membersRes.data;
  state.chama.years = yearsRes.data;
  state.chama.payments = paymentsRes.data;

  const stillValid = state.chama.selectedYear && state.chama.years.some(y => y.year === state.chama.selectedYear);
  if (!stillValid) {
    const currentYear = new Date().getFullYear();
    const hasCurrent = state.chama.years.some(y => y.year === currentYear);
    state.chama.selectedYear = hasCurrent ? currentYear : (state.chama.years[0]?.year ?? null);
  }
}

async function refresh() {
  state.loading = true;
  render();
  await Promise.all([loadCustomers(), loadChama()]);
  state.loading = false;
  render();
}

// ---------- Auth actions ----------

async function handleAuthSubmit(email, password) {
  state.authError = '';
  const fn = state.authMode === 'signup' ? 'signUp' : 'signInWithPassword';
  const { data, error } = await sb.auth[fn]({ email, password });
  if (error) {
    state.authError = error.message;
    render();
    return;
  }
  if (state.authMode === 'signup' && !data.session) {
    state.authError = 'Check your email to confirm your account, then sign in.';
    state.authMode = 'signin';
    render();
    return;
  }
  state.session = data.session;
  await refresh();
}

async function handleSignOut() {
  await sb.auth.signOut();
  state.session = null;
  state.customers = [];
  render();
}

async function setShopName() {
  const current = getShopName() || '';
  const name = prompt('Your shop name (shown to customers in reminders):', current);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;

  const { data, error } = await sb.auth.updateUser({ data: { shop_name: trimmed } });
  if (error) { alert(error.message); return; }
  state.session.user = data.user;
  render();
}

async function setChamaName() {
  const current = getChamaName() || '';
  const name = prompt('Name your chama (e.g. "Maslah\'s Chama"):', current);
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) return;

  const { data, error } = await sb.auth.updateUser({ data: { chama_name: trimmed } });
  if (error) { alert(error.message); return; }
  state.session.user = data.user;
  render();
}

// ---------- Mutations ----------

async function addCustomer(name, phone) {
  const owner = state.session.user.id;
  const { error } = await sb.from('customers').insert({ owner_id: owner, name, phone });
  if (error) { alert(error.message); return; }
  state.showAddCustomer = false;
  await refresh();
}

async function addDebt(customerId, amount, description) {
  const owner = state.session.user.id;
  const { error } = await sb.from('debts').insert({
    owner_id: owner, customer_id: customerId, amount, description, paid_amount: 0,
  });
  if (error) { alert(error.message); return; }
  await refresh();
}

function findDebtById(debtId) {
  for (const c of state.customers) {
    const d = c.debts.find(d => d.id === debtId);
    if (d) return d;
  }
  return null;
}

async function recordPayment(debtId) {
  const debt = findDebtById(debtId);
  if (!debt) return;
  const remaining = debtRemaining(debt);
  const input = prompt(`How much did they pay? (Remaining: ${money(remaining)})`, remaining);
  if (input === null) return;
  const amount = parseFloat(input);
  if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }

  const newPaidAmount = Math.min(Number(debt.amount), Number(debt.paid_amount || 0) + amount);
  const isFullyPaid = newPaidAmount >= Number(debt.amount);

  const { error } = await sb.from('debts')
    .update({
      paid_amount: newPaidAmount,
      paid: isFullyPaid,
      paid_at: isFullyPaid ? new Date().toISOString() : null,
    })
    .eq('id', debtId);
  if (error) { alert(error.message); return; }
  await refresh();
}

async function deleteDebt(debtId) {
  const ok = confirm('Delete this debt entry? This cannot be undone.');
  if (!ok) return;
  const { error } = await sb.from('debts').delete().eq('id', debtId);
  if (error) { alert(error.message); return; }
  await refresh();
}

async function editCustomer(customerId, currentName, currentPhone) {
  const name = prompt('Customer name:', currentName);
  if (!name) return;
  const phone = prompt('Phone (optional, for WhatsApp/SMS reminders):', currentPhone || '');
  const { error } = await sb.from('customers')
    .update({ name: name.trim(), phone: phone ? phone.trim() : null })
    .eq('id', customerId);
  if (error) { alert(error.message); return; }
  await refresh();
}

async function deleteCustomer(customerId) {
  const ok = confirm('Delete this customer and all their debts? This cannot be undone.');
  if (!ok) return;
  await sb.from('debts').delete().eq('customer_id', customerId);
  const { error } = await sb.from('customers').delete().eq('id', customerId);
  if (error) { alert(error.message); return; }
  state.openCustomerId = null;
  await refresh();
}

async function sendSmsReminder(customerId) {
  const c = state.customers.find(c => c.id === customerId);
  if (!c || !c.phone) return;

  const owed = totalOwed(c);
  const shopName = getShopName();
  const message = shopName
    ? `Hello ${c.name}, this is a friendly reminder from ${shopName} that your outstanding balance is ${money(owed)}. Thank you!`
    : `Hello ${c.name}, this is a friendly reminder from your shop that your outstanding balance is ${money(owed)}. Thank you!`;

  const btn = document.getElementById('sms-remind');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(SMS_FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ phone: c.phone, message }),
    });
    const result = await res.json();
    if (!res.ok) {
      alert('Could not send SMS: ' + (result.error || 'Unknown error'));
    } else {
      alert(`SMS sent to ${c.name}.`);
    }
  } catch (err) {
    alert('Could not send SMS: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `Remind ${escapeHtml(c.name)} by SMS`; }
  }
}

// ---------- Mama Chama mutations ----------

async function addChamaMember(name, fixedAmount) {
  const owner = state.session.user.id;
  const { error } = await sb.from('chama_members').insert({
    owner_id: owner, name, fixed_amount: fixedAmount ?? null,
  });
  if (error) { alert(error.message); return; }
  state.chama.showAddMember = false;
  await refresh();
}

async function editChamaMember(id, currentName, currentFixed) {
  const name = prompt('Member name:', currentName);
  if (!name) return;
  const fixedInput = prompt('Fixed monthly contribution (KSh) — leave blank for none:', currentFixed ?? '');
  if (fixedInput === null) return;
  const trimmed = fixedInput.trim();
  const fixed = trimmed === '' ? null : parseFloat(trimmed);
  const { error } = await sb.from('chama_members')
    .update({ name: name.trim(), fixed_amount: (fixed !== null && !isNaN(fixed)) ? fixed : null })
    .eq('id', id);
  if (error) { alert(error.message); return; }
  await refresh();
}

async function deleteChamaMember(id) {
  const m = state.chama.members.find(x => x.id === id);
  const label = m ? `"${m.name}"` : 'this member';
  const ok = confirm(`Delete ${label} and all their contribution records? This cannot be undone.`);
  if (!ok) return;
  await sb.from('chama_payments').delete().eq('member_id', id);
  const { error } = await sb.from('chama_members').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  if (state.chama.bulkSelected.has(id)) state.chama.bulkSelected.delete(id);
  await refresh();
}

async function addChamaYear(year) {
  const owner = state.session.user.id;
  const { error } = await sb.from('chama_years').insert({ owner_id: owner, year });
  if (error) { alert(error.message); return; }
  state.chama.showAddYear = false;
  state.chama.selectedYear = year;
  await refresh();
}

async function deleteChamaYear(id, year) {
  const ok = confirm(`Delete ${year} and every contribution record in it? This cannot be undone.`);
  if (!ok) return;
  const owner = state.session.user.id;
  await sb.from('chama_payments').delete().eq('owner_id', owner).eq('year', year);
  const { error } = await sb.from('chama_years').delete().eq('id', id);
  if (error) { alert(error.message); return; }
  await refresh();
}

async function markChamaPaid(memberId, year, month, amount) {
  const owner = state.session.user.id;
  const { error } = await sb.from('chama_payments').upsert({
    owner_id: owner, member_id: memberId, year, month,
    paid: true, amount, paid_at: new Date().toISOString(),
  }, { onConflict: 'member_id,year,month' });
  if (error) { alert(error.message); return; }
  state.chama.openCell = null;
  await refresh();
}

async function markChamaUnpaid(memberId, year, month) {
  const owner = state.session.user.id;
  const { error } = await sb.from('chama_payments').upsert({
    owner_id: owner, member_id: memberId, year, month,
    paid: false, amount: null, paid_at: null,
  }, { onConflict: 'member_id,year,month' });
  if (error) { alert(error.message); return; }
  state.chama.openCell = null;
  await refresh();
}

// ---------- Mama Chama bulk payment recording ----------
// Lets the admin select any number of members first (no per-tap DB write or
// refresh), then record all of their payments for the month in one submit.

function enterBulkMode() {
  state.chama.bulkMode = true;
  state.chama.bulkSelected = new Set();
  state.chama.bulkDefaultAmount = '';
  render();
}

function exitBulkMode() {
  state.chama.bulkMode = false;
  state.chama.bulkSelected = new Set();
  state.chama.bulkDefaultAmount = '';
  render();
}

function toggleBulkSelect(memberId) {
  const set = state.chama.bulkSelected;
  if (set.has(memberId)) set.delete(memberId); else set.add(memberId);
  render();
}

async function bulkRecordPayments(year, month) {
  const c = state.chama;
  const ids = Array.from(c.bulkSelected);
  if (!ids.length) { alert('Select at least one member first.'); return; }

  const owner = state.session.user.id;
  const defaultAmount = parseFloat(c.bulkDefaultAmount);
  const rows = [];
  const missing = [];

  ids.forEach(id => {
    const m = c.members.find(x => x.id === id);
    if (!m) return;
    let amount = m.fixed_amount ? Number(m.fixed_amount) : null;
    if (!amount) {
      if (defaultAmount && defaultAmount > 0) amount = defaultAmount;
      else { missing.push(m.name); return; }
    }
    rows.push({
      owner_id: owner, member_id: id, year, month,
      paid: true, amount, paid_at: new Date().toISOString(),
    });
  });

  if (missing.length) {
    alert(`Enter an amount for members with no fixed contribution: ${missing.join(', ')}`);
    return;
  }

  // One batched upsert for every selected member, instead of one call per member.
  const { error } = await sb.from('chama_payments').upsert(rows, { onConflict: 'member_id,year,month' });
  if (error) { alert(error.message); return; }

  exitBulkMode();
  await refresh();
}

// ---------- Rendering ----------

function render() {
  if (!state.session) {
    root.innerHTML = renderAuthScreen();
    wireAuthScreen();
    return;
  }

  const shopName = getShopName();
  const chamaName = getChamaName();
  const isChama = state.tab === 'chama';

  let fabHtml = '<button class="fab" id="fab-add">+ Add customer</button>';
  if (isChama) {
    fabHtml = state.chama.years.length
      ? '<button class="fab" id="fab-add-member">+ Add member</button>'
      : '<button class="fab" id="fab-add-year">+ Add year</button>';
  }

  root.innerHTML = `
    <header class="signboard">
      <button class="signout" id="signout-btn">Sign out</button>
      <h1>Duka <span class="mark">Debt</span></h1>
      <div class="tagline">${isChama ? 'Mama Chama — group contributions.' : 'Who owes you, and how much.'}</div>
      <div class="shop-name-row">
        ${shopName
          ? `<span class="shop-name-badge">${escapeHtml(shopName)}</span> <button class="shop-name-edit" id="shop-name-edit" title="Edit shop name">✏️</button>`
          : `<button class="shop-name-set" id="shop-name-edit">+ Add your shop name</button>`}
      </div>
      ${isChama ? `
      <div class="chama-name-row">
        ${chamaName
          ? `<span class="chama-name-badge">🏷 ${escapeHtml(chamaName)}</span> <button class="chama-name-edit" id="chama-name-edit" title="Edit chama name">✏️</button>`
          : `<button class="chama-name-set" id="chama-name-edit">+ Name your chama</button>`}
      </div>` : ''}
    </header>
    <div class="tab-bar">
      <button class="tab-btn ${!isChama ? 'active' : ''}" id="tab-debt">Duka Debt</button>
      <button class="tab-btn ${isChama ? 'active' : ''}" id="tab-chama">Mama Chama</button>
    </div>
    <main>
      ${state.loading ? '<div class="loading-text">Loading…</div>' : (isChama ? renderChamaBody() : renderDashboardBody())}
    </main>
    <div class="founder-link-wrap">
      <button class="founder-link" id="founder-link">About the founder</button>
    </div>
    ${fabHtml}
    ${state.showAddCustomer ? renderAddCustomerSheet() : ''}
    ${state.openCustomerId ? renderCustomerSheet() : ''}
    ${state.showAbout ? renderAboutSheet() : ''}
    ${state.chama.showAddMember ? renderAddMemberSheet() : ''}
    ${state.chama.showAddYear ? renderAddYearSheet() : ''}
    ${state.chama.showMembers ? renderMembersSheet() : ''}
    ${state.chama.showExport ? renderExportSheet() : ''}
    ${state.chama.openCell ? renderCellSheet() : ''}
  `;

  document.getElementById('signout-btn').onclick = handleSignOut;
  document.getElementById('founder-link').onclick = () => { state.showAbout = true; render(); };
  document.getElementById('shop-name-edit').onclick = setShopName;
  document.getElementById('tab-debt').onclick = () => { state.tab = 'debt'; render(); };
  document.getElementById('tab-chama').onclick = () => { state.tab = 'chama'; render(); };

  const chamaNameEdit = document.getElementById('chama-name-edit');
  if (chamaNameEdit) chamaNameEdit.onclick = setChamaName;

  if (!isChama) {
    const fabAdd = document.getElementById('fab-add');
    if (fabAdd) fabAdd.onclick = () => { state.showAddCustomer = true; render(); };
    document.querySelectorAll('.customer-row').forEach(el => {
      el.onclick = () => { state.openCustomerId = el.dataset.id; render(); };
    });
  } else {
    const fabMember = document.getElementById('fab-add-member');
    if (fabMember) fabMember.onclick = () => { state.chama.showAddMember = true; render(); };
    const fabYear = document.getElementById('fab-add-year');
    if (fabYear) fabYear.onclick = () => { state.chama.showAddYear = true; render(); };
    wireChamaBody();
  }

  if (state.showAddCustomer) wireAddCustomerSheet();
  if (state.openCustomerId) wireCustomerSheet();
  if (state.showAbout) wireAboutSheet();
  if (state.chama.showAddMember) wireAddMemberSheet();
  if (state.chama.showAddYear) wireAddYearSheet();
  if (state.chama.showMembers) wireMembersSheet();
  if (state.chama.showExport) wireExportSheet();
  if (state.chama.openCell) wireCellSheet();
}

function renderDashboardBody() {
  const total = grandTotal();
  const stampClass = total === 0 ? 'stamp zero' : 'stamp';
  const stampLabel = total === 0 ? 'All settled' : 'Owed to you';
  const { newDebtsTotal, collectedTotal } = weeklySummary();

  const rows = state.customers.length
    ? state.customers.map(c => {
        const owed = totalOwed(c);
        const settled = owed === 0;
        return `
          <div class="customer-row ${settled ? 'settled' : ''}" data-id="${c.id}">
            <div class="row-top">
              <div class="name">${escapeHtml(c.name)}</div>
              <div class="owed">${settled ? 'Settled' : money(owed)}</div>
            </div>
            <div class="meta">${c.phone ? escapeHtml(c.phone) : 'No phone on file'}</div>
          </div>
        `;
      }).join('')
    : `<div class="empty-state">
         <div class="big">No customers yet</div>
         Add your first customer and record what they owe.
       </div>`;

  return `
    <div class="week-summary">
      <div class="week-summary-item">
        <div class="week-summary-label">Collected this week</div>
        <div class="week-summary-amount collected">${money(collectedTotal)}</div>
      </div>
      <div class="week-summary-item">
        <div class="week-summary-label">New debts this week</div>
        <div class="week-summary-amount">${money(newDebtsTotal)}</div>
      </div>
    </div>
    <div class="stamp-wrap">
      <div class="${stampClass}">
        <div class="label">${stampLabel}</div>
        <div class="amount">${money(total)}</div>
      </div>
    </div>
    <div class="section-label">Your customers</div>
    <div class="customer-list">${rows}</div>
  `;
}

function renderAddCustomerSheet() {
  return `
    <div class="sheet-backdrop" id="add-backdrop">
      <div class="sheet">
        <button class="close-x" id="add-close">&times;</button>
        <h2>Add a customer</h2>
        <div class="field">
          <label for="new-name">Name</label>
          <input id="new-name" type="text" placeholder="e.g. Ahmed Yussuf" />
        </div>
        <div class="field">
          <label for="new-phone">Phone (optional, for WhatsApp/SMS reminders)</label>
          <input id="new-phone" type="tel" placeholder="e.g. 254712345678" />
        </div>
        <div id="add-error" class="error-text" style="display:none"></div>
        <button class="primary" id="add-save">Save customer</button>
      </div>
    </div>
  `;
}

function wireAddCustomerSheet() {
  const close = () => { state.showAddCustomer = false; render(); };
  document.getElementById('add-backdrop').onclick = (e) => { if (e.target.id === 'add-backdrop') close(); };
  document.getElementById('add-close').onclick = close;
  document.getElementById('add-save').onclick = async () => {
    const name = document.getElementById('new-name').value.trim();
    const phone = document.getElementById('new-phone').value.trim();
    const errEl = document.getElementById('add-error');
    if (!name) { errEl.textContent = 'Enter a name.'; errEl.style.display = 'block'; return; }
    await addCustomer(name, phone || null);
  };
}

// ---------- Mama Chama rendering ----------

function renderChamaBody() {
  const c = state.chama;
  const years = c.years.slice().sort((a, b) => b.year - a.year);
  const members = c.members;

  const yearChips = years.map(y => `
    <button class="year-chip ${y.year === c.selectedYear ? 'active' : ''}" data-year="${y.year}">${y.year}</button>
  `).join('');

  const yearRow = `<div class="chip-row">${yearChips}<button class="year-chip add" id="add-year-chip">+ Year</button></div>`;

  if (!years.length) {
    return `
      ${yearRow}
      <div class="empty-state">
        <div class="big">No years yet</div>
        Add a year to start recording monthly contributions.
      </div>
    `;
  }

  if (!members.length) {
    return `
      ${yearRow}
      <div class="empty-state">
        <div class="big">No members yet</div>
        Add your first member to start recording contributions.
      </div>
    `;
  }

  const year = c.selectedYear;
  const chamaName = getChamaName();
  const monthPaid = chamaMonthPaidCount(year, c.selectedMonth);
  const monthTotal = chamaMonthTotal(year, c.selectedMonth);

  const monthChips = MONTH_SHORT.map((m, i) => {
    const month = i + 1;
    return `<button class="month-chip ${month === c.selectedMonth ? 'active' : ''}" data-month="${month}">${m}</button>`;
  }).join('');

  const content = c.view === 'overview'
    ? renderChamaOverviewGrid(year)
    : renderChamaMonthList(year, c.selectedMonth);

  return `
    ${yearRow}
    ${chamaName ? `<div class="chama-name-heading">${escapeHtml(chamaName)}</div>` : ''}
    <div class="chama-toolbar">
      <button class="members-link" id="members-link">👥 ${members.length} member${members.length === 1 ? '' : 's'}</button>
      <div style="display:flex;gap:14px;align-items:center;">
        <button class="export-btn" id="export-btn" title="Export ${year}">📤 Export</button>
        <button class="year-delete" id="delete-year-btn" title="Delete ${year}">🗑 Delete ${year}</button>
      </div>
    </div>
    <div class="view-toggle">
      <button class="view-toggle-btn ${c.view === 'month' ? 'active' : ''}" data-view="month">Month view</button>
      <button class="view-toggle-btn ${c.view === 'overview' ? 'active' : ''}" data-view="overview">Year overview</button>
    </div>
    ${c.view === 'month' ? `
      <div class="chip-row month-row">${monthChips}</div>
      <div class="week-summary">
        <div class="week-summary-item">
          <div class="week-summary-label">${MONTH_NAMES[c.selectedMonth - 1]} ${year} collected</div>
          <div class="week-summary-amount collected">${money(monthTotal)}</div>
        </div>
        <div class="week-summary-item">
          <div class="week-summary-label">Paid this month</div>
          <div class="week-summary-amount">${monthPaid} / ${members.length}</div>
        </div>
      </div>
      <div class="bulk-bar">
        <button class="bulk-toggle-btn ${c.bulkMode ? 'active' : ''}" id="bulk-toggle-btn">
          ${c.bulkMode ? '✕ Cancel bulk selection' : '☑ Bulk record payments'}
        </button>
      </div>
    ` : ''}
    ${content}
    ${(c.view === 'month' && c.bulkMode) ? renderBulkSubmitBar() : ''}
  `;
}

function renderBulkSubmitBar() {
  const c = state.chama;
  const selectedIds = Array.from(c.bulkSelected);
  const selectedMembers = selectedIds.map(id => c.members.find(m => m.id === id)).filter(Boolean);
  const needsDefault = selectedMembers.some(m => !m.fixed_amount);
  const count = selectedIds.length;

  return `
    <div class="bulk-submit-bar">
      <div class="bulk-count">${count} member${count === 1 ? '' : 's'} selected</div>
      ${needsDefault ? `
        <div class="field amount" style="margin:10px 0 4px;">
          <label for="bulk-default-amount">Amount (KSh) for members with no fixed contribution</label>
          <input id="bulk-default-amount" type="number" inputmode="numeric" placeholder="0" value="${escapeHtml(c.bulkDefaultAmount)}" />
        </div>
      ` : ''}
      <button class="primary" id="bulk-submit-btn" ${count ? '' : 'disabled'} style="margin-top:10px;">
        ✓ Record ${count || ''} payment${count === 1 ? '' : 's'}
      </button>
    </div>
  `;
}

function renderChamaMonthList(year, month) {
  const bulkMode = state.chama.bulkMode;
  const selected = state.chama.bulkSelected;

  const rows = state.chama.members.map(m => {
    const p = findPayment(m.id, year, month);
    const isPaid = !!(p && p.paid);
    const amountText = isPaid
      ? money(p.amount)
      : (m.fixed_amount ? `Fixed ${money(m.fixed_amount)}/month — tap the tick` : 'No fixed amount set');

    if (bulkMode) {
      const isSelected = selected.has(m.id);
      const metaText = isPaid ? `Already recorded — ${money(p.amount)}` : amountText;
      return `
        <div class="chama-row ${isPaid ? 'paid locked' : (isSelected ? 'selected' : 'unpaid')}" data-bulk-row data-member="${m.id}">
          <button class="bulk-tick ${isSelected ? 'ticked' : ''}" data-bulk-check data-member="${m.id}" ${isPaid ? 'disabled' : ''} title="${isPaid ? 'Already recorded' : (isSelected ? 'Deselect' : 'Select')}">
            <span class="tick-circle">${(isPaid || isSelected) ? '✓' : ''}</span>
          </button>
          <div class="chama-row-body">
            <div class="row-top"><div class="name">${escapeHtml(m.name)}</div></div>
            <div class="meta">${metaText}</div>
          </div>
        </div>
      `;
    }

    return `
      <div class="chama-row ${isPaid ? 'paid' : 'unpaid'}">
        <button class="chama-tick ${isPaid ? 'ticked' : ''}" data-tick data-member="${m.id}" data-month="${month}" title="${isPaid ? 'Mark not paid' : 'Mark paid'}"><span class="tick-circle">${isPaid ? '✓' : ''}</span></button>
        <div class="chama-row-body" data-open data-member="${m.id}" data-month="${month}">
          <div class="row-top">
            <div class="name">${escapeHtml(m.name)} <button class="inline-edit" data-edit="${m.id}" title="Edit member">✏️</button></div>
          </div>
          <div class="meta">${amountText}</div>
        </div>
      </div>
    `;
  }).join('');
  return `<div class="customer-list chama-list">${rows}</div>`;
}

function renderChamaOverviewGrid(year) {
  const members = state.chama.members;
  const headerCells = MONTH_SHORT.map(m => `<th>${m}</th>`).join('');
  const rows = members.map(m => {
    const cells = MONTH_SHORT.map((_, i) => {
      const month = i + 1;
      const p = findPayment(m.id, year, month);
      const isPaid = !!(p && p.paid);
      return `<td class="grid-cell ${isPaid ? 'paid' : ''}" data-member="${m.id}" data-month="${month}">${isPaid ? '✓' : '·'}</td>`;
    }).join('');
    const total = chamaMemberYearTotal(m.id, year);
    return `<tr><th class="row-head" data-edit="${m.id}">${escapeHtml(m.name)} <span class="row-edit">✏️</span></th>${cells}<td class="grid-total">${money(total)}</td></tr>`;
  }).join('');

  return `
    <div class="grid-scroll">
      <table class="chama-grid">
        <thead><tr><th class="row-head">Member</th>${headerCells}<th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function chamaQuickToggle(memberId, year, month) {
  const m = state.chama.members.find(x => x.id === memberId);
  if (!m) return;
  const p = findPayment(memberId, year, month);
  const isPaid = !!(p && p.paid);

  if (isPaid) {
    // Already ticked — one tap unticks it, no dialog needed.
    markChamaUnpaid(memberId, year, month);
    return;
  }

  if (m.fixed_amount) {
    // Fixed amount is set — tick it straight to paid, no typing required.
    markChamaPaid(memberId, year, month, m.fixed_amount);
    return;
  }

  // No fixed amount on file — we need an amount, so open the sheet.
  state.chama.openCell = { memberId, month, year };
  render();
}

function wireChamaBody() {
  document.querySelectorAll('.year-chip[data-year]').forEach(btn => {
    btn.onclick = () => {
      state.chama.selectedYear = parseInt(btn.dataset.year, 10);
      state.chama.bulkSelected = new Set();
      render();
    };
  });

  const addYearChip = document.getElementById('add-year-chip');
  if (addYearChip) addYearChip.onclick = () => { state.chama.showAddYear = true; render(); };

  const membersLink = document.getElementById('members-link');
  if (membersLink) membersLink.onclick = () => { state.chama.showMembers = true; render(); };

  const exportBtn = document.getElementById('export-btn');
  if (exportBtn) exportBtn.onclick = () => { state.chama.showExport = true; render(); };

  const deleteYearBtn = document.getElementById('delete-year-btn');
  if (deleteYearBtn) {
    deleteYearBtn.onclick = () => {
      const y = state.chama.years.find(y => y.year === state.chama.selectedYear);
      if (y) deleteChamaYear(y.id, y.year);
    };
  }

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.onclick = () => { state.chama.view = btn.dataset.view; render(); };
  });

  document.querySelectorAll('.month-chip').forEach(btn => {
    btn.onclick = () => {
      state.chama.selectedMonth = parseInt(btn.dataset.month, 10);
      state.chama.bulkSelected = new Set();
      render();
    };
  });

  // Quick tick: month-view checkbox and grid cells both toggle instantly
  // when the member has a fixed amount — no dialog, just tap and move on.
  // (Not wired in bulk mode — those rows use .bulk-tick instead.)
  document.querySelectorAll('.chama-tick[data-tick], .grid-cell').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      chamaQuickToggle(el.dataset.member, state.chama.selectedYear, parseInt(el.dataset.month, 10));
    };
  });

  // Tapping the rest of a month-view row opens the full sheet (for a
  // custom amount, or to review/change what was recorded).
  document.querySelectorAll('.chama-row-body[data-open]').forEach(el => {
    el.onclick = () => {
      state.chama.openCell = {
        memberId: el.dataset.member,
        month: parseInt(el.dataset.month, 10),
        year: state.chama.selectedYear,
      };
      render();
    };
  });

  // Editable member names: the pencil in month view, and the name itself
  // in the year-overview grid's sticky column.
  document.querySelectorAll('.inline-edit[data-edit], .row-head[data-edit]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const m = state.chama.members.find(x => x.id === el.dataset.edit);
      if (m) editChamaMember(m.id, m.name, m.fixed_amount);
    };
  });

  // ---------- Bulk payment recording ----------
  const bulkToggleBtn = document.getElementById('bulk-toggle-btn');
  if (bulkToggleBtn) {
    bulkToggleBtn.onclick = () => {
      if (state.chama.bulkMode) exitBulkMode(); else enterBulkMode();
    };
  }

  if (state.chama.bulkMode) {
    // Selecting is purely local state — no DB write and no refresh per tap.
    document.querySelectorAll('[data-bulk-row]').forEach(el => {
      el.onclick = () => {
        const checkbox = el.querySelector('[data-bulk-check]');
        if (checkbox && !checkbox.disabled) toggleBulkSelect(el.dataset.member);
      };
    });
    document.querySelectorAll('[data-bulk-check]').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        if (el.disabled) return;
        toggleBulkSelect(el.dataset.member);
      };
    });

    const defaultAmountInput = document.getElementById('bulk-default-amount');
    if (defaultAmountInput) {
      defaultAmountInput.oninput = () => { state.chama.bulkDefaultAmount = defaultAmountInput.value; };
    }

    const bulkSubmitBtn = document.getElementById('bulk-submit-btn');
    if (bulkSubmitBtn) {
      bulkSubmitBtn.onclick = () => bulkRecordPayments(state.chama.selectedYear, state.chama.selectedMonth);
    }
  }
}

function renderCellSheet() {
  const { memberId, month, year } = state.chama.openCell;
  const m = state.chama.members.find(x => x.id === memberId);
  if (!m) return '';
  const p = findPayment(memberId, year, month);
  const isPaid = !!(p && p.paid);

  return `
    <div class="sheet-backdrop" id="cell-backdrop">
      <div class="sheet">
        <button class="close-x" id="cell-close">&times;</button>
        <h2>${escapeHtml(m.name)}</h2>
        <div class="section-label">${MONTH_NAMES[month - 1]} ${year}</div>
        <div class="cell-status ${isPaid ? 'paid' : 'unpaid'}">${isPaid ? `Paid ${money(p.amount)}` : 'Not paid yet'}</div>
        ${m.fixed_amount ? `<button class="primary" id="mark-fixed">✓ Mark Paid (${money(m.fixed_amount)})</button>` : ''}
        <div class="field amount" style="margin-top:14px">
          <label for="cell-amount">${m.fixed_amount ? 'Or a different amount (KSh)' : 'Amount paid (KSh)'}</label>
          <input id="cell-amount" type="number" inputmode="numeric" placeholder="0" value="${isPaid ? p.amount : (m.fixed_amount || '')}" />
        </div>
        <button class="ghost" id="mark-custom">✓ Mark Paid with this amount</button>
        ${isPaid ? `<button class="ghost" id="mark-unpaid" style="border-color:var(--rust);color:var(--rust);">✗ Mark Not Paid</button>` : ''}
      </div>
    </div>
  `;
}

function wireCellSheet() {
  const { memberId, month, year } = state.chama.openCell;
  const m = state.chama.members.find(x => x.id === memberId);
  const close = () => { state.chama.openCell = null; render(); };
  document.getElementById('cell-backdrop').onclick = (e) => { if (e.target.id === 'cell-backdrop') close(); };
  document.getElementById('cell-close').onclick = close;

  const fixedBtn = document.getElementById('mark-fixed');
  if (fixedBtn) fixedBtn.onclick = () => markChamaPaid(memberId, year, month, m.fixed_amount);

  document.getElementById('mark-custom').onclick = () => {
    const amount = parseFloat(document.getElementById('cell-amount').value);
    if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }
    markChamaPaid(memberId, year, month, amount);
  };

  const unpaidBtn = document.getElementById('mark-unpaid');
  if (unpaidBtn) unpaidBtn.onclick = () => markChamaUnpaid(memberId, year, month);
}

function renderMembersSheet() {
  const members = state.chama.members;
  const rows = members.length
    ? members.map(m => `
        <div class="debt-line">
          <div>
            <div>${escapeHtml(m.name)}</div>
            <div class="desc">${m.fixed_amount ? `Fixed ${money(m.fixed_amount)}/month` : 'No fixed amount'}</div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="icon-btn" data-edit="${m.id}" title="Edit">✏️</button>
            <button class="icon-btn" data-delete="${m.id}" title="Delete">🗑</button>
          </div>
        </div>
      `).join('')
    : `<div class="debt-line"><span class="desc">No members yet.</span></div>`;

  return `
    <div class="sheet-backdrop" id="members-backdrop">
      <div class="sheet">
        <button class="close-x" id="members-close">&times;</button>
        <h2>Members</h2>
        ${rows}
        <button class="primary" id="members-add-new" style="margin-top:18px;">+ Add member</button>
      </div>
    </div>
  `;
}

function wireMembersSheet() {
  const close = () => { state.chama.showMembers = false; render(); };
  document.getElementById('members-backdrop').onclick = (e) => { if (e.target.id === 'members-backdrop') close(); };
  document.getElementById('members-close').onclick = close;
  document.getElementById('members-add-new').onclick = () => {
    state.chama.showMembers = false;
    state.chama.showAddMember = true;
    render();
  };

  document.querySelectorAll('#members-backdrop [data-edit]').forEach(btn => {
    btn.onclick = () => {
      const m = state.chama.members.find(x => x.id === btn.dataset.edit);
      if (m) editChamaMember(m.id, m.name, m.fixed_amount);
    };
  });
  document.querySelectorAll('#members-backdrop [data-delete]').forEach(btn => {
    btn.onclick = () => deleteChamaMember(btn.dataset.delete);
  });
}

function renderAddMemberSheet() {
  return `
    <div class="sheet-backdrop" id="add-member-backdrop">
      <div class="sheet">
        <button class="close-x" id="add-member-close">&times;</button>
        <h2>Add a member</h2>
        <div class="field">
          <label for="new-member-name">Name</label>
          <input id="new-member-name" type="text" placeholder="e.g. Fatuma Noor" />
        </div>
        <div class="field amount">
          <label for="new-member-fixed">Fixed monthly contribution (KSh, optional)</label>
          <input id="new-member-fixed" type="number" inputmode="numeric" placeholder="e.g. 500" />
        </div>
        <div class="hint-text">Set this once and you'll just tap ✓ to mark each month paid — no typing the amount every time.</div>
        <div id="add-member-error" class="error-text" style="display:none"></div>
        <button class="primary" id="add-member-save">Save member</button>
      </div>
    </div>
  `;
}

function wireAddMemberSheet() {
  const close = () => { state.chama.showAddMember = false; render(); };
  document.getElementById('add-member-backdrop').onclick = (e) => { if (e.target.id === 'add-member-backdrop') close(); };
  document.getElementById('add-member-close').onclick = close;
  document.getElementById('add-member-save').onclick = async () => {
    const name = document.getElementById('new-member-name').value.trim();
    const fixedInput = document.getElementById('new-member-fixed').value.trim();
    const errEl = document.getElementById('add-member-error');
    if (!name) { errEl.textContent = 'Enter a name.'; errEl.style.display = 'block'; return; }
    const fixed = fixedInput ? parseFloat(fixedInput) : null;
    await addChamaMember(name, (fixed !== null && !isNaN(fixed)) ? fixed : null);
  };
}

function renderAddYearSheet() {
  const suggested = new Date().getFullYear();
  return `
    <div class="sheet-backdrop" id="add-year-backdrop">
      <div class="sheet">
        <button class="close-x" id="add-year-close">&times;</button>
        <h2>Add a year</h2>
        <div class="field">
          <label for="new-year">Year</label>
          <input id="new-year" type="number" inputmode="numeric" value="${suggested}" />
        </div>
        <div id="add-year-error" class="error-text" style="display:none"></div>
        <button class="primary" id="add-year-save">Save year</button>
      </div>
    </div>
  `;
}

function wireAddYearSheet() {
  const close = () => { state.chama.showAddYear = false; render(); };
  document.getElementById('add-year-backdrop').onclick = (e) => { if (e.target.id === 'add-year-backdrop') close(); };
  document.getElementById('add-year-close').onclick = close;
  document.getElementById('add-year-save').onclick = async () => {
    const yearInput = document.getElementById('new-year').value.trim();
    const errEl = document.getElementById('add-year-error');
    const year = parseInt(yearInput, 10);
    if (!year || year < 2000 || year > 2100) {
      errEl.textContent = 'Enter a valid year.'; errEl.style.display = 'block'; return;
    }
    if (state.chama.years.some(y => y.year === year)) {
      errEl.textContent = 'That year already exists.'; errEl.style.display = 'block'; return;
    }
    await addChamaYear(year);
  };
}

function renderExportSheet() {
  const year = state.chama.selectedYear;
  const chamaName = getChamaName();
  return `
    <div class="sheet-backdrop" id="export-backdrop">
      <div class="sheet">
        <button class="close-x" id="export-close">&times;</button>
        <h2>Export ${chamaName ? escapeHtml(chamaName) + ' ' : ''}${year}</h2>
        <div class="section-label">Every member, all 12 months</div>
        <button class="primary" id="export-pdf">📄 Download official PDF report</button>
        <button class="ghost" id="export-print">🖨️ Print / Save as PDF</button>
        <button class="ghost" id="export-csv">⬇️ Download as CSV (opens in Excel)</button>
      </div>
    </div>
  `;
}

function wireExportSheet() {
  const close = () => { state.chama.showExport = false; render(); };
  document.getElementById('export-backdrop').onclick = (e) => { if (e.target.id === 'export-backdrop') close(); };
  document.getElementById('export-close').onclick = close;
  document.getElementById('export-pdf').onclick = () => downloadChamaPDF(state.chama.selectedYear);
  document.getElementById('export-print').onclick = () => printChamaYear(state.chama.selectedYear);
  document.getElementById('export-csv').onclick = () => downloadChamaCSV(state.chama.selectedYear);
}

function csvEscape(str) {
  const s = String(str ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function safeFileSlug(str) {
  return String(str || '').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '');
}

function printChamaYear(year) {
  const shopName = getShopName();
  const chamaName = getChamaName();
  const titleName = chamaName || shopName;
  const members = state.chama.members;

  const headerCells = MONTH_SHORT.map(m => `<th>${m}</th>`).join('');
  const rows = members.map(m => {
    const cells = MONTH_SHORT.map((_, i) => {
      const month = i + 1;
      const p = findPayment(m.id, year, month);
      const isPaid = !!(p && p.paid);
      return `<td>${isPaid ? money(p.amount) : '—'}</td>`;
    }).join('');
    const total = chamaMemberYearTotal(m.id, year);
    return `<tr><td class="pname">${escapeHtml(m.name)}</td>${cells}<td class="ptotal">${money(total)}</td></tr>`;
  }).join('');
  const grandTotal = members.reduce((sum, m) => sum + chamaMemberYearTotal(m.id, year), 0);
  const dateStr = new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' });

  const html = `
    <h1>${titleName ? escapeHtml(titleName) + ' — ' : ''}Mama Chama ${year}</h1>
    ${chamaName && shopName ? `<div class="print-meta">via ${escapeHtml(shopName)}</div>` : ''}
    <div class="print-meta">Printed ${dateStr}</div>
    <table>
      <thead><tr><th class="pname">Member</th>${headerCells}<th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td class="pname">Grand total</td><td colspan="12"></td><td class="ptotal">${money(grandTotal)}</td></tr></tfoot>
    </table>
    <div class="print-founder">Founded by Maslah Aliow Abdow — Takaba, Mandera</div>
  `;

  document.getElementById('print-area').innerHTML = html;
  state.chama.showExport = false;
  render();
  setTimeout(() => window.print(), 50);
}

function downloadChamaCSV(year) {
  const chamaName = getChamaName();
  const members = state.chama.members;
  const header = ['Member', ...MONTH_NAMES, 'Total'];
  const lines = [header.map(csvEscape).join(',')];

  members.forEach(m => {
    const cells = MONTH_SHORT.map((_, i) => {
      const month = i + 1;
      const p = findPayment(m.id, year, month);
      const isPaid = !!(p && p.paid);
      return isPaid ? Number(p.amount) : '';
    });
    const total = chamaMemberYearTotal(m.id, year);
    lines.push([csvEscape(m.name), ...cells, total].join(','));
  });

  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileSlug(chamaName) || 'mama-chama'}-${year}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  state.chama.showExport = false;
  render();
}

// ---------- Mama Chama: professional PDF export ----------
// Builds a colourful, branded PDF (drawn logo, chama name, year, founder
// credit) using jsPDF + autoTable, in addition to the existing CSV/print.
function downloadChamaPDF(year) {
  if (!window.jspdf) {
    alert('The PDF tool did not load — check your connection and try again.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const chamaName = getChamaName() || 'Mama Chama';
  const shopName = getShopName();
  const members = state.chama.members;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const COLOR = {
    ink: [27, 46, 43],
    paper: [246, 239, 217],
    paperRaised: [251, 246, 232],
    amber: [217, 142, 43],
    amberDark: [185, 116, 28],
    moss: [79, 121, 66],
    rust: [179, 64, 44],
    line: [216, 203, 160],
    charcoal: [43, 43, 40],
  };

  function drawHeader() {
    // Signboard-style banner, matching the app's ink/amber palette.
    doc.setFillColor(...COLOR.ink);
    doc.rect(0, 0, pageWidth, 92, 'F');
    doc.setFillColor(...COLOR.amber);
    doc.rect(0, 90, pageWidth, 3, 'F');

    // Drawn emblem standing in for the app logo.
    doc.setFillColor(...COLOR.amber);
    doc.circle(48, 46, 21, 'F');
    doc.setTextColor(...COLOR.ink);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text('DD', 48, 51, { align: 'center' });

    doc.setTextColor(...COLOR.paper);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(19);
    doc.text('Duka Debt', 82, 39);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.text('Mama Chama — Official Contribution Record', 82, 55);
    if (shopName) {
      doc.setFontSize(8.5);
      doc.text(shopName, 82, 68);
    }

    doc.setTextColor(...COLOR.paper);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.text(chamaName, pageWidth - 30, 39, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(`Contribution Year ${year}`, pageWidth - 30, 57, { align: 'right' });
  }

  function drawFooter(pageNum, pageCount) {
    doc.setDrawColor(...COLOR.line);
    doc.setLineWidth(1);
    doc.line(30, pageHeight - 46, pageWidth - 30, pageHeight - 46);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(...COLOR.charcoal);
    doc.text('Founded by Maslah Aliow Abdow — Takaba, Mandera', 30, pageHeight - 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(`Page ${pageNum} of ${pageCount}`, pageWidth - 30, pageHeight - 28, { align: 'right' });
  }

  const head = [['Member', ...MONTH_SHORT, 'Total']];
  const body = members.map(m => {
    const cells = MONTH_SHORT.map((_, i) => {
      const p = findPayment(m.id, year, i + 1);
      return (p && p.paid) ? money(p.amount) : '—';
    });
    return [m.name, ...cells, money(chamaMemberYearTotal(m.id, year))];
  });
  const grand = members.reduce((sum, m) => sum + chamaMemberYearTotal(m.id, year), 0);

  doc.autoTable({
    head,
    body,
    foot: [['Grand total', ...Array(12).fill(''), money(grand)]],
    startY: 112,
    margin: { top: 100, left: 30, right: 30, bottom: 56 },
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, textColor: COLOR.charcoal, lineColor: COLOR.line, lineWidth: 0.5, cellPadding: 4 },
    headStyles: { fillColor: COLOR.ink, textColor: COLOR.paper, fontStyle: 'bold', fontSize: 8, halign: 'center' },
    footStyles: { fillColor: COLOR.amber, textColor: COLOR.ink, fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: COLOR.paperRaised },
    columnStyles: {
      0: { fontStyle: 'bold', halign: 'left', textColor: COLOR.ink, cellWidth: 92 },
      13: { fontStyle: 'bold', textColor: COLOR.moss },
    },
    didDrawPage: drawHeader,
  });

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    drawFooter(i, pageCount);
  }

  doc.save(`${safeFileSlug(chamaName) || 'mama-chama'}-${year}.pdf`);

  state.chama.showExport = false;
  render();
}

function renderCustomerSheet() {
  const c = state.customers.find(c => c.id === state.openCustomerId);
  if (!c) return '';
  const owed = totalOwed(c);

  const debtLines = c.debts.length
    ? c.debts.map(d => {
        const remaining = debtRemaining(d);
        const isFullyPaid = remaining <= 0;
        const paidAmount = Number(d.paid_amount || 0);
        const progressText = paidAmount > 0 && !isFullyPaid
          ? `<div class="desc">Paid ${money(paidAmount)} of ${money(d.amount)} — ${money(remaining)} left</div>`
          : '';
        return `
        <div class="debt-line ${isFullyPaid ? 'paid' : ''}">
          <div>
            <div>${money(d.amount)} <button class="delete-debt" data-id="${d.id}" title="Delete this debt" style="font-size:13px;background:none;border:none;cursor:pointer;">🗑</button></div>
            ${d.description ? `<div class="desc">${escapeHtml(d.description)}</div>` : ''}
            ${progressText}
          </div>
          ${isFullyPaid
            ? '<span class="amt">Paid</span>'
            : `<button class="record-payment" data-debt="${d.id}">Record payment</button>`}
        </div>
      `;
      }).join('')
    : `<div class="debt-line"><span class="desc">No debts recorded yet.</span></div>`;

  const waLink = c.phone ? buildWhatsAppLink(c.phone, c.name, owed) : null;

  return `
    <div class="sheet-backdrop" id="cust-backdrop">
      <div class="sheet">
        <button class="close-x" id="cust-close">&times;</button>
        <h2>${escapeHtml(c.name)}
          <button id="cust-edit" title="Edit customer" style="font-size:16px;background:none;border:none;cursor:pointer;">✏️</button>
          <button id="cust-delete" title="Delete customer" style="font-size:16px;background:none;border:none;cursor:pointer;">🗑</button>
        </h2>
        <div class="section-label">Owes ${money(owed)}</div>
        ${debtLines}

        <div class="section-label" style="margin-top:22px">Add a debt</div>
        <div class="field amount">
          <label for="debt-amount">Amount (KSh)</label>
          <input id="debt-amount" type="number" inputmode="numeric" placeholder="0" />
        </div>
        <div class="field">
          <label for="debt-desc">What for (optional)</label>
          <input id="debt-desc" type="text" placeholder="e.g. 2 bags of sugar" />
        </div>
        <button class="primary" id="debt-save">Add debt</button>

        ${waLink ? `<a class="whatsapp-btn" href="${waLink}" target="_blank" rel="noopener">Remind ${escapeHtml(c.name)} on WhatsApp</a>` : ''}
        ${c.phone ? `<button class="primary" id="sms-remind" style="margin-top:10px;background:#2f3e3a;">Remind ${escapeHtml(c.name)} by SMS</button>` : ''}
      </div>
    </div>
  `;
}

function wireCustomerSheet() {
  const c = state.customers.find(c => c.id === state.openCustomerId);
  const close = () => { state.openCustomerId = null; render(); };
  document.getElementById('cust-backdrop').onclick = (e) => { if (e.target.id === 'cust-backdrop') close(); };
  document.getElementById('cust-close').onclick = close;

  document.getElementById('cust-edit').onclick = () => editCustomer(c.id, c.name, c.phone);
  document.getElementById('cust-delete').onclick = () => deleteCustomer(c.id);

  document.querySelectorAll('.record-payment').forEach(btn => {
    btn.onclick = () => recordPayment(btn.dataset.debt);
  });

  document.querySelectorAll('.delete-debt').forEach(btn => {
    btn.onclick = () => deleteDebt(btn.dataset.id);
  });

  const smsBtn = document.getElementById('sms-remind');
  if (smsBtn) {
    smsBtn.onclick = () => sendSmsReminder(c.id);
  }

  document.getElementById('debt-save').onclick = async () => {
    const amount = parseFloat(document.getElementById('debt-amount').value);
    const description = document.getElementById('debt-desc').value.trim();
    if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }
    await addDebt(state.openCustomerId, amount, description || null);
  };
}

function renderAboutSheet() {
  return `
    <div class="sheet-backdrop" id="about-backdrop">
      <div class="sheet founder-sheet">
        <button class="close-x" id="about-close">&times;</button>
        <div class="founder-badge">Founder</div>
        <h2>Maslah Aliow Abdow</h2>
        <div class="founder-location">Takaba, Mandera</div>

        <div class="founder-subhead">Mission</div>
        <p class="founder-bio">
          To give small shop owners a simple, honest way to track what
          their customers owe — replacing the torn exercise book with
          something that never loses a page and never forgets who paid.
        </p>

        <div class="founder-subhead">Vision</div>
        <p class="founder-bio">
          A duka in every corner of Kenya running on tools built for it —
          not borrowed from somewhere else — so that keeping track of
          debt is one less thing a shopkeeper has to worry about.
        </p>

        <p class="founder-signoff">Asante for trusting the ledger. — Maslah</p>
      </div>
    </div>
  `;
}

function wireAboutSheet() {
  const close = () => { state.showAbout = false; render(); };
  document.getElementById('about-backdrop').onclick = (e) => { if (e.target.id === 'about-backdrop') close(); };
  document.getElementById('about-close').onclick = close;
}

function buildWhatsAppLink(phone, name, owed) {
  const digits = phone.replace(/[^0-9]/g, '');
  const shopName = getShopName();
  const message = shopName
    ? `Hello ${name}, this is a friendly reminder from ${shopName} that your outstanding balance is ${money(owed)}. Thank you!`
    : `Hello ${name}, this is a friendly reminder from your shop that your outstanding balance is ${money(owed)}. Thank you!`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Auth screen ----------

function renderAuthScreen() {
  const isSignup = state.authMode === 'signup';
  return `
    <div class="auth-screen">
      <h1>Duka <span>Debt</span></h1>
      <div class="sub">Track what your customers owe you — no notebook needed.</div>
      <div class="field">
        <label for="auth-email">Email</label>
        <input id="auth-email" type="email" placeholder="you@example.com" />
      </div>
      <div class="field">
        <label for="auth-password">Password</label>
        <input id="auth-password" type="password" placeholder="••••••••" />
      </div>
      ${state.authError ? `<div class="error-text">${escapeHtml(state.authError)}</div>` : ''}
      <button class="primary" id="auth-submit">${isSignup ? 'Create account' : 'Sign in'}</button>
      <div class="auth-toggle">
        ${isSignup ? 'Already have an account?' : "Don't have an account yet?"}
        <button id="auth-toggle-btn">${isSignup ? 'Sign in' : 'Create one'}</button>
      </div>
    </div>
  `;
}

function wireAuthScreen() {
  document.getElementById('auth-submit').onclick = () => {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    if (!email || !password) {
      state.authError = 'Enter both email and password.';
      render();
      return;
    }
    handleAuthSubmit(email, password);
  };
  document.getElementById('auth-toggle-btn').onclick = () => {
    state.authMode = state.authMode === 'signup' ? 'signin' : 'signup';
    state.authError = '';
    render();
  };
}

// ---------- Boot ----------

async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  if (state.session) {
    await refresh();
  } else {
    state.loading = false;
    render();
  }

  sb.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    if (session) refresh(); else render();
  });
}

boot();

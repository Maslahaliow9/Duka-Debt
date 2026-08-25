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
    openCell: null,        // {memberId, month, year}
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
  const ok = confirm('Delete this member and all their contribution records? This cannot be undone.');
  if (!ok) return;
  await sb.from('chama_payments').delete().eq('member_id', id);
  const { error } = await sb.from('chama_members').delete().eq('id', id);
  if (error) { alert(error.message); return; }
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

// ---------- Rendering ----------

function render() {
  if (!state.session) {
    root.innerHTML = renderAuthScreen();
    wireAuthScreen();
    return;
  }

  const shopName = getShopName();
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
    ${state.chama.openCell ? renderCellSheet() : ''}
  `;

  document.getElementById('signout-btn').onclick = handleSignOut;
  document.getElementById('founder-link').onclick = () => { state.showAbout = true; render(); };
  document.getElementById('shop-name-edit').onclick = setShopName;
  document.getElementById('tab-debt').onclick = () => { state.tab = 'debt'; render(); };
  document.getElementById('tab-chama').onclick = () => { state.tab = 'chama'; render(); };

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
    <div class="chama-toolbar">
      <button class="members-link" id="members-link">👥 ${members.length} member${members.length === 1 ? '' : 's'}</button>
      <button class="year-delete" id="delete-year-btn" title="Delete ${year}">🗑 Delete ${year}</button>
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
    ` : ''}
    ${content}
  `;
}

function renderChamaMonthList(year, month) {
  const rows = state.chama.members.map(m => {
    const p = findPayment(m.id, year, month);
    const isPaid = !!(p && p.paid);
    const amountText = isPaid
      ? money(p.amount)
      : (m.fixed_amount ? `Fixed ${money(m.fixed_amount)}/month` : 'No fixed amount set');
    return `
      <div class="chama-row ${isPaid ? 'paid' : 'unpaid'}" data-member="${m.id}" data-month="${month}">
        <div class="row-top">
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="status ${isPaid ? 'paid' : 'unpaid'}">${isPaid ? '✓ Paid' : '✗ Not paid'}</div>
        </div>
        <div class="meta">${amountText}</div>
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
    return `<tr><th class="row-head">${escapeHtml(m.name)}</th>${cells}<td class="grid-total">${money(total)}</td></tr>`;
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

function wireChamaBody() {
  document.querySelectorAll('.year-chip[data-year]').forEach(btn => {
    btn.onclick = () => { state.chama.selectedYear = parseInt(btn.dataset.year, 10); render(); };
  });

  const addYearChip = document.getElementById('add-year-chip');
  if (addYearChip) addYearChip.onclick = () => { state.chama.showAddYear = true; render(); };

  const membersLink = document.getElementById('members-link');
  if (membersLink) membersLink.onclick = () => { state.chama.showMembers = true; render(); };

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
    btn.onclick = () => { state.chama.selectedMonth = parseInt(btn.dataset.month, 10); render(); };
  });

  document.querySelectorAll('.chama-row, .grid-cell').forEach(el => {
    el.onclick = () => {
      state.chama.openCell = {
        memberId: el.dataset.member,
        month: parseInt(el.dataset.month, 10),
        year: state.chama.selectedYear,
      };
      render();
    };
  });
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

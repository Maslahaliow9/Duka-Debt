// Duka Debt — app logic
// A shopkeeper signs in, adds customers, records what they owe, and can
// remind them over WhatsApp or SMS. All data is scoped to the signed-in
// owner via Supabase Row Level Security (see schema.sql).

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SMS_FUNCTION_URL = 'https://vghnfzgjfnvsbsaucitt.supabase.co/functions/v1/send-sms';

const root = document.getElementById('app');

let state = {
  session: null,
  authMode: 'signin', // 'signin' | 'signup'
  authError: '',
  customers: [],      // [{id, name, phone, debts: [...]}]
  loading: true,
  openCustomerId: null,
  showAddCustomer: false,
  showAbout: false,
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

async function refresh() {
  state.loading = true;
  render();
  await loadCustomers();
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

// ---------- Rendering ----------

function render() {
  if (!state.session) {
    root.innerHTML = renderAuthScreen();
    wireAuthScreen();
    return;
  }

  const shopName = getShopName();

  root.innerHTML = `
    <header class="signboard">
      <button class="signout" id="signout-btn">Sign out</button>
      <h1>Duka <span class="mark">Debt</span></h1>
      <div class="tagline">Who owes you, and how much.</div>
      <div class="shop-name-row">
        ${shopName
          ? `<span class="shop-name-badge">${escapeHtml(shopName)}</span> <button class="shop-name-edit" id="shop-name-edit" title="Edit shop name">✏️</button>`
          : `<button class="shop-name-set" id="shop-name-edit">+ Add your shop name</button>`}
      </div>
    </header>
    <main>
      ${state.loading ? '<div class="loading-text">Loading your ledger…</div>' : renderDashboardBody()}
    </main>
    <div class="founder-link-wrap">
      <button class="founder-link" id="founder-link">About the founder</button>
    </div>
    <button class="fab" id="fab-add">+ Add customer</button>
    ${state.showAddCustomer ? renderAddCustomerSheet() : ''}
    ${state.openCustomerId ? renderCustomerSheet() : ''}
    ${state.showAbout ? renderAboutSheet() : ''}
  `;

  document.getElementById('signout-btn').onclick = handleSignOut;
  document.getElementById('fab-add').onclick = () => { state.showAddCustomer = true; render(); };
  document.getElementById('founder-link').onclick = () => { state.showAbout = true; render(); };
  document.getElementById('shop-name-edit').onclick = setShopName;

  if (state.showAddCustomer) wireAddCustomerSheet();
  if (state.openCustomerId) wireCustomerSheet();
  if (state.showAbout) wireAboutSheet();

  document.querySelectorAll('.customer-row').forEach(el => {
    el.onclick = () => { state.openCustomerId = el.dataset.id; render(); };
  });
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

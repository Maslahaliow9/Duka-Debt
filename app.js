// Duka Debt — app logic
// A shopkeeper signs in, adds customers, records what they owe, and can
// remind them over WhatsApp. All data is scoped to the signed-in owner
// via Supabase Row Level Security (see schema.sql).

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const root = document.getElementById('app');

let state = {
  session: null,
  authMode: 'signin', // 'signin' | 'signup'
  authError: '',
  customers: [],      // [{id, name, phone, debts: [...]}]
  loading: true,
  openCustomerId: null,
  showAddCustomer: false,
};

function money(n) {
  return 'KSh ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0 });
}

function totalOwed(customer) {
  return customer.debts.filter(d => !d.paid).reduce((sum, d) => sum + Number(d.amount), 0);
}

function grandTotal() {
  return state.customers.reduce((sum, c) => sum + totalOwed(c), 0);
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
    .select('id, customer_id, amount, description, paid, created_at')
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
    owner_id: owner, customer_id: customerId, amount, description,
  });
  if (error) { alert(error.message); return; }
  await refresh();
}

async function markPaid(debtId) {
  const { error } = await sb.from('debts')
    .update({ paid: true, paid_at: new Date().toISOString() })
    .eq('id', debtId);
  if (error) { alert(error.message); return; }
  await refresh();
}

// ---------- Rendering ----------

function render() {
  if (!state.session) {
    root.innerHTML = renderAuthScreen();
    wireAuthScreen();
    return;
  }

  root.innerHTML = `
    <header class="signboard">
      <button class="signout" id="signout-btn">Sign out</button>
      <h1>Duka <span class="mark">Debt</span></h1>
      <div class="tagline">Who owes you, and how much.</div>
    </header>
    <main>
      ${state.loading ? '<div class="loading-text">Loading your ledger…</div>' : renderDashboardBody()}
    </main>
    <button class="fab" id="fab-add">+ Add customer</button>
    ${state.showAddCustomer ? renderAddCustomerSheet() : ''}
    ${state.openCustomerId ? renderCustomerSheet() : ''}
  `;

  document.getElementById('signout-btn').onclick = handleSignOut;
  document.getElementById('fab-add').onclick = () => { state.showAddCustomer = true; render(); };

  if (state.showAddCustomer) wireAddCustomerSheet();
  if (state.openCustomerId) wireCustomerSheet();

  document.querySelectorAll('.customer-row').forEach(el => {
    el.onclick = () => { state.openCustomerId = el.dataset.id; render(); };
  });
}

function renderDashboardBody() {
  const total = grandTotal();
  const stampClass = total === 0 ? 'stamp zero' : 'stamp';
  const stampLabel = total === 0 ? 'All settled' : 'Owed to you';

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
          <label for="new-phone">Phone (optional, for WhatsApp reminders)</label>
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
    ? c.debts.map(d => `
        <div class="debt-line ${d.paid ? 'paid' : ''}">
          <div>
            <div>${money(d.amount)}</div>
            ${d.description ? `<div class="desc">${escapeHtml(d.description)}</div>` : ''}
          </div>
          ${d.paid ? '<span class="amt">Paid</span>' : `<button class="mark-paid" data-debt="${d.id}">Mark paid</button>`}
        </div>
      `).join('')
    : `<div class="debt-line"><span class="desc">No debts recorded yet.</span></div>`;

  const waLink = c.phone ? buildWhatsAppLink(c.phone, c.name, owed) : null;

  return `
    <div class="sheet-backdrop" id="cust-backdrop">
      <div class="sheet">
        <button class="close-x" id="cust-close">&times;</button>
        <h2>${escapeHtml(c.name)}</h2>
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
      </div>
    </div>
  `;
}

function wireCustomerSheet() {
  const close = () => { state.openCustomerId = null; render(); };
  document.getElementById('cust-backdrop').onclick = (e) => { if (e.target.id === 'cust-backdrop') close(); };
  document.getElementById('cust-close').onclick = close;

  document.querySelectorAll('.mark-paid').forEach(btn => {
    btn.onclick = () => markPaid(btn.dataset.debt);
  });

  document.getElementById('debt-save').onclick = async () => {
    const amount = parseFloat(document.getElementById('debt-amount').value);
    const description = document.getElementById('debt-desc').value.trim();
    if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }
    await addDebt(state.openCustomerId, amount, description || null);
  };
}

function buildWhatsAppLink(phone, name, owed) {
  const digits = phone.replace(/[^0-9]/g, '');
  const message = `Hello ${name}, this is a friendly reminder from your shop that your outstanding balance is ${money(owed)}. Thank you!`;
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

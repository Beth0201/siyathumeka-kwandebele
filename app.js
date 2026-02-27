// ============================================================
// SIYATHUMEKA KWANDEBELE — COMPLETE APP
// React-style SPA in Vanilla JS + Supabase
// ============================================================

// db is fetched lazily so the app never crashes if Supabase loads slightly late
function getDb() { return window._supabase; }
const db = new Proxy({}, {
  get(_, prop) {
    const client = window._supabase;
    if (!client) { console.error('Supabase not ready'); return () => ({ data: null, error: { message: 'Supabase not connected' } }); }
    return typeof client[prop] === 'function' ? client[prop].bind(client) : client[prop];
  }
});

// ============================================================
// STATE
// ============================================================
const State = {
  user: null,
  profile: null,
  cart: JSON.parse(localStorage.getItem('tkw_cart') || '[]'),
  activeStore: null,
  activeCategory: 'ALL',
  currentPage: 'home',
  products: [],
  orders: [],
  currentOrder: null,
  deliveryInfo: { address: '', lat: null, lng: null, distance: null, fee: null },
  customerInfo: { firstName: '', lastName: '', phone: '', email: '' },
};

// Fee constants
const BASE_FEE = 20;
const PER_KM_FEE = 7;
const VAT_RATE = 0.15;
const DRIVER_SHARE = 0.70;
const MIN_WITHDRAWAL = 15.01;
// Warehouse hub coordinates (Siyabuswa area)
const HUB_LAT = -25.1530;
const HUB_LNG = 29.0500;

// ============================================================
// ROUTER
// ============================================================
function navigate(page, data = {}) {
  Object.assign(State, data);
  State.currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${page}`);
  if (target) {
    target.classList.add('active');
    window.scrollTo(0, 0);
  }
  renderPage(page);
  updateNavBadge();
}

// ============================================================
// TOAST
// ============================================================
function toast(msg, type = 'default') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ============================================================
// SUPABASE AUTH
// ============================================================
async function initAuth() {
  const { data: { session } } = await db.auth.getSession();
  if (session?.user) {
    State.user = session.user;
    await loadProfile();
  }
  db.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_IN' && session) {
      State.user = session.user;
      await loadProfile();
      updateUserUI();
    } else if (event === 'SIGNED_OUT') {
      State.user = null;
      State.profile = null;
      updateUserUI();
    }
  });
}

async function loadProfile() {
  if (!State.user) return;
  const { data } = await db.from('profiles').select('*').eq('id', State.user.id).single();
  if (data) {
    State.profile = data;
  }
}

async function signUp(email, password, profileData) {
  const { data, error } = await db.auth.signUp({ email, password });
  if (error) { toast(error.message, 'error'); return false; }
  // Insert profile
  const { error: pErr } = await db.from('profiles').insert({
    id: data.user.id,
    email,
    ...profileData
  });
  if (pErr) { toast(pErr.message, 'error'); return false; }
  toast('Profile created! Check email to verify.', 'success');
  return true;
}

async function signIn(email, password) {
  const { data, error } = await db.auth.signInWithPassword({ email, password });
  if (error) { toast(error.message, 'error'); return false; }
  State.user = data.user;
  await loadProfile();
  updateUserUI();
  toast('Welcome back!', 'success');
  return true;
}

async function signOut() {
  await db.auth.signOut();
  State.user = null;
  State.profile = null;
  updateUserUI();
  navigate('home');
  toast('Signed out successfully');
}

// ============================================================
// PRODUCTS
// ============================================================
async function loadProducts(storeId = null) {
  let query = db.from('products').select('*').eq('active', true);
  if (storeId) query = query.eq('store_id', storeId);
  const { data, error } = await query;
  if (!error && data) {
    State.products = data;
  }
  return State.products;
}

// ============================================================
// CART
// ============================================================
function addToCart(product) {
  const existing = State.cart.find(i => i.id === product.id);
  if (existing) {
    existing.quantity++;
  } else {
    State.cart.push({ ...product, quantity: 1 });
  }
  saveCart();
  updateNavBadge();
  toast(`${product.name} added to basket`, 'success');
}

function removeFromCart(productId) {
  State.cart = State.cart.filter(i => i.id !== productId);
  saveCart();
  updateNavBadge();
}

function updateCartQty(productId, delta) {
  const item = State.cart.find(i => i.id === productId);
  if (!item) return;
  item.quantity = Math.max(1, item.quantity + delta);
  saveCart();
}

function saveCart() {
  localStorage.setItem('tkw_cart', JSON.stringify(State.cart));
}

function getCartTotal() {
  return State.cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
}

function getCartCount() {
  return State.cart.reduce((sum, i) => sum + i.quantity, 0);
}

function updateNavBadge() {
  const badge = document.getElementById('cart-badge');
  const count = getCartCount();
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }
}

// ============================================================
// ORDERS
// ============================================================
function generateOrderCode() {
  return 'RSA-' + Math.floor(10000 + Math.random() * 90000);
}

function generateWaybill() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  return Array.from({ length: 14 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function createOrder(paymentMethod) {
  if (!State.user || !State.profile) {
    navigate('identity-registry');
    return null;
  }
  const subtotal = getCartTotal();
  const vat = subtotal * VAT_RATE;
  const travelFee = State.deliveryInfo.fee || 0;
  const total = subtotal + vat + travelFee;
  const orderCode = generateOrderCode();
  const waybill = generateWaybill();

  const { data: order, error } = await db.from('orders').insert({
    order_code: orderCode,
    customer_id: State.user.id,
    status: 'pending',
    subtotal,
    vat,
    travel_fee: travelFee,
    total,
    delivery_address: State.deliveryInfo.address,
    delivery_lat: State.deliveryInfo.lat,
    delivery_lng: State.deliveryInfo.lng,
    distance_km: State.deliveryInfo.distance,
    waybill,
    citizen_first_name: State.customerInfo.firstName || State.profile.first_name,
    citizen_last_name: State.customerInfo.lastName || State.profile.last_name,
    citizen_phone: State.customerInfo.phone || State.profile.phone,
    citizen_email: State.customerInfo.email || State.profile.email,
    payment_method: paymentMethod,
  }).select().single();

  if (error) { toast(error.message, 'error'); return null; }

  // Insert order items
  const items = State.cart.map(item => ({
    order_id: order.id,
    product_id: item.id,
    product_name: item.name,
    store_id: item.store_id,
    store_name: item.store_id?.toUpperCase(),
    quantity: item.quantity,
    price: item.price,
    status: 'pending'
  }));

  await db.from('order_items').insert(items);

  // Clear cart
  State.cart = [];
  saveCart();
  updateNavBadge();
  State.currentOrder = order;

  return order;
}

async function loadCustomerOrders() {
  if (!State.user) return [];
  const { data } = await db.from('orders')
    .select('*, order_items(*)')
    .eq('customer_id', State.user.id)
    .order('created_at', { ascending: false });
  return data || [];
}

async function loadPickerOrders() {
  const { data } = await db.from('orders')
    .select('*, order_items(*)')
    .in('status', ['pending', 'gathering'])
    .order('created_at', { ascending: false });
  return data || [];
}

async function loadDriverOrders() {
  const { data } = await db.from('orders')
    .select('*, order_items(*)')
    .eq('status', 'packed')
    .order('created_at', { ascending: false });
  return data || [];
}

async function updateOrderStatus(orderId, status, extraData = {}) {
  const { error } = await db.from('orders').update({ status, ...extraData }).eq('id', orderId);
  if (error) toast(error.message, 'error');
  return !error;
}

async function updateItemStatus(itemId, status) {
  const { error } = await db.from('order_items').update({ status }).eq('id', itemId);
  return !error;
}

// ============================================================
// WALLET
// ============================================================
async function loadWallet() {
  if (!State.user) return { balance: 0, transactions: [], withdrawals: [] };
  const { data: profile } = await db.from('profiles').select('wallet_balance').eq('id', State.user.id).single();
  const { data: transactions } = await db.from('wallet_transactions').select('*').eq('user_id', State.user.id).order('created_at', { ascending: false });
  const { data: withdrawals } = await db.from('withdrawals').select('*').eq('user_id', State.user.id).order('requested_at', { ascending: false });
  return {
    balance: profile?.wallet_balance || 0,
    transactions: transactions || [],
    withdrawals: withdrawals || []
  };
}

async function requestWithdrawal() {
  if (!State.user) return;
  const { data: profile } = await db.from('profiles').select('wallet_balance').eq('id', State.user.id).single();
  const balance = profile?.wallet_balance || 0;
  if (balance < MIN_WITHDRAWAL) {
    toast(`Minimum withdrawal is R${MIN_WITHDRAWAL}`, 'error');
    return;
  }
  const fee = balance * 0.03; // 3% fee
  const netPayout = balance - fee;
  const { error } = await db.from('withdrawals').insert({
    user_id: State.user.id,
    amount: balance,
    net_payout: netPayout,
    status: 'pending'
  });
  if (!error) {
    // Zero out wallet
    await db.from('profiles').update({ wallet_balance: 0 }).eq('id', State.user.id);
    toast('Withdrawal requested!', 'success');
    navigate('wallet');
  }
}

// ============================================================
// GPS / DISTANCE
// ============================================================
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error('Geolocation not supported')); return; }
    navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
  });
}

function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function syncSatellite() {
  const btn = document.getElementById('sync-btn');
  if (btn) { btn.textContent = '⏳ SYNCING...'; btn.disabled = true; }
  try {
    const pos = await getLocation();
    const { latitude: lat, longitude: lng } = pos.coords;
    const distance = calcDistance(HUB_LAT, HUB_LNG, lat, lng);
    const fee = BASE_FEE + (distance * PER_KM_FEE);
    State.deliveryInfo = { ...State.deliveryInfo, lat, lng, distance: Math.round(distance * 10) / 10, fee: Math.round(fee * 100) / 100 };
    renderCalibrationResult();
  } catch (e) {
    // Use demo distance if GPS fails
    const demo = 16.1;
    const fee = BASE_FEE + (demo * PER_KM_FEE);
    State.deliveryInfo = { ...State.deliveryInfo, lat: -25.1, lng: 29.1, distance: demo, fee: Math.round(fee * 100) / 100 };
    renderCalibrationResult();
    toast('Location access denied — using demo distance', 'warning');
  }
  if (btn) { btn.textContent = 'SYNC SATELLITE'; btn.disabled = false; }
}

// ============================================================
// ADMIN / FINANCE
// ============================================================
async function loadAdminStats() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const { data: todayOrders } = await db.from('orders')
    .select('total, travel_fee, status')
    .eq('status', 'delivered')
    .gte('delivered_at', today.toISOString());
  const { data: allOrders } = await db.from('orders')
    .select('total, travel_fee')
    .eq('status', 'delivered');
  const { data: activeOrders } = await db.from('orders')
    .select('id')
    .in('status', ['pending', 'gathering', 'packed', 'in_transit']);
  const { data: withdrawals } = await db.from('withdrawals')
    .select('amount')
    .eq('status', 'paid');

  const todayProfit = (todayOrders || []).reduce((s, o) => s + (o.travel_fee * (1 - DRIVER_SHARE)), 0);
  const lifetimeRevenue = (allOrders || []).reduce((s, o) => s + (o.travel_fee * (1 - DRIVER_SHARE)), 0);
  const adminFees = (withdrawals || []).reduce((s, w) => s + w.amount * 0.03, 0);
  return {
    todayProfit,
    lifetimeRevenue,
    activeConsignments: activeOrders?.length || 0,
    adminFees
  };
}

// ============================================================
// UI HELPERS
// ============================================================
function updateUserUI() {
  const userBtn = document.getElementById('user-btn');
  if (userBtn) {
    userBtn.textContent = State.user ? '👤' : '🔑';
  }
}

function formatRand(amount) {
  return `R ${(+amount || 0).toFixed(2)}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-ZA');
}

function getRoleLabel(role) {
  const map = { customer: 'RSA CITIZEN', picker: 'PICKER', driver: 'DRIVER', admin: 'CEO / ADMIN' };
  return map[role] || 'RSA CITIZEN';
}

function requireAuth() {
  if (!State.user || !State.profile) {
    navigate('checkout-gate');
    return false;
  }
  return true;
}

// ============================================================
// PAGE RENDERERS
// ============================================================

function renderPage(page) {
  const renderers = {
    'home': renderHome,
    'catalog': renderCatalog,
    'basket': renderBasket,
    'logistics-calibration': renderCalibration,
    'settlement': renderSettlement,
    'payment': renderPayment,
    'mission-complete': renderMissionComplete,
    'my-deliveries': renderMyDeliveries,
    'order-detail': renderOrderDetail,
    'wallet': renderWallet,
    'identity-registry': renderIdentityRegistry,
    'sign-in': renderSignIn,
    'my-profile': renderMyProfile,
    'checkout-gate': renderCheckoutGate,
    'picker-terminal': renderPickerTerminal,
    'picker-mission': renderPickerMission,
    'driver-hub': renderDriverHub,
    'admin-hub': renderAdminHub,
    'admin-inventory': renderAdminInventory,
    'admin-deliveries': renderAdminDeliveries,
    'admin-wallets': renderAdminWallets,
    'admin-withdrawals': renderAdminWithdrawals,
    'admin-earnings': renderAdminEarnings,
  };
  if (renderers[page]) renderers[page]();
}

// ---------------------------------------- HOME
function renderHome() {
  const el = document.getElementById('page-home');
  el.innerHTML = `
    <div class="home-ticker">
      <div class="ticker-inner">
        ${['SHOPRITE','SHOPRITE LIQUOR','BOXER','SPAR','ROOTS','FAST DELIVERY','NDEBELE PRIDE','RSA LOGISTICS'].map(s=>`<span class="ticker-item">• ${s}</span>`).join('')}
        ${['SHOPRITE','SHOPRITE LIQUOR','BOXER','SPAR','ROOTS','FAST DELIVERY','NDEBELE PRIDE','RSA LOGISTICS'].map(s=>`<span class="ticker-item">• ${s}</span>`).join('')}
      </div>
    </div>
    <div class="home-hero">
      <div class="home-badge">OFFICIAL KWANDEBELE MARKETPLACE</div>
      <div class="home-title">SIYATHUMEKA<br/><span class="blue">KWANDEBELE</span></div>
      <div class="home-underline"></div>
      <div class="home-tagline">YOUR SINGLE GATEWAY TO KWANDEBELE'S FINEST RETAILERS.<br/>SHOP ACROSS ALL MAJOR STORES WITH UNIFIED LOGISTICS.</div>
      <div class="home-ctas">
        <button class="btn btn-black" onclick="navigate('catalog')">🛒 ACCESS ALL STORES</button>
        <button class="btn btn-white" onclick="navigate('identity-registry')">🪪 CREATE RSA IDENTITY</button>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section-title">NATIONAL CATEGORIES</div>
    <div class="retailer-grid" style="margin-bottom:20px">
      ${['FRESH FOOD','FROZEN FOOD','BAKERY','FOOD CUPBOARD','DRINKS','HOUSEHOLD','BABY','PETS','CLOTHING & FOOTWEAR','ELECTRONICS'].map(cat=>`
        <div class="retailer-card" onclick="State.activeCategory='${cat}';navigate('catalog')">
          <div class="retailer-name" style="font-size:18px">${cat}</div>
        </div>`).join('')}
    </div>
    ${renderFooter()}
  `;
}

// ---------------------------------------- CATALOG
async function renderCatalog() {
  const el = document.getElementById('page-catalog');
  el.innerHTML = `<div class="page-title">STORE<br/><span style="color:var(--blue)">CATALOG</span></div><div class="page-subtitle">SELECT A RETAILER</div><div class="p-20"><div class="spinner"></div></div>`;

  const stores = [
    { id: 'shoprite', name: 'SHOPRITE', tag: 'LOWER PRICES YOU CAN TRUST, ALWAYS.' },
    { id: 'shoprite-liquor', name: 'SHOPRITE LIQUOR', tag: 'GREAT DEALS ON YOUR FAVORITE DRINKS.' },
    { id: 'boxer', name: 'BOXER', tag: 'NEVER PAY MORE THAN THE BOXER PRICE.' },
    { id: 'spar', name: 'SPAR', tag: 'GOOD FOR YOU.' },
    { id: 'roots', name: 'ROOTS', tag: 'QUALITY MEAT AND FRESH PRODUCE.', full: true },
  ];

  await loadProducts(State.activeStore);
  const categories = ['ALL', ...new Set(State.products.map(p => p.category).filter(Boolean))];

  el.innerHTML = `
    <div class="page-title">STORE<br/><span style="color:var(--blue)">CATALOG</span></div>
    <div class="page-subtitle">SELECT A RETAILER</div>
    <div class="retailer-grid">
      ${stores.map(s => `
        <div class="retailer-card ${State.activeStore === s.id ? 'active' : ''} ${s.full ? 'full-width' : ''}" onclick="selectStore('${s.id}')">
          ${State.activeStore === s.id ? '<div class="retailer-badge"></div>' : ''}
          <div class="retailer-name">${s.name}</div>
          <div class="retailer-tag">${s.tag}</div>
        </div>`).join('')}
    </div>
    ${State.activeStore ? `<div style="background:var(--black);color:var(--white);padding:10px 20px;font-size:12px;font-weight:700;letter-spacing:2px;margin-bottom:16px">ACTIVE STORE: ${State.activeStore.toUpperCase()}</div>` : ''}
    <div class="category-filters">
      ${categories.map(c => `<button class="cat-btn ${State.activeCategory === c ? 'active' : ''}" onclick="filterCategory('${c}')">${c}</button>`).join('')}
    </div>
    <div class="product-list" id="product-list">
      ${renderProducts()}
    </div>
    <div style="height:40px"></div>
  `;
}

async function selectStore(storeId) {
  State.activeStore = storeId;
  State.activeCategory = 'ALL';
  await loadProducts(storeId);
  renderCatalog();
}

async function filterCategory(cat) {
  State.activeCategory = cat;
  let prods = State.products;
  if (cat !== 'ALL') prods = prods.filter(p => p.category === cat);
  document.getElementById('product-list').innerHTML = renderProducts(prods);
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('active', b.textContent === cat));
}

function renderProducts(prods = null) {
  const list = prods || (State.activeCategory === 'ALL' ? State.products : State.products.filter(p => p.category === State.activeCategory));
  if (!list.length) return `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-text">NO PRODUCTS FOUND.</div></div>`;
  return list.map(p => `
    <div class="product-card">
      <div class="product-meta">
        <span class="product-cat">${p.category || 'GENERAL'}</span>
        <span class="product-rating">⭐ ${p.rating || 4.0}</span>
      </div>
      <div class="product-store">🏪 ${(p.store_id || '').toUpperCase()}</div>
      <div class="product-name">${p.name}</div>
      <div class="product-desc">${p.description || ''}</div>
      <div class="product-price">R ${(+p.price).toFixed(2)}</div>
      <button class="btn btn-blue" onclick="addToCart(${JSON.stringify(p).replace(/"/g,"'")})">+ ADD TO BASKET</button>
    </div>`).join('');
}

// Override addToCart to handle stringified objects from onclick
const _addToCart = addToCart;
window.addToCart = function(p) {
  if (typeof p === 'string') p = JSON.parse(p.replace(/'/g, '"'));
  _addToCart(p);
};

// ---------------------------------------- BASKET
function renderBasket() {
  const el = document.getElementById('page-basket');
  const subtotal = getCartTotal();
  const vat = subtotal * VAT_RATE;
  const total = subtotal + vat;

  el.innerHTML = `
    <div class="page-title">BASKET</div>
    <div class="divider"></div>
    ${State.cart.length === 0 ? `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <div class="empty-text">YOUR BASKET IS EMPTY.</div>
      </div>
      <div class="p-20"><button class="btn btn-black" onclick="navigate('catalog')">ACCESS STORES</button></div>
    ` : `
      ${State.cart.map(item => `
        <div class="basket-item">
          <div class="basket-item-name">${item.name}</div>
          <div class="basket-item-uid">UID: ${item.uid || item.id?.slice(0,12)?.toUpperCase()}</div>
          <div class="basket-item-price">R ${(+item.price * item.quantity).toFixed(2)}</div>
          <div class="qty-control">
            <button class="qty-btn" onclick="changeQty('${item.id}', -1)">−</button>
            <div class="qty-num">${item.quantity}</div>
            <button class="qty-btn" onclick="changeQty('${item.id}', 1)">+</button>
          </div>
          <button class="btn btn-white btn-sm" style="border:2px solid #000;width:auto;padding:8px 20px" onclick="removeItem('${item.id}')">🗑 EXPUNGE</button>
        </div>
      `).join('')}
      <div class="summary-box">
        <div class="summary-title">SUMMARY</div>
        <div class="summary-row"><span>SUBTOTAL</span><span>R ${subtotal.toFixed(2)}</span></div>
        <div class="summary-row"><span>VAT (15%)</span><span>R ${vat.toFixed(2)}</span></div>
        <div class="summary-row total"><span>Total</span><span>R ${total.toFixed(2)}</span></div>
        <div class="summary-actions">
          <button class="btn btn-black" onclick="proceedFromBasket()">PROCEED →</button>
          <button class="btn btn-white" onclick="navigate('catalog')">CONTINUE SHOPPING</button>
        </div>
      </div>
    `}
  `;
}

window.changeQty = function(id, delta) {
  updateCartQty(id, delta);
  renderBasket();
};
window.removeItem = function(id) {
  removeFromCart(id);
  renderBasket();
};

function proceedFromBasket() {
  if (!requireAuth()) return;
  navigate('logistics-calibration');
}

// ---------------------------------------- LOGISTICS CALIBRATION
function renderCalibration() {
  const el = document.getElementById('page-logistics-calibration');
  el.innerHTML = `
    <div class="page-title" style="color:var(--black)">LOGISTICS<br/><span style="color:var(--blue)">CALIBRATION</span></div>
    <div class="page-subtitle">NATIONAL LOGISTICS PROTOCOL: SYNC YOUR LIVE LOCATION TO CALCULATE DISTANCE-BASED DELIVERY FEES FROM THE NATIONAL GRID HUB.</div>
    <div class="gps-card">
      <div class="gps-icon-wrap">🎯</div>
      <div class="gps-title">SYNC LIVE COORDINATES</div>
      <div class="gps-sub">USE YOUR DEVICE'S SATELLITE LINK TO PINPOINT YOUR EXACT DELIVERY STATION FOR THE MOST ACCURATE TRAVEL FEE CALCULATION.</div>
      <button class="btn btn-black" id="sync-btn" onclick="syncSatellite()">SYNC SATELLITE</button>
      ${State.deliveryInfo.lat ? `<div style="margin-top:12px;font-size:12px;color:var(--green);font-weight:700;letter-spacing:1px">✅ CALIBRATED</div>` : ''}
    </div>
    <div id="calibration-result"></div>
    <div class="card-inner" style="margin:0 20px 16px;border:var(--border)">
      <div class="form-label">PHYSICAL DELIVERY ADDRESS</div>
      <input class="form-input" id="delivery-address" placeholder="E.G. 45 MATHE STREET, SIYABUSWA" value="${State.deliveryInfo.address}" oninput="State.deliveryInfo.address=this.value"/>
      <div class="form-hint">ENTER THE SPECIFIC HOUSE OR BUILDING IDENTIFIER AT THE CALIBRATED COORDINATES.</div>
    </div>
    <div class="info-box">
      <div class="info-icon">ℹ️</div>
      <div class="info-text">LOGISTICS CALCULATION: RSA NATIONAL HUB STANDARD - R${BASE_FEE} BASE TRANSACTION FEE + R${PER_KM_FEE} PER KILOMETER TRAVELED. LIVE CALIBRATION ENSURES FAIR COMPENSATION FOR LOGISTICS OPERATORS AND PRECISE BUDGETING FOR CITIZENS.</div>
    </div>
  `;
  if (State.deliveryInfo.distance) renderCalibrationResult();
}

function renderCalibrationResult() {
  const container = document.getElementById('calibration-result');
  if (!container || !State.deliveryInfo.distance) return;
  container.innerHTML = `
    <div class="distance-card">
      <div class="distance-label">LOGISTICS VERIFIED DISTANCE</div>
      <div class="distance-value">${State.deliveryInfo.distance} KM</div>
      <div class="distance-fee-label">DYNAMIC TRAVEL FEE</div>
      <div class="distance-fee">R ${State.deliveryInfo.fee?.toFixed(2)}</div>
      <div style="border-top:2px solid #000;margin:16px 0 16px"></div>
      <button class="btn btn-black" onclick="proceedToSettlement()">PROCEED TO PAYMENT</button>
    </div>
  `;
}

function proceedToSettlement() {
  State.deliveryInfo.address = document.getElementById('delivery-address')?.value || '';
  if (!State.deliveryInfo.address) { toast('Please enter your delivery address', 'error'); return; }
  navigate('settlement');
}

// ---------------------------------------- SETTLEMENT / CITIZEN INFO
function renderSettlement() {
  const subtotal = getCartTotal();
  const vat = subtotal * VAT_RATE;
  const travelFee = State.deliveryInfo.fee || 0;
  const total = subtotal + vat + travelFee;

  const el = document.getElementById('page-settlement');
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('logistics-calibration')">← BACK</button>
    <div class="page-title">SETTLE</div>
    <div class="divider"></div>
    <div class="form-section" style="margin:0 20px 4px"><h3>🚚 DELIVERY DETAILS</h3></div>
    <div class="form-body" style="margin:0 20px 16px">
      <div class="form-group">
        <div class="form-label">CITIZEN FIRST NAME</div>
        <input class="form-input" id="ci-fname" placeholder="SIPHO" value="${State.customerInfo.firstName || State.profile?.first_name || ''}"/>
      </div>
      <div class="form-group">
        <div class="form-label">CITIZEN LAST NAME</div>
        <input class="form-input" id="ci-lname" placeholder="DUBE" value="${State.customerInfo.lastName || State.profile?.last_name || ''}"/>
      </div>
      <div class="form-group">
        <div class="form-label">CONTACT CELLPHONE</div>
        <input class="form-input" id="ci-phone" type="tel" placeholder="+27 82 000 0000" value="${State.customerInfo.phone || State.profile?.phone || ''}"/>
      </div>
      <div class="form-group">
        <div class="form-label">INQUIRY EMAIL</div>
        <input class="form-input" id="ci-email" type="email" placeholder="citizen@siyathumeka.co.za" value="${State.customerInfo.email || State.profile?.email || ''}"/>
      </div>
    </div>
    <div class="summary-box" style="margin:0 20px 16px">
      <div class="summary-title">VALUATION</div>
      <div class="summary-row"><span>SUBTOTAL</span><span>R ${subtotal.toFixed(2)}</span></div>
      <div class="summary-row travel"><span>✈ TRAVEL (${State.deliveryInfo.distance || 0}KM)</span><span>R ${travelFee.toFixed(2)}</span></div>
      <div class="summary-row"><span>VAT (15%)</span><span>R ${vat.toFixed(2)}</span></div>
      <div class="summary-row total"><span>Total</span><span>R ${total.toFixed(2)}</span></div>
    </div>
    <div class="security-badge" style="margin:0 20px 8px;border:1px solid #E0E0E0;padding:14px 16px;display:flex;align-items:center;gap:12px">
      <span style="color:var(--blue);font-size:20px">🔒</span>
      <span style="font-size:12px;font-weight:700;letter-spacing:1px">ENCRYPTED BY RSA SECURITY AUTHORITY.</span>
    </div>
    <div style="background:var(--yellow);margin:0 20px 20px;padding:14px 16px;display:flex;align-items:center;gap:12px">
      <span style="font-size:20px">🛒</span>
      <span style="font-size:12px;font-weight:700;letter-spacing:1px">GRID VERIFIED: ${getCartCount()} ITEMS READY FOR GATHERING.</span>
    </div>
    <div style="padding:0 20px 40px">
      <button class="btn btn-black" style="font-size:20px;padding:20px" onclick="goToPayment()">PAY R ${total.toFixed(2)}</button>
    </div>
  `;
}

function goToPayment() {
  State.customerInfo = {
    firstName: document.getElementById('ci-fname')?.value || '',
    lastName: document.getElementById('ci-lname')?.value || '',
    phone: document.getElementById('ci-phone')?.value || '',
    email: document.getElementById('ci-email')?.value || '',
  };
  if (!State.customerInfo.firstName) { toast('Please enter your first name', 'error'); return; }
  navigate('payment');
}

// ---------------------------------------- PAYMENT
function renderPayment() {
  const subtotal = getCartTotal();
  const vat = subtotal * VAT_RATE;
  const travelFee = State.deliveryInfo.fee || 0;
  const total = subtotal + vat + travelFee;

  const el = document.getElementById('page-payment');
  el.innerHTML = `
    <div class="payment-header">PAY R ${total.toFixed(2)}</div>
    <div style="background:var(--black);padding:20px">
      <span style="font-size:28px">💳</span>
    </div>
    <div style="border:var(--border);margin:16px 20px;padding:24px">
      <div class="payment-method" style="margin:0 0 8px">
        <input type="radio" name="payment" id="pm-card" value="card" checked/>
        <label for="pm-card">SECURED CARD</label>
      </div>
      <div class="payment-method" style="margin:0 0 20px">
        <input type="radio" name="payment" id="pm-eft" value="eft"/>
        <label for="pm-eft">CITIZEN EFT</label>
      </div>
      <div class="form-group">
        <div class="form-label">CARD IDENTIFICATION NUMBER</div>
        <input class="form-input" id="card-num" placeholder="0000 0000 0000 0000" maxlength="19" oninput="formatCard(this)"/>
      </div>
      <div class="form-row">
        <div class="form-group">
          <div class="form-label">EXPIRY</div>
          <input class="form-input" id="card-exp" placeholder="MM/YY" maxlength="5"/>
        </div>
        <div class="form-group">
          <div class="form-label">CVV</div>
          <input class="form-input" id="card-cvv" placeholder="123" maxlength="3"/>
        </div>
      </div>
    </div>
    <div style="padding:0 20px 40px">
      <button class="btn btn-black" style="font-size:20px;padding:20px" id="pay-btn" onclick="processPayment(${total.toFixed(2)})">PAY R ${total.toFixed(2)}</button>
    </div>
  `;
}

window.formatCard = function(input) {
  let v = input.value.replace(/\s/g, '').replace(/\D/g, '');
  input.value = v.match(/.{1,4}/g)?.join(' ') || v;
};

async function processPayment(total) {
  const btn = document.getElementById('pay-btn');
  btn.innerHTML = '<div class="spinner"></div> PROCESSING...';
  btn.disabled = true;
  const method = document.querySelector('input[name="payment"]:checked')?.value || 'card';

  await new Promise(r => setTimeout(r, 1800)); // Simulate payment processing

  const order = await createOrder(method);
  if (order) {
    navigate('mission-complete');
  } else {
    btn.textContent = `PAY R ${total}`;
    btn.disabled = false;
  }
}

// ---------------------------------------- MISSION COMPLETE
function renderMissionComplete() {
  const el = document.getElementById('page-mission-complete');
  el.innerHTML = `
    <div class="mission-screen">
      <div class="mission-icon">✅</div>
      <div class="mission-title">MISSION<br/>ACTIVE</div>
      <div class="mission-sub">CITIZEN, YOUR DELIVERY IS NOW IN THE RSA LOGISTICS PIPELINE.</div>
      <div class="mission-actions">
        <button class="btn btn-white" onclick="navigate('my-deliveries')">TRACK STATUS</button>
        <button class="btn btn-black" onclick="navigate('catalog')">CONTINUE SHOPPING</button>
      </div>
    </div>
  `;
}

// ---------------------------------------- MY DELIVERIES
async function renderMyDeliveries() {
  const el = document.getElementById('page-my-deliveries');
  el.innerHTML = `<div class="page-title">MY<br/>DELIVERIES</div><div class="page-subtitle">REAL-TIME RSA LOGISTICS TRACKING</div><div class="p-20"><div class="spinner"></div></div>`;

  if (!State.user) { navigate('sign-in'); return; }
  const orders = await loadCustomerOrders();

  el.innerHTML = `
    <div class="page-title">MY<br/>DELIVERIES</div>
    <div class="page-subtitle">REAL-TIME RSA LOGISTICS TRACKING</div>
    <div style="padding:0 20px 20px">
      <input class="form-input" placeholder="SEARCH ORDER ID..." oninput="filterDeliveries(this.value,'${orders.map(o=>o.order_code).join(',')}')"/>
    </div>
    ${orders.length === 0 ? `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-text">NO ORDERS YET.</div></div>` :
      orders.map(o => renderOrderCard(o)).join('')
    }
  `;
}

function renderOrderCard(order) {
  const statusMap = { pending: 'badge-yellow', gathering: 'badge-blue', packed: 'badge-blue', in_transit: 'badge-orange', delivered: 'badge-green', cancelled: 'badge-red' };
  const statusLabel = { pending: '⏰ PENDING', gathering: '📦 GATHERING', packed: '✅ PACKED', in_transit: '🚚 IN TRANSIT', delivered: '✅ DELIVERED', cancelled: '❌ CANCELLED' };
  return `
    <div class="order-card" onclick="viewOrder('${order.id}')">
      <div class="order-card-header">
        <div class="order-code">${order.order_code}</div>
        <span class="badge ${statusMap[order.status] || 'badge-yellow'}">${statusLabel[order.status] || order.status?.toUpperCase()}</span>
      </div>
      <div class="order-body">
        <div class="order-label">TIMESTAMP</div>
        <div class="order-val">${formatDate(order.created_at)}</div>
        <div class="order-label">RSA VALUATION</div>
        <div class="order-val yellow">R ${(+order.total || 0).toFixed(3)}</div>
      </div>
    </div>`;
}

window.viewOrder = async function(orderId) {
  const { data } = await db.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  if (data) { State.currentOrder = data; navigate('order-detail'); }
};

window.filterDeliveries = function(val) {
  document.querySelectorAll('.order-card').forEach(c => {
    c.style.display = c.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
  });
};

// ---------------------------------------- ORDER DETAIL
function renderOrderDetail() {
  const order = State.currentOrder;
  if (!order) { navigate('my-deliveries'); return; }
  const el = document.getElementById('page-order-detail');
  const statusBadge = { pending: 'badge-yellow', gathering: 'badge-blue', packed: 'badge-blue', in_transit: 'badge-orange', delivered: 'badge-green' };
  const statusLabel = { pending: '⏰ PENDING', gathering: '📦 GATHERING', packed: '✅ PACKED', in_transit: '🚚 IN TRANSIT', delivered: '✅ DELIVERED' };

  el.innerHTML = `
    <button class="back-btn" onclick="navigate('my-deliveries')">← MY DELIVERIES</button>
    <div class="order-card" style="margin:20px">
      <div class="order-card-header">
        <div class="order-code">${order.order_code}</div>
        <span class="badge ${statusBadge[order.status] || 'badge-yellow'}">${statusLabel[order.status] || order.status?.toUpperCase()}</span>
      </div>
      <div class="order-body">
        <div class="order-label">TIMESTAMP</div>
        <div class="order-val">${formatDate(order.created_at)}</div>
        <div class="order-label">RSA VALUATION</div>
        <div class="order-val yellow">R ${(+order.total || 0).toFixed(3)}</div>
        ${order.delivery_address ? `<div class="order-label">LOGISTICS DESTINATION</div><div class="order-val" style="display:flex;align-items:center;gap:8px"><span style="color:var(--blue)">📍</span>${order.delivery_address}</div>` : ''}
        <div class="order-items-list">
          ${(order.order_items || []).map(item => `
            <div class="order-item-row">
              <div>
                <div>${item.quantity}X ${item.product_name}</div>
                <div class="order-item-store">${(item.store_name || '').toUpperCase()}</div>
              </div>
              <div>R ${(+item.price * item.quantity).toFixed(2)}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="order-footer">
        <div style="font-size:11px;font-weight:700;letter-spacing:1px">LOGISTICS WAYBILL:</div>
        <div style="background:var(--black);color:var(--white);padding:4px 12px;font-size:12px;font-weight:700;letter-spacing:1px">${order.waybill || '—'}</div>
        <button class="btn btn-white btn-sm" style="margin-top:8px">CITIZEN SUPPORT</button>
        <button class="btn btn-black btn-sm" style="margin-top:8px" onclick="repeatOrder('${order.id}')">REPEAT DELIVERY</button>
      </div>
    </div>
  `;
}

window.repeatOrder = async function(orderId) {
  const { data: items } = await db.from('order_items').select('*, products(*)').eq('order_id', orderId);
  if (items) {
    items.forEach(item => { if (item.products) addToCart(item.products); });
    navigate('basket');
  }
};

// ---------------------------------------- WALLET
async function renderWallet() {
  const el = document.getElementById('page-wallet');
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('my-profile')">← BACK</button>
    <div class="page-title">MY<br/>WALLET</div>
    <div class="page-subtitle">CITIZEN LOGISTICS CREDITS & REFUNDS</div>
    <div class="divider"></div>
    <div class="p-20"><div class="spinner"></div></div>
  `;

  if (!State.user) { navigate('sign-in'); return; }
  const { balance, transactions, withdrawals } = await loadWallet();

  el.innerHTML = `
    <button class="back-btn" onclick="navigate('my-profile')">← BACK</button>
    <div class="page-title">MY<br/>WALLET</div>
    <div class="page-subtitle">CITIZEN LOGISTICS CREDITS & REFUNDS</div>
    <div class="divider"></div>
    <div class="wallet-balance-card">
      <div class="wallet-label">AVAILABLE BALANCE</div>
      <div class="wallet-amount">R ${(+balance).toFixed(2)}</div>
      <div class="wallet-note">NOTE: THIS BALANCE ACCUMULATES FROM ITEMS MARKED "NOT FOUND" DURING GATHERING.</div>
    </div>
    <div class="settlement-card">
      <div class="settlement-icon">🏛</div>
      <div class="settlement-title">INSTITUTIONAL SETTLEMENT</div>
      <button class="btn btn-yellow" onclick="requestWithdrawal()" style="width:200px;margin:0 auto">↑ WITHDRAW</button>
      <div class="settlement-min">MINIMUM R ${MIN_WITHDRAWAL} REQUIRED</div>
    </div>
    <div class="section-title">WALLET MOVEMENTS</div>
    <div class="wallet-table">
      <div class="wallet-table-header"><span>DATE</span><span>TYPE</span><span>AMOUNT</span></div>
      ${transactions.length === 0
        ? `<div class="wallet-empty">NO MOVEMENTS.</div>`
        : transactions.map(t => `
            <div class="wallet-table-row">
              <span>${formatDate(t.created_at)}</span>
              <span>${(t.type || '').toUpperCase()}</span>
              <span>R ${(+t.amount).toFixed(2)}</span>
            </div>`).join('')}
    </div>
    <div style="height:20px"></div>
    <div class="section-title">SETTLEMENT STATUS</div>
    <div class="wallet-table">
      <div class="wallet-table-header"><span>REQUESTED</span><span>NET PAYOUT</span><span>STATUS</span></div>
      ${withdrawals.length === 0
        ? `<div class="wallet-empty">NO WITHDRAWALS.</div>`
        : withdrawals.map(w => `
            <div class="wallet-table-row">
              <span>${formatDate(w.requested_at)}</span>
              <span>R ${(+w.net_payout).toFixed(2)}</span>
              <span><span class="badge ${w.status==='paid'?'badge-green':'badge-yellow'}" style="font-size:10px">${w.status?.toUpperCase()}</span></span>
            </div>`).join('')}
    </div>
    <div style="height:40px"></div>
  `;
}

// ---------------------------------------- IDENTITY REGISTRY
function renderIdentityRegistry() {
  const el = document.getElementById('page-identity-registry');
  el.innerHTML = `
    <div class="page-title">IDENTITY<br/><span style="color:var(--blue)">REGISTRY</span></div>
    <div class="divider"></div>
    <div class="form-section" style="margin:0 20px 4px"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">👤</span><h3>1. PERSONAL IDENTIFICATION</h3></div></div>
    <div class="form-body" style="margin:0 20px 4px">
      <div class="form-group"><div class="form-label">FIRST NAME</div><input class="form-input" id="reg-fname" placeholder="E.G. SIPHO"/></div>
      <div class="form-group"><div class="form-label">LAST NAME</div><input class="form-input" id="reg-lname" placeholder="E.G. DUBE"/></div>
      <div class="form-group"><div class="form-label">IDENTITY NUMBER (RSA ID)</div><input class="form-input" id="reg-id" placeholder="9001015000081"/></div>
      <div class="form-group">
        <div class="form-label">CITIZENSHIP</div>
        <select class="form-select" id="reg-citizenship">
          <option>SOUTH AFRICAN</option><option>OTHER</option>
        </select>
      </div>
    </div>
    <div class="form-section" style="margin:0 20px 4px"><div style="display:flex;align-items:center;gap:10px"><span style="color:var(--blue)">📍</span><h3>2. LOGISTICS POINTS</h3></div></div>
    <div class="form-body" style="margin:0 20px 4px">
      <div class="form-group"><div class="form-label">MAIN DELIVERY ADDRESS</div><input class="form-input" id="reg-addr" placeholder="STREET, SUBURB, CITY, PROVINCE"/></div>
      <div class="form-group"><div class="form-label">FINANCE / BILLING ADDRESS (OPTIONAL)</div><input class="form-input" id="reg-billing" placeholder="LEAVE BLANK IF SAME AS DELIVERY"/></div>
      <div class="form-group"><div class="form-label">CONTACT CELLPHONE</div><input class="form-input" id="reg-phone" type="tel" placeholder="+27 82 000 0000"/></div>
    </div>
    <div class="form-section" style="margin:0 20px 4px"><div style="display:flex;align-items:center;gap:10px"><span style="color:var(--red)">🔒</span><h3>3. SECURITY CLEARANCE</h3></div></div>
    <div class="form-body" style="margin:0 20px 20px">
      <div class="form-group"><div class="form-label">LOGIN EMAIL ADDRESS</div><input class="form-input" id="reg-email" type="email" placeholder="CITIZEN@SIYATHUMEKA.CO.ZA"/></div>
      <div class="form-group"><div class="form-label">SECURITY PASSWORD (SECRET KEY)</div><input class="form-input" id="reg-pass" type="password" placeholder="MIN 6 CHARACTERS"/></div>
      <div class="form-group"><div class="form-label">CONFIRM PASSWORD</div><input class="form-input" id="reg-pass2" type="password" placeholder="REPEAT PASSWORD"/></div>
    </div>
    <div class="citizen-agreement">
      <span class="agreement-icon">🛡</span>
      <div>
        <div class="agreement-title">CITIZEN AGREEMENT</div>
        <div class="agreement-text">BY ESTABLISHING THIS PROFILE, YOU VERIFY THAT ALL PROVIDED DATA IS ACCURATE AND BELONGS TO YOU. THIS IDENTITY SERVES AS YOUR LEGAL AUTHORITY FOR NATIONAL LOGISTICS AND FINANCIAL SETTLEMENTS WITHIN THE SIYATHUMEKA KWANDEBELE NETWORK.</div>
      </div>
    </div>
    <div style="padding:0 20px 40px;margin-top:16px">
      <button class="btn btn-black" style="font-size:16px;padding:20px" onclick="submitRegistration()">ESTABLISH RSA IDENTITY</button>
      <button class="btn-link" style="display:block;text-align:center;margin-top:12px" onclick="navigate('sign-in')">ALREADY REGISTERED? ACCESS PROFILE</button>
    </div>
  `;
}

async function submitRegistration() {
  const fname = document.getElementById('reg-fname')?.value?.trim();
  const lname = document.getElementById('reg-lname')?.value?.trim();
  const idNum = document.getElementById('reg-id')?.value?.trim();
  const citizenship = document.getElementById('reg-citizenship')?.value;
  const addr = document.getElementById('reg-addr')?.value?.trim();
  const phone = document.getElementById('reg-phone')?.value?.trim();
  const email = document.getElementById('reg-email')?.value?.trim();
  const pass = document.getElementById('reg-pass')?.value;
  const pass2 = document.getElementById('reg-pass2')?.value;

  if (!fname || !lname || !email || !pass) { toast('Please fill all required fields', 'error'); return; }
  if (pass !== pass2) { toast('Passwords do not match', 'error'); return; }
  if (pass.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }

  const ok = await signUp(email, pass, {
    first_name: fname, last_name: lname, identity_number: idNum,
    citizenship, delivery_address: addr, phone, role: 'customer'
  });
  if (ok) navigate('sign-in');
}

// ---------------------------------------- SIGN IN
function renderSignIn() {
  const el = document.getElementById('page-sign-in');
  el.innerHTML = `
    <div class="page-title">ACCESS<br/><span style="color:var(--blue)">PROFILE</span></div>
    <div class="divider"></div>
    <div class="form-body" style="margin:20px 20px">
      <div class="form-group"><div class="form-label">LOGIN EMAIL ADDRESS</div><input class="form-input" id="si-email" type="email" placeholder="CITIZEN@SIYATHUMEKA.CO.ZA"/></div>
      <div class="form-group"><div class="form-label">SECURITY PASSWORD</div><input class="form-input" id="si-pass" type="password" placeholder="MIN 6 CHARACTERS"/></div>
    </div>
    <div style="padding:0 20px 40px">
      <button class="btn btn-black" style="padding:20px;font-size:16px" id="signin-btn" onclick="submitSignIn()">ACCESS PROFILE →</button>
      <button class="btn-link" style="display:block;text-align:center;margin-top:12px" onclick="navigate('identity-registry')">CREATE NEW IDENTITY</button>
    </div>
  `;
}

async function submitSignIn() {
  const email = document.getElementById('si-email')?.value;
  const pass = document.getElementById('si-pass')?.value;
  if (!email || !pass) { toast('Please enter email and password', 'error'); return; }
  const btn = document.getElementById('signin-btn');
  btn.innerHTML = '<div class="spinner" style="border-top-color:white"></div>';
  btn.disabled = true;
  const ok = await signIn(email, pass);
  if (ok) {
    navigate(State.profile?.role === 'admin' ? 'admin-hub' : State.profile?.role === 'picker' ? 'picker-terminal' : State.profile?.role === 'driver' ? 'driver-hub' : 'home');
  } else {
    btn.textContent = 'ACCESS PROFILE →';
    btn.disabled = false;
  }
}

// ---------------------------------------- MY PROFILE
async function renderMyProfile() {
  if (!State.user) { navigate('sign-in'); return; }
  if (!State.profile) await loadProfile();
  const el = document.getElementById('page-my-profile');
  el.innerHTML = `
    <div class="page-title">MY<br/>PROFILE</div>
    <div class="divider"></div>
    <div class="profile-badge">
      <div class="profile-role-badge">${getRoleLabel(State.profile?.role)}</div>
      <span style="font-size:24px">✅</span>
    </div>
    <div class="authority-box">
      <div class="authority-header">
        <div class="authority-title">🛡 AUTHORITY CONTROL</div>
        <button class="btn btn-white btn-sm" onclick="loadProfile();toast('Clearance synced','success')">🔄 SYNC GRID CLEARANCE</button>
      </div>
      <div class="authority-note">CLEARANCE IS MANAGED BY THE OFFICE OF THE CEO. USE THIS TO REFRESH YOUR AUTHORITY IF CHANGED IN THE DATABASE CONSOLE.</div>
      <div class="authority-email">${State.user?.email || ''}</div>
    </div>
    <div class="form-section" style="margin:0 20px 4px"><div style="display:flex;align-items:center;gap:8px"><span>👤</span><h3>RSA IDENTITY DETAILS</h3></div></div>
    <div class="form-body" style="margin:0 20px 20px">
      <div class="form-group"><div class="form-label">FIRST NAME</div><input class="form-input" id="pr-fname" value="${State.profile?.first_name || ''}"/></div>
      <div class="form-group"><div class="form-label">LAST NAME</div><input class="form-input" id="pr-lname" value="${State.profile?.last_name || ''}"/></div>
      <div class="form-group"><div class="form-label">IDENTITY NUMBER</div><input class="form-input" id="pr-id" value="${State.profile?.identity_number || ''}"/></div>
      <div class="form-group"><div class="form-label">CONTACT CELLPHONE</div><input class="form-input" id="pr-phone" value="${State.profile?.phone || ''}"/></div>
      <div class="form-group"><div class="form-label">DELIVERY ADDRESS</div><input class="form-input" id="pr-addr" value="${State.profile?.delivery_address || ''}"/></div>
      <button class="btn btn-black" onclick="saveProfile()">SAVE CHANGES</button>
    </div>
    <div style="padding:0 20px 40px">
      <button class="btn btn-white" onclick="navigate('wallet')">💼 MY WALLET</button>
      <div style="height:12px"></div>
      <button class="btn btn-red" onclick="signOut()">SIGN OUT</button>
    </div>
  `;
}

async function saveProfile() {
  if (!State.user) return;
  const updates = {
    first_name: document.getElementById('pr-fname')?.value,
    last_name: document.getElementById('pr-lname')?.value,
    identity_number: document.getElementById('pr-id')?.value,
    phone: document.getElementById('pr-phone')?.value,
    delivery_address: document.getElementById('pr-addr')?.value,
  };
  const { error } = await db.from('profiles').update(updates).eq('id', State.user.id);
  if (!error) { Object.assign(State.profile, updates); toast('Profile updated!', 'success'); }
  else toast(error.message, 'error');
}

// ---------------------------------------- CHECKOUT GATE
function renderCheckoutGate() {
  const el = document.getElementById('page-checkout-gate');
  el.innerHTML = `
    <div style="padding:40px 20px">
      <div class="auth-gate">
        <div class="auth-icon">❗</div>
        <div class="auth-title">REGISTERED<br/>IDENTITY<br/>REQUIRED</div>
        <div class="auth-sub">CITIZEN, YOU MUST ESTABLISH A PERMANENT RSA IDENTITY TO FINALIZE YOUR NATIONAL SHOPPING MISSION.</div>
        <button class="btn btn-black" style="max-width:320px;margin:0 auto" onclick="navigate('identity-registry')">REGISTER A PROFILE</button>
        <button class="btn-link" style="display:block;text-align:center;margin-top:12px" onclick="navigate('sign-in')">EXISTING PROFILE? SIGN IN</button>
      </div>
    </div>
  `;
}

// ---------------------------------------- PICKER TERMINAL
async function renderPickerTerminal() {
  if (!State.user || !['picker','admin'].includes(State.profile?.role)) {
    if (!State.user) { navigate('sign-in'); return; }
    toast('Access denied — Picker only', 'error'); navigate('home'); return;
  }
  const el = document.getElementById('page-picker-terminal');
  el.innerHTML = `<div class="page-title">PICKER<br/>TERMINAL</div><div class="page-subtitle">NATIONAL GROCERY GATHERING & PICKING STATION</div><div class="p-20"><div class="spinner"></div></div>`;

  const orders = await loadPickerOrders();

  el.innerHTML = `
    <div class="page-title">📦 PICKER<br/>TERMINAL</div>
    <div class="page-subtitle">NATIONAL GROCERY GATHERING & PICKING STATION</div>
    <div class="divider"></div>
    ${orders.length === 0
      ? `<div class="card card-dashed" style="margin:20px"><div class="card-inner text-center" style="padding:40px"><span style="font-size:32px;opacity:0.3">⏰</span><div class="empty-text" style="margin-top:8px">NO PENDING ORDERS</div></div></div>`
      : orders.map(o => `
          <div class="card" style="margin:0 20px 16px;cursor:pointer" onclick="openPickerMission('${o.id}')">
            <div style="background:var(--blue);color:white;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
              <div style="font-family:var(--font-display);font-size:22px"># ${o.order_code}</div>
              <span class="badge badge-white">${o.picker_id === State.user?.id ? 'MY WORK' : 'AWAITING PICKER'}</span>
            </div>
            <div class="card-inner">
              <div style="font-size:11px;color:var(--gray-mid);letter-spacing:1.5px;margin-bottom:4px">CITIZEN IDENTIFICATION</div>
              <div style="font-family:var(--font-display);font-size:24px;margin-bottom:12px">${(o.citizen_first_name + ' ' + o.citizen_last_name).toUpperCase()}</div>
              <div style="font-size:11px;color:var(--gray-mid);letter-spacing:1.5px;margin-bottom:8px">📦 GATHERING LIST</div>
              ${(o.order_items || []).slice(0,3).map(i => `
                <div style="border:1px solid #E0E0E0;padding:8px 12px;margin-bottom:4px;display:flex;justify-content:space-between;font-size:13px;font-weight:700">
                  <span>${i.quantity}X ${i.product_name}</span>
                  <span style="color:var(--gray-mid);font-size:11px">${(i.store_name||'').toUpperCase()}</span>
                </div>`).join('')}
              ${o.order_items?.length > 3 ? `<div style="font-size:12px;color:var(--gray-mid);text-align:center;padding:8px">+${o.order_items.length - 3} MORE ITEMS</div>` : ''}
              <button class="btn btn-black" style="margin-top:12px" onclick="event.stopPropagation();secureMission('${o.id}')">SECURE MISSION</button>
            </div>
          </div>`).join('')}
  `;
}

window.openPickerMission = async function(orderId) {
  const { data } = await db.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  if (data) { State.currentOrder = data; navigate('picker-mission'); }
};

window.secureMission = async function(orderId) {
  await updateOrderStatus(orderId, 'gathering', { picker_id: State.user.id });
  const { data } = await db.from('orders').select('*, order_items(*)').eq('id', orderId).single();
  if (data) { State.currentOrder = data; navigate('picker-mission'); }
};

// ---------------------------------------- PICKER MISSION
function renderPickerMission() {
  const order = State.currentOrder;
  if (!order) { navigate('picker-terminal'); return; }
  const el = document.getElementById('page-picker-mission');
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('picker-terminal')">← TERMINAL</button>
    <div style="background:var(--blue);color:white;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div style="font-family:var(--font-display);font-size:24px"># ${order.order_code}</div>
      <span class="badge badge-white">MY WORK</span>
    </div>
    <div style="padding:12px 20px;font-size:12px;color:var(--gray-mid);letter-spacing:2px;font-weight:700">✓ LIVE PICKING AUDIT</div>
    <div id="gathering-items" style="padding:0 20px">
      ${(order.order_items || []).map(item => `
        <div class="gathering-item ${item.status === 'found' ? 'found' : item.status === 'missing' ? 'missing' : ''}" id="gi-${item.id}">
          <div class="gathering-qty">${item.quantity}</div>
          <div class="gathering-info">
            <div class="gathering-name">${item.product_name}</div>
            <div class="gathering-store">${(item.store_name||'').toUpperCase()}</div>
          </div>
          ${item.status === 'found'
            ? `<span style="color:var(--green);font-weight:700;font-size:12px">✓ FOUND</span>`
            : item.status === 'missing'
            ? `<span style="color:var(--red);font-weight:700;font-size:12px">✗ MISSING</span>`
            : `<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
                <button class="btn btn-green btn-sm" style="font-size:10px;padding:6px 12px" onclick="markItem('${item.id}','found')">✓ FOUND</button>
                <button class="missing-btn" onclick="markItem('${item.id}','missing')">ITEM MISSING</button>
               </div>`}
        </div>`).join('')}
    </div>
    <div style="background:var(--black);padding:16px 20px;position:sticky;bottom:0;margin-top:20px">
      <button class="btn btn-yellow" onclick="finishAndPack('${order.id}')">FINISH & PACK →</button>
    </div>
  `;
}

window.markItem = async function(itemId, status) {
  await updateItemStatus(itemId, status);
  const el = document.getElementById(`gi-${itemId}`);
  if (!el) return;
  // Update the item in currentOrder
  const item = State.currentOrder.order_items?.find(i => i.id === itemId);
  if (item) item.status = status;
  // If missing → add refund to customer wallet
  if (status === 'missing') {
    el.classList.remove('found'); el.classList.add('missing');
    // Find price and add to customer wallet
    const { data: orderData } = await db.from('orders').select('customer_id').eq('id', State.currentOrder.id).single();
    if (orderData) {
      const price = item.price * item.quantity;
      const { data: custProfile } = await window._supabase.from('profiles').select('wallet_balance').eq('id', orderData.customer_id).single();
      const newBal = ((+custProfile?.wallet_balance) || 0) + price;
      await window._supabase.from('profiles').update({ wallet_balance: newBal }).eq('id', orderData.customer_id);
      await window._supabase.from('wallet_transactions').insert({ user_id: orderData.customer_id, order_id: State.currentOrder.id, type: 'refund', amount: price, description: `Refund: ${item.product_name}` });
    }
    el.querySelector('.gathering-info').insertAdjacentHTML('afterend', `<span style="color:var(--red);font-weight:700;font-size:12px">✗ MISSING</span>`);
  } else {
    el.classList.add('found');
    el.querySelector('.gathering-info').insertAdjacentHTML('afterend', `<span style="color:var(--green);font-weight:700;font-size:12px">✓ FOUND</span>`);
  }
  // Remove buttons
  el.querySelectorAll('.btn-green,.missing-btn').forEach(b => b.remove());
};

window.finishAndPack = async function(orderId) {
  await updateOrderStatus(orderId, 'packed', { packed_at: new Date().toISOString() });
  toast('Order packed! Moved to Driver Pool.', 'success');
  navigate('picker-terminal');
};

// ---------------------------------------- DRIVER HUB
async function renderDriverHub() {
  if (!State.user || !['driver','admin'].includes(State.profile?.role)) {
    if (!State.user) { navigate('sign-in'); return; }
    toast('Access denied — Driver only', 'error'); navigate('home'); return;
  }
  const el = document.getElementById('page-driver-hub');
  el.innerHTML = `<div class="page-title">🚚 DRIVER<br/>HUB</div><div class="p-20"><div class="spinner"></div></div>`;

  const { data: profile } = await db.from('profiles').select('wallet_balance').eq('id', State.user.id).single();
  const orders = await loadDriverOrders();
  const { data: activeRoute } = await db.from('orders').select('*, order_items(*)').eq('driver_id', State.user.id).eq('status', 'in_transit').maybeSingle();

  el.innerHTML = `
    <div class="page-title" style="position:relative">🚚 DRIVER<br/>HUB<span class="ceo-tag">(CEO)</span></div>
    <div class="page-subtitle">RSA NATIONAL LOGISTICS OPERATOR</div>
    <div class="divider"></div>
    <div class="driver-wallet">
      <div class="driver-wallet-icon">💼</div>
      <div class="driver-wallet-info">
        <div class="driver-wallet-label">OPERATOR WALLET (70% FEE)</div>
        <div class="driver-wallet-amount">R ${(+profile?.wallet_balance || 0).toFixed(0)}</div>
      </div>
    </div>
    <div class="section-title">ACTIVE ROUTE</div>
    ${activeRoute
      ? `<div class="active-route-box has-route">
          <div style="font-family:var(--font-display);font-size:28px;margin-bottom:8px">${activeRoute.order_code}</div>
          <div style="font-size:12px;letter-spacing:1.5px;color:#AAA;margin-bottom:16px">📍 ${activeRoute.delivery_address || 'DESTINATION SET'}</div>
          <button class="btn btn-green" onclick="completeDelivery('${activeRoute.id}')">✅ MARK DELIVERED</button>
         </div>`
      : `<div class="active-route-box">
          <span style="font-size:32px;opacity:0.2">⚠</span>
          <div style="font-family:var(--font-body);font-size:16px;font-weight:700;letter-spacing:1px;color:#CCC;margin-top:12px">NO ACTIVE ROUTE</div>
          <div style="font-size:12px;letter-spacing:1px;color:#CCC;margin-top:4px">CLAIM A MISSION FROM THE LOGISTICS POOL TO BEGIN.</div>
         </div>`}
    <div class="section-title" style="margin-top:20px">LOGISTICS POOL</div>
    ${orders.length === 0
      ? `<div class="card card-dashed"><div class="card-inner text-center"><div class="empty-text">QUEUE EMPTY</div><div style="font-size:12px;color:var(--gray-mid);letter-spacing:1px;margin-top:4px;font-style:italic">WAITING FOR STAFF TO COMPLETE GATHERING...</div></div></div>`
      : orders.map(o => `
          <div class="pool-item">
            <div>
              <div class="pool-code">${o.order_code}</div>
              <div class="pool-dest">📍 ${o.delivery_address || 'PENDING ADDRESS'}</div>
              <div style="font-size:12px;color:var(--blue);font-weight:700;margin-top:4px">TRAVEL FEE: R ${(+o.travel_fee||0).toFixed(2)}</div>
            </div>
            <button class="btn btn-black btn-sm" onclick="claimDelivery('${o.id}')">CLAIM</button>
          </div>`).join('')}
    <div style="height:40px"></div>
  `;
}

window.claimDelivery = async function(orderId) {
  await updateOrderStatus(orderId, 'in_transit', { driver_id: State.user.id });
  toast('Mission claimed! You are now on route.', 'success');
  renderDriverHub();
};

window.completeDelivery = async function(orderId) {
  // Get order travel fee
  const { data: order } = await db.from('orders').select('travel_fee, driver_id').eq('id', orderId).single();
  if (order) {
    const driverEarning = (order.travel_fee || 0) * DRIVER_SHARE;
    // Credit driver wallet - fetch current balance first then add
    const { data: driverProfile } = await window._supabase.from('profiles').select('wallet_balance').eq('id', order.driver_id).single();
    const newBalance = ((+driverProfile?.wallet_balance) || 0) + driverEarning;
    await window._supabase.from('profiles').update({ wallet_balance: newBalance }).eq('id', order.driver_id);
    await window._supabase.from('wallet_transactions').insert({ user_id: order.driver_id, order_id: orderId, type: 'earning', amount: driverEarning, description: 'Delivery completed' });
  }
  await updateOrderStatus(orderId, 'delivered', { delivered_at: new Date().toISOString() });
  toast('Delivery complete! Earnings added to wallet.', 'success');
  renderDriverHub();
};

// ---------------------------------------- ADMIN HUB
async function renderAdminHub() {
  if (!State.user || State.profile?.role !== 'admin') {
    if (!State.user) { navigate('sign-in'); return; }
    toast('CEO access only', 'error'); navigate('home'); return;
  }
  const el = document.getElementById('page-admin-hub');
  el.innerHTML = `<div class="page-title">ADMIN<br/>HUB</div><div class="p-20"><div class="spinner"></div></div>`;

  const stats = await loadAdminStats();

  el.innerHTML = `
    <div class="page-title" style="position:relative">📊 ADMIN<br/>HUB<span class="ceo-tag">(CEO)</span></div>
    <div class="page-subtitle">NATIONAL COMMERCE & LOGISTICS COMMAND</div>
    <div class="divider"></div>
    <div class="stat-card yellow"><div class="stat-inner"><div><div class="stat-label">TODAY'S NET PROFIT</div><div class="stat-value">R ${stats.todayProfit.toFixed(2)}</div></div><div class="stat-icon">$</div></div></div>
    <div class="stat-card"><div class="stat-inner"><div><div class="stat-label">LIFETIME CEO REVENUE</div><div class="stat-value">R ${stats.lifetimeRevenue.toFixed(2)}</div></div><div class="stat-icon">🏛</div></div></div>
    <div class="stat-card blue"><div class="stat-inner"><div><div class="stat-label">ACTIVE CONSIGNMENTS</div><div class="stat-value">${stats.activeConsignments}</div></div><div class="stat-icon">🔒</div></div></div>
    <div class="stat-card green"><div class="stat-inner"><div><div class="stat-label">ADMIN FEES COLLECTED</div><div class="stat-value">R ${stats.adminFees.toFixed(0)}</div></div><div class="stat-icon">💼</div></div></div>
    <div class="admin-nav-grid">
      <button class="admin-nav-btn orange" onclick="navigate('picker-terminal')">📦 PICKER TERMINAL</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <button class="admin-nav-btn black" onclick="navigate('admin-inventory')">🏷 INVENTORY</button>
        <button class="admin-nav-btn white" onclick="navigate('admin-deliveries')">🚚 DELIVERIES</button>
      </div>
      <button class="admin-nav-btn yellow" onclick="navigate('admin-wallets')">💼 WALLETS</button>
      <button class="admin-nav-btn blue" onclick="navigate('admin-withdrawals')">↑ WITHDRAWALS</button>
      <button class="admin-nav-btn dark" onclick="navigate('admin-earnings')">🏛 EARNINGS REPORT</button>
    </div>
  `;
}

// ---------------------------------------- ADMIN INVENTORY
async function renderAdminInventory() {
  const el = document.getElementById('page-admin-inventory');
  el.innerHTML = `<button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button><div class="page-title">INVENTORY</div><div class="p-20"><div class="spinner"></div></div>`;
  await loadProducts();
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button>
    <div class="page-title">INVENTORY</div>
    <div class="page-subtitle">PRODUCT MANAGEMENT</div>
    <div class="divider"></div>
    <div style="padding:0 20px 20px">
      <button class="btn btn-black" onclick="showAddProductForm()">+ ADD PRODUCT</button>
    </div>
    <div id="add-product-form" style="display:none"></div>
    ${State.products.map(p => `
      <div style="border:var(--border);margin:0 20px 8px;padding:16px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-family:var(--font-body);font-size:15px;font-weight:700">${p.name}</div>
          <div style="font-size:11px;color:var(--gray-mid);letter-spacing:1px">${(p.store_id||'').toUpperCase()} · ${p.category}</div>
          <div style="font-family:var(--font-display);font-size:20px">R ${(+p.price).toFixed(2)}</div>
        </div>
        <button class="btn btn-red btn-sm" onclick="deleteProduct('${p.id}')">🗑</button>
      </div>`).join('')}
  `;
}

window.showAddProductForm = function() {
  const form = document.getElementById('add-product-form');
  form.style.display = 'block';
  form.innerHTML = `
    <div class="form-body" style="margin:0 20px 16px">
      <div class="form-group"><div class="form-label">PRODUCT NAME</div><input class="form-input" id="np-name" placeholder="PRODUCT NAME"/></div>
      <div class="form-group"><div class="form-label">STORE</div>
        <select class="form-select" id="np-store">
          <option value="shoprite">SHOPRITE</option><option value="shoprite-liquor">SHOPRITE LIQUOR</option>
          <option value="boxer">BOXER</option><option value="spar">SPAR</option><option value="roots">ROOTS</option>
        </select>
      </div>
      <div class="form-group"><div class="form-label">CATEGORY</div>
        <select class="form-select" id="np-cat">
          <option>Fresh Food</option><option>Frozen Food</option><option>Bakery</option><option>Food Cupboard</option>
          <option>Drinks</option><option>Household</option><option>Baby</option><option>Pets</option>
          <option>Clothing & Footwear</option><option>Electronics</option>
        </select>
      </div>
      <div class="form-row">
        <div class="form-group"><div class="form-label">PRICE (ZAR)</div><input class="form-input" id="np-price" type="number" placeholder="0.00"/></div>
        <div class="form-group"><div class="form-label">DESCRIPTION</div><input class="form-input" id="np-desc" placeholder="Short description"/></div>
      </div>
      <button class="btn btn-black" onclick="saveNewProduct()">SAVE PRODUCT</button>
    </div>
  `;
};

window.saveNewProduct = async function() {
  const name = document.getElementById('np-name')?.value?.trim();
  const storeId = document.getElementById('np-store')?.value;
  const category = document.getElementById('np-cat')?.value;
  const price = parseFloat(document.getElementById('np-price')?.value);
  const description = document.getElementById('np-desc')?.value;
  if (!name || !price) { toast('Name and price are required', 'error'); return; }
  const uid = storeId.toUpperCase() + '-' + Date.now();
  const { error } = await db.from('products').insert({ name, store_id: storeId, category, price, description, uid, active: true });
  if (!error) { toast('Product added!', 'success'); renderAdminInventory(); }
  else toast(error.message, 'error');
};

window.deleteProduct = async function(id) {
  if (!confirm('Delete this product?')) return;
  await db.from('products').update({ active: false }).eq('id', id);
  toast('Product removed', 'success');
  renderAdminInventory();
};

// ---------------------------------------- ADMIN DELIVERIES
async function renderAdminDeliveries() {
  const el = document.getElementById('page-admin-deliveries');
  el.innerHTML = `<button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button><div class="page-title">DELIVERIES</div><div class="p-20"><div class="spinner"></div></div>`;
  const { data: orders } = await db.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).limit(50);
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button>
    <div class="page-title">DELIVERIES</div>
    <div class="page-subtitle">ALL CONSIGNMENTS</div>
    <div class="divider"></div>
    ${(orders || []).map(o => renderOrderCard(o)).join('') || '<div class="empty-state"><div class="empty-text">NO ORDERS YET.</div></div>'}
  `;
}

// ---------------------------------------- ADMIN WALLETS
async function renderAdminWallets() {
  const el = document.getElementById('page-admin-wallets');
  el.innerHTML = `<button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button><div class="page-title">WALLETS</div><div class="p-20"><div class="spinner"></div></div>`;
  const { data: profiles } = await db.from('profiles').select('*').order('wallet_balance', { ascending: false });
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button>
    <div class="page-title">WALLETS</div>
    <div class="page-subtitle">ALL CITIZEN & OPERATOR BALANCES</div>
    <div class="divider"></div>
    ${(profiles || []).map(p => `
      <div style="border:var(--border);margin:0 20px 8px;padding:16px;display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-family:var(--font-body);font-size:15px;font-weight:700">${p.first_name || ''} ${p.last_name || ''}</div>
          <div style="font-size:11px;color:var(--gray-mid);letter-spacing:1px">${p.email || ''} · ${(p.role||'customer').toUpperCase()}</div>
        </div>
        <div style="font-family:var(--font-display);font-size:24px">R ${(+p.wallet_balance||0).toFixed(2)}</div>
      </div>`).join('') || '<div class="empty-state"><div class="empty-text">NO PROFILES YET.</div></div>'}
  `;
}

// ---------------------------------------- ADMIN WITHDRAWALS
async function renderAdminWithdrawals() {
  const el = document.getElementById('page-admin-withdrawals');
  el.innerHTML = `<button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button><div class="page-title">WITHDRAWALS</div><div class="p-20"><div class="spinner"></div></div>`;
  const { data: withdrawals } = await db.from('withdrawals').select('*, profiles(first_name,last_name,email)').order('requested_at', { ascending: false });
  el.innerHTML = `
    <button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button>
    <div class="page-title">WITHDRAWALS</div>
    <div class="page-subtitle">PENDING & PROCESSED REQUESTS</div>
    <div class="divider"></div>
    ${(withdrawals || []).map(w => `
      <div style="border:var(--border);margin:0 20px 8px;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div style="font-family:var(--font-body);font-size:15px;font-weight:700">${w.profiles?.first_name||''} ${w.profiles?.last_name||''}</div>
            <div style="font-size:11px;color:var(--gray-mid)">${w.profiles?.email||''}</div>
          </div>
          <span class="badge ${w.status==='pending'?'badge-yellow':w.status==='paid'?'badge-green':'badge-red'}">${w.status?.toUpperCase()}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:12px">
          <div><div style="font-size:11px;color:var(--gray-mid)">REQUESTED</div><div style="font-weight:700">R ${(+w.amount).toFixed(2)}</div></div>
          <div><div style="font-size:11px;color:var(--gray-mid)">NET PAYOUT</div><div style="font-weight:700">R ${(+w.net_payout).toFixed(2)}</div></div>
          <div><div style="font-size:11px;color:var(--gray-mid)">DATE</div><div style="font-weight:700">${formatDate(w.requested_at)}</div></div>
        </div>
        ${w.status === 'pending' ? `<div style="display:flex;gap:8px"><button class="btn btn-green btn-sm" onclick="approveWithdrawal('${w.id}')">APPROVE</button><button class="btn btn-red btn-sm" onclick="rejectWithdrawal('${w.id}')">REJECT</button></div>` : ''}
      </div>`).join('') || '<div class="empty-state"><div class="empty-text">NO WITHDRAWAL REQUESTS.</div></div>'}
  `;
}

window.approveWithdrawal = async function(id) {
  await db.from('withdrawals').update({ status: 'paid', processed_at: new Date().toISOString() }).eq('id', id);
  toast('Withdrawal approved!', 'success');
  renderAdminWithdrawals();
};
window.rejectWithdrawal = async function(id) {
  await db.from('withdrawals').update({ status: 'rejected', processed_at: new Date().toISOString() }).eq('id', id);
  toast('Withdrawal rejected', 'error');
  renderAdminWithdrawals();
};

// ---------------------------------------- ADMIN EARNINGS
async function renderAdminEarnings() {
  const el = document.getElementById('page-admin-earnings');
  el.innerHTML = `<button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button><div class="page-title">EARNINGS<br/>REPORT</div><div class="p-20"><div class="spinner"></div></div>`;
  const stats = await loadAdminStats();
  const { data: delivered } = await db.from('orders').select('order_code, travel_fee, total, created_at, delivered_at').eq('status', 'delivered').order('delivered_at', { ascending: false }).limit(20);

  el.innerHTML = `
    <button class="back-btn" onclick="navigate('admin-hub')">← ADMIN HUB</button>
    <div class="page-title">EARNINGS<br/>REPORT</div>
    <div class="page-subtitle">NATIONAL COMMERCE & LOGISTICS COMMAND</div>
    <div class="divider"></div>
    <div class="stat-card green"><div class="stat-inner"><div><div class="stat-label">ADMIN FEES COLLECTED</div><div class="stat-value">R ${stats.adminFees.toFixed(2)}</div></div><div class="stat-icon">💼</div></div></div>
    <div class="section-title" style="margin-top:12px">DAILY NET PROFIT FEED</div>
    <div style="background:var(--yellow);padding:8px 20px;display:flex;justify-content:flex-end">
      <div style="font-size:12px;font-weight:700;letter-spacing:1px">TODAY: R ${stats.todayProfit.toFixed(2)}</div>
    </div>
    <div class="profit-table">
      <div class="profit-table-header"><span>REF ID</span><span>TYPE</span><span>TIME</span><span>NET PROFIT</span></div>
      ${(delivered||[]).length === 0
        ? `<div class="wallet-empty">NO PROFIT RECORDED TODAY YET.</div>`
        : (delivered||[]).map(o => `
            <div class="profit-row">
              <span>${o.order_code}</span>
              <span>DELIVERY</span>
              <span>${formatDate(o.delivered_at)}</span>
              <span>R ${((+o.travel_fee||0) * (1-DRIVER_SHARE)).toFixed(2)}</span>
            </div>`).join('')}
    </div>
    <div style="height:40px"></div>
  `;
}

// ============================================================
// FOOTER
// ============================================================
function renderFooter() {
  return `
    <footer class="footer">
      <div class="footer-brand">SIYATHUMEKA<br/>KWANDEBELE</div>
      <div class="footer-tagline">PREMIUM MARKETPLACE FOR LOCALLY-SOURCED GOODS AND ESSENTIALS. SERVING THE REPUBLIC OF SOUTH AFRICA WITH FAST LOGISTICS AND NDEBELE PRIDE.</div>
      <div class="footer-section-title">CATALOG</div>
      ${['FRESH FOOD','BAKERY','DRINKS','ELECTRONICS'].map(c=>`<a class="footer-link" onclick="State.activeCategory='${c}';navigate('catalog')">${c}</a>`).join('')}
      <div class="footer-section-title">CITIZEN SERVICES</div>
      ${[['MY DELIVERIES','my-deliveries'],['SHOPPING BASKET','basket'],['RSA IDENTITY','identity-registry']].map(([l,p])=>`<a class="footer-link" onclick="navigate('${p}')">${l}</a>`).join('')}
      <div class="footer-section-title">GOVERNANCE</div>
      ${['SUPPORT CENTER','LOGISTICS TERMS','PRIVACY POLICY','FARMER NETWORK'].map(l=>`<a class="footer-link">${l}</a>`).join('')}
      <div class="footer-bottom">© 2026 SIYATHUMEKA KWANDEBELE. ALL RIGHTS RESERVED. RSA LOGISTICS NETWORK.</div>
    </footer>
  `;
}

// ============================================================
// NAVBAR & MENU
// ============================================================
function buildApp() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <!-- NAVBAR -->
    <nav id="navbar">
      <div class="nav-brand" onclick="navigate('home')">
        <span class="nav-truck">🚚</span>
        <div class="nav-title">SIYATHUMEKA<br/>KWANDEBELE</div>
      </div>
      <div class="nav-actions">
        <button class="nav-btn" onclick="navigate('basket')" title="Basket">
          🛒
          <span class="nav-badge" id="cart-badge" style="display:none">0</span>
        </button>
        <button class="nav-btn" id="user-btn" onclick="toggleUserDropdown()" title="Account">👤</button>
        <button class="nav-btn" onclick="openMenu()">☰</button>
      </div>
    </nav>

    <!-- USER DROPDOWN -->
    <div class="user-dropdown" id="user-dropdown">
      <div id="user-dropdown-content"></div>
    </div>

    <!-- FLAG STRIP -->
    <div class="flag-strip"></div>

    <!-- PAGES -->
    <main>
      ${['home','catalog','basket','logistics-calibration','settlement','payment','mission-complete','my-deliveries','order-detail','wallet','identity-registry','sign-in','my-profile','checkout-gate','picker-terminal','picker-mission','driver-hub','admin-hub','admin-inventory','admin-deliveries','admin-wallets','admin-withdrawals','admin-earnings'].map(p=>`<div class="page" id="page-${p}"></div>`).join('')}
    </main>

    <!-- MENU OVERLAY -->
    <div class="menu-overlay" id="menu-overlay" onclick="closeMenu()"></div>
    <div class="menu-drawer" id="menu-drawer">
      <div class="menu-header">
        <div class="menu-logo">🚚 SIYATHUMEKA KWANDEBELE</div>
        <button class="menu-close" onclick="closeMenu()">✕</button>
      </div>
      <div class="menu-section">
        <div class="menu-section-title">CATALOG</div>
        <a class="menu-link" onclick="navigate('catalog');closeMenu()">CATALOG</a>
        <a class="menu-link" onclick="navigate('my-deliveries');closeMenu()">TRACK ORDERS</a>
        <a class="menu-link" onclick="navigate('basket');closeMenu()">CART</a>
      </div>
      <div class="menu-section" id="menu-staff-section" style="display:none">
        <div class="menu-section-title">STAFF</div>
        <a class="menu-link" id="menu-picker-link" style="display:none" onclick="navigate('picker-terminal');closeMenu()">PICKER TERMINAL</a>
        <a class="menu-link" id="menu-driver-link" style="display:none" onclick="navigate('driver-hub');closeMenu()">DRIVER HUB</a>
        <a class="menu-link" id="menu-admin-link" style="display:none" onclick="navigate('admin-hub');closeMenu()">ADMIN HUB</a>
      </div>
    </div>

    <!-- TOAST CONTAINER -->
    <div class="toast-container" id="toast-container"></div>
  `;
}

function toggleUserDropdown() {
  const dd = document.getElementById('user-dropdown');
  const isOpen = dd.classList.contains('open');
  if (isOpen) { dd.classList.remove('open'); return; }
  const content = document.getElementById('user-dropdown-content');
  if (State.user) {
    content.innerHTML = `
      <div class="user-dropdown-header"><div class="user-dropdown-label">SIGNED IN AS</div><div class="user-dropdown-email">${State.user.email}</div></div>
      <div class="user-dropdown-item user-dropdown-wallet" onclick="navigate('wallet');toggleUserDropdown()">💼 WALLET <span style="margin-left:auto">R 0.00</span></div>
      <div class="user-dropdown-item" onclick="navigate('my-profile');toggleUserDropdown()">⚙ MY PROFILE</div>
      <div class="user-dropdown-item user-dropdown-signout" onclick="signOut();toggleUserDropdown()">→ SIGN OUT</div>
    `;
  } else {
    content.innerHTML = `
      <div class="user-dropdown-item" onclick="navigate('sign-in');toggleUserDropdown()">🔑 SIGN IN</div>
      <div class="user-dropdown-item" onclick="navigate('identity-registry');toggleUserDropdown()">🪪 REGISTER</div>
    `;
  }
  dd.classList.add('open');
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target) && !document.getElementById('user-btn').contains(e.target)) dd.classList.remove('open');
  }, { once: true });
}

function openMenu() {
  document.getElementById('menu-overlay').classList.add('open');
  document.getElementById('menu-drawer').classList.add('open');
  updateMenuLinks();
}

function closeMenu() {
  document.getElementById('menu-overlay').classList.remove('open');
  document.getElementById('menu-drawer').classList.remove('open');
}

function updateMenuLinks() {
  const role = State.profile?.role;
  if (role && role !== 'customer') {
    document.getElementById('menu-staff-section').style.display = 'block';
    document.getElementById('menu-picker-link').style.display = ['picker','admin'].includes(role) ? 'block' : 'none';
    document.getElementById('menu-driver-link').style.display = ['driver','admin'].includes(role) ? 'block' : 'none';
    document.getElementById('menu-admin-link').style.display = role === 'admin' ? 'block' : 'none';
  }
}

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  const dd = document.getElementById('user-dropdown');
  if (dd && !dd.contains(e.target)) dd.classList.remove('open');
});

// ============================================================
// INIT
// ============================================================
async function init() {
  buildApp();

  // Try to connect to Supabase - if keys are wrong, still show the homepage
  try {
    if (window._supabase) {
      await initAuth();
    } else {
      console.warn('Supabase client not found - check your keys in supabase.js');
    }
  } catch (e) {
    console.warn('Supabase init failed:', e.message);
  }

  updateNavBadge();
  updateUserUI();

  // Hide loading screen
  await new Promise(r => setTimeout(r, 1200));
  const loader = document.getElementById('loading-screen');
  if (loader) {
    loader.classList.add('fade-out');
    setTimeout(() => loader.remove(), 600);
  }

  navigate('home');
}

window.addEventListener('DOMContentLoaded', init);

// ============================================================
// EXPOSE GLOBALS
// ============================================================
Object.assign(window, {
  navigate, State, toast, selectStore, filterCategory,
  syncSatellite, proceedToSettlement, proceedFromBasket,
  goToPayment, processPayment, submitRegistration, submitSignIn,
  signOut, saveProfile, requestWithdrawal, openMenu, closeMenu,
  toggleUserDropdown, secureMission, finishAndPack, markItem,
  openPickerMission, claimDelivery, completeDelivery,
  approveWithdrawal, rejectWithdrawal, showAddProductForm,
  saveNewProduct, deleteProduct, viewOrder, filterDeliveries,
  repeatOrder, changeQty, removeItem, formatCard, renderCalibrationResult
});

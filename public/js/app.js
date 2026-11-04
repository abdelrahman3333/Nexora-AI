/**
 * Nexora AI Dashboard - Frontend Application
 */

const state = {
  user: null,
  csrfToken: null,
  business: null,
  bot: null,
  usage: null,
  dailyUsage: [],
  modelUsage: [],
  activeTab: 'overview',
  isLoading: false,
};

// --- API Client ---
async function apiCall(endpoint, { method = 'GET', body = null } = {}) {
  const headers = {};
  if (body) {
    headers['Content-Type'] = 'application/json';
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase()) && state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }

  const res = await fetch(endpoint, {
    method,
    headers,
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : null,
  });

  if (res.status === 401) {
    state.user = null;
    state.csrfToken = null;
    throw new Error('UNAUTHORIZED');
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errorMsg = data.message || data.error || 'حدث خطأ أثناء معالجة الطلب';
    throw new Error(errorMsg);
  }

  return data;
}

// --- App Initialization ---
async function initApp() {
  const app = document.getElementById('app');
  if (!app) {
    console.error('Root element #app not found');
    return;
  }

  try {
    const authData = await apiCall('/api/auth/me');
    if (!authData || !authData.user) {
      renderAuth();
      return;
    }
    state.user = authData.user;
    state.csrfToken = authData.csrfToken;
    if (state.user.role === 'business_owner') {
      await loadBusinessData();
    }
    renderDashboard();
  } catch (err) {
    // If not authenticated or on any initialization failure, safely show auth screen
    state.user = null;
    state.csrfToken = null;
    renderAuth();
  }
}

async function loadUsageData() {
  try {
    const [usageRes, dailyRes, modelsRes] = await Promise.all([
      apiCall('/api/my-business/usage').catch(() => ({ summary: null })),
      apiCall('/api/my-business/usage/daily').catch(() => ({ daily: [] })),
      apiCall('/api/my-business/usage/models').catch(() => ({ models: [] })),
    ]);
    state.usage = usageRes.summary;
    state.dailyUsage = dailyRes.daily || [];
    state.modelUsage = modelsRes.models || [];
  } catch (err) {
    console.error('Failed to load usage data', err);
  }
}

async function loadBusinessData() {
  try {
    const [bizData, botData] = await Promise.all([
      apiCall('/api/my-business'),
      apiCall('/api/my-business/bot').catch(() => ({ bot: null })),
      loadUsageData(),
    ]);
    state.business = bizData.business;
    state.bot = botData.bot;
  } catch (err) {
    showAlert(err.message, 'danger');
  }
}

// --- Security: Safe HTML Entity Escaping (Prevents Stored & DOM XSS) ---
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Alerts ---
function showAlert(message, type = 'danger') {
  const container = document.getElementById('alert-container');
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${escapeHtml(type)}">${escapeHtml(message)}</div>`;
  setTimeout(() => {
    container.innerHTML = '';
  }, 5000);
}

// --- Auth View ---
function renderAuth() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="auth-wrapper">
      <div class="auth-card">
        <div class="auth-header">
          <div class="auth-logo">
            <span>✨</span> Nexora AI
          </div>
          <h2 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.25rem;">تسجيل الدخول للمتجر</h2>
          <p class="auth-subtitle">لوحة تحكم صاحب العمل ومساعد المبيعات الذكي</p>
        </div>
        <div id="auth-alert"></div>
        <form id="login-form">
          <div class="form-group">
            <label for="login-email">البريد الإلكتروني</label>
            <input type="email" id="login-email" class="form-control" placeholder="owner@store.com" required dir="ltr">
          </div>
          <div class="form-group">
            <label for="login-password">كلمة المرور</label>
            <input type="password" id="login-password" class="form-control" placeholder="••••••••" required dir="ltr">
          </div>
          <button type="submit" id="login-btn" class="btn btn-primary" style="width: 100%; padding: 0.75rem; margin-top: 0.5rem;">
            تسجيل الدخول
          </button>
        </form>
      </div>
    </div>
  `;

  const loginForm = document.getElementById('login-form');
  if (!loginForm) return;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const alertBox = document.getElementById('auth-alert');
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> جاري التحقق...';
    alertBox.innerHTML = '';

    try {
      const data = await apiCall('/api/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      state.user = data.user;
      state.csrfToken = data.csrfToken;
      await loadBusinessData();
      renderDashboard();
    } catch (err) {
      alertBox.innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.innerText = 'تسجيل الدخول';
    }
  });
}

// --- Dashboard View ---
function renderDashboard() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="app-container">
      <!-- Sidebar -->
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-logo">
            <span>✨</span> Nexora AI
          </div>
          <button class="modal-close mobile-menu-btn" onclick="toggleSidebar()">✕</button>
        </div>
        <ul class="nav-links">
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'overview' ? 'active' : ''}" onclick="switchTab('overview')">
              <span>📊</span> نظرة عامة
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'products' ? 'active' : ''}" onclick="switchTab('products')">
              <span>📦</span> إدارة المنتجات
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'offers' ? 'active' : ''}" onclick="switchTab('offers')">
              <span>🏷️</span> العروض والباقات
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'settings' ? 'active' : ''}" onclick="switchTab('settings')">
              <span>⚙️</span> إعدادات المتجر
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'ai-settings' ? 'active' : ''}" onclick="switchTab('ai-settings')">
              <span>🤖</span> مساعد المبيعات الذكي
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'bot-settings' ? 'active' : ''}" onclick="switchTab('bot-settings')">
              <span>📱</span> إعدادات البوت
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'ai-usage' ? 'active' : ''}" onclick="switchTab('ai-usage')">
              <span>⚡</span> استهلاك الذكاء الاصطناعي
            </a>
          </li>
          <li class="nav-item">
            <a class="nav-link ${state.activeTab === 'conversations' ? 'active' : ''}" onclick="switchTab('conversations')">
              <span>💬</span> المحادثات
            </a>
          </li>
        </ul>
        <div class="sidebar-footer">
          <div class="user-badge">
            <div class="user-avatar">${escapeHtml((state.user.email || 'U')[0].toUpperCase())}</div>
            <div class="user-info">
              <div class="user-email" title="${escapeHtml(state.user.email)}">${escapeHtml(state.user.email)}</div>
              <div class="user-role">${state.user.role === 'business_owner' ? 'صاحب عمل' : 'مدير المنصة'}</div>
            </div>
          </div>
          <button class="btn btn-secondary btn-sm" style="width: 100%" onclick="handleLogout()">
            <span>🚪</span> تسجيل الخروج
          </button>
        </div>
      </aside>

      <!-- Main Content -->
      <main class="main-content">
        <header class="topbar">
          <div class="flex items-center gap-4">
            <button class="mobile-menu-btn" onclick="toggleSidebar()">☰</button>
            <h1 class="page-title" id="page-title">${getTabTitle(state.activeTab)}</h1>
          </div>
          <div class="flex items-center gap-2">
            <span class="badge ${state.bot?.status === 'active' ? 'badge-success' : 'badge-warning'}">
              ${state.bot?.status === 'active' ? '● البوت نشط' : '○ البوت غير نشط'}
            </span>
          </div>
        </header>

        <div class="page-container">
          <div id="alert-container"></div>
          <div id="tab-content">
            ${renderTabContent(state.activeTab)}
          </div>
        </div>
      </main>
    </div>
    <div id="modal-container"></div>
  `;
}

function getTabTitle(tab) {
  switch (tab) {
    case 'overview': return 'نظرة عامة على المتجر';
    case 'products': return 'إدارة المنتجات والأسعار';
    case 'offers': return 'العروض والباقات النشطة';
    case 'settings': return 'إعدادات وسياسات المتجر';
    case 'ai-settings': return 'تخصيص مساعد المبيعات الذكي';
    case 'ai-usage': return 'استهلاك الذكاء الاصطناعي والتكاليف التقديرية';
    case 'bot-settings': return 'حالة وتكامل بوت تيليجرام';
    case 'conversations': return 'سجل المحادثات المباشرة';
    default: return 'لوحة التحكم';
  }
}

async function switchTab(tab) {
  state.activeTab = tab;
  if (tab === 'ai-usage') {
    await loadUsageData();
  }
  renderDashboard();
}
window.switchTab = switchTab;

function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('open');
}

async function handleLogout() {
  try {
    await apiCall('/api/auth/logout', { method: 'POST' });
  } catch (err) {
    console.error(err);
  } finally {
    state.user = null;
    state.csrfToken = null;
    state.business = null;
    renderAuth();
  }
}

// --- Tab Renderers ---
function renderTabContent(tab) {
  switch (tab) {
    case 'overview': return renderOverviewTab();
    case 'products': return renderProductsTab();
    case 'offers': return renderOffersTab();
    case 'settings': return renderSettingsTab();
    case 'ai-settings': return renderAiSettingsTab();
    case 'ai-usage': return renderAiUsageTab();
    case 'bot-settings': return renderBotSettingsTab();
    case 'conversations': return renderConversationsTab();
    default: return '';
  }
}

// 1. Overview Tab
function renderOverviewTab() {
  const b = state.business || {};
  const products = b.products || [];
  const offers = b.offers || [];

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">🏪</div>
        <div class="stat-content">
          <div class="stat-label">المتجر</div>
          <div class="stat-value" style="font-size: 1.1rem">${escapeHtml(b.name || 'غير محدد')}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">📦</div>
        <div class="stat-content">
          <div class="stat-label">إجمالي المنتجات</div>
          <div class="stat-value">${products.length}</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🏷️</div>
        <div class="stat-content">
          <div class="stat-label">العروض والباقات</div>
          <div class="stat-value">${offers.length}</div>
        </div>
      </div>
      <div class="stat-card" style="cursor: pointer;" onclick="switchTab('ai-usage')">
        <div class="stat-icon">⚡</div>
        <div class="stat-content">
          <div class="stat-label">استهلاك الذكاء الاصطناعي</div>
          <div class="stat-value" style="font-size: 1.1rem; color: var(--accent);">
            ${state.usage ? `${escapeHtml(state.usage.totalRequests)} طلب` : 'عرض الاستهلاك ↗'}
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3 style="margin-bottom: 0.75rem; font-size: 1.1rem">معلومات سريعة عن متجرك</h3>
      <p style="color: var(--text-muted); font-size: 0.9rem; margin-bottom: 1rem;">
        ${escapeHtml(b.companyOverview?.descriptionAr || 'لا يوجد وصف للمتجر حالياً.')}
      </p>
      <div class="flex gap-4" style="flex-wrap: wrap;">
        <div><strong>العملة المعتمدة:</strong> ${escapeHtml(b.currency || 'SAR')}</div>
        <div><strong>الدولة:</strong> ${escapeHtml(b.country || 'SA')}</div>
        <div><strong>المجال:</strong> ${escapeHtml(b.industry || 'التجارة الإلكترونية')}</div>
        <div><strong>اللهجة المعتمدة:</strong> ${escapeHtml(b.dialect || 'saudi')}</div>
      </div>
    </div>
  `;
}

// 2. Products Tab
function renderProductsTab() {
  const products = state.business?.products || [];

  return `
    <div class="flex justify-between items-center" style="margin-bottom: 1.5rem;">
      <div>
        <h2 style="font-size: 1.1rem; font-weight: 600;">قائمة المنتجات الموثقة</h2>
        <p style="color: var(--text-muted); font-size: 0.85rem;">أي تغيير بالأسعار أو التوفر يتم تحديثه فوراً في ردود الذكاء الاصطناعي</p>
      </div>
      <button class="btn btn-primary" onclick="openProductModal()">
        <span>➕</span> إضافة منتج جديد
      </button>
    </div>

    ${products.length === 0 ? `
      <div class="card empty-state">
        <div class="empty-state-icon">📦</div>
        <h3>لا توجد منتجات مسجلة بعد</h3>
        <p>أضف أول منتج لمتجرك ليبدأ مساعد الذكاء الاصطناعي في بيعه للعملاء.</p>
        <button class="btn btn-primary" style="margin-top: 1rem;" onclick="openProductModal()">إضافة منتج</button>
      </div>
    ` : `
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>المعرف (ID)</th>
              <th>اسم المنتج</th>
              <th>السعر</th>
              <th>الحالة</th>
              <th>المميزات والفوائد</th>
              <th style="text-align: left;">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${products.map(p => `
              <tr>
                <td><code>${escapeHtml(p.id)}</code></td>
                <td>
                  <strong>${escapeHtml(p.nameAr)}</strong>
                  ${p.nameEn ? `<div style="font-size: 0.75rem; color: var(--text-dim);">${escapeHtml(p.nameEn)}</div>` : ''}
                </td>
                <td><strong>${escapeHtml(p.price)} ${escapeHtml(state.business?.currency || 'SAR')}</strong></td>
                <td>
                  <span class="badge ${p.inStock ? 'badge-success' : 'badge-danger'}">
                    ${p.inStock ? 'متوفر' : 'غير متوفر'}
                  </span>
                </td>
                <td style="max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(p.featuresAr || p.description || '-')}
                </td>
                <td style="text-align: left;">
                  <button class="btn btn-secondary btn-sm" onclick="editProduct('${escapeHtml(encodeURIComponent(p.id))}')">تعديل</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteProduct('${escapeHtml(encodeURIComponent(p.id))}')">حذف</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;
}

// 3. Offers Tab
function renderOffersTab() {
  const offers = state.business?.offers || [];

  return `
    <div class="flex justify-between items-center" style="margin-bottom: 1.5rem;">
      <div>
        <h2 style="font-size: 1.1rem; font-weight: 600;">العروض والباقات التسويقية</h2>
        <p style="color: var(--text-muted); font-size: 0.85rem;">يستخدمها المساعد لاقتراح التخفيضات وإغلاق المبيعات</p>
      </div>
      <button class="btn btn-primary" onclick="openOfferModal()">
        <span>➕</span> إضافة عرض جديد
      </button>
    </div>

    ${offers.length === 0 ? `
      <div class="card empty-state">
        <div class="empty-state-icon">🏷️</div>
        <h3>لا توجد عروض ترويجية نشطة</h3>
        <p>أنشئ عروض باقات أو خصومات ليقوم البوت بعرضها على العملاء لزيادة مبيعاتك.</p>
        <button class="btn btn-primary" style="margin-top: 1rem;" onclick="openOfferModal()">إنشاء عرض</button>
      </div>
    ` : `
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>المعرف</th>
              <th>عنوان العرض</th>
              <th>سعر العرض</th>
              <th>الحالة</th>
              <th>تفاصيل العرض</th>
              <th style="text-align: left;">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${offers.map(o => `
              <tr>
                <td><code>${escapeHtml(o.id)}</code></td>
                <td><strong>${escapeHtml(o.titleAr)}</strong></td>
                <td>${o.price !== undefined && o.price !== null ? `<strong>${escapeHtml(o.price)} ${escapeHtml(state.business?.currency || 'SAR')}</strong>` : 'حسب المنتج'}</td>
                <td>
                  <span class="badge ${o.isActive !== false ? 'badge-success' : 'badge-danger'}">
                    ${o.isActive !== false ? 'نشط' : 'معطل'}
                  </span>
                </td>
                <td style="max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                  ${escapeHtml(o.detailsAr)}
                </td>
                <td style="text-align: left;">
                  <button class="btn btn-secondary btn-sm" onclick="editOffer('${escapeHtml(encodeURIComponent(o.id))}')">تعديل</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteOffer('${escapeHtml(encodeURIComponent(o.id))}')">حذف</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `}
  `;
}

// 4. Settings Tab
function renderSettingsTab() {
  const b = state.business || {};
  return `
    <div class="card" style="max-width: 800px;">
      <h2 style="font-size: 1.15rem; font-weight: 600; margin-bottom: 1.5rem;">إعدادات وسياسات المتجر</h2>
      <form id="business-settings-form">
        <div class="form-row">
          <div class="form-group">
            <label>اسم المتجر</label>
            <input type="text" id="biz-name" class="form-control" value="${escapeHtml(b.name || '')}" required>
          </div>
          <div class="form-group">
            <label>مجال العمل</label>
            <input type="text" id="biz-industry" class="form-control" value="${escapeHtml(b.industry || '')}" required>
          </div>
        </div>

        <div class="form-group">
          <label>وصف المتجر ونبذة عنه</label>
          <textarea id="biz-desc" class="form-control" rows="3">${escapeHtml(b.companyOverview?.descriptionAr || '')}</textarea>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>العملة الرسمية</label>
            <select id="biz-currency" class="form-control">
              <option value="SAR" ${b.currency === 'SAR' ? 'selected' : ''}>ريال سعودي (SAR)</option>
              <option value="AED" ${b.currency === 'AED' ? 'selected' : ''}>درهم إماراتي (AED)</option>
              <option value="KWD" ${b.currency === 'KWD' ? 'selected' : ''}>دينار كويتي (KWD)</option>
              <option value="QAR" ${b.currency === 'QAR' ? 'selected' : ''}>ريال قطري (QAR)</option>
              <option value="BHD" ${b.currency === 'BHD' ? 'selected' : ''}>دينار بحريني (BHD)</option>
              <option value="OMR" ${b.currency === 'OMR' ? 'selected' : ''}>ريال عماني (OMR)</option>
            </select>
          </div>
          <div class="form-group">
            <label>الدولة</label>
            <select id="biz-country" class="form-control">
              <option value="SA" ${b.country === 'SA' ? 'selected' : ''}>السعودية (SA)</option>
              <option value="AE" ${b.country === 'AE' ? 'selected' : ''}>الإمارات (AE)</option>
              <option value="KW" ${b.country === 'KW' ? 'selected' : ''}>الكويت (KW)</option>
              <option value="QA" ${b.country === 'QA' ? 'selected' : ''}>قطر (QA)</option>
              <option value="BH" ${b.country === 'BH' ? 'selected' : ''}>البحرين (BH)</option>
              <option value="OM" ${b.country === 'OM' ? 'selected' : ''}>عمان (OM)</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label>سياسة الشحن والتوصيل الموثقة</label>
          <textarea id="biz-delivery" class="form-control" rows="2">${escapeHtml(b.deliveryPolicy?.detailsAr || b.shippingPolicy?.detailsAr || '')}</textarea>
        </div>

        <div class="form-group">
          <label>سياسة الاسترجاع والاستبدال</label>
          <textarea id="biz-return" class="form-control" rows="2">${escapeHtml(b.returnPolicy?.detailsAr || '')}</textarea>
        </div>

        <div class="form-group">
          <label>أوقات العمل</label>
          <input type="text" id="biz-hours" class="form-control" value="${escapeHtml(b.workingHours?.scheduleAr || '')}">
        </div>

        <button type="submit" id="save-settings-btn" class="btn btn-primary" style="margin-top: 1rem;">
          حفظ التغييرات
        </button>
      </form>
    </div>
  `;
}

// 5. AI Settings Tab
function renderAiSettingsTab() {
  const b = state.business || {};
  return `
    <div class="card" style="max-width: 800px;">
      <h2 style="font-size: 1.15rem; font-weight: 600; margin-bottom: 0.5rem;">تخصيص مساعد المبيعات الذكي (Gemini)</h2>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem;">
        اضبط أسلوب الحوار واللهجة التلقائية التي يستخدمها الذكاء الاصطناعي مع عملائك.
      </p>

      <form id="ai-settings-form">
        <div class="form-group">
          <label>اللهجة المفضلة للرد</label>
          <select id="ai-dialect" class="form-control">
            <option value="saudi" ${b.dialect === 'saudi' ? 'selected' : ''}>اللهجة السعودية الحديثة البيضاء (افتراضي)</option>
            <option value="uae" ${b.dialect === 'uae' ? 'selected' : ''}>اللهجة الإماراتية البيضاء</option>
            <option value="kuwaiti" ${b.dialect === 'kuwaiti' ? 'selected' : ''}>اللهجة الكويتية</option>
            <option value="qatari" ${b.dialect === 'qatari' ? 'selected' : ''}>اللهجة القطرية</option>
            <option value="bahraini" ${b.dialect === 'bahraini' ? 'selected' : ''}>اللهجة البحرينية</option>
            <option value="omani" ${b.dialect === 'omani' ? 'selected' : ''}>اللهجة العمانية</option>
            <option value="gulf_general" ${b.dialect === 'gulf_general' ? 'selected' : ''}>اللهجة الخليجية العامة</option>
            <option value="msa" ${b.dialect === 'msa' ? 'selected' : ''}>اللغة العربية الفصحى المعاصرة</option>
          </select>
        </div>

        <div class="form-group">
          <label>نبرة وأسلوب المحادثة (Tone)</label>
          <select id="ai-tone" class="form-control">
            <option value="polite_professional_gulf" ${b.tone === 'polite_professional_gulf' ? 'selected' : ''}>
              مهذب، احترافي، وودود (أسلوب خدمة عملاء ومبيعات طبيعي)
            </option>
            <option value="friendly_gulf" ${b.tone === 'friendly_gulf' ? 'selected' : ''}>
              عفوي، دافئ، وترحيبي جداً (مثل دردشة واتساب حية)
            </option>
            <option value="formal_gulf" ${b.tone === 'formal_gulf' ? 'selected' : ''}>
              رسمي ومباشر (Corporate / Executive)
            </option>
          </select>
        </div>

        <div class="form-group">
          <label>تفضيل لغة العميل</label>
          <select id="ai-lang" class="form-control">
            <option value="auto" ${b.languagePreference === 'auto' ? 'selected' : ''}>اكتشاف تلقائي (عربي أو إنجليزي بحسب رسالة العميل)</option>
            <option value="ar" ${b.languagePreference === 'ar' ? 'selected' : ''}>الرد بالعربية دائماً</option>
            <option value="en" ${b.languagePreference === 'en' ? 'selected' : ''}>الرد بالإنجليزية دائماً</option>
          </select>
        </div>

        <button type="submit" id="save-ai-btn" class="btn btn-primary" style="margin-top: 1rem;">
          حفظ إعدادات المساعد
        </button>
      </form>
    </div>
  `;
}

// 5b. AI Usage & Cost Estimation Tab
function renderAiUsageTab() {
  const u = state.usage;
  const models = state.modelUsage || [];
  const daily = state.dailyUsage || [];

  if (!u || u.totalRequests === 0) {
    return `
      <div class="card empty-state">
        <div class="empty-state-icon">⚡</div>
        <h3>لا يوجد استهلاك مسجل بعد</h3>
        <p>لم يقم بوت المتجر بإجراء أي استدعاءات لمساعد Gemini حتى الآن. فور بدء العملاء بالمحادثة، ستظهر إحصائيات التوكنات والتكاليف التقديرية هنا تلقائياً.</p>
      </div>
    `;
  }

  const costDisplay =
    u.estimatedCostUsd !== null && u.estimatedCostUsd !== undefined
      ? `$${u.estimatedCostUsd.toFixed(4)} USD`
      : 'غير متوفر';

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-icon">🔄</div>
        <div class="stat-content">
          <div class="stat-label">إجمالي الطلبات (Requests)</div>
          <div class="stat-value">${escapeHtml(u.totalRequests)}</div>
          <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">
            الناجحة: ${escapeHtml(u.successfulRequests)} | الفاشلة: ${escapeHtml(u.failedRequests)}
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">🪙</div>
        <div class="stat-content">
          <div class="stat-label">إجمالي التوكنات (Tokens)</div>
          <div class="stat-value">${escapeHtml(Number(u.totalTokens || 0).toLocaleString('en-US'))}</div>
          <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">
            المدخلات: ${escapeHtml(Number(u.totalPromptTokens || 0).toLocaleString('en-US'))} | المخرجات: ${escapeHtml(Number(u.totalOutputTokens || 0).toLocaleString('en-US'))}
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">💵</div>
        <div class="stat-content">
          <div class="stat-label">التكلفة التقديرية (Estimated)</div>
          <div class="stat-value" style="color: var(--accent);">${escapeHtml(costDisplay)}</div>
          <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">
            تقديري بحسب تسعيرة المليون توكن
          </div>
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-icon">⚠️</div>
        <div class="stat-content">
          <div class="stat-label">أخطاء الضغط (429 Rate Limit)</div>
          <div class="stat-value" style="color: ${u.rateLimit429Errors > 0 ? '#ef4444' : 'var(--text-primary)'};">
            ${escapeHtml(u.rateLimit429Errors)}
          </div>
          <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">
            استفسارات فريدة: ${escapeHtml(u.uniqueCustomerRequests)}
          </div>
        </div>
      </div>
    </div>

    <!-- Alert / Pricing Disclaimer -->
    <div class="alert alert-info" style="margin-bottom: 1.5rem; font-size: 0.85rem; line-height: 1.5;">
      ℹ️ <strong>تنويه التكلفة التقديرية:</strong> تُحسب التكاليف التقديرية حصرياً بناءً على التسعيرة الرسمية الموثقة لـ Google AI Developer API (إصدار ${escapeHtml(u.pricingVersion || '2025')}). الفاتورة الشهرية النهائية تخضع لأسعار Google Cloud المعتمدة لحسابك.
    </div>

    <!-- Model Usage Table -->
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3 style="font-size: 1.05rem; font-weight: 600; margin-bottom: 1rem;">الاستهلاك بحسب الموديل (Usage by Model)</h3>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>الموديل</th>
              <th>إجمالي الطلبات</th>
              <th>الناجحة / الفاشلة</th>
              <th>توكنات المدخلات</th>
              <th>توكنات المخرجات</th>
              <th>إجمالي التوكنات</th>
              <th>التكلفة التقديرية</th>
            </tr>
          </thead>
          <tbody>
            ${models.map(m => `
              <tr>
                <td><code>${escapeHtml(m.model)}</code></td>
                <td><strong>${escapeHtml(m.totalRequests)}</strong></td>
                <td>${escapeHtml(m.successfulRequests)} / ${escapeHtml(m.failedRequests)}</td>
                <td>${escapeHtml(Number(m.promptTokens || 0).toLocaleString('en-US'))}</td>
                <td>${escapeHtml(Number(m.outputTokens || 0).toLocaleString('en-US'))}</td>
                <td><strong>${escapeHtml(Number(m.totalTokens || 0).toLocaleString('en-US'))}</strong></td>
                <td>
                  ${m.pricingUnavailable
                    ? '<span class="badge badge-warning">التسعيرة غير متوفرة</span>'
                    : `<strong>$${escapeHtml(m.estimatedCostUsd !== null ? m.estimatedCostUsd.toFixed(4) : '0.0000')} USD</strong>`
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Daily Usage Table -->
    <div class="card">
      <h3 style="font-size: 1.05rem; font-weight: 600; margin-bottom: 1rem;">الاستهلاك اليومي (Daily Usage)</h3>
      ${daily.length === 0 ? `
        <p style="color: var(--text-muted); font-size: 0.9rem;">لا توجد سجلات يومية كافية للعرض.</p>
      ` : `
        <div class="table-responsive">
          <table class="table">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th>إجمالي الطلبات</th>
                <th>الطلبات الناجحة</th>
                <th>الطلبات الفاشلة</th>
                <th>توكنات المدخلات</th>
                <th>توكنات المخرجات</th>
                <th>إجمالي التوكنات</th>
              </tr>
            </thead>
            <tbody>
              ${daily.map(d => `
                <tr>
                  <td><code>${escapeHtml(d.date)}</code></td>
                  <td><strong>${escapeHtml(d.totalRequests)}</strong></td>
                  <td>${escapeHtml(d.successfulRequests)}</td>
                  <td>${escapeHtml(d.failedRequests)}</td>
                  <td>${escapeHtml(Number(d.promptTokens || 0).toLocaleString('en-US'))}</td>
                  <td>${escapeHtml(Number(d.outputTokens || 0).toLocaleString('en-US'))}</td>
                  <td><strong>${escapeHtml(Number(d.totalTokens || 0).toLocaleString('en-US'))}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      `}
    </div>
  `;
}

// 6. Bot Settings Tab
function renderBotSettingsTab() {
  const bot = state.bot;
  return `
    <div class="card" style="max-width: 700px;">
      <h2 style="font-size: 1.15rem; font-weight: 600; margin-bottom: 1rem;">إعدادات وتكامل بوت تيليجرام</h2>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem;">
        يتم إدارة وتخصيص البوتات المركزية من قِبل إدارة المنصة مع حماية تامة للتوكنات والبيانات السرية.
      </p>

      ${bot ? `
        <div style="background-color: var(--bg-primary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 1.25rem; margin-bottom: 1.5rem;">
          <div class="flex justify-between items-center" style="margin-bottom: 0.75rem;">
            <div>
              <div style="font-size: 0.8rem; color: var(--text-muted);">البوت المرتبط بمتجرك</div>
              <div style="font-size: 1.2rem; font-weight: 600; color: var(--accent);">
                @${escapeHtml(bot.bot_username)}
              </div>
            </div>
            <span class="badge ${bot.status === 'active' ? 'badge-success' : 'badge-warning'}">
              ${bot.status === 'active' ? '● متصل ونشط' : '○ غير نشط'}
            </span>
          </div>

          <div style="font-size: 0.85rem; color: var(--text-muted);">
            <div><strong>معرف البوت بالمنصة:</strong> <code>${escapeHtml(bot.bot_id)}</code></div>
            <div><strong>حالة مفتاح التوكن:</strong> ${bot.hasTokenConfigured ? 'محمي ومكوّن بأمان في الخادم' : 'غير مكتمل'}</div>
          </div>
        </div>

        <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
          🔒 <strong>أمان المنصة:</strong> يتم حجب التوكنات السرية ولا يمكن لأي متجر الاطلاع على مفاتيح أو بوتات المتاجر الأخرى. لتعديل البوت أو ربط بوت جديد يرجى التواصل مع إدارة منصة Nexora AI.
        </div>
      ` : `
        <div class="empty-state">
          <div class="empty-state-icon">📱</div>
          <h3>لا يوجد بوت مرتبط حالياً بهذا المتجر</h3>
          <p>تواصل مع مدير منصة Nexora AI لربط حساب البوت الخاص بمتجرك.</p>
        </div>
      `}
    </div>
  `;
}

// 7. Conversations Tab (Placeholder compliant with requirements)
function renderConversationsTab() {
  return `
    <div class="card" style="max-width: 800px;">
      <h2 style="font-size: 1.15rem; font-weight: 600; margin-bottom: 0.5rem;">سجل المحادثات المباشرة</h2>
      <p style="color: var(--text-muted); font-size: 0.85rem; margin-bottom: 1.5rem;">
        يتم إدارة جلسات المحادثات النشطة وحفظها في الذاكرة المعزولة لكل عميل وبوت.
      </p>

      <div class="empty-state">
        <div class="empty-state-icon">💬</div>
        <h3>ميزة عرض سجل المحادثات السحابي</h3>
        <p style="max-width: 500px; margin: 0 auto; line-height: 1.6;">
          المحادثات مخزنة حالياً في الذاكرة المؤقتة (In-Memory Isolation). ستتوفر واجهة تصفح واسترجاع المحادثات السحابية المؤرشفة في التحديث القادم بعد ربطها مع قاعدة البيانات المركزية.
        </p>
      </div>
    </div>
  `;
}

// --- Event Handlers & Forms Binding ---
document.addEventListener('submit', async (e) => {
  // Save Business Settings
  if (e.target && e.target.id === 'business-settings-form') {
    e.preventDefault();
    const btn = document.getElementById('save-settings-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> جاري الحفظ...';

    const payload = {
      name: document.getElementById('biz-name').value.trim(),
      industry: document.getElementById('biz-industry').value.trim(),
      companyOverview: {
        descriptionAr: document.getElementById('biz-desc').value.trim(),
      },
      currency: document.getElementById('biz-currency').value,
      country: document.getElementById('biz-country').value,
      deliveryPolicy: {
        detailsAr: document.getElementById('biz-delivery').value.trim(),
      },
      returnPolicy: {
        detailsAr: document.getElementById('biz-return').value.trim(),
      },
      workingHours: {
        scheduleAr: document.getElementById('biz-hours').value.trim(),
      },
    };

    try {
      const res = await apiCall('/api/my-business', { method: 'PUT', body: payload });
      state.business = res.business;
      showAlert('تم تحديث إعدادات وسياسات المتجر بنجاح!', 'success');
    } catch (err) {
      showAlert(err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerText = 'حفظ التغييرات';
    }
  }

  // Save AI Settings
  if (e.target && e.target.id === 'ai-settings-form') {
    e.preventDefault();
    const btn = document.getElementById('save-ai-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> جاري الحفظ...';

    const payload = {
      dialect: document.getElementById('ai-dialect').value,
      tone: document.getElementById('ai-tone').value,
      languagePreference: document.getElementById('ai-lang').value,
    };

    try {
      const res = await apiCall('/api/my-business', { method: 'PUT', body: payload });
      state.business = res.business;
      showAlert('تم تحديث إعدادات مساعد المبيعات الذكي فوراً!', 'success');
    } catch (err) {
      showAlert(err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.innerText = 'حفظ إعدادات المساعد';
    }
  }
});

// --- Product Modal & CRUD ---
window.openProductModal = function (product = null) {
  const isEdit = Boolean(product);
  const container = document.getElementById('modal-container');
  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${isEdit ? 'تعديل المنتج' : 'إضافة منتج جديد'}</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="product-form">
          <div class="modal-body">
            <div id="modal-alert"></div>
            <div class="form-group">
              <label>معرف المنتج (ID فريد)</label>
              <input type="text" id="prod-id" class="form-control" value="${escapeHtml(product?.id || '')}" ${isEdit ? 'readonly style="opacity: 0.6"' : 'required'} placeholder="e.g. PRD-05">
            </div>
            <div class="form-group">
              <label>اسم المنتج (بالعربية)</label>
              <input type="text" id="prod-name-ar" class="form-control" value="${escapeHtml(product?.nameAr || '')}" required placeholder="مثال: مطحنة قهوة يدوية">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>السعر (${escapeHtml(state.business?.currency || 'SAR')})</label>
                <input type="number" id="prod-price" class="form-control" step="any" min="0" value="${escapeHtml(product?.price ?? '')}" required>
              </div>
              <div class="form-group">
                <label>حالة التوفر</label>
                <select id="prod-stock" class="form-control">
                  <option value="true" ${product?.inStock !== false ? 'selected' : ''}>متوفر بالمخزون</option>
                  <option value="false" ${product?.inStock === false ? 'selected' : ''}>غير متوفر حالياً</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>المميزات والفوائد (تساعد الذكاء الاصطناعي في ترشيحه للعميل)</label>
              <textarea id="prod-features" class="form-control" rows="2" placeholder="تروس ستانلس ستيل، بطارية أسبوعين...">${escapeHtml(product?.featuresAr || '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button type="submit" id="prod-submit-btn" class="btn btn-primary">${isEdit ? 'حفظ التعديلات' : 'إضافة المنتج'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('product-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('prod-submit-btn');
    btn.disabled = true;

    const payload = {
      id: document.getElementById('prod-id').value.trim(),
      nameAr: document.getElementById('prod-name-ar').value.trim(),
      price: parseFloat(document.getElementById('prod-price').value),
      inStock: document.getElementById('prod-stock').value === 'true',
      featuresAr: document.getElementById('prod-features').value.trim(),
    };

    try {
      if (isEdit) {
        await apiCall(`/api/my-business/products/${encodeURIComponent(product.id)}`, {
          method: 'PUT',
          body: payload,
        });
      } else {
        await apiCall('/api/my-business/products', {
          method: 'POST',
          body: payload,
        });
      }
      await loadBusinessData();
      closeModal();
      switchTab('products');
      showAlert('تم تحديث قائمة المنتجات بنجاح!', 'success');
    } catch (err) {
      document.getElementById('modal-alert').innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
};

window.editProduct = function (id) {
  const cleanId = decodeURIComponent(id);
  const prod = state.business?.products?.find(p => p.id === cleanId || p.id === id);
  if (prod) openProductModal(prod);
};

window.deleteProduct = async function (id) {
  const cleanId = decodeURIComponent(id);
  if (!confirm(`هل أنت متأكد من حذف المنتج "${cleanId}"؟`)) return;
  try {
    await apiCall(`/api/my-business/products/${encodeURIComponent(cleanId)}`, { method: 'DELETE' });
    await loadBusinessData();
    switchTab('products');
    showAlert('تم حذف المنتج بنجاح', 'success');
  } catch (err) {
    showAlert(err.message, 'danger');
  }
};

// --- Offers Modal & CRUD ---
window.openOfferModal = function (offer = null) {
  const isEdit = Boolean(offer);
  const container = document.getElementById('modal-container');
  container.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <div class="modal-title">${isEdit ? 'تعديل العرض' : 'إنشاء عرض جديد'}</div>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <form id="offer-form">
          <div class="modal-body">
            <div id="modal-alert"></div>
            <div class="form-group">
              <label>معرف العرض (ID فريد)</label>
              <input type="text" id="offer-id" class="form-control" value="${escapeHtml(offer?.id || '')}" ${isEdit ? 'readonly style="opacity: 0.6"' : 'required'} placeholder="e.g. OFF-01">
            </div>
            <div class="form-group">
              <label>عنوان العرض</label>
              <input type="text" id="offer-title" class="form-control" value="${escapeHtml(offer?.titleAr || '')}" required placeholder="مثال: باقة التوفير الصيفية">
            </div>
            <div class="form-row">
              <div class="form-group">
                <label>سعر العرض (${escapeHtml(state.business?.currency || 'SAR')})</label>
                <input type="number" id="offer-price" class="form-control" step="any" min="0" value="${escapeHtml(offer?.price ?? '')}">
              </div>
              <div class="form-group">
                <label>الحالة</label>
                <select id="offer-status" class="form-control">
                  <option value="true" ${offer?.isActive !== false ? 'selected' : ''}>نشط</option>
                  <option value="false" ${offer?.isActive === false ? 'selected' : ''}>معطل</option>
                </select>
              </div>
            </div>
            <div class="form-group">
              <label>تفاصيل ومميزات العرض</label>
              <textarea id="offer-details" class="form-control" rows="2" required placeholder="وفر 50 ريال عند شراء باقة...">${escapeHtml(offer?.detailsAr || '')}</textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
            <button type="submit" id="offer-submit-btn" class="btn btn-primary">${isEdit ? 'حفظ العرض' : 'إنشاء العرض'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('offer-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('offer-submit-btn');
    btn.disabled = true;

    const priceVal = document.getElementById('offer-price').value;
    const payload = {
      id: document.getElementById('offer-id').value.trim(),
      titleAr: document.getElementById('offer-title').value.trim(),
      price: priceVal !== '' ? parseFloat(priceVal) : undefined,
      isActive: document.getElementById('offer-status').value === 'true',
      detailsAr: document.getElementById('offer-details').value.trim(),
    };

    try {
      if (isEdit) {
        await apiCall(`/api/my-business/offers/${encodeURIComponent(offer.id)}`, {
          method: 'PUT',
          body: payload,
        });
      } else {
        await apiCall('/api/my-business/offers', {
          method: 'POST',
          body: payload,
        });
      }
      await loadBusinessData();
      closeModal();
      switchTab('offers');
      showAlert('تم تحديث العروض بنجاح!', 'success');
    } catch (err) {
      document.getElementById('modal-alert').innerHTML = `<div class="alert alert-danger">${escapeHtml(err.message)}</div>`;
      btn.disabled = false;
    }
  });
};

window.editOffer = function (id) {
  const cleanId = decodeURIComponent(id);
  const offer = state.business?.offers?.find(o => o.id === cleanId || o.id === id);
  if (offer) openOfferModal(offer);
};

window.deleteOffer = async function (id) {
  const cleanId = decodeURIComponent(id);
  if (!confirm(`هل أنت متأكد من حذف العرض "${cleanId}"؟`)) return;
  try {
    await apiCall(`/api/my-business/offers/${encodeURIComponent(cleanId)}`, { method: 'DELETE' });
    await loadBusinessData();
    switchTab('offers');
    showAlert('تم حذف العرض بنجاح', 'success');
  } catch (err) {
    showAlert(err.message, 'danger');
  }
};

window.closeModal = function () {
  const container = document.getElementById('modal-container');
  if (container) container.innerHTML = '';
};

// Start application when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}


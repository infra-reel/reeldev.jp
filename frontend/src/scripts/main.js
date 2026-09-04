/* =====================================================
   reeldev.jp — main.js
   Ocean dive: スクロール深度・バブル・ナビ・データ取得
===================================================== */

// ---------- NAV: Hamburger (右スライド) ----------
const hamburger  = document.getElementById('hamburger');
const navLinks   = document.getElementById('navLinks');
const navOverlay = document.getElementById('navOverlay');

function openMenu() {
  navLinks.classList.add('open');
  navOverlay.classList.add('open');
  hamburger.classList.add('open');
  hamburger.setAttribute('aria-expanded', 'true');
  document.body.style.overflow = 'hidden';
}
function closeMenu() {
  navLinks.classList.remove('open');
  navOverlay.classList.remove('open');
  hamburger.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  document.body.style.overflow = '';
}
hamburger.addEventListener('click', () =>
  navLinks.classList.contains('open') ? closeMenu() : openMenu()
);
navOverlay.addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

// ---------- BUBBLES ----------
const bubblesEl = document.getElementById('bubbles');
if (bubblesEl) {
  const N = 28;
  for (let i = 0; i < N; i++) {
    const b = document.createElement('div');
    b.className = 'bubble';
    const size = 4 + Math.random() * 18;
    b.style.cssText = `
      width:${size}px; height:${size}px;
      left:${Math.random() * 100}%;
      bottom:-${size}px;
      animation-duration:${6 + Math.random() * 12}s;
      animation-delay:-${Math.random() * 14}s;
      opacity:${.1 + Math.random() * .3};
    `;
    bubblesEl.appendChild(b);
  }
}

// ---------- DEPTH INDICATOR ----------
const depthFill  = document.getElementById('depthFill');
const depthLabel = document.querySelector('.depth-label');
const MAX_DEPTH  = 3000; // meters (dramatic)

function updateDepth() {
  const scrolled  = window.scrollY;
  const docH      = document.documentElement.scrollHeight - window.innerHeight;
  const pct       = Math.min(1, scrolled / (docH || 1));
  const meters    = Math.round(pct * MAX_DEPTH);
  if (depthFill)  depthFill.style.height = `${pct * 100}%`;
  if (depthLabel) depthLabel.textContent = `${meters}m`;
}

// ---------- SECTION REVEAL ----------
const sections = document.querySelectorAll('.section');
const io = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) e.target.classList.add('in-view');
  });
}, { threshold: .12 });
sections.forEach(s => io.observe(s));

// ---------- SCROLL ----------
window.addEventListener('scroll', updateDepth, { passive: true });
updateDepth();

// ---------- NEWS DATA ----------
async function loadNews() {
  const grid = document.getElementById('newsGrid');
  if (!grid) return;
  try {
    const res  = await fetch('/api/news?limit=3');
    const data = await res.json();
    grid.innerHTML = '';
    if (!data.items?.length) {
      grid.innerHTML = '<p style="color:var(--c-text-dim);font-size:.85rem">お知らせはまだありません。</p>';
      return;
    }
    data.items.forEach(item => {
      const card = document.createElement('a');
      card.className = 'news-card';
      card.href = `/news/${item.id}`;
      card.innerHTML = `
        ${item.image ? `<img class="news-img" src="${item.image}" alt="${item.title}" loading="lazy" />` : ''}
        <p class="news-date">${new Date(item.createdAt).toLocaleDateString('ja-JP')}</p>
        <h3 class="news-title">${item.title}</h3>
      `;
      grid.appendChild(card);
    });
  } catch {
    grid.innerHTML = '<p style="color:var(--c-text-dim);font-size:.85rem">読み込みに失敗しました。</p>';
  }
}

// ---------- SNS DATA ----------
const SNS_LINKS = [
  { icon: '𝕏', label: 'X (Twitter)', url: 'https://x.com/riel_hosiduki' },
  { icon: '⬛', label: 'GitHub',      url: 'https://github.com/riel-hosiduki' },
  { icon: '🔷', label: 'Qiita',       url: 'https://qiita.com/riel_hosiduki' },
];
function loadSNS() {
  const list = document.getElementById('snsList');
  if (!list) return;
  // Try API first (admin-managed), fallback to static
  fetch('/api/links?type=sns').then(r => r.json()).then(data => {
    const items = data.items?.length ? data.items : SNS_LINKS;
    renderSNS(list, items);
  }).catch(() => renderSNS(list, SNS_LINKS));
}
function renderSNS(container, items) {
  container.innerHTML = '';
  items.forEach(item => {
    const a = document.createElement('a');
    a.className = 'sns-item';
    a.href = item.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = `<span class="sns-icon">${item.icon || '🔗'}</span><span>${item.label}</span>`;
    container.appendChild(a);
  });
}

// ---------- INIT ----------
loadNews();
loadSNS();

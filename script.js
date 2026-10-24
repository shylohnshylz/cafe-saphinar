/* ==========================================================================
   CAFE SAPHINAR — script.js
   --------------------------------------------------------------------------
   1. CONFIG          — paste your Apps Script Web App URL here
   2. Utilities
   3. API             — talks to Google Sheets (JSONP), or a local demo store
   4. Steam canvas
   5. Menu + cart
   6. Reservations    — hour-by-hour booking
   7. Admin console   — login, timetable, orders, menu manager
   ========================================================================== */

(() => {
  'use strict';

  /* =======================================================================
     1. CONFIG
     ======================================================================= */

  const CONFIG = {
    /* ─────────────────────────────────────────────────────────────────────
       ⚠️  PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL BETWEEN THE QUOTES.
       It looks like:  https://script.google.com/macros/s/AKfycb..../exec
       Until you do, the whole site runs in DEMO MODE: everything works and
       is saved in this browser only, with no Google account needed.
       Walkthrough: README.md → Part 3.
       ───────────────────────────────────────────────────────────────────── */
    API_URL: 'https://script.google.com/macros/s/AKfycbxJSgdyYe_INvrKLTznA0A2DeRhsH-zdSaINqDyiSREDRqsbKvZUejzHwLuf1VFMfTE/exec',

    CURRENCY: '₹',
    OPEN_HOUR: 11,          // matches Code.gs
    CLOSE_HOUR: 22,
    BOOKING_DAYS_AHEAD: 60,
    ADMIN_ROUTE: '#admin',

    ORDER_TIMEOUT: 20000,
    READ_TIMEOUT: 15000
  };

  const PLACEHOLDER = /PASTE_YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE/;
  const DEMO = PLACEHOLDER.test(CONFIG.API_URL);
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  /* =======================================================================
     2. UTILITIES
     ======================================================================= */

  const money = (n) => CONFIG.CURRENCY + Number(n || 0).toLocaleString('en-IN');
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const pad = (n) => String(n).padStart(2, '0');
  const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const addDays = (iso, n) => {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const prettyDate = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso || '');
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };
  const prettyTime = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    const suffix = h >= 12 ? 'pm' : 'am';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}${m ? ':' + pad(m) : ''} ${suffix}`;
  };
  const slotList = () => {
    const out = [];
    for (let h = CONFIG.OPEN_HOUR; h < CONFIG.CLOSE_HOUR; h++) out.push(`${pad(h)}:00`);
    return out;
  };

  function toast(message, kind = 'success', ms = 4200) {
    const host = $('#toasts');
    if (!host) return;
    // Keep the stack short so nothing piles up over the page.
    while (host.children.length >= 3) host.removeChild(host.firstElementChild);

    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.innerHTML = `<span class="toast__dot" aria-hidden="true"></span><span>${escapeHtml(message)}</span>`;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  function setStatus(el, message, kind = '') {
    if (!el) return;
    el.className = `form__status is-visible${kind ? ' is-' + kind : ''}`;
    el.innerHTML = message;
  }
  function clearStatus(el) {
    if (!el) return;
    el.className = 'form__status';
    el.innerHTML = '';
  }

  function markInvalid(input, message) {
    const wrap = input.closest('.field');
    if (wrap) wrap.classList.add('is-invalid');
    const slot = wrap && wrap.querySelector('.field__error');
    if (slot) slot.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    return input;
  }
  function markValid(input) {
    const wrap = input.closest('.field');
    if (wrap) wrap.classList.remove('is-invalid');
    const slot = wrap && wrap.querySelector('.field__error');
    if (slot) slot.textContent = '';
    input.removeAttribute('aria-invalid');
  }
  const nameError = (v) => (String(v).trim().length < 2 ? 'Please add a name.' : '');
  const phoneError = (v) => {
    const d = digits(v);
    if (!String(v).trim()) return 'Please add a phone number.';
    if (!/^[+\d][\d\s().-]{5,23}$/.test(String(v).trim())) return 'That number looks incomplete.';
    if (d.length < 7 || d.length > 15) return 'Please add a valid phone number.';
    return '';
  };

  function busy(btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-loading', on);
    btn.disabled = on;
  }

  /* =======================================================================
     3. API

     Two transports, in this order:

       JSONP  — a <script> tag with ?callback=… . Apps Script answers through a
                redirect that browsers cannot always read cross-origin, so this
                is the transport that works every time, from every browser.
                Every action (reads AND writes) can travel this way.
       POST   — form-urlencoded, tried if JSONP fails. Works wherever CORS is
                allowed and keeps the data out of the URL.

     With no API_URL set, a local demo store takes over so the entire site —
     including the admin console — is fully clickable before Google is wired.
     ======================================================================= */

  let cbSeq = 0;

  function jsonp(action, params, timeout) {
    return new Promise((resolve, reject) => {
      const cb = `__saphinar_cb_${Date.now().toString(36)}_${++cbSeq}`;
      let done = false;

      const script = document.createElement('script');
      const cleanup = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[cb]; } catch (_) { window[cb] = undefined; }
        script.remove();
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('timeout'));
      }, timeout);

      window[cb] = (data) => {
        cleanup();
        if (data && data.result === 'error') {
          const err = new Error(data.message || 'Request failed.');
          err.payload = data;
          reject(err);
        } else {
          resolve(data);
        }
      };

      const url = new URL(CONFIG.API_URL);
      url.searchParams.set('action', action);
      url.searchParams.set('callback', cb);
      Object.keys(params || {}).forEach((k) => {
        const v = params[k];
        if (v === undefined || v === null || v === '') return;
        url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      });

      script.async = true;
      script.src = url.toString();
      script.onerror = () => {
        cleanup();
        reject(new Error('network'));
      };
      document.head.appendChild(script);
    });
  }

  async function httpPost(action, params, timeout) {
    const body = new URLSearchParams();
    body.set('action', action);
    Object.keys(params || {}).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const res = await fetch(CONFIG.API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
        signal: ctrl ? ctrl.signal : undefined,
        redirect: 'follow'
      });
      const text = await res.text();
      const data = JSON.parse(text);
      if (data && data.result === 'error') {
        const err = new Error(data.message || 'Request failed.');
        err.payload = data;
        throw err;
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const API = {
    live: !DEMO,
    async call(action, params = {}, kind = 'read') {
      if (DEMO) return Mock.call(action, params);
      const timeout = kind === 'write' ? CONFIG.ORDER_TIMEOUT : CONFIG.READ_TIMEOUT;
      try {
        return await jsonp(action, params, timeout);
      } catch (first) {
        // A JSONP *error* message is a real answer — don't retry those.
        if (first && first.payload) throw first;
        try {
          return await httpPost(action, params, timeout);
        } catch (second) {
          // Real answers from the server keep their own message; only genuine
          // transport failures get the friendly wording.
          if (second && second.payload) throw second;
          const timedOut = (first && first.message === 'timeout') ||
            /abort|timeout/i.test(String((second && second.message) || ''));
          throw new Error(timedOut
            ? 'The café server is taking too long to answer. Please try again.'
            : 'Can’t reach the café server right now. Check your connection and try again.');
        }
      }
    }
  };

  /* ---------------------------------------------------------- demo store */

  const SAMPLE_MENU = [
    { id: "ESP", name: "Espresso", category: "Coffee", price: 120, desc: "Double shot, thick crema, no fuss.", available: true },
    { id: "AME", name: "Americano", category: "Coffee", price: 150, desc: "Long black, bright and clean.", available: true },
    { id: "CAP", name: "Cappuccino", category: "Coffee", price: 180, desc: "Silky microfoam, dusted with cocoa.", available: true },
    { id: "LAT", name: "Cafe Latte", category: "Coffee", price: 190, desc: "Gentle, milky, all-day drinkable.", available: true },
    { id: "MOC", name: "Cafe Mocha", category: "Coffee", price: 210, desc: "Dark chocolate, espresso, whipped cream.", available: true },
    { id: "FLT", name: "South Indian Filter Coffee", category: "Coffee", price: 90, desc: "Chicory-forward, served in a steel tumbler.", available: true },
    { id: "COL", name: "Cold Brew", category: "Coffee", price: 220, desc: "Eighteen-hour steep, over a single rock.", available: true },
    { id: "ICL", name: "Iced Latte", category: "Coffee", price: 200, desc: "Double shot, cold milk, no sugar rush.", available: true },
    { id: "CHA", name: "Masala Chai", category: "Tea & Chai", price: 80, desc: "Ginger, cardamom, clove, full-boiled milk.", available: true },
    { id: "GRN", name: "Green Tea", category: "Tea & Chai", price: 100, desc: "Sencha, light and grassy.", available: true },
    { id: "ERG", name: "Earl Grey", category: "Tea & Chai", price: 110, desc: "Bergamot, served with a lemon wheel.", available: true },
    { id: "LEM", name: "Iced Lemon Tea", category: "Tea & Chai", price: 130, desc: "Black tea, lemon, a little honey.", available: true },
    { id: "POH", name: "Poha", category: "Breakfast", price: 140, desc: "Flattened rice, peanuts, curry leaf, lime.", available: true },
    { id: "UPM", name: "Rava Upma", category: "Breakfast", price: 130, desc: "Semolina, ghee, coconut chutney.", available: true },
    { id: "OMT", name: "Masala Omelette Toast", category: "Breakfast", price: 220, desc: "Three eggs, onion, chilli, sourdough.", available: true },
    { id: "PNC", name: "Buttermilk Pancakes", category: "Breakfast", price: 260, desc: "Maple butter, seasonal fruit.", available: true },
    { id: "AVT", name: "Avocado Toast", category: "Breakfast", price: 280, desc: "Sourdough, chilli oil, poached egg.", available: true },
    { id: "FRH", name: "French Toast", category: "Breakfast", price: 240, desc: "Brioche, cinnamon, honey.", available: true },
    { id: "GRC", name: "Grilled Cheese", category: "Sandwiches & Wraps", price: 200, desc: "Three cheeses, mustard butter, toasted.", available: true },
    { id: "VGC", name: "Veg Club Sandwich", category: "Sandwiches & Wraps", price: 240, desc: "Grilled veg, pesto, cheddar, triple stack.", available: true },
    { id: "CHW", name: "Chicken Club Sandwich", category: "Sandwiches & Wraps", price: 290, desc: "Roast chicken, bacon, tomato, aioli.", available: true },
    { id: "PNW", name: "Paneer Tikka Wrap", category: "Sandwiches & Wraps", price: 260, desc: "Charred paneer, mint chutney, onion.", available: true },
    { id: "ALF", name: "Alfredo Pasta", category: "Pasta & Pizza", price: 320, desc: "Fettuccine, parmesan, cracked pepper.", available: true },
    { id: "ARR", name: "Arrabbiata Pasta", category: "Pasta & Pizza", price: 300, desc: "Tomato, garlic, chilli, basil.", available: true },
    { id: "MGP", name: "Margherita Pizza", category: "Pasta & Pizza", price: 340, desc: "San Marzano, mozzarella, basil.", available: true },
    { id: "PPF", name: "Peri Peri Fries", category: "Pasta & Pizza", price: 180, desc: "Crisp fries, house peri peri dust.", available: true },
    { id: "BRW", name: "Chocolate Brownie", category: "Desserts", price: 180, desc: "Warm, fudgy, sea salt, vanilla scoop.", available: true },
    { id: "CHK", name: "New York Cheesecake", category: "Desserts", price: 260, desc: "Dense, tangy, biscuit base.", available: true },
    { id: "TIR", name: "Tiramisu", category: "Desserts", price: 280, desc: "Espresso-soaked savoiardi, mascarpone.", available: true },
    { id: "CRT", name: "Carrot Cake", category: "Desserts", price: 200, desc: "Walnut, cream cheese frosting.", available: true },
    { id: "GJC", name: "Gulab Jamun Cheesecake", category: "Desserts", price: 240, desc: "House fusion - rose, cardamom, pistachio.", available: true },
    { id: "LMS", name: "Fresh Lime Soda", category: "Coolers", price: 120, desc: "Sweet, salted, or mixed.", available: true },
    { id: "MOJ", name: "Virgin Mojito", category: "Coolers", price: 180, desc: "Lime, mint, soda, crushed ice.", available: true },
    { id: "HCH", name: "Hot Chocolate", category: "Coolers", price: 200, desc: "Seventy percent dark, steamed milk, marshmallow.", available: true },
    { id: "BNS", name: "Banana Smoothie", category: "Coolers", price: 220, desc: "Banana, honey, curd, cinnamon.", available: true }
  ];

  const Mock = {
    KEY: 'saphinar_demo_v1',
    DELAY: 240,

    read() {
      try {
        const raw = localStorage.getItem(this.KEY);
        if (raw) return JSON.parse(raw);
      } catch (_) { /* private mode — fall through */ }
      return { menu: SAMPLE_MENU.slice(), orders: [], reservations: [] };
    },
    write(state) {
      try { localStorage.setItem(this.KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
    },
    id(prefix) {
      return prefix + '-' + Date.now().toString(36).toUpperCase().slice(-4) +
        Math.random().toString(36).toUpperCase().slice(2, 5);
    },
    reservationsOn(state, date) {
      return state.reservations.filter((r) => r.date === date && r.status === 'Active');
    },

    async call(action, p) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      await wait(this.DELAY);
      const state = this.read();
      const fail = (message) => {
        const err = new Error(message);
        err.payload = { result: 'error', message };
        throw err;
      };

      switch (action) {
        case 'menu':
          return { result: 'success', items: state.menu.filter((i) => i.available), currency: CONFIG.CURRENCY, demo: true };

        case 'slots': {
          const taken = this.reservationsOn(state, p.date);
          return {
            result: 'success',
            date: p.date,
            slots: slotList().map((time) => {
              const count = taken.filter((r) => r.slot === time).length;
              return { time, available: count < 1, left: Math.max(0, 1 - count) };
            })
          };
        }

        case 'reserve':
        case 'adminReserve': {
          if (!p.name || digits(p.phone).length < 7) fail('Please add a name and a phone number.');
          const clash = this.reservationsOn(state, p.date).some((r) => r.slot === p.slot);
          if (clash) fail('That hour has just been booked. Please pick another.');
          const row = {
            timestamp: new Date().toISOString(),
            date: p.date,
            slot: p.slot,
            name: String(p.name).slice(0, 80),
            phone: String(p.phone).slice(0, 24),
            size: Number(p.size) || 2,
            notes: String(p.notes || '').slice(0, 300),
            status: 'Active',
            source: action === 'adminReserve' ? 'admin' : 'website',
            code: this.id('SAPH')
          };
          state.reservations.push(row);
          this.write(state);
          return { result: 'success', code: row.code, date: row.date, slot: row.slot, name: row.name, size: row.size };
        }

        case 'order': {
          if (!p.name || digits(p.phone).length < 7) fail('Please add a name and a phone number.');
          let items = p.items;
          if (typeof items === 'string') items = JSON.parse(items);
          const lines = [];
          let total = 0;
          let qty = 0;
          (items || []).forEach((line) => {
            const item = state.menu.find((m) => m.id === line.id && m.available);
            if (!item) return;
            const q = Math.min(Math.max(parseInt(line.qty, 10) || 0, 0), 50);
            if (!q) return;
            total += item.price * q;
            qty += q;
            lines.push(`${q} × ${item.name}`);
          });
          if (!lines.length) fail('None of those items are available right now.');
          const code = this.id('ORD');
          state.orders.push({
            timestamp: new Date().toISOString(),
            date: todayIso(),
            code,
            name: p.name,
            phone: p.phone,
            table: p.table || '',
            items: lines.join(', '),
            qty,
            total,
            notes: p.notes || '',
            status: 'New',
            source: 'website'
          });
          this.write(state);
          return { result: 'success', code, total, qty, lines };
        }

        case 'adminLogin':
          if (String(p.username).trim() !== 'admin' || String(p.password) !== 'saphinar') {
            fail('Wrong username or password.');
          }
          return { result: 'success', token: 'demo-token', expiresIn: 21600, user: 'admin', demo: true };

        case 'adminData': {
          const date = p.date || todayIso();
          const dayRows = state.reservations.filter((r) => r.date === date);
          const active = dayRows.filter((r) => r.status === 'Active');
          const orders = state.orders.slice().reverse().slice(0, 60);
          const todayOrders = orders.filter((o) => o.date === date);
          return {
            result: 'success',
            date,
            timetable: slotList().map((time) => {
              const guests = active.filter((r) => r.slot === time);
              return { time, booked: guests.length >= 1, guests, seats: guests.reduce((s, g) => s + g.size, 0), capacity: 1 };
            }),
            reservations: dayRows,
            upcoming: active.filter((r) => r.date >= todayIso()).slice(0, 40),
            orders,
            menu: state.menu,
            stats: {
              reservationsToday: active.length,
              guestsToday: active.reduce((s, r) => s + r.size, 0),
              ordersToday: todayOrders.length,
              openOrders: orders.filter((o) => o.status === 'New' || o.status === 'Preparing').length,
              revenueToday: todayOrders.filter((o) => o.status !== 'Cancelled').reduce((s, o) => s + Number(o.total || 0), 0),
              currency: CONFIG.CURRENCY
            },
            demo: true
          };
        }

        case 'adminCancel': {
          const row = state.reservations.find((r) => r.code === p.code);
          if (!row) fail('Reservation not found.');
          row.status = 'Cancelled';
          this.write(state);
          return { result: 'success', code: p.code };
        }

        case 'adminOrderStatus': {
          const row = state.orders.find((o) => o.code === p.code);
          if (!row) fail('Order not found.');
          row.status = p.status;
          this.write(state);
          return { result: 'success', code: p.code, status: p.status };
        }

        case 'adminMenuSave': {
          if (!p.name) fail('Give the item a name.');
          if (!(Number(p.price) > 0)) fail('Price must be a positive number.');
          const available = String(p.available) !== 'false';
          if (p.id) {
            const row = state.menu.find((m) => m.id === p.id);
            if (!row) fail('That item no longer exists.');
            Object.assign(row, { name: p.name, category: p.category, price: Number(p.price), desc: p.desc || '', available });
            this.write(state);
            return { result: 'success', id: p.id, updated: true };
          }
          const id = String(p.name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() + '-' +
            Math.random().toString(36).toUpperCase().slice(2, 5);
          state.menu.push({ id, name: p.name, category: p.category || 'Coffee', price: Number(p.price), desc: p.desc || '', available });
          this.write(state);
          return { result: 'success', id, created: true };
        }

        case 'adminMenuDelete': {
          const before = state.menu.length;
          state.menu = state.menu.filter((m) => m.id !== p.id);
          if (state.menu.length === before) fail('Item not found.');
          this.write(state);
          return { result: 'success', id: p.id };
        }

        default:
          fail('Unknown action: ' + action);
      }
    }
  };

  /* =======================================================================
     4. STEAM  (canvas — warm bokeh rising through the room)

     A few dozen soft glowing motes drift upward, each with its own size,
     speed and sway. Nothing is computed per pixel: each mote is one
     radial-gradient sprite, which keeps this almost free even on a phone.
     ======================================================================= */

  function startSteam() {
    const canvas = $('#steam');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) { document.body.classList.add('no-canvas'); return; }

    let w = 0, h = 0, dpr = 1;
    let motes = [];

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.max(26, Math.min(70, Math.round(w / 22)));
      motes = Array.from({ length: count }, () => spawn(true));
    }

    function spawn(anywhere) {
      const warm = Math.random();
      return {
        x: Math.random() * w,
        y: anywhere ? Math.random() * h : h + 40,
        r: 18 + Math.random() * 70,
        speed: 6 + Math.random() * 18,           // px per second
        sway: 4 + Math.random() * 26,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.05 + Math.random() * 0.13,
        hue: warm > 0.72 ? '232, 185, 107' : (warm > 0.42 ? '201, 138, 75' : '140, 74, 63')
      };
    }

    let last = 0;
    let raf = 0;

    function draw(now) {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;

      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
      last = now;
      const t = now / 1000;

      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        m.y -= m.speed * dt;
        const x = m.x + Math.sin(t * 0.5 + m.phase) * m.sway;

        if (m.y < -m.r * 2) { motes[i] = spawn(false); continue; }

        // fade in at the bottom, out at the top
        const fade = Math.min(1, Math.max(0, m.y / h)) * Math.min(1, Math.max(0, (h - m.y) / (h * 0.25) + 0.2));
        const g = ctx.createRadialGradient(x, m.y, 0, x, m.y, m.r);
        g.addColorStop(0, `rgba(${m.hue}, ${m.alpha * fade})`);
        g.addColorStop(0.55, `rgba(${m.hue}, ${m.alpha * fade * 0.35})`);
        g.addColorStop(1, `rgba(${m.hue}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    build();
    window.addEventListener('resize', () => { clearTimeout(build._t); build._t = setTimeout(build, 180); });

    if (REDUCED) {
      // one still frame — atmosphere without motion
      last = 0;
      draw(performance.now());
      cancelAnimationFrame(raf);
      return;
    }

    raf = requestAnimationFrame(draw);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { cancelAnimationFrame(raf); raf = 0; }
      else if (!raf) { last = 0; raf = requestAnimationFrame(draw); }
    });
  }

  /* =======================================================================
     5. MENU + CART
     ======================================================================= */

  const state = {
    menu: [],
    category: 'All',
    query: '',
    cart: {},          // id → qty
    lastAdded: null
  };

  function cartCount() {
    return Object.values(state.cart).reduce((s, q) => s + q, 0);
  }
  function cartTotal() {
    return Object.keys(state.cart).reduce((sum, id) => {
      const item = state.menu.find((m) => m.id === id);
      return sum + (item ? item.price * state.cart[id] : 0);
    }, 0);
  }
  function cartLines() {
    return Object.keys(state.cart).map((id) => ({ id, qty: state.cart[id] })).filter((l) => l.qty > 0);
  }

  function renderFilters() {
    const host = $('#menuFilters');
    if (!host) return;
    const counts = {};
    state.menu.forEach((m) => { counts[m.category] = (counts[m.category] || 0) + 1; });
    const cats = ['All'].concat(Object.keys(counts).sort());
    host.innerHTML = cats.map((c) => {
      const n = c === 'All' ? state.menu.length : counts[c];
      return `<button class="chip${c === state.category ? ' is-active' : ''}" type="button"
                role="tab" aria-selected="${c === state.category}" data-cat="${escapeHtml(c)}">
                ${escapeHtml(c)}<span class="chip__count">${n}</span>
              </button>`;
    }).join('');
  }

  function visibleItems() {
    const q = state.query.trim().toLowerCase();
    return state.menu.filter((m) => {
      if (state.category !== 'All' && m.category !== state.category) return false;
      if (!q) return true;
      return (m.name + ' ' + m.desc + ' ' + m.category).toLowerCase().includes(q);
    });
  }

  function renderMenu() {
    const grid = $('#menuGrid');
    const empty = $('#menuEmpty');
    const loading = $('#menuLoading');
    if (!grid) return;
    if (loading) loading.hidden = true;

    const items = visibleItems();
    if (empty) empty.hidden = items.length > 0;

    grid.innerHTML = items.map((m) => {
      const qty = state.cart[m.id] || 0;
      return `
        <article class="dish" data-id="${escapeHtml(m.id)}">
          <div class="dish__top">
            <h3 class="dish__name">${escapeHtml(m.name)}</h3>
            <span class="dish__price">${money(m.price)}</span>
          </div>
          <p class="dish__desc">${escapeHtml(m.desc || '')}</p>
          <div class="dish__foot">
            <span class="dish__tag">${escapeHtml(m.category)}</span>
            <button class="dish__add${qty ? ' is-added' : ''}" type="button" data-add="${escapeHtml(m.id)}"
                    aria-label="Add ${escapeHtml(m.name)} to your order">
              ${qty ? `In tray · ${qty}` : 'Add +'}
            </button>
          </div>
        </article>`;
    }).join('');
  }

  function addToCart(id) {
    const item = state.menu.find((m) => m.id === id);
    if (!item) return;
    state.cart[id] = (state.cart[id] || 0) + 1;
    state.lastAdded = id;
    updateCartUI();
    renderMenu();
    toast(`${item.name} added · ${money(item.price)}`, 'success', 2400);
  }

  function setQty(id, qty) {
    if (qty <= 0) delete state.cart[id];
    else state.cart[id] = Math.min(qty, 50);
    updateCartUI();
    renderMenu();
  }

  function updateCartUI() {
    const n = cartCount();
    const count = $('#cartCount');
    if (count) {
      count.textContent = n;
      count.classList.remove('is-bump');
      void count.offsetWidth;
      count.classList.add('is-bump');
    }

    const list = $('#cartItems');
    const emptyEl = $('#cartEmpty');
    const form = $('#checkoutForm');
    const totalEl = $('#cartTotal');
    const meta = $('#cartMeta');
    const checkout = $('#checkoutBtn');

    if (list) {
      list.innerHTML = Object.keys(state.cart).map((id) => {
        const item = state.menu.find((m) => m.id === id);
        if (!item) return '';
        const q = state.cart[id];
        return `
          <li class="cart__item">
            <div>
              <div class="cart__name">${escapeHtml(item.name)}</div>
              <div class="cart__price">${money(item.price)} each</div>
            </div>
            <div class="cart__qty">
              <button class="qty-btn" type="button" data-dec="${escapeHtml(id)}" aria-label="One less ${escapeHtml(item.name)}">−</button>
              <span class="cart__q">${q}</span>
              <button class="qty-btn" type="button" data-inc="${escapeHtml(id)}" aria-label="One more ${escapeHtml(item.name)}">+</button>
            </div>
            <div class="cart__line-total">${money(item.price * q)}</div>
          </li>`;
      }).join('');
    }

    if (emptyEl) emptyEl.hidden = n > 0;
    if (form) form.hidden = n === 0;
    if (totalEl) totalEl.textContent = money(cartTotal());
    if (meta) meta.textContent = n === 0 ? 'Nothing added yet' : `${n} item${n > 1 ? 's' : ''} · ${money(cartTotal())}`;
    if (checkout && !checkout.classList.contains('is-loading')) checkout.disabled = n === 0;
  }

  function openCart() {
    const drawer = $('#cartDrawer');
    const backdrop = $('#cartBackdrop');
    if (!drawer) return;
    drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
    drawer.classList.remove('is-closing');
    document.body.classList.add('is-locked');
    const close = $('#cartClose');
    if (close) close.focus({ preventScroll: true });
  }

  function closeCart() {
    const drawer = $('#cartDrawer');
    const backdrop = $('#cartBackdrop');
    if (!drawer || drawer.hidden) return;
    drawer.classList.add('is-closing');
    document.body.classList.remove('is-locked');
    setTimeout(() => {
      drawer.hidden = true;
      drawer.classList.remove('is-closing');
      if (backdrop) backdrop.hidden = true;
    }, 280);
  }

  async function placeOrder() {
    const btn = $('#checkoutBtn');
    const status = $('#orderStatus');
    const nameEl = $('#orderName');
    const phoneEl = $('#orderPhone');

    clearStatus(status);

    const badName = nameError(nameEl.value);
    const badPhone = phoneError(phoneEl.value);
    if (badName) { markInvalid(nameEl, badName); nameEl.focus(); }
    else markValid(nameEl);
    if (badPhone) { markInvalid(phoneEl, badPhone); if (!badName) phoneEl.focus(); }
    else markValid(phoneEl);
    if (badName || badPhone) {
      setStatus(status, 'Please check the two fields above.', 'error');
      return;
    }
    if (!cartCount()) return;

    busy(btn, true);
    try {
      const res = await API.call('order', {
        name: nameEl.value.trim(),
        phone: phoneEl.value.trim(),
        table: $('#orderTable').value.trim(),
        notes: $('#orderNote').value.trim(),
        items: JSON.stringify(cartLines())
      }, 'write');

      setStatus(status, `<strong>Order ${escapeHtml(res.code)} sent.</strong> ${money(res.total)} · the kitchen has it.`, 'success');
      toast(`Order ${res.code} sent to the kitchen`, 'success', 5200);

      state.cart = {};
      updateCartUI();
      if ($('#orderNote')) $('#orderNote').value = '';
      setTimeout(closeCart, 2600);
    } catch (err) {
      setStatus(status, escapeHtml(err.message || 'Could not send the order. Please try again.'), 'error');
    } finally {
      busy(btn, false);
      updateCartUI();
    }
  }

  function initMenu() {
    const grid = $('#menuGrid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const add = e.target.closest('[data-add]');
        if (add) addToCart(add.getAttribute('data-add'));
      });
      grid.addEventListener('pointermove', (e) => {
        const card = e.target.closest('.dish');
        if (!card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - r.left}px`);
        card.style.setProperty('--my', `${e.clientY - r.top}px`);
      });
    }

    const filters = $('#menuFilters');
    if (filters) {
      filters.addEventListener('click', (e) => {
        const chip = e.target.closest('[data-cat]');
        if (!chip) return;
        state.category = chip.getAttribute('data-cat');
        renderFilters();
        renderMenu();
      });
    }

    const search = $('#menuSearch');
    if (search) {
      search.addEventListener('input', () => {
        state.query = search.value;
        renderMenu();
      });
    }

    const cartBtn = $('#cartBtn');
    if (cartBtn) cartBtn.addEventListener('click', openCart);
    // "see your order" inside the empty-search message
    $$('[data-open-cart]').forEach((el) => el.addEventListener('click', openCart));
    const close = $('#cartClose');
    if (close) close.addEventListener('click', closeCart);
    const backdrop = $('#cartBackdrop');
    if (backdrop) backdrop.addEventListener('click', closeCart);
    const toMenu = $('#cartToMenu');
    if (toMenu) toMenu.addEventListener('click', closeCart);

    const items = $('#cartItems');
    if (items) {
      items.addEventListener('click', (e) => {
        const inc = e.target.closest('[data-inc]');
        const dec = e.target.closest('[data-dec]');
        if (inc) { const id = inc.getAttribute('data-inc'); setQty(id, (state.cart[id] || 0) + 1); }
        if (dec) { const id = dec.getAttribute('data-dec'); setQty(id, (state.cart[id] || 0) - 1); }
      });
    }

    const checkout = $('#checkoutBtn');
    if (checkout) checkout.addEventListener('click', placeOrder);

    $('#orderName')?.addEventListener('blur', () => {
      const v = $('#orderName').value;
      if (v.trim()) { const m = nameError(v); if (m) markInvalid($('#orderName'), m); else markValid($('#orderName')); }
    });
    $('#orderPhone')?.addEventListener('blur', () => {
      const v = $('#orderPhone').value;
      if (v.trim()) { const m = phoneError(v); if (m) markInvalid($('#orderPhone'), m); else markValid($('#orderPhone')); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeCart();
    });

    updateCartUI();
  }

  async function loadMenu() {
    try {
      const res = await API.call('menu');
      state.menu = (res.items || []).map((m) => ({
        id: m.id, name: m.name, category: m.category || 'Coffee',
        price: Number(m.price) || 0, desc: m.desc || '',
        available: m.available !== false
      }));
    } catch (err) {
      // Never leave an empty page: fall back to the built-in menu.
      state.menu = SAMPLE_MENU.map((m) => ({ ...m }));
      toast('Could not reach the kitchen list — showing the house menu.', 'error', 6000);
    }
    renderFilters();
    renderMenu();
  }

  /* =======================================================================
     6. RESERVATIONS
     ======================================================================= */

  const resv = { date: todayIso(), slot: null, slots: [] };

  function renderSlots() {
    const host = $('#slotGrid');
    if (!host) return;

    if (!resv.slots.length) {
      host.innerHTML = '<p class="slots__none">No hours returned for this day.</p>';
      return;
    }

    host.innerHTML = resv.slots.map((s) => {
      const picked = resv.slot === s.time;
      return `<button class="slot" type="button" data-slot="${escapeHtml(s.time)}"
                aria-pressed="${picked}" ${s.available ? '' : 'disabled'}
                aria-label="${prettyTime(s.time)}${s.available ? ' — available' : ' — already booked'}">
                ${escapeHtml(s.time)}
                <small>${s.available ? 'open' : 'booked'}</small>
              </button>`;
    }).join('');

    const label = $('#reserveDateLabel');
    if (label) {
      const open = resv.slots.filter((s) => s.available).length;
      label.textContent = `${prettyDate(resv.date)} · ${open} of ${resv.slots.length} hours open`;
    }
  }

  async function loadSlots(date) {
    const host = $('#slotGrid');
    if (!host) return;
    resv.date = date;
    resv.slot = null;
    host.innerHTML = '<p class="slots__loading">Checking the room…</p>';
    syncPick();
    try {
      const res = await API.call('slots', { date });
      resv.slots = res.slots || [];
    } catch (err) {
      resv.slots = [];
      toast(err.message || 'Could not load availability.', 'error', 5000);
    }
    renderSlots();
  }

  function syncPick() {
    const pick = $('#resPick');
    const submit = $('#resSubmit');
    const chosen = resv.slot;
    if (pick) {
      pick.textContent = chosen
        ? `${prettyDate(resv.date)} at ${prettyTime(chosen)} — hold this hour`
        : 'No hour selected yet';
      pick.classList.toggle('is-set', !!chosen);
    }
    if (submit) submit.disabled = !chosen;
  }

  async function submitReservation(e) {
    e.preventDefault();
    const status = $('#resStatus');
    const btn = $('#resSubmit');
    const nameEl = $('#resName');
    const phoneEl = $('#resPhone');
    clearStatus(status);

    if (!resv.slot) {
      setStatus(status, 'Pick an open hour above first.', 'error');
      return;
    }

    const badName = nameError(nameEl.value);
    const badPhone = phoneError(phoneEl.value);
    if (badName) { markInvalid(nameEl, badName); nameEl.focus(); } else markValid(nameEl);
    if (badPhone) { markInvalid(phoneEl, badPhone); if (!badName) phoneEl.focus(); } else markValid(phoneEl);
    if (badName || badPhone) {
      setStatus(status, 'Please check the fields above.', 'error');
      return;
    }

    busy(btn, true);
    try {
      const res = await API.call('reserve', {
        date: resv.date,
        slot: resv.slot,
        name: nameEl.value.trim(),
        phone: phoneEl.value.trim(),
        size: $('#resSize').value,
        notes: $('#resNotes').value.trim()
      }, 'write');

      $('#ticketCode').textContent = res.code;
      $('#ticketLine').textContent = `${res.name} · party of ${res.size} · ${prettyDate(res.date)}, ${prettyTime(res.slot)}`;
      $('#resTicket').hidden = false;
      $('#resForm').hidden = true;
      toast(`Table held for ${prettyTime(res.slot)}`, 'success', 5000);

      // refresh availability so the hour we just took disappears for everyone
      await loadSlots(resv.date);
    } catch (err) {
      setStatus(status, escapeHtml(err.message || 'Could not book that hour.'), 'error');
      // Someone else may have taken it a second ago — show the truth.
      await loadSlots(resv.date);
    } finally {
      busy(btn, false);
      syncPick();
    }
  }

  function resetTicket() {
    $('#resTicket').hidden = true;
    $('#resForm').hidden = false;
    $('#resName').value = '';
    $('#resPhone').value = '';
    $('#resNotes').value = '';
    $('#resSize').value = '2';
    markValid($('#resName'));
    markValid($('#resPhone'));
    clearStatus($('#resStatus'));
    loadSlots(resv.date);
  }

  function initReservations() {
    const dateEl = $('#resDate');
    if (!dateEl) return;

    dateEl.min = todayIso();
    dateEl.max = addDays(todayIso(), CONFIG.BOOKING_DAYS_AHEAD);
    dateEl.value = todayIso();
    dateEl.addEventListener('change', () => {
      const v = dateEl.value || todayIso();
      loadSlots(v);
    });

    const grid = $('#slotGrid');
    if (grid) {
      grid.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-slot]');
        if (!btn || btn.disabled) return;
        const time = btn.getAttribute('data-slot');
        resv.slot = resv.slot === time ? null : time;
        renderSlots();
        syncPick();
      });
    }

    const form = $('#resForm');
    if (form) form.addEventListener('submit', submitReservation);
    const reset = $('#ticketReset');
    if (reset) reset.addEventListener('click', resetTicket);

    $('#resName')?.addEventListener('blur', () => {
      const v = $('#resName').value;
      if (v.trim()) { const m = nameError(v); if (m) markInvalid($('#resName'), m); else markValid($('#resName')); }
    });
    $('#resPhone')?.addEventListener('blur', () => {
      const v = $('#resPhone').value;
      if (v.trim()) { const m = phoneError(v); if (m) markInvalid($('#resPhone'), m); else markValid($('#resPhone')); }
    });

    loadSlots(todayIso());
    syncPick();
  }

  /* =======================================================================
     7. ADMIN CONSOLE
     ======================================================================= */

  const admin = {
    token: sessionStorage.getItem('saphinar_token') || '',
    date: todayIso(),
    data: null,
    tab: 'timetable'
  };

  function setView(view) {
    const main = $('#main');
    const footer = $('.footer');
    const adminEl = $('#admin');
    const nav = $('#nav');
    const progress = $('#scrollProgress');
    const isAdmin = view === 'admin';

    if (main) main.hidden = isAdmin;
    if (footer) footer.hidden = isAdmin;
    if (adminEl) adminEl.hidden = !isAdmin;
    if (nav) nav.hidden = isAdmin;
    if (progress) progress.hidden = isAdmin;

    document.body.classList.toggle('is-admin', isAdmin);
    document.body.classList.remove('is-locked');
    closeCart();

    if (!isAdmin) {
      $('#adminLogin')?.removeAttribute('hidden');
      $('#adminDash')?.setAttribute('hidden', '');
    }
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function route() {
    const wantsAdmin = location.hash === CONFIG.ADMIN_ROUTE;
    setView(wantsAdmin ? 'admin' : 'site');
    if (wantsAdmin) {
      if (admin.token) tryDashboard();
      else showLogin();
    }
  }

  function showLogin() {
    $('#adminLogin')?.removeAttribute('hidden');
    $('#adminDash')?.setAttribute('hidden', '');
    $('#adminWho')?.setAttribute('hidden', '');
    $('#adminLogout')?.setAttribute('hidden', '');
    setTimeout(() => $('#adminUser')?.focus({ preventScroll: true }), 120);
  }

  function showDash() {
    $('#adminLogin')?.setAttribute('hidden', '');
    $('#adminDash')?.removeAttribute('hidden');
    const who = $('#adminWho');
    if (who) { who.textContent = 'Signed in · admin'; who.removeAttribute('hidden'); }
    const out = $('#adminLogout');
    if (out) out.removeAttribute('hidden');
  }

  async function tryDashboard() {
    try {
      await loadDashboard(admin.date);
      showDash();
    } catch (err) {
      admin.token = '';
      sessionStorage.removeItem('saphinar_token');
      showLogin();
      if (err.message && /sign in|session/i.test(err.message)) {
        setStatus($('#adminLoginStatus'), 'Your session expired. Please sign in again.', 'error');
      }
    }
  }

  async function adminLogin(e) {
    e.preventDefault();
    const btn = $('#adminLoginBtn');
    const status = $('#adminLoginStatus');
    const user = $('#adminUser').value.trim();
    const pass = $('#adminPass').value;
    clearStatus(status);

    if (!user || !pass) {
      setStatus(status, 'Enter both your username and password.', 'error');
      return;
    }

    busy(btn, true);
    try {
      const res = await API.call('adminLogin', { username: user, password: pass }, 'write');
      admin.token = res.token;
      sessionStorage.setItem('saphinar_token', res.token);
      $('#adminPass').value = '';
      await loadDashboard(admin.date);
      showDash();
      toast('Welcome back.', 'success', 2600);
    } catch (err) {
      setStatus(status, escapeHtml(err.message || 'Could not sign in.'), 'error');
    } finally {
      busy(btn, false);
    }
  }

  function adminLogout() {
    admin.token = '';
    admin.data = null;
    sessionStorage.removeItem('saphinar_token');
    showLogin();
    toast('Signed out.', 'info', 2200);
  }

  async function loadDashboard(date) {
    admin.date = date || admin.date;
    const res = await API.call('adminData', { token: admin.token, date: admin.date }, 'write');
    admin.data = res;
    renderStats(res);
    renderTimetable(res);
    renderOrders(res);
    renderMenuTable(res.menu || []);
    fillCategoryList(res.menu || []);

    const label = $('#timetableLabel');
    if (label) {
      label.textContent = `${prettyDate(res.date)} · ${res.timetable.filter((t) => t.booked).length} of ${res.timetable.length} hours booked`;
    }
  }

  function renderStats(res) {
    const host = $('#adminStats');
    if (!host) return;
    const s = res.stats || {};
    const cards = [
      { k: 'Reservations today', v: s.reservationsToday ?? 0, sub: 'active bookings' },
      { k: 'Guests expected', v: s.guestsToday ?? 0, sub: 'seats held' },
      { k: 'Orders today', v: s.ordersToday ?? 0, sub: s.openOrders ? `${s.openOrders} open` : 'all handled' },
      { k: 'Revenue today', v: money(s.revenueToday || 0), sub: 'excludes cancelled' }
    ];
    host.innerHTML = cards.map((c) => `
      <div class="stat">
        <span class="stat__k">${escapeHtml(c.k)}</span>
        <span class="stat__v">${escapeHtml(String(c.v))}</span>
        <span class="stat__sub">${escapeHtml(c.sub)}</span>
      </div>`).join('');
  }

  function renderTimetable(res) {
    const host = $('#timetable');
    if (!host) return;

    host.innerHTML = res.timetable.map((row) => {
      if (!row.booked) {
        return `<div class="tt__row">
          <span class="tt__hour">${escapeHtml(row.time)}</span>
          <span class="tt__free">Open — no booking</span>
          <span></span>
        </div>`;
      }
      const guests = row.guests || [];
      const g = guests[0] || {};
      return `<div class="tt__row is-booked">
        <span class="tt__hour">${escapeHtml(row.time)}</span>
        <div class="tt__detail">
          <div class="tt__guest">${escapeHtml(g.name || '—')} · ${g.size || 1} guest${(g.size || 1) > 1 ? 's' : ''}</div>
          <div class="tt__meta">
            <a href="tel:${escapeHtml(String(g.phone || '').replace(/\s/g, ''))}">${escapeHtml(g.phone || '')}</a>
            · ${escapeHtml(g.code || '')}${g.notes ? ' · ' + escapeHtml(g.notes) : ''}
          </div>
        </div>
        <div class="tt__actions">
          <button class="tt__cancel" type="button" data-cancel="${escapeHtml(g.code || '')}">Cancel</button>
        </div>
      </div>`;
    }).join('');
  }

  function renderOrders(res) {
    const host = $('#ordersList');
    if (!host) return;
    const orders = res.orders || [];

    if (!orders.length) {
      host.innerHTML = '<p class="tt__free">No orders yet today. They will appear here the moment someone sends one.</p>';
      return;
    }

    const statuses = ['New', 'Preparing', 'Served', 'Cancelled'];
    host.innerHTML = orders.map((o) => `
      <article class="order">
        <div class="order__top">
          <span class="order__code">${escapeHtml(o.code)}</span>
          <span class="order__total">${money(o.total)}</span>
        </div>
        <div class="order__who">${escapeHtml(o.name)} · ${escapeHtml(o.phone)}${o.table ? ' · ' + escapeHtml(o.table) : ''}</div>
        <div class="order__items">${escapeHtml(o.items)}${o.notes ? ' — ' + escapeHtml(o.notes) : ''}</div>
        <div class="order__foot">
          <span class="order__time">${escapeHtml(String(o.timestamp).slice(0, 16).replace('T', ' '))}</span>
          <div class="statuses">
            ${statuses.map((s) => `<button class="st${o.status === s ? ' is-on' : ''}" type="button"
              data-order="${escapeHtml(o.code)}" data-status="${s}">${s}</button>`).join('')}
          </div>
        </div>
      </article>`).join('');
  }

  function renderMenuTable(menu) {
    const host = $('#menuTable');
    if (!host) return;
    host.innerHTML = menu.map((m) => `
      <div class="mrow${m.available ? '' : ' is-off'}">
        <div class="mrow__main">
          <div class="mrow__name">${escapeHtml(m.name)}</div>
          <div class="mrow__meta">${escapeHtml(m.category)} · ${escapeHtml(m.id)}${m.available ? '' : ' · hidden'}</div>
        </div>
        <span class="mrow__price">${money(m.price)}</span>
        <div class="mrow__actions">
          <button class="mlink" type="button" data-edit="${escapeHtml(m.id)}">Edit</button>
          <button class="mlink mlink--danger" type="button" data-del="${escapeHtml(m.id)}">Delete</button>
        </div>
      </div>`).join('');
  }

  function fillCategoryList(menu) {
    const list = $('#categoryList');
    if (!list) return;
    const cats = Array.from(new Set(menu.map((m) => m.category))).sort();
    list.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join('');
  }

  /* ------------------------------------------------ admin: interactions */

  function openBookingModal() {
    const modal = $('#bookingModal');
    if (!modal) return;
    modal.hidden = false;
    $('#abDate').value = admin.date;
    $('#abDate').min = todayIso();
    $('#abDate').max = addDays(todayIso(), CONFIG.BOOKING_DAYS_AHEAD);
    fillBookingSlots();
    setTimeout(() => $('#abName')?.focus({ preventScroll: true }), 100);
  }

  function fillBookingSlots() {
    const sel = $('#abSlot');
    if (!sel) return;
    const rows = (admin.data && admin.data.timetable) || [];
    const date = $('#abDate').value;
    const sameDay = date === admin.date;
    sel.innerHTML = slotList().map((t) => {
      const row = sameDay ? rows.find((r) => r.time === t) : null;
      const taken = row && row.booked;
      return `<option value="${t}" ${taken ? 'disabled' : ''}>${escapeHtml(t)}${taken ? ' — booked' : ''}</option>`;
    }).join('');
  }

  async function submitAdminBooking(e) {
    e.preventDefault();
    const status = $('#adminBookingStatus');
    const btn = e.target.querySelector('button[type="submit"]');
    clearStatus(status);

    busy(btn, true);
    try {
      const res = await API.call('adminReserve', {
        token: admin.token,
        date: $('#abDate').value,
        slot: $('#abSlot').value,
        name: $('#abName').value.trim(),
        phone: $('#abPhone').value.trim(),
        size: $('#abSize').value,
        notes: $('#abNotes').value.trim()
      }, 'write');

      $('#bookingModal').hidden = true;
      e.target.reset();
      toast(`Booked ${prettyTime(res.slot)} for ${res.name} (${res.code})`, 'success', 5000);
      admin.date = $('#adminDate').value || admin.date;
      await loadDashboard(admin.date);
    } catch (err) {
      setStatus(status, escapeHtml(err.message || 'Could not book that hour.'), 'error');
    } finally {
      busy(btn, false);
    }
  }

  function switchTab(tab) {
    admin.tab = tab;
    $$('#adminTabs .tab').forEach((b) => {
      const on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    ['timetable', 'orders', 'menu'].forEach((name) => {
      const panel = $(`#panel-${name}`);
      if (panel) panel.hidden = name !== tab;
    });
  }

  function initAdmin() {
    $('#adminLoginForm')?.addEventListener('submit', adminLogin);
    $('#adminLogout')?.addEventListener('click', adminLogout);

    $('#adminDate')?.addEventListener('change', (e) => {
      loadDashboard(e.target.value || todayIso()).catch((err) => toast(err.message, 'error'));
    });

    $('#adminTabs')?.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) switchTab(tab.getAttribute('data-tab'));
    });

    $('#adminRefresh')?.addEventListener('click', () => {
      loadDashboard(admin.date).then(() => toast('Refreshed.', 'info', 1800)).catch((err) => toast(err.message, 'error'));
    });

    // cancel a reservation
    $('#timetable')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cancel]');
      if (!btn) return;
      const code = btn.getAttribute('data-cancel');
      if (!code || !confirm(`Cancel reservation ${code}? The hour becomes available again.`)) return;
      btn.disabled = true;
      try {
        await API.call('adminCancel', { token: admin.token, code }, 'write');
        toast(`${code} cancelled — hour freed`, 'success', 3600);
        await loadDashboard(admin.date);
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });

    // order status
    $('#ordersList')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-order]');
      if (!btn) return;
      const code = btn.getAttribute('data-order');
      const status = btn.getAttribute('data-status');
      try {
        await API.call('adminOrderStatus', { token: admin.token, code, status }, 'write');
        await loadDashboard(admin.date);
        toast(`${code} → ${status}`, 'success', 2400);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // menu manager
    const form = $('#menuForm');
    $('#adminNewItem')?.addEventListener('click', () => {
      form.hidden = false;
      $('#miId').value = '';
      $('#miName').value = '';
      $('#miCategory').value = 'Coffee';
      $('#miPrice').value = '';
      $('#miDesc').value = '';
      $('#miAvailable').checked = true;
      clearStatus($('#menuStatus'));
      $('#miName').focus();
    });
    $('#menuFormCancel')?.addEventListener('click', () => { form.hidden = true; });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = $('#menuStatus');
      clearStatus(status);
      const name = $('#miName').value.trim();
      const price = Number($('#miPrice').value);
      if (!name) { setStatus(status, 'Give the item a name.', 'error'); return; }
      if (!(price > 0)) { setStatus(status, 'Price must be a number above zero.', 'error'); return; }

      const btn = form.querySelector('button[type="submit"]');
      busy(btn, true);
      try {
        await API.call('adminMenuSave', {
          token: admin.token,
          id: $('#miId').value,
          name,
          category: $('#miCategory').value.trim() || 'Coffee',
          price,
          desc: $('#miDesc').value.trim(),
          available: $('#miAvailable').checked ? 'true' : 'false'
        }, 'write');
        form.hidden = true;
        toast('Menu saved.', 'success', 2400);
        await loadDashboard(admin.date);
        await loadMenu();
      } catch (err) {
        setStatus(status, escapeHtml(err.message), 'error');
      } finally {
        busy(btn, false);
      }
    });

    $('#menuTable')?.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-edit]');
      const del = e.target.closest('[data-del]');
      const menu = (admin.data && admin.data.menu) || [];

      if (edit) {
        const item = menu.find((m) => m.id === edit.getAttribute('data-edit'));
        if (!item) return;
        form.hidden = false;
        $('#miId').value = item.id;
        $('#miName').value = item.name;
        $('#miCategory').value = item.category;
        $('#miPrice').value = item.price;
        $('#miDesc').value = item.desc || '';
        $('#miAvailable').checked = !!item.available;
        clearStatus($('#menuStatus'));
        form.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      if (del) {
        const id = del.getAttribute('data-del');
        if (!confirm(`Delete ${id} from the menu? Past orders are not affected.`)) return;
        try {
          await API.call('adminMenuDelete', { token: admin.token, id }, 'write');
          toast('Item removed.', 'success', 2400);
          await loadDashboard(admin.date);
          await loadMenu();
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    });

    // manual booking modal
    $('#adminNewBooking')?.addEventListener('click', openBookingModal);
    $('#bookingModalClose')?.addEventListener('click', () => { $('#bookingModal').hidden = true; });
    $('#bookingModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'bookingModal') $('#bookingModal').hidden = true;
    });
    $('#abDate')?.addEventListener('change', fillBookingSlots);
    $('#adminBookingForm')?.addEventListener('submit', submitAdminBooking);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#bookingModal').hidden) $('#bookingModal').hidden = true;
    });
  }

  /* =======================================================================
     BOOT
     ======================================================================= */

  function initInterface() {
    const nav = $('#nav');
    const toggle = $('#navToggle');
    const links = $('#navLinks');
    const progress = $('#scrollProgress');

    const onScroll = () => {
      const y = window.scrollY || 0;
      nav?.classList.toggle('is-stuck', y > 20);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (progress) progress.style.width = `${max > 0 ? (y / max) * 100 : 0}%`;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    if (toggle && links) {
      const close = () => {
        links.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Open menu');
      };
      toggle.addEventListener('click', () => {
        const open = links.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      });
      links.addEventListener('click', (e) => { if (e.target.closest('a')) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }

    const items = $$('[data-reveal]');
    if ('IntersectionObserver' in window && !REDUCED) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.14, rootMargin: '0px 0px -6% 0px' });
      items.forEach((el) => io.observe(el));
    } else {
      items.forEach((el) => el.classList.add('is-visible'));
    }

    const year = $('#year');
    if (year) year.textContent = new Date().getFullYear();

    // hero: live open/closed badge
    const today = $('#heroToday');
    if (today) {
      const now = new Date();
      const hour = now.getHours() + now.getMinutes() / 60;
      const open = hour >= CONFIG.OPEN_HOUR && hour < CONFIG.CLOSE_HOUR;
      today.textContent = open ? 'Open now' : 'Closed — see you at 11:00';
      today.classList.add(open ? 'is-open' : 'is-shut');
    }
    const hours = $('#heroHours');
    if (hours) hours.textContent = `${pad(CONFIG.OPEN_HOUR)}:00 — ${pad(CONFIG.CLOSE_HOUR)}:00`;

    if (DEMO && !sessionStorage.getItem('saphinar_demo_notice')) {
      sessionStorage.setItem('saphinar_demo_notice', '1');
      setTimeout(() => {
        toast('Demo mode — add your Apps Script URL in script.js to go live.', 'info', 7000);
      }, 1600);
    }
  }

  function onReady() {
    initInterface();
    initMenu();
    initReservations();
    initAdmin();
    startSteam();
    loadMenu();

    const dateEl = $('#adminDate');
    if (dateEl) {
      dateEl.value = admin.date;
      dateEl.min = todayIso();
      dateEl.max = addDays(todayIso(), CONFIG.BOOKING_DAYS_AHEAD);
    }

    route();
    window.addEventListener('hashchange', route);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady, { once: true });
  } else {
    onReady();
  }
})();

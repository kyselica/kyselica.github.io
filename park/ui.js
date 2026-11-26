/* Kyselica Park: the interface around the canvas.
   Plaques, the park guide, the prompt and the stamp count are ordinary HTML, so they stay readable,
   selectable and reachable by keyboard and screen reader without walking anywhere. */
(function () {
  'use strict';
  const Park = window.Park;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const stage = $('stage'), canvas = $('park'), plaque = $('plaque'), guide = $('guide'), welcome = $('welcome');
  const measure = () => {
    stage.classList.toggle('narrow', stage.clientWidth < 700);
    stage.classList.toggle('tiny', stage.clientWidth < 380);
    stage.classList.toggle('short', stage.clientHeight < 500);
  };
  measure();
  const prompt = $('prompt'), hint = $('hint'), tip = $('tip'), stamps = $('stamps');
  const exhibits = Park.data.exhibits, byId = {};
  exhibits.forEach((e, i) => { byId[e.id] = e; e.index = i; });
  const zones = Park.world.ZONES, sitesMeta = Park.world.SITES;

  /* ----- stamps: which plaques this visitor has read ----- */
  const KEY = 'kyselicapark.stamps';
  let visited = new Set();
  try { visited = new Set(JSON.parse(localStorage.getItem(KEY) || '[]').filter((id) => byId[id])); } catch (e) { /* storage blocked: stamps last for this visit only */ }
  const saveStamps = () => { try { localStorage.setItem(KEY, JSON.stringify(Array.from(visited))); } catch (e) { /* not remembered */ } };
  const showStamps = () => { stamps.querySelector('b').textContent = visited.size + ' / ' + exhibits.length; };

  let openId = null;
  const blocked = () => guide.open || !welcome.hidden;
  const game = Park.start(canvas, {
    blocked,
    visited: (id) => visited.has(id),
    onNear(id) {
      if (openId && id !== openId) closePlaque({ keepFocus: true });   // walked away from the sign
      if (!id || id === openId) { prompt.hidden = true; return; }
      prompt.hidden = false;
      prompt.dataset.id = id;
      prompt.querySelector('.prompt-name').textContent = byId[id].title;
    },
    onOpen: (id) => openPlaque(id),
    onMove() { hint.classList.add('gone'); },
    onHover(id, x, y) {
      if (!id) { tip.hidden = true; return; }
      tip.hidden = false; tip.textContent = byId[id].title;
      const r = stage.getBoundingClientRect();
      tip.style.transform = 'translate(' + Math.round(x - r.left + 14) + 'px,' + Math.round(y - r.top + 16) + 'px)';
    },
  });

  /* ----- plaque ----- */
  function setInset() {
    measure();
    if (!openId) { game.setInset(0, 0); return; }
    const r = plaque.getBoundingClientRect(), st = stage.getBoundingClientRect();
    if (stage.classList.contains('narrow')) game.setInset(0, st.bottom - r.top); else game.setInset(st.right - r.left, 0);
  }
  function videoBlock(v) {
    const box = el('div', 'video');
    const play = el('button', 'video-play');
    play.type = 'button';
    play.setAttribute('aria-label', 'Play video: ' + v.title);
    const img = el('img');
    img.src = 'park/img/' + v.id + '.jpg'; img.alt = ''; img.loading = 'lazy';
    play.appendChild(img);
    play.appendChild(el('span', 'video-badge', '▶ Watch the routine'));
    play.addEventListener('click', () => {
      const f = el('iframe');
      f.src = 'https://www.youtube-nocookie.com/embed/' + v.id + '?autoplay=1&rel=0';
      f.title = v.title;
      f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      f.allowFullscreen = true;
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      box.replaceChild(f, play);
    });
    box.appendChild(play);
    const wrap = el('div');
    wrap.appendChild(box);
    const link = el('a', 'video-link', 'Watch on YouTube');
    link.href = 'https://www.youtube.com/watch?v=' + v.id; link.target = '_blank'; link.rel = 'noopener';
    wrap.appendChild(link);
    return wrap;
  }
  function fillPlaque(e) {
    const zone = zones[sitesMeta[e.id].zone];
    const body = plaque.querySelector('.plaque-body');
    body.textContent = '';
    const chip = plaque.querySelector('.zone');
    chip.textContent = zone.name; chip.style.setProperty('--zone', zone.color);
    plaque.querySelector('.plaque-count').textContent = e.index + 1 + ' of ' + exhibits.length;

    const head = el('div', 'plaque-head' + (e.image && e.image.icon ? ' has-icon' : ''));
    if (e.image && e.image.icon) { const i = el('img', 'plaque-icon' + (e.image.pixel ? ' pixel' : '')); i.src = e.image.src; i.alt = e.image.alt; head.appendChild(i); }
    const titles = el('div');
    const h = el('h2', null, e.title); h.id = 'plaque-title'; h.tabIndex = -1;
    titles.appendChild(h);
    titles.appendChild(el('p', 'kicker', e.kicker));
    head.appendChild(titles);
    body.appendChild(head);

    if (e.meta) { const m = el('ul', 'meta'); e.meta.forEach((t) => m.appendChild(el('li', null, t))); body.appendChild(m); }
    if (e.draft) body.appendChild(el('p', 'draft', 'Wet paint'));
    if (e.video) body.appendChild(videoBlock(e.video));
    if (e.image && !e.image.icon) {
      const i = el('img', 'photo' + (e.image.portrait ? ' portrait' : ''));
      i.src = e.image.src; i.alt = e.image.alt; i.loading = 'lazy';
      body.appendChild(i);
    }
    (e.body || []).forEach((t) => body.appendChild(el('p', null, t)));
    if (e.bullets) { const u = el('ul', 'bullets'); e.bullets.forEach((t) => u.appendChild(el('li', null, t))); body.appendChild(u); }
    if (e.shelves) {
      const d = el('dl', 'shelves');
      e.shelves.forEach(([k, v]) => { d.appendChild(el('dt', null, k)); d.appendChild(el('dd', null, v)); });
      body.appendChild(d);
    }
    if (e.tags) { const u = el('ul', 'tags'); e.tags.forEach((t) => u.appendChild(el('li', null, t))); body.appendChild(u); }
    if (e.links) {
      const row = el('div', 'links');
      e.links.forEach((l) => {
        const a = el('a', 'btn' + (l.primary ? ' primary' : ''), l.label);
        a.href = l.href;
        if (/^https?:/.test(l.href) || /\.pdf$/.test(l.href)) { a.target = '_blank'; a.rel = 'noopener'; }
        row.appendChild(a);
      });
      body.appendChild(row);
    }
    if (e.note) body.appendChild(el('p', 'note', e.note));
    body.scrollTop = 0;
  }
  function openPlaque(id, opt) {
    const e = byId[id];
    if (!e) return;
    opt = opt || {};
    openId = id;
    fillPlaque(e);
    plaque.hidden = false;
    prompt.hidden = true;
    if (!visited.has(id)) { visited.add(id); saveStamps(); showStamps(); stamps.classList.remove('bump'); void stamps.offsetWidth; stamps.classList.add('bump'); }
    game.setFocus(id);
    setInset();
    if (!opt.quiet) try { history.replaceState(null, '', '#' + id); } catch (err) { /* file:// in some browsers */ }
    if (!opt.keepFocus) plaque.querySelector('#plaque-title').focus({ preventScroll: true });
  }
  function closePlaque(opt) {
    if (!openId) return;
    openId = null;
    plaque.hidden = true;
    plaque.querySelector('.plaque-body').textContent = '';   // stops any playing video
    game.setFocus(null);
    setInset();
    try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignore */ }
    const near = game.near();
    if (near) { prompt.hidden = false; prompt.dataset.id = near; prompt.querySelector('.prompt-name').textContent = byId[near].title; }
    if (!(opt && opt.keepFocus) || plaque.contains(document.activeElement) || document.activeElement === document.body) canvas.focus({ preventScroll: true });
  }
  function visit(id) { game.teleport(id); openPlaque(id); }
  function step(d) { const e = exhibits[(byId[openId].index + d + exhibits.length) % exhibits.length]; visit(e.id); }

  plaque.querySelector('.plaque-close').addEventListener('click', () => closePlaque());
  plaque.querySelector('.plaque-prev').addEventListener('click', () => step(-1));
  plaque.querySelector('.plaque-next').addEventListener('click', () => step(1));
  prompt.addEventListener('click', () => { const id = prompt.dataset.id; if (id) game.goTo(id, true); });
  window.addEventListener('resize', setInset);
  if (window.ResizeObserver) new ResizeObserver(setInset).observe(stage);

  /* ----- park guide: a map with pins, and the same exhibits as a plain list ----- */
  let mapDrawn = false;
  function buildGuide() {
    const list = guide.querySelector('.guide-list'), pins = guide.querySelector('.guide-pins');
    list.textContent = ''; pins.textContent = '';
    const W = Park.world.W * Park.world.T, H = Park.world.H * Park.world.T;
    Object.keys(zones).forEach((zid) => {
      const members = exhibits.filter((e) => sitesMeta[e.id].zone === zid);
      if (!members.length) return;
      const sec = el('section', 'guide-zone');
      const h = el('h3', null, zones[zid].name); h.style.setProperty('--zone', zones[zid].color);
      sec.appendChild(h);
      const ul = el('ul');
      members.forEach((e) => {
        const li = el('li'), b = el('button', 'guide-item' + (visited.has(e.id) ? ' seen' : ''));
        b.type = 'button';
        b.appendChild(el('span', 'num', String(e.index + 1)));
        const t = el('span', 'txt'); t.appendChild(el('b', null, e.title)); t.appendChild(el('small', null, e.kicker)); b.appendChild(t);
        b.appendChild(el('span', 'stamp', visited.has(e.id) ? 'Read' : ''));
        b.addEventListener('click', () => { guide.close(); visit(e.id); });
        li.appendChild(b); ul.appendChild(li);
        const s = game.sites[e.id], pin = el('button', 'pin' + (visited.has(e.id) ? ' seen' : ''), String(e.index + 1));
        pin.type = 'button'; pin.title = e.title; pin.setAttribute('aria-label', e.title);
        pin.style.left = (s.focusPx.x / W) * 100 + '%'; pin.style.top = (s.focusPx.y / H) * 100 + '%';
        pin.style.setProperty('--zone', zones[zid].color);
        pin.addEventListener('click', () => { guide.close(); visit(e.id); });
        pins.appendChild(pin);
      });
      sec.appendChild(ul); list.appendChild(sec);
    });
    const you = el('span', 'you', 'You');
    you.style.left = (game.player.x / W) * 100 + '%'; you.style.top = (game.player.y / H) * 100 + '%';
    pins.appendChild(you);
  }
  function openGuide() {
    if (guide.open) return;
    if (!mapDrawn) { game.renderMap(guide.querySelector('canvas')); mapDrawn = true; }
    buildGuide();
    welcome.hidden = true;
    if (guide.showModal) guide.showModal(); else guide.setAttribute('open', '');
  }
  $('btn-guide').addEventListener('click', openGuide);
  stamps.addEventListener('click', openGuide);
  guide.querySelector('.guide-close').addEventListener('click', () => guide.close());
  guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); });
  guide.addEventListener('close', () => canvas.focus({ preventScroll: true }));

  /* ----- welcome card, zoom, keys ----- */
  function enter() { welcome.hidden = true; canvas.focus({ preventScroll: true }); }
  $('btn-enter').addEventListener('click', enter);
  $('btn-tour').addEventListener('click', openGuide);
  $('zoom-in').addEventListener('click', () => { game.zoomBy(1); setInset(); });
  $('zoom-out').addEventListener('click', () => { game.zoomBy(-1); setInset(); });
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') { if (!welcome.hidden) enter(); else if (!guide.open && openId) closePlaque(); return; }
    if (guide.open) return;
    if (!welcome.hidden) { if (e.key === 'Enter' && document.activeElement === document.body) enter(); return; }
    if (e.key === 'm' || e.key === 'M') openGuide();
    else if (e.key === '+' || e.key === '=') game.zoomBy(1);
    else if (e.key === '-' || e.key === '_') game.zoomBy(-1);
    else if (openId && e.key === ']') step(1);
    else if (openId && e.key === '[') step(-1);
  });

  if (window.matchMedia('(pointer: coarse)').matches) {
    hint.textContent = 'Tap to walk. Tap an exhibit to read its sign. Pinch to zoom.';
    document.querySelector('.welcome-card .keys').textContent = 'Tap to walk · tap an exhibit to read its sign · pinch to zoom';
  }
  showStamps();
  $('btn-enter').focus({ preventScroll: true });

  /* a link straight to an exhibit: kyseli.ca/#fennec */
  const wanted = decodeURIComponent(location.hash.replace('#', ''));
  if (byId[wanted]) { welcome.hidden = true; hint.classList.add('gone'); game.teleport(wanted); openPlaque(wanted, { quiet: true, keepFocus: true }); }
  else if (wanted === 'guide') openGuide();

  Park.ui = { openPlaque, closePlaque, openGuide, visit, game };
})();

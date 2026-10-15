/* PortWatch: catalogue, project pages, fork checks and the submit form. No dependencies. */
(function () {
  'use strict';

  var ISSUES = 'https://github.com/dudemurphytronnn/portwatch/issues/new';
  var API = 'https://api.github.com/';
  var DAY = 86400000;
  var nf = new Intl.NumberFormat('en-US');

  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseDate(iso) { return Date.parse(iso.length === 10 ? iso + 'T00:00:00Z' : iso); }
  function fmtDate(iso) {
    if (!iso) return 'None';
    return new Date(parseDate(iso)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  function ago(iso, now) {
    var d = Math.round(((now || Date.now()) - parseDate(iso)) / DAY);
    if (d <= 0) return 'today';
    if (d === 1) return '1 day ago';
    if (d < 60) return d + ' days ago';
    return Math.round(d / 30) + ' months ago';
  }
  function rate(n) { return n >= 10 ? nf.format(Math.round(n)) : n.toFixed(1); }
  function licenseLabel(l) {
    if (!l) return 'No license file';
    if (l === 'NOASSERTION' || l === 'other') return 'Custom / unclear';
    return l;
  }
  function splitName(full) {
    var i = full.indexOf('/');
    return { owner: full.slice(0, i), repo: full.slice(i + 1) };
  }
  function nameHTML(full) {
    var n = splitName(full);
    return '<span class="owner">' + esc(n.owner) + '/</span>' + esc(n.repo);
  }
  function projectHref(full) { return 'project.html?r=' + encodeURIComponent(full); }

  var STAR = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 .8l2.2 4.6 5 .7-3.6 3.5.9 5L8 12.2 3.5 14.6l.9-5L.8 6.1l5-.7z"/></svg>';
  var BYOG_ICON = {
    stated: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8.5l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    required: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="4" width="12" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 6.5v3M8 11v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    none: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    na: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 8h6" stroke="currentColor" stroke-width="1.6"/></svg>'
  };
  function byogHTML(b) {
    return '<span class="byog ' + esc(b.level) + '">' + (BYOG_ICON[b.level] || '') + esc(b.label) + '</span>';
  }

  /* ---------- data ---------- */
  var dataPromise;
  function loadData() {
    if (!dataPromise) {
      dataPromise = fetch('data.json', { cache: 'no-cache' }).then(function (r) {
        if (!r.ok) throw new Error('data.json returned ' + r.status);
        return r.json();
      }).then(function (d) {
        var snap = parseDate(d.snapshot);
        d.catById = {};
        d.categories.forEach(function (c) { d.catById[c.id] = c; });
        d.projects.forEach(function (p) {
          p.ageDays = Math.max(1, Math.round((snap - parseDate(p.created)) / DAY));
          p.perDay = p.stars / p.ageDays;
          p.noise = p.categories.indexOf('unrelated') !== -1;
          p.haystack = [p.name, p.description, p.summary, p.language, (p.topics || []).join(' '), p.platforms.join(' ')].join(' ').toLowerCase();
        });
        d.byName = {};
        d.projects.forEach(function (p) { d.byName[p.name.toLowerCase()] = p; });
        return d;
      });
    }
    return dataPromise;
  }

  /* ---------- GitHub API with session cache ---------- */
  function RateLimited() { this.message = 'rate-limited'; }
  function gh(path) {
    var key = 'pw:' + path;
    try {
      var hit = sessionStorage.getItem(key);
      if (hit) return Promise.resolve(JSON.parse(hit));
    } catch (e) { /* storage unavailable */ }
    return fetch(API + path, { headers: { Accept: 'application/vnd.github+json' } }).then(function (r) {
      if (r.status === 404 || r.status === 409 || r.status === 422) return null;
      if (r.status === 403 || r.status === 429) throw new RateLimited();
      if (!r.ok) throw new Error('GitHub returned ' + r.status);
      return r.json();
    }).then(function (j) {
      try { sessionStorage.setItem(key, JSON.stringify(j)); } catch (e) { /* full or blocked */ }
      return j;
    });
  }
  function apiFailText(err) {
    return err instanceof RateLimited
      ? 'GitHub\'s hourly limit for this browser is used up. Showing the snapshot; try again later.'
      : 'Couldn\'t reach GitHub just now. Showing the snapshot.';
  }

  // Ask GitHub whether a repo is a fork, and if so how far it is from its parent.
  function forkStatus(full) {
    return gh('repos/' + full).then(function (repo) {
      if (!repo) return { missing: true };
      var out = { repo: repo };
      if (!repo.fork || !repo.parent) return out;
      var parent = repo.parent;
      var owner = repo.owner.login;
      return gh('repos/' + parent.full_name + '/compare/' +
        encodeURIComponent(parent.default_branch) + '...' + encodeURIComponent(owner + ':' + repo.default_branch))
        .then(function (cmp) { out.compare = cmp; return out; });
    });
  }
  function forkStatusHTML(s) {
    if (s.missing) return '<span class="live-warn">Not found on GitHub now. It may have been renamed, made private or removed.</span>';
    var r = s.repo, bits = [];
    if (r.fork && r.parent) {
      bits.push('Fork of <a href="' + projectHref(r.parent.full_name) + '">' + esc(r.parent.full_name) + '</a>');
      if (s.compare) bits.push(nf.format(s.compare.ahead_by) + ' ahead, ' + nf.format(s.compare.behind_by) + ' behind');
      else bits.push('ahead/behind unavailable');
    } else {
      bits.push('Not a GitHub fork: its own history');
    }
    bits.push('pushed ' + ago(r.pushed_at));
    bits.push(nf.format(r.stargazers_count) + '★ now');
    return '<span class="live-ok">' + bits.join(' · ') + '</span>';
  }

  /* ---------- index ---------- */
  function initIndex() {
    var form = $('#filters');
    var state = { q: '', cats: [], lang: '', lic: '', sort: 'stars', twins: false };

    function readURL() {
      var u = new URLSearchParams(location.search);
      state.q = u.get('q') || '';
      state.cats = (u.get('cat') || '').split(',').filter(Boolean);
      state.lang = u.get('lang') || '';
      state.lic = u.get('lic') || '';
      state.sort = u.get('sort') || 'stars';
      state.twins = u.get('twins') === '1';
    }
    function writeURL() {
      var u = new URLSearchParams();
      if (state.q) u.set('q', state.q);
      if (state.cats.length) u.set('cat', state.cats.join(','));
      if (state.lang) u.set('lang', state.lang);
      if (state.lic) u.set('lic', state.lic);
      if (state.sort !== 'stars') u.set('sort', state.sort);
      if (state.twins) u.set('twins', '1');
      var qs = u.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    }

    loadData().then(function (d) {
      readURL();
      var listed = d.projects.filter(function (p) { return !p.noise; });
      var noiseCount = d.projects.length - listed.length;

      // Masthead manifest
      var totalStars = listed.reduce(function (a, p) { return a + p.stars; }, 0);
      $('#manifest-line').innerHTML =
        '<span>Snapshot <b>' + esc(fmtDate(d.snapshot)) + '</b></span>' +
        '<span><b>' + listed.length + '</b> projects tracked</span>' +
        '<span><b>' + nf.format(totalStars) + '</b> stars between them</span>' +
        '<span><b>' + noiseCount + '</b> name twins set aside</span>' +
        '<span>Source: GitHub API</span>';

      renderRising(d, listed);

      // Category chips (noise has its own toggle)
      var cats = d.categories.filter(function (c) { return c.id !== 'unrelated'; });
      $('#cat-chips').innerHTML = cats.map(function (c) {
        return '<label class="chip" title="' + esc(c.blurb) + '"><input type="checkbox" name="cat" value="' + esc(c.id) + '"><span>' +
          esc(c.label) + ' <b data-count="' + esc(c.id) + '">0</b></span></label>';
      }).join('');
      $('#twins-label').textContent = 'Show name twins and search noise (' + noiseCount + ')';

      fillSelect($('#lang'), d.projects, function (p) { return p.language || 'Not detected'; }, 'All languages');
      fillSelect($('#lic'), d.projects, function (p) { return licenseLabel(p.license); }, 'All licenses');

      // Restore state into controls
      $('#q').value = state.q;
      form.querySelectorAll('input[name="cat"]').forEach(function (i) { i.checked = state.cats.indexOf(i.value) !== -1; });
      $('#lang').value = state.lang;
      $('#lic').value = state.lic;
      $('#sort').value = state.sort;
      $('#twins').checked = state.twins;
      if ($('#lang').value !== state.lang) state.lang = '';
      if ($('#lic').value !== state.lic) state.lic = '';

      var t;
      form.addEventListener('input', function (e) {
        clearTimeout(t);
        t = setTimeout(sync, e.target.id === 'q' ? 120 : 0);
      });
      form.addEventListener('change', sync);
      form.addEventListener('submit', function (e) { e.preventDefault(); sync(); });
      form.addEventListener('reset', function () { setTimeout(sync, 0); });
      $('#empty-reset').addEventListener('click', function () { form.reset(); });

      function sync() {
        state.q = $('#q').value.trim();
        state.cats = Array.prototype.map.call(form.querySelectorAll('input[name="cat"]:checked'), function (i) { return i.value; });
        state.lang = $('#lang').value;
        state.lic = $('#lic').value;
        state.sort = $('#sort').value;
        state.twins = $('#twins').checked;
        writeURL();
        render();
      }

      function passes(p, skipCats) {
        if (p.noise && !state.twins) return false;
        if (!skipCats && state.cats.length && !p.categories.some(function (c) { return state.cats.indexOf(c) !== -1; })) return false;
        if (state.lang && (p.language || 'Not detected') !== state.lang) return false;
        if (state.lic && licenseLabel(p.license) !== state.lic) return false;
        if (state.q) {
          var words = state.q.toLowerCase().split(/\s+/);
          for (var i = 0; i < words.length; i++) if (p.haystack.indexOf(words[i]) === -1) return false;
        }
        return true;
      }

      var SORTS = {
        stars: function (a, b) { return b.stars - a.stars || a.name.localeCompare(b.name); },
        rate: function (a, b) { return b.perDay - a.perDay || b.stars - a.stars; },
        newest: function (a, b) { return b.created.localeCompare(a.created) || b.stars - a.stars; },
        pushed: function (a, b) { return b.updated.localeCompare(a.updated) || b.stars - a.stars; },
        name: function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); }
      };

      function render() {
        // Live counts per category, honouring every other filter
        var pool = d.projects.filter(function (p) { return passes(p, true); });
        cats.forEach(function (c) {
          var n = pool.filter(function (p) { return p.categories.indexOf(c.id) !== -1; }).length;
          var el = form.querySelector('[data-count="' + c.id + '"]');
          el.textContent = n;
          el.closest('label').querySelector('input').disabled = n === 0 && state.cats.indexOf(c.id) === -1;
        });

        var rows = d.projects.filter(function (p) { return passes(p, false); }).sort(SORTS[state.sort] || SORTS.stars);
        var shownNoise = rows.filter(function (p) { return p.noise; }).length;
        $('#result-count').innerHTML = '<b>' + rows.length + '</b> of ' + d.projects.length + ' repos' +
          (shownNoise ? ' (' + shownNoise + ' name twins)' : '');
        $('#results').innerHTML = rows.map(entryHTML).join('');
        var empty = rows.length === 0;
        $('#empty').hidden = !empty;
        if (empty) {
          var hidden = d.projects.filter(function (p) { return p.noise && !state.twins && passes(Object.assign({}, p, { noise: false }), false); }).length;
          $('#empty-why').textContent = hidden
            ? hidden + ' name twin' + (hidden === 1 ? '' : 's') + ' match, but they are hidden. Tick "Show name twins" to see them, or clear the filters.'
            : 'Nothing in the catalogue matches. Try fewer categories or a shorter search.';
        }
      }

      function entryHTML(p) {
        var stamps = p.categories.map(function (c) {
          return '<li class="stamp">' + esc(d.catById[c] ? d.catById[c].label : c) + '</li>';
        }).join('');
        var links = '<a href="' + projectHref(p.name) + '">Claims, commits &amp; forks</a>' +
          '<a class="ext" href="' + esc(p.url) + '" rel="noopener">GitHub</a>' +
          (p.homepage ? '<a class="ext" href="' + esc(p.homepage) + '" rel="noopener nofollow">Homepage</a>' : '');
        return '<li class="entry' + (p.noise ? ' is-noise' : '') + '">' +
          '<div class="entry-head"><h3><a href="' + projectHref(p.name) + '">' + nameHTML(p.name) + '</a></h3>' +
          '<span class="stars" aria-label="' + nf.format(p.stars) + ' stars">' + STAR + nf.format(p.stars) + '</span></div>' +
          (p.noise ? '<p><span class="noise-flag">Not a compatibility project</span></p>' : '') +
          '<p class="summary">' + esc(p.summary) + '</p>' +
          '<ul class="stamps" aria-label="Categories">' + stamps + '<li>' + byogHTML(p.byog) + '</li></ul>' +
          '<dl class="facts">' +
          fact('★ / day', rate(p.perDay)) +
          fact('License', licenseLabel(p.license)) +
          fact('Language', p.language || 'Not detected') +
          fact('Created', fmtDate(p.created)) +
          fact('Updated', fmtDate(p.updated)) +
          fact('Forks', nf.format(p.forks)) +
          '</dl>' +
          '<p class="links">' + links + '</p></li>';
      }

      render();
      renderFamilies(d);
      if (location.hash) {
        var target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
      }
    }).catch(function (err) {
      $('#manifest-line').textContent = 'The catalogue failed to load.';
      $('#results').innerHTML = '';
      $('#result-count').textContent = '';
      $('#rising-list').innerHTML = '';
      $('#family-list').innerHTML = '';
      var e = $('#empty');
      e.hidden = false;
      e.querySelector('h3').textContent = 'The catalogue didn\'t load';
      $('#empty-why').textContent = 'Reload the page to try again. (' + err.message + ')';
    });
  }

  function fact(k, v) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>'; }

  function fillSelect(sel, projects, keyFn, allLabel) {
    var counts = {};
    projects.forEach(function (p) { var k = keyFn(p); counts[k] = (counts[k] || 0) + 1; });
    var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a] || a.localeCompare(b); });
    sel.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + keys.map(function (k) {
      return '<option value="' + esc(k) + '">' + esc(k) + ' (' + counts[k] + ')</option>';
    }).join('');
  }

  function renderRising(d, listed) {
    var snap = parseDate(d.snapshot);
    var active = listed.filter(function (p) { return snap - parseDate(p.updated) <= 7 * DAY; })
      .sort(function (a, b) { return b.perDay - a.perDay; }).slice(0, 6);
    var max = active.length ? active[0].perDay : 1;
    $('#rising-list').innerHTML = active.length ? active.map(function (p) {
      var pct = Math.max(2, Math.round(p.perDay / max * 100));
      return '<li><span class="r-name"><a href="' + projectHref(p.name) + '">' + nameHTML(p.name) + '</a></span>' +
        '<span class="r-rate">' + rate(p.perDay) + ' <small>★/day</small></span>' +
        '<span class="r-bar" aria-hidden="true"><span style="width:' + pct + '%"></span></span>' +
        '<span class="r-meta">' + nf.format(p.stars) + '★ in ' + p.ageDays + ' day' + (p.ageDays === 1 ? '' : 's') +
        ' · ' + esc(p.categories.map(function (c) { return d.catById[c].label; }).join(', ')) + '</span></li>';
    }).join('') : '<li>No tracked project was updated in the last week of this snapshot.</li>';
  }

  function renderFamilies(d) {
    var el = $('#family-list');
    el.innerHTML = d.families.map(function (f) {
      var members = f.members.map(function (m, i) {
        var p = d.byName[m.repo.toLowerCase()];
        return '<li class="' + (/upstream/i.test(m.role) ? 'upstream' : '') + '" data-repo="' + esc(m.repo) + '">' +
          '<div class="m-top"><a class="m-name" href="' + projectHref(m.repo) + '">' + nameHTML(m.repo) + '</a>' +
          '<span class="m-role">' + esc(m.role) + '</span>' +
          (p ? '<span class="m-stars">' + nf.format(p.stars) + '★ · ' + esc(fmtDate(p.updated)) + '</span>' : '') + '</div>' +
          (m.note ? '<p class="m-note">' + esc(m.note) + '</p>' : '') +
          '<p class="m-live" aria-live="polite"></p></li>';
      }).join('');
      var editUrl = ISSUES + '?' + new URLSearchParams({
        title: 'Fork note: ' + f.name,
        labels: 'fork-note',
        body: '### Family\n' + f.name + '\n\n### Current note\n> ' + f.note + '\n\n### Suggested change\n\n\n### Source for the change (link to commits, README or release)\n'
      }).toString();
      return '<article class="family" id="family-' + esc(f.id) + '">' +
        '<p class="kind">' + esc(f.kind) + '</p><h3>' + esc(f.name) + '</h3>' +
        '<p>' + esc(f.note) + '</p>' +
        '<ul class="tree">' + members + '</ul>' +
        '<div class="family-actions"><button type="button" class="btn ghost small" data-check="' + esc(f.id) + '">Check live on GitHub</button>' +
        '<a href="' + esc(editUrl) + '" target="_blank" rel="noopener">Suggest an edit to this note</a></div>' +
        '<details class="history"><summary>Note history (' + f.revisions.length + ' revision' + (f.revisions.length === 1 ? '' : 's') + ')</summary><ol>' +
        f.revisions.map(function (r) { return '<li><time datetime="' + esc(r.date) + '">' + esc(fmtDate(r.date)) + '</time>: ' + esc(r.summary) + '</li>'; }).join('') +
        '</ol></details></article>';
    }).join('');

    el.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-check]');
      if (!btn) return;
      var fam = d.families.filter(function (f) { return f.id === btn.dataset.check; })[0];
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = 'Checking…';
      var art = btn.closest('.family');
      // Sequential, to stay gentle on the anonymous rate limit
      var chain = Promise.resolve(), limited = false;
      fam.members.forEach(function (m) {
        chain = chain.then(function () {
          var slot = art.querySelector('[data-repo="' + CSS.escape(m.repo) + '"] .m-live');
          if (limited) return;
          slot.textContent = 'Asking GitHub…';
          return forkStatus(m.repo).then(function (s) { slot.innerHTML = forkStatusHTML(s); })
            .catch(function (err) {
              if (err instanceof RateLimited) limited = true;
              slot.innerHTML = '<span class="live-warn">' + esc(apiFailText(err)) + '</span>';
            });
        });
      });
      chain.then(function () {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
        btn.textContent = limited ? 'Try again later' : 'Checked · run again';
      });
    });
  }

  /* ---------- project page ---------- */
  function initProject() {
    var root = $('#project');
    var full = new URLSearchParams(location.search).get('r') || '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(full)) return notListed(root, '');

    loadData().then(function (d) {
      var p = d.byName[full.toLowerCase()];
      if (!p) return notListed(root, full);
      document.title = p.name + ' · PortWatch';
      var md = document.querySelector('meta[name="description"]');
      if (md) md.setAttribute('content', p.summary);
      var fam = p.family ? d.families.filter(function (f) { return f.id === p.family; })[0] : null;
      var famMember = fam ? fam.members.filter(function (m) { return m.repo === p.name; })[0] : null;

      var corrUrl = ISSUES + '?' + new URLSearchParams({
        title: 'Correction: ' + p.name,
        labels: 'correction',
        body: '### Listing\n' + p.name + '\n\n### What is wrong\n\n\n### Source (link)\n'
      }).toString();

      root.innerHTML =
        '<p class="crumbs"><a href="index.html#catalogue">Catalogue</a> / ' + esc(p.categories.map(function (c) { return d.catById[c].label; }).join(', ')) + '</p>' +
        '<header class="p-head">' +
        '<h1><span class="owner">' + esc(splitName(p.name).owner) + ' /</span>' + esc(splitName(p.name).repo) + '</h1>' +
        (p.noise ? '<p><span class="noise-flag">Not a compatibility project. Kept so it isn\'t confused with one.</span></p>' : '') +
        '<p class="summary">' + esc(p.summary) + '</p>' +
        '<ul class="stamps">' + p.categories.map(function (c) { return '<li class="stamp">' + esc(d.catById[c].label) + '</li>'; }).join('') +
        (p.topics || []).map(function (t) { return '<li class="stamp topic">' + esc(t) + '</li>'; }).join('') +
        '<li>' + byogHTML(p.byog) + '</li></ul>' +
        '<p class="links"><a class="ext" href="' + esc(p.url) + '" rel="noopener">Repo on GitHub</a>' +
        (p.homepage ? '<a class="ext" href="' + esc(p.homepage) + '" rel="noopener nofollow">Project homepage</a>' : '') +
        '<a href="' + esc(corrUrl) + '" target="_blank" rel="noopener">Report a correction</a></p>' +
        '</header>' +
        '<div class="p-grid">' +
        '<aside class="p-side" aria-labelledby="facts-title"><h2 id="facts-title" class="visually-hidden">Facts</h2>' +
        '<dl class="facts" id="facts">' +
        '<div class="big"><dt>Stars</dt><dd id="v-stars">' + nf.format(p.stars) + '</dd></div>' +
        '<div class="big"><dt>★ / day avg</dt><dd>' + rate(p.perDay) + '</dd></div>' +
        fact('Last commit', 'Checking…').replace('<dd>', '<dd id="v-commit">') +
        fact('Last release', 'Checking…').replace('<dd>', '<dd id="v-release">') +
        fact('License', licenseLabel(p.license)).replace('<dd>', '<dd id="v-license">') +
        fact('Language', p.language || 'Not detected') +
        fact('Created', fmtDate(p.created)) +
        fact('Forks', nf.format(p.forks)).replace('<dd>', '<dd id="v-forks">') +
        '<div style="grid-column:1/-1"><dt>Platforms</dt><dd>' + esc(p.platforms.length ? p.platforms.join(', ') : 'n/a') + '</dd></div>' +
        '</dl>' +
        '<p class="live-status" id="live-status" aria-live="polite">Snapshot ' + esc(fmtDate(d.snapshot)) + '. Fetching live numbers…</p>' +
        '</aside>' +
        '<div class="p-main">' +
        '<section class="p-block" aria-labelledby="tl-title"><h2 id="tl-title">Claims beside commits</h2>' +
        '<p>What the project says about itself, dated, next to the latest commits and releases GitHub reports. Read them together.</p>' +
        '<div class="timeline-head" aria-hidden="true"><span>Date</span><span>The project says</span><span>The repo shows</span></div>' +
        '<ol class="timeline" id="timeline">' + timelineHTML(p.claims, [], []) + '</ol></section>' +
        '<section class="p-block" aria-labelledby="fork-title"><h2 id="fork-title">Fork status</h2>' +
        '<p id="fork-live">Asking GitHub…</p>' +
        (fam ? '<p>Part of the <a href="index.html#family-' + esc(fam.id) + '">' + esc(fam.name) + '</a> family' +
          (famMember ? ' as <strong>' + esc(famMember.role.toLowerCase()) + '</strong>' : '') + '. ' +
          esc(famMember && famMember.note ? famMember.note : fam.note) + '</p>' : '') +
        '</section>' +
        '<section class="p-block" aria-labelledby="src-title"><h2 id="src-title">Sources</h2><ol class="sources">' +
        '<li>Repo metadata: <a class="ext" href="' + esc(p.url) + '" rel="noopener">' + esc(p.url) + '</a>, via GitHub REST API, read ' + esc(fmtDate(d.snapshot)) + '.</li>' +
        (p.description ? '<li>Description as published on GitHub, read ' + esc(fmtDate(d.snapshot)) + ': <q>' + esc(p.description) + '</q></li>' : '<li>The repo had no description on GitHub at the snapshot.</li>') +
        '<li id="src-live" hidden></li>' +
        '</ol></section>' +
        '</div></div>';

      live(p, d);
    }).catch(function (err) {
      root.innerHTML = '<div class="empty"><h3>This page didn\'t load</h3><p>Reload to try again. (' + esc(err.message) + ')</p></div>';
    });
  }

  function timelineHTML(claims, commits, releases) {
    var items = [];
    claims.forEach(function (c) {
      items.push({ date: c.date, cls: 'claim', kind: 'Claim',
        html: '<q>' + esc(c.text) + '</q> <small>(' + esc(c.source) + ')</small>' });
    });
    releases.forEach(function (r) {
      items.push({ date: r.published_at || r.created_at, cls: 'release', kind: 'Release',
        html: '<a href="' + esc(r.html_url) + '" rel="noopener">' + esc(r.name || r.tag_name) + '</a>' + (r.prerelease ? ' <small>(pre-release)</small>' : '') });
    });
    commits.forEach(function (c) {
      var msg = (c.commit && c.commit.message || '').split('\n')[0];
      items.push({ date: c.commit.committer && c.commit.committer.date || c.commit.author.date, cls: 'commit', kind: 'Commit',
        html: '<a class="sha" href="' + esc(c.html_url) + '" rel="noopener">' + esc(c.sha.slice(0, 7)) + '</a> ' + esc(msg.length > 120 ? msg.slice(0, 117) + '…' : msg) });
    });
    if (!items.length) return '<li><span></span><span class="body">No dated claims recorded yet. <a href="submit.html">Send one with its source.</a></span></li>';
    items.sort(function (a, b) { return parseDate(b.date) - parseDate(a.date) || (a.cls === 'claim' ? -1 : 1); });
    return items.map(function (i) {
      return '<li class="' + i.cls + '"><time datetime="' + esc(i.date) + '">' + esc(fmtDate(i.date)) + '</time>' +
        '<span class="body"><span class="kind">' + i.kind + '</span>' + i.html + '</span></li>';
    }).join('');
  }

  function live(p, d) {
    var status = $('#live-status');
    var forkEl = $('#fork-live');
    Promise.all([
      forkStatus(p.name),
      gh('repos/' + p.name + '/commits?per_page=15').catch(function (e) { if (e instanceof RateLimited) throw e; return null; }),
      gh('repos/' + p.name + '/releases?per_page=5').catch(function (e) { if (e instanceof RateLimited) throw e; return null; })
    ]).then(function (res) {
      var s = res[0], commits = res[1] || [], releases = (res[2] || []).filter(function (r) { return !r.draft; });
      if (s.missing) {
        status.textContent = 'GitHub no longer finds this repo. Showing the ' + fmtDate(d.snapshot) + ' snapshot.';
        forkEl.innerHTML = forkStatusHTML(s);
        $('#v-commit').textContent = 'Unknown';
        $('#v-release').textContent = 'Unknown';
        return;
      }
      var r = s.repo;
      $('#v-stars').textContent = nf.format(r.stargazers_count);
      $('#v-forks').textContent = nf.format(r.forks_count);
      if (r.license) $('#v-license').textContent = licenseLabel(r.license.spdx_id);
      $('#v-commit').textContent = commits.length ? ago(commits[0].commit.committer.date) : ('pushed ' + ago(r.pushed_at));
      $('#v-release').textContent = releases.length ? (releases[0].tag_name + ', ' + fmtDate(releases[0].published_at || releases[0].created_at)) : 'No releases';
      var delta = r.stargazers_count - p.stars;
      status.textContent = 'Live from GitHub, ' + new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) + '. ' +
        (delta ? (delta > 0 ? '+' : '') + nf.format(delta) + ' stars since the ' + fmtDate(d.snapshot) + ' snapshot.' : 'No star change since the snapshot.');
      forkEl.innerHTML = forkStatusHTML(s);
      $('#timeline').innerHTML = timelineHTML(p.claims, commits, releases);
      var src = $('#src-live');
      src.hidden = false;
      src.innerHTML = 'Commits, releases and fork status: GitHub REST API, read live ' + esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })) + '.';
    }).catch(function (err) {
      status.textContent = apiFailText(err);
      forkEl.textContent = 'Fork status needs GitHub\'s API, which isn\'t answering right now.';
      $('#v-commit').textContent = 'Snapshot: ' + fmtDate(p.updated);
      $('#v-release').textContent = 'Unknown';
    });
  }

  function notListed(root, full) {
    root.innerHTML = '<div class="empty"><h3>' + (full ? esc(full) + ' isn\'t listed' : 'No project given') + '</h3>' +
      '<p>' + (full ? 'PortWatch hasn\'t reviewed this repo. If it meets the listing rules, submit it.' : 'Pick a project from the catalogue.') + '</p>' +
      '<p><a class="btn" href="' + (full ? 'submit.html?url=' + encodeURIComponent('https://github.com/' + full) : 'index.html#catalogue') + '">' +
      (full ? 'Submit it' : 'Open the catalogue') + '</a></p></div>';
  }

  /* ---------- submit ---------- */
  var OSI = ['MIT', 'MIT-0', 'Apache-2.0', 'GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later',
    'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'ISC', 'Zlib', 'Unlicense', '0BSD', 'EPL-2.0', 'BSL-1.0', 'Artistic-2.0', 'EUPL-1.2'];
  var GAME_DATA = /\.(nsp|xci|nca|nsz|xcz|iso|cia|3ds|wbfs|wad|rvz|gcm|cso|chd)$|(^|\/)(prod|title|dev)\.keys$|\.keys$/i;

  function parseRepoURL(v) {
    var m = String(v).trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
    return m ? m[1] + '/' + m[2] : null;
  }

  function initSubmit() {
    var form = $('#submit-form');
    var urlIn = $('#f-url');
    var checksEl = $('#checks');
    var lastChecks = { repo: null, items: [] };
    var known = {};
    loadData().then(function (d) { known = d.byName; }).catch(function () {});

    var pre = new URLSearchParams(location.search).get('url');
    if (pre) { urlIn.value = pre; setTimeout(runChecks, 0); }

    var t;
    urlIn.addEventListener('input', function () { clearTimeout(t); t = setTimeout(runChecks, 600); });
    urlIn.addEventListener('blur', function () { clearTimeout(t); runChecks(); });

    function show(items) {
      lastChecks.items = items;
      checksEl.innerHTML = items.map(function (i) {
        var ico = { pass: '✓', warn: '!', fail: '✕', wait: '…' }[i.s] || '·';
        return '<li class="' + i.s + '"><span class="ico" aria-hidden="true">' + ico + '</span><span>' +
          '<span class="visually-hidden">' + ({ pass: 'Passed: ', warn: 'Needs review: ', fail: 'Failed: ', wait: 'Checking: ' }[i.s] || '') + '</span>' +
          esc(i.t) + (i.d ? '<small>' + esc(i.d) + '</small>' : '') + '</span></li>';
      }).join('');
    }

    function runChecks() {
      var repo = parseRepoURL(urlIn.value);
      if (!urlIn.value.trim()) { lastChecks.repo = null; show([{ s: '', t: 'Paste a repo URL to start.' }]); return; }
      if (!repo) { lastChecks.repo = null; show([{ s: 'fail', t: 'That isn\'t a github.com/owner/repo address.' }]); return; }
      if (repo === lastChecks.repo) return;
      lastChecks.repo = repo;
      if (!$('#f-name').value) $('#f-name').value = repo.split('/')[1];
      var items = [];
      if (known[repo.toLowerCase()]) items.push({ s: 'warn', t: 'Already in the catalogue.', d: 'Use "Report a correction" on its page instead.' });
      show(items.concat([{ s: 'wait', t: 'Asking GitHub about ' + repo + '…' }]));

      gh('repos/' + repo).then(function (r) {
        if (lastChecks.repo !== repo) return;
        if (!r) { show(items.concat([{ s: 'fail', t: 'Not found, or not public.', d: 'Only public repos can be listed.' }])); return; }
        items.push(r.private ? { s: 'fail', t: 'Repo is private.' } : { s: 'pass', t: 'Public repo', d: nf.format(r.stargazers_count) + '★, created ' + fmtDate(r.created_at) });
        var spdx = r.license && r.license.spdx_id;
        if (spdx && OSI.indexOf(spdx) !== -1) items.push({ s: 'pass', t: 'OSI license: ' + spdx });
        else if (spdx) items.push({ s: 'warn', t: 'License file found but not a standard one', d: 'A moderator will read it (' + spdx + ').' });
        else items.push({ s: 'fail', t: 'No license detected', d: 'Ask the project to add one, or explain in the description why it should be listed.' });
        if (r.fork && r.parent) items.push({ s: 'pass', t: 'Fork of ' + r.parent.full_name, d: 'Please say what it changes.' });
        if (r.archived) items.push({ s: 'warn', t: 'Archived by its owner' });
        show(items.concat([{ s: 'wait', t: 'Scanning file list for game data…' }]));
        return gh('repos/' + repo + '/git/trees/' + encodeURIComponent(r.default_branch) + '?recursive=1').then(function (tree) {
          if (lastChecks.repo !== repo) return;
          if (!tree || !tree.tree) { items.push({ s: 'warn', t: 'Couldn\'t read the file list', d: 'A moderator will check by hand.' }); show(items); return; }
          var flagged = tree.tree.filter(function (f) { return f.type === 'blob' && GAME_DATA.test(f.path); });
          var huge = tree.tree.filter(function (f) { return f.type === 'blob' && f.size > 50 * 1024 * 1024; });
          if (flagged.length) items.push({ s: 'fail', t: flagged.length + ' file' + (flagged.length === 1 ? '' : 's') + ' look like game images or keys', d: flagged.slice(0, 4).map(function (f) { return f.path; }).join(', ') });
          else items.push({ s: 'pass', t: 'No game images or key files in ' + nf.format(tree.tree.length) + ' paths' });
          if (huge.length) items.push({ s: 'warn', t: huge.length + ' file' + (huge.length === 1 ? '' : 's') + ' over 50 MB', d: huge.slice(0, 3).map(function (f) { return f.path; }).join(', ') });
          if (tree.truncated) items.push({ s: 'warn', t: 'File list was too long to scan fully' });
          show(items);
        });
      }).catch(function (err) {
        if (lastChecks.repo !== repo) return;
        show(items.concat([{ s: 'warn', t: apiFailText(err).replace(' Showing the snapshot.', ''), d: 'You can still submit; a moderator will run the checks.' }]));
      });
    }

    function setErr(id, msg) {
      var input = $('#' + id), err = $('#' + id + '-err');
      err.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
      return !msg;
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var repo = parseRepoURL(urlIn.value);
      var ok = [
        setErr('f-url', repo ? '' : 'Enter a public GitHub repo address, like https://github.com/owner/repo.'),
        setErr('f-name', $('#f-name').value.trim() ? '' : 'Give the project a name.'),
        setErr('f-cat', $('#f-cat').value ? '' : 'Choose the closest category.'),
        setErr('f-desc', $('#f-desc').value.trim().length >= 10 ? '' : 'Describe what it does in a sentence or two.'),
        setErr('f-rules', $('#f-rules').checked ? '' : 'Listings must follow the rules. Tick the box to confirm.')
      ];
      var firstBad = ok.indexOf(false);
      if (firstBad !== -1) {
        $(['#f-url', '#f-name', '#f-cat', '#f-desc', '#f-rules'][firstBad]).focus();
        return;
      }
      var checks = lastChecks.repo === repo && lastChecks.items.length
        ? lastChecks.items.filter(function (i) { return i.s && i.s !== 'wait'; }).map(function (i) {
          return '- ' + ({ pass: '✅', warn: '⚠️', fail: '❌' }[i.s]) + ' ' + i.t + (i.d ? ' (' + i.d + ')' : '');
        }).join('\n')
        : '- Not run (GitHub API unavailable in the submitter\'s browser)';
      var fork = $('#f-fork').value.trim();
      var body = [
        '### Repository', 'https://github.com/' + repo, '',
        '### Name', $('#f-name').value.trim(), '',
        '### Category', $('#f-cat').value, '',
        '### What it does', $('#f-desc').value.trim(), '',
        '### What the fork changes', fork || '_Not a fork, or not given._', '',
        '### Automatic checks (run in the submitter\'s browser, ' + new Date().toISOString().slice(0, 10) + ')', checks, '',
        '### Rules affirmed',
        '- [x] Public, with an OSI or otherwise clear license',
        '- [x] Bundles and links to no game data, firmware, BIOS, decryption keys or copyrighted assets',
        '- [x] Works only with copies the user legitimately owns'
      ].join('\n');
      var url = ISSUES + '?' + new URLSearchParams({ title: 'Submit: ' + repo, labels: 'submission', body: body }).toString();
      // No 'noopener' feature: with it, window.open always returns null and a blocked tab can't be detected.
      var win = window.open(url, '_blank');
      if (win) win.opener = null;
      $('#f-status').innerHTML = win
        ? 'GitHub opened in a new tab. Press <strong>Submit new issue</strong> there to send it to the moderators.'
        : 'Your browser blocked the new tab. <a href="' + esc(url) + '" target="_blank" rel="noopener">Open the pre-filled issue</a>.';
    });
  }

  /* ---------- boot ---------- */
  var page = document.body.dataset.page;
  if (page === 'index') initIndex();
  else if (page === 'project') initProject();
  else if (page === 'submit') initSubmit();
})();

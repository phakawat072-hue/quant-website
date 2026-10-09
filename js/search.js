(function (QL) {
  'use strict';

  const squash = (s) => s.toLowerCase().replace(/[\s.\-]/g, '');

  // Lower is better; -1 means no match.
  function rank(item, query) {
    const q = query.toLowerCase().trim();
    const qs = squash(q);
    const t = squash(item.ticker);
    const n = item.name.toLowerCase();
    if (t === qs) return 0;
    if (t.startsWith(qs)) return 1;
    if (n.startsWith(q)) return 2;
    if (n.split(/[\s()&,'-]+/).some((w) => w.startsWith(q))) return 3;
    if (t.includes(qs)) return 4;
    if (n.includes(q)) return 5;
    if (item.group.toLowerCase().includes(q)) return 6;
    return -1;
  }

  function search(items, query) {
    if (!query.trim()) return items.slice();
    return items
      .map((it, i) => ({ it, r: rank(it, query), i }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.it);
  }

  // Accessible combobox (WAI-ARIA 1.2 list autocomplete pattern).
  function create({ input, list, getItems, getCurrent, onSelect, emptyText }) {
    let results = [];
    let active = -1;
    let isOpen = false;

    const labelOf = (it) => (it ? it.ticker + ' · ' + it.name : '');
    const current = () => getItems().find((it) => it.id === getCurrent());
    const showCurrent = () => { input.value = labelOf(current()); };

    function openList() {
      isOpen = true;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    function closeList() {
      isOpen = false;
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function setActive(i) {
      const opts = list.querySelectorAll('[role="option"]');
      opts.forEach((o, k) => o.classList.toggle('is-active', k === i));
      active = i;
      if (i >= 0 && opts[i]) {
        input.setAttribute('aria-activedescendant', opts[i].id);
        opts[i].scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }

    function render(query) {
      const q = query.trim();
      results = search(getItems(), q);
      list.textContent = '';
      if (!results.length) {
        const li = document.createElement('li');
        li.className = 'combo-empty';
        li.textContent = emptyText(q);
        list.appendChild(li);
        setActive(-1);
        return;
      }
      let lastGroup = null;
      results.forEach((it, i) => {
        if (!q && it.group !== lastGroup) {
          const h = document.createElement('li');
          h.className = 'combo-group';
          h.setAttribute('role', 'presentation');
          h.textContent = it.group;
          list.appendChild(h);
          lastGroup = it.group;
        }
        const li = document.createElement('li');
        li.id = 'combo-opt-' + i;
        li.className = 'combo-option';
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(it.id === getCurrent()));
        const tk = document.createElement('span');
        tk.className = 'combo-ticker';
        tk.textContent = it.ticker;
        const nm = document.createElement('span');
        nm.className = 'combo-name';
        nm.textContent = it.name;
        li.append(tk, nm);
        if (q) {
          const tag = document.createElement('span');
          tag.className = 'combo-tag';
          tag.textContent = it.tag || it.group;
          li.appendChild(tag);
        }
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
        li.addEventListener('mousemove', () => { if (active !== i) setActive(i); });
        list.appendChild(li);
      });
      const cur = results.findIndex((it) => it.id === getCurrent());
      setActive(q ? 0 : Math.max(0, cur));
    }

    function choose(i) {
      const it = results[i];
      if (!it) return;
      closeList();
      input.value = labelOf(it);
      if (it.id !== getCurrent()) onSelect(it.id);
    }

    input.addEventListener('focus', () => {
      render('');
      openList();
      input.select();
    });
    input.addEventListener('click', () => {
      if (!isOpen) { render(''); openList(); }
    });
    input.addEventListener('input', () => {
      render(input.value);
      openList();
    });
    input.addEventListener('blur', () => {
      closeList();
      showCurrent();
    });
    input.addEventListener('keydown', (e) => {
      const n = results.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) { render(''); openList(); return; }
        if (!n) return;
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive(Math.min(n - 1, Math.max(0, active + step)));
      } else if (e.key === 'Enter') {
        if (isOpen && active >= 0) { e.preventDefault(); choose(active); }
      } else if (e.key === 'Escape') {
        if (isOpen) {
          e.preventDefault();
          closeList();
          showCurrent();
          input.select();
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      e.preventDefault();
      input.focus();
    });

    showCurrent();
    return { refresh: () => { if (document.activeElement !== input) showCurrent(); } };
  }

  QL.search = { create, rank, search };
})((window.QL = window.QL || {}));

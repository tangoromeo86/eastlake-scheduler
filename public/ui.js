'use strict';
// Small shared UI helpers loaded by the coach, director and admin pages.
// Replaces the alert()/prompt() calls that had accumulated — fine while
// building, wrong for something coaches use on a phone mid-season.

function uiEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Transient confirmation. Non-blocking, unlike alert().
function toast(message, kind) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0';
                     setTimeout(() => el.remove(), 300); }, kind === 'bad' ? 5200 : 3600);
}

// Slide-over panel. Closes on backdrop click or Escape.
function openPanel(title, bodyHtml) {
  closePanel();
  const wrap = document.createElement('div');
  wrap.className = 'panel-overlay';
  wrap.id = 'ui-panel';
  wrap.innerHTML = `<div class="panel" role="dialog" aria-modal="true">
      <div class="panel-head"><h2>${uiEsc(title)}</h2>
        <button class="panel-close" aria-label="Close">&times;</button></div>
      <div class="panel-body">${bodyHtml}</div>
    </div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap) closePanel(); });
  wrap.querySelector('.panel-close').addEventListener('click', closePanel);
  document.body.appendChild(wrap);
  document.body.style.overflow = 'hidden';
}
function closePanel() {
  const p = document.getElementById('ui-panel');
  if (p) p.remove();
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePanel(); });

// Typed confirmation for destructive actions, where a plain OK/Cancel is too
// easy to click through.
function confirmTyped(title, message, word) {
  return new Promise(resolve => {
    openPanel(title, `
      <p style="font-size:14px;color:#475569;line-height:1.55">${message}</p>
      <div class="field-form-row" style="margin-top:14px">
        <label>Type <strong>${uiEsc(word)}</strong> to confirm
          <input id="ui-confirm-input" type="text" autocomplete="off"></label>
      </div>
      <div class="field-form-actions">
        <button class="btn btn-secondary" id="ui-confirm-no">Cancel</button>
        <button class="btn btn-danger" id="ui-confirm-yes">Confirm</button>
      </div>
      <div id="ui-confirm-err" class="notice notice-bad" style="display:none">
        That didn't match — nothing has been changed.</div>`);
    const done = (v) => { closePanel(); resolve(v); };
    document.getElementById('ui-confirm-no').onclick = () => done(false);
    document.getElementById('ui-confirm-yes').onclick = () => {
      const typed = (document.getElementById('ui-confirm-input').value || '').trim().toLowerCase();
      if (typed === String(word).toLowerCase()) return done(true);
      document.getElementById('ui-confirm-err').style.display = '';
    };
    setTimeout(() => document.getElementById('ui-confirm-input')?.focus(), 50);
  });
}

// ── Game history ────────────────────────────────────────────────────────────
// Previously an alert() dumping plain text. This is the surface Ted asked to be
// "very clear", and directors need to read it mid-negotiation, so it gets a
// proper timeline with the live state called out at the top.

function uiWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US',
    { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function uiDue(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US',
    { weekday: 'short', month: 'short', day: 'numeric' });
}

async function showGameHistory(gameId) {
  openPanel(`Game #${gameId}`, '<p class="muted">Loading history…</p>');
  let data;
  try {
    const res = await fetch(`api/games/${gameId}/history`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch {
    openPanel(`Game #${gameId}`, '<p class="danger-text">Could not load history for this game.</p>');
    return;
  }

  let html = '';
  if (data.active) {
    const a = data.active;
    const overdue = a.response_due_at && new Date(a.response_due_at) < new Date();
    const flags = [
      a.escalated?.director ? 'director notified' : null,
      a.escalated?.admin ? 'admin notified' : null,
      a.escalated?.stalemate ? 'stalemate — directors looped in' : null,
    ].filter(Boolean);
    html += `<div class="live-box">
      <h3>Change in progress</h3>
      <p>${uiEsc(a.summary)}</p>
      ${a.response_due_at ? `<p class="due">${overdue ? 'Response was due' : 'Response due'} ${uiEsc(uiDue(a.response_due_at))}${overdue ? ' — now overdue' : ''}</p>` : ''}
      ${flags.length ? `<p class="due">${uiEsc(flags.join(' · '))}</p>` : ''}
    </div>`;
  }

  const items = (data.timeline || []);
  if (!items.length) {
    html += '<p class="empty-note">Nothing has changed on this game yet.</p>';
  } else {
    html += '<ul class="tl">' + items.map(e => {
      const cls = e.kind === 'agreed' ? 'is-agreed'
                : e.kind === 'escalated' ? 'is-escalated'
                : e.kind === 'proposed' ? 'is-proposed' : '';
      return `<li class="${cls}">
        <div class="tl-when">${uiEsc(uiWhen(e.at))}</div>
        <div class="tl-what">${uiEsc(e.summary)}</div>
        ${e.detail ? `<div class="tl-detail">${uiEsc(e.detail)}</div>` : ''}
      </li>`;
    }).join('') + '</ul>';
  }
  openPanel(`Game #${gameId}`, html);
}

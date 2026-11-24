/* ai-mail.js - Global AI Assistant, Auto-Email on Letter Creation, and Two-Way Email Inbox
 *
 * NOTE: This file must stay valid JavaScript. An earlier version had leftover build
 * instructions after the closing IIFE, which caused a SyntaxError and made the whole
 * AI feature disappear. Keep the last line as `})();`.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // 1. State
  // ---------------------------------------------------------------------------
  var LS_EMC = 'qrAttEmc';
  var LS_CHAT = 'qrAttAiChat';

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  window.emc = Object.assign({ autoSend: false, gasUrl: '', map: {}, outbox: [] }, readJson(LS_EMC));
  function saveEmc() { writeJson(LS_EMC, window.emc); }

  // On-device AI (LiteRT-LM). No API keys, no cloud endpoints.
  var localAi = {
    state: 'idle',          // idle | loading | ready | missing_model | error
    message: '',
    detail: '',
    modelPath: '',
    searched: [],
    pending: {}             // requestId -> { bubble, raw, done, error }
  };

  function hasNativeAi() {
    return !!(window.AndroidApp && typeof window.AndroidApp.aiGenerate === 'function');
  }

  function refreshLocalAiStatus() {
    if (!hasNativeAi()) {
      localAi.state = 'unavailable';
      localAi.message = 'On-device AI bridge is not available in this build.';
      return localAi;
    }
    try {
      var raw = window.AndroidApp.aiStatus ? window.AndroidApp.aiStatus() : '{}';
      var s = JSON.parse(raw || '{}');
      localAi.state = s.state || 'idle';
      localAi.message = s.message || '';
      localAi.detail = s.detail || '';
      localAi.modelPath = s.modelPath || '';
      localAi.searched = Array.isArray(s.searched) ? s.searched : [];
    } catch (e) {
      localAi.state = 'error';
      localAi.message = 'Could not read local AI status.';
    }
    return localAi;
  }

  function initLocalAi() {
    if (!hasNativeAi()) { refreshLocalAiStatus(); updateAiStatus(); return; }
    try { window.AndroidApp.aiInit(); } catch (e) {}
    refreshLocalAiStatus();
    updateAiStatus();
  }

  // Chat history used for follow-up questions. Stored so the thread survives a reload.
  var history = [];
  try { history = JSON.parse(localStorage.getItem(LS_CHAT) || '[]') || []; } catch (e) { history = []; }
  function saveHistory() {
    history = history.slice(-24);
    try { localStorage.setItem(LS_CHAT, JSON.stringify(history)); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 2. Small helpers
  // ---------------------------------------------------------------------------
  function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function says(text) {
    if (typeof toast === 'function') { try { toast(text); } catch (e) {} }
  }
  function todayKey() {
    try { if (typeof cur !== 'undefined' && typeof ymd === 'function') return ymd(cur); } catch (e) {}
    return new Date().toISOString().slice(0, 10);
  }
  function readList(name) {
    try { return (typeof window !== 'undefined' && Array.isArray(window[name])) ? window[name] : []; } catch (e) { return []; }
  }
  // `students`/`subs` are declared with var in index.html, so window[name] works.
  function allStudents() { return readList('students'); }
  function allSubjects() { return readList('subs'); }
  function allWarns() { return readList('warns'); }
  function allLetters() { return readList('letters'); }
  function currentSubjectIndex() {
    try { return (typeof si !== 'undefined' && Number.isFinite(si)) ? si : 0; } catch (e) { return 0; }
  }
  function letterTypeName(ty) {
    try { if (typeof LTS !== 'undefined' && LTS[ty]) return LTS[ty]; } catch (e) {}
    return ({ 1: 'Warning notice', 2: 'Disciplinary notice', 3: 'Sanction notice', 4: 'Failure-to-clean notice', 5: 'SAO endorsement' })[ty] || ('Letter ' + ty);
  }

  // ---------------------------------------------------------------------------
  // 3. DOM & CSS injection
  // ---------------------------------------------------------------------------
  function initAiDom() {
    if (document.getElementById('aiDrawer')) return;
    if (!document.body) return;

    if (!document.getElementById('aiStyles')) {
      var css = `
        .ai-fab { position: fixed; bottom: 85px; right: 18px; width: 56px; height: 56px; border-radius: 50%; background: #800000; color: #fff; border: 2px solid #fff; box-shadow: 0 6px 16px rgba(0,0,0,0.35); z-index: 99999; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 24px; transition: transform 0.2s, background 0.2s; }
        .ai-fab:active { transform: scale(0.92); }
        .ai-badge { position: absolute; top: -2px; right: -2px; background: #22c55e; color: #fff; font-size: 10px; font-weight: bold; width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px solid #fff; }

        .ai-drawer { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); z-index: 99999; display: none; align-items: flex-end; justify-content: center; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
        .ai-drawer.on { display: flex !important; }
        .ai-content { background: var(--bg, #fff); color: var(--tx, #111); width: 100%; max-width: 600px; height: 85vh; border-top-left-radius: 20px; border-top-right-radius: 20px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 -8px 24px rgba(0,0,0,0.3); animation: aiSlideUp 0.25s ease-out; }
        @keyframes aiSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }

        .ai-header { padding: 12px 16px; border-bottom: 1px solid var(--bd, #e5e7eb); display: flex; align-items: center; justify-content: space-between; background: var(--card, #f9fafb); gap: 8px; }
        .ai-header h3 { margin: 0; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
        .ai-status { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
        .ai-status.online { background: #dcfce7; color: #166534; }
        .ai-status.offline { background: #fef3c7; color: #92400e; }
        .ai-tabs { display: flex; gap: 6px; padding: 8px 16px; border-bottom: 1px solid var(--bd, #e5e7eb); background: var(--card, #f9fafb); }
        .ai-tab { flex: 1; padding: 6px 10px; font-size: 12px; font-weight: 600; border-radius: 8px; border: 1px solid var(--bd, #d1d5db); background: transparent; color: var(--tx, #374151); cursor: pointer; text-align: center; }
        .ai-tab.on { background: var(--red, #800000); color: #fff; border-color: var(--red, #800000); }

        .ai-body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; }
        .ai-msg { display: flex; flex-direction: column; max-width: 88%; }
        .ai-msg.user { align-self: flex-end; }
        .ai-msg.user .ai-bubble { background: var(--red, #800000); color: #fff; border-radius: 14px 14px 2px 14px; }
        .ai-msg.bot { align-self: flex-start; }
        .ai-msg.bot .ai-bubble { background: var(--card, #f3f4f6); color: var(--tx, #111); border: 1px solid var(--bd, #e5e7eb); border-radius: 14px 14px 14px 2px; }
        .ai-bubble { padding: 10px 14px; font-size: 13px; line-height: 1.5; word-break: break-word; }
        .ai-bubble b { font-weight: 700; }
        .ai-typing { font-size: 12px; color: var(--mu, #6b7280); font-style: italic; }

        .ai-chips { display: flex; gap: 6px; overflow-x: auto; padding: 6px 0; scrollbar-width: none; }
        .ai-chip { font-size: 11px; padding: 5px 10px; border-radius: 14px; background: var(--card, #f3f4f6); border: 1px solid var(--bd, #d1d5db); color: var(--tx, #374151); white-space: nowrap; cursor: pointer; flex-shrink: 0; }
        .ai-chip:hover { border-color: var(--red, #800000); }

        .ai-footer { padding: 10px 16px; border-top: 1px solid var(--bd, #e5e7eb); display: flex; gap: 8px; background: var(--card, #f9fafb); }
        .ai-input { flex: 1; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--bd, #d1d5db); font-size: 13px; background: var(--bg, #fff); color: var(--tx, #111); outline: none; }

        .ai-card { background: var(--card, #f9fafb); border: 1px solid var(--bd, #e5e7eb); border-radius: 12px; padding: 10px; margin-top: 6px; font-size: 12px; }
        .ai-card-btns { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
        .ai-note { font-size: 11px; color: var(--mu, #6b7280); line-height: 1.45; }

        .inbox-item { border: 1px solid var(--bd, #e5e7eb); border-radius: 10px; padding: 10px; margin-bottom: 8px; background: var(--card, #fff); }
        .inbox-item b { font-size: 13px; display: block; }
        .inbox-item small { color: var(--mu, #6b7280); font-size: 11px; }
        .inbox-body { font-size: 12px; margin: 6px 0; color: var(--tx, #374151); max-height: 80px; overflow-y: auto; background: var(--bg, #f9fafb); padding: 6px; border-radius: 6px; }
      `;
      var styleEl = document.createElement('style');
      styleEl.id = 'aiStyles';
      styleEl.textContent = css;
      document.head.appendChild(styleEl);
    }

    if (!document.querySelector('.ai-fab')) {
      var fab = document.createElement('button');
      fab.className = 'ai-fab';
      fab.setAttribute('aria-label', 'Open AI Assistant & Inbox');
      fab.innerHTML = '✨<div class="ai-badge" id="aiUnread" style="display:none">0</div>';
      fab.onclick = function (e) { if (e) e.stopPropagation(); toggleAiDrawer(); };
      document.body.appendChild(fab);
    }

    var drawer = document.createElement('div');
    drawer.className = 'ai-drawer';
    drawer.id = 'aiDrawer';
    drawer.onclick = function (e) { if (e.target === drawer) toggleAiDrawer(); };
    drawer.innerHTML = `
      <div class="ai-content" onclick="event.stopPropagation()">
        <div class="ai-header">
          <h3>✨ AI Assistant <span class="ai-status offline" id="aiStatus">on-device AI</span></h3>
          <div style="display:flex;gap:6px">
            <button class="btn ghost sm" onclick="aiClearChat()" title="Clear chat">Clear</button>
            <button class="btn ghost sm" onclick="toggleAiDrawer()" aria-label="Close">✕</button>
          </div>
        </div>
        <div class="ai-tabs">
          <button class="ai-tab on" id="tabAiChat" onclick="setAiTab('chat')">AI Chat</button>
          <button class="ai-tab" id="tabAiInbox" onclick="setAiTab('inbox')">Inbox & Appeals</button>
          <button class="ai-tab" id="tabAiSettings" onclick="setAiTab('settings')">Settings</button>
        </div>

        <div class="ai-body" id="aiTabBodyChat">
          <div class="ai-chips">
            <button class="ai-chip" onclick="sendAiChip('Who is absent today?')">Who is absent today?</button>
            <button class="ai-chip" onclick="sendAiChip('Give me a full summary of today')">Today's summary</button>
            <button class="ai-chip" onclick="sendAiChip('Who has the most lates?')">Most lates</button>
            <button class="ai-chip" onclick="sendAiChip('Who has the most warnings?')">Most warnings</button>
            <button class="ai-chip" onclick="sendAiChip('List all students')">All students</button>
            <button class="ai-chip" onclick="sendAiChip('Mark everyone present')">Mark class present</button>
          </div>
          <div id="aiMsgs" style="display:flex;flex-direction:column;gap:10px;flex:1"></div>
        </div>

        <div class="ai-footer" id="aiChatFooter">
          <input class="ai-input" id="aiInput" placeholder="Ask anything about your class or app..." onkeydown="if(event.key==='Enter')sendAiMsg()">
          <button class="btn sm" onclick="sendAiMsg()">Send</button>
        </div>

        <div class="ai-body" id="aiTabBodyInbox" style="display:none">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <b style="font-size:13px">Student Email Replies & Appeals</b>
            <button class="btn ghost sm" onclick="fetchInboxReplies(true)">Refresh inbox</button>
          </div>
          <div id="inboxList"></div>
        </div>

        <div class="ai-body" id="aiTabBodySettings" style="display:none">
          <h4 style="margin:0 0 8px;font-size:14px">On-Device AI (Offline)</h4>
          <p class="ai-note" style="margin:0 0 10px">This app now runs AI <b>on your device</b> using LiteRT-LM. No API key, no internet, and your class data stays on the phone.</p>

          <div class="ai-card" style="margin-bottom:10px">
            <div><b>Status:</b> <span id="localAiState">Checking…</span></div>
            <div id="localAiModel" class="ai-note" style="margin-top:4px"></div>
            <div id="localAiMsg" class="ai-note" style="margin-top:6px;white-space:pre-wrap"></div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
            <button class="btn sm" onclick="aiInitLocal()">Load / Reload model</button>
            <button class="btn ghost sm" onclick="aiResetLocal()">Reset AI session</button>
          </div>

          <p class="ai-note" style="margin:-4px 0 12px"><b>Model setup:</b> copy a <code>.litertlm</code> model to the app (example):<br>
          <code>adb push your-model.litertlm /data/data/com.callmejstn.attendance/files/model.litertlm</code><br>
          Or place it in <code>/data/local/tmp/llm/</code>. Then tap “Load / Reload model”.</p>

          <h4 style="margin:12px 0 8px;font-size:14px">Auto-Email & Google Apps Script Settings</h4>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:10px">
            <input type="checkbox" id="aiAutoSend" onchange="updAiSettings()">
            <b>Auto-send email when letter is created</b>
          </label>

          <label style="font-size:12px;font-weight:600">Google Apps Script Web App URL</label>
          <input class="ai-input" id="aiGasUrl" placeholder="https://script.google.com/macros/s/.../exec" style="width:100%;margin-bottom:10px" onchange="updAiSettings()">

          <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
            <button class="btn ghost sm" onclick="copyGasCode()">Copy Updated GAS Script Code</button>
            <button class="btn ghost sm" onclick="flushOutbox()">Flush Outbox Queue (<span id="outboxCount">0</span>)</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(drawer);
  }

  window.toggleAiDrawer = function () {
    try {
      var d = document.getElementById('aiDrawer');
      if (!d) { initAiDom(); d = document.getElementById('aiDrawer'); }
      if (!d) return;
      d.classList.toggle('on');
      if (d.classList.contains('on')) {
        try { loadSettingsUI(); } catch (e) {}
        try { updateAiStatus(); } catch (e) {}
        try {
          var msgs = document.getElementById('aiMsgs');
          if (msgs && !msgs.children.length) {
            refreshLocalAiStatus();
            var hint;
            if (localAi.state === 'ready') {
              hint = 'Hello! I am running <b>on-device</b> with LiteRT-LM (no API key, no internet). I can read every record in this app. Ask me anything.';
            } else if (localAi.state === 'loading') {
              hint = 'The on-device AI model is loading. I can still answer common questions with the rule-based offline engine while it loads.';
            } else if (navigator.onLine) {
              hint = 'Hello! I am connected to <b>online keyless AI</b> (no API key needed). I can analyze your students, attendance records, and notices. Ask me anything!';
            } else {
              hint = 'Hello! You are currently offline. Running the <b>built-in rule engine</b> to answer questions about students, attendance, warnings, and letters.';
            }
            addBotMsg(hint, true);
            if (hasNativeAi() && localAi.state !== 'ready' && localAi.state !== 'loading') initLocalAi();
          }
        } catch (e) {}
        try { fetchInboxReplies(); } catch (e) {}
      }
    } catch (err) {
      console.error('toggleAiDrawer error:', err);
    }
  };

  if (document.body) {
    initAiDom();
  } else {
    document.addEventListener('DOMContentLoaded', initAiDom);
    window.addEventListener('load', initAiDom);
  }

  window.setAiTab = function (tab) {
    ['Chat', 'Inbox', 'Settings'].forEach(function (t) {
      var btn = document.getElementById('tabAi' + t);
      var body = document.getElementById('aiTabBody' + t);
      var isCur = t.toLowerCase() === tab;
      if (btn) btn.classList.toggle('on', isCur);
      if (body) body.style.display = isCur ? 'flex' : 'none';
    });
    var ft = document.getElementById('aiChatFooter');
    if (ft) ft.style.display = tab === 'chat' ? 'flex' : 'none';
  };

  function aiConfigured() {
    refreshLocalAiStatus();
    return localAi.state === 'ready';
  }

  function engineMode() {
    refreshLocalAiStatus();
    if (localAi.state === 'ready') return 'local';
    if (localAi.state === 'loading') return 'loading';
    if (localAi.state === 'missing_model') return 'missing';
    return 'offline';
  }

  function updateAiStatus() {
    refreshLocalAiStatus();
    var el = document.getElementById('aiStatus');
    if (el) {
      if (localAi.state === 'ready') {
        el.textContent = 'on-device AI';
        el.className = 'ai-status online';
        el.title = 'Offline on-device AI is ready.' + (localAi.modelPath ? ' Model: ' + localAi.modelPath : '');
      } else if (localAi.state === 'loading') {
        el.textContent = 'loading model…';
        el.className = 'ai-status offline';
        el.title = 'Loading the on-device model.';
      } else if (navigator.onLine) {
        el.textContent = 'online AI (free)';
        el.className = 'ai-status online';
        el.title = 'Keyless online AI is active. No API key needed!';
      } else {
        el.textContent = 'offline engine';
        el.className = 'ai-status offline';
        el.title = 'Device is offline. Using rule-based offline engine.';
      }
    }

    var st = document.getElementById('localAiState');
    if (st) {
      var label = {
        ready: 'Ready (on-device, offline)',
        loading: 'Loading model…',
        missing_model: 'Model file missing',
        error: 'Error',
        idle: 'Not loaded',
        unavailable: 'Unavailable'
      }[localAi.state] || localAi.state;
      st.textContent = label;
    }
    var mp = document.getElementById('localAiModel');
    if (mp) mp.textContent = localAi.modelPath ? ('Model: ' + localAi.modelPath) : '';
    var msg = document.getElementById('localAiMsg');
    if (msg) {
      var text = localAi.message || '';
      if (localAi.detail) text += (text ? '\n' : '') + localAi.detail;
      msg.textContent = text;
    }
  }

  function loadSettingsUI() {
    var a = document.getElementById('aiAutoSend'); if (a) a.checked = !!window.emc.autoSend;
    var g = document.getElementById('aiGasUrl'); if (g) g.value = window.emc.gasUrl || '';
    var ob = document.getElementById('outboxCount'); if (ob) ob.textContent = (window.emc.outbox || []).length;
    updateAiStatus();
  }

  window.updAiSettings = function () {
    window.emc.autoSend = !!(document.getElementById('aiAutoSend') || {}).checked;
    window.emc.gasUrl = ((document.getElementById('aiGasUrl') || {}).value || '').trim();
    saveEmc();
    updateAiStatus();
    says('Settings updated');
  };

  window.aiInitLocal = function () {
    initLocalAi();
    says('Checking on-device AI model…');
  };

  window.aiResetLocal = function () {
    if (hasNativeAi()) try { window.AndroidApp.aiReset(); } catch (e) {}
    history = [];
    saveHistory();
    says('AI session reset');
  };

  // Backward-compatible no-op handlers for old UI calls.
  window.aiProviderChanged = function () {};
  window.aiShowKeyHelp = function () { window.setAiTab('settings'); };
  window.aiTestConnection = function () { window.aiInitLocal(); };

  // ---------------------------------------------------------------------------
  // 4. Email (fixed Blob -> base64 conversion)
  // ---------------------------------------------------------------------------
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      try {
        var fr = new FileReader();
        fr.onload = function () {
          var s = String(fr.result || '');
          var i = s.indexOf('base64,');
          resolve(i > -1 ? s.slice(i + 7) : s);
        };
        fr.onerror = function () { reject(new Error('Could not read the PDF file.')); };
        fr.readAsDataURL(blob);
      } catch (e) { reject(e); }
    });
  }

  async function sendEmailForLetter(L, S) {
    if (!window.emc.autoSend || !L) return;
    var sts = allStudents();
    var st = sts.filter(function (x) { return x.i === L.st || (x.n && x.n.toLowerCase() === (L.to || '').toLowerCase()); })[0];
    var email = (st && st.em) || window.emc.map[L.st] || window.emc.map[L.to];
    if (!email) {
      says('Auto-email skipped: no email address for ' + (L.to || 'this student'));
      return;
    }

    var merged = Object.assign({}, typeof lset0 === 'function' ? lset0() : {}, S || {});
    var pdfBase64;
    try {
      var blob = letterPdf(L, merged, await letterImgs(merged, L));
      pdfBase64 = await blobToBase64(blob);
    } catch (e) {
      says('Auto-email failed while building the PDF: ' + e.message);
      return;
    }

    var item = {
      id: L.id,
      to: email,
      subject: (L.subj || (letterTypeName(L.ty) + ' - ' + (L.to || ''))) + ' [Ref: ' + L.id + ']',
      body: 'Dear Parent/Guardian,\n\nPlease find attached the official notice regarding ' + (L.to || 'the student') + '.\n\nRef ID: ' + L.id + '\n\nSincerely,\nClass Adviser',
      pdfBase64: pdfBase64,
      filename: (typeof letterFileName === 'function' ? letterFileName(L) : 'notice-' + L.id + '.pdf'),
      ts: Date.now()
    };

    if (!window.emc.gasUrl || !navigator.onLine) {
      window.emc.outbox.push(item);
      saveEmc();
      says('Email queued in Outbox (offline)');
      loadSettingsUI();
      return;
    }

    try {
      var res = await fetch(window.emc.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'sendEmail', data: item })
      });
      var r = await res.json();
      if (r.ok) says('Auto-email sent to ' + email);
      else throw new Error(r.msg || 'GAS error');
    } catch (e) {
      window.emc.outbox.push(item);
      saveEmc();
      says('Email queued in Outbox: ' + e.message);
      loadSettingsUI();
    }
  }

  window.flushOutbox = async function () {
    if (!window.emc.gasUrl) { says('Set the Google Apps Script URL first.'); return; }
    if (!window.emc.outbox || !window.emc.outbox.length) { says('Outbox is empty'); return; }
    var list = window.emc.outbox.slice();
    window.emc.outbox = [];
    saveEmc();
    var sent = 0;
    for (var i = 0; i < list.length; i++) {
      try {
        var res = await fetch(window.emc.gasUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'sendEmail', data: list[i] })
        });
        var r = await res.json();
        if (r.ok) sent++; else window.emc.outbox.push(list[i]);
      } catch (e) {
        window.emc.outbox.push(list[i]);
      }
    }
    saveEmc();
    loadSettingsUI();
    says('Outbox: ' + sent + ' sent');
  };

  window.addEventListener('online', function () {
    if (window.emc.outbox && window.emc.outbox.length) window.flushOutbox();
  });

  var _origPvSave = window.pvSave;
  window.pvSave = function () {
    var L = (typeof pv !== 'undefined' && pv) ? pv.L : null;
    var S = (typeof pv !== 'undefined' && pv) ? pv.S : null;
    if (typeof _origPvSave === 'function') _origPvSave();
    if (L && window.emc.autoSend) sendEmailForLetter(L, S);
  };

  // ---------------------------------------------------------------------------
  // 5. Inbox
  // ---------------------------------------------------------------------------
  window.fetchInboxReplies = async function (manual) {
    var listEl = document.getElementById('inboxList');
    if (!listEl) return;
    if (!window.emc.gasUrl) {
      listEl.innerHTML = '<p class="hint">Set your Google Apps Script URL in Settings to check student email replies.</p>';
      return;
    }
    if (manual) listEl.innerHTML = '<p class="hint">Checking inbox...</p>';
    try {
      var res = await fetch(window.emc.gasUrl + '?action=checkInbox');
      var r = await res.json();
      if (!r.ok || !r.replies || !r.replies.length) {
        listEl.innerHTML = '<p class="hint">No new email replies found.</p>';
        var b = document.getElementById('aiUnread'); if (b) b.style.display = 'none';
        return;
      }
      var b2 = document.getElementById('aiUnread');
      if (b2) { b2.textContent = r.replies.length; b2.style.display = 'flex'; }
      var lettersList = allLetters();
      listEl.innerHTML = r.replies.map(function (rep, idx) {
        var matchL = lettersList.filter(function (l) { return l.id === rep.refId; })[0];
        return '<div class="inbox-item">' +
          '<b>' + escHtml(rep.from) + ' <small>(' + escHtml(rep.date) + ')</small></b>' +
          '<div style="font-size:11px;font-weight:600;margin:2px 0">Subject: ' + escHtml(rep.subject) + (matchL ? ' · <span class="chip ok">Matched Letter #' + escHtml(matchL.id) + '</span>' : '') + '</div>' +
          '<div class="inbox-body">' + escHtml(rep.body) + '</div>' +
          '<button class="btn sm" onclick="analyzeAppeal(' + idx + ')">✨ Analyze Appeal & Draft Reply</button>' +
          '</div>';
      }).join('');
      window._lastReplies = r.replies;
    } catch (e) {
      listEl.innerHTML = '<p class="hint">Error checking inbox: ' + escHtml(e.message) + '</p>';
    }
  };

  window.analyzeAppeal = function (idx) {
    var rep = window._lastReplies && window._lastReplies[idx];
    if (!rep) return;
    window.setAiTab('chat');
    var prompt = 'Analyze this email reply/appeal from ' + rep.from + ':\n"' + rep.body + '"\nRef ID: ' + (rep.refId || 'N/A');
    addUserMsg(prompt);
    processAiPrompt(prompt, rep);
  };

  // ---------------------------------------------------------------------------
  // 6. Chat UI
  // ---------------------------------------------------------------------------
  function addUserMsg(txt) {
    var m = document.getElementById('aiMsgs');
    if (!m) return;
    var div = document.createElement('div');
    div.className = 'ai-msg user';
    div.innerHTML = '<div class="ai-bubble">' + escHtml(txt).replace(/\n/g, '<br>') + '</div>';
    m.appendChild(div);
    m.scrollTop = m.scrollHeight;
  }

  function addBotMsg(content, isHtml) {
    var m = document.getElementById('aiMsgs');
    if (!m) return;
    var div = document.createElement('div');
    div.className = 'ai-msg bot';
    div.innerHTML = '<div class="ai-bubble">' + (isHtml ? content : fmtAi(content)) + '</div>';
    m.appendChild(div);
    m.scrollTop = m.scrollHeight;
    return div;
  }

  function addTyping() {
    var m = document.getElementById('aiMsgs');
    if (!m) return null;
    var div = document.createElement('div');
    div.className = 'ai-msg bot ai-typing';
    div.textContent = 'Scanning records…';
    m.appendChild(div);
    m.scrollTop = m.scrollHeight;
    return div;
  }

  // Lightweight, safe formatter for model output.
  function fmtAi(text) {
    var s = String(text || '');
    s = s.replace(/```[a-zA-Z0-9]*\n?/g, '').replace(/```/g, '');
    s = s.replace(/`([^`]+)`/g, '$1');
    s = escHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^\s*#{1,4}\s*(.+)$/gm, '<b>$1</b>');
    s = s.replace(/^\s*[-*•]\s+(.+)$/gm, '• $1');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:var(--red)">$1</a>');
    s = s.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
    return s;
  }

  window.sendAiChip = function (txt) {
    var inp = document.getElementById('aiInput');
    if (inp) inp.value = txt;
    window.sendAiMsg();
  };

  window.sendAiMsg = function () {
    var inp = document.getElementById('aiInput');
    if (!inp) return;
    var txt = inp.value.trim();
    if (!txt) return;
    inp.value = '';
    addUserMsg(txt);
    processAiPrompt(txt);
  };

  window.aiClearChat = function () {
    var m = document.getElementById('aiMsgs');
    if (m) m.innerHTML = '';
    history = [];
    saveHistory();
    addBotMsg('Chat cleared. Ask me anything about your students, attendance, warnings or letters.');
  };

  function buildAiPrompt(prompt, contextReply) {
    var ctx = buildAppContext();
    var parts = [];
    parts.push('You are the built-in on-device AI assistant of "Bayan at Batas - Attendance".');
    parts.push('Use ONLY the APP DATA below. Never invent students, records, dates, or numbers.');
    parts.push('Answer clearly and specifically. Include names, IDs, counts, dates, and subjects when relevant.');
    parts.push('If the user asks to perform an action (mark attendance, create letter), explain the exact command they can type.');
    parts.push('Reply in the same language as the user (English or Filipino).');
    parts.push('');
    parts.push('APP DATA (' + (ctx.compact ? 'compact' : 'full') + '):');
    parts.push(ctx.text);
    if (contextReply) {
      parts.push('');
      parts.push('APPEAL EMAIL TO ANALYZE:');
      parts.push(JSON.stringify({ from: contextReply.from, subject: contextReply.subject, body: contextReply.body, refId: contextReply.refId || null, date: contextReply.date }));
    }
    var recent = history.slice(-8);
    if (recent.length) {
      parts.push('');
      parts.push('RECENT CHAT:');
      recent.forEach(function (h) { parts.push((h.role === 'user' ? 'User' : 'Assistant') + ': ' + String(h.text || '').slice(0, 600)); });
    }
    parts.push('');
    parts.push('USER QUESTION:');
    parts.push(String(prompt || ''));
    return parts.join('\n');
  }

  function handleLocalAiEvent(ev) {
    if (!ev) return;
    if (ev.t === 'status') {
      try {
        var s = JSON.parse(ev.status || '{}');
        localAi.state = s.state || localAi.state;
        localAi.message = s.message || '';
        localAi.detail = s.detail || '';
        localAi.modelPath = s.modelPath || '';
        localAi.searched = Array.isArray(s.searched) ? s.searched : [];
      } catch (e) {}
      updateAiStatus();
      return;
    }
    if (!ev.id) return;
    var p = localAi.pending[ev.id];
    if (!p) return;
    if (ev.t === 'chunk') {
      p.raw += String(ev.text || '');
      if (p.bubble) p.bubble.innerHTML = '<div class="ai-bubble">' + fmtAi(p.raw) + '</div>';
      var m = document.getElementById('aiMsgs'); if (m) m.scrollTop = m.scrollHeight;
      return;
    }
    if (ev.t === 'done') {
      var txt = (p.raw || '').trim();
      if (!txt) txt = 'The on-device model returned an empty answer.';
      p.done(txt);
      delete localAi.pending[ev.id];
      updateAiStatus();
      return;
    }
    if (ev.t === 'error') {
      p.error(new Error(ev.msg || 'On-device AI error'));
      delete localAi.pending[ev.id];
      updateAiStatus();
    }
  }
  window.__aiNativeEvent = handleLocalAiEvent;

  function callLocalAi(prompt, contextReply) {
    return new Promise(function (resolve, reject) {
      if (!hasNativeAi()) { reject(new Error('On-device AI bridge unavailable')); return; }
      refreshLocalAiStatus();
      if (localAi.state === 'missing_model') { reject(new Error(localAi.message || 'No .litertlm model file found on the device.')); return; }
      var id = 'ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      var bubble = addBotMsg('<span class="ai-note">Thinking on-device…</span>', true);
      localAi.pending[id] = { bubble: bubble, raw: '', done: resolve, error: reject };
      try { window.AndroidApp.aiGenerate(id, buildAiPrompt(prompt, contextReply)); }
      catch (e) { delete localAi.pending[id]; reject(e); }
    });
  }

  async function callOnlineFreeAi(prompt, contextReply) {
    var fullPrompt = buildAiPrompt(prompt, contextReply);
    var messages = [
      {
        role: 'system',
        content: 'You are the intelligent assistant for the "Attendance" app. Answer questions, analyze attendance data, explain records, or compose formal notice drafts based on the provided APP DATA. Be concise, polite, and accurate. Format lists with bullets or bold text.'
      },
      {
        role: 'user',
        content: fullPrompt
      }
    ];

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 25000);
    try {
      var res = await fetch('https://text.pollinations.ai/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: messages,
          model: 'openai',
          seed: Math.floor(Math.random() * 100000)
        })
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var text = await res.text();
      return text;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async function processAiPrompt(prompt, contextReply) {
    refreshLocalAiStatus();
    if (hasNativeAi() && localAi.state !== 'ready' && localAi.state !== 'loading') {
      initLocalAi();
      refreshLocalAiStatus();
    }
    // 1. If on-device LiteRT-LM is available and model is loaded, use it
    if (hasNativeAi() && localAi.state === 'ready') {
      try {
        var localRes = await callLocalAi(prompt, contextReply);
        history.push({ role: 'user', text: prompt });
        history.push({ role: 'model', text: localRes });
        saveHistory();
        updateAiStatus();
        return;
      } catch (e) {
        console.warn('Local AI failed, trying online AI:', e);
      }
    }

    // 2. If online, use keyless online AI (no API key required!)
    if (navigator.onLine) {
      var botDiv = addBotMsg('<span class="ai-note">Thinking online (keyless AI)…</span>', true);
      try {
        var onlineRes = await callOnlineFreeAi(prompt, contextReply);
        if (onlineRes && onlineRes.trim()) {
          var bubble = botDiv ? botDiv.querySelector('.ai-bubble') : null;
          if (bubble) bubble.innerHTML = fmtAi(onlineRes.trim());
          history.push({ role: 'user', text: prompt });
          history.push({ role: 'model', text: onlineRes.trim() });
          saveHistory();
          updateAiStatus();
          return;
        }
      } catch (e) {
        console.warn('Online AI failed, falling back to offline engine:', e);
        if (botDiv) botDiv.remove();
      }
    } else if (localAi.state === 'loading') {
      addBotMsg('<span class="ai-note">The on-device model is still loading. I used the rule-based offline engine for now.</span>', true);
    } else if (localAi.state === 'missing_model') {
      addBotMsg('<span class="ai-note">Offline mode: using the rule-based offline engine. Connect to the internet or push a .litertlm model for conversational AI.</span>', true);
    }

    // 3. Fallback to rule-based offline engine
    var offlineRes = runOfflineAiEngine(prompt, contextReply);
    addBotMsg(offlineRes, true);
    history.push({ role: 'user', text: prompt });
    history.push({ role: 'model', text: 'Offline answer: ' + offlineRes.replace(/<[^>]+>/g, '') });
    saveHistory();
    updateAiStatus();
  }
  // 7. Full-app data context
  // ---------------------------------------------------------------------------
  function buildDataModel(compact) {
    var sts = allStudents();
    var sbs = allSubjects();
    var wrs = allWarns();
    var lts = allLetters();
    var today = todayKey();
    var sIdx = currentSubjectIndex();
    var currentSub = sbs[sIdx] || sbs[0] || null;

    var per = {};
    sts.forEach(function (s) {
      per[s.i] = {
        id: s.i, name: s.n, section: s.sec || '', email: s.em || '',
        nfcLinked: !!s.nfc, present: 0, late: 0, absent: 0,
        recorded: 0, warnings: 0, letters: 0, records: []
      };
    });

    var subjects = sbs.map(function (sub, sidx) {
      var byDate = {};
      var recs = Array.isArray(sub.r) ? sub.r : [];
      recs.forEach(function (r) {
        var d = byDate[r.d] || (byDate[r.d] = { present: 0, late: 0, absent: 0, records: [] });
        var status = String(r.s || '');
        var k = status.toLowerCase();
        if (d[k] !== undefined) d[k]++;
        if (!compact) d.records.push({ student: r.n || '', id: r.i, status: status, time: r.t || '' });
        if (per[r.i]) {
          if (per[r.i][k] !== undefined) per[r.i][k]++;
          per[r.i].recorded++;
          if (per[r.i].records.length < 12) per[r.i].records.push({ subject: sub.n, date: r.d, status: status, time: r.t || '' });
        }
      });
      return {
        index: sidx,
        subject: sub.n,
        code: sub.c || '',
        isCurrent: sidx === sIdx,
        daysRecorded: Object.keys(byDate).length,
        totalRecords: recs.length,
        attendanceByDate: byDate
      };
    });

    var warnings = wrs.map(function (w) {
      if (per[w.i]) per[w.i].warnings++;
      return {
        student: w.n || (per[w.i] ? per[w.i].name : ''),
        id: w.i,
        reason: w.r || '',
        note: w.note || '',
        date: w.d || '',
        time: w.t || '',
        subject: w.sub || ''
      };
    });

    var letters = lts.map(function (l) {
      if (per[l.st]) per[l.st].letters++;
      return {
        id: l.id,
        type: letterTypeName(l.ty),
        date: l.date || '',
        student: l.to || '',
        studentId: l.st || '',
        offense: l.off || '',
        rule: l.rule || '',
        subject: l.subj || ''
      };
    });

    // Attendance for the current subject on the current date, with names resolved.
    var todayRecs = [];
    if (currentSub && Array.isArray(currentSub.r)) {
      todayRecs = currentSub.r.filter(function (r) { return r.d === today; }).map(function (r) {
        return { student: r.n || (per[r.i] ? per[r.i].name : ''), id: r.i, status: r.s, time: r.t || '' };
      });
    }
    var todayIds = {};
    todayRecs.forEach(function (r) { todayIds[r.id] = r.status; });
    var unrecorded = sts.filter(function (s) { return todayIds[s.i] === undefined; }).map(function (s) {
      return { name: s.n, id: s.i };
    });

    return {
      app: 'Bayan at Batas - Attendance (Android)',
      today: today,
      currentSubject: currentSub ? currentSub.n : null,
      currentSubjectCode: currentSub ? (currentSub.c || '') : '',
      studentCount: sts.length,
      subjectCount: sbs.length,
      warningCount: wrs.length,
      letterCount: lts.length,
      subjects: subjects,
      students: Object.keys(per).map(function (k) {
        var s = per[k];
        return {
          name: s.name, id: s.id, section: s.section, email: s.email, nfcLinked: s.nfcLinked,
          present: s.present, late: s.late, absent: s.absent, recorded: s.recorded,
          warnings: s.warnings, letters: s.letters,
          recentAttendance: compact ? [] : s.records
        };
      }),
      warnings: warnings,
      letters: letters,
      todaySnapshot: {
        date: today,
        subject: currentSub ? currentSub.n : null,
        present: todayRecs.filter(function (r) { return r.status === 'Present'; }).length,
        late: todayRecs.filter(function (r) { return r.status === 'Late'; }).length,
        absent: todayRecs.filter(function (r) { return r.status === 'Absent'; }).length,
        unrecorded: unrecorded,
        records: compact ? [] : todayRecs
      },
      appGuide: {
        home: 'Daily attendance: pick a date, choose a subject, mark Present/Late/Absent per student; shows summaries and lists.',
        students: 'Student list: add/edit/delete students, ID numbers, section, email, QR codes, NFC card linking.',
        subjects: 'Subjects: add/edit subjects and view/export their attendance records.',
        warnings: 'Warning log: record offenses (late, uniform/ID, disruptive, phone, failed to clean) and create letters from them.',
        letters: 'Letter builder: Warning Notice (1st), Notice of Disciplinary Action (2nd), Sanction Notice (3rd, SAO), Notice of Failure to Clean, and SAO Endorsement. Can export PDF and optionally email parents.',
        data: 'Data screen: backup/restore JSON and optional GitHub sync.',
        nfc: 'NFC: tap a card to record attendance or write a card link for a student.',
        ai: 'AI Assistant: answers questions about the data above, can mark attendance, generate letters, and analyze appeal emails.'
      }
    };
  }

  function buildAppContext() {
    var full = buildDataModel(false);
    var json = JSON.stringify(full);
    if (json.length > 700000) {
      var compact = buildDataModel(true);
      return { text: JSON.stringify(compact), compact: true };
    }
    return { text: json, compact: false };
  }

  // ---------------------------------------------------------------------------
  // 9. Offline engine (works with no API key; reads the whole dataset)
  // ---------------------------------------------------------------------------
  function buildOfflineView() {
    var model = buildDataModel(true);
    var sts = allStudents();
    var sbs = allSubjects();
    var wrs = allWarns();
    var lts = allLetters();
    var today = todayKey();

    // Totals per student across all subjects.
    var byId = {};
    sts.forEach(function (s) {
      byId[s.i] = { s: s, present: 0, late: 0, absent: 0, recorded: 0, warnings: 0, letters: 0, entries: [] };
    });
    sbs.forEach(function (sub) {
      (sub.r || []).forEach(function (r) {
        var t = byId[r.i];
        if (!t) return;
        var k = String(r.s || '').toLowerCase();
        if (t[k] !== undefined) t[k]++;
        t.recorded++;
        if (t.entries.length < 10) t.entries.push({ subject: sub.n, date: r.d, status: r.s, time: r.t || '' });
      });
    });
    wrs.forEach(function (w) { if (byId[w.i]) byId[w.i].warnings++; });
    lts.forEach(function (l) { if (byId[l.st]) byId[l.st].letters++; });

    var todayRecords = [];
    var currentSub = sbs[currentSubjectIndex()] || sbs[0];
    if (currentSub) {
      todayRecords = (currentSub.r || []).filter(function (r) { return r.d === today; }).map(function (r) {
        return { name: (byId[r.i] && byId[r.i].s.n) || r.n || r.i, id: r.i, status: r.s, time: r.t || '' };
      });
    }
    var recordedIds = {};
    todayRecords.forEach(function (r) { recordedIds[r.id] = true; });

    return {
      model: model,
      students: Object.keys(byId).map(function (k) { return byId[k]; }),
      today: today,
      currentSub: currentSub,
      todayRecords: todayRecords,
      unrecorded: sts.filter(function (s) { return !recordedIds[s.i]; }),
      subjects: sbs,
      warnings: wrs,
      letters: lts,
      counts: { students: sts.length, subjects: sbs.length, warnings: wrs.length, letters: lts.length }
    };
  }

  function listNames(arr, limit) {
    limit = limit || 40;
    if (!arr.length) return '';
    var shown = arr.slice(0, limit).map(function (x) { return '• ' + escHtml(x); }).join('<br>');
    if (arr.length > limit) shown += '<br>…and ' + (arr.length - limit) + ' more.';
    return shown;
  }

  function statusLine(present, late, absent, unrecorded) {
    return 'Present: <b>' + present + '</b> · Late: <b>' + late + '</b> · Absent: <b>' + absent + '</b>' +
      (unrecorded === undefined ? '' : ' · Unrecorded: <b>' + unrecorded + '</b>');
  }

  function findStudentIn(text, list) {
    var q = String(text || '').toLowerCase();
    var best = null, bestLen = 0;
    list.forEach(function (item) {
      var st = item.s || item;
      var name = String(st.n || '').toLowerCase();
      if (!name) return;
      var candidates = [name];
      if (name.indexOf(',') > -1) {
        var seg = name.split(',');
        candidates.push(seg[0].trim());
        candidates.push(seg.slice(1).join(' ').trim());
      }
      name.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(function (t) {
        if (t.length > 2) candidates.push(t);
      });
      candidates.forEach(function (c) {
        if (c && q.indexOf(c) > -1 && c.length > bestLen) { best = item; bestLen = c.length; }
      });
      var id = String(st.i || '').toLowerCase();
      if (id && q.indexOf(id) > -1 && id.length > bestLen) { best = item; bestLen = id.length; }
    });
    return best;
  }

  function studentReport(item) {
    var st = item.s;
    var sbs = allSubjects();
    var lines = [];
    sbs.forEach(function (sub) {
      var mine = (sub.r || []).filter(function (r) { return r.i === st.i; });
      if (!mine.length) return;
      var p = mine.filter(function (r) { return r.s === 'Present'; }).length;
      var l = mine.filter(function (r) { return r.s === 'Late'; }).length;
      var a = mine.filter(function (r) { return r.s === 'Absent'; }).length;
      lines.push('<b>' + escHtml(sub.n) + '</b>: ' + statusLine(p, l, a) + ' · ' + mine.length + ' record(s)');
    });
    var recent = item.entries.slice().sort(function (x, y) { return String(y.date).localeCompare(String(x.date)); }).slice(0, 8);
    var w = allWarns().filter(function (x) { return x.i === st.i; });
    var l = allLetters().filter(function (x) { return x.st === st.i; });

    var html = '<b>👤 ' + escHtml(st.n) + '</b><br>' +
      'ID: ' + escHtml(st.i) + (st.sec ? ' · Section: ' + escHtml(st.sec) : '') + '<br>' +
      (st.em ? 'Email: ' + escHtml(st.em) + '<br>' : '') +
      'NFC card: ' + (st.nfc ? 'linked' : 'not linked') + '<br><br>' +
      '<b>Overall</b><br>' + statusLine(item.present, item.late, item.absent, undefined) +
      ' · ' + item.recorded + ' record(s)<br>' +
      (lines.length ? '<br><b>By subject</b><br>' + lines.join('<br>') : '<br>No attendance records yet.<br>') +
      (recent.length ? '<br><b>Recent</b><br>' + recent.map(function (r) {
        return '• ' + escHtml(r.date) + ' · ' + escHtml(r.subject) + ' · <b>' + escHtml(r.status) + '</b>' + (r.time ? ' (' + escHtml(r.time) + ')' : '');
      }).join('<br>') : '') +
      '<br><br><b>Warnings:</b> ' + w.length +
      (w.length ? '<br>' + w.slice(-5).map(function (x) {
        return '• ' + escHtml(x.d || '') + ' · ' + escHtml(x.r || '') + (x.note ? ' — ' + escHtml(x.note) : '');
      }).join('<br>') : '') +
      '<br><b>Letters:</b> ' + l.length +
      (l.length ? '<br>' + l.slice(-5).map(function (x) {
        return '• #' + escHtml(x.id) + ' · ' + escHtml(letterTypeName(x.ty)) + ' · ' + escHtml(x.date || '');
      }).join('<br>') : '');
    return html;
  }

  function runOfflineAiEngine(prompt, contextReply) {
    var p = String(prompt || '').toLowerCase().trim();
    var v = buildOfflineView();
    var sts = allStudents();

    // --- Appeal analysis -----------------------------------------------------
    if (contextReply) {
      var matchL = allLetters().filter(function (l) { return l.id === contextReply.refId; })[0];
      var matchSt = sts.filter(function (s) {
        return (s.em && s.em.toLowerCase() === String(contextReply.from || '').toLowerCase()) ||
          (matchL && matchL.st === s.i) ||
          (contextReply.from && String(contextReply.from).toLowerCase().indexOf(String(s.n || '').toLowerCase()) > -1);
      })[0];
      var recCount = matchSt ? allWarns().filter(function (w) { return w.i === matchSt.i; }).length : 0;
      var isMedical = /doctor|hospital|sick|fever|medical|clinic/i.test(contextReply.body || '');
      var rec = isMedical ? 'Grant Appeal (medical reason)' : 'Endorse to SAO (rules violation)';
      return '<b>✨ Appeal analysis</b><br>' +
        '<b>Student:</b> ' + escHtml(matchSt ? matchSt.n : contextReply.from) + '<br>' +
        '<b>Warning count:</b> ' + recCount + '<br>' +
        '<b>Recommendation:</b> ' + rec + '<br><br>' +
        '<b>Draft reply</b><br>' +
        '<div class="ai-card">Dear Parent/Guardian,<br><br>' +
        'Thank you for the explanation regarding ' + escHtml(matchSt ? matchSt.n : 'the student') + '. ' +
        (isMedical ? 'The medical excuse is accepted and the absence will be excused.' : 'Under our classroom regulations, this matter is endorsed to the SAO for review.') +
        '<br><br>Sincerely,<br>Class Adviser</div>';
    }

    // --- Help / greeting -----------------------------------------------------
    if (/^(hi|hello|hey|good (morning|afternoon|evening))\b/.test(p)) {
      return 'Hello! I can read <b>' + v.counts.students + ' students</b>, <b>' + v.counts.subjects +
        ' subjects</b>, all attendance records, <b>' + v.counts.warnings + ' warnings</b> and <b>' +
        v.counts.letters + ' letters</b>.<br><br>Try: <i>Who is absent today?</i>, <i>Show the record of Justine</i>, <i>Who has the most lates?</i>, or <i>Mark everyone present</i>.';
    }
    if (/(what can you do|help|commands|how do you work|features)/.test(p)) {
      return '<b>I can answer from every record in the app:</b><br>' +
        '• Attendance: who is absent/late today, per-date summaries, per-subject totals<br>' +
        '• Students: full profile, attendance history, warnings and letters<br>' +
        '• Rankings: most lates, most absences, most warnings<br>' +
        '• Letters: list and counts by type<br>' +
        '• Actions: mark a student (or the whole class) present/late/absent, create warning letters<br><br>' +
        'Load a .litertlm model in Settings for free-form on-device answers.';
    }
    if (/^(thanks|thank you|salamat)\b/.test(p)) return "You're welcome!";

    // --- Mark whole class present -------------------------------------------
    if (/mark (everyone|all|the (whole )?class) present|class present|attend(ance)? all/.test(p)) {
      var curSub = v.currentSub;
      if (!curSub) return 'Add a subject first, then I can mark attendance.';
      var k = todayKey();
      var added = 0;
      sts.forEach(function (st) {
        if (!(curSub.r || []).some(function (r) { return r.d === k && r.i === st.i; })) {
          if (!Array.isArray(curSub.r)) curSub.r = [];
          curSub.r.push({ ts: Date.now(), d: k, n: st.n, i: st.i, t: '08:00', s: 'Present', w: 0 });
          added++;
        }
      });
      if (typeof save === 'function') save();
      if (typeof drawHome === 'function') drawHome();
      if (typeof drawRecs === 'function') drawRecs();
      return 'Done — marked <b>' + added + '</b> student(s) Present in <b>' + escHtml(curSub.n) + '</b> for ' + k + '.';
    }

    // --- Mark one student ----------------------------------------------------
    var markMatch = /(mark|set|record)\s+(.+?)\s+(?:as\s+)?(present|late|absent)\b/i.exec(prompt);
    if (markMatch) {
      var targetName = markMatch[2].replace(/^(student\s+)/i, '').trim();
      var status = markMatch[3].charAt(0).toUpperCase() + markMatch[3].slice(1).toLowerCase();
      var found = sts.filter(function (s) {
        return s.n.toLowerCase().indexOf(targetName.toLowerCase()) > -1 || s.i === targetName;
      })[0];
      if (!found) return 'I could not find a student matching "' + escHtml(targetName) + '".';
      if (typeof mark === 'function') { mark(found, status); return 'Marked <b>' + escHtml(found.n) + '</b> as <b>' + status + '</b>.'; }
      return 'I found ' + escHtml(found.n) + ', but the attendance action is unavailable on this screen.';
    }

    // --- Create letter -------------------------------------------------------
    var letMatch = /(letter|notice|warning|sanction|endorse\w*)\s+(?:for|to)\s+(.+)/i.exec(prompt);
    if (letMatch && !/analy[sz]e|draft|reply|appeal/i.test(p)) {
      var lname = letMatch[2].replace(/[?.!].*$/, '').trim();
      var lst = sts.filter(function (s) {
        return s.n.toLowerCase().indexOf(lname.toLowerCase()) > -1 || s.i === lname;
      })[0];
      if (!lst) return 'I could not find a student matching "' + escHtml(lname) + '".';
      var ty = '1';
      if (/disciplinary|2nd|second/.test(p)) ty = '2';
      else if (/sanction|3rd|third|last/.test(p)) ty = '3';
      else if (/clean/.test(p)) ty = '4';
      else if (/endorse|sao/.test(p)) ty = '5';
      var L = {
        id: Date.now(), ty: ty, date: todayKey(), to: lst.n,
        sal: typeof firstName === 'function' ? firstName(lst.n) : lst.n,
        inc: todayKey(), off: 'Classroom rules violation', rule: 'Classroom Regulations',
        st: lst.i, mt: Date.now()
      };
      allLetters().push(L);
      if (typeof save === 'function') save();
      if (typeof drawLetters === 'function') drawLetters();
      if (window.emc.autoSend) sendEmailForLetter(L, typeof lset0 === 'function' ? lset0() : {});
      return '<b>✨ Created ' + escHtml(letterTypeName(ty)) + ' for ' + escHtml(lst.n) + '</b><br>' +
        'Letter ID: #' + L.id + '<div class="ai-card-btns">' +
        '<button class="btn sm" onclick="openPreview(' + L.id + ')">Preview PDF</button>' +
        '<button class="btn ghost sm" onclick="editLetter(' + L.id + ')">Edit details</button></div>';
    }

    // --- Today's absentees ---------------------------------------------------
    if (/absent/.test(p) && /today|now|class|who/.test(p)) {
      if (!v.currentSub) return 'Add a subject first so I can check attendance.';
      var absRecs = v.todayRecords.filter(function (r) { return r.status === 'Absent'; });
      var notRec = v.unrecorded.map(function (s) { return s.n; });
      var absNames = absRecs.map(function (r) { return r.name; }).concat(notRec);
      if (!absNames.length) return '<b>' + escHtml(v.currentSub.n) + ' — ' + v.today + '</b><br>No one is absent. Everyone has a record today. ✅';
      return '<b>Absent / not recorded today</b><br>' + escHtml(v.currentSub.n) + ' · ' + v.today + '<br><br>' +
        listNames(absNames) +
        (absRecs.length ? '<br><br>Marked Absent: ' + absRecs.length : '') +
        (notRec.length ? '<br>Not yet recorded: ' + notRec.length : '');
    }

    // --- Simple counts (checked before the broad summary intent) -------------
    var countMatch = /how many\s+(students?|subjects?|warnings?|letters?|records?)/i.exec(prompt);
    if (countMatch) {
      var what = countMatch[1].toLowerCase();
      if (what.indexOf('student') === 0) return 'You have <b>' + v.counts.students + '</b> students.';
      if (what.indexOf('subject') === 0) return 'You have <b>' + v.counts.subjects + '</b> subjects.';
      if (what.indexOf('warning') === 0) return 'There are <b>' + v.counts.warnings + '</b> warnings recorded.';
      if (what.indexOf('letter') === 0) return 'There are <b>' + v.counts.letters + '</b> letters created.';
      var recTotal = v.subjects.reduce(function (n, s) { return n + ((s.r || []).length); }, 0);
      return 'There are <b>' + recTotal + '</b> attendance records across ' + v.counts.subjects + ' subject(s).';
    }

    // --- Today summary -------------------------------------------------------
    if (/summary|summar|overview|status|report|attendance today|today/.test(p)) {
      if (!v.currentSub) return 'No subjects yet. Add a subject to start taking attendance.';
      var pres = v.todayRecords.filter(function (r) { return r.status === 'Present'; }).length;
      var late = v.todayRecords.filter(function (r) { return r.status === 'Late'; }).length;
      var abs = v.todayRecords.filter(function (r) { return r.status === 'Absent'; }).length;
      var un = v.unrecorded.length;
      var rate = v.counts.students ? Math.round((pres / v.counts.students) * 100) : 0;
      return '<b>📊 ' + escHtml(v.currentSub.n) + ' — ' + v.today + '</b><br>' +
        statusLine(pres, late, abs, un) + '<br>Attendance rate: <b>' + rate + '%</b><br>' +
        (un ? '<br><b>Not yet recorded (' + un + ')</b><br>' + listNames(v.unrecorded.map(function (s) { return s.n; })) :
          '<br>Everyone has a record today. ✅');
    }

    // --- Rankings ------------------------------------------------------------
    if (/most|top|highest|ranking|rank/.test(p)) {
      var metric = /late|tardy/.test(p) ? 'late' : (/absent|absence/.test(p) ? 'absent' : (/warning|offen[cs]e/.test(p) ? 'warnings' : 'late'));
      var ranked = v.students.slice().sort(function (a, b) { return (b[metric] || 0) - (a[metric] || 0); });
      var nz = ranked.filter(function (x) { return (x[metric] || 0) > 0; }).slice(0, 10);
      if (!nz.length) return 'No student has any recorded ' + metric + ' yet.';
      var label = metric === 'warnings' ? 'warnings' : metric;
      return '<b>Top students by ' + label + '</b><br>' + nz.map(function (x, i) {
        return (i + 1) + '. ' + escHtml(x.s.n) + ' — <b>' + x[metric] + '</b> ' + label;
      }).join('<br>');
    }

    // --- Student profile -----------------------------------------------------
    var hit = findStudentIn(prompt, v.students);
    if (hit && (/who|about|record|profile|status|attendance|history|late|absent|warning|letter|show|tell|check|how/.test(p) || p.split(/\s+/).length <= 3)) {
      return studentReport(hit);
    }

    // --- Lists ---------------------------------------------------------------
    if (/list|all|show/.test(p) && /student|class/.test(p)) {
      if (!sts.length) return 'No students yet. Add students on the Students screen.';
      return '<b>Students (' + sts.length + ')</b><br>' + listNames(sts.map(function (s) { return s.n + ' (' + s.i + ')'; }));
    }
    if (/list|all|show/.test(p) && /letter|notice/.test(p)) {
      if (!v.letters.length) return 'No letters have been created yet.';
      var l2 = v.letters.slice(-15).map(function (l) {
        return '• #' + l.id + ' · ' + letterTypeName(l.ty) + ' · ' + (l.to || '') + ' · ' + (l.date || '');
      });
      return '<b>Letters (' + v.letters.length + ')</b><br>' + l2.join('<br>') +
        (v.letters.length > 15 ? '<br>…showing the latest 15.' : '');
    }
    if (/list|all|show|which/.test(p) && /subject/.test(p)) {
      if (!v.subjects.length) return 'No subjects yet.';
      return '<b>Subjects (' + v.subjects.length + ')</b><br>' + v.subjects.map(function (s) {
        return '• ' + escHtml(s.n) + (s.c ? ' (' + escHtml(s.c) + ')' : '') + ' — ' + (s.r || []).length + ' record(s)';
      }).join('<br>');
    }
    if (/warning|offen[cs]e/.test(p)) {
      if (!v.warnings.length) return 'No warnings recorded yet.';
      return '<b>Warnings (' + v.warnings.length + ')</b><br>' + v.warnings.slice(-15).map(function (w) {
        return '• ' + escHtml(w.n || '') + ' · ' + escHtml(w.r || '') + ' · ' + escHtml(w.d || '');
      }).join('<br>') + (v.warnings.length > 15 ? '<br>…showing the latest 15.' : '');
    }
    if (/how many|count|total/.test(p)) {
      return '<b>App totals</b><br>Students: <b>' + v.counts.students + '</b><br>Subjects: <b>' + v.counts.subjects +
        '</b><br>Warnings: <b>' + v.counts.warnings + '</b><br>Letters: <b>' + v.counts.letters + '</b><br>Today: ' + v.today;
    }

    // --- Fallback: still give a real answer ---------------------------------
    return 'I can read all <b>' + v.counts.students + ' students</b>, <b>' + v.counts.subjects +
      ' subjects</b> and every attendance record. I could not match that question to a report.<br><br>' +
      'Try asking:<br>• <i>Who is absent today?</i><br>• <i>Show the record of [student name]</i><br>' +
      '• <i>Who has the most absences?</i><br>• <i>List all students</i><br>• <i>Mark [name] present</i><br><br>' +
      '<span class="ai-note">For free-form questions like “<i>' + escHtml(prompt) + '</i>”, add a Gemini API key in Settings.</span>';
  }

  // Debug hooks (harmless; lets the project be tested outside a WebView).
  window.aiDebug = {
    buildDataModel: buildDataModel,
    buildAppContext: buildAppContext,
    runOfflineAiEngine: runOfflineAiEngine,
    buildAiPrompt: buildAiPrompt,
    engineMode: engineMode,
    localAi: function(){ return localAi; }
  };

  // ---------------------------------------------------------------------------
  // 10. Google Apps Script helper (unchanged behavior)
  // ---------------------------------------------------------------------------
  window.copyGasCode = function () {
    var code = window.emGasCode();
    navigator.clipboard.writeText(code);
    says('Google Apps Script code copied to clipboard');
  };

  window.emGasCode = function () {
    return `// Two-way Gmail integration for the Attendance app
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    if (data.action === 'sendEmail') {
      var item = data.data;
      var blob = Utilities.newBlob(Utilities.base64Decode(item.pdfBase64), 'application/pdf', item.filename);
      GmailApp.sendEmail(item.to, item.subject, item.body, { attachments: [blob] });
      return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, msg: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'checkInbox') {
      var threads = GmailApp.search('subject:"[Ref:"');
      var replies = [];
      for (var i = 0; i < Math.min(threads.length, 10); i++) {
        var msgs = threads[i].getMessages();
        if (msgs.length > 1) {
          var lastMsg = msgs[msgs.length - 1];
          var subj = lastMsg.getSubject();
          var match = /\\[Ref:\\s*(\\d+)\\]/.exec(subj);
          replies.push({
            from: lastMsg.getFrom(),
            subject: subj,
            body: lastMsg.getPlainBody().slice(0, 300),
            date: lastMsg.getDate().toISOString().slice(0, 10),
            refId: match ? Number(match[1]) : 0
          });
        }
      }
      return ContentService.createTextOutput(JSON.stringify({ ok: true, replies: replies })).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, msg: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}`;
  };

  window.addEventListener('online', updateAiStatus);
  window.addEventListener('offline', updateAiStatus);

})();

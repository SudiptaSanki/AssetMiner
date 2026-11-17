/**
 * Asset Miner page bridge - runs in the PAGE's JavaScript world (MAIN world).
 *
 * Why: content scripts live in an isolated world and cannot see the editor
 * objects the page created. Virtualized editors (CodeMirror 6, Monaco) only
 * put the visible ~50 lines in the DOM, but the editor object in the page
 * already holds the COMPLETE text of every file you opened. Reading that
 * object is the same data you can see and edit on screen - nothing is
 * fetched, no network request is made, no access control is touched.
 *
 * Strictly read-only: it never calls a mutating editor API. It posts
 * snapshots to the isolated content script via window.postMessage; texts
 * that did not change since the last post are sent without their body.
 */
(function () {
  'use strict';
  if (window.__assetMinerBridge) return;
  window.__assetMinerBridge = true;

  var TAG = '__assetMinerBridge';
  var HOST_ID = 'asset-miner-host';
  var lastText = new Map(); // key -> text last posted
  var nextId = 1;
  var ids = new WeakMap();

  function idOf(obj) {
    var id = ids.get(obj);
    if (!id) {
      id = nextId++;
      ids.set(obj, id);
    }
    return id;
  }

  // Scopes to search: the document plus every open shadow root (not ours).
  // Recomputed at most every 3s - walking the whole DOM is not free.
  var scopes = [document];
  var scopesAt = 0;
  function refreshScopes() {
    var now = Date.now();
    if (now - scopesAt < 3000) return;
    scopesAt = now;
    var found = [document];
    var all = document.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.shadowRoot && el.id !== HOST_ID) found.push(el.shadowRoot);
    }
    scopes = found;
  }

  function deepAll(selector) {
    var out = [];
    for (var s = 0; s < scopes.length; s++) {
      var list = scopes[s].querySelectorAll(selector);
      for (var i = 0; i < list.length; i++) out.push(list[i]);
    }
    return out;
  }

  function area(el) {
    if (!el || !el.getBoundingClientRect) return 0;
    var r = el.getBoundingClientRect();
    var w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    var h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  function collect() {
    var docs = [];
    refreshScopes();

    // ---- Monaco (global API, when the page exposes it) ----
    try {
      var m = window.monaco;
      if (m && m.editor && typeof m.editor.getModels === 'function') {
        var visibleModels = new Map();
        var editors = typeof m.editor.getEditors === 'function' ? m.editor.getEditors() : [];
        for (var e = 0; e < editors.length; e++) {
          var ed = editors[e];
          var model = ed.getModel && ed.getModel();
          if (!model) continue;
          var dom = ed.getContainerDomNode && ed.getContainerDomNode();
          var a = area(dom);
          if (a > (visibleModels.get(model) || 0)) visibleModels.set(model, a);
        }
        var models = m.editor.getModels();
        for (var k = 0; k < models.length; k++) {
          var md = models[k];
          if (md.isDisposed && md.isDisposed()) continue;
          var uri = md.uri ? String(md.uri.toString()) : '';
          docs.push({
            kind: 'monaco',
            key: 'monaco:' + uri,
            uri: uri,
            path: md.uri ? String(md.uri.path || '') : '',
            text: md.getValue(),
            area: visibleModels.get(md) || 0,
          });
        }
      }
    } catch (err) { /* page API shape differs - ignore */ }

    // ---- CodeMirror 6 (EditorView reachable from .cm-content.cmView) ----
    var cms = deepAll('.cm-content');
    for (var c = 0; c < cms.length; c++) {
      try {
        var cv = cms[c].cmView;
        var view = cv && ((cv.rootView && cv.rootView.view) || cv.view);
        if (!view || !view.state || !view.state.doc) continue;
        docs.push({
          kind: 'cm6',
          key: 'cm6:' + idOf(view),
          uri: '',
          path: '',
          text: view.state.doc.toString(),
          area: area(view.dom),
        });
      } catch (err) { /* ignore */ }
    }

    // ---- CodeMirror 5 ----
    var cm5 = deepAll('.CodeMirror');
    for (var f = 0; f < cm5.length; f++) {
      try {
        var inst = cm5[f].CodeMirror;
        if (!inst || typeof inst.getValue !== 'function') continue;
        docs.push({ kind: 'cm5', key: 'cm5:' + idOf(inst), uri: '', path: '', text: inst.getValue(), area: area(cm5[f]) });
      } catch (err) { /* ignore */ }
    }

    // ---- Ace ----
    var aces = deepAll('.ace_editor');
    for (var g = 0; g < aces.length; g++) {
      try {
        var ace = aces[g].env && aces[g].env.editor;
        if (!ace || typeof ace.getValue !== 'function') continue;
        docs.push({ kind: 'ace', key: 'ace:' + idOf(ace), uri: '', path: '', text: ace.getValue(), area: area(aces[g]) });
      } catch (err) { /* ignore */ }
    }

    return docs;
  }

  function tick() {
    var docs;
    try {
      docs = collect();
    } catch (err) {
      return;
    }
    if (docs.length === 0) return;
    var out = [];
    for (var i = 0; i < docs.length; i++) {
      var d = docs[i];
      var same = lastText.get(d.key) === d.text;
      if (!same) lastText.set(d.key, d.text);
      out.push({
        kind: d.kind,
        key: d.key,
        uri: d.uri,
        path: d.path,
        area: d.area,
        same: same,
        text: same ? null : d.text,
      });
    }
    window.postMessage({ source: TAG, type: 'docs', docs: out }, '*');
  }

  // Content script asks for a full resend (e.g. after it (re)started).
  window.addEventListener('message', function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== '__assetMinerContent') return;
    if (ev.data.type === 'resend') {
      lastText.clear();
      tick();
    }
  });

  setInterval(tick, 700);
  document.addEventListener('click', function () { setTimeout(tick, 250); }, true);
  tick();
})();

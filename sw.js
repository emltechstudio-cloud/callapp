// ═══════════════════════════════════════════════════
// iNet sw.js  — Service Worker
// Fixes: #11 dead CANCEL_NOTIFICATIONS branch removed
//        #14 focusOrOpen broadened URL check
// ═══════════════════════════════════════════════════

const CACHE = 'inet-v4';
const ASSETS = ['/app.html', '/index.html', '/manifest.json', '/icon.svg'];

// ── INSTALL ────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ───────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ──────────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (!e.request.url.startsWith(self.location.origin)) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/app.html'));
    })
  );
});

// ── PUSH ───────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }

  const type     = data.type     || 'generic';
  const from     = data.from     || 'Someone';
  const callType = data.call_type || 'audio';

  let title, body, actions, tag, requireInteraction, vibrate;

  if (type === 'incoming_call') {
    title              = `Incoming ${callType === 'video' ? 'Video' : 'Audio'} Call`;
    body               = `PIN ${from} is calling you`;
    tag                = 'incoming-call';
    requireInteraction = true;
    vibrate            = [500, 200, 500, 200, 500];
    actions            = [
      { action: 'answer',  title: 'Answer'  },
      { action: 'decline', title: 'Decline' }
    ];
  } else if (type === 'new_message') {
    title   = `Message from ${from}`;
    body    = data.body || 'New message';
    tag     = `msg-${from}`;
    vibrate = [200, 100, 200];
    actions = [
      { action: 'open',    title: 'Open'    },
      { action: 'dismiss', title: 'Dismiss' }
    ];
  } else if (type === 'incoming_group_call') {
    title              = 'Group Call Invitation';
    body               = `${from} invited you to a group call`;
    tag                = 'group-call';
    requireInteraction = true;
    vibrate            = [400, 150, 400, 150, 400];
    actions            = [
      { action: 'join',    title: 'Join'    },
      { action: 'decline', title: 'Decline' }
    ];
  } else {
    title = 'iNet';
    body  = data.body || 'New notification';
    tag   = 'generic';
  }

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:               '/icon.svg',
      badge:              '/icon.svg',
      tag,
      data,
      actions:            actions || [],
      requireInteraction: requireInteraction || false,
      vibrate:            vibrate || [200, 100, 200],
      timestamp:          Date.now(),
      silent:             false
    })
  );
});

// ── NOTIFICATION CLICK ─────────────────────────────
self.addEventListener('notificationclick', e => {
  const n      = e.notification;
  const action = e.action;
  const data   = n.data || {};

  n.close();

  const appUrl = self.registration.scope + 'app.html';

  if (action === 'answer' || action === 'join') {
    e.waitUntil(
      focusOrOpen(appUrl).then(client => {
        if (client) client.postMessage({ type: 'ANSWER_CALL', data });
      })
    );
  } else if (action === 'decline') {
    e.waitUntil(notifyClients({ type: 'DECLINE_CALL', data }));
  } else {
    e.waitUntil(focusOrOpen(appUrl));
  }
});

// ── NOTIFICATION CLOSE ─────────────────────────────
self.addEventListener('notificationclose', e => {
  if (e.notification.tag === 'incoming-call') {
    notifyClients({ type: 'CALL_NOTIFICATION_DISMISSED', data: e.notification.data });
  }
});

// ── MESSAGES FROM CLIENT ──────────────────────────
// Fix #11: Removed dead CANCEL_NOTIFICATIONS client-message handler.
// Clients send CANCEL_NOTIFICATIONS to the SW (not the other way around),
// so the SW handles it here and closes the notification directly.
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};

  if (type === 'CANCEL_NOTIFICATIONS') {
    self.registration.getNotifications({ tag: payload?.tag || 'incoming-call' })
      .then(ns => ns.forEach(n => n.close()));
  }

  if (type === 'SKIP_WAITING') self.skipWaiting();

  if (type === 'SHOW_NOTIFICATION') {
    const p = payload || {};
    self.registration.showNotification(p.title || 'iNet', {
      body:               p.body               || '',
      icon:               '/icon.svg',
      badge:              '/icon.svg',
      tag:                p.tag                || 'generic',
      data:               p.data               || {},
      actions:            p.actions            || [],
      requireInteraction: p.requireInteraction || false,
      vibrate:            p.vibrate            || [200, 100, 200],
      silent:             false
    });
  }
});

// ── HELPERS ────────────────────────────────────────

// Fix #14: Broadened URL check — match ANY open window, not just specific paths.
// Installed PWAs may have varying URL patterns; focusing any window is correct.
function focusOrOpen(url) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
    if (all.length > 0) {
      // Prefer a window that's already visible / focused
      const target = all.find(c => c.focused) || all[0];
      if ('focus' in target) return target.focus();
    }
    return clients.openWindow(url);
  });
}

function notifyClients(msg) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(all => all.forEach(c => c.postMessage(msg)));
}

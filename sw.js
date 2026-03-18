// iNet Service Worker — Push Notifications + Offline Cache
const CACHE = 'inet-v2';
const ASSETS = ['/app.html', '/index.html', '/manifest.json', '/icon.svg'];

// ── INSTALL ──────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE ─────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH — serve from cache, fallback to network ────────
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

// ── PUSH — show real notification ─────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = {}; }

  const type      = data.type || 'generic';
  const from      = data.from || 'Someone';
  const callType  = data.call_type || 'audio';

  let title, body, actions, tag, requireInteraction, vibrate;

  if (type === 'incoming_call') {
    title              = `📞 Incoming ${callType === 'video' ? 'Video' : 'Audio'} Call`;
    body               = `PIN ${from} is calling you`;
    tag                = 'incoming-call';
    requireInteraction = true;          // stays on screen until tapped
    vibrate            = [500, 200, 500, 200, 500];
    actions            = [
      { action: 'answer',  title: '✅ Answer'  },
      { action: 'decline', title: '❌ Decline' }
    ];
  } else if (type === 'new_message') {
    title   = `💬 Message from ${from}`;
    body    = data.body || 'New message';
    tag     = `msg-${from}`;
    vibrate = [200, 100, 200];
    actions = [
      { action: 'open',    title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' }
    ];
  } else if (type === 'incoming_group_call') {
    title              = `👥 Group Call`;
    body               = `${from} invited you to a group call`;
    tag                = 'group-call';
    requireInteraction = true;
    vibrate            = [400, 150, 400, 150, 400];
    actions            = [
      { action: 'join',    title: '✅ Join'   },
      { action: 'decline', title: '❌ Decline' }
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

// ── NOTIFICATION CLICK ────────────────────────────────────
self.addEventListener('notificationclick', e => {
  const n      = e.notification;
  const action = e.action;
  const data   = n.data || {};

  n.close();

  const appUrl = self.registration.scope + 'app.html';

  if (action === 'answer' || action === 'join') {
    // Open/focus app and tell it to answer
    e.waitUntil(
      focusOrOpen(appUrl).then(client => {
        if (client) client.postMessage({ type: 'ANSWER_CALL', data });
      })
    );
  } else if (action === 'decline') {
    // Tell the app to decline (if it's open)
    e.waitUntil(
      notifyClients({ type: 'DECLINE_CALL', data })
    );
  } else {
    // Default tap — just open the app
    e.waitUntil(focusOrOpen(appUrl));
  }
});

// ── NOTIFICATION CLOSE ────────────────────────────────────
self.addEventListener('notificationclose', e => {
  if (e.notification.tag === 'incoming-call') {
    notifyClients({ type: 'CALL_NOTIFICATION_DISMISSED', data: e.notification.data });
  }
});

// ── MESSAGES FROM APP ─────────────────────────────────────
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};
  if (type === 'CANCEL_NOTIFICATIONS') {
    self.registration.getNotifications({ tag: payload?.tag || 'incoming-call' })
      .then(ns => ns.forEach(n => n.close()));
  }
  if (type === 'SKIP_WAITING') self.skipWaiting();
});

// ── HELPERS ───────────────────────────────────────────────
function focusOrOpen(url) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
    const existing = all.find(c => c.url.includes('app.html') || c.url.includes('/inet'));
    if (existing) return existing.focus();
    return clients.openWindow(url);
  });
}

function notifyClients(msg) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(all => all.forEach(c => c.postMessage(msg)));
}

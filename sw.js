// ═══════════════════════════════════════════════════
// iNet sw.js  — Service Worker v5
//
// Key fixes:
//  - Incoming call notification repeats every 4s (simulates ringing)
//    via a loop using renotify:true on the same tag
//  - Answer from notification opens app with ?action=answer so the app
//    auto-answers even when fully closed or on the lock screen
//  - Decline from notification posts DECLINE_CALL to any open clients
//    so the app can signal the caller
//  - Long repeating vibration pattern mimics a real ringtone
//  - Only one ring notification at a time (tag deduplication)
//  - iOS: Web Push not delivered when app is fully closed — Apple limit
// ═══════════════════════════════════════════════════

const CACHE  = 'inet-v5';
const ASSETS = ['/app.html', '/index.html', '/manifest.json', '/icon.svg'];

// Ring loop state
let ringInterval = null;
let pendingCall  = null; // stored so notificationclick can reference it

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

  const type     = data.type      || 'generic';
  const from     = data.from      || 'Unknown';
  const callType = data.call_type || 'audio';

  if (type === 'incoming_call' || type === 'incoming_group_call') {
    pendingCall = { from, call_type: callType, room: data.room || null, type };
    e.waitUntil(startRinging(pendingCall));
    return;
  }

  if (type === 'new_message') {
    e.waitUntil(
      self.registration.showNotification(`Message from ${from}`, {
        body:    data.body || 'New message',
        icon:    '/icon.svg',
        badge:   '/icon.svg',
        tag:     `msg-${from}`,
        data,
        vibrate: [200, 100, 200],
        actions: [
          { action: 'open',    title: 'Open'    },
          { action: 'dismiss', title: 'Dismiss' }
        ]
      })
    );
    return;
  }

  // Generic fallback
  e.waitUntil(
    self.registration.showNotification('iNet', {
      body:  data.body || 'New notification',
      icon:  '/icon.svg',
      badge: '/icon.svg',
      tag:   'generic',
      data
    })
  );
});

// ── RINGING ────────────────────────────────────────
// Shows the call notification and repeats it every 4s so the
// vibration pattern keeps firing — simulating a ringtone.
async function startRinging(call) {
  stopRinging();

  const isGroup   = call.type === 'incoming_group_call';
  const typeLabel = isGroup             ? 'Group Call'
                  : call.call_type === 'video' ? 'Video Call'
                  : 'Audio Call';

  const notifOptions = {
    body:               `PIN ${call.from} is calling you`,
    icon:               '/icon.svg',
    badge:              '/icon.svg',
    tag:                'incoming-call',  // single tag deduplicates
    renotify:           true,             // re-alert each time even on same tag
    requireInteraction: true,             // stay on screen — don't auto-dismiss
    silent:             false,
    // Vibration: 3 short buzzes, pause, repeat — like a real ringtone
    vibrate: [300, 150, 300, 150, 300, 600, 300, 150, 300, 150, 300],
    data:    call,
    actions: [
      { action: 'answer',  title: 'Answer'  },
      { action: 'decline', title: 'Decline' }
    ]
  };

  await self.registration.showNotification(`Incoming ${typeLabel}`, notifOptions);

  // Ring loop — re-fire notification every 4s to keep vibrating
  ringInterval = setInterval(async () => {
    const active = await self.registration.getNotifications({ tag: 'incoming-call' });
    if (!active.length) {
      stopRinging();
      return;
    }
    await self.registration.showNotification(`Incoming ${typeLabel}`, notifOptions);
  }, 4000);
}

function stopRinging() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
}

// ── NOTIFICATION CLICK ─────────────────────────────
self.addEventListener('notificationclick', e => {
  const action = e.action;
  const data   = e.notification.data || pendingCall || {};

  e.notification.close();
  stopRinging();

  if (action === 'decline') {
    // Tell any open app windows to signal the caller
    e.waitUntil(notifyClients({ type: 'DECLINE_CALL', data }));
    pendingCall = null;
    return;
  }

  // Answer (button or tapping the notification body) — open app with ?action=answer
  // so app.js detects it on load and auto-answers even from a cold start
  const params = new URLSearchParams({ action: 'answer' });
  if (data.from)      params.set('from',      data.from);
  if (data.call_type) params.set('call_type', data.call_type);
  if (data.room)      params.set('room',      data.room);

  const targetUrl = `${self.registration.scope}app.html?${params.toString()}`;

  e.waitUntil(
    focusOrOpen(targetUrl).then(client => {
      // Also post a message in case the app was already open in background
      if (client) client.postMessage({ type: 'ANSWER_CALL', data });
    })
  );
  pendingCall = null;
});

// ── NOTIFICATION CLOSE (swiped away) ──────────────
self.addEventListener('notificationclose', e => {
  if (e.notification.tag === 'incoming-call') {
    stopRinging();
    pendingCall = null;
    notifyClients({ type: 'CALL_NOTIFICATION_DISMISSED', data: e.notification.data });
  }
});

// ── MESSAGES FROM CLIENT ──────────────────────────
self.addEventListener('message', e => {
  const { type, payload } = e.data || {};

  // App answered or call ended — stop ringing and clear notification
  if (type === 'CANCEL_NOTIFICATIONS') {
    stopRinging();
    pendingCall = null;
    self.registration.getNotifications({ tag: payload?.tag || 'incoming-call' })
      .then(ns => ns.forEach(n => n.close()));
  }

  // App asks SW to ring (when app is open but screen may be locked)
  if (type === 'SHOW_CALL_NOTIFICATION') {
    pendingCall = payload || {};
    startRinging(pendingCall);
  }

  if (type === 'SKIP_WAITING') self.skipWaiting();
});

// ── HELPERS ────────────────────────────────────────

// Focus an existing app window or open a new one at targetUrl.
// Using navigate() so lock-screen answer goes to the right URL.
function focusOrOpen(url) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
    const existing = all.find(c => c.url.includes('app.html')) || all[0];
    if (existing) {
      const p = existing.navigate ? existing.navigate(url) : Promise.resolve(null);
      return p.then(c => (c || existing).focus()).catch(() => existing.focus());
    }
    return clients.openWindow(url);
  });
}

function notifyClients(msg) {
  return clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(all => all.forEach(c => c.postMessage(msg)));
}

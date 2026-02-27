const CACHE = 'inet-v2';
const ASSETS = ['/', '/app.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() =>
      e.request.destination === 'document' ? caches.match('/app.html') : undefined
    ))
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  const isCall = data.type === 'incoming_call';
  const title = isCall ? `📞 Incoming ${data.call_type || 'audio'} call` : '💬 New message';
  const body = isCall ? `${data.from} is calling you` : `${data.from}: ${data.content || ''}`;
  e.waitUntil(
    self.registration.showNotification(title, {
      body, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png',
      vibrate: isCall ? [200,100,200,100,200] : [200],
      requireInteraction: isCall,
      tag: isCall ? `call-${data.from}` : `msg-${data.from}`,
      data, actions: isCall ? [{ action: 'answer', title: '✅ Answer' }, { action: 'decline', title: '❌ Decline' }] : []
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const existing = list.find(c => c.url.includes('app.html') && 'focus' in c);
      if (existing) { existing.focus(); existing.postMessage({ type: 'notification_action', action: e.action, data }); }
      else clients.openWindow('/app.html').then(c => c?.postMessage?.({ type: 'notification_action', action: e.action, data }));
    })
  );
});

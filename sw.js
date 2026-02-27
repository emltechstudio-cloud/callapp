// sw.js — Production-ready for iNet
const CACHE = 'inet-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('push', event => {
  const data = event.data.json();
  const options = {
    body: data.body || 'Incoming call or message',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge.png',
    tag: 'inet-' + (data.from || Date.now()),
    data: data,
    actions: [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(`iNet • ${data.from || 'Call'}`, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'answer') {
    clients.openWindow(`/app?answer=${event.notification.data.from}`);
  } else {
    clients.openWindow('/app');
  }
});

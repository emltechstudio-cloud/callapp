// sw.js – iNet service worker with inline icon
const ICON_DATA = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'%3E%3Ccircle cx=\'50\' cy=\'50\' r=\'45\' fill=\'%23e63946\'/%3E%3Ctext x=\'50\' y=\'70\' font-size=\'50\' text-anchor=\'middle\' fill=\'white\' font-family=\'Arial\'%3EiN%3C/text%3E%3C/svg%3E';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { body: 'New notification' };
  }

  const { type, from, call_type, room, body } = data;
  let title = 'iNet';
  let options = {
    body: body || 'You have a call',
    icon: ICON_DATA,
    badge: ICON_DATA,
    vibrate: [200, 100, 200],
    data: { type, from, call_type, room },
    actions: []
  };

  if (type === 'incoming_call' || type === 'incoming_group_call') {
    options.actions = [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' }
    ];
    title = type === 'incoming_call' ? '📞 Incoming call' : '👥 Group invite';
  } else if (type === 'new_message') {
    title = '💬 New message';
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const { action } = event;
  const { type, from, call_type, room } = event.notification.data;

  if (action === 'answer') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clientList => {
          for (const client of clientList) {
            if (client.url.includes(self.location.origin) && 'focus' in client) {
              client.focus();
              client.postMessage({
                type: 'notification_action',
                action: 'answer',
                data: { from, call_type, room }
              });
              return;
            }
          }
          if (clients.openWindow) {
            return clients.openWindow('/').then(client => {
              setTimeout(() => {
                client.postMessage({
                  type: 'notification_action',
                  action: 'answer',
                  data: { from, call_type, room }
                });
              }, 1000);
            });
          }
        })
    );
  } else if (action === 'decline') {
    // Optionally notify server that you declined (can be added later)
  } else {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clientList => {
          for (const client of clientList) {
            if (client.url.includes(self.location.origin) && 'focus' in client) {
              client.focus();
              return;
            }
          }
          if (clients.openWindow) clients.openWindow('/');
        })
    );
  }
});

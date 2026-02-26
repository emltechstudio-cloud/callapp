const CACHE_NAME = 'inet-v1';

self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (e) => {
    let data = {};
    try {
        data = e.data.json();
    } catch {
        return;
    }

    const { type, from, call_type, content } = data;

    let title = 'iNet';
    let body = '';
    let icon = '/icons/icon-192.png';
    let badge = '/icons/icon-72.png';
    let actions = [];
    let requireInteraction = false;

    if (type === 'incoming_call') {
        title = `Incoming ${call_type || 'audio'} call`;
        body = `From ${from}`;
        actions = [
            { action: 'answer', title: 'Answer' },
            { action: 'decline', title: 'Decline' }
        ];
        requireInteraction = true;
    } else if (type === 'new_message') {
        title = `Message from ${from}`;
        body = content || 'New message';
        actions = [
            { action: 'open', title: 'Open' }
        ];
    } else if (type === 'missed_call') {
        title = 'Missed call';
        body = `From ${from}`;
    }

    e.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon,
            badge,
            data: { from, type },
            actions,
            requireInteraction,
            vibrate: type === 'incoming_call' ? [500, 200, 500] : [200, 100, 200]
        })
    );
});

self.addEventListener('notificationclick', (e) => {
    const notification = e.notification;
    const action = e.action;
    const data = notification.data;

    notification.close();

    if (action === 'answer') {
        e.waitUntil(clients.openWindow('/app.html?call=' + data.from));
    } else if (action === 'open') {
        e.waitUntil(clients.openWindow('/app.html?chat=' + data.from));
    } else {
        e.waitUntil(clients.openWindow('/app.html'));
    }
});

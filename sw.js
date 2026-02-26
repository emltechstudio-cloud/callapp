// iNet Service Worker v1.0
// Handles: offline caching, push notifications (calls, messages, files)

const CACHE_NAME = 'inet-v1';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/app.html',
    '/install.html',
    '/manifest.json'
];

// ─────────────────────────────────────────
// INSTALL — cache static assets
// ─────────────────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(STATIC_ASSETS).catch(() => {
                // Non-fatal: some assets may not exist yet
            });
        }).then(() => self.skipWaiting())
    );
});

// ─────────────────────────────────────────
// ACTIVATE — clean old caches
// ─────────────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        ).then(() => self.clients.claim())
    );
});

// ─────────────────────────────────────────
// FETCH — serve from cache, fallback to network
// ─────────────────────────────────────────
self.addEventListener('fetch', event => {
    // Skip non-GET and cross-origin requests
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache successful HTML/CSS/JS responses
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback
                if (event.request.destination === 'document') {
                    return caches.match('/app.html') || caches.match('/index.html');
                }
            });
        })
    );
});

// ─────────────────────────────────────────
// PUSH — real notifications when app is closed
// ─────────────────────────────────────────
self.addEventListener('push', event => {
    let data = {};

    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { type: 'incoming_call', from: 'Unknown' };
    }

    const { type, from, call_type, text, filename } = data;

    let title = 'iNet';
    let body  = 'New notification';
    let icon  = '/icons/icon-192.png';
    let badge = '/icons/badge-72.png';
    let tag   = type || 'generic';
    let actions = [];
    let requireInteraction = false;
    let vibrate = [200, 100, 200];
    let data_payload = data;

    switch (type) {

        // ── INCOMING CALL ──────────────────────────
        case 'incoming_call':
            title = `📞 Incoming ${call_type === 'video' ? 'Video' : 'Audio'} Call`;
            body  = `PIN ${from} is calling you`;
            tag   = 'incoming-call';
            requireInteraction = true; // stays until dismissed
            vibrate = [500, 200, 500, 200, 500]; // strong pattern for calls
            actions = [
                { action: 'answer', title: '✅ Answer' },
                { action: 'decline', title: '❌ Decline' }
            ];
            break;

        // ── MISSED CALL ─────────────────────────────
        case 'missed_call':
            title = '📵 Missed Call';
            body  = `You missed a call from PIN ${from}`;
            tag   = 'missed-call';
            vibrate = [200, 100, 200];
            actions = [
                { action: 'callback', title: '📞 Call Back' },
                { action: 'dismiss', title: 'Dismiss' }
            ];
            break;

        // ── INCOMING MESSAGE ─────────────────────────
        case 'chat_message':
            title = `💬 Message from ${from}`;
            body  = text || 'Sent you a message';
            tag   = `chat-${from}`;
            vibrate = [100, 50, 100];
            actions = [
                { action: 'open', title: 'Open' },
                { action: 'dismiss', title: 'Dismiss' }
            ];
            break;

        // ── FILE RECEIVED ─────────────────────────────
        case 'file_received':
            title = `📎 File from ${from}`;
            body  = filename ? `"${filename}" received` : 'A file was sent to you';
            tag   = `file-${from}`;
            vibrate = [200, 100, 200];
            actions = [
                { action: 'open', title: 'Open App' },
                { action: 'dismiss', title: 'Dismiss' }
            ];
            break;

        // ── GROUP INVITE ─────────────────────────────
        case 'group_invite':
            title = `👥 Group Call Invite`;
            body  = `PIN ${from} invited you to a group call`;
            tag   = 'group-invite';
            requireInteraction = true;
            vibrate = [400, 150, 400];
            actions = [
                { action: 'join', title: '✅ Join' },
                { action: 'decline', title: '❌ Decline' }
            ];
            break;

        default:
            title = 'iNet';
            body  = 'You have a new notification';
    }

    const options = {
        body,
        icon,
        badge,
        tag,
        data: data_payload,
        actions,
        requireInteraction,
        vibrate,
        timestamp: Date.now(),
        silent: false
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

// ─────────────────────────────────────────
// NOTIFICATION CLICK — handle action buttons
// ─────────────────────────────────────────
self.addEventListener('notificationclick', event => {
    const notification = event.notification;
    const action = event.action;
    const data = notification.data || {};

    notification.close();

    const appUrl = self.registration.scope + 'app.html';

    switch (action) {

        case 'answer':
            // Open app and signal to answer the call
            event.waitUntil(
                openOrFocusApp(appUrl + `?action=answer&from=${data.from || ''}`)
            );
            break;

        case 'decline':
            // Open app briefly to send decline signal, or just close
            event.waitUntil(
                notifyClients({ type: 'decline_call', from: data.from })
            );
            break;

        case 'callback':
            event.waitUntil(
                openOrFocusApp(appUrl + `?action=call&pin=${data.from || ''}`)
            );
            break;

        case 'join':
            event.waitUntil(
                openOrFocusApp(appUrl + `?action=join&room=${data.roomId || ''}&host=${data.from || ''}`)
            );
            break;

        case 'open':
        case '':
        default:
            // Default: just open / focus the app
            event.waitUntil(openOrFocusApp(appUrl));
            break;
    }
});

// ─────────────────────────────────────────
// NOTIFICATION CLOSE — track dismissals
// ─────────────────────────────────────────
self.addEventListener('notificationclose', event => {
    const data = event.notification.data || {};
    // If a call notification was closed without answering, notify the app
    if (data.type === 'incoming_call') {
        notifyClients({ type: 'call_notification_dismissed', from: data.from });
    }
});

// ─────────────────────────────────────────
// MESSAGE — app can send messages to SW
// ─────────────────────────────────────────
self.addEventListener('message', event => {
    const { type, payload } = event.data || {};

    switch (type) {
        case 'SKIP_WAITING':
            self.skipWaiting();
            break;

        // App can ask SW to show a notification locally (fallback)
        case 'SHOW_NOTIFICATION':
            if (payload) {
                self.registration.showNotification(payload.title || 'iNet', {
                    body:  payload.body || '',
                    icon:  '/icons/icon-192.png',
                    badge: '/icons/badge-72.png',
                    tag:   payload.tag || 'local',
                    data:  payload.data || {},
                    requireInteraction: payload.requireInteraction || false,
                    vibrate: payload.vibrate || [200, 100, 200],
                    actions: payload.actions || []
                });
            }
            break;

        case 'CANCEL_NOTIFICATIONS':
            // App answered call — dismiss the ringing notification
            if (payload && payload.tag) {
                self.registration.getNotifications({ tag: payload.tag })
                    .then(notifications => notifications.forEach(n => n.close()));
            }
            break;
    }
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

/**
 * Open the app if not already open, or focus it and navigate.
 */
function openOrFocusApp(url) {
    return clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(windowClients => {
            // Look for an existing iNet window
            const existingClient = windowClients.find(c =>
                c.url.includes('/app.html') || c.url.includes('/inet')
            );

            if (existingClient) {
                // Focus it and post a message
                return existingClient.focus().then(client => {
                    client.postMessage({ type: 'NAVIGATE', url });
                });
            }

            // No window open — open a new one
            return clients.openWindow(url);
        });
}

/**
 * Post a message to all open app windows.
 */
function notifyClients(message) {
    return clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(windowClients => {
            windowClients.forEach(client => client.postMessage(message));
        });
}

// sw.js - iNet Service Worker v2.0
const CACHE_NAME = 'inet-v2';
const APP_URL = '/app.html';
const API_URL = 'https://emltechstudio-inet.hf.space';

// Inline icon (your iNet logo)
const ICON_DATA = 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'%3E%3Ccircle cx=\'50\' cy=\'50\' r=\'45\' fill=\'%23e63946\'/%3E%3Ctext x=\'50\' y=\'70\' font-size=\'50\' text-anchor=\'middle\' fill=\'white\' font-family=\'Arial\'%3EiN%3C/text%3E%3C/svg%3E';

// Install event - cache assets
self.addEventListener('install', (event) => {
  console.log('✅ Service Worker installing...');
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        APP_URL,
        'manifest.json'
      ]).catch(err => console.warn('Cache add failed:', err));
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('✅ Service Worker activated');
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(keys => {
        return Promise.all(
          keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
        );
      })
    ])
  );
});

// Push event - handle all notifications
self.addEventListener('push', (event) => {
  console.log('📨 Push received:', event);
  
  let data = {};
  try {
    data = event.data.json();
    console.log('Push data:', data);
  } catch (e) {
    console.warn('Push parse error:', e);
    data = { 
      type: 'unknown',
      body: 'New notification',
      title: 'iNet'
    };
  }

  // Default values
  const { 
    type = 'unknown', 
    from = 'Someone', 
    call_type = 'audio', 
    room = null, 
    body = 'You have a new notification',
    title = null
  } = data;

  // Build notification based on type
  let notificationTitle = title || 'iNet';
  let notificationOptions = {
    body: body,
    icon: ICON_DATA,
    badge: ICON_DATA,
    vibrate: [200, 100, 200],
    data: { type, from, call_type, room, timestamp: Date.now() },
    requireInteraction: true,
    tag: `${type}-${from}-${Date.now()}`,
    renotify: true,
    silent: false
  };

  // Customize for different notification types
  switch(type) {
    case 'incoming_call':
      notificationTitle = `📞 Incoming ${call_type} call`;
      notificationOptions.body = `${from} is calling...`;
      notificationOptions.actions = [
        { action: 'answer', title: '✅ Answer' },
        { action: 'decline', title: '❌ Decline' }
      ];
      break;
      
    case 'incoming_group_call':
      notificationTitle = '👥 Group call invite';
      notificationOptions.body = `${from} invited you to a group call`;
      notificationOptions.actions = [
        { action: 'answer', title: '✅ Join' },
        { action: 'decline', title: '❌ Decline' }
      ];
      break;
      
    case 'new_message':
      notificationTitle = `💬 Message from ${from}`;
      notificationOptions.body = body;
      notificationOptions.actions = [
        { action: 'reply', title: '📝 Reply' },
        { action: 'open', title: '🔓 Open' }
      ];
      break;
      
    case 'test_notification':
      notificationTitle = '🔔 Test Notification';
      notificationOptions.body = body || 'Push notifications are working!';
      notificationOptions.actions = [
        { action: 'open', title: 'Open App' }
      ];
      break;
      
    default:
      notificationTitle = title || 'iNet';
      notificationOptions.body = body;
  }

  event.waitUntil(
    self.registration.showNotification(notificationTitle, notificationOptions)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('👆 Notification clicked:', event.action);
  event.notification.close();
  
  const { action = 'open' } = event;
  const { type, from, call_type, room } = event.notification.data;
  
  // Handle different actions
  if (action === 'decline') {
    // Just close the notification, do nothing else
    return;
  }
  
  if (action === 'answer' || action === 'open' || action === 'reply') {
    event.waitUntil(handleNotificationAction({ type, from, call_type, room, action }));
  }
});

// Handle notification actions
async function handleNotificationAction({ type, from, call_type, room, action }) {
  // Try to find existing client
  const clients = await self.clients.matchAll({ 
    type: 'window', 
    includeUncontrolled: true 
  });
  
  const urlToOpen = new URL(APP_URL, self.location.origin).href;
  
  // Prepare data to send to the app
  const messageData = {
    type: 'notification_action',
    action: action,
    data: { from, call_type, room }
  };
  
  // If we have an existing client, use it
  for (const client of clients) {
    if (client.url.includes(self.location.origin)) {
      // Focus the client
      await client.focus();
      // Send message to the client
      client.postMessage(messageData);
      return;
    }
  }
  
  // No existing client, open a new one
  const newClient = await self.clients.openWindow(urlToOpen);
  
  // Wait for the client to load, then send message
  if (newClient) {
    // Give it a moment to load
    await new Promise(resolve => setTimeout(resolve, 1000));
    newClient.postMessage(messageData);
  }
}

// Handle messages from the app
self.addEventListener('message', (event) => {
  console.log('📨 Message from app:', event.data);
  
  const { type } = event.data || {};
  
  switch(type) {
    case 'skipWaiting':
      self.skipWaiting();
      break;
      
    case 'checkSubscription':
      // Check if push is subscribed
      self.registration.pushManager.getSubscription()
        .then(subscription => {
          if (event.source) {
            event.source.postMessage({
              type: 'subscriptionStatus',
              subscribed: !!subscription
            });
          }
        });
      break;
      
    case 'clearNotifications':
      // Clear all notifications with a specific tag
      if (event.data.tag) {
        self.registration.getNotifications({ tag: event.data.tag })
          .then(notifications => notifications.forEach(n => n.close()));
      }
      break;
  }
});

// Background sync for offline messages (optional)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-messages') {
    console.log('🔄 Background sync triggered');
    event.waitUntil(syncPendingMessages());
  }
});

async function syncPendingMessages() {
  try {
    // Get pending messages from IndexedDB
    const pending = await getPendingMessages();
    
    for (const msg of pending) {
      await fetch(`${API_URL}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg)
      });
    }
    
    // Clear synced messages
    await clearPendingMessages();
    
    // Notify user
    self.registration.showNotification('✅ Messages sent', {
      body: 'Your offline messages have been delivered',
      icon: ICON_DATA,
      badge: ICON_DATA
    });
  } catch (err) {
    console.warn('Sync failed:', err);
  }
}

// Placeholder functions for IndexedDB (implement if needed)
async function getPendingMessages() { return []; }
async function clearPendingMessages() {}

// Fetch event - offline fallback (optional)
self.addEventListener('fetch', (event) => {
  // Only handle GET requests for the app
  if (event.request.method === 'GET' && event.request.url.includes(self.location.origin)) {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
    );
  }
});

console.log('✅ Service Worker loaded'); 

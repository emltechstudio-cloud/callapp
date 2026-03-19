// ═══════════════════════════════════════════════════
// iNet app.js  — all JavaScript for app.html
// ═══════════════════════════════════════════════════

const API = 'https://emltechstudio-inet.hf.space';
const WS_URL = 'wss://emltechstudio-inet.hf.space/ws';
const ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',  username:'openrelayproject', credential:'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username:'openrelayproject', credential:'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject', credential:'openrelayproject' }
]};

// ── STATE ──────────────────────────────────────────
let myPin    = localStorage.getItem('myPin');
let deviceId = localStorage.getItem('deviceId');
// VAPID key — always comes from backend, stored locally
// Never hardcoded here. Refreshed if push subscription fails.
let vapidKey = localStorage.getItem('vapidKey');

let ws = null, wsTimer = null, wsConnecting = false, wsHeartbeat = null;
let contacts  = JSON.parse(localStorage.getItem('contacts')    || '[]');
let chats     = JSON.parse(localStorage.getItem('chats')       || '{}');
let calls     = JSON.parse(localStorage.getItem('calls')       || '[]');
let pending   = JSON.parse(localStorage.getItem('pending')     || '{}');
let unread    = JSON.parse(localStorage.getItem('unread')      || '{}');
let recentRooms = JSON.parse(localStorage.getItem('recentRooms') || '[]');

let onlineStatus  = {};
let currentChatId = null;
let fabOpen       = false;
let deferredPrompt = null;

// 1:1 call state
let localStream = null, peerConn = null, callPeer = null, callType = null;
let callTimer = null, isMuted = false, isCamOff = false;
let incomingBuffer = null;   // { from, payload }
// ICE candidate queue (fixes race condition)
let iceCandQueue = [];
let remoteDescSet = false;
let callConnected = false;   // <-- NEW: whether call ever connected

// Group call state
let gcRoomId = null, gcStream = null, gcPeers = {}, gcTimer = null, gcSecs = 0;
let gcMuted = false, gcCamOff = false;

// Voice recording
let mediaRec = null, audioChunks = [], isRecording = false;

// My link-call room
let myRoomId = localStorage.getItem('myRoomId') || null;

// ── INIT ───────────────────────────────────────────
(function init() {
  // Service worker — listens for push notification actions
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', onSwMessage);
  }

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installBtn').style.display = 'block';
  });

  document.getElementById('fileInput').addEventListener('change', handleFile);
  makeDraggable(document.getElementById('gcLocalPip'));
  makeDraggable(document.getElementById('localVideo'));

  // Handle deep link room join (e.g. app.html#room:abc123)
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('room:')) {
    const roomId = hash.slice(5);   // strip 'room:' prefix — no double prefix
    if (myPin) setTimeout(() => joinRoom(roomId), 1200);
    else sessionStorage.setItem('pendingRoom', roomId);
  }

  if (myPin && deviceId) {
    startApp();
  } else {
    // Show signup
    document.getElementById('signupView').style.display = 'flex';
  }

  // Stay online even in background — reconnect when tab is visible again
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (!ws || ws.readyState !== WebSocket.OPEN) connectWS();
    }
  });
  window.addEventListener('online', () => connectWS());
})();

function startApp() {
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('tabs').style.display      = 'flex';
  document.querySelector('.main').style.overflow     = 'hidden';
  document.getElementById('fab').classList.add('visible');

  const badge = document.getElementById('pinBadge');
  badge.textContent = myPin;
  badge.classList.add('active');

  connectWS();
  renderAll();
  startPingLoop();
  updateLinkView();

  // Subscribe to push using stored vapid key
  // If it fails, we'll fetch a fresh key from /whoami
  if (vapidKey) subscribePush(vapidKey);

  // Join pending room if navigated here via link
  const pendingRoom = sessionStorage.getItem('pendingRoom');
  if (pendingRoom) {
    sessionStorage.removeItem('pendingRoom');
    setTimeout(() => joinRoom(pendingRoom), 1200);
  }
}

// ── SIGNUP ─────────────────────────────────────────
async function signup() {
  const btn = document.getElementById('signupBtn');
  btn.disabled = true; btn.textContent = 'Creating…';
  document.getElementById('signupError').textContent = '';
  try {
    const r = await fetch(API + '/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const d = await r.json();
    if (!d.net_number) throw new Error('Signup failed');

    myPin    = d.net_number;
    deviceId = d.device_id;
    localStorage.setItem('myPin', myPin);
    localStorage.setItem('deviceId', deviceId);

    // Save VAPID key from backend — this is the only source of truth
    if (d.vapid_public_key) {
      vapidKey = d.vapid_public_key;
      localStorage.setItem('vapidKey', vapidKey);
    }

    startApp();

    // Request notification permission and subscribe
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted' && vapidKey) subscribePush(vapidKey);
    }
  } catch(e) {
    document.getElementById('signupError').textContent = e.message;
    btn.disabled = false;
    btn.textContent = 'Get your PIN';
  }
}

// ── PUSH SUBSCRIPTION ──────────────────────────────
async function subscribePush(key) {
  if (!key || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(key)
    });
    await fetch(API + '/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ net_number: myPin, device_id: deviceId, subscription: sub.toJSON() })
    });
    console.log('[iNet] Push subscribed ✓');
  } catch(e) {
    console.warn('[iNet] Push subscription failed:', e.message);
    // Key mismatch or expired — fetch fresh key from backend and retry once
    if (e.name === 'InvalidStateError' || e.message.includes('key')) {
      await refreshVapidAndRetry();
    }
  }
}

async function refreshVapidAndRetry() {
  try {
    const r = await fetch(`${API}/whoami?net_number=${myPin}&device_id=${deviceId}`);
    const d = await r.json();
    if (d.vapid_public_key && d.vapid_public_key !== vapidKey) {
      vapidKey = d.vapid_public_key;
      localStorage.setItem('vapidKey', vapidKey);
      // Unsubscribe old, resubscribe with new key
      const reg = await navigator.serviceWorker.ready;
      const oldSub = await reg.pushManager.getSubscription();
      if (oldSub) await oldSub.unsubscribe();
      await subscribePush(vapidKey);
    }
  } catch(e) {
    console.warn('[iNet] VAPID refresh failed:', e.message);
  }
}

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── WEBSOCKET ──────────────────────────────────────
function connectWS() {
  if (!myPin || !deviceId) return;
  if (wsConnecting) return;
  if (ws && ws.readyState === WebSocket.OPEN) return;

  wsConnecting = true;
  setDot('ing');

  try {
    ws = new WebSocket(`${WS_URL}?net_number=${myPin}&device_id=${deviceId}`);
  } catch {
    wsConnecting = false;
    schedReconnect();
    return;
  }

  ws.onopen = () => {
    wsConnecting = false;
    setDot('on');
    clearTimeout(wsTimer); wsTimer = null;
    startHeartbeat();
    console.log('[iNet] WS connected');
  };

  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };

  ws.onerror = () => { wsConnecting = false; setDot(''); };

  ws.onclose = () => {
    wsConnecting = false;
    setDot('');
    stopHeartbeat();
    schedReconnect();
  };
}

function schedReconnect() {
  if (!wsTimer) wsTimer = setTimeout(() => { wsTimer = null; connectWS(); }, 3000);
}

// Heartbeat — keeps connection alive even when screen sleeps
function startHeartbeat() {
  stopHeartbeat();
  wsHeartbeat = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      stopHeartbeat();
      schedReconnect();
    }
  }, 25000);
}

function stopHeartbeat() {
  if (wsHeartbeat) { clearInterval(wsHeartbeat); wsHeartbeat = null; }
}

function setDot(s) {
  document.getElementById('wsDot').className = 'ws-dot' + (s ? ' ' + s : '');
}

function signal(target, type, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Not connected — retrying…');
    connectWS();
    return;
  }
  ws.send(JSON.stringify({ target, type, payload }));
}

// Group/room signal — uses `room` key not `target`
function sigRoom(room, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ room, type, payload }));
}

// ── PING / ONLINE STATUS ───────────────────────────
// Poll every 30s — marks contacts online/offline
// WhatsApp rule: if WS connected = online, even in background
function startPingLoop() {
  pingContacts();
  setInterval(pingContacts, 30000);
}

async function pingContacts() {
  if (!contacts.length) return;
  try {
    const r = await fetch(API + '/status/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contacts.map(c => c.pin))
    });
    const statuses = await r.json();
    Object.assign(onlineStatus, statuses);
    renderContacts();
    renderChats();
    if (currentChatId) updateChatStatus();
  } catch {}
}

// ── MESSAGE HANDLER ────────────────────────────────
function handleMsg(msg) {
  const { from, type, payload } = msg;

  if (type === 'pong') return;

  if (type === 'status_change') {
    onlineStatus[payload.net_number] = { online: payload.online, last_seen: payload.last_seen };
    renderContacts(); renderChats();
    if (currentChatId === payload.net_number) updateChatStatus();
    return;
  }

  switch (type) {
    case 'chat':         receiveChat(from, payload); break;
    case 'sync_deliver': payload.messages?.forEach(m => receiveChat(from, m)); break;
    case 'sync_request': flushPending(from); break;
    case 'call_offer':   handleCallOffer(from, payload); break;
    case 'call_answer':  handleCallAnswer(from, payload); break;
    case 'ice_candidate': handleIce(from, payload); break;
    case 'call_end':     endCall(false); break;
    case 'gc_offer':     handleGcOffer(from, payload); break;
    case 'gc_answer':    handleGcAnswer(from, payload); break;
    case 'gc_ice':       handleGcIce(from, payload); break;
    case 'gc_join':      handleGcJoin(from); break;
    case 'gc_leave':     handleGcLeave(from); break;
    case 'gc_invite':    handleGcInvite(from, payload); break;
  }
}

// Messages from service worker (e.g. user tapped notification)
function onSwMessage(e) {
  const { type, data } = e.data || {};
  if (type === 'ANSWER_CALL' && incomingBuffer) answerIncomingCall();
  if (type === 'DECLINE_CALL') declineCall();
  if (type === 'CANCEL_NOTIFICATIONS') {
    navigator.serviceWorker.ready.then(reg =>
      reg.active?.postMessage({ type: 'CANCEL_NOTIFICATIONS', payload: { tag: 'incoming-call' } })
    );
  }
}

// Show local notification when app is backgrounded (incoming call)
function showLocalNotif(from, callType) {
  if (!document.hidden) return;   // app is visible — in-app UI is enough
  navigator.serviceWorker.ready.then(reg => {
    reg.active?.postMessage({
      type: 'SHOW_NOTIFICATION',
      payload: {
        title:              `📞 Incoming ${callType === 'video' ? 'Video' : 'Audio'} Call`,
        body:               `PIN ${from} is calling you`,
        tag:                'incoming-call',
        requireInteraction: true,
        vibrate:            [500, 200, 500, 200, 500],
        data:               { type: 'incoming_call', from, call_type: callType },
        actions:            [{ action: 'answer', title: '✅ Answer' }, { action: 'decline', title: '❌ Decline' }]
      }
    });
  });
}

// ── CHAT ───────────────────────────────────────────
function sendMsg() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text || !currentChatId) return;

  const msg = { id: Date.now(), type: 'text', content: text,
                time: new Date().toISOString(), from: myPin };
  dispatchMsg(currentChatId, msg);
  input.value = '';
  input.style.height = '';
}

function dispatchMsg(pin, msg) {
  if (!chats[pin]) chats[pin] = [];
  chats[pin].push({ ...msg, dir: 'out', status: 'sending' });
  saveChats();

  if (onlineStatus[pin]?.online) {
    signal(pin, 'chat', msg);
    setMsgStatus(pin, msg.id, 'sent');
  } else {
    queuePending(pin, msg);
    setMsgStatus(pin, msg.id, 'pending');
  }
  renderChatMessages();
  renderChats();
}

function receiveChat(from, msg) {
  if (!chats[from]) chats[from] = [];
  if (chats[from].find(m => m.id === msg.id)) return;   // deduplicate
  chats[from].push({ ...msg, dir: 'in', status: 'delivered' });
  saveChats();

  if (currentChatId !== from) {
    unread[from] = (unread[from] || 0) + 1;
    localStorage.setItem('unread', JSON.stringify(unread));
    updateUnreadBadge();
  } else {
    renderChatMessages();
  }
  renderChats();
}

function queuePending(pin, msg) {
  if (!pending[pin]) pending[pin] = [];
  pending[pin].push(msg);
  localStorage.setItem('pending', JSON.stringify(pending));
}

function flushPending(to) {
  if (pending[to]?.length) {
    signal(to, 'sync_deliver', { messages: pending[to] });
    delete pending[to];
    localStorage.setItem('pending', JSON.stringify(pending));
  }
}

function setMsgStatus(pin, id, status) {
  const m = chats[pin]?.find(x => x.id === id);
  if (m) { m.status = status; saveChats(); }
}

function saveChats() { localStorage.setItem('chats', JSON.stringify(chats)); }

function updateUnreadBadge() {
  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  const badge = document.getElementById('chatsBadge');
  badge.style.display = total ? 'inline' : 'none';
  badge.textContent   = total > 99 ? '99+' : total;
}

// ── 1:1 CALLS ──────────────────────────────────────
async function startDMCall(type) {
  if (!currentChatId) return;
  callPeer = currentChatId;
  callType = type;
  callConnected = false;   // <-- reset

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: type === 'video' ? { facingMode: 'user', width: { ideal: 640 } } : false
    });

    showCallScreen(callPeer, 'Calling…', type);
    peerConn      = makePeerConn(callPeer);
    remoteDescSet = false;
    iceCandQueue  = [];
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    signal(callPeer, 'call_offer', { sdp: peerConn.localDescription, call_type: type });

    // 45s no-answer timeout
    callTimer = setTimeout(() => {
      if (document.getElementById('callStatus').textContent !== 'Connected') {
        document.getElementById('callStatus').textContent = 'No answer';
        setTimeout(() => endCall(true), 2000);
      }
    }, 45000);
  } catch(e) {
    toast('Media error: ' + e.message);
    endCall(true);
  }
}

function handleCallOffer(from, payload) {
  incomingBuffer = { from, payload };
  showIncoming(from, payload.call_type || 'audio');
  showLocalNotif(from, payload.call_type || 'audio');
}

async function answerIncomingCall() {
  if (!incomingBuffer) return;
  const { from, payload } = incomingBuffer;
  incomingBuffer = null;
  hideIncoming();
  callPeer = from;
  callType = payload.call_type || 'audio';
  callConnected = false;   // <-- reset

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 } } : false
    });

    showCallScreen(from, 'Connecting…', callType);
    peerConn      = makePeerConn(from);
    remoteDescSet = false;
    iceCandQueue  = [];
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    await peerConn.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    remoteDescSet = true;
    flushIceCandidates();

    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    signal(from, 'call_answer', { sdp: peerConn.localDescription });
  } catch(e) {
    toast('Call error: ' + e.message);
    endCall(true);
  }
}

function declineCall() {
  if (incomingBuffer) {
    signal(incomingBuffer.from, 'call_end', {});
    incomingBuffer = null;
  }
  hideIncoming();
}

function handleCallAnswer(from, payload) {
  if (!peerConn) return;
  peerConn.setRemoteDescription(new RTCSessionDescription(payload.sdp))
    .then(() => { remoteDescSet = true; flushIceCandidates(); });
}

function handleIce(from, payload) {
  const candidate = new RTCIceCandidate(payload.candidate);
  if (peerConn && remoteDescSet) {
    peerConn.addIceCandidate(candidate).catch(() => {});
  } else {
    iceCandQueue.push(candidate);   // buffer until remote desc is set
  }
}

function flushIceCandidates() {
  while (iceCandQueue.length) {
    peerConn?.addIceCandidate(iceCandQueue.shift()).catch(() => {});
  }
}

function makePeerConn(pin) {
  const pc = new RTCPeerConnection(ICE);

  pc.onicecandidate = e => {
    if (e.candidate) signal(pin, 'ice_candidate', { candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      callConnected = true;   // <-- mark as connected
      setCallStatus('Connected');
      document.getElementById('callOverlay').style.opacity = '0';
    }
    if (s === 'disconnected' || s === 'failed' || s === 'closed') {
      endCall(false);
    }
  };

  pc.ontrack = e => {
    if (callType === 'video') {
      document.getElementById('remoteVideo').srcObject = e.streams[0];
    } else {
      document.getElementById('remoteAudio').srcObject = e.streams[0];
    }
    setCallStatus('Connected');
    document.getElementById('callOverlay').style.opacity = '0';
    clearTimeout(callTimer);
    stopRingtone();
  };

  return pc;
}

function showCallScreen(pin, status, type) {
  document.getElementById('callName').textContent   = getContactName(pin);
  document.getElementById('callAvatar').textContent = pin[0];
  setCallStatus(status);
  document.getElementById('callOverlay').style.opacity = '1';

  const lv = document.getElementById('localVideo');
  lv.srcObject  = localStream;
  lv.style.display = type === 'video' ? 'block' : 'none';
  document.getElementById('remoteVideo').srcObject = null;

  document.getElementById('callScreen').classList.add('show');
  startRingtone();
}

function setCallStatus(s) {
  document.getElementById('callStatus').textContent = s;
}

function endCall(notify = true) {
  // Record missed call if never connected
  if (!callConnected && callPeer) {
    const missedCall = {
      with: callPeer,
      type: callType,
      dir: (callPeer === currentChatId ? 'out' : 'in'),
      time: new Date().toISOString(),
      missed: true
    };
    calls.unshift(missedCall);
    localStorage.setItem('calls', JSON.stringify(calls.slice(0, 100)));
    renderCalls(); // if needed
  }

  document.getElementById('callScreen').classList.remove('show');
  clearTimeout(callTimer);
  stopRingtone();

  if (notify && callPeer) signal(callPeer, 'call_end', {});
  peerConn?.close();
  localStream?.getTracks().forEach(t => t.stop());

  peerConn = null; localStream = null; callPeer = null;
  remoteDescSet = false; iceCandQueue = [];
  callConnected = false; // reset

  // Dismiss the incoming-call notification if it's showing
  navigator.serviceWorker?.ready.then(reg =>
    reg.active?.postMessage({ type: 'CANCEL_NOTIFICATIONS', payload: { tag: 'incoming-call' } })
  );
}

function toggleCallMute() {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !isMuted);
  document.getElementById('c1Mute').classList.toggle('muted', isMuted);
}

function toggleCallCam() {
  isCamOff = !isCamOff;
  localStream?.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  document.getElementById('c1Cam').classList.toggle('muted', isCamOff);
}

function toggleSpeaker() { toast('Speaker toggle — coming soon'); }

let ringtoneCtx = null, ringtoneInt = null;
function startRingtone() {
  stopRingtone();
  try {
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const play = () => {
      const osc  = ringtoneCtx.createOscillator();
      const gain = ringtoneCtx.createGain();
      osc.connect(gain); gain.connect(ringtoneCtx.destination);
      osc.frequency.value = 440; gain.gain.value = 0.15; osc.type = 'sine';
      osc.start(); osc.stop(ringtoneCtx.currentTime + 0.5);
    };
    play();
    ringtoneInt = setInterval(play, 2000);
  } catch {}
}
function stopRingtone() {
  clearInterval(ringtoneInt); ringtoneInt = null;
  ringtoneCtx?.close().catch(() => {}); ringtoneCtx = null;
}

function showIncoming(from, type) {
  startRingtone();
  document.getElementById('incomingName').textContent = getContactName(from);
  document.getElementById('incomingType').textContent =
    (type === 'video' ? '📹 Video' : '📞 Audio') + ' Call';
  document.getElementById('incomingOverlay').classList.add('show');
}
function hideIncoming() {
  document.getElementById('incomingOverlay').classList.remove('show');
  stopRingtone();
}

// ── GROUP / LINK CALLS ─────────────────────────────
// Room ID is just a short random string — NO 'room:' prefix stored here.
// The URL hash format is #room:ROOMID
// All internal state just uses the plain ROOMID.

function createLinkCall() {
  // Generate a clean room ID — no prefix
  myRoomId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  localStorage.setItem('myRoomId', myRoomId);
  updateLinkView();
  toast('Room created — share the link!');
}

function createLinkCallAndStart() {
  closeFab();
  createLinkCall();
  setTimeout(() => joinRoom(myRoomId), 100);
}

// The shareable URL always embeds the roomId cleanly
function getRoomUrl(roomId) {
  return `${location.origin}${location.pathname}#room:${roomId}`;
}

// Parse roomId from any input: URL, hash, or raw ID
function parseRoomId(input) {
  input = input.trim();
  // Full URL with hash
  if (input.includes('#room:')) return input.split('#room:')[1];
  // Just the hash part
  if (input.startsWith('room:')) return input.slice(5);
  // Raw ID
  return input;
}

function updateLinkView() {
  const card = document.getElementById('myLinkCard');
  if (myRoomId) {
    document.getElementById('myLinkUrl').textContent = getRoomUrl(myRoomId);
    card.style.display = 'block';
  } else {
    card.style.display = 'none';
  }
  const el = document.getElementById('recentRooms');
  el.innerHTML = recentRooms.length
    ? recentRooms.map(r => `
        <div class="item" onclick="joinRoom('${r.id}')">
          <div class="avatar" style="background:var(--blue-dim);color:var(--blue)">🔗</div>
          <div class="item-info">
            <div class="item-name">Room …${r.id.slice(-6)}</div>
            <div class="item-sub">${fmtTime(new Date(r.time).toISOString())}</div>
          </div>
        </div>`).join('')
    : '<div style="color:var(--text3);padding:8px 0;font-size:0.82rem">No recent rooms</div>';
}

function copyLink() {
  navigator.clipboard?.writeText(getRoomUrl(myRoomId)).then(() => toast('Link copied!'));
}

function joinMyLinkCall() {
  if (myRoomId) joinRoom(myRoomId);
}

function joinLinkCall() {
  const raw    = document.getElementById('joinRoomId').value;
  const roomId = parseRoomId(raw);
  if (!roomId) { toast('Enter a room link or ID'); return; }
  joinRoom(roomId);
}

async function joinRoom(roomId) {
  if (!myPin) { toast('Please sign up first'); return; }
  gcRoomId = roomId;

  // Clear hash so refreshing doesn't re-join
  if (location.hash) history.replaceState(null, '', location.pathname);

  document.getElementById('gcTitle').textContent = 'Room …' + roomId.slice(-6);

  try {
    gcStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    try { gcStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch(e) { toast('Mic needed for calls: ' + e.message); return; }
  }

  document.getElementById('gcLocalVideo').srcObject = gcStream;
  document.getElementById('groupCallScreen').classList.add('show');
  addGcTile(myPin, gcStream, true);

  // Tell backend we joined this room (broadcasts gc_join to all in room)
  sigRoom(roomId, 'gc_join', { from: myPin });
  startGcTimer();
  addRecentRoom(roomId);
}

// Received when another peer joins the room
function handleGcJoin(from) {
  if (!gcRoomId) return;
  toast(`${getContactName(from)} joined`);
  // We initiate the offer (lower PIN starts)
  if (myPin < from) createGcPeer(from, true);
  else createGcPeer(from, false);
}

async function createGcPeer(pin, initiator) {
  if (gcPeers[pin]) return;
  const pc = new RTCPeerConnection(ICE);
  gcPeers[pin] = pc;

  gcStream.getTracks().forEach(t => pc.addTrack(t, gcStream));

  pc.onicecandidate = e => {
    if (e.candidate) sigRoom(gcRoomId, 'gc_ice', { to: pin, candidate: e.candidate, from: myPin });
  };

  pc.ontrack = e => {
    addGcTile(pin, e.streams[0], false);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removeGcTile(pin);
    }
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sigRoom(gcRoomId, 'gc_offer', { to: pin, sdp: pc.localDescription, from: myPin });
  }
}

async function handleGcOffer(from, payload) {
  if (payload.to !== myPin) return;
  await createGcPeer(from, false);
  const pc = gcPeers[from];
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sigRoom(gcRoomId, 'gc_answer', { to: from, sdp: pc.localDescription, from: myPin });
}

async function handleGcAnswer(from, payload) {
  if (payload.to !== myPin) return;
  const pc = gcPeers[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
}

function handleGcIce(from, payload) {
  if (payload.to !== myPin) return;
  const pc = gcPeers[from];
  if (pc) pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
}

function handleGcLeave(from) {
  removeGcTile(from);
  gcPeers[from]?.close();
  delete gcPeers[from];
}

function handleGcInvite(from, payload) {
  showIncoming(from, 'group');
  document.getElementById('incomingType').textContent = '👥 Group Call';
  document.getElementById('answerBtn').onclick = () => {
    hideIncoming();
    joinRoom(payload.room);
  };
}

function addGcTile(pin, stream, isLocal) {
  removeGcTile(pin);
  const grid = document.getElementById('gcGrid');
  const tile = document.createElement('div');
  tile.className = 'gc-tile';
  tile.id = 'gc-tile-' + pin;
  const hasVideo = stream.getVideoTracks().some(t => t.enabled);
  if (hasVideo) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true;
    if (isLocal) v.muted = true;
    v.srcObject = stream;
    v.style.cssText = 'width:100%;height:100%;object-fit:cover';
    tile.appendChild(v);
  } else {
    const av = document.createElement('div');
    av.className = 'gc-tile-avatar';
    av.textContent = pin[0];
    tile.appendChild(av);
  }
  const ov = document.createElement('div');
  ov.className = 'gc-tile-overlay';
  ov.innerHTML = `<span class="gc-tile-name">${isLocal ? 'You' : getContactName(pin)}</span>`;
  tile.appendChild(ov);
  grid.appendChild(tile);
  updateGcGrid();
}

function removeGcTile(pin) {
  document.getElementById('gc-tile-' + pin)?.remove();
  updateGcGrid();
}

function updateGcGrid() {
  const grid = document.getElementById('gcGrid');
  grid.setAttribute('data-count', String(Math.min(grid.children.length, 4)));
}

function startGcTimer() {
  gcSecs = 0;
  gcTimer = setInterval(() => {
    gcSecs++;
    const m = String(Math.floor(gcSecs / 60)).padStart(2, '0');
    const s = String(gcSecs % 60).padStart(2, '0');
    document.getElementById('gcTimer').textContent = m + ':' + s;
  }, 1000);
}

function endGroupCall() {
  sigRoom(gcRoomId, 'gc_leave', { from: myPin });
  document.getElementById('groupCallScreen').classList.remove('show');
  clearInterval(gcTimer);
  gcStream?.getTracks().forEach(t => t.stop());
  Object.values(gcPeers).forEach(pc => pc.close());
  gcPeers = {}; gcRoomId = null;
  document.getElementById('gcGrid').innerHTML = '';
}

function toggleGcMute() {
  gcMuted = !gcMuted;
  gcStream?.getAudioTracks().forEach(t => t.enabled = !gcMuted);
  document.getElementById('gcMuteBtn').classList.toggle('muted', gcMuted);
}

function toggleGcCam() {
  gcCamOff = !gcCamOff;
  gcStream?.getVideoTracks().forEach(t => t.enabled = !gcCamOff);
}

function shareGroupCallLink() {
  if (!gcRoomId) return;
  const url = getRoomUrl(gcRoomId);
  if (navigator.share) navigator.share({ title: 'Join my iNet call', url });
  else navigator.clipboard?.writeText(url).then(() => toast('Link copied!'));
}

function showInviteToCall() {
  const online = contacts.filter(c => onlineStatus[c.pin]?.online && !gcPeers[c.pin]);
  if (!online.length) { toast('No online contacts to invite'); return; }
  online.forEach(c => signal(c.pin, 'gc_invite', { room: gcRoomId, from: myPin }));
  toast(`Invited ${online.length} contact${online.length > 1 ? 's' : ''}`);
}

function addRecentRoom(id) {
  recentRooms = [{ id, time: Date.now() }, ...recentRooms.filter(r => r.id !== id)].slice(0, 10);
  localStorage.setItem('recentRooms', JSON.stringify(recentRooms));
}

// ── VOICE RECORDING ────────────────────────────────
async function toggleVoice() {
  if (!isRecording) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRec = new MediaRecorder(stream);
      audioChunks = [];
      mediaRec.ondataavailable = e => audioChunks.push(e.data);
      mediaRec.onstop = () => {
        const reader = new FileReader();
        reader.onload = ev => {
          const msg = { id: Date.now(), type: 'audio', content: ev.target.result,
                        time: new Date().toISOString(), from: myPin };
          dispatchMsg(currentChatId, msg);
        };
        reader.readAsDataURL(new Blob(audioChunks, { type: 'audio/webm' }));
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRec.start();
      isRecording = true;
      document.getElementById('voiceBtn').classList.add('recording');
      toast('Recording…');
    } catch { toast('Microphone permission needed'); }
  } else {
    mediaRec?.stop();
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
  }
}

function handleFile(e) {
  const file = e.target.files[0];
  if (!file || !currentChatId) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const type = file.type.startsWith('image/') ? 'image'
               : file.type.startsWith('video/') ? 'video'
               : file.type.startsWith('audio/') ? 'audio' : 'file';
    const msg = { id: Date.now(), type, content: ev.target.result,
                  fileName: file.name, time: new Date().toISOString(), from: myPin };
    dispatchMsg(currentChatId, msg);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}

// ── CONTACTS ───────────────────────────────────────
function showAddContactModal() { closeFab(); openModal('addContactModal'); }

function addContact() {
  const pin  = document.getElementById('contactPinInput').value.trim();
  const name = document.getElementById('contactNameInput').value.trim();
  if (pin.length !== 6 || !/^\d{6}$/.test(pin)) { toast('Enter a valid 6-digit PIN'); return; }
  if (pin === myPin) { toast("That's your own PIN!"); return; }
  if (contacts.find(c => c.pin === pin)) { toast('Already in contacts'); closeModal('addContactModal'); return; }
  contacts.push({ pin, name: name || pin, added: new Date().toISOString() });
  localStorage.setItem('contacts', JSON.stringify(contacts));
  document.getElementById('contactPinInput').value = '';
  document.getElementById('contactNameInput').value = '';
  closeModal('addContactModal');
  renderContacts();
  toast('Contact added');
}

function getContactName(pin) {
  if (pin === myPin) return 'You';
  return contacts.find(c => c.pin === pin)?.name || pin;
}

// ── RENDER ─────────────────────────────────────────
function renderAll() { renderContacts(); renderChats(); renderCalls(); updateUnreadBadge(); }

function renderContacts() {
  const list  = document.getElementById('contactsList');
  const empty = document.getElementById('contactsEmpty');
  if (!contacts.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  list.innerHTML = contacts.map(c => {
    const online = onlineStatus[c.pin]?.online;
    return `<div class="item" onclick="openDMChat('${c.pin}')">
      <div class="avatar ${online ? 'avatar-online' : ''}">${c.pin[0]}</div>
      <div class="item-info">
        <div class="item-name">${esc(c.name || c.pin)}</div>
        <div class="item-sub">PIN ${c.pin}</div>
      </div>
      <span style="font-size:0.75rem;color:${online ? 'var(--green)' : 'var(--text3)'}">
        ${online ? 'online' : 'offline'}
      </span>
    </div>`;
  }).join('');
}

function renderChats() {
  const list  = document.getElementById('chatsList');
  const empty = document.getElementById('chatsEmpty');
  const keys  = Object.keys(chats);
  if (!keys.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  const sorted = [...keys].sort((a, b) => {
    const ta = chats[a]?.slice(-1)[0]?.time || '';
    const tb = chats[b]?.slice(-1)[0]?.time || '';
    return tb < ta ? -1 : 1;
  });
  list.innerHTML = sorted.map(key => {
    const last    = chats[key]?.slice(-1)[0];
    const name    = getContactName(key);
    const preview = last ? (last.type === 'text' ? last.content.slice(0, 40) : '📎 Media') : '';
    const online  = onlineStatus[key]?.online;
    return `<div class="item" onclick="openDMChat('${key}')">
      <div class="avatar ${online ? 'avatar-online' : ''}">${name[0]}</div>
      <div class="item-info">
        <div class="item-name">${esc(name)}</div>
        <div class="item-sub">${last?.dir === 'out' ? 'You: ' : ''}${esc(preview)}</div>
      </div>
      <div class="item-right">
        <span class="item-time">${last ? fmtTime(last.time) : ''}</span>
        ${unread[key] ? `<span class="unread-badge">${unread[key]}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function renderCalls() {
  const list  = document.getElementById('callsList');
  const empty = document.getElementById('callsEmpty');
  if (!calls.length) { list.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  list.innerHTML = calls.slice(0, 50).map(c => `
    <div class="item" onclick="openDMChat('${c.with}')">
      <div class="avatar" style="font-size:1.3rem">${c.type === 'video' ? '📹' : '📞'}</div>
      <div class="item-info">
        <div class="item-name">${esc(getContactName(c.with))}</div>
        <div class="item-sub">${c.dir === 'out' ? 'Outgoing' : 'Incoming'} ${c.type} ${c.missed ? '(missed)' : ''}</div>
      </div>
      <span class="item-time">${fmtTime(c.time)}</span>
    </div>`).join('');
}

function renderChatMessages() {
  const c   = document.getElementById('chatMessages');
  const key = currentChatId;
  if (!key || !chats[key]) { c.innerHTML = ''; return; }
  c.innerHTML = chats[key].map(m => {
    const own = m.dir === 'out';
    let body  = '';
    if      (m.type === 'text')  body = `<div class="bubble">${esc(m.content)}</div>`;
    else if (m.type === 'image') body = `<img src="${m.content}" class="msg-img" onclick="window.open(this.src)">`;
    else if (m.type === 'audio') body = `<audio src="${m.content}" class="msg-audio" controls></audio>`;
    else                         body = `<div class="bubble">📎 ${esc(m.fileName || 'File')}</div>`;
    const tick = own
      ? `<span class="tick ${m.status === 'sent' ? 'sent' : ''}">${m.status === 'pending' ? '⏳' : '✓'}</span>`
      : '';
    return `<div class="msg ${own ? 'own' : ''}">${body}
      <div class="msg-meta">${fmtTime(m.time)} ${tick}</div>
    </div>`;
  }).join('');
  c.scrollTop = c.scrollHeight;
}

// ── UI HELPERS ─────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(tab + 'View').classList.add('active');
  if (tab === 'chats') {
    unread = {};
    localStorage.setItem('unread', JSON.stringify(unread));
    updateUnreadBadge();
  }
}

function toggleFab() {
  fabOpen = !fabOpen;
  document.getElementById('fabMenu').classList.toggle('open', fabOpen);
  document.getElementById('fab').innerHTML = fabOpen
    ? '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
}
function closeFab() {
  fabOpen = false;
  document.getElementById('fabMenu').classList.remove('open');
  document.getElementById('fab').innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
}

function openDMChat(pin) {
  currentChatId = pin;
  clearUnread(pin);
  document.getElementById('chatName').textContent   = getContactName(pin);
  document.getElementById('chatActions').style.display = 'flex';
  updateChatStatus();
  document.getElementById('chatScreen').classList.add('show');
  renderChatMessages();
  // When this contact comes online, flush pending messages
  flushPending(pin);
}

function clearUnread(key) {
  if (unread[key]) {
    delete unread[key];
    localStorage.setItem('unread', JSON.stringify(unread));
    updateUnreadBadge();
  }
}

function updateChatStatus() {
  const s      = document.getElementById('chatStatus');
  const online = onlineStatus[currentChatId]?.online;
  s.textContent = online ? 'online' : 'offline';
  s.className   = 'screen-status' + (online ? ' online' : '');
}

function closeChat() {
  document.getElementById('chatScreen').classList.remove('show');
  currentChatId = null;
}

function openModal(id)  { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
function copyPin()      { navigator.clipboard?.writeText(myPin).then(() => toast('PIN copied!')); }
function installApp()   {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  } else toast('Use browser menu → Add to Home Screen');
}

function autoResize(el) {
  el.style.height = '';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function makeDraggable(el) {
  let sx, sy, ex, ey;
  el.addEventListener('touchstart', e => {
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY;
    const r = el.getBoundingClientRect();
    ex = r.left; ey = r.top;
  }, { passive: true });
  el.addEventListener('touchmove', e => {
    const t = e.touches[0];
    el.style.left   = (ex + t.clientX - sx) + 'px';
    el.style.top    = (ey + t.clientY - sy) + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
  }, { passive: true });
}

function fmtTime(iso) {
  const d   = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function esc(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className   = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function log(...args) { console.log('[iNet]', ...args); }

// ── EXPOSE TO HTML onclick handlers ───────────────
Object.assign(window, {
  signup, copyPin, installApp,
  switchTab, toggleFab, closeFab,
  openModal, closeModal,
  showAddContactModal, addContact,
  openDMChat, closeChat,
  sendMsg, toggleVoice, autoResize,
  startDMCall,
  answerIncomingCall, declineCall,
  endCall, toggleCallMute, toggleCallCam, toggleSpeaker,
  createLinkCall, createLinkCallAndStart,
  copyLink, joinMyLinkCall, joinLinkCall,
  endGroupCall, toggleGcMute, toggleGcCam,
  shareGroupCallLink, showInviteToCall,
  toggleGcSpeaker: () => toast('Speaker toggle coming soon'),
});

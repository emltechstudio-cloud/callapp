// ═══════════════════════════════════════════════════
// iNet app.js  — all JavaScript for app.html
// Bug fixes:
//  #1  Contacts view blank on startup            → view.active in HTML + explicit activate in startApp
//  #2  Incoming overlay stuck if caller cancels  → endCall clears incomingBuffer & hides overlay
//  #3  Group call — new joiner invisible         → existing member ALWAYS initiates; handles gc_members
//  #4  answerBtn.onclick overwritten by gc invite → incomingAnswerAction state variable
//  #5  Voice note sent to wrong chat             → capture currentChatId at recording start
//  #6  Stale gcPeers entry on failure            → delete gcPeers[pin] + pc.close() in handler
//  #7  Missed call direction wrong               → dedicated callDirection variable
//  #8  startGcTimer interval leak                → clearInterval before starting
//  #9  endCall doesn't clear incomingBuffer      → covered in #2 fix
//  #10 handleGcOffer double-processes peers      → guard on existing remoteDescription
//  #11 Dead CANCEL_NOTIFICATIONS in onSwMessage  → removed
//  #12 No file size check before base64 send     → 2 MB cap on handleFile
//  #13 No clipboard fallback                     → fallbackCopy() with execCommand
//  #14 SW focusOrOpen URL mismatch               → fixed in sw.js
//  #15 gcLocalVideo.srcObject not nulled         → nulled in endGroupCall
// ═══════════════════════════════════════════════════

const API    = 'https://emltechstudio-inet.hf.space';
const WS_URL = 'wss://emltechstudio-inet.hf.space/ws';
const ICE    = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',              username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
]};

const FILE_MAX_BYTES = 2 * 1024 * 1024; // #12 — 2 MB file cap

// ── STATE ──────────────────────────────────────────
let myPin    = localStorage.getItem('myPin');
let deviceId = localStorage.getItem('deviceId');
let vapidKey = localStorage.getItem('vapidKey');

let ws = null, wsTimer = null, wsConnecting = false, wsHeartbeat = null;

let contacts    = JSON.parse(localStorage.getItem('contacts')     || '[]');
let chats       = JSON.parse(localStorage.getItem('chats')        || '{}');
let calls       = JSON.parse(localStorage.getItem('calls')        || '[]');
let pending     = JSON.parse(localStorage.getItem('pending')      || '{}');
let unread      = JSON.parse(localStorage.getItem('unread')       || '{}');
let recentRooms = JSON.parse(localStorage.getItem('recentRooms')  || '[]');

let onlineStatus  = {};
let currentChatId = null;
let fabOpen       = false;
let deferredPrompt = null;

// 1:1 call state
let localStream    = null;
let peerConn       = null;
let callPeer       = null;
let callType       = null;
let callTimer      = null;
let isMuted        = false;
let isCamOff       = false;
let incomingBuffer = null;
let iceCandQueue   = [];
let remoteDescSet  = false;
let callConnected  = false;
let callDirection  = 'out'; // #7 — 'out' | 'in'

// #4 — incoming answer action state (prevents answerBtn.onclick from being overwritten)
let incomingAnswerAction = 'dm'; // 'dm' | 'group'
let incomingGroupRoom    = null;

// Group call state
let gcRoomId  = null;
let gcStream  = null;
let gcPeers   = {};
let gcTimer   = null;
let gcSecs    = 0;
let gcMuted   = false;
let gcCamOff  = false;

// Voice recording
let mediaRec    = null;
let audioChunks = [];
let isRecording = false;

// Link call room
let myRoomId = localStorage.getItem('myRoomId') || null;

// ── INIT ───────────────────────────────────────────
(function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', onSwMessage);
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    document.getElementById('installBtn').style.display = 'block';
  });

  document.getElementById('fileInput').addEventListener('change', handleFile);
  makeDraggable(document.getElementById('gcLocalPip'));
  makeDraggable(document.getElementById('localVideo'));

  // Handle ?action=incoming — app was opened by tapping a call notification.
  // Store call data in sessionStorage; startApp() will pick it up and show
  // the ringing screen immediately after WS connects.
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('action') === 'incoming') {
    const from     = urlParams.get('from');
    const callType = urlParams.get('call_type') || 'audio';
    const room     = urlParams.get('room');
    if (from) {
      sessionStorage.setItem('pendingIncoming', JSON.stringify({ from, call_type: callType, room }));
    }
    history.replaceState(null, '', location.pathname);
  }

  const hash = location.hash.replace('#', '');
  if (hash.startsWith('room:')) {
    const roomId = hash.slice(5);
    if (myPin) setTimeout(() => joinRoom(roomId), 1200);
    else sessionStorage.setItem('pendingRoom', roomId);
  }

  if (myPin && deviceId) {
    startApp();
  } else {
    document.getElementById('signupView').style.display = 'flex';
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN)) connectWS();
  });
  window.addEventListener('online', () => connectWS());
})();

// ── START APP ──────────────────────────────────────
function startApp() {
  document.getElementById('signupView').style.display = 'none';
  document.getElementById('tabs').style.display       = 'flex';
  document.getElementById('fab').classList.add('visible');

  const badge = document.getElementById('pinBadge');
  badge.textContent = myPin;
  badge.classList.add('active');

  // #1 — explicitly activate contacts view (HTML already has class="view active" as default)
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('contactsView').classList.add('active');
  document.querySelector('.tab[data-tab="contacts"]').classList.add('active');

  connectWS();
  renderAll();
  startPingLoop();
  updateLinkView();

  if (vapidKey) subscribePush(vapidKey);

  const pendingRoom = sessionStorage.getItem('pendingRoom');
  if (pendingRoom) {
    sessionStorage.removeItem('pendingRoom');
    setTimeout(() => joinRoom(pendingRoom), 1200);
  }

  // Opened from a call notification — show ringing screen straight away
  const pendingIncomingRaw = sessionStorage.getItem('pendingIncoming');
  if (pendingIncomingRaw) {
    sessionStorage.removeItem('pendingIncoming');
    try {
      const pi = JSON.parse(pendingIncomingRaw);
      // Show ringing UI immediately; the actual WebRTC offer will arrive
      // via WS within a second and handleCallOffer() will populate incomingBuffer
      callDirection        = 'in';
      incomingAnswerAction = 'dm';
      setTimeout(() => showIncoming(pi.from, pi.call_type || 'audio'), 400);
    } catch {}
  }
}

// ── SIGNUP ─────────────────────────────────────────
async function signup() {
  const btn = document.getElementById('signupBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  document.getElementById('signupError').textContent = '';
  try {
    const r = await fetch(API + '/signup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({})
    });
    const d = await r.json();
    if (!d.net_number) throw new Error('Signup failed');

    myPin    = d.net_number;
    deviceId = d.device_id;
    localStorage.setItem('myPin',    myPin);
    localStorage.setItem('deviceId', deviceId);

    if (d.vapid_public_key) {
      vapidKey = d.vapid_public_key;
      localStorage.setItem('vapidKey', vapidKey);
    }

    startApp();

    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted' && vapidKey) subscribePush(vapidKey);
    }
  } catch (e) {
    document.getElementById('signupError').textContent = e.message;
    btn.disabled    = false;
    btn.textContent = 'Get your PIN';
  }
}

// ── PUSH SUBSCRIPTION ──────────────────────────────
async function subscribePush(key) {
  if (!key || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: b64ToUint8(key)
    });
    await fetch(API + '/push/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ net_number: myPin, device_id: deviceId, subscription: sub.toJSON() })
    });
  } catch (e) {
    if (e.name === 'InvalidStateError' || String(e.message).includes('key')) {
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
      const reg    = await navigator.serviceWorker.ready;
      const oldSub = await reg.pushManager.getSubscription();
      if (oldSub) await oldSub.unsubscribe();
      await subscribePush(vapidKey);
    }
  } catch {}
}

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ── WEBSOCKET ──────────────────────────────────────
function connectWS() {
  if (!myPin || !deviceId)                          return;
  if (wsConnecting)                                  return;
  if (ws && ws.readyState === WebSocket.OPEN)        return;

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
    clearTimeout(wsTimer);
    wsTimer = null;
    startHeartbeat();
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

function sigRoom(room, type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ room, type, payload }));
}

// ── PING / ONLINE STATUS ───────────────────────────
function startPingLoop() {
  pingContacts();
  setInterval(pingContacts, 30000);
}

async function pingContacts() {
  if (!contacts.length) return;
  try {
    const r = await fetch(API + '/status/batch', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(contacts.map(c => c.pin))
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
    renderContacts();
    renderChats();
    if (currentChatId === payload.net_number) updateChatStatus();
    return;
  }

  switch (type) {
    case 'chat':          receiveChat(from, payload);          break;
    case 'sync_deliver':  payload.messages?.forEach(m => receiveChat(from, m)); break;
    case 'sync_request':  flushPending(from);                  break;
    case 'call_offer':    handleCallOffer(from, payload);      break;
    case 'call_answer':   handleCallAnswer(from, payload);     break;
    case 'ice_candidate': handleIce(from, payload);            break;
    case 'call_end':      handleRemoteCallEnd();               break;
    // Group calls
    case 'gc_join':       handleGcJoin(from);                  break;
    case 'gc_members':    handleGcMembers(payload);            break; // #3
    case 'gc_offer':      handleGcOffer(from, payload);        break;
    case 'gc_answer':     handleGcAnswer(from, payload);       break;
    case 'gc_ice':        handleGcIce(from, payload);          break;
    case 'gc_leave':      handleGcLeave(from);                 break;
    case 'gc_invite':     handleGcInvite(from, payload);       break;
  }
}

// #11 — removed dead CANCEL_NOTIFICATIONS branch; SW handles that itself
function onSwMessage(e) {
  const { type, data } = e.data || {};
  // Notification tapped while app was open in background — show ringing screen
  if (type === 'SHOW_INCOMING' && data?.from) {
    callDirection        = 'in';
    incomingAnswerAction = 'dm';
    showIncoming(data.from, data.call_type || 'audio');
  }
  if (type === 'ANSWER_CALL')                answerIncomingCall();
  if (type === 'DECLINE_CALL')               declineCall();
  if (type === 'CALL_NOTIFICATION_DISMISSED') {
    if (incomingBuffer) declineCall();
  }
}

function showLocalNotif(from, callType) {
  // Use SHOW_CALL_NOTIFICATION so SW starts the ring loop
  navigator.serviceWorker?.ready.then(reg =>
    reg.active?.postMessage({
      type:    'SHOW_CALL_NOTIFICATION',
      payload: { from, call_type: callType, type: 'incoming_call' }
    })
  );
}

// ── CHAT ───────────────────────────────────────────
function sendMsg() {
  const input = document.getElementById('msgInput');
  const text  = input.value.trim();
  if (!text || !currentChatId) return;

  const msg = {
    id:      Date.now(),
    type:    'text',
    content: text,
    time:    new Date().toISOString(),
    from:    myPin
  };
  dispatchMsg(currentChatId, msg);
  input.value        = '';
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
  if (chats[from].find(m => m.id === msg.id)) return; // dedup
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

  callPeer       = currentChatId;
  callType       = type;
  callConnected  = false;
  callDirection  = 'out'; // #7

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: type === 'video' ? { facingMode: 'user', width: { ideal: 640 } } : false
    });

    showCallScreen(callPeer, 'Calling…', type);
    remoteDescSet = false;
    iceCandQueue  = [];
    peerConn      = makePeerConn(callPeer);
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    const offer = await peerConn.createOffer();
    await peerConn.setLocalDescription(offer);
    signal(callPeer, 'call_offer', { sdp: peerConn.localDescription, call_type: type });

    callTimer = setTimeout(() => {
      if (document.getElementById('callStatus').textContent !== 'Connected') {
        document.getElementById('callStatus').textContent = 'No answer';
        setTimeout(() => endCall(true), 2000);
      }
    }, 45000);
  } catch (e) {
    toast('Media error: ' + e.message);
    endCall(false);
  }
}

function handleCallOffer(from, payload) {
  incomingBuffer       = { from, payload };
  callDirection        = 'in';
  incomingAnswerAction = 'dm';
  // Only show ringing UI if not already visible (may have been opened from notification)
  const overlayVisible = document.getElementById('incomingOverlay').classList.contains('show');
  if (!overlayVisible) {
    showIncoming(from, payload.call_type || 'audio');
  }
  // Only fire SW notification if app is backgrounded/hidden
  if (document.hidden) {
    showLocalNotif(from, payload.call_type || 'audio');
  }
}

async function answerIncomingCall() {
  // #4 — group call invite handled separately
  if (incomingAnswerAction === 'group') {
    const room = incomingGroupRoom;
    incomingAnswerAction = 'dm';
    incomingGroupRoom    = null;
    incomingBuffer       = null;
    hideIncoming();
    joinRoom(room);
    return;
  }

  // If app was opened from a notification, incomingBuffer may not have arrived
  // yet (offer is still in flight over WS). Wait up to 5s for it.
  if (!incomingBuffer) {
    toast('Connecting…');
    const waited = await waitForIncomingBuffer(5000);
    if (!waited) {
      toast('Call no longer available');
      hideIncoming();
      return;
    }
  }

  const { from, payload } = incomingBuffer;
  incomingBuffer = null;
  hideIncoming();

  callPeer      = from;
  callType      = payload.call_type || 'audio';
  callConnected = false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 } } : false
    });

    showCallScreen(from, 'Connecting…', callType);
    remoteDescSet = false;
    iceCandQueue  = [];
    peerConn      = makePeerConn(from);
    localStream.getTracks().forEach(t => peerConn.addTrack(t, localStream));

    await peerConn.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    remoteDescSet = true;
    flushIceCandidates();

    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    signal(from, 'call_answer', { sdp: peerConn.localDescription });
  } catch (e) {
    toast('Call error: ' + e.message);
    endCall(false);
  }
}

// Poll every 200ms until incomingBuffer is populated or timeout is reached
function waitForIncomingBuffer(timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (incomingBuffer) { resolve(true); return; }
      if (Date.now() - start >= timeoutMs) { resolve(false); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function declineCall() {
  if (incomingAnswerAction === 'group') {
    incomingAnswerAction = 'dm';
    incomingGroupRoom    = null;
  }
  if (incomingBuffer) {
    signal(incomingBuffer.from, 'call_end', {});
    incomingBuffer = null;
  }
  hideIncoming();
}

function handleCallAnswer(from, payload) {
  if (!peerConn) return;
  peerConn.setRemoteDescription(new RTCSessionDescription(payload.sdp))
    .then(() => { remoteDescSet = true; flushIceCandidates(); })
    .catch(() => {});
}

function handleIce(from, payload) {
  const candidate = new RTCIceCandidate(payload.candidate);
  if (peerConn && remoteDescSet) {
    peerConn.addIceCandidate(candidate).catch(() => {});
  } else {
    iceCandQueue.push(candidate);
  }
}

function flushIceCandidates() {
  while (iceCandQueue.length) {
    peerConn?.addIceCandidate(iceCandQueue.shift()).catch(() => {});
  }
}

// #2 — caller sent call_end while we were ringing; dismiss everything cleanly
function handleRemoteCallEnd() {
  if (incomingBuffer) {
    incomingBuffer = null;
    hideIncoming();
    stopRingtone();
    cancelCallNotif();
    return;
  }
  endCall(false);
}

function makePeerConn(pin) {
  const pc = new RTCPeerConnection(ICE);

  pc.onicecandidate = e => {
    if (e.candidate) signal(pin, 'ice_candidate', { candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      callConnected = true;
      setCallStatus('Connected');
      document.getElementById('callOverlay').style.opacity = '0';
      stopRingtone();
      clearTimeout(callTimer);
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
    callConnected = true;
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
  lv.srcObject    = localStream;
  lv.style.display = type === 'video' ? 'block' : 'none';
  document.getElementById('remoteVideo').srcObject = null;

  document.getElementById('callScreen').classList.add('show');
  startRingtone();
}

function setCallStatus(s) {
  document.getElementById('callStatus').textContent = s;
}

function endCall(notify = true) {
  // #2 & #9 — always clear incomingBuffer and hide overlay
  if (incomingBuffer) { incomingBuffer = null; }
  hideIncoming();

  // #7 — record missed call using callDirection
  if (!callConnected && callPeer) {
    calls.unshift({
      with:   callPeer,
      type:   callType   || 'audio',
      dir:    callDirection,            // #7 fix
      time:   new Date().toISOString(),
      missed: true
    });
    localStorage.setItem('calls', JSON.stringify(calls.slice(0, 100)));
    renderCalls();
  }

  document.getElementById('callScreen').classList.remove('show');
  clearTimeout(callTimer);
  stopRingtone();
  cancelCallNotif();

  if (notify && callPeer) signal(callPeer, 'call_end', {});

  peerConn?.close();
  localStream?.getTracks().forEach(t => t.stop());

  peerConn       = null;
  localStream    = null;
  callPeer       = null;
  remoteDescSet  = false;
  iceCandQueue   = [];
  callConnected  = false;
}

function cancelCallNotif() {
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

// ── RINGTONE ───────────────────────────────────────
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
    (type === 'video' ? 'Video' : type === 'group' ? 'Group' : 'Audio') + ' Call';
  document.getElementById('incomingOverlay').classList.add('show');
}

function hideIncoming() {
  document.getElementById('incomingOverlay').classList.remove('show');
  stopRingtone();
}

// ── GROUP / LINK CALLS ─────────────────────────────
function createLinkCall() {
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

function getRoomUrl(roomId) {
  return `${location.origin}${location.pathname}#room:${roomId}`;
}

function parseRoomId(input) {
  input = input.trim();
  if (input.includes('#room:')) return input.split('#room:')[1];
  if (input.startsWith('room:')) return input.slice(5);
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
          <div class="avatar" style="background:var(--blue-dim);color:var(--blue)">&#128279;</div>
          <div class="item-info">
            <div class="item-name">Room …${r.id.slice(-6)}</div>
            <div class="item-sub">${fmtTime(new Date(r.time).toISOString())}</div>
          </div>
        </div>`).join('')
    : '<div style="color:var(--text3);padding:8px 0;font-size:0.82rem">No recent rooms</div>';
}

function copyLink() {
  copyToClipboard(getRoomUrl(myRoomId), 'Link copied!');
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

  if (location.hash) history.replaceState(null, '', location.pathname);

  document.getElementById('gcTitle').textContent = 'Room …' + roomId.slice(-6);

  try {
    gcStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    try { gcStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('Mic needed: ' + e.message); return; }
  }

  document.getElementById('gcLocalVideo').srcObject = gcStream;
  document.getElementById('groupCallScreen').classList.add('show');
  addGcTile(myPin, gcStream, true);

  // Signal the room — backend will send back gc_members with existing members (#3)
  sigRoom(roomId, 'gc_join', { from: myPin });
  startGcTimer(); // #8 — clears old timer internally
  addRecentRoom(roomId);
}

// #3 — existing member always initiates to new joiner (no more PIN comparison)
function handleGcJoin(from) {
  if (!gcRoomId) return;
  toast(`${getContactName(from)} joined`);
  createGcPeer(from, true); // existing member sends the offer
}

// #3 — new joiner receives member list from backend and initiates to all of them
function handleGcMembers(payload) {
  const members = payload?.members || [];
  members.forEach(pin => {
    if (pin !== myPin) createGcPeer(pin, true); // new joiner initiates
  });
}

async function createGcPeer(pin, initiator) {
  if (gcPeers[pin]) return;
  const pc = new RTCPeerConnection(ICE);
  gcPeers[pin] = pc;

  gcStream?.getTracks().forEach(t => pc.addTrack(t, gcStream));

  pc.onicecandidate = e => {
    if (e.candidate) sigRoom(gcRoomId, 'gc_ice', { to: pin, candidate: e.candidate, from: myPin });
  };

  pc.ontrack = e => { addGcTile(pin, e.streams[0], false); };

  // #6 — properly clean up stale peer on failure
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'closed') {
      removeGcTile(pin);
      delete gcPeers[pin];
      try { pc.close(); } catch {}
    }
  };

  if (initiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sigRoom(gcRoomId, 'gc_offer', { to: pin, sdp: pc.localDescription, from: myPin });
    } catch {}
  }
}

// #10 — guard against double-processing existing peers
async function handleGcOffer(from, payload) {
  if (payload.to !== myPin) return;

  // If peer already exists with a remote description, skip (already negotiated)
  if (gcPeers[from]?.remoteDescription) return;

  await createGcPeer(from, false);
  const pc = gcPeers[from];
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sigRoom(gcRoomId, 'gc_answer', { to: from, sdp: pc.localDescription, from: myPin });
  } catch {}
}

async function handleGcAnswer(from, payload) {
  if (payload.to !== myPin) return;
  const pc = gcPeers[from];
  if (pc) {
    try { await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp)); } catch {}
  }
}

function handleGcIce(from, payload) {
  if (payload.to !== myPin) return;
  const pc = gcPeers[from];
  if (pc) pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
}

function handleGcLeave(from) {
  removeGcTile(from);
  const pc = gcPeers[from];
  if (pc) { try { pc.close(); } catch {} delete gcPeers[from]; }
}

// #4 — group call invite uses state variable instead of overwriting answerBtn.onclick
function handleGcInvite(from, payload) {
  incomingAnswerAction = 'group';
  incomingGroupRoom    = payload.room;
  showIncoming(from, 'group');
}

function addGcTile(pin, stream, isLocal) {
  removeGcTile(pin);
  const grid = document.getElementById('gcGrid');
  const tile = document.createElement('div');
  tile.className = 'gc-tile';
  tile.id        = 'gc-tile-' + pin;

  const hasVideo = stream?.getVideoTracks().some(t => t.enabled && t.readyState === 'live');
  if (hasVideo) {
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true;
    if (isLocal) v.muted = true;
    v.srcObject = stream;
    v.style.cssText = 'width:100%;height:100%;object-fit:cover';
    tile.appendChild(v);
  } else {
    const av = document.createElement('div');
    av.className   = 'gc-tile-avatar';
    av.textContent = pin[0];
    tile.appendChild(av);
  }

  const ov = document.createElement('div');
  ov.className = 'gc-tile-overlay';
  ov.innerHTML = `<span class="gc-tile-name">${isLocal ? 'You' : esc(getContactName(pin))}</span>`;
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

// #8 — always clear any existing timer before starting a new one
function startGcTimer() {
  clearInterval(gcTimer);
  gcSecs  = 0;
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

  // #15 — null the video element srcObject to release the stream reference
  const gcLocalVideo = document.getElementById('gcLocalVideo');
  gcLocalVideo.srcObject = null;

  Object.values(gcPeers).forEach(pc => { try { pc.close(); } catch {} });
  gcPeers  = {};
  gcRoomId = null;
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
  document.getElementById('gcCamBtn').classList.toggle('muted', gcCamOff);
}

function shareGroupCallLink() {
  if (!gcRoomId) return;
  const url = getRoomUrl(gcRoomId);
  if (navigator.share) navigator.share({ title: 'Join my iNet call', url });
  else copyToClipboard(url, 'Link copied!');
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
    if (!currentChatId) { toast('Open a chat first'); return; }
    const targetPin = currentChatId; // #5 — capture NOW, not later

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRec     = new MediaRecorder(stream);
      audioChunks  = [];

      mediaRec.ondataavailable = e => audioChunks.push(e.data);

      mediaRec.onstop = () => {
        const reader = new FileReader();
        reader.onload = ev => {
          const msg = {
            id:      Date.now(),
            type:    'audio',
            content: ev.target.result,
            time:    new Date().toISOString(),
            from:    myPin
          };
          dispatchMsg(targetPin, msg); // #5 — use captured pin
        };
        reader.readAsDataURL(new Blob(audioChunks, { type: 'audio/webm' }));
        stream.getTracks().forEach(t => t.stop());
      };

      mediaRec.start();
      isRecording = true;
      document.getElementById('voiceBtn').classList.add('recording');
      toast('Recording… tap again to send');
    } catch {
      toast('Microphone permission needed');
    }
  } else {
    mediaRec?.stop();
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
  }
}

// ── FILE HANDLING ──────────────────────────────────
function handleFile(e) {
  const file = e.target.files[0];
  if (!file || !currentChatId) return;

  // #12 — reject files over 2 MB to avoid oversized WebSocket payloads
  if (file.size > FILE_MAX_BYTES) {
    toast('File too large — max 2 MB');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = ev => {
    const type = file.type.startsWith('image/') ? 'image'
               : file.type.startsWith('video/') ? 'video'
               : file.type.startsWith('audio/') ? 'audio' : 'file';
    const msg = {
      id:       Date.now(),
      type,
      content:  ev.target.result,
      fileName: file.name,
      time:     new Date().toISOString(),
      from:     myPin
    };
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
  if (pin === myPin)                              { toast("That's your own PIN!");      return; }
  if (contacts.find(c => c.pin === pin))          {
    toast('Already in contacts');
    closeModal('addContactModal');
    return;
  }
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
function renderAll() {
  renderContacts();
  renderChats();
  renderCalls();
  updateUnreadBadge();
}

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
    const preview = last ? (last.type === 'text' ? last.content.slice(0, 40) : 'Media') : '';
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
      <div class="avatar" style="font-size:1.3rem">${c.type === 'video' ? '&#128249;' : '&#128222;'}</div>
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
    else                         body = `<div class="bubble">&#128206; ${esc(m.fileName || 'File')}</div>`;

    const tick = own
      ? `<span class="tick ${m.status === 'sent' ? 'sent' : ''}">
           ${m.status === 'pending' ? '&#9203;' : '&#10003;'}
         </span>`
      : '';
    return `<div class="msg ${own ? 'own' : ''}">${body}
      <div class="msg-meta">${fmtTime(m.time)} ${tick}</div>
    </div>`;
  }).join('');
  c.scrollTop = c.scrollHeight;
}

// ── UI HELPERS ─────────────────────────────────────
function switchTab(tab, el) {
  document.querySelectorAll('.tab').forEach(t  => t.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  el.classList.add('active');
  document.getElementById(tab + 'View').classList.add('active');

  if (tab === 'chats') {
    unread = {};
    localStorage.setItem('unread', JSON.stringify(unread));
    updateUnreadBadge();
  }
  if (tab === 'callLink') updateLinkView();
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
  document.getElementById('chatName').textContent      = getContactName(pin);
  document.getElementById('chatActions').style.display = 'flex';
  updateChatStatus();
  document.getElementById('chatScreen').classList.add('show');
  renderChatMessages();
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

// #13 — copyPin uses safe clipboard helper
function copyPin() { copyToClipboard(myPin, 'PIN copied!'); }

function installApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { deferredPrompt = null; });
  } else {
    toast('Use browser menu \u2192 Add to Home Screen');
  }
}

function autoResize(el) {
  el.style.height = '';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// #13 — safe clipboard with execCommand fallback
function copyToClipboard(text, successMsg) {
  const msg = successMsg || 'Copied!';
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text)
      .then(() => toast(msg))
      .catch(() => fallbackCopy(text, msg));
  } else {
    fallbackCopy(text, msg);
  }
}

function fallbackCopy(text, msg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try {
    document.execCommand('copy');
    toast(msg || 'Copied!');
  } catch {
    toast('Copy failed — select manually');
  }
  document.body.removeChild(ta);
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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el       = document.createElement('div');
  el.className   = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── EXPOSE TO HTML onclick HANDLERS ───────────────
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
  toggleGcSpeaker: () => toast('Speaker toggle — coming soon'),
  joinRoom,
});

const firebaseConfig = {
    apiKey: "AIzaSyBMYAZQTen1vqSMQKwvBLeeJem94oQL-5s",
    authDomain: "goldburn-server.firebaseapp.com",
    projectId: "goldburn-server",
    storageBucket: "goldburn-server.firebasestorage.app",
    messagingSenderId: "1063210985272",
    appId: "1:1063210985272:web:24ef04dec6a3eee8cd03cd"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

const RANKS = ["Copper", "Iron", "Silver", "Emerald", "GOLDEN", "BURNING", "GOOBIS"];

let playerState = { 
    uid: null, email: null, displayName: "Guest Player", photoURL: "GoldBurnLogo (1).png", accountGold: 0, isAdmin: false, rank: "Copper",
    unlockedCards: ['Bandits Arrival Starter'], customDecks: {}, activeDeckName: "Custom Deck", currentDeck: {}, currentVital: null,
    tempSessionId: "guest_" + Math.random().toString(36).substr(2, 9)
};

function getPlayerId() { return playerState.uid || playerState.tempSessionId; }

let currentRoomId = null;
let roomUnsubscribe = null;
let lastChatCount = 0; let lastLogCount = 0;

let gameState = {
    isHost: false, roomCode: null, phase: 'LOBBY', mode: 'quickplay', activeQueueMode: null,
    players: {}, turnOrder: [], activeTurnUid: null, spectatorVision: {},
    hand: [], deck: [], lastTarget: null, 
    lastKnownPing: null, localLastPingTime: null,
    targetMode: false, targetSource: null, moveMode: false, moveSource: null
};

let selectedHandIndex = null; let activeInsSlot = null;
let matchTimerInterval = null; let matchSeconds = 0; let hostPingInterval = null;

const STORE_ITEMS = [
    { key: "Bandits Arrival Starter", name: "Bandits Arrival Starter", cost: 0, desc: "Foundational Bandits Arrival starter deck." },
    { key: "Devout Patronage Starter", name: "Devout Patronage Starter", cost: 20, desc: "Complete Devout Patronage starter deck." }
];

// --- AUTH & SETUP ---
auth.onAuthStateChanged(async (user) => {
    loadLocalDeck();
    if (user) {
        playerState.uid = user.uid; playerState.email = user.email;
        playerState.displayName = user.displayName; 
        playerState.photoURL = user.photoURL || "GoldBurnLogo (1).png";
        
        document.getElementById('profile-name').textContent = playerState.displayName;
        document.getElementById('profile-img').src = playerState.photoURL;
        document.getElementById('auth-btn').textContent = "Sign Out";
        
        try {
            const userRef = db.collection('players').doc(user.uid);
            const doc = await userRef.get();
            if(!doc.exists) {
                const newProfile = { email: user.email, displayName: user.displayName, photoURL: playerState.photoURL, accountGold: 0, unlockedCards: ['Bandits Arrival Starter'], isAdmin: false, rank: "Copper" };
                await userRef.set(newProfile, { merge: true });
                playerState.accountGold = 0; playerState.unlockedCards = ['Bandits Arrival Starter']; playerState.isAdmin = false; playerState.rank = "Copper";
            } else {
                const data = doc.data();
                playerState.accountGold = data.accountGold !== undefined ? data.accountGold : 0;
                playerState.unlockedCards = data.unlockedCards || ['Bandits Arrival Starter'];
                playerState.isAdmin = data.isAdmin || false;
                playerState.rank = data.rank || "Copper";
            }
            if(playerState.isAdmin) document.getElementById('btn-admin').classList.remove('hidden');
            updateUI(); filterCollection(); renderStoreAndInventory();
        } catch (error) { console.error("Firestore Error: ", error); }
    } else {
        playerState.unlockedCards = ['Bandits Arrival Starter'];
        filterCollection(); renderStoreAndInventory(); renderDeckList();
    }
});

function toggleAuth() {
    if (currentRoomId && currentRoomId !== "SANDBOX") return alert("Cannot sign out in a match!");
    if (playerState.uid) auth.signOut().then(() => window.location.reload());
    else auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(err => alert("Login popup blocked."));
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    const target = document.getElementById(`tab-${tabId}`);
    if(target) target.classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('bg-amber-500', 'text-stone-950');
        btn.classList.add('bg-stone-800', 'text-stone-300');
    });
    
    const activeBtn = document.getElementById(`btn-${tabId}`);
    if(activeBtn) {
        activeBtn.classList.remove('bg-stone-800', 'text-stone-300');
        activeBtn.classList.add('bg-amber-500', 'text-stone-950');
    }

    if (tabId === 'deck') filterCollection();
    if (tabId === 'admin') loadAdminBrowser();
}

function hideAllViews() {
    document.getElementById('lobby-view').classList.add('hidden');
    document.getElementById('pre-lobby-view').classList.add('hidden');
    document.getElementById('vital-lobby-view').classList.add('hidden');
    document.getElementById('game-view').classList.add('hidden');
}

// --- ADMIN PANEL ---
let allPlayersCache = [];
async function loadAdminBrowser() {
    if(!playerState.isAdmin) return;
    const snap = await db.collection('players').get();
    allPlayersCache = [];
    snap.forEach(d => allPlayersCache.push({ id: d.id, ...d.data() }));
    filterAdminList();
}
function filterAdminList() {
    const q = document.getElementById('admin-search').value.toLowerCase();
    const list = document.getElementById('admin-player-list');
    list.innerHTML = '';
    allPlayersCache.filter(p => p.displayName?.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q)).forEach(p => {
        let cardsHtml = `<select id="rem-${p.id}" class="bg-stone-800 text-xs rounded p-1"><option value="">-- Remove Item --</option>`;
        (p.unlockedCards||[]).forEach(c => cardsHtml += `<option value="${c}">${c}</option>`);
        cardsHtml += `</select><button onclick="adminRemoveItem('${p.id}')" class="bg-red-800 hover:bg-red-700 px-2 rounded text-xs ml-1 transition">Del</button>`;
        
        let rankOptions = '';
        RANKS.forEach(r => rankOptions += `<option value="${r}" ${p.rank === r ? 'selected' : ''}>${r}</option>`);

        list.innerHTML += `<div class="bg-stone-900 border border-stone-700 p-3 rounded flex flex-col gap-2 shadow">
            <div class="flex justify-between items-center text-xs">
                <span class="font-bold text-amber-400">${p.displayName}</span> <span class="text-stone-500">${p.email}</span>
            </div>
            <div class="flex gap-2 text-xs items-center">
                <span class="text-stone-400 font-bold">Gold:</span>
                <input type="number" id="gold-${p.id}" value="${p.accountGold || 0}" class="w-16 bg-stone-950 border border-stone-800 p-1 rounded font-bold text-white">
                <span class="text-stone-400 font-bold ml-2">Rank:</span>
                <select id="rank-${p.id}" class="bg-stone-950 border border-stone-800 p-1 rounded font-bold text-amber-400">${rankOptions}</select>
                <button onclick="adminSavePlayer('${p.id}')" class="bg-stone-800 hover:bg-stone-700 px-3 py-1 rounded transition font-bold text-white shadow ml-auto">Save</button>
            </div>
            <div class="flex justify-end text-xs items-center mt-1 pt-2 border-t border-stone-800">
                ${cardsHtml}
            </div>
        </div>`;
    });
}
async function adminSavePlayer(uid) {
    const newGold = parseInt(document.getElementById(`gold-${uid}`).value) || 0;
    const newRank = document.getElementById(`rank-${uid}`).value;
    await db.collection('players').doc(uid).update({ accountGold: newGold, rank: newRank });
    alert("Player Profile Saved"); loadAdminBrowser();
}
async function adminRemoveItem(uid) {
    const val = document.getElementById(`rem-${uid}`).value;
    if(!val) return;
    await db.collection('players').doc(uid).update({ unlockedCards: firebase.firestore.FieldValue.arrayRemove(val) });
    alert("Item Removed"); loadAdminBrowser();
}

// --- MATCHMAKING & PRE-LOBBY ---
let activeQueueUnsub = null;
async function queueMatch(mode) {
    if(!playerState.uid) return alert("Guests can only play Custom matches!");
    if(mode !== 'starters' && !playerState.currentVital) return alert("Equip a Vital card in Deck Manager first!");
    
    const btn = document.getElementById(`btn-${mode}`);
    const origText = btn.textContent;

    if (gameState.activeQueueMode === mode) {
        if(activeQueueUnsub) activeQueueUnsub();
        gameState.activeQueueMode = null;
        btn.textContent = `Play ${mode.charAt(0).toUpperCase() + mode.slice(1)}`;
        btn.classList.replace('bg-red-700', 'bg-amber-600');
        return;
    }

    if (gameState.activeQueueMode) {
        if(activeQueueUnsub) activeQueueUnsub();
        const oldBtn = document.getElementById(`btn-${gameState.activeQueueMode}`);
        if(oldBtn) { oldBtn.textContent = `Play ${gameState.activeQueueMode.charAt(0).toUpperCase() + gameState.activeQueueMode.slice(1)}`; oldBtn.classList.replace('bg-red-700', 'bg-amber-600'); }
    }

    gameState.activeQueueMode = mode;
    btn.textContent = "Cancel Search";
    btn.classList.replace('bg-amber-600', 'bg-red-700');

    let joined = false;
    const myRankIndex = RANKS.indexOf(playerState.rank);
    
    const query = db.collection('rooms')
        .where('mode', '==', mode)
        .where('status', '==', 'WAITING');
    
    activeQueueUnsub = query.onSnapshot(snap => {
        if(!joined && !snap.empty) {
            let validRoom = null;
            snap.docs.forEach(doc => {
                const data = doc.data();
                if(data.hostRankIndex !== undefined) {
                    if (Math.abs(data.hostRankIndex - myRankIndex) <= 1) validRoom = doc;
                } else {
                    validRoom = doc; 
                }
            });

            if (validRoom) {
                joined = true; activeQueueUnsub(); gameState.activeQueueMode = null;
                btn.textContent = origText; btn.classList.replace('bg-red-700', 'bg-amber-600');
                joinMatch(mode, null, validRoom.id);
            }
        }
    });

    setTimeout(() => {
        if(!joined && gameState.activeQueueMode === mode) {
            joined = true; activeQueueUnsub(); gameState.activeQueueMode = null;
            btn.textContent = origText; btn.classList.replace('bg-red-700', 'bg-amber-600');
            hostMatch(mode);
        }
    }, 5000);
}

async function handleCustomMatch() {
    const code = document.getElementById('custom-room-code').value.trim();
    if (code) joinMatch('custom', code); else hostMatch('custom');
}

async function hostMatch(mode) {
    if(!playerState.uid && mode !== 'custom') return alert("Guests can only play Custom matches!");
    if(mode !== 'starters' && !playerState.currentVital) return alert("Equip a Vital card in Deck Manager first!");
    
    const roomCode = mode === 'custom' ? Math.floor(1000 + Math.random()*9000).toString() : null;
    const initialPlayer = { 
        name: playerState.displayName, photo: playerState.photoURL, spectator: false, 
        front: [null,null,null], back: [null,null,null], gy: [], void: [], center: [null,null,null], gold: 0, deckCount: 0 
    };

    const roomRef = await db.collection('rooms').add({
        hostUid: getPlayerId(), hostRankIndex: RANKS.indexOf(playerState.rank),
        mode: mode, roomCode: roomCode, 
        status: mode === 'custom' ? 'PRE_LOBBY' : 'WAITING',
        lockedVitals: 0, players: { [getPlayerId()]: initialPlayer }, turnOrder: [], activeTurnUid: null,
        rules: { starter: false, health: false, noZone: false, maxPlayers: 2 },
        chat: [], logs: [], lastTarget: null, lastPing: Date.now()
    });
    
    currentRoomId = roomRef.id; gameState.roomCode = roomCode; gameState.isHost = true; gameState.mode = mode;
    
    if(mode !== 'sandbox') {
        hostPingInterval = setInterval(() => {
            if(gameState.isHost && currentRoomId && currentRoomId !== "SANDBOX") {
                db.collection('rooms').doc(currentRoomId).update({ lastPing: Date.now() }).catch(()=>{});
            }
        }, 10000);
    }
    
    listenToRoom();
    if(mode === 'custom') showPreLobby(); else showVitalLobby(mode);
}

async function joinMatch(mode, code = null, directRoomId = null) {
    if(!playerState.uid && mode !== 'custom') return alert("Guests can only play Custom matches!");
    if(mode !== 'starters' && !playerState.currentVital) return alert("Equip a Vital card in Deck Manager first!");
    
    let roomDoc = null;
    if(directRoomId) {
        roomDoc = await db.collection('rooms').doc(directRoomId).get();
    } else {
        let query = db.collection('rooms').where('mode', '==', mode).where('status', 'in', ['WAITING', 'PRE_LOBBY']);
        if (mode === 'custom') {
            if(!code) return alert("Enter a room code!");
            query = query.where('roomCode', '==', code);
        }
        const snap = await query.limit(1).get();
        if (snap.empty) return alert("No rooms found!");
        roomDoc = snap.docs[0];
    }
    
    const data = roomDoc.data();
    currentRoomId = roomDoc.id; gameState.roomCode = data.roomCode; gameState.isHost = false; gameState.mode = mode;
    
    gameState.lastKnownPing = data.lastPing || null;
    gameState.localLastPingTime = Date.now();
    
    const newPlayer = { name: playerState.displayName, photo: playerState.photoURL, spectator: false, front: [null,null,null], back: [null,null,null], gy: [], void: [], center: [null,null,null], gold: 0, deckCount: 0 };
    
    const updates = { [`players.${getPlayerId()}`]: newPlayer };
    const pCount = Object.keys(data.players).length + 1;
    if (mode !== 'custom' && pCount >= 2) updates.status = 'PLAYING_VITAL'; 
    if (mode === 'custom' && pCount >= data.rules.maxPlayers) updates.status = 'LOCKED';
    
    await db.collection('rooms').doc(currentRoomId).update(updates);
    
    if(mode !== 'sandbox') {
        hostPingInterval = setInterval(() => {
            if (!gameState.isHost && currentRoomId && gameState.localLastPingTime) {
                if (Date.now() - gameState.localLastPingTime > 120000) {
                    alert("Host disconnected. Lobby tie."); executeLeaveMatch();
                }
            }
        }, 5000);
    }

    listenToRoom();
    if (mode === 'custom') showPreLobby(); else showVitalLobby(mode);
}

document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentRoomId && currentRoomId !== "SANDBOX") {
        if (gameState.isHost) db.collection('rooms').doc(currentRoomId).update({ lastPing: Date.now() }).catch(()=>{});
        else gameState.localLastPingTime = Date.now();
    }
});

function showPreLobby() {
    hideAllViews();
    document.getElementById('pre-lobby-view').classList.remove('hidden');
    document.getElementById('pre-lobby-code').textContent = gameState.roomCode;
    
    if (gameState.isHost) {
        ['host-set-starter', 'host-set-health', 'host-set-zone', 'host-set-players'].forEach(id => {
            const el = document.getElementById(id); el.disabled = false;
            el.onchange = () => db.collection('rooms').doc(currentRoomId).update({
                'rules.starter': document.getElementById('host-set-starter').checked,
                'rules.health': document.getElementById('host-set-health').checked,
                'rules.noZone': document.getElementById('host-set-zone').checked,
                'rules.maxPlayers': parseInt(document.getElementById('host-set-players').value)
            });
        });
        document.getElementById('btn-start-custom').classList.remove('hidden');
        document.getElementById('pre-lobby-wait').classList.add('hidden');
    }
}
function startCustomMatch() {
    db.collection('rooms').doc(currentRoomId).update({ status: 'PLAYING_VITAL' });
}

function showVitalLobby(mode) {
    hideAllViews();
    document.getElementById('vital-lobby-view').classList.remove('hidden');
    
    const vArea = document.getElementById('vital-selection-area');
    const sArea = document.getElementById('starter-deck-selection');
    vArea.classList.add('hidden'); sArea.classList.add('hidden');
    
    const btn = document.getElementById('btn-lock-in-vital');
    btn.textContent = "Lock In Vital"; btn.disabled = true;
    btn.classList.remove('bg-amber-600', 'text-stone-950'); btn.classList.add('bg-stone-800', 'text-stone-500');
    pendingVitalSlot = null;
    document.querySelectorAll('.vital-btn').forEach(b => {
        b.classList.remove('border-amber-400'); 
        b.innerHTML = b.id.includes('Front') ? 'F'+(parseInt(b.id.split('-')[2])+1) : 'B'+(parseInt(b.id.split('-')[2])+1);
    });
    
    let isStarter = mode === 'starters' || (gameState.rules && gameState.rules.starter);
    if (mode === 'sandbox') {
        document.getElementById('lobby-title').textContent = "SANDBOX"; vArea.classList.remove('hidden'); loadDeckIntoGameState();
    } else if (isStarter) {
        document.getElementById('lobby-status').textContent = "Choose your Starter Deck."; sArea.classList.remove('hidden');
    } else {
        document.getElementById('lobby-status').textContent = "Waiting for players..."; vArea.classList.remove('hidden'); loadDeckIntoGameState();
    }
}

let pendingVitalSlot = null;
function selectVitalSlot(region, idx) {
    pendingVitalSlot = {region, idx};
    const vCard = MASTER_CARDS.find(c => c.id === playerState.currentVital);
    document.querySelectorAll('.vital-btn').forEach(btn => {
        if (btn.id === `vs-${region}-${idx}`) {
            btn.classList.add('border-amber-400'); btn.innerHTML = `<img src="${vCard ? vCard.image : 'GoldBurnLogo (1).png'}" class="w-full h-full object-cover rounded opacity-80" onerror="this.src='GoldBurnLogo (1).png'">`;
        } else {
            btn.classList.remove('border-amber-400'); btn.innerHTML = btn.id.includes('Front') ? 'F'+(parseInt(btn.id.split('-')[2])+1) : 'B'+(parseInt(btn.id.split('-')[2])+1);
        }
    });
    checkVitalLockinStatus();
}

function checkVitalLockinStatus() {
    const btn = document.getElementById('btn-lock-in-vital');
    if (btn.disabled && btn.textContent === "Waiting for others...") return; 
    
    if (currentRoomId === "SANDBOX") {
        if(pendingVitalSlot) { btn.disabled = false; btn.classList.replace('bg-stone-800', 'bg-amber-600'); btn.classList.replace('text-stone-500', 'text-stone-950'); }
        return;
    }

    const isFull = Object.keys(gameState.players).length >= (gameState.mode === 'custom' ? 2 : 2); 
    if(isFull && pendingVitalSlot) {
        btn.disabled = false; btn.classList.replace('bg-stone-800', 'bg-amber-600'); btn.classList.replace('text-stone-500', 'text-stone-950');
    } else {
        btn.disabled = true; btn.classList.replace('bg-amber-600', 'bg-stone-800'); btn.classList.replace('text-stone-950', 'text-stone-500');
    }
}

function lockInVital() {
    const btn = document.getElementById('btn-lock-in-vital');
    btn.disabled = true; btn.textContent = "Waiting for others...";
    btn.classList.replace('bg-amber-600', 'bg-stone-800'); btn.classList.replace('text-stone-950', 'text-stone-500');
    
    const vIdx = gameState.deck.findIndex(c => c.type === 'Vital');
    if (vIdx !== -1) {
        const v = gameState.deck.splice(vIdx, 1)[0];
        if(gameState.rules && gameState.rules.health) { v.currentHp = Math.max(1, Math.floor(v.hp/2)); }
        
        const dbReg = pendingVitalSlot.region === 'front' ? 'front' : 'back';
        gameState.players[getPlayerId()][dbReg][pendingVitalSlot.idx] = v;
    }
    
    if (currentRoomId === "SANDBOX") { enterMatch(); } 
    else {
        broadcastState();
        db.collection('rooms').doc(currentRoomId).update({ lockedVitals: firebase.firestore.FieldValue.increment(1) });
    }
}

function confirmLobbyStarter() {
    const val = document.getElementById('lobby-starter-select').value;
    if(!val) return alert("Select a deck.");
    let tV = null; let tD = {};
    for(const [id, count] of Object.entries(STARTER_DECKS[val])) {
        const c = MASTER_CARDS.find(x=>x.id===id); if(c && c.type==='Vital') tV=id; else tD[id]=count;
    }
    playerState.currentVital = tV; loadDeckIntoGameState(tD, tV);
    document.getElementById('starter-deck-selection').classList.add('hidden');
    document.getElementById('vital-selection-area').classList.remove('hidden');
}

function loadDeckIntoGameState(deckToLoad = playerState.currentDeck, vitalToLoad = playerState.currentVital) {
    gameState.deck = [];
    for (const [id, count] of Object.entries(deckToLoad)) {
        const c = MASTER_CARDS.find(x=>x.id===id);
        if(c) for(let i=0;i<count;i++) gameState.deck.push({...c, instanceId: Math.random().toString(36).substr(2,9), currentHp: c.hp, markers: {}, exhausted: false});
    }
    const vCard = MASTER_CARDS.find(c => c.id === vitalToLoad);
    if(vCard) gameState.deck.push({...vCard, instanceId: Math.random().toString(36).substr(2,9), currentHp: vCard.hp, markers: {}, exhausted: false});
    if(!gameState.players[getPlayerId()]) gameState.players[getPlayerId()] = {front:[null,null,null], back:[null,null,null], center:[null,null,null], gy:[], void:[], gold:0, handCache:[], deckCache:[]};
}

function enterMatch() {
    hideAllViews();
    document.getElementById('game-view').classList.remove('hidden');
    
    gameState.phase = 'PLAYING';
    gameState.deck.sort(() => Math.random() - 0.5);
    gameState.hand = gameState.deck.splice(0, 5); 
    
    if(currentRoomId === "SANDBOX") {
        gameState.turnOrder = [getPlayerId()]; gameState.activeTurnUid = getPlayerId();
        gameState.players[getPlayerId()].gold = 3;
    } else {
        if(gameState.activeTurnUid === getPlayerId()) {
            gameState.players[getPlayerId()].gold = 3;
        } else {
            gameState.players[getPlayerId()].gold = 0;
        }
    }
    
    logAction("Match started. Drew 5 cards.");
    startMatchTimer(); renderVTT(); broadcastState();
}

// --- SYNC & LISTENER ---
function listenToRoom() {
    if(roomUnsubscribe) roomUnsubscribe();
    roomUnsubscribe = db.collection('rooms').doc(currentRoomId).onSnapshot(doc => {
        if(!doc.exists) return executeLeaveMatch();
        const data = doc.data();
        gameState.players = data.players || {};
        gameState.rules = data.rules || {};
        gameState.turnOrder = data.turnOrder || [];
        gameState.activeTurnUid = data.activeTurnUid;
        
        if (data.lastPing && data.lastPing !== gameState.lastKnownPing) {
            gameState.lastKnownPing = data.lastPing;
            gameState.localLastPingTime = Date.now();
        }

        if(data.status === 'CLOSED') { alert("Room closed."); executeLeaveMatch(); return; }

        if(gameState.phase === 'LOBBY' && data.status === 'PRE_LOBBY') {
            const pDiv = document.getElementById('pre-lobby-players'); pDiv.innerHTML = '';
            Object.values(data.players).forEach(p => pDiv.innerHTML += `<div>${p.name} connected</div>`);
            if(!gameState.isHost && data.rules) {
                document.getElementById('host-set-starter').checked = data.rules.starter;
                document.getElementById('host-set-health').checked = data.rules.health;
                document.getElementById('host-set-zone').checked = data.rules.noZone;
            }
        }
        
        if (gameState.phase === 'LOBBY' && data.status === 'PLAYING_VITAL') {
            showVitalLobby(data.mode); gameState.phase = 'VITAL';
        }
        
        if (gameState.phase === 'VITAL') {
            const ls = document.getElementById('lobby-status');
            if (Object.keys(data.players).length >= 2) {
                ls.textContent = "Player found! Select & lock in your vital.";
                ls.classList.replace('text-stone-400', 'text-amber-400');
                checkVitalLockinStatus();
            } else {
                ls.textContent = "Waiting for players...";
                ls.classList.replace('text-amber-400', 'text-stone-400');
                checkVitalLockinStatus();
            }
        }

        if (gameState.phase === 'VITAL' && data.lockedVitals >= Object.keys(data.players).length) {
            if (gameState.isHost && data.turnOrder.length === 0) {
                let tOrder = Object.keys(data.players);
                tOrder.sort(() => Math.random() - 0.5);
                const updates = { turnOrder: tOrder, activeTurnUid: tOrder[0], status: 'PLAYING' };
                db.collection('rooms').doc(currentRoomId).update(updates);
            }
        }
        
        if (data.status === 'PLAYING' && gameState.phase === 'VITAL') { enterMatch(); }

        if (gameState.phase === 'PLAYING') {
            if(data.lastTarget && (!gameState.lastTarget || data.lastTarget.id !== gameState.lastTarget.id)) {
                gameState.lastTarget = data.lastTarget;
                drawTargetLine(data.lastTarget);
            }
            renderVTT();
        }
        
        if(data.chat && data.chat.length > lastChatCount) {
            const newChats = data.chat.slice(lastChatCount);
            const cb = document.getElementById('chat-log');
            newChats.forEach(c => {
                cb.innerHTML += `<div><span class="${c.uid===getPlayerId()?'text-green-500':'text-amber-500'} font-bold">${c.name}:</span> ${c.msg}</div>`;
            });
            cb.scrollTop = cb.scrollHeight; lastChatCount = data.chat.length;
        }
        
        if(data.logs && data.logs.length > lastLogCount) {
            const newLogs = data.logs.slice(lastLogCount);
            const lb = document.getElementById('action-log');
            newLogs.forEach(l => { if (l.uid !== getPlayerId()) lb.innerHTML += `<div><span class="text-amber-500">></span> ${l.name}: ${l.msg}</div>`; });
            lb.scrollTop = lb.scrollHeight; lastLogCount = data.logs.length;
        }

        if(data.status === 'FINISHED' && gameState.phase === 'PLAYING') {
            if(data.winnerUid === getPlayerId() && playerState.uid && (data.mode==='quickplay'||data.mode==='starters')) {
                alert("WINNER! You earned 3 Gold.");
                playerState.accountGold += 3;
                db.collection('players').doc(playerState.uid).update({ accountGold: playerState.accountGold });
                updateUI();
            } else if (data.winnerUid === getPlayerId()) alert("WINNER!");
            else alert("DEFEATED! Winner was decided.");
            executeLeaveMatch();
        }
    });
}

function broadcastState() {
    if (currentRoomId === "SANDBOX" || !currentRoomId || !gameState.players[getPlayerId()]) return;
    gameState.players[getPlayerId()].deckCount = gameState.deck.length;
    gameState.players[getPlayerId()].handCache = gameState.hand; 
    gameState.players[getPlayerId()].deckCache = gameState.deck; 
    const pData = JSON.parse(JSON.stringify(gameState.players[getPlayerId()]));
    db.collection('rooms').doc(currentRoomId).update({ [`players.${getPlayerId()}`]: pData }).catch(e=>console.error(e));
}

function startMatchTimer() {
    clearInterval(matchTimerInterval); matchSeconds = 0;
    matchTimerInterval = setInterval(() => {
        matchSeconds++;
        const m = String(Math.floor(matchSeconds / 60)).padStart(2, '0');
        const s = String(matchSeconds % 60).padStart(2, '0');
        document.getElementById('match-timer').textContent = `${m}:${s}`;
    }, 1000);
}

function cancelModes(e) {
    if(!gameState.targetMode && !gameState.moveMode) return;
    const ign = ['ins-board-actions', 'btn-play', 'btn-end-turn', 'card-inspector'];
    if(e && ign.some(id => e.target.closest(`#${id}`))) return;
    if(gameState.targetMode) { gameState.targetMode = false; logAction("Targeting cancelled."); renderVTT(); }
    if(gameState.moveMode) { gameState.moveMode = false; logAction("Move cancelled."); renderVTT(); }
}
document.addEventListener('keydown', (e) => { if(e.key === 'Escape') cancelModes(null); });

// --- RENDERING ---
function renderVTT() {
    const myUid = getPlayerId();
    const myP = gameState.players[myUid];
    if(!myP) return;

    const isMyTurn = gameState.activeTurnUid === myUid || currentRoomId === "SANDBOX";
    const endTurnBtn = document.getElementById('btn-end-turn');
    if(endTurnBtn) {
        if(isMyTurn) { 
            endTurnBtn.classList.replace('bg-stone-800', 'bg-amber-600'); 
            endTurnBtn.classList.replace('text-stone-500', 'text-stone-950'); 
            endTurnBtn.disabled = false; 
        } else { 
            endTurnBtn.classList.replace('bg-amber-600', 'bg-stone-800'); 
            endTurnBtn.classList.replace('text-stone-950', 'text-stone-500'); 
            endTurnBtn.disabled = true; 
        }
    }

    const handEl = document.getElementById('player-hand-container'); handEl.innerHTML = '';

    if(myP.spectator) {
        document.getElementById('player-active-board').classList.add('hidden');
        document.getElementById('spectator-ui').classList.remove('hidden');
        
        const concedeBtn = document.getElementById('btn-concede');
        if(concedeBtn) {
            concedeBtn.textContent = "Leave Match";
            concedeBtn.onclick = () => {
                alert("You Lost!");
                window.location.reload();
            };
        }

        renderSpectatorCheckboxes();

        Object.entries(gameState.players).forEach(([uid, p]) => {
            if(gameState.spectatorVision[uid] && p.handCache && p.handCache.length > 0) {
                p.handCache.forEach(card => {
                    const div = document.createElement('div');
                    div.className = `w-[110px] h-[155px] flex-shrink-0 rounded-md overflow-hidden border-2 border-amber-500/50 shadow-lg relative`;
                    div.innerHTML = `<img src="${card.image}" class="card-img-full bg-stone-900 p-1" onerror="this.src='GoldBurnLogo (1).png'"><div class="absolute bottom-0 w-full bg-black/80 text-[9px] text-amber-400 font-bold text-center truncate px-1">${p.name}</div>`;
                    handEl.appendChild(div);
                });
            }
        });
        return;
    } else {
        document.getElementById('player-active-board').classList.remove('hidden');
        document.getElementById('spectator-ui').classList.add('hidden');
        
        const concedeBtn = document.getElementById('btn-concede');
        if(concedeBtn) {
            concedeBtn.textContent = "Concede";
            concedeBtn.onclick = leaveMatch;
        }

        gameState.hand.forEach((card, idx) => {
            const div = document.createElement('div');
            div.className = `w-[110px] h-[155px] flex-shrink-0 cursor-pointer rounded-md overflow-hidden border-2 transition ${selectedHandIndex === idx ? 'border-amber-400 scale-105 z-20' : 'border-stone-800'}`;
            div.innerHTML = `<img src="${card.image}" class="card-img-full bg-stone-900 p-1" onerror="this.src='GoldBurnLogo (1).png'">`;
            div.onclick = (e) => {
                e.stopPropagation();
                
                let canPlay = isMyTurn;
                if (card.type === 'Act' && card.subtypes && card.subtypes.includes('Fast')) canPlay = true;
                if (!canPlay) return;

                selectedHandIndex = selectedHandIndex === idx ? null : idx;
                activeInsSlot = null; gameState.moveMode = false; gameState.targetMode = false;
                if(selectedHandIndex !== null) inspectCard(card, 'hand', idx); else inspectEmpty();
                renderVTT();
            };
            handEl.appendChild(div);
        });
    }

    document.getElementById('deck-count-hud').textContent = gameState.deck.length;
    document.getElementById('match-gold-val').textContent = myP.gold || 0;
    
    const toPanel = document.getElementById('turn-order-list');
    toPanel.innerHTML = '';
    gameState.turnOrder.forEach(uid => {
        const p = gameState.players[uid];
        if(!p || p.spectator) return;
        const isAct = uid === gameState.activeTurnUid;
        toPanel.innerHTML += `<div class="flex items-center gap-2 p-1 rounded transition ${isAct?'turn-active border border-amber-500':'border border-stone-800 opacity-70'}"><img src="${p.photo}" class="w-6 h-6 rounded-full"><span class="text-xs font-bold ${isAct?'text-amber-400':'text-stone-400'} truncate w-full">${p.name}</span></div>`;
    });

    const opps = Object.keys(gameState.players).filter(u => u !== myUid && !gameState.players[u].spectator).sort();
    const multiContainer = document.getElementById('opponents-container');
    const soloContainer = document.getElementById('opp-1v1-board');

    if (opps.length === 1) {
        multiContainer.classList.add('hidden');
        soloContainer.classList.remove('hidden');
        const oppUid = opps[0];
        const p = gameState.players[oppUid];
        
        soloContainer.innerHTML = `
            <div class="flex items-center gap-2 mb-2 absolute top-0 left-4"><img src="${p.photo}" class="w-8 h-8 rounded-full border border-amber-500"><span class="text-amber-400 font-bold">${p.name}</span></div>
            <div class="flex flex-col gap-2 w-24">
                <div class="bg-stone-900 border border-stone-800 p-2 rounded text-center shadow">
                    <span class="text-amber-400 font-bold text-xs">Gold</span><br>
                    <span class="text-stone-100 text-lg">${p.gold}</span>
                </div>
                <div class="board-slot bg-[#050505] border border-purple-900/50 rounded flex flex-col items-center justify-center text-[10px] text-purple-800 font-bold cursor-pointer hover:border-purple-500 transition shadow-inner p-1 relative overflow-hidden text-center" onclick="openPeerModal('${oppUid}', 'void')"><span class="z-10 bg-[#050505]/80 px-1 py-1 rounded text-purple-400 w-full font-bold">VOID<br>[${p.void ? p.void.length : 0}]</span></div>
                <div class="board-slot bg-stone-950 border border-stone-700 rounded flex flex-col items-center justify-center text-[10px] text-stone-500 font-bold cursor-pointer hover:border-stone-400 transition shadow-inner p-1 relative overflow-hidden text-center" onclick="openPeerModal('${oppUid}', 'gy')"><span class="z-10 bg-stone-950/80 px-1 py-1 rounded text-stone-400 w-full font-bold">GRAVE YARD<br>[${p.gy ? p.gy.length : 0}]</span></div>
            </div>
            
            <div class="flex flex-col gap-2">
                <div class="flex gap-2" id="opp-back-row">
                    ${[0,1,2].map(i => renderSlotHtml(p.back[i], oppUid, 'back', i, true)).join('')}
                </div>
                <div class="flex gap-2" id="opp-front-row">
                    ${[0,1,2].map(i => renderSlotHtml(p.front[i], oppUid, 'front', i, true)).join('')}
                </div>
            </div>

            <div class="flex flex-col gap-2 w-24">
                <div class="board-slot bg-stone-950 border border-stone-700 rounded flex items-center justify-center text-xs text-amber-500 font-bold cursor-pointer hover:border-amber-400 transition bg-[url('GoldBurnLogo (1).png')] bg-cover bg-center bg-blend-overlay bg-black/80" onclick="openPeerModal('${oppUid}', 'deck')">DECK [${p.deckCount}]</div>
            </div>
        `;
    } else {
        soloContainer.classList.add('hidden');
        multiContainer.classList.remove('hidden');
        multiContainer.innerHTML = '';
        opps.forEach(uid => {
            const p = gameState.players[uid];

            const oppHtml = `
                <div class="flex flex-col gap-2 relative bg-stone-900/50 p-2 rounded-xl border border-stone-800" id="board-${uid}">
                    <div class="flex items-center gap-2 mb-1"><img src="${p.photo}" class="w-6 h-6 rounded-full"><span class="text-amber-400 text-xs font-bold">${p.name}</span> <span class="ml-auto text-xs text-stone-400">Cards: ${p.deckCount} | Gold: <span class="text-amber-500">${p.gold}</span></span></div>
                    <div class="flex gap-4">
                        <div class="flex flex-col gap-2">
                            <div class="flex gap-2">
                                ${[0,1,2].map(i => renderSlotHtml(p.back[i], uid, 'back', i, true)).join('')}
                            </div>
                            <div class="flex gap-2">
                                ${[0,1,2].map(i => renderSlotHtml(p.front[i], uid, 'front', i, true)).join('')}
                            </div>
                        </div>
                        <div class="flex flex-col gap-2 justify-center">
                            <div class="w-12 h-16 bg-[#050505] border border-purple-900/50 rounded flex flex-col items-center justify-center text-[8px] text-purple-700 cursor-pointer hover:border-purple-500 text-center leading-none" onclick="openPeerModal('${uid}', 'void')"><span class="font-bold">V</span><br>[${p.void?p.void.length:0}]</div>
                            <div class="w-12 h-16 bg-stone-950 border border-stone-800 rounded flex flex-col items-center justify-center text-[8px] text-stone-500 cursor-pointer hover:border-stone-500 text-center leading-none" onclick="openPeerModal('${uid}', 'gy')"><span class="font-bold">GY</span><br>[${p.gy?p.gy.length:0}]</div>
                            <div class="w-12 h-16 bg-stone-950 border border-amber-800/50 rounded flex flex-col items-center justify-center text-[8px] text-amber-500 cursor-pointer hover:border-amber-500 text-center leading-none" onclick="openPeerModal('${uid}', 'deck')"><span class="font-bold">DECK</span><br>[${p.deckCount}]</div>
                        </div>
                    </div>
                </div>`;
            multiContainer.innerHTML += oppHtml;
        });
    }

    const centerContainer = document.getElementById('center-container');
    if (centerContainer && !myP.spectator) {
        let centerHtml = '';
        opps.forEach((oppUid) => {
            const oppCard = gameState.players[oppUid].center[2];
            centerHtml += renderSlotHtml(oppCard, oppUid, 'center', 2, true, true, `oppAct-${oppUid}`, 'OPP ACT');
        });
        
        if (!(gameState.rules && gameState.rules.noZone)) {
            let sharedZoneCard = null;
            let sharedZoneUid = myUid;
            for (const uid of Object.keys(gameState.players)) {
                if (gameState.players[uid].center && gameState.players[uid].center[1]) {
                    sharedZoneCard = gameState.players[uid].center[1];
                    sharedZoneUid = uid;
                    break;
                }
            }
            centerHtml += renderSlotHtml(sharedZoneCard, sharedZoneUid, 'center', 1, sharedZoneUid !== myUid, true, 'center', 'SHARED ZONE');
        }
        
        centerHtml += renderSlotHtml(myP.center[2], myUid, 'center', 2, false, true, 'center', 'YOUR ACT');
        centerContainer.innerHTML = centerHtml;
    }

    ['front', 'back'].forEach(region => {
        const max = 3;
        for(let idx=0; idx<max; idx++) {
            const el = document.getElementById(`player${region==='front'?'Front':'Back'}-${idx}`);
            if(!el) continue;
            const card = myP[region][idx];
            el.outerHTML = renderSlotHtml(card, myUid, region, idx, false, false, '');
        }
    });

    ['gy','void'].forEach(z => {
        const el = document.getElementById(`${z}-visual`); if(!el) return;
        const arr = myP[z] || [];
        const label = z === 'gy' ? 'GRAVE YARD' : 'VOID';
        el.innerHTML = arr.length > 0 ? `<img src="${arr[arr.length-1].image}" class="absolute inset-0 w-full h-full object-cover opacity-60" onerror="this.src='GoldBurnLogo (1).png'"><span class="z-10 bg-black/80 px-2 rounded font-bold text-center">${label}<br>[${arr.length}]</span>` : `<span class="z-10 bg-black/80 px-2 rounded font-bold text-center">${label}<br>[0]</span>`;
    });
}

function renderSlotHtml(card, uid, region, idx, isOpp, isCenter=false, htmlIdPrefix='', customLabel=null) {
    const sId = isCenter ? (isOpp ? `oppAct-${uid}-2` : `${htmlIdPrefix}-${idx}`) : (isOpp ? `${uid}-${region}-${idx}` : `player${region==='front'?'Front':'Back'}-${idx}`);
    if (card) {
        let mh = ''; for(let [c, a] of Object.entries(card.markers||{})) { if(a>0) mh += `<div class="marker-dot bg-${c==='black'?'stone-800':c+'-500'}">${a}</div>`; }
        const dbRegion = isCenter ? 'center' : region;
        const sel = activeInsSlot && activeInsSlot.region === dbRegion && activeInsSlot.index === idx && activeInsSlot.uid === uid;
        return `<div id="${sId}" onclick="event.stopPropagation(); inspectFromBoard('${uid}','${dbRegion}',${idx},${isOpp})" class="board-slot bg-stone-900 border-2 ${sel?'border-amber-400 scale-[1.02] shadow-xl z-10':(isOpp?'border-red-900/50':'border-amber-600/50')} rounded overflow-hidden cursor-pointer">
            <img src="${card.image}" class="card-img-full bg-black ${card.exhausted?'opacity-50':''}" onerror="this.src='GoldBurnLogo (1).png'">
            ${card.exhausted ? `<div class="zzz-overlay bg-black/80 px-1 rounded text-[10px]">USED</div>` : ''}
            ${card.currentHp!==undefined ? `<div class="hp-badge">${card.currentHp}</div>` : ''}
            <div class="marker-container">${mh}</div>
        </div>`;
    } else {
        const mt = gameState.moveMode && !isOpp && (!isCenter || idx!==0);
        let txt = customLabel || 'EMPTY';
        const dbRegion = isCenter ? 'center' : region;
        const clickEvent = !isOpp ? `onclick="event.stopPropagation(); handleEmptySlotClick('${dbRegion}', ${idx})"` : '';
        return `<div id="${sId}" ${clickEvent} class="board-slot bg-stone-800/20 border-2 border-stone-700 rounded flex items-center justify-center text-[10px] text-stone-500 font-bold text-center px-1 ${mt?'move-target cursor-pointer':''}">
            ${txt}
        </div>`;
    }
}

function renderSpectatorCheckboxes() {
    const cont = document.getElementById('spectator-checkboxes'); cont.innerHTML = '';
    Object.entries(gameState.players).forEach(([uid, p]) => {
        if(!p.spectator && uid !== getPlayerId()) {
            const chk = gameState.spectatorVision[uid] ? 'checked' : '';
            cont.innerHTML += `<label class="flex items-center gap-1 cursor-pointer"><input type="checkbox" onchange="toggleSpecVision('${uid}', this.checked)" ${chk} class="rounded bg-stone-900 border-stone-700"> <span>${p.name}</span></label>`;
        }
    });
}
function toggleSpecVision(uid, checked) { gameState.spectatorVision[uid] = checked; renderVTT(); }

function inspectFromBoard(uid, dbRegion, idx, isOpp) {
    const card = gameState.players[uid][dbRegion][idx];
    if(!card) return;

    if (gameState.targetMode) {
        return finishTargeting(uid, dbRegion, idx);
    }
    if (gameState.moveMode) return;
    
    selectedHandIndex = null;
    activeInsSlot = { uid, region: dbRegion, index: idx };
    inspectCard(card, dbRegion, idx, isOpp);
    renderVTT();
}

function handleEmptySlotClick(region, index) {
    if (gameState.moveMode) return finishMoving(region, index);
    if (gameState.targetMode) return finishTargeting(getPlayerId(), region, index);

    if (selectedHandIndex !== null) {
        const card = gameState.hand[selectedHandIndex];
        const myP = gameState.players[getPlayerId()];
        
        if (card.type === 'Act' && (region !== 'center' || index !== 2)) return alert("Act cards can only go in YOUR ACT slot.");
        if (card.type === 'Zone' && (region !== 'center' || index !== 1)) return alert("Zone cards can only go in SHARED ZONE.");
        if (card.type !== 'Act' && region === 'center' && index === 2) return alert("Only Act cards can go in YOUR ACT.");
        if (card.type !== 'Zone' && region === 'center' && index === 1) return alert("Only Zone cards can go in SHARED.");

        if (myP.gold < (card.cost||0)) return alert("Not enough gold!");
        myP.gold -= (card.cost||0);

        gameState.hand.splice(selectedHandIndex, 1);
        myP[region][index] = card;
        
        selectedHandIndex = null; activeInsSlot = null;
        logAction(`Deployed ${card.name}.`);
        renderVTT(); inspectEmpty(); broadcastState();
    } else {
        activeInsSlot = { uid: getPlayerId(), region, index }; 
        showEmptyInspector(); renderVTT();
    }
}

function finishMoving(region, index) {
    const myP = gameState.players[getPlayerId()];
    const sReg = gameState.moveSource.region; const sIdx = gameState.moveSource.index;
    const card = myP[sReg][sIdx];
    
    if (card.type === 'Act' && (region !== 'center' || index !== 2)) return alert("Act cards can only go in YOUR ACT slot.");
    if (card.type === 'Zone' && (region !== 'center' || index !== 1)) return alert("Zone cards can only go in SHARED ZONE.");
    if (card.type !== 'Act' && region === 'center' && index === 2) return alert("Only Act cards can go in YOUR ACT.");
    if (card.type !== 'Zone' && region === 'center' && index === 1) return alert("Only Zone cards can go in SHARED.");

    myP[sReg][sIdx] = null; myP[region][index] = card;
    gameState.moveMode = false; gameState.moveSource = null; activeInsSlot = null;
    logAction(`Moved ${card.name}.`); renderVTT(); inspectEmpty(); broadcastState();
}

function inspectCard(card, region, idx, isOpp=false) {
    if(!card) return;
    document.getElementById('ins-img').src = card.image || 'GoldBurnLogo (1).png';
    document.getElementById('ins-name').textContent = card.name;
    document.getElementById('ins-stats').textContent = `${card.type} | ${card.subtypes ? card.subtypes.join(', ') : ''}`;
    document.getElementById('ins-desc').textContent = `Cost: ${card.cost||0} | HP: ${card.hp||'-'}\n\n${card.description}`;
    
    ['ins-empty-actions','ins-hand-actions','ins-board-actions','ins-zone-actions'].forEach(id => document.getElementById(id).classList.add('hidden'));

    if(isOpp) return;
    if (region === 'hand') document.getElementById('ins-hand-actions').classList.remove('hidden');
    else if (region === 'gy' || region === 'void') {
        document.getElementById('ins-zone-actions').classList.remove('hidden');
        document.getElementById('btn-zone-hand').onclick = () => moveZoneCard(region, 'hand', idx);
        document.getElementById('btn-zone-deck').onclick = () => moveZoneCard(region, 'deck', idx);
        const oB = document.getElementById('btn-zone-opposite');
        if(region==='gy'){ oB.textContent="To Void"; oB.onclick=()=>moveZoneCard('gy','void',idx); } else { oB.textContent="To GY"; oB.onclick=()=>moveZoneCard('void','gy',idx); }
    } else if (region) {
        document.getElementById('ins-board-actions').classList.remove('hidden');
        document.getElementById('ins-hp-val').textContent = card.currentHp || 0;
        ['red','blue','green','black'].forEach(c => document.getElementById(`ins-m-${c}`).textContent = card.markers[c]||0);
    }
}
function inspectEmpty() {
    document.getElementById('ins-img').src = 'GoldBurnLogo (1).png'; document.getElementById('ins-name').textContent = "Select a Card"; document.getElementById('ins-desc').textContent = "";
    ['ins-board-actions','ins-hand-actions','ins-zone-actions','ins-empty-actions'].forEach(id => document.getElementById(id).classList.add('hidden'));
}
function showEmptyInspector() { inspectEmpty(); document.getElementById('ins-name').textContent = "Empty Slot"; document.getElementById('ins-empty-actions').classList.remove('hidden'); }

function enlargeImage() {
    const src = document.getElementById('ins-img').src;
    if (src && !src.includes('GoldBurnLogo')) {
        document.getElementById('enlarged-img').src = src;
        document.getElementById('enlarge-modal').classList.remove('hidden');
    }
}

// --- ACTIONS ---
function drawCard() {
    if(gameState.deck.length===0) return;
    gameState.hand.push(gameState.deck.shift()); logAction("Drew card."); renderVTT(); broadcastState();
}
function editMatchGold(dir) {
    const p = gameState.players[getPlayerId()]; p.gold = Math.max(0, p.gold+dir); logAction(`Gold ${p.gold}`); renderVTT(); broadcastState();
}

function processPlayerElimination() {
    const myUid = getPlayerId();
    gameState.players[myUid].spectator = true;
    gameState.players[myUid].front = [null,null,null]; gameState.players[myUid].back = [null,null,null]; gameState.players[myUid].center = [null,null,null];
    gameState.players[myUid].gy = []; gameState.players[myUid].void = []; gameState.players[myUid].gold = 0; gameState.players[myUid].handCache = [];
    gameState.hand = [];
    
    gameState.turnOrder = gameState.turnOrder.filter(u => u !== myUid);
    if(gameState.activeTurnUid === myUid) gameState.activeTurnUid = gameState.turnOrder[0] || null;
    
    if(gameState.turnOrder.length <= 1 && currentRoomId !== "SANDBOX") {
        db.collection('rooms').doc(currentRoomId).update({ status: 'FINISHED', winnerUid: gameState.turnOrder[0] });
    } else if (currentRoomId !== "SANDBOX") {
        db.collection('rooms').doc(currentRoomId).update({ turnOrder: gameState.turnOrder, activeTurnUid: gameState.activeTurnUid });
        broadcastState();
    }
    renderVTT();
}

function editCardHP(dir) {
    if(!activeInsSlot || activeInsSlot.uid !== getPlayerId()) return alert("Can't modify opponent's card HP.");
    const card = gameState.players[getPlayerId()][activeInsSlot.region][activeInsSlot.index];
    card.currentHp += dir; document.getElementById('ins-hp-val').textContent = card.currentHp;
    logAction(`HP to ${card.currentHp}`);
    
    if(card.type === 'Vital' && card.currentHp <= 0) {
        alert("Your vital reached 0 HP. You are now spectating.");
        processPlayerElimination();
    } else {
        renderVTT(); broadcastState();
    }
}
function editMarker(c, d) {
    if(!activeInsSlot || activeInsSlot.uid !== getPlayerId()) return alert("Can't modify opponent's markers.");
    const card = gameState.players[getPlayerId()][activeInsSlot.region][activeInsSlot.index];
    card.markers[c] = Math.max(0, (card.markers[c]||0)+d);
    document.getElementById(`ins-m-${c}`).textContent = card.markers[c]; renderVTT(); broadcastState();
}
function discardHandCard() { const c = gameState.hand.splice(selectedHandIndex,1)[0]; gameState.players[getPlayerId()].gy.push(c); selectedHandIndex=null; renderVTT(); inspectEmpty(); broadcastState(); }

function sendToZone(z) {
    if(!activeInsSlot || activeInsSlot.uid !== getPlayerId()) return alert("Can't move opponent's card.");
    const card = gameState.players[getPlayerId()][activeInsSlot.region][activeInsSlot.index];
    gameState.players[getPlayerId()][activeInsSlot.region][activeInsSlot.index] = null;
    gameState.players[getPlayerId()][z].push(card); activeInsSlot=null; inspectEmpty(); renderVTT(); broadcastState();
}

function moveZoneCard(f,t,i) {
    if(!activeInsSlot || activeInsSlot.uid !== getPlayerId()) return alert("Can't move opponent's card.");
    const p = gameState.players[getPlayerId()]; const c = p[f].splice(i,1)[0];
    if(t==='hand') gameState.hand.push(c); else if(t==='deck') { gameState.deck.push(c); gameState.deck.sort(()=>Math.random()-0.5); } else p[t].push(c);
    activeInsSlot=null; inspectEmpty(); renderVTT(); broadcastState();
}

function createToken() {
    const n = prompt("Name:"); if(!n) return;
    const t = { name: n, type: 'Token', hp: 1, currentHp: 1, markers: {}, image: 'GoldBurnLogo (1).png', description: 'Token', exhausted: false };
    gameState.players[getPlayerId()][activeInsSlot.region][activeInsSlot.index] = t; activeInsSlot=null; inspectEmpty(); renderVTT(); broadcastState();
}

// Targeting Sync
function startTargeting(e) { 
    if(e) e.stopPropagation();
    if(activeInsSlot.region === 'hand') return alert("Play to the board first to target.");
    gameState.targetMode = true; gameState.targetSource = activeInsSlot; logAction("Select target..."); 
}
function startMoving(e) {
    if(e) e.stopPropagation();
    if(activeInsSlot.uid !== getPlayerId()) return alert("Can't move opponent's card.");
    gameState.moveMode = true; gameState.moveSource = activeInsSlot; logAction("Select empty slot...");
}
function finishTargeting(tUid, tRegion, tIndex) {
    gameState.targetMode = false;
    const s = gameState.targetSource;
    const sCard = gameState.players[s.uid][s.region][s.index];
    if(sCard) sCard.exhausted = true;
    
    const payload = { id: Date.now(), s: {uid: s.uid, reg: s.region, idx: s.index}, t: {uid: tUid, reg: tRegion, idx: tIndex} };
    
    if(currentRoomId !== "SANDBOX") {
        db.collection('rooms').doc(currentRoomId).update({ lastTarget: payload });
    } else { drawTargetLine(payload); }
    renderVTT(); broadcastState();
}
function drawTargetLine(data) {
    const resolveDomId = (targetData) => {
        const {uid, reg, idx} = targetData;
        if (reg === 'center') {
            if (uid === getPlayerId()) {
                if (idx === 1) return `center-1`;
                if (idx === 2) return `center-2`;
                return `center-2`;
            } else {
                if (idx === 1) return `center-1`;
                return `oppAct-${uid}-2`;
            }
        } else {
            if (uid === getPlayerId()) return `player${reg==='front'?'Front':'Back'}-${idx}`;
            return `${uid}-${reg}-${idx}`;
        }
    };

    const sEl = document.getElementById(resolveDomId(data.s)); 
    const tEl = document.getElementById(resolveDomId(data.t));
    if(sEl && tEl) {
        const svg = document.getElementById('targeting-line-container'); const line = document.getElementById('targeting-line');
        const cont = document.getElementById('game-view').getBoundingClientRect();
        const sr = sEl.getBoundingClientRect(); const tr = tEl.getBoundingClientRect();
        svg.classList.remove('hidden');
        line.setAttribute('x1', (sr.left - cont.left) + sr.width/2); line.setAttribute('y1', (sr.top - cont.top) + sr.height/2);
        line.setAttribute('x2', (tr.left - cont.left) + tr.width/2); line.setAttribute('y2', (tr.top - cont.top) + tr.height/2);
        setTimeout(()=>svg.classList.add('hidden'), 1500);
    }
}

// Chat, Dice & Commands
function sendChat() {
    const input = document.getElementById('chat-input'); const msg = input.value.trim(); if(!msg) return; input.value = '';
    if(currentRoomId !== "SANDBOX") db.collection('rooms').doc(currentRoomId).update({ chat: firebase.firestore.FieldValue.arrayUnion({ uid: getPlayerId(), name: playerState.displayName, msg }) });
    else { const cb = document.getElementById('chat-log'); cb.innerHTML += `<div><span class="text-green-500 font-bold">You:</span> ${msg}</div>`; cb.scrollTop = cb.scrollHeight; }
}
function rollDice() {
    const max = parseInt(document.getElementById('dice-type').value);
    const res = Math.floor(Math.random()*max)+1;
    const msg = `rolled a d${max} and got ${res}.`;
    if(currentRoomId !== "SANDBOX") db.collection('rooms').doc(currentRoomId).update({ chat: firebase.firestore.FieldValue.arrayUnion({ uid: 'SYSTEM', name: playerState.displayName, msg }) });
    else { const cb = document.getElementById('chat-log'); cb.innerHTML += `<div><span class="text-purple-400 font-bold">${playerState.displayName}:</span> ${msg}</div>`; cb.scrollTop = cb.scrollHeight; }
}
function logAction(msg) {
    const lb = document.getElementById('action-log'); lb.innerHTML += `<div><span class="text-amber-500">></span> ${msg}</div>`; lb.scrollTop = lb.scrollHeight;
    if(currentRoomId && currentRoomId !== "SANDBOX") db.collection('rooms').doc(currentRoomId).update({ logs: firebase.firestore.FieldValue.arrayUnion({ uid: getPlayerId(), name: playerState.displayName, msg }) });
}

// Turn Management
function endTurn() {
    const myP = gameState.players[getPlayerId()];
    ['front','back','center'].forEach(r => myP[r].forEach(c => { if(c) c.exhausted = false; }));
    
    if(currentRoomId !== "SANDBOX") {
        let tOrder = [...gameState.turnOrder];
        if (tOrder.length > 0) {
            tOrder.push(tOrder.shift());
            db.collection('rooms').doc(currentRoomId).update({ turnOrder: tOrder, activeTurnUid: tOrder[0] });
        }
    }
    logAction("Ended turn. Restored exhausted cards."); broadcastState();
}

let activePeerZone = null;
let selectedPeerCardId = null;

function openPeerModal(uid, zone) {
    activePeerZone = { uid, zone };
    selectedPeerCardId = null;
    const m = document.getElementById('peer-modal');
    const g = document.getElementById('peer-grid');
    document.getElementById('peer-modal-title').textContent = `${zone === 'gy' ? 'GRAVEYARD' : zone.toUpperCase()}`;
    document.getElementById('peer-card-actions').classList.add('hidden');
    g.innerHTML = '';
    
    let arr = [];
    if (uid === getPlayerId()) {
        if (zone === 'deck') arr = [...gameState.deck];
        else arr = [...(gameState.players[uid][zone] || [])];
    } else {
        if (zone === 'deck') arr = [...(gameState.players[uid].deckCache || [])];
        else arr = [...(gameState.players[uid][zone] || [])];
    }
    
    arr.sort((a,b) => a.name.localeCompare(b.name));
    
    arr.forEach(c => {
        g.innerHTML += `<div class="peer-card-item bg-stone-900 border-2 border-stone-700 rounded p-1 cursor-pointer hover:border-amber-500 transition" id="peer-card-${c.instanceId}" onclick="handlePeerCardClick('${c.instanceId}')">
            <img src="${c.image}" class="w-full h-auto object-contain" onerror="this.src='GoldBurnLogo (1).png'">
        </div>`;
    });
    m.classList.remove('hidden');
    if(zone === 'deck' && uid !== getPlayerId()) logAction("Peered at opponent's deck.");
    else if(zone === 'deck') logAction("Peered into deck.");
}

function handlePeerCardClick(instanceId) {
    if (activePeerZone.uid !== getPlayerId()) return;
    
    let arr = activePeerZone.zone === 'deck' ? gameState.deck : gameState.players[getPlayerId()][activePeerZone.zone];
    const card = arr.find(c => c.instanceId === instanceId);
    if (!card) return;

    if (activePeerZone.zone === 'gy') {
        selectedPeerCardId = instanceId;
        document.querySelectorAll('.peer-card-item').forEach(el => el.classList.remove('border-amber-400', 'scale-105'));
        const activeEl = document.getElementById(`peer-card-${instanceId}`);
        if(activeEl) activeEl.classList.add('border-amber-400', 'scale-105');
        
        document.getElementById('peer-selected-card-name').textContent = card.name;
        document.getElementById('peer-card-actions').classList.remove('hidden');
    } else {
        const idx = arr.findIndex(c => c.instanceId === instanceId);
        if (idx > -1) {
            const removedCard = arr.splice(idx, 1)[0];
            gameState.hand.push(removedCard);
            logAction(`Took ${removedCard.name} from deck to hand.`);
            openPeerModal(activePeerZone.uid, activePeerZone.zone);
            renderVTT(); broadcastState();
        }
    }
}

function movePeerSelectedCard(targetZone) {
    if(!selectedPeerCardId || !activePeerZone || activePeerZone.uid !== getPlayerId()) return;
    let arr = gameState.players[getPlayerId()][activePeerZone.zone];
    const idx = arr.findIndex(c => c.instanceId === selectedPeerCardId);
    if(idx > -1) {
        const card = arr.splice(idx, 1)[0];
        if(targetZone === 'hand') {
            gameState.hand.push(card);
            logAction(`Moved ${card.name} from Grave Yard to Hand.`);
        } else if(targetZone === 'void') {
            gameState.players[getPlayerId()].void.push(card);
            logAction(`Moved ${card.name} from Grave Yard to Void.`);
        } else if(targetZone === 'deck') {
            gameState.deck.push(card);
            gameState.deck.sort(() => Math.random() - 0.5);
            logAction(`Moved ${card.name} from Grave Yard to Deck and shuffled.`);
        }
        selectedPeerCardId = null;
        openPeerModal(activePeerZone.uid, activePeerZone.zone);
        renderVTT(); broadcastState();
    }
}

function closePeerModal(e) {
    if(e && e.target.id !== 'peer-modal' && e.target.id !== 'close-peer-btn') return;
    document.getElementById('peer-modal').classList.add('hidden');
    if (activePeerZone && activePeerZone.uid === getPlayerId() && activePeerZone.zone === 'deck') {
        gameState.deck.sort(() => Math.random() - 0.5);
        logAction("Deck shuffled.");
        broadcastState();
    }
    activePeerZone = null;
    selectedPeerCardId = null;
}

function leaveMatch() {
    if(gameState.players[getPlayerId()] && gameState.players[getPlayerId()].spectator) return;
    
    if(gameState.phase === 'PLAYING' && currentRoomId && currentRoomId !== "SANDBOX") {
        if(confirm("Concede match?")) {
            gameState.players[getPlayerId()].spectator = true;
            processPlayerElimination();
        }
    } else executeLeaveMatch();
}

function executeLeaveMatch() {
    if(currentRoomId && currentRoomId !== "SANDBOX" && gameState.isHost) db.collection('rooms').doc(currentRoomId).update({ status: 'CLOSED' }).catch(()=>{});
    gameState.phase = 'LOBBY'; if(roomUnsubscribe) { roomUnsubscribe(); roomUnsubscribe=null; } currentRoomId=null;
    clearInterval(matchTimerInterval); clearInterval(hostPingInterval);
    
    gameState.players = {}; gameState.turnOrder = []; gameState.activeTurnUid = null;
    activeQueueUnsub = null; gameState.activeQueueMode = null;

    hideAllViews();
    document.getElementById('lobby-view').classList.remove('hidden');
    switchTab('play'); loadLocalDeck();
}

// --- DECK MANAGER ---
function loadLocalDeck() {
    const d = localStorage.getItem('gb_currentDeck');
    if(d) playerState.currentDeck = JSON.parse(d);
    playerState.currentVital = localStorage.getItem('gb_currentVital') || null;
    playerState.activeDeckName = localStorage.getItem('gb_activeDeckName') || "Custom Deck";
}
function saveLocalDeck() {
    localStorage.setItem('gb_currentDeck', JSON.stringify(playerState.currentDeck));
    localStorage.setItem('gb_currentVital', playerState.currentVital || '');
    localStorage.setItem('gb_activeDeckName', playerState.activeDeckName);
}

function isCardOwned(card) {
    if(card.id === 'DW_thebanditcaptain' && (!playerState.uid || playerState.unlockedCards.includes('Bandits Arrival Starter'))) return true;
    if(!playerState.uid) return card.set && card.set.includes('Bandits Arrival');
    if(playerState.unlockedCards.includes(card.id)) return true;
    if(card.set && card.set.includes('Bandits') && playerState.unlockedCards.includes('Bandits Arrival Starter')) return true;
    if(card.set && card.set.includes('Devout') && playerState.unlockedCards.includes('Devout Patronage Starter')) return true;
    return false;
}

function toggleSubtypeDropdown() { document.getElementById('subtype-dropdown-panel').classList.toggle('hidden'); }

let selectedFilterTypes = new Set();
function filterCollection() {
    const nameEl = document.getElementById('card-search-name');
    if(!nameEl) return;
    const qName = nameEl.value.toLowerCase();
    const qDesc = document.getElementById('card-search-desc').value.toLowerCase();
    const cost = document.getElementById('filter-cost').value;
    const setFilter = document.getElementById('filter-set').value;
    const speed = document.getElementById('filter-speed').value;
    const sort = document.getElementById('sort-by').value;
    const grid = document.getElementById('collection-grid');
    if(!grid) return;
    grid.innerHTML = '';

    const panel = document.getElementById('subtype-dropdown-panel');
    if (panel && panel.children.length === 0) {
        const availableTypes = new Set(); const availableSubtypes = new Set();
        MASTER_CARDS.forEach(c => {
            if (isCardOwned(c)) {
                if(c.type) availableTypes.add(c.type);
                if(c.subtypes) c.subtypes.forEach(s => availableSubtypes.add(s));
            }
        });
        
        let html = `<div class="font-bold text-amber-400 text-xs mb-1 border-b border-stone-800 pb-1">Types</div><div class="grid grid-cols-3 md:grid-cols-4 gap-1 mb-2">`;
        availableTypes.forEach(t => html += `<label class="flex items-center space-x-2 text-stone-300 text-xs cursor-pointer"><input type="checkbox" value="${t}" onchange="handleSubtype(this)" class="rounded bg-stone-900 border-stone-700 text-amber-500"><span>${t}</span></label>`);
        html += `</div><div class="font-bold text-amber-400 text-xs mb-1 border-b border-stone-800 pb-1">Subtypes</div><div class="grid grid-cols-3 md:grid-cols-4 gap-1">`;
        availableSubtypes.forEach(st => html += `<label class="flex items-center space-x-2 text-stone-300 text-xs cursor-pointer"><input type="checkbox" value="${st}" onchange="handleSubtype(this)" class="rounded bg-stone-900 border-stone-700 text-amber-500"><span>${st}</span></label>`);
        panel.innerHTML = html + `</div>`;
    }

    let filtered = MASTER_CARDS.filter(card => {
        if (!isCardOwned(card)) return false;
        if (qName && !card.name.toLowerCase().includes(qName)) return false;
        if (qDesc && (!card.description || !card.description.toLowerCase().includes(qDesc))) return false;
        if (cost !== 'all') {
            const cc = card.cost || 0;
            if (cost === '<3' && cc >= 3) return false;
            if (cost === '3' && cc !== 3) return false;
            if (cost === '>3' && cc <= 3) return false;
            if (cost === 'special' && card.type !== 'Zone' && card.type !== 'Act') return false;
        }
        if (setFilter !== 'all' && (!card.set || !card.set.includes(setFilter))) return false;
        if (speed !== 'all' && (!card.subtypes || !card.subtypes.includes(speed))) return false;
        if (selectedFilterTypes.size > 0) {
            const matchT = selectedFilterTypes.has(card.type);
            const matchS = card.subtypes && card.subtypes.some(s => selectedFilterTypes.has(s));
            if(!matchT && !matchS) return false;
        }
        return true;
    });

    filtered.sort((a,b) => {
        if(sort === 'name') return a.name.localeCompare(b.name);
        if(sort === 'type') return a.type.localeCompare(b.type);
        if(sort === 'cost') return (a.cost||0) - (b.cost||0);
        return 0;
    });

    filtered.forEach(card => {
        const el = document.createElement('div');
        el.className = "bg-stone-950 border border-stone-800 p-2 rounded text-xs flex flex-col justify-between h-64 shadow-md hover:border-amber-500 transition relative";
        el.innerHTML = `
            <div class="flex justify-between items-center mb-1">
                <span class="text-amber-400 font-bold truncate text-sm flex-1">${card.name}</span>
                <button onclick="showCardDetails('${card.id}')" class="bg-stone-800 text-stone-300 hover:text-amber-400 px-1.5 py-0.5 rounded text-[10px] ml-1 shadow font-bold border border-stone-700">[ i ]</button>
            </div>
            <div class="flex-1 overflow-hidden bg-stone-900 rounded flex items-center justify-center p-1 border border-stone-800 cursor-pointer" onclick="addCardToDeck('${card.id}')">
                <img src="${card.image}" class="h-full w-full object-contain" onerror="this.src='GoldBurnLogo (1).png'">
            </div>
            <div class="text-[10px] text-stone-500 my-1">${card.type} | Cost: ${card.cost||0}</div>
            <button onclick="addCardToDeck('${card.id}')" class="bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold py-1.5 rounded transition shadow">Add to Deck</button>`;
        grid.appendChild(el);
    });
}

function handleSubtype(cb) {
    if (cb.checked) selectedFilterTypes.add(cb.value); else selectedFilterTypes.delete(cb.value);
    document.getElementById('subtype-dropdown-label').textContent = selectedFilterTypes.size > 0 ? `Selected (${selectedFilterTypes.size})` : "Types & Subtypes";
    filterCollection();
}

function showCardDetails(id) {
    const card = MASTER_CARDS.find(c => c.id === id);
    if(!card) return;
    document.getElementById('cd-img').src = card.image || 'GoldBurnLogo (1).png';
    document.getElementById('cd-name').textContent = card.name;
    document.getElementById('cd-stats').textContent = `Cost: ${card.cost||0} | HP: ${card.hp||'-'} | Set: ${card.set||'Core'} | ${card.type} - ${card.subtypes ? card.subtypes.join(', ') : ''}`;
    document.getElementById('cd-desc').textContent = card.description || 'No description available.';
    document.getElementById('card-details-modal').classList.remove('hidden');
}
function closeCardDetails(e) { if(e && e.target.id === 'card-details-modal') document.getElementById('card-details-modal').classList.add('hidden'); }

function addCardToDeck(id) {
    const card = MASTER_CARDS.find(c => c.id === id);
    if(!card) return;
    if (card.type === 'Vital') {
        playerState.currentVital = id;
    } else {
        const count = playerState.currentDeck[id] || 0;
        if (count >= (card.limit || 3)) return alert(`Limit ${card.limit||3} per card.`);
        let total = 0; for (let amt of Object.values(playerState.currentDeck)) total += amt;
        if (total >= 30) return alert("Main deck limit 30 reached.");
        playerState.currentDeck[id] = count + 1;
    }
    renderDeckList(); saveLocalDeck();
}

function removeCardFromDeck(id) {
    if(playerState.currentDeck[id]) {
        playerState.currentDeck[id]--;
        if(playerState.currentDeck[id] <= 0) delete playerState.currentDeck[id];
        renderDeckList(); saveLocalDeck();
    }
}
function removeVitalCard() { playerState.currentVital = null; renderDeckList(); saveLocalDeck(); }

function renderDeckList() {
    const list = document.getElementById('deck-list');
    if(!list) return;
    list.innerHTML = '';
    
    const vitalDisplay = document.getElementById('vital-card-display');
    if (playerState.currentVital) {
        const v = MASTER_CARDS.find(c => c.id === playerState.currentVital);
        vitalDisplay.textContent = v ? v.name : "None";
    } else {
        vitalDisplay.textContent = "None";
    }

    let total = 0;
    for (const [id, count] of Object.entries(playerState.currentDeck)) {
        const c = MASTER_CARDS.find(card => card.id === id);
        if(!c) continue;
        total += count;
        const el = document.createElement('div');
        el.className = "flex justify-between items-center text-xs border-b border-stone-800 py-1.5";
        el.innerHTML = `<span class="text-stone-300 font-bold">${c.name} <span class="text-amber-500">x${count}</span></span> <button onclick="removeCardFromDeck('${id}')" class="text-red-500 hover:text-red-400 font-bold bg-stone-900 px-2 rounded border border-stone-700">X</button>`;
        list.appendChild(el);
    }
    document.getElementById('deck-count').textContent = `${total} / 30`;
    document.getElementById('deck-name-input').value = playerState.activeDeckName;

    const saved = document.getElementById('saved-decks-select');
    if(saved) {
        saved.innerHTML = `<option value="">-- Load Saved Deck --</option>`;
        for (const d of Object.keys(playerState.customDecks)) {
            saved.innerHTML += `<option value="${d}" ${playerState.activeDeckName === d ? 'selected' : ''}>${d}</option>`;
        }
    }
}

function saveCurrentDeck() {
    const name = document.getElementById('deck-name-input').value.trim() || "Custom Deck";
    playerState.customDecks[name] = {...playerState.currentDeck};
    playerState.activeDeckName = name;
    saveLocalDeck(); renderDeckList(); alert("Deck Saved locally!");
}

function loadSelectedDeck() {
    const name = document.getElementById('saved-decks-select').value;
    if (name && playerState.customDecks[name]) {
        playerState.currentDeck = {...playerState.customDecks[name]};
        playerState.activeDeckName = name;
        document.getElementById('deck-name-input').value = name;
        renderDeckList(); saveLocalDeck();
    }
}
function deleteSelectedDeck() {
    const name = document.getElementById('saved-decks-select').value;
    if (name) { delete playerState.customDecks[name]; renderDeckList(); saveLocalDeck(); }
}
function exportDeckCode() { prompt("Deck Code:", btoa(JSON.stringify({v: playerState.currentVital, m: playerState.currentDeck}))); }
function importDeckCode() {
    try {
        const c = JSON.parse(atob(prompt("Paste Code:")));
        if (c.m) playerState.currentDeck = c.m; if (c.v) playerState.currentVital = c.v;
        renderDeckList(); saveLocalDeck();
    } catch(e) { alert("Invalid Code"); }
}

function equipStarterDeck() {
    const val = document.getElementById('equip-starter-select').value;
    if (val && STARTER_DECKS[val]) {
        const isOwned = !playerState.uid ? (val === "Bandits Arrival Starter") : playerState.unlockedCards.includes(val);
        if(!isOwned) return alert("You must buy this deck in the Shop first!");

        playerState.currentDeck = {};
        for (const [id, count] of Object.entries(STARTER_DECKS[val])) {
            const card = MASTER_CARDS.find(c => c.id === id);
            if (card && card.type === 'Vital') playerState.currentVital = id; 
            else playerState.currentDeck[id] = count;
        }
        playerState.activeDeckName = val;
        saveLocalDeck(); renderDeckList(); alert(`Equipped ${val}`);
    }
}

// --- SHOP & INVENTORY ---
function buyStoreItem(key, cost) {
    if (playerState.accountGold >= cost) {
        playerState.accountGold -= cost;
        if (!playerState.unlockedCards.includes(key)) playerState.unlockedCards.push(key);
        
        if (playerState.uid) {
            db.collection('players').doc(playerState.uid).update({ 
                accountGold: playerState.accountGold, unlockedCards: playerState.unlockedCards 
            });
        }
        updateUI(); filterCollection(); renderStoreAndInventory();
    } else { alert("Not enough account gold!"); }
}

function renderStoreAndInventory() {
    const store = document.getElementById('store-items-container');
    const inv = document.getElementById('inventory-list');
    if(!store || !inv) return;
    store.innerHTML = ''; inv.innerHTML = '';

    STORE_ITEMS.forEach(i => {
        if (!playerState.unlockedCards.includes(i.key)) {
            const el = document.createElement('div');
            el.className = "bg-stone-900 border border-stone-800 p-4 rounded shadow-lg flex flex-col justify-between";
            el.innerHTML = `<div><h3 class="text-amber-400 font-bold text-lg mb-1">${i.name}</h3><p class="text-stone-400 text-xs mb-3">${i.desc}</p></div><button onclick="buyStoreItem('${i.key}', ${i.cost})" class="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold py-2 rounded transition shadow">Buy (${i.cost}G)</button>`;
            store.appendChild(el);
        }
    });

    if (playerState.unlockedCards.length === 0) inv.innerHTML = `<p class="text-xs text-stone-500 col-span-full">No items unlocked yet.</p>`;
    playerState.unlockedCards.forEach(item => {
        const el = document.createElement('div');
        el.className = "bg-stone-950 border border-amber-500/50 p-3 rounded text-center text-xs font-bold text-amber-400 shadow flex flex-col justify-center items-center";
        el.innerHTML = `<div class="text-stone-500 text-[10px] mb-1">UNLOCKED</div><div>${item}</div>`;
        inv.appendChild(el);
    });
}

function updateUI() { 
    const el = document.getElementById('account-gold-display');
    if(el) el.textContent = playerState.accountGold; 
    const rankEl = document.getElementById('profile-rank');
    if(rankEl) rankEl.textContent = playerState.rank;
}
function testDeckInSandbox(){ currentRoomId="SANDBOX"; showVitalLobby('sandbox'); }
window.onload = () => { loadLocalDeck(); updateUI(); filterCollection(); renderDeckList(); renderStoreAndInventory(); };

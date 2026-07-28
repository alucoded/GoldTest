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
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

let playerState = { 
    uid: null, displayName: "Guest Player", accountGold: 10, 
    unlockedCards: [], customDecks: {}, activeDeckName: "Custom Deck", currentDeck: {}, currentVital: null
};
let ws = null;
let pendingPayloads = [];

// --- VTT GAME STATE ---
let gameState = {
    matchId: null, roomCode: null, phase: 'LOBBY',
    deck: [], hand: [], gold: 3,
    board: { playerFront: [null, null, null], playerBack: [null, null, null], oppFront: [null, null, null], oppBack: [null, null, null], center: [null, null, null], gy: [], void: [], oppGy: [], oppVoid: [], oppDeckCount: 0, oppGold: 3 },
    targetMode: false, targetSource: null, moveMode: false, moveSource: null
};
let selectedHandIndex = null;
let activeInsSlot = null; 
let activeBoardMenuSlot = null; 
let activeQueueMode = null;
let matchTimerInterval = null;
let matchSeconds = 0;

const STORE_ITEMS = [
    { key: "Bandits Arrival Starter", name: "Bandits Arrival Starter", cost: 0, desc: "Foundational Bandits Arrival starter deck." },
    { key: "Devout Patronage Starter", name: "Devout Patronage Starter", cost: 20, desc: "Complete Devout Patronage starter deck." }
];

function isCardOwned(card) {
    if(card.id === 'DW_thebanditcaptain' && (!playerState.uid || playerState.unlockedCards.includes('Bandits Arrival Starter'))) return true;
    if(!playerState.uid) return card.set && card.set.includes('Bandits Arrival');
    if(playerState.unlockedCards.includes(card.id)) return true;
    if(card.set && card.set.includes('Bandits') && playerState.unlockedCards.includes('Bandits Arrival Starter')) return true;
    if(card.set && card.set.includes('Devout') && playerState.unlockedCards.includes('Devout Patronage Starter')) return true;
    return false;
}

function sendToServer(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    } else {
        pendingPayloads.push(payload);
        connectWebSocket();
    }
}

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket('wss://your-app-name.onrender.com');
    ws.onopen = () => { 
        if (playerState.uid) ws.send(JSON.stringify({ type: "AUTH", uid: playerState.uid, email: playerState.email, displayName: playerState.displayName })); 
        while(pendingPayloads.length > 0) ws.send(JSON.stringify(pendingPayloads.shift()));
    };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "PROFILE_LOADED") {
            playerState.accountGold = data.profile.accountGold;
            playerState.unlockedCards = data.profile.unlockedCards || [];
            updateUI(); filterCollection(); renderStoreAndInventory();
        } else if (data.type === "MATCH_FOUND") {
            resetQueueButtons();
            gameState.matchId = data.matchId;
            gameState.roomCode = data.roomCode;
            showVitalLobby(data.mode);
        } else if (data.type === "OPPONENT_JOINED") {
            const ls = document.getElementById('lobby-status');
            if(ls) {
                ls.textContent = "Opponent connected! Prepare for match.";
                ls.classList.replace('text-stone-400', 'text-emerald-400');
            }
        } else if (data.type === "START_GAME") {
            enterMatch(data.startingGold, data.isPlayerOne);
        } else if (data.type === "SYNC_STATE") {
            const p = data.payload;
            gameState.board.oppFront = p.front; gameState.board.oppBack = p.back;
            gameState.board.oppGy = p.gy; gameState.board.oppVoid = p.void; 
            gameState.board.oppDeckCount = p.deckCount;
            gameState.board.oppGold = p.gold !== undefined ? p.gold : 3;
            if (p.center) {
                if (p.center[2] !== null) gameState.board.center[0] = p.center[2];
                if (p.center[0] !== null) gameState.board.center[2] = p.center[0];
                if (p.center[1] !== null) gameState.board.center[1] = p.center[1];
            }
            renderVTT();
        } else if (data.type === "GAME_ACTION") {
            logAction(`Opponent: ${data.payload}`, true);
        } else if (data.type === "CHAT") {
            const chat = document.getElementById('chat-log');
            chat.innerHTML += `<div><span class="text-red-500 font-bold">Opp:</span> ${data.payload}</div>`;
            chat.scrollTop = chat.scrollHeight;
        } else if (data.type === "MATCH_END") {
            if (data.isWinner) {
                alert("醇 YOU WIN! Your opponent was defeated or surrendered. You earned 3 Gold.");
            } else {
                alert("逐 YOU LOST! You have been defeated.");
            }
            executeLeaveMatch();
        } else if (data.type === "ERROR") alert(data.message);
    };
}

auth.onAuthStateChanged((user) => {
    loadLocalDeck();
    if (user) {
        playerState.uid = user.uid; playerState.displayName = user.displayName;
        document.getElementById('profile-name').textContent = user.displayName;
        document.getElementById('auth-btn').textContent = "Sign Out";
        connectWebSocket();
    } else {
        playerState.unlockedCards = ['Bandits Arrival Starter'];
        filterCollection(); renderStoreAndInventory(); renderDeckList();
    }
});

function toggleAuth() {
    if (gameState.matchId) return alert("Cannot sign out in a match!");
    if (playerState.uid) auth.signOut().then(() => window.location.reload());
    else auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.getElementById(`tab-${tabId}`).classList.remove('hidden');
    if (tabId === 'forge') filterCollection();
}

function toggleQueue(mode, btn) {
    if (activeQueueMode === mode) {
        sendToServer({ type: "CANCEL_QUEUE", mode });
        resetQueueButtons();
    } else {
        if (activeQueueMode) sendToServer({ type: "CANCEL_QUEUE", mode: activeQueueMode });
        resetQueueButtons();
        activeQueueMode = mode;
        btn.textContent = "Cancel Search";
        btn.classList.replace('bg-amber-600', 'bg-red-700');
        
        if(mode !== 'starters' && !playerState.currentVital) { 
            resetQueueButtons(); 
            return alert("You must equip a Vital card in the Forge first!"); 
        }
        sendToServer({ type: "JOIN_QUEUE", mode, uid: playerState.uid });
    }
}
function resetQueueButtons() {
    ['quickplay', 'ranked', 'starters'].forEach(m => {
        const b = document.getElementById(`q-${m}`);
        if(b) { b.textContent = `Play ${m.charAt(0).toUpperCase() + m.slice(1)}`; b.classList.replace('bg-red-700', 'bg-amber-600'); }
    });
    activeQueueMode = null;
}

function startCustomMatch() {
    if(!playerState.currentVital) return alert("You must equip a Vital card in the Forge first!");
    const code = document.getElementById('custom-room-code').value.trim();
    sendToServer({ type: "START_CUSTOM", roomCode: code, uid: playerState.uid });
}

// --- GAMEPLAY ENGINE ---
function broadcastState() {
    if (gameState.matchId === "SANDBOX" || !gameState.matchId) return;
    const payload = {
        front: gameState.board.playerFront, back: gameState.board.playerBack, center: gameState.board.center,
        gy: gameState.board.gy, void: gameState.board.void, deckCount: gameState.deck.length, gold: gameState.gold
    };
    sendToServer({ type: "SYNC_STATE", matchId: gameState.matchId, payload });
}

function testDeckInSandbox() {
    if (Object.keys(playerState.currentDeck).length === 0) return alert("Deck is empty!");
    if (!playerState.currentVital) return alert("No Vital card equipped!");
    gameState.matchId = "SANDBOX";
    showVitalLobby("sandbox");
}

// Helper to parse the current deck into the match state
function loadDeckIntoGameState(deckToLoad = playerState.currentDeck, vitalToLoad = playerState.currentVital) {
    gameState.deck = [];
    for (const [id, count] of Object.entries(deckToLoad)) {
        const card = MASTER_CARDS.find(c => c.id === id);
        if(card) {
            for (let i=0; i<count; i++) gameState.deck.push({...card, instanceId: Math.random().toString(36).substr(2, 9), currentHp: card.hp, markers: {}, exhausted: false});
        }
    }
    const vCard = MASTER_CARDS.find(c => c.id === vitalToLoad);
    if (vCard) gameState.deck.push({...vCard, instanceId: Math.random().toString(36).substr(2, 9), currentHp: vCard.hp, markers: {}, exhausted: false});
}

// Fired when the player confirms their starter deck choice in the lobby
function confirmLobbyStarter() {
    const val = document.getElementById('lobby-starter-select').value;
    if (!val) return alert("Please select a deck first.");
    
    let tempVital = null;
    let tempDeck = {};
    for (const [id, count] of Object.entries(STARTER_DECKS[val])) {
        const card = MASTER_CARDS.find(c => c.id === id);
        if (card && card.type === 'Vital') tempVital = id;
        else tempDeck[id] = count;
    }
    
    // Set up the state using the chosen starter deck temporarily without overwriting their custom deck
    playerState.currentVital = tempVital; 
    loadDeckIntoGameState(tempDeck, tempVital);
    
    document.getElementById('starter-deck-selection').classList.add('hidden');
    document.getElementById('vital-selection-area').classList.remove('hidden');
}

function showVitalLobby(mode) {
    document.getElementById('lobby-view').classList.add('hidden');
    document.getElementById('vital-lobby-view').classList.remove('hidden');
    
    const vitalArea = document.getElementById('vital-selection-area');
    const starterArea = document.getElementById('starter-deck-selection');
    
    // Reset displays
    vitalArea.classList.add('hidden');
    starterArea.classList.add('hidden');

    if (mode === 'sandbox') {
        document.getElementById('lobby-room-code-container').classList.add('hidden');
        document.getElementById('lobby-status').textContent = "Sandbox Mode Active. Select a slot for your Vital.";
        document.getElementById('lobby-status').classList.replace('text-stone-400', 'text-emerald-400');
        vitalArea.classList.remove('hidden');
        loadDeckIntoGameState();
    } else if (mode === 'starters') {
        document.getElementById('lobby-room-code-container').classList.remove('hidden');
        document.getElementById('lobby-room-code').textContent = gameState.roomCode;
        document.getElementById('lobby-status').textContent = "Opponent found! Choose your Starter Deck.";
        starterArea.classList.remove('hidden'); // Show dropdown instead of vital grid
    } else {
        document.getElementById('lobby-room-code-container').classList.remove('hidden');
        document.getElementById('lobby-room-code').textContent = gameState.roomCode;
        document.getElementById('lobby-status').textContent = "Waiting for opponent to connect...";
        document.getElementById('lobby-status').classList.replace('text-emerald-400', 'text-stone-400');
        vitalArea.classList.remove('hidden');
        loadDeckIntoGameState();
    }

    // Reset Vital Buttons
    document.querySelectorAll('.vital-btn').forEach(btn => {
        btn.classList.remove('border-amber-400');
        btn.innerHTML = btn.id.includes('Front') ? 'F'+(parseInt(btn.id.split('-')[2])+1) : 'B'+(parseInt(btn.id.split('-')[2])+1);
    });
    const lbtn = document.getElementById('btn-lock-in-vital');
    lbtn.disabled = true; lbtn.classList.replace('bg-amber-600', 'bg-stone-800'); lbtn.classList.replace('text-stone-950', 'text-stone-500');
}

let pendingVitalSlot = null; // {region, idx}
function selectVitalSlot(region, idx) {
    pendingVitalSlot = {region, idx};
    const vCard = MASTER_CARDS.find(c => c.id === playerState.currentVital);
    
    document.querySelectorAll('.vital-btn').forEach(btn => {
        const bReg = btn.id.split('-')[1];
        const bIdx = parseInt(btn.id.split('-')[2]);
        if (bReg === region && bIdx === idx) {
            btn.classList.add('border-amber-400');
            btn.innerHTML = `<div class="w-full h-full p-1"><img src="${vCard.image}" class="w-full h-full object-cover rounded opacity-80" onerror="this.src='GoldBurnLogo (1).png'"></div>`;
        } else {
            btn.classList.remove('border-amber-400');
            btn.innerHTML = bReg.includes('Front') ? 'F'+(bIdx+1) : 'B'+(bIdx+1);
        }
    });
    
    const btn = document.getElementById('btn-lock-in-vital');
    btn.disabled = false;
    btn.classList.replace('bg-stone-800', 'bg-amber-600');
    btn.classList.replace('text-stone-500', 'text-stone-950');
}

function lockInVital() {
    const vitalIdx = gameState.deck.findIndex(c => c.type === 'Vital');
    if (vitalIdx !== -1) {
        const vital = gameState.deck.splice(vitalIdx, 1)[0];
        gameState.board[pendingVitalSlot.region][pendingVitalSlot.idx] = vital;
    }
    
    if (gameState.matchId === "SANDBOX") {
        enterMatch(3, true);
    } else {
        document.getElementById('btn-lock-in-vital').textContent = "Waiting for Opponent...";
        sendToServer({ type: "VITAL_LOCKED", matchId: gameState.matchId });
    }
}

function enterMatch(startingGold = 3, isPlayerOne = true) {
    document.getElementById('vital-lobby-view').classList.add('hidden');
    document.getElementById('game-view').classList.remove('hidden');
    
    gameState.phase = 'PLAYING';
    gameState.gold = startingGold;
    
    gameState.deck.sort(() => Math.random() - 0.5);
    gameState.hand = gameState.deck.splice(0, 5); 
    
    document.getElementById('match-gold-val').textContent = gameState.gold;
    document.getElementById('action-log').innerHTML = ''; 
    document.getElementById('chat-log').innerHTML = '';
    
    const turnText = gameState.matchId === "SANDBOX" ? "" : (isPlayerOne ? "You go first!" : "Opponent goes first!");
    logAction(`Match started. Vital deployed. Drew 5 cards. ${turnText}`, true);
    
    startMatchTimer();
    renderVTT();
    inspectEmpty();
    broadcastState();
}

function startMatchTimer() {
    clearInterval(matchTimerInterval);
    matchSeconds = 0;
    document.getElementById('match-timer').textContent = "00:00";
    matchTimerInterval = setInterval(() => {
        matchSeconds++;
        const m = String(Math.floor(matchSeconds / 60)).padStart(2, '0');
        const s = String(matchSeconds % 60).padStart(2, '0');
        document.getElementById('match-timer').textContent = `${m}:${s}`;
    }, 1000);
}

function drawCard() {
    if (gameState.phase !== 'PLAYING') return;
    if (gameState.deck.length === 0) return logAction("Deck empty!", true);
    gameState.hand.push(gameState.deck.shift());
    logAction("Drew a card.");
    renderVTT();
    broadcastState();
}

function editMatchGold(dir) {
    gameState.gold = Math.max(0, gameState.gold + dir);
    document.getElementById('match-gold-val').textContent = gameState.gold;
    logAction(`Adjusted Gold to ${gameState.gold}.`);
    broadcastState();
}

function logAction(msg, skipBroadcast = false) {
    const log = document.getElementById('action-log');
    log.innerHTML += `<div><span class="text-amber-500">></span> ${msg}</div>`;
    log.scrollTop = log.scrollHeight;
    if (!skipBroadcast && ws && gameState.matchId !== "SANDBOX") sendToServer({ type: "GAME_ACTION", matchId: gameState.matchId, action: "LOG", payload: msg });
}

function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    const chat = document.getElementById('chat-log');
    chat.innerHTML += `<div><span class="text-green-500 font-bold">You:</span> ${msg}</div>`;
    chat.scrollTop = chat.scrollHeight;
    input.value = '';
    if (ws && gameState.matchId !== "SANDBOX") sendToServer({ type: "CHAT", matchId: gameState.matchId, payload: msg });
}

// --- VTT RENDERER ---
function renderVTT() {
    document.getElementById('deck-count-hud').textContent = gameState.deck.length;
    
    // Opponent Gold Sync
    const oppGoldEl = document.getElementById('opp-gold-val');
    if(oppGoldEl) oppGoldEl.textContent = gameState.board.oppGold || 0;

    // Render Hand
    const handEl = document.getElementById('player-hand-container');
    handEl.innerHTML = '';
    gameState.hand.forEach((card, idx) => {
        const div = document.createElement('div');
        div.className = `w-[110px] h-[155px] flex-shrink-0 cursor-pointer rounded-md overflow-hidden border-2 transition ${selectedHandIndex === idx ? 'border-amber-400 scale-105 shadow-[0_0_15px_#fbbf24] z-20' : 'border-stone-800 hover:border-stone-500'}`;
        div.innerHTML = `<img src="${card.image}" class="card-img-full bg-stone-900 p-1" onerror="this.src='GoldBurnLogo (1).png'">`;
        div.onclick = () => {
            selectedHandIndex = selectedHandIndex === idx ? null : idx;
            activeInsSlot = null; activeBoardMenuSlot = null;
            if (gameState.moveMode) { gameState.moveMode = false; gameState.moveSource = null; } 
            if (gameState.targetMode) { gameState.targetMode = false; gameState.targetSource = null; } 
            if(selectedHandIndex !== null) inspectCard(card, 'hand', idx);
            else inspectEmpty();
            renderVTT();
        };
        handEl.appendChild(div);
    });

    const renderRow = (region, maxSlots, isOpp=false) => {
        for(let idx=0; idx<maxSlots; idx++) {
            const card = gameState.board[region][idx];
            const slot = document.getElementById(`${region}-${idx}`);
            if (!slot) continue;
            
            if (card) {
                let markersHtml = '';
                for(let [color, amt] of Object.entries(card.markers||{})) {
                    if (amt > 0) markersHtml += `<div class="marker-dot bg-${color === 'black' ? 'stone-800' : color+'-500'}">${amt}</div>`;
                }
                
                const isTargeted = activeInsSlot && activeInsSlot.region === region && activeInsSlot.index === idx;
                const isMenuOpen = activeBoardMenuSlot && activeBoardMenuSlot.region === region && activeBoardMenuSlot.index === idx;
                const exhaustedStyle = card.exhausted ? 'opacity-50 grayscale-[80%]' : '';
                const zzzOverlay = card.exhausted ? `<div class="zzz-overlay">彫</div>` : '';
                
                // On-Card Menu Overlay
                const menuOverlay = isMenuOpen && !isOpp ? `
                    <div class="absolute inset-0 bg-black/85 flex flex-col items-center justify-center gap-1 z-20 rounded p-1">
                        <button onclick="event.stopPropagation(); startTargeting()" class="bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold px-2 py-1.5 rounded text-[9px] w-full shadow">識 Target</button>
                        <button onclick="event.stopPropagation(); startMoving()" class="bg-blue-600 hover:bg-blue-500 text-stone-100 font-bold px-2 py-1.5 rounded text-[9px] w-full shadow">純 Move</button>
                        <button onclick="event.stopPropagation(); sendToZone('gy')" class="bg-stone-800 hover:bg-stone-700 text-stone-300 font-bold px-2 py-1.5 rounded text-[9px] w-full border border-stone-600">逐 To GY</button>
                    </div>` : '';

                slot.className = `board-slot bg-stone-900 border-2 ${isTargeted ? 'border-amber-400 ring-2 ring-amber-500 shadow-xl scale-[1.02] z-10' : (isOpp?'border-red-900/50':'border-amber-600/50')} rounded flex items-center justify-center shadow-lg overflow-hidden cursor-pointer`;
                slot.innerHTML = `
                    <img src="${card.image}" class="card-img-full bg-black ${exhaustedStyle}" onerror="this.src='GoldBurnLogo (1).png'">
                    ${zzzOverlay}
                    ${card.currentHp !== undefined ? `<div class="hp-badge">${card.currentHp}</div>` : ''}
                    <div class="marker-container">${markersHtml}</div>
                    ${menuOverlay}
                `;
                slot.onclick = () => {
                    if (gameState.targetMode) return finishTargeting(region, idx);
                    if (gameState.moveMode) return; // Cannot move ONTO an occupied slot
                    
                    selectedHandIndex = null;
                    activeInsSlot = { region, index: idx };
                    
                    if(!isOpp) {
                        if (isMenuOpen) activeBoardMenuSlot = null;
                        else activeBoardMenuSlot = { region, index: idx };
                    }
                    
                    inspectCard(card, region, idx, isOpp);
                    renderVTT();
                };
            } else {
                const isMoveTarget = gameState.moveMode && !isOpp && (region === 'playerFront' || region === 'playerBack' || (region === 'center' && (idx === 1 || idx === 2)));
                
                slot.className = `board-slot bg-stone-800/20 border-2 border-stone-700 rounded flex items-center justify-center text-xs text-stone-500 font-bold ${selectedHandIndex !== null || gameState.targetMode ? 'selectable' : ''} ${isMoveTarget ? 'move-target' : ''}`;
                slot.innerHTML = region === 'center' ? (idx===1?'SHARED ZONE':(idx===0?'OPP ACT':'YOUR ACT')) : `EMPTY`;
                slot.onclick = () => {
                    if (gameState.targetMode) return finishTargeting(region, idx);
                    if (gameState.moveMode) return finishMoving(region, idx);
                    if (!isOpp) handleEmptySlotClick(region, idx);
                };
            }
        }
    };

    renderRow('playerFront', 3); renderRow('playerBack', 3); renderRow('center', 3);
    renderRow('oppFront', 3, true); renderRow('oppBack', 3, true);

    const renderPile = (id, arr, colorClass) => {
        const el = document.getElementById(id);
        if(!el) return;
        if (arr && arr.length > 0) {
            const top = arr[arr.length-1];
            el.innerHTML = `<img src="${top.image}" class="absolute inset-0 w-full h-full object-cover opacity-60 blur-[1px] grayscale p-1" onerror="this.src='GoldBurnLogo (1).png'"><span class="z-10 bg-black/80 px-2 py-1 rounded text-${colorClass}-400">${id.split('-')[0].toUpperCase()} [${arr.length}]</span>`;
        } else {
            el.innerHTML = `<span class="z-10 bg-black/80 px-2 py-1 rounded text-${colorClass}-400">${id.split('-')[0].toUpperCase()} [0]</span>`;
        }
    };
    renderPile('gy-visual', gameState.board.gy, 'stone');
    renderPile('void-visual', gameState.board.void, 'purple');
    renderPile('opp-gy-visual', gameState.board.oppGy, 'stone');
    renderPile('opp-void-visual', gameState.board.oppVoid, 'purple');
}

function handleEmptySlotClick(region, index) {
    if (selectedHandIndex !== null) {
        const card = gameState.hand[selectedHandIndex];
        if (region === 'center') {
            if (index === 1 && card.type !== 'Zone') return alert("Only Zone cards can go here.");
            if (index === 2 && card.type !== 'Act') return alert("Only Act cards can go here.");
            if (index === 0) return alert("That is the opponent's act slot.");
        }
        
        if (gameState.gold < (card.cost || 0)) return alert("Not enough gold!");
        gameState.gold -= (card.cost || 0);
        document.getElementById('match-gold-val').textContent = gameState.gold;

        gameState.hand.splice(selectedHandIndex, 1);
        gameState.board[region][index] = card;
        selectedHandIndex = null; activeInsSlot = null; activeBoardMenuSlot = null;
        logAction(`Deployed ${card.name}.`);
        renderVTT();
        inspectEmpty();
        broadcastState();
    } else {
        activeInsSlot = { region, index };
        activeBoardMenuSlot = null;
        showEmptyInspector();
        renderVTT();
    }
}

// --- MOVE MECHANIC ---
function startMoving() {
    gameState.moveMode = true;
    gameState.moveSource = activeInsSlot;
    activeBoardMenuSlot = null; 
    logAction("Select an empty slot to move the card...");
    renderVTT();
}

function finishMoving(region, index) {
    if (region === 'center') {
        const sourceCard = gameState.board[gameState.moveSource.region][gameState.moveSource.index];
        if (index === 1 && sourceCard.type !== 'Zone') return alert("Only Zone cards can go here.");
        if (index === 2 && sourceCard.type !== 'Act') return alert("Only Act cards can go here.");
        if (index === 0) return alert("That is the opponent's act slot.");
    }

    const card = gameState.board[gameState.moveSource.region][gameState.moveSource.index];
    gameState.board[gameState.moveSource.region][gameState.moveSource.index] = null;
    gameState.board[region][index] = card;
    
    gameState.moveMode = false;
    gameState.moveSource = null;
    activeInsSlot = null;
    logAction(`Moved ${card.name}.`);
    renderVTT();
    inspectEmpty();
    broadcastState();
}

// --- CARD INSPECTOR LOGIC ---
function inspectCard(card, region=null, idx=null, isOpp=false) {
    document.getElementById('ins-img').src = card.image || 'GoldBurnLogo (1).png';
    document.getElementById('ins-name').textContent = card.name;
    document.getElementById('ins-stats').textContent = `${card.type} | ${card.subtypes ? card.subtypes.join(', ') : ''}`;
    document.getElementById('ins-desc').textContent = `Cost: ${card.cost||0}\nHP: ${card.hp||'-'}\n\n${card.description || 'No description.'}`;
    
    document.getElementById('ins-empty-actions').classList.add('hidden');
    document.getElementById('ins-hand-actions').classList.add('hidden');
    document.getElementById('ins-board-actions').classList.add('hidden');
    document.getElementById('ins-zone-actions').classList.add('hidden');

    if (isOpp) return; 

    if (region === 'hand') {
        document.getElementById('ins-hand-actions').classList.remove('hidden');
    } else if (region === 'gy' || region === 'void') {
        document.getElementById('ins-zone-actions').classList.remove('hidden');
        const oppBtn = document.getElementById('btn-zone-opposite');
        if(region === 'gy') { oppBtn.textContent = "Move to Void"; oppBtn.onclick = () => moveZoneCard('gy', 'void', idx); } 
        else { oppBtn.textContent = "Move to GY"; oppBtn.onclick = () => moveZoneCard('void', 'gy', idx); }
        document.getElementById('btn-zone-hand').onclick = () => moveZoneCard(region, 'hand', idx);
        document.getElementById('btn-zone-deck').onclick = () => moveZoneCard(region, 'deck', idx);
    } else if (region) {
        document.getElementById('ins-board-actions').classList.remove('hidden');
        document.getElementById('ins-hp-val').textContent = card.currentHp || 0;
        ['red', 'blue', 'green', 'black'].forEach(c => document.getElementById(`ins-m-${c}`).textContent = card.markers[c] || 0);
    }
}

function inspectEmpty() {
    document.getElementById('ins-img').src = 'GoldBurnLogo (1).png';
    document.getElementById('ins-name').textContent = "Select a Card";
    document.getElementById('ins-stats').textContent = "Type | Subtype";
    document.getElementById('ins-desc').textContent = "Click any card in your hand or on the board to view its detailed abilities, lore, and exact cost here.";
    document.getElementById('ins-board-actions').classList.add('hidden');
    document.getElementById('ins-hand-actions').classList.add('hidden');
    document.getElementById('ins-zone-actions').classList.add('hidden');
    document.getElementById('ins-empty-actions').classList.add('hidden');
}

function showEmptyInspector() {
    document.getElementById('ins-img').src = 'GoldBurnLogo (1).png';
    document.getElementById('ins-name').textContent = "Empty Slot";
    document.getElementById('ins-stats').textContent = "No Card";
    document.getElementById('ins-desc').textContent = "You can create a token here.";
    document.getElementById('ins-board-actions').classList.add('hidden');
    document.getElementById('ins-hand-actions').classList.add('hidden');
    document.getElementById('ins-zone-actions').classList.add('hidden');
    document.getElementById('ins-empty-actions').classList.remove('hidden');
}

function enlargeImage() {
    const src = document.getElementById('ins-img').src;
    if (src && !src.includes('GoldBurnLogo')) {
        document.getElementById('enlarged-img').src = src;
        document.getElementById('enlarge-modal').classList.remove('hidden');
    }
}

function editCardHP(dir) {
    if(!activeInsSlot) return;
    const card = gameState.board[activeInsSlot.region][activeInsSlot.index];
    card.currentHp += dir;
    document.getElementById('ins-hp-val').textContent = card.currentHp;
    logAction(`Adjusted ${card.name} HP to ${card.currentHp}.`);
    
    if (card.type === 'Vital' && card.currentHp <= 0) {
        if (gameState.matchId !== "SANDBOX") {
            sendToServer({ type: "GAME_OVER", matchId: gameState.matchId });
        } else {
            alert("Your Vital has reached 0 HP.");
            executeLeaveMatch();
        }
    }
    
    renderVTT(); broadcastState();
}

function editMarker(color, dir) {
    if(!activeInsSlot) return;
    const card = gameState.board[activeInsSlot.region][activeInsSlot.index];
    let amt = (card.markers[color] || 0) + dir;
    if (amt < 0) amt = 0;
    card.markers[color] = amt;
    document.getElementById(`ins-m-${color}`).textContent = amt;
    logAction(`Adjusted ${color} marker to ${amt}.`);
    renderVTT(); broadcastState();
}

function discardHandCard() {
    if(selectedHandIndex === null) return;
    const card = gameState.hand.splice(selectedHandIndex, 1)[0];
    gameState.board.gy.push(card);
    selectedHandIndex = null;
    logAction(`Discarded ${card.name} from hand.`);
    renderVTT(); inspectEmpty(); broadcastState();
}

function sendToZone(zone) {
    if(!activeInsSlot) return;
    const card = gameState.board[activeInsSlot.region][activeInsSlot.index];
    gameState.board[activeInsSlot.region][activeInsSlot.index] = null;
    gameState.board[zone].push(card);
    logAction(`Sent ${card.name} to ${zone.toUpperCase()}.`);
    activeInsSlot = null; activeBoardMenuSlot = null;
    inspectEmpty(); renderVTT(); broadcastState();
}

function createToken() {
    if(!activeInsSlot) return;
    const name = prompt("Token Name:");
    if (!name) return;
    const hp = parseInt(prompt("Token HP:", "1")) || 1;
    const token = { name, type: 'Token', hp, currentHp: hp, markers: {}, image: 'GoldBurnLogo (1).png', description: 'Custom Token', exhausted: false };
    gameState.board[activeInsSlot.region][activeInsSlot.index] = token;
    logAction(`Created token: ${name}`);
    activeInsSlot = null;
    inspectEmpty(); renderVTT(); broadcastState();
}

function startTargeting() {
    gameState.targetMode = true;
    gameState.targetSource = activeInsSlot;
    activeBoardMenuSlot = null; 
    logAction("Select a target on the board...");
    renderVTT(); 
}

function finishTargeting(region, index) {
    gameState.targetMode = false;
    const sCard = gameState.board[gameState.targetSource.region][gameState.targetSource.index];
    const tCard = gameState.board[region][index];
    
    if (sCard && tCard) {
        logAction(`${sCard.name} targeted ${tCard.name}!`);
        sCard.exhausted = true; // Zzz ONLY to source
        
        const containerRect = document.getElementById('game-view').getBoundingClientRect();
        const sEl = document.getElementById(`${gameState.targetSource.region}-${gameState.targetSource.index}`);
        const tEl = document.getElementById(`${region}-${index}`);
        
        const svg = document.getElementById('targeting-line-container');
        const line = document.getElementById('targeting-line');
        
        if (sEl && tEl) {
            const sRect = sEl.getBoundingClientRect();
            const tRect = tEl.getBoundingClientRect();
            svg.classList.remove('hidden');
            line.setAttribute('x1', (sRect.left - containerRect.left) + sRect.width/2);
            line.setAttribute('y1', (sRect.top - containerRect.top) + sRect.height/2);
            line.setAttribute('x2', (tRect.left - containerRect.left) + tRect.width/2);
            line.setAttribute('y2', (tRect.top - containerRect.top) + tRect.height/2);
            setTimeout(() => svg.classList.add('hidden'), 1000);
        }
    }
    renderVTT(); broadcastState();
}

// --- MODALS: GY/VOID & DECK PEER ---
function openZoneModal(zone) {
    const arr = gameState.board[zone];
    if(!arr || arr.length === 0) return;
    const m = document.getElementById('zone-modal');
    const g = document.getElementById('zone-grid');
    document.getElementById('zone-modal-title').textContent = zone === 'gy' ? 'Graveyard' : 'Void';
    g.innerHTML = '';
    arr.forEach((c, i) => {
        g.innerHTML += `<div onclick="inspectZoneCard('${zone}', ${i})" class="cursor-pointer bg-stone-900 border-2 border-stone-700 rounded p-1 hover:border-amber-500 transition"><img src="${c.image}" class="w-full h-auto object-contain" onerror="this.src='GoldBurnLogo (1).png'"></div>`;
    });
    m.classList.remove('hidden');
}

function inspectZoneCard(zone, idx) {
    document.getElementById('zone-modal').classList.add('hidden');
    activeInsSlot = { region: zone, index: idx };
    inspectCard(gameState.board[zone][idx], zone, idx);
}

function moveZoneCard(from, to, idx) {
    const card = gameState.board[from].splice(idx, 1)[0];
    if (to === 'hand') {
        gameState.hand.push(card);
        logAction(`Moved ${card.name} from ${from.toUpperCase()} to Hand.`);
    } else if (to === 'deck') {
        gameState.deck.push(card);
        gameState.deck.sort(() => Math.random() - 0.5);
        logAction(`Moved ${card.name} from ${from.toUpperCase()} to Deck and shuffled.`);
    } else {
        gameState.board[to].push(card);
        logAction(`Moved ${card.name} from ${from.toUpperCase()} to ${to.toUpperCase()}.`);
    }
    activeInsSlot = null;
    inspectEmpty(); renderVTT(); broadcastState();
}

function closeZoneModal(e) {
    if(e && e.target.id === 'zone-modal') document.getElementById('zone-modal').classList.add('hidden');
}

function peerIntoDeck() {
    const m = document.getElementById('peer-modal');
    const g = document.getElementById('peer-grid');
    g.innerHTML = '';
    const sortedDeck = [...gameState.deck].sort((a,b) => a.name.localeCompare(b.name));
    sortedDeck.forEach(c => {
        g.innerHTML += `<div class="bg-stone-900 border-2 border-stone-700 rounded p-1"><img src="${c.image}" class="w-full h-auto object-contain" onerror="this.src='GoldBurnLogo (1).png'"></div>`;
    });
    m.classList.remove('hidden');
    logAction("Peered into deck.");
}

function closePeerModal(e) {
    if(e && e.target.id !== 'peer-modal' && e.target.id !== 'close-peer-btn') return;
    document.getElementById('peer-modal').classList.add('hidden');
    gameState.deck.sort(() => Math.random() - 0.5);
    logAction("Deck shuffled after peering.");
    broadcastState();
}

function endTurn() {
    ['playerFront', 'playerBack', 'center'].forEach(r => {
        gameState.board[r].forEach(c => { if(c) c.exhausted = false; });
    });
    logAction("Turn Ended.");
    renderVTT(); broadcastState();
}

function leaveMatch() {
    if (gameState.phase === 'PLAYING' && gameState.matchId !== "SANDBOX") {
        if (confirm("Are you sure you want to surrender? You will lose the match.")) {
            sendToServer({ type: "GAME_OVER", matchId: gameState.matchId });
        }
    } else {
        executeLeaveMatch();
    }
}

function executeLeaveMatch() {
    gameState.phase = 'LOBBY';
    gameState.matchId = null;
    clearInterval(matchTimerInterval);
    
    gameState.deck = []; gameState.hand = [];
    gameState.board = { playerFront: [null, null, null], playerBack: [null, null, null], oppFront: [null, null, null], oppBack: [null, null, null], center: [null, null, null], gy: [], void: [], oppGy: [], oppVoid: [], oppDeckCount: 0, oppGold: 3 };
    
    document.getElementById('game-view').classList.add('hidden');
    document.getElementById('vital-lobby-view').classList.add('hidden');
    document.getElementById('lobby-view').classList.remove('hidden');
    inspectEmpty();
    loadLocalDeck(); // Reset to custom deck if starter deck was selected
}

// --- FULL DECK MANAGER & FORGE FILTERS ---
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

function toggleSubtypeDropdown() {
    document.getElementById('subtype-dropdown-panel').classList.toggle('hidden');
}

let selectedFilterTypes = new Set();
function filterCollection() {
    const qName = document.getElementById('card-search-name').value.toLowerCase();
    const qDesc = document.getElementById('card-search-desc').value.toLowerCase();
    const cost = document.getElementById('filter-cost').value;
    const setFilter = document.getElementById('filter-set').value;
    const speed = document.getElementById('filter-speed').value;
    const sort = document.getElementById('sort-by').value;
    const grid = document.getElementById('collection-grid');
    grid.innerHTML = '';

    const panel = document.getElementById('subtype-dropdown-panel');
    if (panel.children.length === 0) {
        const availableTypes = new Set();
        const availableSubtypes = new Set();
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
                <button onclick="showCardDetails('${card.id}')" class="bg-stone-800 text-stone-300 hover:text-amber-400 px-1.5 py-0.5 rounded text-[10px] ml-1 shadow">剥</button>
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
    document.getElementById('cd-img').src = card.image || 'GoldBurnLogo (1).png';
    document.getElementById('cd-name').textContent = card.name;
    document.getElementById('cd-stats').textContent = `Cost: ${card.cost||0} | HP: ${card.hp||'-'} | Set: ${card.set||'Core'} | ${card.type} - ${card.subtypes ? card.subtypes.join(', ') : ''}`;
    document.getElementById('cd-desc').textContent = card.description || 'No description available.';
    document.getElementById('card-details-modal').classList.remove('hidden');
}
function closeCardDetails(e) {
    if(e && e.target.id === 'card-details-modal') document.getElementById('card-details-modal').classList.add('hidden');
}

function addCardToDeck(id) {
    const card = MASTER_CARDS.find(c => c.id === id);
    if (card.type === 'Vital') {
        playerState.currentVital = id;
    } else {
        const count = playerState.currentDeck[id] || 0;
        if (count >= (card.limit || 3)) return alert(`Limit ${card.limit||3} per card.`);
        
        let total = 0;
        for (let amt of Object.values(playerState.currentDeck)) total += amt;
        if (total >= 30) return alert("Main deck limit 30 reached.");
        
        playerState.currentDeck[id] = count + 1;
    }
    renderDeckList();
    saveLocalDeck();
}

function removeCardFromDeck(id) {
    if(playerState.currentDeck[id]) {
        playerState.currentDeck[id]--;
        if(playerState.currentDeck[id] <= 0) delete playerState.currentDeck[id];
        renderDeckList();
        saveLocalDeck();
    }
}

function removeVitalCard() {
    playerState.currentVital = null;
    renderDeckList();
    saveLocalDeck();
}

function renderDeckList() {
    const list = document.getElementById('deck-list');
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
        total += count;
        const el = document.createElement('div');
        el.className = "flex justify-between items-center text-xs border-b border-stone-800 py-1.5";
        el.innerHTML = `<span class="text-stone-300 font-bold">${c.name} <span class="text-amber-500">x${count}</span></span> <button onclick="removeCardFromDeck('${id}')" class="text-red-500 hover:text-red-400 font-bold bg-stone-900 px-2 rounded border border-stone-700">X</button>`;
        list.appendChild(el);
    }
    document.getElementById('deck-count').textContent = `${total} / 30`;
    document.getElementById('deck-name-input').value = playerState.activeDeckName;

    const saved = document.getElementById('saved-decks-select');
    saved.innerHTML = `<option value="">-- Load Saved Deck --</option>`;
    for (const d of Object.keys(playerState.customDecks)) {
        saved.innerHTML += `<option value="${d}" ${playerState.activeDeckName === d ? 'selected' : ''}>${d}</option>`;
    }
}

function saveCurrentDeck() {
    const name = document.getElementById('deck-name-input').value.trim() || "Custom Deck";
    playerState.customDecks[name] = {...playerState.currentDeck};
    playerState.activeDeckName = name;
    saveLocalDeck();
    renderDeckList();
    alert("Deck Saved locally!");
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
    if (name) {
        delete playerState.customDecks[name];
        renderDeckList(); saveLocalDeck();
    }
}

function exportDeckCode() { prompt("Deck Code:", btoa(JSON.stringify({v: playerState.currentVital, m: playerState.currentDeck}))); }
function importDeckCode() {
    try {
        const c = JSON.parse(atob(prompt("Paste Code:")));
        if (c.m) playerState.currentDeck = c.m;
        if (c.v) playerState.currentVital = c.v;
        renderDeckList(); saveLocalDeck();
    } catch(e) { alert("Invalid Code"); }
}

function equipStarterDeck() {
    const val = document.getElementById('equip-starter-select').value;
    if (val && STARTER_DECKS[val]) {
        const isOwned = !playerState.uid ? (val === "Bandits Arrival Starter") : playerState.unlockedCards.includes(val);
        if(!isOwned) return alert("You must buy this deck in the Store first!");

        playerState.currentDeck = {};
        for (const [id, count] of Object.entries(STARTER_DECKS[val])) {
            const card = MASTER_CARDS.find(c => c.id === id);
            if (card.type === 'Vital') playerState.currentVital = id;
            else playerState.currentDeck[id] = count;
        }
        playerState.activeDeckName = val;
        saveLocalDeck(); renderDeckList();
        alert(`Equipped ${val}`);
    }
}

function buyStoreItem(key, cost) {
    sendToServer({ type: "STORE_PURCHASE", uid: playerState.uid, itemKey: key, cost });
}

function renderStoreAndInventory() {
    const store = document.getElementById('store-items-container');
    const inv = document.getElementById('inventory-list');
    store.innerHTML = ''; inv.innerHTML = '';

    STORE_ITEMS.forEach(i => {
        if (!playerState.unlockedCards.includes(i.key)) {
            const el = document.createElement('div');
            el.className = "bg-stone-900 border border-stone-800 p-4 rounded shadow-lg flex flex-col justify-between";
            el.innerHTML = `<div><h3 class="text-amber-400 font-bold text-lg mb-1">${i.name}</h3><p class="text-stone-400 text-xs mb-3">${i.desc}</p></div><button onclick="buyStoreItem('${i.key}', ${i.cost})" class="w-full bg-amber-600 hover:bg-amber-500 text-stone-950 font-bold py-2 rounded transition shadow">Buy (${i.cost}G)</button>`;
            store.appendChild(el);
        }
    });
    
    function resetQueueButtons() {
        const displayNames = { quickplay: 'Quickplay', ranked: 'Ranked', starters: 'Starter Decks' };
        ['quickplay', 'ranked', 'starters'].forEach(m => {
            const b = document.getElementById(`q-${m}`);
            if(b) { 
                b.textContent = `Play ${displayNames[m]}`; 
                b.classList.replace('bg-red-700', 'bg-amber-600'); 
            }
        });
        activeQueueMode = null;
    }
    
    if (playerState.unlockedCards.length === 0) inv.innerHTML = `<p class="text-xs text-stone-500 col-span-full">No items unlocked yet.</p>`;
    playerState.unlockedCards.forEach(item => {
        const el = document.createElement('div');
        el.className = "bg-stone-950 border border-amber-500/50 p-3 rounded text-center text-xs font-bold text-amber-400 shadow flex flex-col justify-center items-center";
        el.innerHTML = `<div class="text-stone-500 text-[10px] mb-1">UNLOCKED</div><div>${item}</div>`;
        inv.appendChild(el);
    });
}

function updateUI() { document.getElementById('account-gold-display').textContent = playerState.accountGold; }
window.onload = () => { loadLocalDeck(); filterCollection(); renderDeckList(); renderStoreAndInventory(); };

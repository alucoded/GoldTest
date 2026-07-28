const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const serviceAccount = require('./serviceAccountKey.json');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
console.log("-----------------------------------------");
console.log("[SYSTEM] Firebase Admin Initialized Successfully.");

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
const clients = new Map();
const activeMatches = new Map();
const queues = { quickplay: [], ranked: [], starters: [], arena: [] };

async function initializeNewPlayer(uid, email, displayName) {
    const userRef = db.collection('players').doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) {
        console.log(`[DB] Creating new player profile for UID: ${uid}`);
        const newProfile = {
            email, displayName: displayName || "New Player",
            accountGold: 10, rankXP: 20, rankTitle: "Copper",
            unlockedCards: [], matchHistory: [], createdAt: FieldValue.serverTimestamp()
        };
        await userRef.set(newProfile);
        return newProfile;
    }
    return doc.data();
}

function generateRoomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

wss.on('connection', (ws) => {
    let clientUid = null;
    let clientName = "Guest";
    console.log(`[NETWORK] New client connected. Total clients: ${clients.size + 1}`);

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        if (data.type === "AUTH") {
            clientUid = data.uid;
            clientName = data.displayName || "Unknown User";
            console.log(`[AUTH] User authenticated: ${clientName} (${clientUid})`);
            const profile = await initializeNewPlayer(data.uid, data.email, data.displayName);
            clients.set(ws, { uid: data.uid, profile, ws });
            ws.send(JSON.stringify({ type: "PROFILE_LOADED", profile }));
        }

        if (data.type === "JOIN_QUEUE") {
            const mode = data.mode;
            if (queues[mode]) {
                // Remove from any other queues first
                Object.values(queues).forEach(q => {
                    const idx = q.findIndex(c => c.ws === ws);
                    if (idx !== -1) q.splice(idx, 1);
                });
                queues[mode].push({ ws, uid: clientUid, profile: clients.get(ws)?.profile });
                console.log(`[QUEUE] ${clientName} joined '${mode}' queue. Players in queue: ${queues[mode].length}`);
                checkMatchmaking(mode);
            }
        }

        if (data.type === "CANCEL_QUEUE") {
            Object.values(queues).forEach(q => {
                const idx = q.findIndex(c => c.ws === ws);
                if (idx !== -1) {
                    q.splice(idx, 1);
                    console.log(`[QUEUE] ${clientName} left the queue.`);
                }
            });
        }

        if (data.type === "START_CUSTOM") {
            const roomCode = data.roomCode || generateRoomCode();
            const matchId = 'custom_' + roomCode;
            
            if (!activeMatches.has(matchId)) {
                console.log(`[CUSTOM] ${clientName} created a new custom room. Room Code: ${roomCode}`);
                activeMatches.set(matchId, { matchId, mode: 'custom', players: [ws], roomCode, lockedVitals: 0 });
                ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode: 'custom' }));
            } else {
                const match = activeMatches.get(matchId);
                if (match.players.length < 2) {
                    console.log(`[CUSTOM] ${clientName} joined custom room: ${roomCode}`);
                    match.players.push(ws);
                    ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode: 'custom' }));
                    match.players.forEach(p => p.send(JSON.stringify({ type: "OPPONENT_JOINED" })));
                } else {
                    console.log(`[CUSTOM] ${clientName} tried to join ${roomCode}, but it was full.`);
                    ws.send(JSON.stringify({ type: "ERROR", message: "Room is full!" }));
                }
            }
        }

        if (data.type === "VITAL_LOCKED") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.lockedVitals++;
                console.log(`[MATCH] A player locked their vital in room ${match.roomCode}. Locked vitals: ${match.lockedVitals}/${match.players.length}`);
                
                // Once both players lock in, start the game and assign starting gold
                if (match.lockedVitals >= 2 || match.players.length === 1) {
                    console.log(`[MATCH] Both vitals locked in room ${match.roomCode}. Starting match!`);
                    match.players.forEach(p => {
                        const isPlayerOne = (p === match.p1);
                        p.send(JSON.stringify({ 
                            type: "START_GAME", 
                            startingGold: isPlayerOne ? 3 : 0, 
                            isPlayerOne: isPlayerOne 
                        }));
                    });
                }
            }
        }

        // Gameplay sync actions (silenced logs to prevent spam, but left active)
        if (data.type === "SYNC_STATE") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.players.forEach(p => {
                    if (p !== ws && p.readyState === WebSocket.OPEN) p.send(JSON.stringify({ type: "SYNC_STATE", payload: data.payload }));
                });
            }
        }

        if (data.type === "GAME_ACTION") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.players.forEach(p => {
                    if (p !== ws && p.readyState === WebSocket.OPEN) p.send(JSON.stringify({ type: "GAME_ACTION", action: data.action, payload: data.payload }));
                });
            }
        }

        if (data.type === "CHAT") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.players.forEach(p => {
                    if (p !== ws && p.readyState === WebSocket.OPEN) p.send(JSON.stringify(data));
                });
            }
        }

        if (data.type === "GAME_OVER") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                console.log(`[MATCH] Match ${match.roomCode} has ended.`);
                match.players.forEach(async p => {
                    if (p.readyState === WebSocket.OPEN) {
                        const isWinner = (p !== ws);
                        p.send(JSON.stringify({ type: "MATCH_END", isWinner }));
                        
                        // Winner gets EXACTLY 3 gold
                        if (isWinner) {
                            const pData = clients.get(p);
                            if (pData && pData.uid) {
                                console.log(`[ECONOMY] Awarding 3 Account Gold to winner: ${pData.profile.displayName}`);
                                pData.profile.accountGold += 3;
                                await db.collection('players').doc(pData.uid).update({ accountGold: pData.profile.accountGold });
                                p.send(JSON.stringify({ type: "PROFILE_LOADED", profile: pData.profile }));
                            } else if (pData && !pData.uid) {
                                pData.profile.accountGold += 3;
                                p.send(JSON.stringify({ type: "PROFILE_LOADED", profile: pData.profile }));
                            }
                        }
                    }
                });
                activeMatches.delete(data.matchId);
            }
        }

        if (data.type === "STORE_PURCHASE") {
            let profile = clients.get(ws)?.profile || { accountGold: 10, unlockedCards: [] };
            if (data.uid) {
                const userRef = db.collection('players').doc(data.uid);
                const doc = await userRef.get();
                if (doc.exists) profile = doc.data();
            }

            if (profile.accountGold >= data.cost) {
                console.log(`[STORE] ${clientName} purchased ${data.itemKey} for ${data.cost}G.`);
                profile.accountGold -= data.cost;
                if (!profile.unlockedCards.includes(data.itemKey)) profile.unlockedCards.push(data.itemKey);
                
                if (data.uid) {
                    await db.collection('players').doc(data.uid).update({ accountGold: profile.accountGold, unlockedCards: profile.unlockedCards });
                } else {
                    clients.set(ws, { uid: null, profile, ws }); 
                }
                ws.send(JSON.stringify({ type: "PROFILE_LOADED", profile }));
            } else {
                ws.send(JSON.stringify({ type: "ERROR", message: "Not enough account gold!" }));
            }
        }
    });

    ws.on('close', () => {
        console.log(`[NETWORK] Client disconnected: ${clientName}`);
        clients.delete(ws);
        Object.values(queues).forEach(q => {
            const idx = q.findIndex(c => c.ws === ws);
            if (idx !== -1) q.splice(idx, 1);
        });
    });
});

function checkMatchmaking(mode) {
    if (mode === 'quickplay' || mode === 'starters') {
        while (queues[mode].length >= 2) {
            const p1 = queues[mode].shift();
            const p2 = queues[mode].shift();
            const roomCode = generateRoomCode();
            const matchId = 'match_' + roomCode;
            
            console.log(`[MATCHMAKING] Success! Matched two players in '${mode}'. Room Code: ${roomCode}`);

            // Note: We now save p1 and p2 in the match state to track turn order
            activeMatches.set(matchId, { matchId, mode, players: [p1.ws, p2.ws], roomCode, lockedVitals: 0, p1: p1.ws, p2: p2.ws });

            [p1, p2].forEach(p => {
                if (p.ws.readyState === WebSocket.OPEN) {
                    p.ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode }));
                    p.ws.send(JSON.stringify({ type: "OPPONENT_JOINED" }));
                }
            });
        }
    }
}

console.log("[SYSTEM] Goldburn Server v2.0 running on ws://localhost:8080");
console.log("-----------------------------------------");

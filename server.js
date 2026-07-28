const WebSocket = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const serviceAccount = require('./serviceAccountKey.json');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
console.log("Firebase Admin Initialized Successfully.");

const wss = new WebSocket.Server({ port: 8080 });
const clients = new Map();
const activeMatches = new Map();
const queues = { quickplay: [], ranked: [], starters: [], arena: [] };

async function initializeNewPlayer(uid, email, displayName) {
    const userRef = db.collection('players').doc(uid);
    const doc = await userRef.get();
    if (!doc.exists) {
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

    ws.on('message', async (message) => {
        const data = JSON.parse(message);

        if (data.type === "AUTH") {
            clientUid = data.uid;
            const profile = await initializeNewPlayer(data.uid, data.email, data.displayName);
            clients.set(ws, { uid: data.uid, profile, ws });
            ws.send(JSON.stringify({ type: "PROFILE_LOADED", profile }));
        }

        if (data.type === "JOIN_QUEUE") {
            const mode = data.mode;
            if (queues[mode]) {
                Object.values(queues).forEach(q => {
                    const idx = q.findIndex(c => c.ws === ws);
                    if (idx !== -1) q.splice(idx, 1);
                });
                queues[mode].push({ ws, uid: clientUid, profile: clients.get(ws)?.profile });
                checkMatchmaking(mode);
            }
        }

        if (data.type === "CANCEL_QUEUE") {
            Object.values(queues).forEach(q => {
                const idx = q.findIndex(c => c.ws === ws);
                if (idx !== -1) q.splice(idx, 1);
            });
        }

        if (data.type === "START_CUSTOM") {
            const roomCode = data.roomCode || generateRoomCode();
            const matchId = 'custom_' + roomCode;
            
            if (!activeMatches.has(matchId)) {
                activeMatches.set(matchId, { matchId, mode: 'custom', players: [ws], roomCode, lockedVitals: 0 });
                ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode: 'custom' }));
            } else {
                const match = activeMatches.get(matchId);
                if (match.players.length < 2) {
                    match.players.push(ws);
                    ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode: 'custom' }));
                    match.players.forEach(p => p.send(JSON.stringify({ type: "OPPONENT_JOINED" })));
                } else {
                    ws.send(JSON.stringify({ type: "ERROR", message: "Room is full!" }));
                }
            }
        }

        if (data.type === "VITAL_LOCKED") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.lockedVitals++;
                if (match.lockedVitals >= 2 || match.players.length === 1) {
                    match.players.forEach(p => p.send(JSON.stringify({ type: "START_GAME" })));
                }
            }
        }

        if (data.type === "SYNC_STATE") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.players.forEach(p => {
                    if (p !== ws && p.readyState === WebSocket.OPEN) {
                        p.send(JSON.stringify({ type: "SYNC_STATE", payload: data.payload }));
                    }
                });
            }
        }

        if (data.type === "GAME_ACTION") {
            const match = activeMatches.get(data.matchId);
            if (match) {
                match.players.forEach(p => {
                    if (p !== ws && p.readyState === WebSocket.OPEN) {
                        p.send(JSON.stringify({ type: "GAME_ACTION", action: data.action, payload: data.payload }));
                    }
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
                match.players.forEach(async p => {
                    if (p.readyState === WebSocket.OPEN) {
                        const isWinner = (p !== ws);
                        p.send(JSON.stringify({ type: "MATCH_END", isWinner }));
                        
                        // Winner gets EXACTLY 3 gold
                        if (isWinner) {
                            const pData = clients.get(p);
                            if (pData && pData.uid) {
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
            activeMatches.set(matchId, { matchId, mode, players: [p1.ws, p2.ws], roomCode, lockedVitals: 0 });

            [p1, p2].forEach(p => {
                if (p.ws.readyState === WebSocket.OPEN) {
                    p.ws.send(JSON.stringify({ type: "MATCH_FOUND", matchId, roomCode, mode }));
                    p.ws.send(JSON.stringify({ type: "OPPONENT_JOINED" }));
                }
            });
        }
    }
}

console.log("Goldburn Server v2.0 running on ws://localhost:8080");
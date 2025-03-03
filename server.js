const path = require('path');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder').pathfinder;
const Movements = require('mineflayer-pathfinder').Movements;
const { GoalNear } = require('mineflayer-pathfinder').goals;

let bots = {};

app.use(express.static(path.join(__dirname, 'public')));
console.log('Chemin du dossier public:', path.join(__dirname, 'public'));

// Configuration WebSocket modifiée
io.on('connection', (socket) => {
    console.log('Client connecté');

    socket.on('createBot', (config) => {
        const bot = createBot(socket, config);
        // Envoi de la liste des bots mis à jour
        socket.emit('botList', Object.keys(bots));
    });

        // Modifier la section de gestion des commandes dans server.js
    socket.on('command', (data) => {
        const command = data.command.toLowerCase().split(' ');
        const action = command[0];
        
        Object.values(bots).forEach(botEntry => {
            if (botEntry.ready && botEntry.instance && 
            (data.bot === 'all' || botEntry.username === data.bot)) {
                
                const bot = botEntry.instance;
                
                try {
                    switch(action) {
                        case '!blockbreak':
                            handleBlockBreaking(botEntry, command[1]);
                            break;
                        case '!random':
                            handleRandomMode(botEntry, command[1]);
                            break;
                        case 'move': // Pour les déplacements
                            handleMoveCommand(bot, command.slice(1));
                            break;
                        default: // Pour toutes les autres commandes
                            bot.chat(data.command);
                            break;
                    }
                } catch (err) {
                    console.error(err);
                    socket.emit('log', {
                        type: 'error',
                        bot: bot.username,
                        message: err.message
                    });
                }
            }
        });
    });

    socket.on('disconnect', () => {
        // Nettoyage des bots
        Object.values(bots).forEach(bot => {
            if(bot.socketId === socket.id) bot.instance.quit();
        });
    });
});

// server.js (version corrigée)
function createBot(socket, config) {
    const bot = mineflayer.createBot({
        host: config.host,
        port: config.port,
        username: config.username,
        version: config.version
    });

    bot.loadPlugin(pathfinder);
    disableAutoDigging(bot);

    // Initialisation correcte de l'objet bot
    // Ajouter dans la configuration du bot
    const botEntry = {
        instance: bot,
        ready: false,
        socketId: socket.id,
        socket: socket,
        randomMode: false,
        blockBreaking: true, // Nouvelle propriété
        randomInterval: null
    };

    // Utilisation d'un ID unique pour éviter les conflits
    const botId = `${config.username}_${Date.now()}`;
    bots[botId] = botEntry;

    bot.on('login', () => {
        console.log('Login event - Bot ID:', botId, 'Username:', bot.username);
        console.log('Current bots state:', Object.keys(bots));
        if (!bots[botId]) return; // Sécurité anti-crash
        
        // Mise à jour atomique de l'état
        bots[botId] = {
            ...bots[botId],
            ready: true,
            username: bot.username // Stockage du username final
        };
        
        io.emit('botList', Object.values(bots).map(b => b.username));
    });

    bot.on('error', err => {
        botEntry.socket.emit('log', { // Utiliser le socket stocké
            type: 'error',
            bot: bot.username,
            message: err.message
        });
    });

    // Initialiser les mouvements
    let movements = null;
    bot.once('spawn', () => {
        movements = new Movements(bot);
        bot.pathfinder.setMovements(movements);
    });

    // Gestion des commandes de mouvement
    bot.on('path_update', (r) => {
        if (r.status === 'arrived') {
            socket.emit('log', {
                type: 'system',
                bot: bot.username,
                message: '✔️ Déplacement terminé'
            });
        }
    });

    bot.on('end', () => {
        stopRandomMovement(botEntry);
        delete bots[botId]; // Utilisez botId au lieu de username
        io.emit('botList', Object.values(bots).map(b => b.username));
    });

    // Écoute des messages du chat améliorée
    bot.on('message', (jsonMsg) => {
        const message = jsonMsg.toString();
        io.emit('log', { // Émission à TOUS les clients
            type: 'chat',
            bot: bot.username,
            message: message
        });
    });

    return bot;
}

function handleMoveCommand(bot, args) {
    const [direction, blocks] = args;
    const validDirections = ['gauche', 'droite', 'avant', 'arrière'];
    
    if (!validDirections.includes(direction) || isNaN(blocks)) {
        throw new Error('Commande invalide. Usage: move [gauche|droite|avant|arrière] [nombre]');
    }

    const currentPos = bot.entity.position;
    const yaw = bot.entity.yaw;
    const distance = parseInt(blocks);
    
    // Calcul de la position cible
    const target = calculateNewPosition(currentPos, yaw, direction, distance);
    
    bot.pathfinder.setGoal(new GoalNear(
        target.x, 
        target.y, 
        target.z, 
        1 // Tolérance en blocs
    ));
}

function calculateNewPosition(pos, yaw, direction, distance) {
    const radians = yaw + Math.PI;
    const cardinal = getCardinalDirection(radians);
    
    // Table de conversion direction/yaw
    const conversion = {
        nord: { gauche: 'ouest', droite: 'est', avant: 'nord', arrière: 'sud' },
        est: { gauche: 'nord', droite: 'sud', avant: 'est', arrière: 'ouest' },
        sud: { gauche: 'est', droite: 'ouest', avant: 'sud', arrière: 'nord' },
        ouest: { gauche: 'sud', droite: 'nord', avant: 'ouest', arrière: 'est' }
    };

    const realDirection = conversion[cardinal][direction];
    
    // Calcul des coordonnées
    switch(realDirection) {
        case 'nord': return { x: pos.x, y: pos.y, z: pos.z - distance };
        case 'sud': return { x: pos.x, y: pos.y, z: pos.z + distance };
        case 'est': return { x: pos.x + distance, y: pos.y, z: pos.z };
        case 'ouest': return { x: pos.x - distance, y: pos.y, z: pos.z };
    }
}

function getCardinalDirection(yaw) {
    const directions = ['nord', 'est', 'sud', 'ouest'];
    const index = Math.floor(((yaw + Math.PI) % (Math.PI * 2)) / (Math.PI/2));
    return directions[(index + 1) % 4];
}

function handleRandomMode(botEntry, state) {
    if (state === 'on') {
        if (!botEntry.randomMode) {
            botEntry.randomMode = true;
            startRandomMovement(botEntry);
        }
    } else {
        if (botEntry.randomMode) {
            botEntry.randomMode = false;
            stopRandomMovement(botEntry);
        }
    }
}

// Modifier la fonction startRandomMovement
function startRandomMovement(botEntry) {
    const bot = botEntry.instance;
    const socket = botEntry.socket; // Récupérer le socket stocké
    
    // Ajouter une vérification de sécurité
    if (!socket || !bot || !bot.entity) return;

    // Arrêter tout intervalle existant
    if (botEntry.randomInterval) clearInterval(botEntry.randomInterval);
    
    botEntry.randomInterval = setInterval(() => {
        try {
            if (!bot.pathfinder.isMoving()) {
                const currentPos = bot.entity.position.clone();
                const target = {
                    x: currentPos.x + Math.floor(Math.random() * 20 - 10),
                    z: currentPos.z + Math.floor(Math.random() * 20 - 10),
                    y: currentPos.y
                };
                
                // Émettre le log via le socket associé
                socket.emit('log', {
                    type: 'system',
                    bot: bot.username,
                    message: `🎲 Déplacement vers X:${target.x.toFixed(1)} Z:${target.z.toFixed(1)}`
                });
                
                bot.pathfinder.setGoal(new GoalNear(target.x, target.y, target.z, 2));
            }
        } catch (err) {
            console.error('Erreur déplacement aléatoire:', err);
            socket.emit('log', {
                type: 'error',
                bot: bot.username,
                message: `❌ Erreur déplacement: ${err.message}`
            });
        }
    }, 5000);
}

function stopRandomMovement(botEntry) {
    if (botEntry.randomInterval) {
        clearInterval(botEntry.randomInterval);
        botEntry.randomInterval = null;
        if (botEntry.instance.pathfinder) {
            botEntry.instance.pathfinder.stop();
        }
        botEntry.socket.emit('log', {
            type: 'system',
            bot: botEntry.username,
            message: '⏹️ Mode aléatoire désactivé'
        });
    }
}

function handleBlockBreaking(botEntry, state) {
    const bot = botEntry.instance;
    botEntry.blockBreaking = state === 'on';
    
    if(botEntry.blockBreaking) {
        // Réactiver le cassage normal
        bot.on('diggingCompleted', normalDigging);
    } else {
        // Désactiver le cassage
        bot.removeListener('diggingCompleted', normalDigging);
    }
}

function normalDigging() {
    // Comportement par défaut
}

function disableAutoDigging(bot) {
    bot.on('diggingAborted', () => {});
    bot.on('diggingCompleted', () => {});
    
    // Override de la méthode dig
    const originalDig = bot.dig;
    bot.dig = async (block, forceLook = true) => {
        if(!bot.blockBreaking) return false;
        return originalDig.call(bot, block, forceLook);
    };
}


http.listen(3000, () => console.log('Serveur écoute sur 3000'));
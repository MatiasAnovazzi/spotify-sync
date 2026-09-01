const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Configuración de Socket.IO optimizada para latencia ultra-baja
const io = new Server(server, {
  transports: ['websocket', 'polling'], // Priorizar WebSocket directo
  pingInterval: 10000,
  pingTimeout: 5000,
  perMessageDeflate: false, // Desactivar compresión para evitar buffering en mensajes pequeños
  httpCompression: false
});

app.use(express.static(path.join(__dirname, 'public')));

const roomUsers = {};
const roomQueues = {}; 
const roomPlaybackState = {}; // roomId -> { isPlaying, trackUri, trackInfo, positionMs, serverTimestamp }
const roomTransitionLock = {}; // Bloqueo para evitar múltiples triggers simultáneos

function emitRoomUsers(roomId) {
  const users = roomUsers[roomId] || [];
  io.to(roomId).emit('room_users_update', users);
}

function emitRoomQueue(roomId) {
  const queue = roomQueues[roomId] || [];
  io.to(roomId).emit('room_queue_update', queue);
}

function playNextInQueue(roomId, triggeredByUser = 'Sistema') {
  if (!roomQueues[roomId] || roomQueues[roomId].length === 0) return;

  // Evitar saltos duplicados si varios clientes reportan fin al mismo segundo
  if (roomTransitionLock[roomId]) return;
  roomTransitionLock[roomId] = true;
  setTimeout(() => { roomTransitionLock[roomId] = false; }, 2500);

  const nextTrack = roomQueues[roomId].shift();
  emitRoomQueue(roomId);

  const now = Date.now();
  const payload = {
    action: 'play',
    actionLabel: `reprodujo siguiente de la cola: 🎵 <b>${nextTrack.name}</b>`,
    trackUri: nextTrack.uri,
    trackInfo: {
      name: nextTrack.name,
      artist: nextTrack.artist,
      image: nextTrack.image,
      duration_ms: nextTrack.duration_ms
    },
    positionMs: 0,
    serverTimestamp: now,
    user: triggeredByUser,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  roomPlaybackState[roomId] = {
    action: 'play',
    isPlaying: true,
    trackUri: nextTrack.uri,
    trackInfo: payload.trackInfo,
    positionMs: 0,
    serverTimestamp: now
  };

  io.to(roomId).emit('apply_action', payload);
  io.to(roomId).emit('log_action', payload);
}

io.on('connection', (socket) => {
  // Sincronización de reloj estilo NTP ultra-rápida
  socket.on('sync_ping', (clientTime) => {
    socket.emit('sync_pong', {
      clientTime,
      serverTime: Date.now()
    });
  });

  socket.on('join_room', ({ roomId, profile }) => {
    socket.join(roomId);
    socket.roomId = roomId;

    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    if (!roomQueues[roomId]) roomQueues[roomId] = [];

    const isFirstUser = roomUsers[roomId].length === 0;

    socket.userData = {
      socketId: socket.id,
      name: profile.name || 'Usuario',
      username: profile.username || 'usuario',
      image: profile.image || 'https://cdn-icons-png.flaticon.com/512/847/847969.png',
      country: profile.country || '--',
      product: profile.product || 'free',
      followers: profile.followers || 0,
      isHost: isFirstUser
    };

    roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);
    roomUsers[roomId].push(socket.userData);

    io.to(roomId).emit('user_joined', {
      user: socket.userData.name,
      isHost: socket.userData.isHost,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    emitRoomUsers(roomId);
    emitRoomQueue(roomId);

    // Si la sala ya tiene reproducción activa, sincronizar al nuevo usuario inmediatamente
    if (roomPlaybackState[roomId]) {
      const state = roomPlaybackState[roomId];
      let currentPosition = state.positionMs || 0;
      if (state.isPlaying) {
        currentPosition += (Date.now() - state.serverTimestamp);
        if (state.trackInfo && state.trackInfo.duration_ms) {
          currentPosition = Math.min(currentPosition, state.trackInfo.duration_ms);
        }
      }

      socket.emit('apply_action', {
        action: state.isPlaying ? 'play' : 'pause',
        actionLabel: 'Sincronización inicial con la sala',
        trackUri: state.trackUri,
        trackInfo: state.trackInfo,
        positionMs: Math.round(currentPosition),
        serverTimestamp: Date.now(),
        user: 'Sistema',
        isInitialSync: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  });

  // Solicitud manual o por deriva de resincronización de sala
  socket.on('request_sync', () => {
    const roomId = socket.roomId;
    if (roomId && roomPlaybackState[roomId]) {
      const state = roomPlaybackState[roomId];
      let currentPosition = state.positionMs || 0;
      if (state.isPlaying) {
        currentPosition += (Date.now() - state.serverTimestamp);
        if (state.trackInfo && state.trackInfo.duration_ms) {
          currentPosition = Math.min(currentPosition, state.trackInfo.duration_ms);
        }
      }

      socket.emit('apply_action', {
        action: state.isPlaying ? 'play' : 'pause',
        actionLabel: 'Resincronización de sala',
        trackUri: state.trackUri,
        trackInfo: state.trackInfo,
        positionMs: Math.round(currentPosition),
        serverTimestamp: Date.now(),
        user: 'Sistema',
        isInitialSync: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  });

  // Reacciones flotantes en vivo
  socket.on('send_reaction', (data) => {
    if (socket.roomId && socket.userData) {
      io.to(socket.roomId).emit('room_reaction', {
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        emoji: data.emoji || '🔥',
        user: socket.userData.name,
        avatar: socket.userData.image
      });
    }
  });

  // Indicador de escritura en chat
  socket.on('typing_start', () => {
    if (socket.roomId && socket.userData) {
      socket.to(socket.roomId).emit('user_typing_start', {
        userId: socket.id,
        userName: socket.userData.name
      });
    }
  });

  socket.on('typing_stop', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('user_typing_stop', {
        userId: socket.id
      });
    }
  });

  // Agregar canción a la cola
  socket.on('add_to_queue', (track) => {
    if (socket.roomId) {
      if (!roomQueues[socket.roomId]) roomQueues[socket.roomId] = [];

      const queueItem = {
        id: Date.now() + Math.random().toString(36).substr(2, 4),
        uri: track.uri,
        name: track.name,
        artist: track.artist,
        image: track.image,
        duration_ms: track.duration_ms,
        addedBy: socket.userData ? socket.userData.name : 'Alguien',
        upvotes: 0,
        upvotedBy: []
      };

      roomQueues[socket.roomId].push(queueItem);
      emitRoomQueue(socket.roomId);

      io.to(socket.roomId).emit('log_action', {
        user: socket.userData ? socket.userData.name : 'Alguien',
        actionLabel: `añadió a la cola: 🎵 <b>${track.name}</b>`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  });

  // Votar por un tema en la cola (Upvote)
  socket.on('upvote_queue_item', (queueItemId) => {
    if (socket.roomId && roomQueues[socket.roomId]) {
      const item = roomQueues[socket.roomId].find(i => i.id === queueItemId);
      if (item) {
        if (!item.upvotes) item.upvotes = 0;
        if (!item.upvotedBy) item.upvotedBy = [];

        const userKey = socket.userData ? (socket.userData.username || socket.userData.name) : socket.id;
        if (!item.upvotedBy.includes(userKey)) {
          item.upvotedBy.push(userKey);
          item.upvotes += 1;
          // Ordenar temas por votos (manteniendo el que tenga más arriba)
          roomQueues[socket.roomId].sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
          emitRoomQueue(socket.roomId);
        }
      }
    }
  });

  // Vaciar toda la cola
  socket.on('clear_queue', () => {
    if (socket.roomId && roomQueues[socket.roomId]) {
      roomQueues[socket.roomId] = [];
      emitRoomQueue(socket.roomId);
      io.to(socket.roomId).emit('log_action', {
        user: socket.userData ? socket.userData.name : 'Alguien',
        actionLabel: 'vació la cola de reproducción',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  });

  // Auto-next: Notificación de canción terminada desde el cliente
  socket.on('track_ended', () => {
    if (socket.roomId) {
      playNextInQueue(socket.roomId, 'Cola Automática');
    }
  });

  // Reproducir un tema específico de la cola manualmente
  socket.on('play_from_queue', (queueItemId) => {
    if (socket.roomId && roomQueues[socket.roomId]) {
      const index = roomQueues[socket.roomId].findIndex(item => item.id === queueItemId);
      if (index !== -1) {
        const [selectedTrack] = roomQueues[socket.roomId].splice(index, 1);
        emitRoomQueue(socket.roomId);

        const now = Date.now();
        const payload = {
          action: 'play',
          actionLabel: `reprodujo desde la cola: 🎵 <b>${selectedTrack.name}</b>`,
          trackUri: selectedTrack.uri,
          trackInfo: {
            name: selectedTrack.name,
            artist: selectedTrack.artist,
            image: selectedTrack.image,
            duration_ms: selectedTrack.duration_ms
          },
          positionMs: 0,
          serverTimestamp: now,
          user: socket.userData ? socket.userData.name : 'Alguien',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        };

        roomPlaybackState[socket.roomId] = {
          action: 'play',
          isPlaying: true,
          trackUri: selectedTrack.uri,
          trackInfo: payload.trackInfo,
          positionMs: 0,
          serverTimestamp: now
        };

        io.to(socket.roomId).emit('apply_action', payload);
        io.to(socket.roomId).emit('log_action', payload);
      }
    }
  });

  // Quitar de la cola
  socket.on('remove_from_queue', (queueItemId) => {
    if (socket.roomId && roomQueues[socket.roomId]) {
      roomQueues[socket.roomId] = roomQueues[socket.roomId].filter(item => item.id !== queueItemId);
      emitRoomQueue(socket.roomId);
    }
  });

  // Chat
  socket.on('chat_message', (text) => {
    if (socket.roomId && socket.userData && text && text.trim().length > 0) {
      const msgData = {
        senderId: socket.id,
        user: socket.userData.name,
        username: socket.userData.username,
        avatar: socket.userData.image,
        isHost: socket.userData.isHost,
        text: text.trim(),
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      io.to(socket.roomId).emit('chat_broadcast', msgData);
    }
  });

  // Acciones multimedia del cliente
  socket.on('sync_action', (data) => {
    if (socket.roomId && socket.userData) {
      // Si aprietan botón "Siguiente" y hay cola, consumir la cola primero
      if (data.action === 'next' && roomQueues[socket.roomId] && roomQueues[socket.roomId].length > 0) {
        playNextInQueue(socket.roomId, socket.userData.name);
        return;
      }

      const now = Date.now();
      const payload = {
        ...data,
        serverTimestamp: now,
        user: socket.userData.name,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };

      // Actualizar estado de sala en el servidor
      if (data.action === 'play') {
        roomPlaybackState[socket.roomId] = {
          action: 'play',
          isPlaying: true,
          trackUri: data.trackUri || (roomPlaybackState[socket.roomId] && roomPlaybackState[socket.roomId].trackUri),
          trackInfo: data.trackInfo || (roomPlaybackState[socket.roomId] && roomPlaybackState[socket.roomId].trackInfo),
          positionMs: typeof data.positionMs === 'number' ? data.positionMs : 0,
          serverTimestamp: now
        };
      } else if (data.action === 'pause') {
        const currentPos = typeof data.positionMs === 'number' 
          ? data.positionMs 
          : (roomPlaybackState[socket.roomId] ? roomPlaybackState[socket.roomId].positionMs : 0);
        roomPlaybackState[socket.roomId] = {
          ...(roomPlaybackState[socket.roomId] || {}),
          action: 'pause',
          isPlaying: false,
          positionMs: currentPos,
          serverTimestamp: now
        };
      } else if (data.action === 'seek') {
        if (roomPlaybackState[socket.roomId]) {
          roomPlaybackState[socket.roomId].positionMs = typeof data.positionMs === 'number' ? data.positionMs : 0;
          roomPlaybackState[socket.roomId].serverTimestamp = now;
        }
      }
      
      socket.to(socket.roomId).emit('apply_action', payload);
      io.to(socket.roomId).emit('log_action', payload);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && roomUsers[roomId]) {
      const leavingUser = socket.userData;
      roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);

      // Si quien salió era el host y quedan usuarios, transferir rol de DJ
      if (leavingUser && leavingUser.isHost && roomUsers[roomId].length > 0) {
        roomUsers[roomId][0].isHost = true;
      }

      if (leavingUser) {
        io.to(roomId).emit('user_left', {
          user: leavingUser.name,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }

      emitRoomUsers(roomId);

      if (roomUsers[roomId].length === 0) {
        delete roomUsers[roomId];
        delete roomQueues[roomId];
        delete roomPlaybackState[roomId];
        delete roomTransitionLock[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
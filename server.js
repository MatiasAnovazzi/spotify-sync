const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const roomUsers = {};
const roomQueues = {}; 
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
  setTimeout(() => { roomTransitionLock[roomId] = false; }, 3000);

  const nextTrack = roomQueues[roomId].shift();
  emitRoomQueue(roomId);

  const payload = {
    action: 'play',
    actionLabel: `reprodujo siguiente de la cola: 🎵 <b>${nextTrack.name}</b>`,
    trackUri: nextTrack.uri,
    positionMs: 0,
    user: triggeredByUser,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };

  io.to(roomId).emit('apply_action', payload);
  io.to(roomId).emit('log_action', payload);
}

io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, profile }) => {
    socket.join(roomId);
    socket.roomId = roomId;

    socket.userData = {
      socketId: socket.id,
      name: profile.name || 'Usuario',
      username: profile.username || 'usuario',
      image: profile.image || 'https://cdn-icons-png.flaticon.com/512/847/847969.png',
      country: profile.country || '--',
      product: profile.product || 'free',
      followers: profile.followers || 0
    };

    if (!roomUsers[roomId]) roomUsers[roomId] = [];
    if (!roomQueues[roomId]) roomQueues[roomId] = [];

    roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);
    roomUsers[roomId].push(socket.userData);

    io.to(roomId).emit('user_joined', {
      user: socket.userData.name,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });

    emitRoomUsers(roomId);
    emitRoomQueue(roomId);
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
        addedBy: socket.userData ? socket.userData.name : 'Alguien'
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

        const payload = {
          action: 'play',
          actionLabel: `reprodujo desde la cola: 🎵 <b>${selectedTrack.name}</b>`,
          trackUri: selectedTrack.uri,
          positionMs: 0,
          user: socket.userData ? socket.userData.name : 'Alguien',
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

      const payload = {
        ...data,
        user: socket.userData.name,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
      
      socket.to(socket.roomId).emit('apply_action', payload);
      io.to(socket.roomId).emit('log_action', payload);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && roomUsers[roomId]) {
      roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);

      if (socket.userData) {
        io.to(roomId).emit('user_left', {
          user: socket.userData.name,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
      }

      emitRoomUsers(roomId);

      if (roomUsers[roomId].length === 0) {
        delete roomUsers[roomId];
        delete roomQueues[roomId];
        delete roomTransitionLock[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
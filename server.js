const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Estructura en memoria para almacenar usuarios por sala:
// { "codigoSala": [ { id, name, username, image, country, product, followers } ] }
const roomUsers = {};

function emitRoomUsers(roomId) {
  const users = roomUsers[roomId] || [];
  io.to(roomId).emit('room_users_update', users);
}

io.on('connection', (socket) => {
  // Unirse a una sala con los datos de perfil de Spotify
  socket.on('join_room', ({ roomId, profile }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    
    // Guardar datos del usuario
    socket.userData = {
      socketId: socket.id,
      name: profile.name || 'Usuario',
      username: profile.username || 'usuario',
      image: profile.image || 'https://via.placeholder.com/150',
      country: profile.country || '--',
      product: profile.product || 'free',
      followers: profile.followers || 0
    };

    if (!roomUsers[roomId]) {
      roomUsers[roomId] = [];
    }

    // Evitar duplicados si reconecta
    roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);
    roomUsers[roomId].push(socket.userData);

    console.log(`[${roomId}] ${socket.userData.name} (@${socket.userData.username}) conectado`);

    // Notificar log de ingreso
    io.to(roomId).emit('user_joined', {
      user: socket.userData.name,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });

    // Enviar la lista actualizada de usuarios a todos en la sala
    emitRoomUsers(roomId);
  });

  // Retransmitir acciones de reproducción
  socket.on('sync_action', (data) => {
    if (socket.roomId && socket.userData) {
      const payload = {
        ...data,
        user: socket.userData.name,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
      
      socket.to(socket.roomId).emit('apply_action', payload);
      io.to(socket.roomId).emit('log_action', payload);
    }
  });

  // Desconexión
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (roomId && roomUsers[roomId]) {
      roomUsers[roomId] = roomUsers[roomId].filter(u => u.socketId !== socket.id);

      if (socket.userData) {
        io.to(roomId).emit('user_left', {
          user: socket.userData.name,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        });
      }

      emitRoomUsers(roomId);

      if (roomUsers[roomId].length === 0) {
        delete roomUsers[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
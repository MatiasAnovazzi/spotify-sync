const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // Unirse a una sala con nombre de usuario
  socket.on('join_room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName || 'Usuario Anónimo';

    console.log(`[${socket.roomId}] ${socket.userName} conectado (${socket.id})`);

    // Notificar a todos en la sala que alguien entró
    io.to(socket.roomId).emit('user_joined', {
      user: socket.userName,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
  });

  // Retransmitir acciones de reproducción
  socket.on('sync_action', (data) => {
    if (socket.roomId) {
      const payload = {
        ...data,
        user: socket.userName || 'Alguien',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      };
      
      // Enviar a todos los demás en la sala
      socket.to(socket.roomId).emit('apply_action', payload);
      // Enviar el evento de log a TODOS (incluyendo el emisor)
      io.to(socket.roomId).emit('log_action', payload);
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId && socket.userName) {
      io.to(socket.roomId).emit('user_left', {
        user: socket.userName,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
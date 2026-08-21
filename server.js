const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos de la carpeta "public"
app.use(express.static(path.join(__dirname, 'public')));

// Gestión de conexiones WebSockets
io.on('connection', (socket) => {
  console.log(`Usuario conectado: ${socket.id}`);

  // Unirse a una sala
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    socket.roomId = roomId;
    console.log(`Socket ${socket.id} se unió a la sala: ${roomId}`);
  });

  // Retransmitir acciones de reproducción a todos los demás en la sala
  socket.on('sync_action', (data) => {
    if (socket.roomId) {
      // socket.to(roomId) envía a todos EN LA SALA excepto al remitente
      socket.to(socket.roomId).emit('apply_action', data);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Usuario desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
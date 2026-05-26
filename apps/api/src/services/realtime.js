let io;

// Track which hotelId each socket has joined (one socket = one hotel room)
const socketHotel = new Map(); // socketId → hotelId

function getSessionCount(hotelId) {
  // Count sockets in the hotel room
  const room = io?.sockets?.adapter?.rooms?.get(`hotel:${hotelId}`);
  return room ? room.size : 0;
}

function broadcastSessionCount(hotelId) {
  if (!io || !hotelId) return;
  const count = getSessionCount(hotelId);
  io.to(`hotel:${hotelId}`).emit("hotel:session_count", { count });
  console.log(`[Realtime] hotel ${hotelId} — ${count} active session(s)`);
}

export function attachRealtime(serverIo) {
  io = serverIo;
  io.on("connection", (socket) => {
    socket.on("hotel:join", (hotelId) => {
      if (!hotelId) return;
      const prev = socketHotel.get(socket.id);
      if (prev && prev !== hotelId) {
        socket.leave(`hotel:${prev}`);
        broadcastSessionCount(prev);
      }
      socket.join(`hotel:${hotelId}`);
      socketHotel.set(socket.id, hotelId);
      // Small delay so the join completes before we count
      setImmediate(() => broadcastSessionCount(hotelId));
    });

    // Guest app joins its own booking room to receive verification:requested events
    socket.on("guest:join", (bookingId) => {
      if (bookingId) socket.join(`booking:${bookingId}`);
    });

    socket.on("disconnect", () => {
      const hotelId = socketHotel.get(socket.id);
      socketHotel.delete(socket.id);
      if (hotelId) {
        setImmediate(() => broadcastSessionCount(hotelId));
      }
    });
  });
}

export function emitHotel(hotelId, event, payload) {
  if (io && hotelId) io.to(`hotel:${hotelId}`).emit(event, payload);
}

// Emit to the guest's booking-specific room
export function emitBooking(bookingId, event, payload) {
  if (io && bookingId) io.to(`booking:${bookingId}`).emit(event, payload);
}

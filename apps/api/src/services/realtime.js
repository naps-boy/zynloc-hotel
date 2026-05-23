let io;

export function attachRealtime(serverIo) {
  io = serverIo;
  io.on("connection", (socket) => {
    socket.on("hotel:join", (hotelId) => {
      if (hotelId) socket.join(`hotel:${hotelId}`);
    });
    // Guest app joins its own booking room to receive verification:requested events
    socket.on("guest:join", (bookingId) => {
      if (bookingId) socket.join(`booking:${bookingId}`);
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

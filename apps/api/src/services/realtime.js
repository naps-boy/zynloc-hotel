let io;

export function attachRealtime(serverIo) {
  io = serverIo;
  io.on("connection", (socket) => {
    socket.on("hotel:join", (hotelId) => {
      if (hotelId) socket.join(`hotel:${hotelId}`);
    });
  });
}

export function emitHotel(hotelId, event, payload) {
  if (io && hotelId) io.to(`hotel:${hotelId}`).emit(event, payload);
}

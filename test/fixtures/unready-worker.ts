// Fault injection: a live worker that never completes its startup handshake.
setInterval(() => {}, 1000);

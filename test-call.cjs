const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:18789");

ws.on("open", () => console.log(">> ws open"));

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  const okStr = msg.ok !== undefined ? " ok=" + msg.ok : "";
  console.log("<<", msg.type, msg.event || msg.method || msg.id || "", okStr);

  if (msg.type === "event" && msg.event === "connect.challenge") {
    ws.send(
      JSON.stringify({
        type: "req",
        id: "c1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "cli", version: "1.0.0", platform: "macos", mode: "backend" },
          role: "operator",
          scopes: [],
          auth: { token: process.env.OPENCLAW_GATEWAY_TOKEN },
        },
      }),
    );
  }

  if (msg.type === "res" && msg.id === "c1") {
    if (!msg.ok) {
      console.error("Auth failed:", JSON.stringify(msg.error));
      process.exit(1);
    }
    console.log(">> authenticated, initiating call");
    ws.send(
      JSON.stringify({
        type: "req",
        id: "call-1",
        method: "voicecall.initiate",
        params: {
          to: "+17032635792",
          message:
            "Hey Sean, this is a test call to check voice quality and consistency. How does this sound?",
          mode: "conversation",
        },
      }),
    );
  }

  if (msg.type === "res" && msg.id === "call-1") {
    console.log("Call result:", JSON.stringify(msg, null, 2));
    setTimeout(() => {
      ws.close();
      process.exit(0);
    }, 3000);
  }
});

ws.on("error", (err) => {
  console.error("err:", err.message);
  process.exit(1);
});
setTimeout(() => {
  console.log("Timeout");
  process.exit(1);
}, 20000);

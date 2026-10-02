(() => {
  let turn = 0, latestGen = 0, node, context, socket, clockOffset = null, bestRtt = Infinity;
  const values = {answer: "—", asr: "—", ttft: "—"};
  const labels = {
    answer: ["Answer playback (estimate)", "Last server-detected user speech → browser playback of KAME speech. Includes output network and playback buffering; excludes microphone upload delay. Negative means overlap."],
    asr: ["ASR final delay", "Last VAD-detected user speech → final transcript received. Includes endpoint silence, ASR queueing and transcription."],
    ttft: ["Oracle TTFT", "Request sent → first nonempty content token received, for the latest oracle generation in this turn."],
  };
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Turn latency measurements");
  panel.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:1000;background:black;color:white;border:1px solid white;padding:10px;font:13px monospace;max-width:calc(100vw - 24px)";
  const heading = document.createElement("div");
  heading.textContent = "Turn timings";
  panel.append(heading);
  const fields = {};
  for (const [key, [label, title]] of Object.entries(labels)) {
    const row = document.createElement("div");
    row.title = title;
    row.style.cssText = "display:flex;gap:16px;justify-content:space-between;margin-top:6px";
    const name = document.createElement("span");
    name.textContent = label;
    fields[key] = document.createElement("span");
    row.append(name, fields[key]);
    panel.append(row);
  }
  const render = () => {
    heading.textContent = turn ? `Turn ${turn} timings` : "Turn timings";
    for (const key of Object.keys(fields)) fields[key].textContent = values[key];
  };
  const format = seconds => `${seconds.toFixed(3)} s${seconds < 0 ? " (overlap)" : ""}`;
  const reset = () => {
    turn = 0;
    latestGen = 0;
    clockOffset = null;
    bestRtt = Infinity;
    for (const key of Object.keys(values)) values[key] = "—";
    render();
  };
  const sendLatency = data => {
    if (socket?.readyState === WebSocket.OPEN) {
      const payload = new TextEncoder().encode(JSON.stringify(data));
      socket.send(new Uint8Array([6, ...payload]));
    }
  };
  const ping = () => sendLatency({ping: performance.now() / 1000});
  let pendingPlayback = null;
  const showPlayback = data => {
    if (data.turn_id !== turn) return;
    if (clockOffset === null) {
      pendingPlayback = data;
      return;
    }
    const stamp = context.getOutputTimestamp?.();
    const playedAt = stamp?.performanceTime > 0
      ? stamp.performanceTime / 1000 + data.at - stamp.contextTime
      : performance.now() / 1000 + data.at - context.currentTime + (context.outputLatency || context.baseLatency || 0);
    const seconds = playedAt + clockOffset - data.ended_at;
    values.answer = format(seconds);
    sendLatency({type: "answer_playback", turn_id: data.turn_id, seconds});
    render();
  };

  // The downloaded UI creates its own WebSocket and AudioWorkletNode.
  const NativeSocket = window.WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (new URL(url, location.href).pathname !== "/api/chat") return;
      socket = this;
      reset();
      this.addEventListener("message", event => {
        if (!(event.data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(event.data);
        if (bytes[0] === 0) { reset(); pendingPlayback = null; ping(); return; }
        if (bytes[0] !== 6) return;
        event.stopImmediatePropagation(); // Metrics are separate from the existing audio/text protocol.
        const data = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
        if (data.type === "clock") {
          const now = performance.now() / 1000;
          const rtt = now - data.ping;
          if (rtt < bestRtt) {
            bestRtt = rtt;
            clockOffset = data.server_time - (data.ping + now) / 2;
          }
          if (pendingPlayback) { showPlayback(pendingPlayback); pendingPlayback = null; }
        } else if (data.type === "turn") {
          turn = data.turn_id;
          latestGen = 0;
          pendingPlayback = null;
          for (const key of Object.keys(values)) values[key] = "—";
        } else if (data.turn_id === turn) {
          if (data.type === "asr") values.asr = format(data.seconds);
          if (data.type === "ttft" && data.gen_id >= latestGen) {
            latestGen = data.gen_id;
            values.ttft = format(data.seconds);
          }
          if (data.type === "answer" && node) {
            node.port.postMessage({...data, type: "latency-marker"});
          }
        }
        render();
      });
      this.addEventListener("close", () => { pendingPlayback = null; });
    }
  };
  const NativeNode = window.AudioWorkletNode;
  window.AudioWorkletNode = class extends NativeNode {
    constructor(audioContext, name, options) {
      super(audioContext, name, options);
      if (name !== "moshi-processor") return;
      node = this;
      context = audioContext;
      this.port.addEventListener("message", event => {
        const data = event.data;
        if (data.type === "answer-played") { event.stopImmediatePropagation(); showPlayback(data); }
        if (data.type === "answer-dropped") {
          event.stopImmediatePropagation();
          if (data.turn_id === turn) {
            values.answer = "unavailable (audio skipped or expired)";
            sendLatency({type: "answer_playback", turn_id: data.turn_id, status: "unavailable"});
            render();
          }
        }
      });
      this.port.start();
    }
  };
  const addModule = AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule = function(url, options) {
    return addModule.call(this, /\/audio-processor-[^/]+\.js(?:\?|$)/.test(String(url))
      ? "/api/latency-worklet.js" : url, options);
  };
  setInterval(ping, 2000);
  document.addEventListener("DOMContentLoaded", () => {
    document.body.append(panel);
    render();
    new MutationObserver(() => {
      for (const cell of document.querySelectorAll("td")) {
        if (cell.textContent.trim() === "Latency:") cell.textContent = "Stream lag: ";
      }
    }).observe(document.getElementById("root"), {childList: true, subtree: true, characterData: true});
  });
})();

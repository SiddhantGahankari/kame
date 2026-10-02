// Run: node tests/test_latency_player.cjs [path/to/downloaded/audio-processor.js]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = path.join(__dirname, "../src/kame");
const wrapper = fs.readFileSync(path.join(source, "latency-worklet.js"), "utf8");
const original = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : `
class Player extends AudioWorkletProcessor {
  constructor() {
    super(); this.timeInStream = 0;
    this.port.onmessage = e => {
      if (e.data.type === 'reset') this.timeInStream = 0;
      if (e.data.dropTo) this.timeInStream = e.data.dropTo;
    };
  }
  process() { this.timeInStream += 0.02; return true; }
}
registerProcessor('moshi-processor', Player);`;
const makePlayer = instrumented => {
  let Player;
  const messages = [];
  const env = vm.createContext({
    sampleRate: 16000, currentFrame: 0, currentTime: 10,
    console: {log() {}},
    AudioWorkletProcessor: class {
      constructor() { this.port = {postMessage: data => messages.push(data)}; }
    },
    registerProcessor: (_name, cls) => { Player = cls; },
  });
  if (instrumented) vm.runInContext(wrapper, env);
  vm.runInContext(original, env);
  return {player: new Player(), env, messages};
};
const tracked = makePlayer(true), baseline = makePlayer(false);
if (process.argv[2]) {
  for (const test of [tracked, baseline]) {
    test.player.port.onmessage({data: {frame: new Float32Array(1600).fill(0.5), micDuration: 1}});
  }
}
tracked.player.port.onmessage({data: {type: "latency-marker", turn_id: 1, position: 0.025, ended_at: 9}});
for (let i = 0; i < 5; i++) {
  const audio = [];
  for (const test of [tracked, baseline]) {
    test.env.currentTime = 10 + i * 0.02;
    const outputs = [[new Float32Array(320)]];
    assert.equal(test.player.process([], outputs, {}), true);
    audio.push(Array.from(outputs[0][0]));
  }
  assert.deepEqual(audio[0], audio[1]); // Instrumentation must preserve playback exactly.
}
const played = tracked.messages.find(message => message.type === "answer-played");
assert.equal(played.turn_id, 1);
assert.ok(played.at >= 10.025 && played.at <= 10.065);
tracked.player.port.onmessage({data: {type: "latency-marker", turn_id: 2, position: 0.01, ended_at: 9}});
assert.equal(tracked.messages.at(-1).type, "answer-played"); // Late markers use playback history.
tracked.player.port.onmessage({data: {type: "latency-marker", turn_id: 3, position: 2, ended_at: 9}});
tracked.player.port.onmessage({data: {type: "reset"}});
assert.equal(tracked.player.latencyHistory.length, 0);
assert.equal(tracked.player.latencyMarkers.length, 0);
tracked.player.timeInStream = 1; // Position skipped by the player rather than played.
tracked.player.port.onmessage({data: {type: "latency-marker", turn_id: 4, position: 0.5, ended_at: 9}});
assert.equal(tracked.messages.at(-1).type, "answer-dropped");

class Element {
  constructor() { this.children = []; this.style = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
}
class Target {
  constructor() { this.listeners = {}; }
  addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
  dispatch(name, data) {
    const event = {data, stopped: false, stopImmediatePropagation() { this.stopped = true; }};
    for (const listener of this.listeners[name] || []) { listener(event); if (event.stopped) break; }
    return event;
  }
}
class Socket extends Target { static OPEN = 1; readyState = 1; send(data) { (this.sent ??= []).push(data); } }
class Port extends Target { start() {} postMessage(data) { this.sent = data; } }
class AudioNode { constructor() { this.port = new Port(); } }
class Worklet { addModule(url) { this.url = url; } }
const body = new Element(), cell = new Element();
cell.textContent = "Latency: ";
let load, mutation, now = 10.2;
const browser = vm.createContext({
  ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, URL,
  WebSocket: Socket, AudioWorkletNode: AudioNode, AudioWorklet: Worklet,
  performance: {now: () => now * 1000}, location: {href: "http://localhost/"},
  setInterval() {},
  document: {
    createElement: () => new Element(), body,
    addEventListener: (_name, fn) => { load = fn; },
    querySelectorAll: () => [cell], getElementById: () => new Element(),
  },
  MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
});
browser.window = browser;
vm.runInContext(fs.readFileSync(path.join(source, "latency-dashboard.js"), "utf8"), browser);
load(); mutation();
assert.equal(cell.textContent, "Stream lag: ");
const socket = new browser.WebSocket("ws://localhost/api/chat");
const audioContext = {getOutputTimestamp: () => ({performanceTime: 11000, contextTime: 4})};
const node = new browser.AudioWorkletNode(audioContext, "moshi-processor");
const sendMetric = data => socket.dispatch("message", new Uint8Array([6, ...new TextEncoder().encode(JSON.stringify(data))]).buffer);
sendMetric({type: "clock", ping: 10, server_time: 100});
sendMetric({type: "turn", turn_id: 1});
sendMetric({type: "ttft", turn_id: 1, gen_id: 2, seconds: 0.08});
sendMetric({type: "ttft", turn_id: 1, gen_id: 1, seconds: 0.3});
sendMetric({type: "asr", turn_id: 1, seconds: 0.7});
assert.equal(sendMetric({type: "answer", turn_id: 1, ended_at: 100, position: 0.025}).stopped, true);
assert.equal(node.port.sent.type, "latency-marker");
assert.equal(node.port.dispatch("message", {type: "answer-played", turn_id: 1, ended_at: 100, at: 5}).stopped, true);
const panel = body.children[0];
assert.equal(panel.children[1].children[1].textContent, "1.900 s");
const playbackReport = JSON.parse(new TextDecoder().decode(socket.sent.at(-1).subarray(1)));
assert.equal(playbackReport.type, "answer_playback");
assert.equal(playbackReport.turn_id, 1);
assert.ok(Math.abs(playbackReport.seconds - 1.9) < 1e-10);
assert.equal(panel.children[2].children[1].textContent, "0.700 s");
assert.equal(panel.children[3].children[1].textContent, "0.080 s");
node.port.dispatch("message", {type: "answer-played", turn_id: 1, ended_at: 102, at: 5});
assert.equal(panel.children[1].children[1].textContent, "-0.100 s (overlap)");
sendMetric({type: "turn", turn_id: 2});
assert.equal(panel.children[1].children[1].textContent, "—");
const reportsBeforeStaleMarker = socket.sent.length;
node.port.dispatch("message", {type: "answer-played", turn_id: 1, ended_at: 100, at: 5});
assert.equal(panel.children[1].children[1].textContent, "—");
assert.equal(socket.sent.length, reportsBeforeStaleMarker);
node.port.dispatch("message", {type: "answer-dropped", turn_id: 2});
assert.equal(JSON.parse(new TextDecoder().decode(socket.sent.at(-1).subarray(1))).status, "unavailable");
const worklet = new browser.AudioWorklet();
worklet.addModule("/assets/audio-processor-example.js");
assert.equal(worklet.url, "/api/latency-worklet.js");
console.log("Latency player and dashboard checks passed");

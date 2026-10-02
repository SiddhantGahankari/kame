// Instrument the existing Moshi player without changing its buffering or audio.
(() => {
  const register = globalThis.registerProcessor;
  globalThis.registerProcessor = (name, Processor) => {
    if (name !== "moshi-processor") return register(name, Processor);
    register(name, class extends Processor {
      constructor(options) {
        super(options);
        this.latencyHistory = [];
        this.latencyMarkers = [];
        const receive = this.port.onmessage;
        this.port.onmessage = event => {
          if (event.data.type === "latency-marker") {
            this.latencyMarkers.push(event.data);
            this.reportMarkers();
            return;
          }
          if (event.data.type === "reset") {
            this.latencyHistory = [];
            this.latencyMarkers = [];
          }
          receive(event);
          this.reportMarkers(); // Packet dropping can skip a pending marker.
        };
      }

      reportMarkers() {
        this.latencyMarkers = this.latencyMarkers.filter(marker => {
          const segment = this.latencyHistory.find(
            item => item.start <= marker.position && marker.position < item.end
          );
          if (segment) {
            this.port.postMessage({
              type: "answer-played", turn_id: marker.turn_id, ended_at: marker.ended_at,
              at: segment.at + marker.position - segment.start,
            });
            return false;
          }
          if (marker.position < this.timeInStream) {
            this.port.postMessage({type: "answer-dropped", turn_id: marker.turn_id});
            return false;
          }
          return true;
        });
      }

      process(inputs, outputs, parameters) {
        const start = this.timeInStream;
        const result = super.process(inputs, outputs, parameters);
        if (this.timeInStream > start) {
          const previous = this.latencyHistory.at(-1);
          if (previous && previous.end === start && Math.abs(previous.at + start - previous.start - currentTime) <= 1 / sampleRate) {
            previous.end = this.timeInStream;
          } else {
            this.latencyHistory.push({start, end: this.timeInStream, at: currentTime});
          }
          // ponytail: retain 30s for replies overlapping user speech; older markers show unavailable.
          while (this.latencyHistory.length && this.latencyHistory[0].at + this.latencyHistory[0].end - this.latencyHistory[0].start < currentTime - 30) {
            this.latencyHistory.shift();
          }
          const first = this.latencyHistory[0];
          if (first && first.at < currentTime - 30) {
            first.start += currentTime - 30 - first.at;
            first.at = currentTime - 30;
          }
        }
        this.reportMarkers();
        return result;
      }
    });
  };
})();

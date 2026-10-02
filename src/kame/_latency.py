from collections import deque


class TurnLatency:
    """Per-session timings, using monotonic seconds and VAD audio positions."""

    def __init__(self, silence_seconds=0.7):
        self.silence_seconds = silence_seconds
        self.turn_id = 0
        self.speaking = False
        self.speech_frames = 0
        self.last_voice_position = 0.0
        self.ended_at = None
        self.last_voice_at = None
        self.answer = None
        self.answer_reported = False
        self.requests = {}
        self.generation_turns = {}
        self.turns = deque(maxlen=32)
        self.events = deque(maxlen=128)

    def input_frame(self, speech, position, received_at):
        if speech:
            self.speech_frames += 1
            if not self.speaking and self.speech_frames >= 3:
                self.turn_id += 1
                self.speaking = True
                self.ended_at = self.answer = None
                self.answer_reported = False
                self.turns.append({"id": self.turn_id, "start": position - 0.06,
                                   "last_voice": position, "ended_at": None,
                                   "asr_at": None, "asr_reported": False})
                self.events.append({"type": "turn", "turn_id": self.turn_id})
            self.last_voice_position = position
            self.last_voice_at = received_at
            if self.speaking:
                self.turns[-1]["last_voice"] = position
        else:
            self.speech_frames = 0
            if self.speaking and position - self.last_voice_position >= self.silence_seconds:
                self.speaking = False
                self.ended_at = self.last_voice_at
                self.turns[-1]["ended_at"] = self.ended_at
                self._report_turn()

    def final_transcript(self, received_at, audio_position=None):
        candidates = [turn for turn in self.turns if not turn["asr_reported"]]
        if audio_position is not None:
            candidates = [turn for turn in candidates
                          if turn["start"] <= audio_position <= turn["last_voice"] + self.silence_seconds]
        # Unattributed transcripts are measured only when there is no ambiguity.
        if len(candidates) == 1:
            candidates[0]["asr_at"] = received_at
            self._report_asr(candidates[0])

    def _report_asr(self, turn):
        if turn["asr_at"] is not None and turn["ended_at"] is not None and not turn["asr_reported"]:
            seconds = turn["asr_at"] - turn["ended_at"]
            if seconds >= 0:
                self.events.append({"type": "asr", "turn_id": turn["id"], "seconds": seconds})
                turn["asr_reported"] = True

    def _report_turn(self):
        if self.ended_at is None:
            return
        self._report_asr(self.turns[-1])
        if self.answer is not None and not self.answer_reported:
            generated_at, position = self.answer
            self.answer_reported = True
            self.events.append({"type": "answer", "turn_id": self.turn_id,
                                "ended_at": self.ended_at, "position": position,
                                "server_seconds": generated_at - self.ended_at})

    def output_speech(self, turn_id, generated_at, position):
        if turn_id != self.turn_id or not turn_id or self.answer is not None:
            return
        self.answer = (generated_at, position)
        self._report_turn()

    def request_started(self, gen_id, started_at):
        self.requests[gen_id] = (self.turn_id, started_at)
        self.generation_turns[gen_id] = self.turn_id

    def first_token(self, gen_id, arrived_at):
        request = self.requests.pop(gen_id, None)
        if request is not None:
            turn_id, started_at = request
            self.events.append({"type": "ttft", "turn_id": turn_id,
                                "gen_id": gen_id, "seconds": arrived_at - started_at})
            return turn_id
        return 0

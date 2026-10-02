import webrtcvad


class StartupVoiceGate:
    """Open after 60 ms of consecutive speech in 16 kHz, mono, int16 PCM."""

    def __init__(self, mode: int = 2, on_frame=None):
        self.vad = webrtcvad.Vad(mode)
        self.pending = bytearray()
        self.speech_frames = 0
        self.open = False
        self.on_frame = on_frame
        self.position = 0.0

    def feed(self, pcm: bytes) -> bool:
        if self.open and self.on_frame is None:
            return True
        self.pending.extend(pcm)
        while len(self.pending) >= 640:  # 20 ms at 16 kHz, two bytes per sample
            frame = bytes(self.pending[:640])
            del self.pending[:640]
            speech = self.vad.is_speech(frame, 16000)
            self.position += 0.02
            if self.on_frame is not None:
                self.on_frame(speech, self.position)
            self.speech_frames = self.speech_frames + 1 if speech else 0
            if self.speech_frames >= 3:
                self.open = True
                if self.on_frame is None:
                    self.pending.clear()
                    break
        return self.open

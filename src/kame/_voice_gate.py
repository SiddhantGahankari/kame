import webrtcvad


class StartupVoiceGate:
    """Open after 60 ms of consecutive speech in 16 kHz, mono, int16 PCM."""

    def __init__(self, mode: int = 2):
        self.vad = webrtcvad.Vad(mode)
        self.pending = bytearray()
        self.speech_frames = 0
        self.open = False

    def feed(self, pcm: bytes) -> bool:
        if self.open:
            return True
        self.pending.extend(pcm)
        while len(self.pending) >= 640:  # 20 ms at 16 kHz, two bytes per sample
            frame = bytes(self.pending[:640])
            del self.pending[:640]
            self.speech_frames = self.speech_frames + 1 if self.vad.is_speech(frame, 16000) else 0
            if self.speech_frames >= 3:
                self.open = True
                self.pending.clear()
                break
        return self.open

import ast
import asyncio
from pathlib import Path
import runpy
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[1] / "src" / "kame"
StartupVoiceGate = runpy.run_path(str(SOURCE / "_voice_gate.py"))["StartupVoiceGate"]
FRAME = bytes(640)


class VoiceGateTests(unittest.TestCase):
    def test_gate_requires_consecutive_speech_and_preserves_partial_frames(self):
        gate = StartupVoiceGate()
        gate.vad = Mock()
        gate.vad.is_speech.side_effect = [True, True, False, True, True, True]
        self.assertFalse(gate.feed(FRAME * 3))
        self.assertFalse(gate.feed(FRAME * 2 + FRAME[:100]))
        self.assertTrue(gate.feed(FRAME[100:]))
        self.assertTrue(gate.feed(FRAME))  # Remains open without further VAD calls.
        self.assertEqual(gate.vad.is_speech.call_count, 6)
        gate.vad.is_speech.assert_called_with(FRAME, 16000)
        self.assertFalse(StartupVoiceGate().open)  # New sessions start closed.

    def test_real_vad_rejects_silence(self):
        self.assertFalse(StartupVoiceGate().feed(FRAME * 50))

    def test_frame_observer_continues_after_startup_gate_opens(self):
        observed = []
        gate = StartupVoiceGate(on_frame=lambda speech, position: observed.append((speech, position)))
        gate.vad = Mock()
        gate.vad.is_speech.side_effect = [True, True, True, False, False]
        self.assertTrue(gate.feed(FRAME * 3))
        self.assertTrue(gate.feed(FRAME * 2))
        self.assertEqual(len(observed), 5)
        self.assertFalse(observed[-1][0])
        self.assertAlmostEqual(observed[-1][1], 0.1)

    def test_asr_partial_cannot_open_gate(self):
        tree = ast.parse((SOURCE / "server_oracle.py").read_text())
        server = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "ServerState")
        method = next(
            node for node in server.body
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "_asr_on_partial_async"
        )
        namespace = {}
        exec(compile(ast.Module(body=[method], type_ignores=[]), "<asr callback>", "exec"), namespace)
        state = Mock()
        state._input_started = False
        state._reject_asr_text.return_value = None
        state._pending_lock = asyncio.Lock()
        state._count_units.return_value = 1
        state._max_pending_units = 0
        state._committed_units_asr = 0
        state._last_logged_total_units = 1
        asyncio.run(namespace[method.name](state, "hello"))
        self.assertFalse(state._input_started)


if __name__ == "__main__":
    unittest.main()

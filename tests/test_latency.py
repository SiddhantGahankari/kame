import ast
import asyncio
from collections import deque
from datetime import timedelta
from pathlib import Path
import queue
import runpy
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


SOURCE = Path(__file__).resolve().parents[1] / "src" / "kame"
TurnLatency = runpy.run_path(str(SOURCE / "_latency.py"))["TurnLatency"]


def server_class(name, **namespace):
    """Exercise server code without importing or loading GPU models."""
    tree = ast.parse((SOURCE / "server_oracle.py").read_text())
    cls = next(node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == name)
    namespace.update(asyncio=asyncio, time=time, queue=queue, log=Mock(), Any=object)
    code = ast.Module(body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), cls], type_ignores=[])
    exec(compile(ast.fix_missing_locations(code), str(SOURCE / "server_oracle.py"), "exec"), namespace)
    return namespace[name]


class LatencyTests(unittest.TestCase):
    def test_turn_end_asr_and_overlapping_answer(self):
        metrics = TurnLatency(silence_seconds=0.1)
        for position in (0.02, 0.04, 0.06):
            metrics.input_frame(True, position, 100 + position)
        metrics.request_started(1, 100.07)
        metrics.first_token(1, 100.09)
        metrics.first_token(1, 100.10)  # Only the first token counts.
        metrics.input_frame(True, 0.08, 100.08)
        metrics.output_speech(1, 100.07, 0.5)  # Answer begins before speech ends.
        metrics.final_transcript(100.15, audio_position=0.08)
        metrics.input_frame(False, 0.20, 100.20)
        events = list(metrics.events)
        self.assertEqual([event["type"] for event in events], ["turn", "ttft", "asr", "answer"])
        self.assertAlmostEqual(events[1]["seconds"], 0.02)
        self.assertAlmostEqual(events[2]["seconds"], 0.07)
        self.assertAlmostEqual(events[3]["server_seconds"], -0.01)
        self.assertEqual(events[3]["position"], 0.5)

    def test_late_asr_is_attributed_to_its_audio_and_silence_has_no_turn(self):
        metrics = TurnLatency(silence_seconds=0.1)
        metrics.input_frame(False, 1, 101)
        self.assertFalse(metrics.events)
        for position in (1.02, 1.04, 1.06):
            metrics.input_frame(True, position, 100 + position)
        metrics.input_frame(False, 1.20, 101.20)
        for position in (1.22, 1.24, 1.26):
            metrics.input_frame(True, position, 100 + position)
        metrics.final_transcript(101.30)  # Ambiguous: do not invent a measurement.
        self.assertFalse(any(event["type"] == "asr" for event in metrics.events))
        metrics.final_transcript(101.40, audio_position=1.06)
        event = metrics.events[-1]
        self.assertEqual(event["turn_id"], 1)
        self.assertAlmostEqual(event["seconds"], 0.34)
        metrics.output_speech(1, 101.41, 0.7)  # Old generation cannot answer the new turn.
        self.assertIsNone(metrics.answer)
        self.assertEqual(TurnLatency().turn_id, 0)

    def test_ttft_is_captured_before_adoption_and_ignores_empty_chunks(self):
        mux_class = server_class("LLMStreamMultiplexer")
        mux = mux_class.__new__(mux_class)
        mux.server_state = SimpleNamespace(latency=TurnLatency(), llm_event_queue=asyncio.Queue())
        mux.server_state.latency.turn_id = 1
        mux._start_ts = {}
        mux._first_emit_ts = {1: 0.0}
        mux._tasks = {}
        mux._running = True
        mux._session_id = 1
        mux.adopted_gen = 0
        mux.oracle_model = "Qwen"
        mux._extra = {}

        async def create(**_kwargs):
            async def stream():
                yield SimpleNamespace(choices=[])
                yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=" "))])
                yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content="Hello "))])
            return stream()

        async def adopt(gen_id):
            self.assertEqual(mux.server_state.latency.events[0]["type"], "ttft")
            await asyncio.sleep(0.01)
            mux.adopted_gen = gen_id

        mux.client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        mux._adopt_generation = adopt
        asyncio.run(mux._stream_single([], 1, 1))
        self.assertEqual(len(mux.server_state.latency.events), 1)
        self.assertLess(mux.server_state.latency.events[0]["seconds"], 0.01)
        self.assertEqual(mux.server_state.llm_event_queue.get_nowait(), ("append", 1, " Hello "))

    def test_local_asr_passes_audio_position_with_final_transcript(self):
        try:
            import numpy as np
        except ImportError:
            self.skipTest("NumPy is required for the local ASR integration check")
        processor_class = server_class("AsyncASRProcessor", np=np)
        processor = processor_class.__new__(processor_class)
        processor.target_sample_rate = 16000
        processor.silence_seconds = 0.1
        processor.speech_threshold = 0.005
        processor.running = True
        processor.audio_buffer = queue.Queue()
        processor.stats = {"final_transcripts": 0}
        processor.last_partial_text = ""
        processor._on_partial = None
        processor._on_final = Mock()
        processor._on_final_audio = Mock()
        processor._transcribe_local = Mock(return_value="hello")
        processor.audio_buffer.put(((np.ones(1600, dtype=np.int16) * 1000).tobytes(), 5.1))
        processor.audio_buffer.put((np.zeros(1600, dtype=np.int16).tobytes(), 5.2))
        processor.audio_buffer.put(None)
        processor._run_local_streaming()
        processor._on_final_audio.assert_called_once_with("hello", 5.1)
        processor._on_final.assert_not_called()

    def test_google_asr_maps_result_position_after_dropped_input(self):
        processor_class = server_class("AsyncASRProcessor")
        processor = processor_class.__new__(processor_class)
        processor.running = True
        processor.last_partial_text = ""
        processor.stats = {"final_transcripts": 0}
        processor._on_final_audio = Mock()
        processor._on_final = Mock()
        processor._speech_stream_positions = deque([(0, 0.08, 5.08), (0.08, 0.16, 6.16)])
        result = SimpleNamespace(
            is_final=True, alternatives=[SimpleNamespace(transcript="hello")],
            result_end_time=timedelta(seconds=0.12),
        )
        processor._process_responses([SimpleNamespace(results=[result])])
        transcript, position = processor._on_final_audio.call_args.args
        self.assertEqual(transcript, "hello")
        self.assertAlmostEqual(position, 6.12)
        processor._on_final.assert_not_called()


if __name__ == "__main__":
    unittest.main()

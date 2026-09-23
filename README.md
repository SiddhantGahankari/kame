<h1 align="center">KAME</h1>

<p align="center">
  <strong>KAME: TANDEM ARCHITECTURE FOR ENHANCING KNOWLEDGE IN REAL-TIME SPEECH-TO-SPEECH CONVERSATIONAL AI</strong>
</p>

<p align="center">
  <a href=".github/workflows/precommit.yml"><img alt="Checks" src="https://img.shields.io/badge/checks-passing-brightgreen"></a>
  <img alt="Python" src="https://img.shields.io/badge/python-%3E%3D3.10-blue">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <a href="https://docs.astral.sh/ruff/"><img alt="ruff" src="https://img.shields.io/badge/code%20style-ruff-informational"></a>
</p>

<p align="center">
  <a href="https://github.com/SakanaAI/kame_finetune">KAME Finetuning code</a> ·
  <a href="https://arxiv.org/abs/2510.02327">Paper</a> ·
  <a href="https://pub.sakana.ai/kame/">Blog post</a> ·
  <a href="https://huggingface.co/SakanaAI/kame">Hugging Face</a>
  
</p>

KAME is a spoken dialogue system built on top of the
[Kyutai Moshi](https://github.com/kyutai-labs/moshi) codebase.
This repository keeps the Python inference stack needed for:

- running KAME's oracle-guided dialogue server with a web UI
- loading KAME-compatible `kame` modules from `kame_finetune`

The public-facing focus of this repository is the Python inference path around
`kame.server_oracle`, while keeping the generic `kame.server` flow available
for compatibility.

<p align="center">
  <img src="docs/assets/kame-overview.gif" alt="KAME oracle-guided spoken dialogue demo in the browser UI" width="900">
</p>

<p align="center">
  <em>KAME running oracle-guided spoken dialogue with live browser interaction.</em>
</p>

## What KAME Adds

Compared with the upstream Moshi repository, KAME adds and maintains the
oracle-guided dialogue path used for our experiments and demos.
The primary entrypoint is:

```bash
python -m kame.server_oracle --help
```

or, after installing the package in editable mode:

```bash
kame-server-oracle --help
```

This server provides the KAME-specific inference path and serves a browser UI.
If `--static` is not provided, the server can fetch static assets automatically.
For compatibility, the generic Python server is also retained:

```bash
python -m kame.server --help
```

## Runtime Notes

- `kame.server_oracle` requires `OPENAI_API_KEY`.
- ASR is enabled by default and uses Google Cloud Speech-to-Text. Set
  `GOOGLE_APPLICATION_CREDENTIALS` to a valid Google Cloud credential JSON file
  before starting the server.
- The current oracle-guided server path is configured for English dialogue and ASR (`en-US`).
- If `--static` is omitted, the browser UI assets are fetched automatically at startup.
- `kame.server_oracle` sends conversation text to OpenAI Chat Completions.
- If ASR is enabled, `kame.server_oracle` sends audio to Google Cloud Speech-to-Text.
- `kame.server_oracle` currently supports only a single active WebSocket session at a time; concurrent sessions are rejected with `503 Server busy`.
- Plaintext local session logs are disabled by default. Enable them explicitly with `--log-dir` or `MOSHI_LOG_DIR` if you want to persist transcripts and token streams locally.

## Repository Layout

The parts of this repository that matter for KAME are:

- [`src/kame/`](src/kame/): installable KAME Python package
- [`src/kame/server_oracle.py`](src/kame/server_oracle.py): oracle-guided server entrypoint
- [`src/kame/server.py`](src/kame/server.py): generic non-oracle server retained for compatibility
- [`src/kame/models/`](src/kame/models/): language model and checkpoint loading code used by `kame_finetune`

The published distribution name is `kame-model`, while the Python import
namespace is `kame`. This repository now uses a standard root project layout
with the package source under [`src/kame/`](src/kame/).

## Typical Usage

### Run from the Hugging Face Checkpoint

The public checkpoint can be loaded directly from Hugging Face with
`--hf-repo`. The package distribution name is `kame-model`, while the Python
module name is `kame`.

```bash
uv init --bare --python 3.12
uv add "kame-model @ git+https://github.com/SakanaAI/kame.git@1a69ee29dbd201d400f841459d87871154881047"

export OPENAI_API_KEY=...
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/google-cloud-credentials.json

uv run python -m kame.server_oracle \
  --hf-repo SakanaAI/kame \
  --host 0.0.0.0 \
  --port 8998 \
  --device cuda
```

Then open `http://localhost:8998`.

### Local DSpark Oracle on One 40 GB GPU

Use llama.cpp's OpenAI-compatible server with the LiquidAI target and its
matching DSpark drafter:

```bash
hf download LiquidAI/LFM2.5-8B-A1B-GGUF LFM2.5-8B-A1B-Q8_0.gguf --local-dir models/lfm
hf download LiquidAI/LFM2.5-8B-A1B-DSpark-GGUF LFM2.5-8B-A1B-DSpark-F16.gguf --local-dir models/lfm

llama-server \
  -m models/lfm/LFM2.5-8B-A1B-Q8_0.gguf \
  -md models/lfm/LFM2.5-8B-A1B-DSpark-F16.gguf \
  --spec-type draft-dspark \
  --spec-draft-n-max 10 \
  --spec-draft-n-min 0 \
  -fa on \
  -ngl 99 \
  --alias lfm-dspark \
  --port 8080 \
  -c 8192
```

Point KAME at that server. A non-empty API key is required by the client but
is not checked by the local server:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8080/v1
export OPENAI_API_KEY=local

python -m kame.server_oracle \
  --hf-repo SakanaAI/kame \
  --oracle-model lfm-dspark \
  --max-concurrent-streams 1 \
  --min-restart-interval 1.0 \
  --host 0.0.0.0 \
  --port 8998 \
  --device cuda
```

`OPENAI_MODEL=lfm-dspark` can be used instead of `--oracle-model`. Keep one
oracle stream initially because KAME and the local oracle share the same GPU.

`kame-model` is not published on PyPI yet, so the example above installs it
directly from GitHub. For reproducible runs, pin a release tag or commit instead
of installing from `main`.

Notes:

- Python `>=3.10` is supported; the command above uses Python 3.12 because it is
  the version used for verification.
- `OPENAI_API_KEY` is required by `kame.server_oracle`.
- ASR is enabled by default and requires Google Cloud Speech-to-Text. Before
  running the server, set up a Google Cloud project for
  [Speech-to-Text](https://cloud.google.com/speech-to-text/docs/setup) and
  configure
  [Application Default Credentials](https://cloud.google.com/docs/authentication/set-up-adc-on-premises)
  with `GOOGLE_APPLICATION_CREDENTIALS`.
- For local smoke tests without Google Speech-to-Text, pass `--no-enable-asr`.
  This skips ASR and does not exercise the full oracle-guided spoken-dialogue path.
- `--config-path`, `--moshi-weight`, `--mimi-weight`, and `--tokenizer` are not
  needed for the public Hugging Face checkpoint in the usual case.
- `config.json` in the Hugging Face repo resolves the model weights, Mimi
  checkpoint, tokenizer, and optional generation settings.

### Local Development

```bash
pip install -e .
python -m kame.server_oracle --help
```

`kame_finetune` can then depend on this repository directly from the repo root,
for example via a local editable path dependency.

## Scope

This repository is intentionally narrower than the original Moshi release.
The main supported workflow is:

1. install the Python package from the repository root
2. run `server_oracle.py` for oracle-guided interactive inference, or `server.py` for the generic server path
3. use the same Python package as the `kame-model` dependency from `kame_finetune`

## License

The `kame-model` Python package is distributed under the MIT License.
This repository is derived from the Kyutai Moshi codebase and retains the
relevant upstream license files and notices. Additional inherited notices,
including [`LICENSE.audiocraft`](LICENSE.audiocraft), are kept at the project
root. Model weights and datasets, when distributed separately, may be subject to
different license terms.

## Attribution

KAME is derived from the
[Kyutai Moshi repository](https://github.com/kyutai-labs/moshi).
We retain the original license files and attribution for the inherited codebase,
and extend the Python inference stack with KAME-specific functionality.

Please keep the existing license files in this repository, including:

- [`LICENSE`](LICENSE)
- [`LICENSE.audiocraft`](LICENSE.audiocraft)
- [`LICENSE-MIT`](LICENSE-MIT)

## Citation

If you use KAME in your research, please cite:

```bibtex
@article{kuroki2025kame,
  title={KAME: Tandem Architecture for Enhancing Knowledge in Real-Time Speech-to-Speech Conversational AI},
  author={Kuroki, So and Kubo, Yotaro and Akiba, Takuya and Tang, Yujin},
  journal={arXiv preprint arXiv:2510.02327},
  year={2025}
}
```

#!/bin/zsh
# One-time setup: Python env + speaker-separation models. Needs Homebrew ffmpeg and uv (or python3.12).
set -e
cd "$(dirname "$0")"
command -v ffmpeg >/dev/null || { echo "Install ffmpeg first: brew install ffmpeg"; exit 1; }
if command -v uv >/dev/null; then
  uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt
else
  python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
fi
mkdir -p models && cd models
if [ ! -d sherpa-onnx-pyannote-segmentation-3-0 ]; then
  curl -sSL -o seg.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2
  tar xjf seg.tar.bz2 && rm seg.tar.bz2
fi
[ -f nemo_en_titanet_small.onnx ] || curl -sSL -fo nemo_en_titanet_small.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx
cd ..
[ -f .env ] || cp .env.example .env
echo "Done. Put your Claude API key in .env, then: .venv/bin/python app.py --config config.demo.json"

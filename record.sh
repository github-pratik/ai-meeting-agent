#!/bin/zsh
# Record an in-person meeting from this Mac's microphone. Press q (or Ctrl+C) to stop.
#   ./record.sh "Staff meeting"            -> inbox/2026-11-09_1400_staff-meeting.m4a
#   ./record.sh --devices                  -> list microphones; then MIC=1 ./record.sh "..."
cd "$(dirname "$0")"
if [[ "$1" == "--devices" ]]; then
  ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/audio devices/,$p'
  exit 0
fi
title=${1:-meeting}
slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
out="inbox/$(date +%Y-%m-%d_%H%M)_${slug}.m4a"
echo "Recording to $out — press q to stop. Tell the room it's being recorded."
ffmpeg -hide_banner -loglevel warning -stats -f avfoundation -i ":${MIC:-default}" -ac 1 -ar 16000 -c:a aac -b:a 64k "$out"
echo "Saved $out"

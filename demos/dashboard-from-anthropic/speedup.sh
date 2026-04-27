#!/usr/bin/env bash
# Post-process the recorded demo: split around the "session running"
# segment and speed it up; keep the intro and the result/trace tail at
# normal speed.
#
# Inputs (relative to this script):
#   demo.mp4    raw recording from scripts/record-demo
#   marks.json  driver-clock timestamps (msg_sent, msg_done, t_total)
#
# Output: demo.mp4 is overwritten with the sped-up version. Raw input is
# kept at demo.raw.mp4 so a second run can re-tune speed without
# re-recording.
set -euo pipefail

cd "$(dirname "$0")"

# Recording starts ~1s before the driver runs (record-start sleeps
# 800ms before returning, then node spin-up adds a fraction). To avoid
# clipping the speedup window into the visible "send message" / "result
# lands" actions, pad both sides by ~0.6s of normal-speed footage.
PAD_BEFORE=0.6
PAD_AFTER=0.6
SPEEDUP=10  # 10x — typical session is 60-180s, this packs it into 6-18s.

if [ ! -f marks.json ]; then echo "marks.json not found" >&2; exit 1; fi

if [ ! -f demo.raw.mp4 ]; then
  if [ ! -f demo.mp4 ]; then echo "demo.mp4 not found" >&2; exit 1; fi
  cp demo.mp4 demo.raw.mp4
fi

MSG_SENT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("marks.json","utf8")).msg_sent)')
MSG_DONE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("marks.json","utf8")).msg_done)')

# Recording offset (driver clock vs recording clock). record-demo starts
# wf-recorder, sleeps 0.8s, then forks node. The driver starts running
# after another ~0.1-0.3s of node import time. Rather than try to chase
# the exact offset, we add 1.0s to driver timestamps to map onto the
# recording's clock (recording starts earlier) and let the pad windows
# above cover the rest of the slop.
REC_OFFSET=1.0

SPLIT_A=$(awk -v t="$MSG_SENT" -v o="$REC_OFFSET" -v p="$PAD_BEFORE" 'BEGIN{printf "%.3f", t + o - p}')
SPLIT_B=$(awk -v t="$MSG_DONE" -v o="$REC_OFFSET" -v p="$PAD_AFTER"  'BEGIN{printf "%.3f", t + o + p}')

echo "[speedup] msg_sent=${MSG_SENT}s  msg_done=${MSG_DONE}s"
echo "[speedup] split A=${SPLIT_A}s  split B=${SPLIT_B}s  speedup=${SPEEDUP}x"

# Single ffmpeg pass: trim into 3 segments, speed up the middle, concat.
# setpts=PTS/${SPEEDUP} drops 9 of every 10 frames (no audio track to
# atempo-juggle, so this is the whole story).
ffmpeg -y -i demo.raw.mp4 -filter_complex "
  [0:v]trim=start=0:end=${SPLIT_A},setpts=PTS-STARTPTS[v0];
  [0:v]trim=start=${SPLIT_A}:end=${SPLIT_B},setpts=(PTS-STARTPTS)/${SPEEDUP}[v1];
  [0:v]trim=start=${SPLIT_B},setpts=PTS-STARTPTS[v2];
  [v0][v1][v2]concat=n=3:v=1:a=0[v]
" -map "[v]" -c:v libx264 -preset veryfast -crf 23 -movflags +faststart \
  demo.mp4

echo "[speedup] wrote demo.mp4 (raw kept at demo.raw.mp4)"

# Audio A/B reference

`tobutobugirl.mgba-120-480.s16le` is mGBA 0.11's mixed audio output for frames
120-480 of `test/performance/testroms/tobutobugirl/tobutobugirl.gb`: raw
interleaved stereo s16le at mGBA's native 131072Hz. mGBA is not needed at test
time; the capture is committed so CI compares against fixed bytes.

`audio-ab-baseline.json` records how close the current core measures against
that capture, and the thresholds the A/B test enforces. The pipeline is
deterministic end to end, so the margins are sized to the smallest real bug
measured (an envelope drop of 0.044 from the wave-channel volume regression),
not to run-to-run noise. When the core genuinely gets closer to mGBA,
re-baseline deliberately and say why in the commit.

To regenerate the reference, build `mgba-audio-capture.c` against libmgba
(written by quintra-codex for the v0.8.7 wave-channel investigation):

    cc mgba-audio-capture.c -o mgba-audio-capture $(pkg-config --cflags --libs mgba)
    ./mgba-audio-capture ../../performance/testroms/tobutobugirl/tobutobugirl.gb \
      120 360 tobutobugirl.mgba-120-480.s16le

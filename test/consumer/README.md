# Consumer smoke test

Drives wasmboy the way a game project would: installs the package as a
dependency and runs a GBC ROM headlessly through the public API only.

The in-repo suites import from `lib/` and `dist/` directly, so they cannot see
packaging problems or behaviour that only appears outside the play loop. This
test found two real bugs that way — save states with undefined memory when
frames are driven without `play()`, and `loadState` detaching the caller's
checkpoint so a second restore silently did nothing.

Run it against the current working tree:

    mkdir -p tmp/consumer-test && cd tmp/consumer-test
    npm init -y
    npm install ../..            # runs wasmboy's prepare build
    node ../../test/consumer/smoke.js

Exits non-zero if any check fails.

// Invariants that hold for any ROM, checked against real games.
//
// The suites next door check the core against test ROMs written to probe
// hardware edge cases. That left two gaps, and a shipped release fell through
// both: they exercise the core rather than the library wrapped around it, and
// they compare against recorded output rather than checking that a run is
// reproducible at all.
//
// A change that seeded video and work RAM with random bytes at startup passed
// every one of them. It broke a released game's title screen, because the game
// assumes RAM starts clear, and it made every run differ from the last. Neither
// consequence was visible to a core-level golden comparison.
//
// So this checks properties instead of recordings:
//
//   parity       the library must not change what the core renders
//   determinism  the same ROM and inputs must produce the same frame
//   startup      memory must come up the same way every time
//
// None of these need a reference emulator, a recorded golden, or a specific
// game, so they keep working as the emulator improves.

const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');

const HELPERS = path.resolve(__dirname, 'helpers');
const ROMS_PATH = path.resolve(__dirname, '../performance/testroms');

// Real games rather than hardware probes: a test ROM that carefully sets up its
// own memory cannot notice startup state changing underneath it.
const ROMS = [
  { name: 'tobutobugirl', file: path.join(ROMS_PATH, 'tobutobugirl/tobutobugirl.gb') },
  { name: 'back-to-color', file: path.join(ROMS_PATH, 'back-to-color/back-to-color.gbc') }
];

// Far enough in to be past boot and rendering real content.
const FRAMES = 600;

const renderFrame = (rom, renderPath) =>
  execFileSync('node', [path.join(HELPERS, 'render-frame.js'), '--rom', rom, '--frames', String(FRAMES), '--path', renderPath], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .pop();

const startupMemory = (rom, randomize) =>
  JSON.parse(
    execFileSync('node', [path.join(HELPERS, 'startup-memory.js'), '--rom', rom, '--randomize', String(randomize)], {
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
      .pop()
  );

describe('Render harness', function() {
  // Each check is a separate process running hundreds of emulated frames.
  this.timeout(120000);

  ROMS.forEach(rom => {
    it(`should render ${rom.name} identically through the core and the library`, () => {
      // The library adds workers, memory clearing and message passing around
      // the core. None of that may change a pixel. This is the invariant the
      // startup-RAM regression broke: the core was correct throughout, and only
      // the library path rendered garbage.
      const core = renderFrame(rom.file, 'core');
      const lib = renderFrame(rom.file, 'lib');

      assert.strictEqual(lib, core, `library output diverged from the core after ${FRAMES} frames`);
    });

    it(`should render ${rom.name} the same way twice`, () => {
      // Separate processes, so anything seeded per-run shows up as a difference.
      const first = renderFrame(rom.file, 'lib');
      const second = renderFrame(rom.file, 'lib');

      assert.strictEqual(second, first, 'the same ROM and inputs produced different frames');
    });
  });

  it('should bring memory up the same way every time', () => {
    // Independent of what any ROM does with memory, so it holds even for a game
    // that clears everything itself and would never notice.
    const first = startupMemory(ROMS[0].file, false);
    const second = startupMemory(ROMS[0].file, false);

    assert.strictEqual(second.hash, first.hash, 'startup memory differed between runs');
  });

  it('should bring memory up clear by default', () => {
    const startup = startupMemory(ROMS[0].file, false);

    assert.strictEqual(
      startup.nonZero,
      0,
      `${startup.nonZero} of ${startup.total} bytes of video and work RAM were seeded before the game ran`
    );
  });

  it('should still be able to seed memory deliberately', () => {
    // The behaviour is worth keeping, just not by default. If this fails the
    // option has become inert, which is how it would silently stop being
    // testable at all.
    const seeded = startupMemory(ROMS[0].file, true);

    assert(seeded.nonZero > seeded.total / 4, `asked for seeded memory, got ${seeded.nonZero} of ${seeded.total} bytes set`);
  });
});

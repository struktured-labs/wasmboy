#include <mgba/flags.h>
#include <mgba/core/core.h>
#include <mgba-util/audio-buffer.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char** argv) {
    if (argc != 5 && argc != 6) {
        fprintf(stderr, "usage: %s ROM START_FRAME FRAME_COUNT OUTPUT.raw [CHANNEL_ID]\n", argv[0]);
        return 2;
    }

    const char* rom_path = argv[1];
    const unsigned start_frame = (unsigned) strtoul(argv[2], NULL, 10);
    const unsigned frame_count = (unsigned) strtoul(argv[3], NULL, 10);
    const char* output_path = argv[4];
    (void) argc;

    struct mCore* core = mCoreFind(rom_path);
    if (!core || !core->init(core)) {
        fprintf(stderr, "could not initialize mGBA core\n");
        return 1;
    }

    mCoreInitConfig(core, NULL);
    core->opts.useBios = false;
    core->opts.skipBios = true;
    core->opts.sampleRate = 44100;
    core->opts.audioBuffers = 8192;
    core->opts.audioSync = false;
    core->opts.videoSync = false;

    if (!mCoreLoadFile(core, rom_path)) {
        fprintf(stderr, "could not load ROM\n");
        core->deinit(core);
        return 1;
    }

    core->setAudioBufferSize(core, 8192);
    core->reset(core);

    FILE* output = fopen(output_path, "wb");
    if (!output) {
        perror("fopen");
        core->deinit(core);
        return 1;
    }

    int16_t samples[8192 * 2];
    size_t written_frames = 0;
    const unsigned end_frame = start_frame + frame_count;
    for (unsigned frame = 0; frame < end_frame; ++frame) {
        core->runFrame(core);
        struct mAudioBuffer* audio = core->getAudioBuffer(core);
        size_t available = mAudioBufferAvailable(audio);
        while (available > 0) {
            size_t request = available > 8192 ? 8192 : available;
            size_t received = mAudioBufferRead(audio, samples, request);
            if (frame >= start_frame) {
                fwrite(samples, sizeof(int16_t) * 2, received, output);
                written_frames += received;
            }
            available = mAudioBufferAvailable(audio);
        }
    }

    fclose(output);
    fprintf(stderr, "sample_rate=%u stereo_frames=%zu\n", core->audioSampleRate(core), written_frames);
    core->unloadROM(core);
    core->deinit(core);
    return 0;
}

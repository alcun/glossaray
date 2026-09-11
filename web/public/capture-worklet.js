/**
 * Microphone capture. Runs on the audio thread, hands back 16-bit PCM.
 *
 * There is no resampling here on purpose. The capture AudioContext is created
 * with sampleRate 16000, so the browser resamples the hardware for us and this
 * processor only converts float to int. That matters: a browser runs the mic at
 * whatever the hardware gives - 48000 almost everywhere, including every iPhone
 * - and assuming a rate is how you ship something that looks like it works and
 * is wrong. Let the platform do the conversion it already knows how to do.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const sample = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);

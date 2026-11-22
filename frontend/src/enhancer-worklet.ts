// AudioWorklet that runs the Rust voice enhancer (frontend/wasm-audio).
// The module has no imports, so it is compiled synchronously here from the
// bytes the main thread passes in processorOptions.

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

interface EnhancerExports {
  memory: WebAssembly.Memory;
  create(sr: number): number;
  input_ptr(h: number): number;
  output_ptr(h: number): number;
  max_block(): number;
  process(h: number, n: number): void;
  destroy(h: number): void;
}

class VoiceEnhancer extends AudioWorkletProcessor {
  private readonly x: EnhancerExports | null = null;
  private readonly h: number = 0;
  private readonly max: number = 0;

  constructor(opts: { processorOptions?: { bytes?: ArrayBuffer } }) {
    super();
    try {
      const bytes = opts.processorOptions?.bytes;
      if (!bytes) throw new Error("no wasm");
      const x = new WebAssembly.Instance(new WebAssembly.Module(bytes), {}).exports as unknown as EnhancerExports;
      this.h = x.create(sampleRate);
      this.max = x.max_block();
      this.x = x;
      this.port.postMessage({ ok: true });
    } catch (e) {
      this.port.postMessage({ ok: false, error: String(e) });
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const src = inputs[0]?.[0];
    const dst = outputs[0];
    if (!src || !dst?.length) return true;
    const x = this.x;
    if (!x) {
      for (const ch of dst) ch.set(src);
      return true;
    }
    for (let off = 0; off < src.length; off += this.max) {
      const n = Math.min(this.max, src.length - off);
      new Float32Array(x.memory.buffer, x.input_ptr(this.h), n).set(src.subarray(off, off + n));
      x.process(this.h, n);
      const res = new Float32Array(x.memory.buffer, x.output_ptr(this.h), n);
      for (const ch of dst) ch.set(res, off);
    }
    return true;
  }
}

registerProcessor("voice-enhancer", VoiceEnhancer);

export {};

"""irodori-TTS（gradio_app_voicedesign.py）を、GPUメモリを抱え込まないようにして起動する。

PyTorch は一度使ったGPUメモリを、音声を作り終わった後も確保したままにする。
そのままだと irodori-TTS だけで 8GB 以上を持ち続け、Ollama（Gemma）がGPUに入りきらずCPUで動いてしまう。
ここでは irodori-TTS 本体には手を入れず、音声を1回作るたびに empty_cache() でメモリを返す。

使い方（start-*.bat から呼ばれる）:
    python irodori_lowvram.py <Irodori-TTSのフォルダ> --server-port 7861
"""

import os
import sys
import time


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: irodori_lowvram.py <Irodori-TTS dir> [gradio args...]")
    irodori_dir = os.path.abspath(sys.argv.pop(1))
    os.chdir(irodori_dir)
    sys.path.insert(0, irodori_dir)

    import torch
    from irodori_tts import inference_runtime
    import gradio_app_voicedesign as app

    original_synthesize = inference_runtime.InferenceRuntime.synthesize

    def synthesize_and_release(self, *args, **kwargs):
        cuda = torch.cuda.is_available()
        if cuda:
            torch.cuda.reset_peak_memory_stats()
        started = time.perf_counter()
        try:
            return original_synthesize(self, *args, **kwargs)
        finally:
            if cuda:
                peak_mb = torch.cuda.max_memory_allocated() / 2**20
                torch.cuda.empty_cache()
                kept_mb = torch.cuda.memory_reserved() / 2**20
                print(
                    f"[lowvram] {time.perf_counter() - started:.2f}s peak={peak_mb:.0f}MB kept={kept_mb:.0f}MB",
                    flush=True,
                )

    inference_runtime.InferenceRuntime.synthesize = synthesize_and_release
    app.main()


if __name__ == "__main__":
    main()

# 配信の邪魔をしないよう、自分の優先度を「アイドル」に下げ、GPU を使わずに inference.py を動かす。
# 使い方: python run_convert.py <歌声.wav> <声見本.wav> <出力フォルダ> [半音ずらし]
import ctypes
import glob
import os
import runpy
import sys

IDLE_PRIORITY_CLASS = 0x40
ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), IDLE_PRIORITY_CLASS)
os.environ.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
os.chdir(os.path.dirname(os.path.abspath(__file__)))

source, target, output = sys.argv[1:4]
shift = sys.argv[4] if len(sys.argv) > 4 else "0"
checkpoint = glob.glob("checkpoints/models--Plachta--Seed-VC/snapshots/*/DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth")[0]
sys.argv = [
    "inference.py", "--source", source, "--target", target, "--output", output,
    "--diffusion-steps", "30", "--f0-condition", "True", "--auto-f0-adjust", "False",
    "--semi-tone-shift", shift, "--fp16", "False",
    "--checkpoint", checkpoint, "--config", "checkpoints/local/config_f0_44k_local.yml",
]
import torch  # noqa: E402

# GPU は配信で使っているので CPU で動かす。
# CUDA_VISIBLE_DEVICES=-1 で隠すと、この PC では torch.cuda.is_available() の後にメモリが壊れて落ちるので、関数を差し替える。
torch.cuda.is_available = lambda: False
torch.set_num_threads(3)

# torchaudio 2.10 の保存は torchcodec（FFmpeg の DLL が要る）に頼っていて読み込めないので、soundfile で保存する。
import soundfile  # noqa: E402
import torchaudio  # noqa: E402

def save_wav(path, wave, sr):
    # 変換後は音量が 0dB を超えて音割れすることがあるので、ピークを -1dB に抑えてから書き出す。
    audio = wave.squeeze(0).float().numpy()
    peak = float(abs(audio).max()) or 1.0
    soundfile.write(path, audio * min(1.0, 0.89 / peak), sr)


torchaudio.save = save_wav
runpy.run_path("inference.py", run_name="__main__")

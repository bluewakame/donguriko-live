"""VOICEVOX の歌声合成で「どんぐりころころ」（青木存義 作詞・梁田貞 作曲、著作権切れ）の1番を歌わせる。
楽譜は Wikimedia Commons の数字譜（ハ長調・4分の2拍子）から起こした。長さの単位は16分音符。"""
import json
import sys
import urllib.request

ENGINE = "http://127.0.0.1:50021"
TEACHER = 6000   # 歌唱指導（音程・長さの推定）
OUT = sys.argv[1]
SINGER = int(sys.argv[2]) if len(sys.argv) > 2 else 3008  # 春日部つむぎ
BPM = float(sys.argv[3]) if len(sys.argv) > 3 else 84
TRANSPOSE = int(sys.argv[4]) if len(sys.argv) > 4 else 2  # ハ長調→ニ長調
FRAMES_PER_16TH = 93.75 * 60 / BPM / 4

# 数字譜の音（1=ド … 7=シ、8=上のド）→ MIDI
DEG = {1: 60, 2: 62, 3: 64, 4: 65, 5: 67, 6: 69, 7: 71, 8: 72}

# (歌詞, 音, 16分音符いくつ分)。歌詞に2モーラ入っている音（どん・さあ など）は、同じ音で2つに分ける。音 0 は休符。
SCORE = [
    ("", 0, 4),
    ("どん", 5, 2), ("ぐ", 3, 1), ("り", 3, 1), ("こ", 4, 1), ("ろ", 3, 1), ("こ", 2, 1), ("ろ", 1, 1),
    ("どん", 5, 2), ("ぶ", 3, 1), ("り", 3, 1), ("こ", 2, 2), ("", 0, 2),
    ("お", 3, 2), ("い", 3, 1), ("け", 5, 1), ("に", 5, 1), ("は", 6, 1), ("ま", 6, 1), ("て", 6, 1),
    ("さあ", 8, 2), ("た", 3, 1), ("い", 3, 1), ("へん", 5, 2), ("", 0, 2),
    ("ど", 5, 1), ("じょ", 5, 1), ("う", 3, 1), ("が", 3, 1), ("で", 4, 1), ("て", 3, 1), ("き", 2, 1), ("て", 1, 1),
    ("こん", 5, 2), ("に", 3, 1), ("ち", 3, 1), ("は", 2, 2), ("", 0, 2),
    ("ぼ", 5, 2), ("ちゃん", 3, 2), ("い", 6, 2), ("しょ", 5, 1), ("に", 5, 1),
    ("あ", 6, 1), ("そ", 6, 1), ("び", 7, 1), ("ま", 7, 1), ("しょ", 8, 4),
    ("", 0, 4),
]

MORA_SPLIT = {"どん": ("ど", "ん"), "へん": ("へ", "ん"), "こん": ("こ", "ん"), "ちゃん": ("ちゃ", "ん"), "さあ": ("さ", "あ")}


def post(path, body, raw=False):
    req = urllib.request.Request(ENGINE + path, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=900) as res:
        data = res.read()
    return data if raw else json.loads(data)


notes = []
for lyric, degree, sixteenths in SCORE:
    frames = round(sixteenths * FRAMES_PER_16TH)
    key = DEG[degree] + TRANSPOSE if degree else None
    if lyric in MORA_SPLIT:
        first, second = MORA_SPLIT[lyric]
        head = round(frames * 0.6)
        notes += [{"key": key, "frame_length": head, "lyric": first}, {"key": key, "frame_length": frames - head, "lyric": second}]
    else:
        notes.append({"key": key, "frame_length": frames, "lyric": lyric})

query = post(f"/sing_frame_audio_query?speaker={TEACHER}", {"notes": notes})
wav = post(f"/frame_synthesis?speaker={SINGER}", query, raw=True)
with open(OUT, "wb") as f:
    f.write(wav)
print(f"wrote {OUT} ({len(wav)} bytes)")

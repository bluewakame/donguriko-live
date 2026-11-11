# Donguriko 縦型ライブ映像

start-tiktok.bat で配信システムを起動し、OBS のブラウザソースを http://127.0.0.1:8790/vertical、1080×1920 に設定します。実際のポートは config.json の server.port に合わせてください。画面だけのプレビューは /gift-live/index.html?demo=1 です。

この画面は提供された実写風動画を使います。待機は scene-idle.mp4、新規入室は scene-welcome.mp4、バラなどは scene-wave.mp4、ハートは scene-heart.mp4、お祝い系は scene-celebrate.mp4、通常の発話中は scene-speaking.mp4 です。動画内の音声は除去済みで、Donguriko の既存 TTS を流します。動画の口の動きは音素単位の同期ではありません。

TikTok の MEMBER 入室イベントで視聴者名を読み上げて歓迎します。接続直後10秒の入室は流さず、全体で30秒、同じ視聴者は10分の間隔を空けます。config.json の tiktok.replyToJoins、joinGlobalCooldownMs、joinUserCooldownMs で調整できます。

映像や写真は MIT ライセンスの対象外です。権利者の許可なく再利用・再配布しないでください。

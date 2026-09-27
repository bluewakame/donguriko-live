// 「歌って」と言われたときに流す歌の一覧を読み、どの歌を歌うか決める。
// 一覧は songs/songs.json。歌の音声（wav）は同じフォルダに置く（公開リポジトリには入れない）。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// 「歌って」「歌聞きたい」「一曲お願い」など。「歌ってみた」「歌ってた」のような話題には反応しない。
const SONG_REQUEST = /歌って(?!た|い[るま]|みた|る)|うたって(?!た|い[るま]|みた|る)|歌を?(?:聞|き)かせて|歌(?:が|を)?(?:聞|き)きたい|歌(?:える|えます)[?？]|歌お(?:う|うよ)?[!！?？]*$|一曲(?:お願い|おねがい|どうぞ|歌)|\bsing\b/i;

export function isSongRequest(text) {
  return SONG_REQUEST.test(String(text ?? "").replace(/\s+/g, " "));
}

export function normalizeSongConfig(config, root) {
  const songs = config.songs ?? {};
  config.songs = songs;
  songs.enabled = songs.enabled ?? true;
  songs.dir = resolve(root, String(songs.dir ?? "songs"));
  // 同じ人に何度も歌わされないよう、歌ってからしばらくは歌わない。
  songs.cooldownMs = Math.max(0, Number(songs.cooldownMs ?? 5 * 60 * 1000));
  return songs;
}

// songs.json を読み、音声ファイルが実際にある歌だけを返す。毎回読むので、配信中に歌を足してもすぐ使える。
export async function loadSongs(settings) {
  try {
    const raw = JSON.parse(await readFile(join(settings.dir, "songs.json"), "utf8"));
    const list = Array.isArray(raw.songs) ? raw.songs : [];
    return list
      .filter((song) => song?.title && song?.file)
      .map((song) => ({
        id: String(song.id ?? song.title),
        title: String(song.title),
        path: join(settings.dir, String(song.file)),
        credit: String(song.credit ?? ""),
        keywords: (Array.isArray(song.keywords) ? song.keywords : []).map(String),
        lyrics: (Array.isArray(song.lyrics) ? song.lyrics : [])
          .map((line) => ({ at: Number(line.at), text: String(line.text ?? "") }))
          .filter((line) => Number.isFinite(line.at) && line.text)
      }))
      .filter((song) => existsSync(song.path));
  } catch {
    return [];
  }
}

// コメントに曲名やキーワードがあればその歌、なければ前回と違う歌をランダムに選ぶ。
export function pickSong(songs, text, lastId = "") {
  const normalized = String(text ?? "").replace(/\s+/g, "");
  const named = songs.find((song) => [song.title, ...song.keywords].some((word) => word && normalized.includes(word.replace(/\s+/g, ""))));
  if (named) return named;
  const others = songs.length > 1 ? songs.filter((song) => song.id !== lastId) : songs;
  return others[Math.floor(Math.random() * others.length)];
}

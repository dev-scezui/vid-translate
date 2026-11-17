/**
 * Subtitle formatting. Pure functions with no Node imports: the server uses
 * them for ?format= downloads and the browser imports the same file from
 * /lib/subtitles.js.
 *
 * Segments look like { start, end, text, translation } (seconds).
 */

const MAX_CUE_CHARS = 84; // ~2 lines of 42, a common subtitle guideline
const MAX_LINE_CHARS = 42;

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** 83.5 -> "00:01:23,500" (SRT) or "00:01:23.500" (VTT). */
export function formatTime(sec, sep = ",") {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** 83.5 -> "01:23", or "1:01:23" past an hour. */
export function formatClock(sec) {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${pad(m)}:${pad(t % 60)}`;
}

/** Greedily pack pieces (each <= max) into chunks <= max, joined by `sep`. */
function pack(pieces, max, sep) {
  const out = [];
  let cur = "";
  for (const p of pieces) {
    if (!cur) cur = p;
    else if (cur.length + sep.length + p.length <= max) cur += sep + p;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Split text into pieces of at most `max` chars, preferring sentence, then clause, then word breaks. */
export function splitText(text, max) {
  text = text.trim().replace(/\s+/g, " ");
  max ??= isCjk(text) ? MAX_CUE_CHARS / 2 : MAX_CUE_CHARS;
  if (text.length <= max) return text ? [text] : [];
  const sentences = text.split(/(?<=[.!?。！？…])\s*/u).filter(Boolean);
  const parts = sentences.flatMap((s) => {
    if (s.length <= max) return [s];
    const clauses = s.split(/(?<=[,;:，、；：])\s*/u).filter(Boolean);
    return clauses.flatMap((c) => {
      if (c.length <= max) return [c];
      const words = c.split(" ");
      if (words.length > 1) return pack(words.flatMap((w) => hardSplit(w, max)), max, " ");
      return hardSplit(c, max); // e.g. CJK text without spaces
    });
  });
  // Re-pack small pieces so cues aren't needlessly short.
  return pack(parts, max, /[　-鿿]/u.test(text) ? "" : " ");
}

function hardSplit(s, max) {
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

const isCjk = (text) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(text);

/** Wrap one cue's text onto at most two balanced lines. */
export function wrapLines(text, max = MAX_LINE_CHARS) {
  // CJK characters are about twice as wide, so wrap them sooner.
  const limit = isCjk(text) ? Math.ceil(max / 2) : max;
  if (text.length <= limit) return text;
  const mid = text.length / 2;
  const nearestToMid = (re) => {
    let best = -1;
    for (let i = 1; i < text.length - 1; i++) {
      if (re.test(text[i]) && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    return best;
  };
  const space = nearestToMid(/ /);
  if (space > 0) return `${text.slice(0, space)}\n${text.slice(space + 1)}`;
  // No spaces (CJK): break after punctuation near the middle, else at the middle.
  const punct = nearestToMid(/[、。，．！？]/u);
  const at = punct > 0 && Math.abs(punct - mid) < text.length / 4 ? punct + 1 : Math.round(mid);
  return `${text.slice(0, at)}\n${text.slice(at)}`;
}

/** Split text into exactly n roughly equal parts at word breaks (or characters, for CJK). */
function splitEven(text, n) {
  if (n <= 1) return [text];
  const units = isCjk(text) && !text.includes(" ") ? [...text] : text.split(" ");
  const sep = units.length === [...text].length ? "" : " ";
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(units.slice(Math.round((i * units.length) / n), Math.round(((i + 1) * units.length) / n)).join(sep));
  }
  return out;
}

/**
 * Turn segments into subtitle cues.
 * track: "translation" | "original" | "bilingual" (translation over original).
 * Long segments are split into several cues, with time shared out by text length.
 */
export function toCues(segments, track = "translation") {
  const cues = [];
  for (const seg of segments) {
    const original = (seg.text ?? "").trim();
    const translated = (seg.translation ?? "").trim() || original;
    if (track === "bilingual") {
      if (!translated) continue;
      if (!original || original === translated) {
        cues.push(...timed(seg, splitText(translated)));
        continue;
      }
      // Cut both languages into the same number of parts so each cue pairs them up.
      const cueChars = (x) => (isCjk(x) ? MAX_CUE_CHARS / 2 : MAX_CUE_CHARS);
      const n = Math.max(Math.ceil(translated.length / cueChars(translated)), Math.ceil(original.length / cueChars(original)));
      const t = splitEven(translated, n);
      const o = splitEven(original, n);
      const pieces = t.map((tp, i) => ({ text: `${wrapLines(tp)}\n${wrapLines(o[i])}`, weight: tp.length }));
      cues.push(...timed(seg, pieces));
      continue;
    }
    cues.push(...timed(seg, splitText(track === "original" ? original : translated)));
  }
  return cues;
}

/** Share a segment's time span across its pieces in proportion to their length. */
function timed(seg, pieces) {
  const items = pieces.map((p) => (typeof p === "string" ? { text: wrapLines(p), weight: p.length } : p));
  const total = items.reduce((n, p) => n + p.weight, 0) || 1;
  let t = seg.start;
  return items.map((p) => {
    const end = t + ((seg.end - seg.start) * p.weight) / total;
    const cue = { start: t, end, text: p.text };
    t = end;
    return cue;
  });
}

export function toSrt(segments, track) {
  return toCues(segments, track)
    .map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}\n`)
    .join("\n");
}

export function toVtt(segments, track) {
  const body = toCues(segments, track)
    .map((c) => `${formatTime(c.start, ".")} --> ${formatTime(c.end, ".")}\n${c.text}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

/** Plain text with a timestamp per segment, e.g. "[00:12] Hello there". */
export function toTimestampedText(segments, track = "translation") {
  return segments
    .map((s) => {
      const o = (s.text ?? "").trim();
      const t = (s.translation ?? "").trim() || o;
      const line = track === "original" ? o : track === "bilingual" && o !== t ? `${t}\n         ${o}` : t;
      return `[${formatClock(s.start)}] ${line}`;
    })
    .join("\n");
}

export const FORMATS = {
  srt: { ext: "srt", mime: "application/x-subrip", render: toSrt },
  vtt: { ext: "vtt", mime: "text/vtt", render: toVtt },
  txt: { ext: "txt", mime: "text/plain", render: toTimestampedText },
};

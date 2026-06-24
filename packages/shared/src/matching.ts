import { pinyin } from "pinyin-pro";
import type { StudentLite, VoiceCandidate, VoiceMatchResult, VoiceSegmentMatch } from "./types";

const SPACE_RE = /\s+/g;
const PUNCT_RE = /[，。、“”‘’；;：:,.!?！？（）()[\]{}<>《》\-_/\\|]/g;
const HONORIFICS_RE = /(同学|学生|作业|已经交了|交了|已交|收到|的本子|本子|也|和|还有|然后|以及|都|已经)/g;
const HARD_SEPARATOR_RE = /[，,、。；;\s\n\r]+/g;
const CHINESE_RE = /^[\u4e00-\u9fa5]{2,4}$/;

interface MatchOptions {
  submittedStudentIds?: Iterable<string>;
}

interface ScoredSpan {
  rawText: string;
  normalizedText: string;
  candidates: VoiceCandidate[];
  score: number;
  nextIndex: number;
}

export function normalizeName(input: string): string {
  return input
    .trim()
    .replace(PUNCT_RE, "")
    .replace(HONORIFICS_RE, "")
    .replace(SPACE_RE, "")
    .toLocaleLowerCase("zh-CN");
}

export function nameToPinyin(input: string): string {
  return nameToPinyinSyllables(input).join("");
}

function nameToPinyinSyllables(input: string): string[] {
  return pinyin(normalizeName(input), {
    toneType: "none",
    type: "array",
    nonZh: "consecutive"
  }).filter(Boolean);
}

function uniqueCandidates(candidates: VoiceCandidate[]): VoiceCandidate[] {
  const byStudent = new Map<string, VoiceCandidate>();
  for (const candidate of candidates) {
    const existing = byStudent.get(candidate.studentId);
    if (!existing || candidate.confidence > existing.confidence) {
      byStudent.set(candidate.studentId, candidate);
    }
  }
  return [...byStudent.values()].sort((a, b) => b.confidence - a.confidence);
}

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a: string, b: string) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

function looseSyllable(input: string) {
  return input
    .replace(/^zh/, "z")
    .replace(/^ch/, "c")
    .replace(/^sh/, "s")
    .replace(/^l/, "n")
    .replace(/^r/, "y")
    .replace(/eng$/, "en")
    .replace(/ing$/, "in")
    .replace(/ang$/, "an");
}

function pinyinSyllableSimilarity(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  let score = 0;
  for (let i = 0; i < maxLen; i += 1) {
    const left = a[i] ?? "";
    const right = b[i] ?? "";
    if (!left || !right) {
      score += 0;
    } else if (left === right) {
      score += 1;
    } else if (looseSyllable(left) === looseSyllable(right)) {
      score += 0.88;
    } else {
      score += Math.max(similarity(left, right), similarity(looseSyllable(left), looseSyllable(right)) * 0.92);
    }
  }
  return score / maxLen;
}

function candidateForStudent(rawText: string, student: StudentLite): VoiceCandidate | null {
  const normalizedText = normalizeName(rawText);
  const normalizedName = normalizeName(student.name);
  const aliases = (student.aliases ?? []).map(normalizeName).filter(Boolean);
  const allNames = [normalizedName, ...aliases];

  if (allNames.includes(normalizedText)) {
    return {
      studentId: student.id,
      name: student.name,
      confidence: normalizedName === normalizedText ? 1 : 0.98,
      reason: normalizedName === normalizedText ? "exact" : "alias"
    };
  }

  const textPinyin = nameToPinyin(normalizedText);
  const namePinyin = nameToPinyin(normalizedName);
  if (textPinyin && textPinyin === namePinyin) {
    return { studentId: student.id, name: student.name, confidence: 0.95, reason: "pinyin_exact" };
  }

  for (const alias of aliases) {
    if (textPinyin && textPinyin === nameToPinyin(alias)) {
      return { studentId: student.id, name: student.name, confidence: 0.94, reason: "alias" };
    }
  }

  const pinyinScore = pinyinSyllableSimilarity(nameToPinyinSyllables(normalizedText), nameToPinyinSyllables(normalizedName));
  const hanziScore = similarity(normalizedText, normalizedName);
  if (pinyinScore >= 0.78) {
    return {
      studentId: student.id,
      name: student.name,
      confidence: Math.min(0.94, 0.58 + pinyinScore * 0.36 + hanziScore * 0.06),
      reason: pinyinScore >= 0.9 ? "pinyin_fuzzy" : "hanzi_fuzzy"
    };
  }

  if (allNames.some((name) => normalizedText.includes(name) || name.includes(normalizedText))) {
    return { studentId: student.id, name: student.name, confidence: 0.78, reason: "contains" };
  }

  const normalizedPinyinSimilarity = similarity(textPinyin, namePinyin);
  if (normalizedPinyinSimilarity >= 0.72) {
    return {
      studentId: student.id,
      name: student.name,
      confidence: Math.min(0.85, 0.45 + normalizedPinyinSimilarity * 0.4),
      reason: "partial"
    };
  }

  return null;
}

function rankCandidates(rawText: string, students: StudentLite[]) {
  return uniqueCandidates(students.flatMap((student) => {
    const candidate = candidateForStudent(rawText, student);
    return candidate ? [candidate] : [];
  })).slice(0, 5);
}

function confidentCandidate(candidates: VoiceCandidate[]) {
  const top = candidates[0];
  const runnerUp = candidates[1];
  const ambiguous = Boolean(top && runnerUp && top.confidence - runnerUp.confidence < 0.08);
  const confident = Boolean(top && top.confidence >= 0.88 && !ambiguous);
  return { top, ambiguous, confident };
}

function toSegment(rawText: string, students: StudentLite[], submittedStudentIds: Set<string>): VoiceSegmentMatch {
  const normalizedText = normalizeName(rawText);
  const candidates = rankCandidates(rawText, students);
  const { top, ambiguous, confident } = confidentCandidate(candidates);
  const matched = confident && top ? top : null;
  const status = matched
    ? submittedStudentIds.has(matched.studentId)
      ? "duplicate"
      : "auto_submitted"
    : candidates.length
      ? "pending_confirm"
      : "unmatched";
  return {
    rawText,
    normalizedText,
    matchedStudentId: matched?.studentId ?? null,
    matchedStudentName: matched?.name ?? null,
    confidence: top?.confidence ?? 0,
    reason: top ? (ambiguous ? "ambiguous" : top.reason) : "none",
    status,
    candidates
  };
}

export function matchStudentName(rawText: string, students: StudentLite[]): VoiceMatchResult {
  const segment = toSegment(rawText, students, new Set());
  return {
    rawText,
    normalizedText: segment.normalizedText,
    matchedStudentId: segment.status === "auto_submitted" ? segment.matchedStudentId : null,
    confidence: segment.confidence,
    reason: segment.reason,
    candidates: segment.candidates,
    needsConfirmation: segment.status !== "auto_submitted"
  };
}

function splitBySeparators(rawText: string) {
  return rawText
    .split(HARD_SEPARATOR_RE)
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreSpan(rawText: string, start: number, length: number, students: StudentLite[]): ScoredSpan | null {
  const raw = rawText.slice(start, start + length);
  const normalized = normalizeName(raw);
  if (!normalized) return null;
  const candidates = rankCandidates(normalized, students);
  const top = candidates[0];
  if (!top || top.confidence < 0.72) return null;
  const lengthBonus = length === 3 ? 0.03 : length === 2 ? 0.01 : 0;
  return {
    rawText: raw,
    normalizedText: normalized,
    candidates,
    score: top.confidence + lengthBonus,
    nextIndex: start + length
  };
}

function splitContinuousText(rawText: string, students: StudentLite[]) {
  const normalized = normalizeName(rawText);
  if (!normalized) return [];
  const dp = new Array<number>(normalized.length + 1).fill(Number.NEGATIVE_INFINITY);
  const next = new Array<ScoredSpan | null>(normalized.length).fill(null);
  dp[normalized.length] = 0;

  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    for (const length of [4, 3, 2]) {
      if (index + length > normalized.length) continue;
      const span = scoreSpan(normalized, index, length, students);
      if (!span) continue;
      const value = span.score + dp[span.nextIndex];
      if (value > dp[index]) {
        dp[index] = value;
        next[index] = span;
      }
    }
    if (dp[index] === Number.NEGATIVE_INFINITY) {
      dp[index] = dp[index + 1] - 0.2;
    }
  }

  const parts: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const span = next[index];
    if (span) {
      parts.push(span.rawText);
      index = span.nextIndex;
    } else {
      let end = index + 1;
      while (end < normalized.length && !next[end]) end += 1;
      parts.push(normalized.slice(index, end));
      index = end;
    }
  }
  return parts.filter(Boolean);
}

export function matchStudentNameSequence(rawText: string, students: StudentLite[], options: MatchOptions = {}) {
  const submittedStudentIds = new Set(options.submittedStudentIds ?? []);
  const separated = splitBySeparators(rawText);
  const rawSegments = separated.length > 1
    ? separated.flatMap((part) => splitContinuousText(part, students))
    : splitContinuousText(rawText, students);
  const segments = (rawSegments.length ? rawSegments : [rawText]).map((segment) => toSegment(segment, students, submittedStudentIds));
  const submittedStudentIdsResult: string[] = [];
  const duplicateStudentIds: string[] = [];
  const pending: VoiceSegmentMatch[] = [];
  const unmatched: VoiceSegmentMatch[] = [];

  for (const segment of segments) {
    if (segment.status === "auto_submitted" && segment.matchedStudentId) {
      submittedStudentIds.add(segment.matchedStudentId);
      submittedStudentIdsResult.push(segment.matchedStudentId);
    } else if (segment.status === "duplicate" && segment.matchedStudentId) {
      duplicateStudentIds.push(segment.matchedStudentId);
    } else if (segment.status === "pending_confirm") {
      pending.push(segment);
    } else if (segment.status === "unmatched") {
      unmatched.push(segment);
    }
  }

  return {
    rawText,
    segments,
    submittedStudentIds: submittedStudentIdsResult,
    pending,
    unmatched,
    duplicateStudentIds
  };
}

export function shouldLearnVoiceAlias(rawText: string) {
  const normalized = normalizeName(rawText);
  return CHINESE_RE.test(normalized) ? normalized : null;
}

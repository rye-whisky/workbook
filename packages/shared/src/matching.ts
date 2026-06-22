import { pinyin } from "pinyin-pro";
import type { StudentLite, VoiceCandidate, VoiceMatchResult } from "./types";

const SPACE_RE = /\s+/g;
const PUNCT_RE = /[，。、“”‘’；;：:,.!?！？（）()[\]{}<>《》\-_/\\|]/g;
const HONORIFICS_RE = /(同学|学生|作业|已经交了|交了|已交|收到|的本子|本子)/g;

export function normalizeName(input: string): string {
  return input
    .trim()
    .replace(PUNCT_RE, "")
    .replace(HONORIFICS_RE, "")
    .replace(SPACE_RE, "")
    .toLocaleLowerCase("zh-CN");
}

export function nameToPinyin(input: string): string {
  return pinyin(normalizeName(input), {
    toneType: "none",
    type: "array",
    nonZh: "consecutive"
  }).join("");
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

export function matchStudentName(rawText: string, students: StudentLite[]): VoiceMatchResult {
  const normalizedText = normalizeName(rawText);
  if (!normalizedText || students.length === 0) {
    return {
      rawText,
      normalizedText,
      matchedStudentId: null,
      confidence: 0,
      reason: "none",
      candidates: [],
      needsConfirmation: true
    };
  }

  const textPinyin = nameToPinyin(normalizedText);
  const candidates: VoiceCandidate[] = [];

  for (const student of students) {
    const normalizedName = normalizeName(student.name);
    const aliases = (student.aliases ?? []).map(normalizeName).filter(Boolean);
    const allNames = [normalizedName, ...aliases];

    if (allNames.includes(normalizedText)) {
      candidates.push({
        studentId: student.id,
        name: student.name,
        confidence: normalizedName === normalizedText ? 1 : 0.96,
        reason: normalizedName === normalizedText ? "exact" : "alias"
      });
      continue;
    }

    if (allNames.some((name) => normalizedText.includes(name) || name.includes(normalizedText))) {
      candidates.push({
        studentId: student.id,
        name: student.name,
        confidence: 0.78,
        reason: "contains"
      });
      continue;
    }

    const namePinyin = nameToPinyin(normalizedName);
    if (namePinyin && textPinyin === namePinyin) {
      candidates.push({
        studentId: student.id,
        name: student.name,
        confidence: 0.9,
        reason: "pinyin"
      });
      continue;
    }

    if (namePinyin && (textPinyin.includes(namePinyin) || namePinyin.includes(textPinyin))) {
      candidates.push({
        studentId: student.id,
        name: student.name,
        confidence: 0.62,
        reason: "partial"
      });
    }
  }

  const ranked = uniqueCandidates(candidates).slice(0, 5);
  const top = ranked[0];
  const runnerUp = ranked[1];
  const ambiguous = Boolean(top && runnerUp && top.confidence - runnerUp.confidence < 0.08);
  const confident = Boolean(top && top.confidence >= 0.88 && !ambiguous);

  return {
    rawText,
    normalizedText,
    matchedStudentId: confident ? top.studentId : null,
    confidence: top?.confidence ?? 0,
    reason: top ? (ambiguous ? "ambiguous" : top.reason) : "none",
    candidates: ranked,
    needsConfirmation: !confident
  };
}

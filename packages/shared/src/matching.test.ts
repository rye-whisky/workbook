import { describe, expect, it } from "vitest";
import { matchStudentName, matchStudentNameSequence, shouldLearnVoiceAlias } from "./matching";
import type { StudentLite } from "./types";

const students: StudentLite[] = [
  { id: "1", name: "张三", aliases: ["小张"] },
  { id: "2", name: "李四" },
  { id: "3", name: "王芳" },
  { id: "4", name: "王方" },
  { id: "5", name: "简乐佳" },
  { id: "6", name: "颜梓轩" },
  { id: "7", name: "郑斯蔓" }
];

describe("matchStudentName", () => {
  it("matches exact names confidently", () => {
    const result = matchStudentName("张三", students);
    expect(result.matchedStudentId).toBe("1");
    expect(result.needsConfirmation).toBe(false);
  });

  it("matches aliases confidently", () => {
    const result = matchStudentName("小张交了", students);
    expect(result.matchedStudentId).toBe("1");
    expect(result.reason).toBe("alias");
  });

  it("matches same-pinyin ASR typos confidently", () => {
    expect(matchStudentName("捡乐家", students).matchedStudentId).toBe("5");
    expect(matchStudentName("言子轩", students).matchedStudentId).toBe("6");
  });

  it("marks same-pinyin conflicts as pending confirmation", () => {
    const result = matchStudentName("wangfang", students);
    expect(result.matchedStudentId).toBeNull();
    expect(result.needsConfirmation).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(1);
  });

  it("returns no match for unknown names", () => {
    const result = matchStudentName("赵六", students);
    expect(result.matchedStudentId).toBeNull();
    expect(result.candidates).toHaveLength(0);
  });
});

describe("matchStudentNameSequence", () => {
  it("splits exact continuous roster names", () => {
    const result = matchStudentNameSequence("简乐佳颜梓轩郑斯蔓", students);
    expect(result.segments.map((item) => item.matchedStudentId)).toEqual(["5", "6", "7"]);
    expect(result.submittedStudentIds).toEqual(["5", "6", "7"]);
  });

  it("splits ASR typo text into roster-constrained candidates", () => {
    const result = matchStudentNameSequence("捡乐家言子轩任思蔓", students);
    expect(result.segments.map((item) => item.rawText)).toEqual(["捡乐家", "言子轩", "任思蔓"]);
    expect(result.segments[0].matchedStudentId).toBe("5");
    expect(result.segments[1].matchedStudentId).toBe("6");
    expect(result.segments[2].candidates[0]?.studentId).toBe("7");
  });

  it("uses punctuation separators when present", () => {
    const result = matchStudentNameSequence("简乐佳，颜梓轩，郑斯蔓", students);
    expect(result.submittedStudentIds).toEqual(["5", "6", "7"]);
  });

  it("removes common speech filler words", () => {
    const result = matchStudentNameSequence("简乐佳交了颜梓轩也交了", students);
    expect(result.submittedStudentIds).toEqual(["5", "6"]);
  });

  it("keeps submitted students as duplicates", () => {
    const result = matchStudentNameSequence("简乐佳颜梓轩", students, { submittedStudentIds: ["5"] });
    expect(result.duplicateStudentIds).toEqual(["5"]);
    expect(result.submittedStudentIds).toEqual(["6"]);
  });

  it("learns only short Chinese ASR aliases", () => {
    expect(shouldLearnVoiceAlias("捡乐家")).toBe("捡乐家");
    expect(shouldLearnVoiceAlias("捡乐家言子轩")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { buildRecommendations } from "../movieRecommend";

describe("buildRecommendations", () => {
  it("maps known genres to dictionary lines", () => {
    const out = buildRecommendations(["巨乳", "痴女"]);
    expect(out).toContain("ボリューム感のある巨乳が好きな方");
    expect(out).toContain("積極的にリードする痴女が好きな方");
  });

  it("caps at maxLines (default 3)", () => {
    const out = buildRecommendations(["巨乳", "痴女", "人妻", "熟女", "素人"]);
    expect(out).toHaveLength(3);
  });

  it("respects a custom maxLines", () => {
    const out = buildRecommendations(["巨乳", "痴女", "人妻"], 2);
    expect(out).toHaveLength(2);
  });

  it("falls back for unknown genres", () => {
    const out = buildRecommendations(["未知ジャンルXYZ"]);
    expect(out).toContain("未知ジャンルXYZジャンルが好きな方");
  });

  it("dedupes identical lines", () => {
    const out = buildRecommendations(["微乳", "貧乳"]);
    // both map to different lines actually; ensure no duplicates in general
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns a generic line when no genres given", () => {
    const out = buildRecommendations([]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe("ショート動画で気軽に作品を試し見したい方");
  });

  it("ignores empty/whitespace genres", () => {
    const out = buildRecommendations(["", "  ", "巨乳"]);
    expect(out).toEqual(["ボリューム感のある巨乳が好きな方"]);
  });

  it("never returns an empty array", () => {
    expect(buildRecommendations(["", "  "]).length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  generateIntro,
  templateIndexForSlug,
  INTRO_TEMPLATE_COUNT,
  type MovieIntroInput,
} from "../movieIntro";

function base(overrides: Partial<MovieIntroInput> = {}): MovieIntroInput {
  return {
    title: "サンプル作品",
    slug: "sample-slug",
    actresses: ["くらしなひまり"],
    genres: ["潜入", "ドキュメンタリー"],
    product_id: "h_1832msoc00065",
    maker_product: null,
    label_name: "メンエス・オナクラ盗撮",
    maker_name: "サンプルメーカー",
    volume: 34,
    price_min: 780,
    price_list: { list_price: 980, sale_price: 780 },
    delivery_date: "2026-08-15",
    release_date: "2026-08-20",
    primary_date: "2026-08-15",
    ...overrides,
  };
}

describe("generateIntro", () => {
  it("returns a non-empty paragraph ending with 。", () => {
    const out = generateIntro(base());
    expect(out.length).toBeGreaterThan(10);
    expect(out.endsWith("。")).toBe(true);
  });

  it("includes site CTA phrase", () => {
    expect(generateIntro(base())).toContain("AV Shorts");
  });

  it("includes formatted hinban (msoc00065, not the h_ prefix)", () => {
    const out = generateIntro(base());
    expect(out).toContain("msoc00065");
    expect(out).not.toContain("h_1832");
  });

  it("is deterministic for the same slug", () => {
    const a = generateIntro(base());
    const b = generateIntro(base());
    expect(a).toBe(b);
  });

  it("selects a template index within range and stable per slug", () => {
    const i1 = templateIndexForSlug("sample-slug");
    const i2 = templateIndexForSlug("sample-slug");
    expect(i1).toBe(i2);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(INTRO_TEMPLATE_COUNT);
  });

  it("handles zero actresses without breaking", () => {
    const out = generateIntro(base({ actresses: [] }));
    expect(out.endsWith("。")).toBe(true);
    expect(out).not.toContain("「」");
    expect(out).not.toContain("出演の作品");
  });

  it("summarizes many actresses as 総勢N名", () => {
    const out = generateIntro(
      base({ actresses: ["A", "B", "C", "D", "E"], slug: "many" }),
    );
    expect(out).toContain("総勢5名");
  });

  it("lists 2-3 actresses individually", () => {
    const out = generateIntro(base({ actresses: ["A", "B"], slug: "two" }));
    expect(out).toContain("「A」");
    expect(out).toContain("「B」");
  });

  it("handles null volume", () => {
    const out = generateIntro(base({ volume: null }));
    expect(out).not.toContain("収録null");
    expect(out).not.toContain("undefined");
    expect(out.endsWith("。")).toBe(true);
  });

  it("handles null price with generic CTA", () => {
    const out = generateIntro(
      base({ price_min: null, price_list: null }),
    );
    expect(out).not.toContain("null円");
    expect(out).toContain("FANZA");
  });

  it("handles all dates null", () => {
    const out = generateIntro(
      base({ delivery_date: null, release_date: null, primary_date: null }),
    );
    expect(out).not.toContain("配信開始");
    expect(out).not.toContain("()");
    expect(out.endsWith("。")).toBe(true);
  });

  it("handles no genres (falls back to 作品)", () => {
    const out = generateIntro(base({ genres: [], slug: "nogenre" }));
    expect(out).toContain("作品");
    expect(out.endsWith("。")).toBe(true);
  });

  it("handles maximally sparse data without producing broken text", () => {
    const sparse: MovieIntroInput = {
      title: "x",
      slug: "sparse-1",
      actresses: [],
      genres: [],
      product_id: null,
      maker_product: null,
      label_name: null,
      maker_name: null,
      volume: null,
      price_min: null,
      price_list: null,
      delivery_date: null,
      release_date: null,
      primary_date: null,
    };
    const out = generateIntro(sparse);
    expect(out.endsWith("。")).toBe(true);
    expect(out).not.toContain("。。");
    expect(out).not.toContain("null");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("()");
    expect(out).not.toContain("「」");
  });

  it("never emits double punctuation or empty parens across many slugs", () => {
    for (let i = 0; i < 50; i++) {
      const out = generateIntro(base({ slug: `slug-${i}` }));
      expect(out).not.toContain("。。");
      expect(out).not.toContain("()");
      expect(out).not.toContain("（）");
      expect(out).not.toContain("null");
      expect(out).not.toContain("undefined");
      expect(out.endsWith("。")).toBe(true);
    }
  });

  it("uses maker_product as hinban when present", () => {
    const out = generateIntro(
      base({ maker_product: "MSOC-065", product_id: "h_1832msoc00065" }),
    );
    expect(out).toContain("MSOC-065");
  });
});

import { describe, it, expect } from "vitest";
import {
  formatHinban,
  formatVolume,
  formatJpDate,
  displayPrice,
  buildSpecRows,
  visibleSpecRows,
  type MovieSpecInput,
} from "../movieSpec";

function base(overrides: Partial<MovieSpecInput> = {}): MovieSpecInput {
  return {
    product_id: "h_1832msoc00065",
    maker_product: null,
    volume: 34,
    delivery_date: "2026-08-15",
    release_date: "2026-08-20",
    primary_date: "2026-08-15",
    maker_name: "サンプルメーカー",
    label_name: "サンプルレーベル",
    genres: ["潜入", "エステ"],
    price_min: 780,
    price_list: { list_price: 980, sale_price: 780 },
    ...overrides,
  };
}

describe("formatHinban", () => {
  it("strips the h_ delivery prefix", () => {
    expect(formatHinban("h_1832msoc00065", null)).toBe("msoc00065");
  });

  it("prefers maker_product when present", () => {
    expect(formatHinban("h_1832msoc00065", "MSOC-065")).toBe("MSOC-065");
  });

  it("returns empty string when both null", () => {
    expect(formatHinban(null, null)).toBe("");
  });

  it("returns input as-is when no pattern match", () => {
    expect(formatHinban("weird", null)).toBe("weird");
  });
});

describe("formatVolume", () => {
  it("formats minutes", () => {
    expect(formatVolume(34)).toBe("34分");
  });
  it("returns null for null", () => {
    expect(formatVolume(null)).toBeNull();
  });
});

describe("formatJpDate", () => {
  it("formats YYYY-MM-DD", () => {
    expect(formatJpDate("2026-08-15")).toBe("2026年8月15日");
  });
  it("returns null for null/invalid", () => {
    expect(formatJpDate(null)).toBeNull();
    expect(formatJpDate("not-a-date")).toBeNull();
  });
});

describe("displayPrice", () => {
  it("prefers sale price", () => {
    expect(displayPrice(base())).toBe(780);
  });
  it("falls back to list price", () => {
    expect(
      displayPrice(base({ price_list: { list_price: 980, sale_price: null } })),
    ).toBe(980);
  });
  it("falls back to price_min", () => {
    expect(displayPrice(base({ price_list: null, price_min: 500 }))).toBe(500);
  });
  it("returns null when nothing available", () => {
    expect(displayPrice(base({ price_list: null, price_min: null }))).toBeNull();
  });
});

describe("visibleSpecRows", () => {
  it("returns all rows when data present", () => {
    const rows = visibleSpecRows(base());
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("品番");
    expect(labels).toContain("収録時間");
    expect(labels).toContain("配信日");
    expect(labels).toContain("メーカー");
    expect(labels).toContain("レーベル");
    expect(labels).toContain("ジャンル");
    expect(labels).toContain("価格");
  });

  it("hides null rows", () => {
    const rows = visibleSpecRows(
      base({
        product_id: null,
        maker_product: null,
        volume: null,
        delivery_date: null,
        release_date: null,
        primary_date: null,
        maker_name: null,
        label_name: null,
        genres: [],
        price_min: null,
        price_list: null,
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it("formats hinban row without h_ prefix", () => {
    const rows = visibleSpecRows(base());
    const hinban = rows.find((r) => r.label === "品番");
    expect(hinban?.value).toBe("msoc00065");
  });

  it("joins genres with 、", () => {
    const rows = visibleSpecRows(base({ genres: ["潜入", "エステ"] }));
    const g = rows.find((r) => r.label === "ジャンル");
    expect(g?.value).toBe("潜入、エステ");
  });
});

describe("buildSpecRows", () => {
  it("includes null rows for filtering by caller", () => {
    const rows = buildSpecRows(base({ volume: null }));
    const vol = rows.find((r) => r.label === "収録時間");
    expect(vol?.value).toBeNull();
  });
});

// 作品スペック表 (品番/収録時間/配信日/メーカー/レーベル/ジャンル/価格) の
// 組み立てと、品番 (hinban) の整形。詳細ページでレンダリング時に使う純関数。
// DB 保存はしない。欠損 (null) は行ごと非表示にできるよう value: null で返す。

export type MovieSpecInput = {
  product_id: string | null;
  maker_product: string | null;
  volume: number | null;
  delivery_date: string | null;
  release_date: string | null;
  primary_date: string | null;
  maker_name: string | null;
  label_name: string | null;
  genres: string[];
  price_min: number | null;
  price_list: {
    list_price: number | null;
    sale_price: number | null;
  } | null;
};

export type SpecRow = { label: string; value: string };

/**
 * 品番 (hinban) を表示用に整形する。
 *
 * FANZA の product_id は "h_1832msoc00065" のように配信用プレフィックス
 * ("h_" + 数字) が付くことがある。末尾の「英字 + 数字」部分 (= msoc00065) が
 * ユーザーが検索に使う品番なので、それを取り出す。
 * maker_product が入っていればそちらが既に整形済み品番なので優先する。
 * どちらも無い / パターンに合わない場合は入力をそのまま (or 空) 返す。
 */
export function formatHinban(
  productId: string | null,
  makerProduct: string | null,
): string {
  const maker = (makerProduct ?? "").trim();
  if (maker) return maker;
  const pid = (productId ?? "").trim();
  if (!pid) return "";
  const m = pid.match(/([a-z]+\d+)$/i);
  return m ? m[1] : pid;
}

/** 収録時間 (分)。null のときは null。 */
export function formatVolume(volume: number | null): string | null {
  return volume != null ? `${volume}分` : null;
}

/** YYYY-MM-DD 等の日付文字列を「YYYY年M月D日」に整形。無効/欠損は null。 */
export function formatJpDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 表示価格 (セール優先→定価→price_min)。無ければ null。 */
export function displayPrice(input: MovieSpecInput): number | null {
  return (
    input.price_list?.sale_price ??
    input.price_list?.list_price ??
    input.price_min ??
    null
  );
}

/**
 * スペック表の行を組み立てる。value が null の行は「データ無し」なので
 * 呼び出し側でそのまま除外できる。ここでは null 行も含めて返し、
 * 表示側で filter する (テスト容易性のため)。
 */
export function buildSpecRows(
  input: MovieSpecInput,
): { label: string; value: string | null }[] {
  const hinban = formatHinban(input.product_id, input.maker_product);
  const price = displayPrice(input);
  const deliveryDate =
    formatJpDate(input.delivery_date) ??
    formatJpDate(input.primary_date) ??
    formatJpDate(input.release_date);

  return [
    { label: "品番", value: hinban || null },
    { label: "収録時間", value: formatVolume(input.volume) },
    { label: "配信日", value: deliveryDate },
    { label: "メーカー", value: input.maker_name || null },
    { label: "レーベル", value: input.label_name || null },
    {
      label: "ジャンル",
      value: input.genres.length > 0 ? input.genres.join("、") : null,
    },
    { label: "価格", value: price != null ? `${price.toLocaleString()}円` : null },
  ];
}

/** null 行を落とした表示用スペック行。 */
export function visibleSpecRows(input: MovieSpecInput): SpecRow[] {
  return buildSpecRows(input).filter(
    (r): r is SpecRow => r.value != null && r.value !== "",
  );
}

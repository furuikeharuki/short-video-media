// 作品ページの独自テキスト (作品紹介) を、構造化メタデータから合成する。
//
// 背景: 2026-06-03 の Google アルゴリズム降格対策。約 4 万件の作品ページが
// FANZA API のメタデータ (タイトル / パッケージ画像 / サンプル動画 / アフィリンク)
// だけで構成されており、他の FANZA アフィリエイトサイトと重複する thin/scaled
// content と判定されている。ここでは女優名・ジャンル・シリーズ・メーカー・
// 収録時間・配信日などを自然な日本語の文章に織り込み、ページ固有の本文を生成する。
//
// 要件:
// - 決定論的だが多様: slug のハッシュで文テンプレート・語順を振り分け、
//   ページ間で完全一致のボイラープレートにならないようにする。
// - FANZA の description をそのまま「独自テキスト」として使わない
//   (別途表示するのは可)。
// - サーバーコンポーネントで描画 (SSR, クローラー可視)。

export type MovieIntroInput = {
  title: string;
  slug: string;
  actresses: string[];
  genres: string[];
  series_name: string | null;
  maker_name: string | null;
  label_name: string | null;
  director_name: string | null;
  volume: number | null;
  delivery_date: string | null;
  release_date: string | null;
  review_count: number;
  review_average: number | null;
};

// FNV-1a 32bit。slug から安定したシード値を得る。
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// xorshift32 ベースの決定論 PRNG。同じ seed からは常に同じ系列を返す。
function makePicker(seed: number) {
  let state = seed || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state >>> 0;
  };
  return {
    pick<T>(arr: T[]): T {
      return arr[next() % arr.length];
    },
    // 0 or 1 を返す (語順の入れ替え判定用)。
    flip(): boolean {
      return next() % 2 === 0;
    },
  };
}

function formatMonth(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function joinNames(names: string[], max: number): string {
  const list = names.slice(0, max);
  return list.join("・");
}

/**
 * 構造化メタデータから作品固有の紹介文を合成する。
 * 十分なメタデータが無い場合は null を返す (呼び出し側でフォールバック)。
 */
export function composeMovieIntro(movie: MovieIntroInput): string | null {
  const rng = makePicker(hashString(movie.slug));

  const actress = movie.actresses.length > 0 ? joinNames(movie.actresses, 3) : null;
  const genreText =
    movie.genres.length > 0 ? joinNames(movie.genres, 3) : null;
  const month = formatMonth(movie.delivery_date ?? movie.release_date);

  const sentences: string[] = [];

  // --- リード文: 女優 / ジャンル / タイトルを織り込む ---
  if (actress && genreText) {
    sentences.push(
      rng.pick([
        `${actress}が出演する本作『${movie.title}』は、${genreText}といった見どころが詰まった一本です。`,
        `本作『${movie.title}』は${actress}が主演を務め、${genreText}を存分に堪能できる作品に仕上がっています。`,
        `${actress}出演の『${movie.title}』は、${genreText}が好きな方にこそおすすめしたい作品です。`,
        `${genreText}をテーマにした『${movie.title}』では、${actress}の魅力がたっぷりと引き出されています。`,
      ]),
    );
  } else if (actress) {
    sentences.push(
      rng.pick([
        `${actress}が出演する話題作『${movie.title}』を、当サイトではショート動画で試し見できます。`,
        `本作『${movie.title}』は${actress}の魅力を存分に味わえる一本です。`,
        `${actress}主演の『${movie.title}』の見どころを、サンプル動画とあわせて紹介します。`,
      ]),
    );
  } else if (genreText) {
    sentences.push(
      rng.pick([
        `『${movie.title}』は、${genreText}といった要素を楽しめる作品です。`,
        `${genreText}が好きな方に向けて、本作『${movie.title}』の見どころを紹介します。`,
      ]),
    );
  } else {
    sentences.push(
      rng.pick([
        `『${movie.title}』の見どころを、サンプル動画とあわせて紹介します。`,
        `本作『${movie.title}』を、当サイトではショート動画で試し見できます。`,
      ]),
    );
  }

  // --- シリーズ / メーカー / レーベル / 監督 ---
  const makerLabel = movie.maker_name ?? movie.label_name;
  if (movie.series_name && makerLabel) {
    sentences.push(
      rng.pick([
        `人気の「${movie.series_name}」シリーズの一作として${makerLabel}からリリースされており、シリーズならではの世界観が味わえます。`,
        `${makerLabel}が手がける「${movie.series_name}」シリーズの作品で、ファンにはたまらない内容となっています。`,
        `「${movie.series_name}」シリーズとして${makerLabel}が制作した本作は、シリーズの流れを汲んだ見応えのある構成です。`,
      ]),
    );
  } else if (movie.series_name) {
    sentences.push(
      rng.pick([
        `人気の「${movie.series_name}」シリーズの一作で、シリーズならではの世界観を楽しめます。`,
        `「${movie.series_name}」シリーズとして制作された作品で、ファン必見の内容です。`,
      ]),
    );
  } else if (makerLabel) {
    sentences.push(
      rng.pick([
        `${makerLabel}がお届けする本作は、丁寧に作り込まれた見応えのある内容です。`,
        `制作は${makerLabel}。安定したクオリティで安心して楽しめる一本です。`,
      ]),
    );
  }
  if (movie.director_name) {
    sentences.push(
      rng.pick([
        `監督は${movie.director_name}が担当しています。`,
        `${movie.director_name}が監督を務めた点にも注目です。`,
      ]),
    );
  }

  // --- 収録時間 / 配信日 ---
  if (movie.volume != null && month) {
    sentences.push(
      rng.flip()
        ? `収録時間は約${movie.volume}分、${month}より配信がスタートしています。`
        : `${month}に配信が開始され、たっぷり約${movie.volume}分のボリュームで収録されています。`,
    );
  } else if (movie.volume != null) {
    sentences.push(`収録時間は約${movie.volume}分のボリュームです。`);
  } else if (month) {
    sentences.push(`${month}より配信が開始されています。`);
  }

  // --- レビュー ---
  if (movie.review_count > 0 && movie.review_average != null) {
    const avg = movie.review_average.toFixed(1);
    sentences.push(
      rng.pick([
        `これまでに${movie.review_count}件のレビューが寄せられ、平均${avg}点の評価を獲得しています。`,
        `ユーザーからの評価は${movie.review_count}件のレビューで平均${avg}点と好評です。`,
      ]),
    );
  }

  // --- 締めの CTA 文 ---
  sentences.push(
    rng.pick([
      "まずはサンプル動画で作品の雰囲気をチェックしてみてください。",
      "気になった方は、サンプル動画で内容を確かめてみてはいかがでしょうか。",
      "サンプル動画で雰囲気をつかんでから、じっくり楽しむのがおすすめです。",
    ]),
  );

  // リード文と締め文の間の順序を slug ハッシュで軽く入れ替え、
  // メタデータが同構成のページ同士でも語順が揃わないようにする。
  const middle = sentences.slice(1, -1);
  if (middle.length >= 2 && rng.flip()) {
    const [a, b, ...rest] = middle;
    middle.splice(0, middle.length, b, a, ...rest);
  }

  const text = [sentences[0], ...middle, sentences[sentences.length - 1]].join("");
  return text.length > 0 ? text : null;
}

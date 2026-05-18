"use client";

/**
 * 詳細検索パネル (Header のドロップダウン内に展開して使う)。
 *
 * 仕様:
 * - 6 フィールド (genre / actress / series / director / maker / label) を
 *   テキスト入力 + サジェスト + チップ追加で複数選択。
 *   - genre / actress は AND、それ以外は OR (API 側の挙動)。UI 表示としては全部チップで揃える。
 * - 配信日 from / to を date input で。
 * - ソートキーは 5 種類: 新着 / 人気 / 評価 / 視聴回数 / ブックマーク数。
 * - NG ワード: ログイン中は サーバ保存 (PUT /me/ng-words)。未ログインは「この検索だけ」のローカル。
 *   - 親が isAuthed を渡す。
 * - 「この条件で検索」ボタンを押すと URL クエリを組み立てて `/search` へ遷移する。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildAdvancedSearchParams,
  suggestFieldValues,
  type AdvancedSearchInput,
  type SortKey,
  type SuggestField,
} from "@/lib/api/search";
import { getNgWords, putNgWords } from "@/lib/api/me";

type Props = {
  /** ログイン中かどうか。サーバ NG ワード保存 UI の出し分けに使う。 */
  isAuthed: boolean;
  /** 検索実行時に呼ばれる (Header 側でドロップダウンを閉じる用)。 */
  onSubmit: (url: string) => void;
};

type FieldKey = "genres" | "actresses" | "series_list" | "directors" | "makers" | "labels";

const FIELD_LABELS: Record<FieldKey, string> = {
  genres: "ジャンル (AND)",
  actresses: "女優 (AND)",
  series_list: "シリーズ",
  directors: "監督",
  makers: "メーカー",
  labels: "レーベル",
};

const FIELD_TO_SUGGEST: Record<FieldKey, SuggestField> = {
  genres: "genre",
  actresses: "actress",
  series_list: "series",
  directors: "director",
  makers: "maker",
  labels: "label",
};

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "new", label: "新着順" },
  { value: "popular", label: "人気順" },
  { value: "rating", label: "評価順" },
  { value: "views", label: "視聴回数順" },
  { value: "bookmarks", label: "ブックマーク数順" },
];

export default function AdvancedSearchPanel({ isAuthed, onSubmit }: Props) {
  const [q, setQ] = useState("");
  const [chips, setChips] = useState<Record<FieldKey, string[]>>({
    genres: [],
    actresses: [],
    series_list: [],
    directors: [],
    makers: [],
    labels: [],
  });
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<SortKey | "">("");

  // NG ワード: サーバ保存 (ログイン時) は別 state、ローカルのみは ngLocal
  const [ngServer, setNgServer] = useState<string[]>([]);
  const [ngLocal, setNgLocal] = useState<string[]>([]);
  const [ngInput, setNgInput] = useState("");
  const [ngSaving, setNgSaving] = useState(false);
  const [ngSavedHint, setNgSavedHint] = useState(false);

  // ログイン中なら初回マウントでサーバ NG ワードをロード
  useEffect(() => {
    if (!isAuthed) {
      setNgServer([]);
      return;
    }
    let cancelled = false;
    getNgWords()
      .then((words) => {
        if (!cancelled) setNgServer(words);
      })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [isAuthed]);

  const addChip = useCallback((key: FieldKey, value: string) => {
    const v = value.trim();
    if (!v) return;
    setChips((prev) => {
      if (prev[key].includes(v)) return prev;
      return { ...prev, [key]: [...prev[key], v] };
    });
  }, []);

  const removeChip = useCallback((key: FieldKey, value: string) => {
    setChips((prev) => ({
      ...prev,
      [key]: prev[key].filter((s) => s !== value),
    }));
  }, []);

  // NG ワード操作
  const addNg = useCallback(() => {
    const v = ngInput.trim();
    if (!v) return;
    if (isAuthed) {
      setNgServer((prev) => (prev.includes(v) ? prev : [...prev, v]));
    } else {
      setNgLocal((prev) => (prev.includes(v) ? prev : [...prev, v]));
    }
    setNgInput("");
  }, [ngInput, isAuthed]);

  const removeNg = useCallback((value: string) => {
    if (isAuthed) {
      setNgServer((prev) => prev.filter((s) => s !== value));
    } else {
      setNgLocal((prev) => prev.filter((s) => s !== value));
    }
  }, [isAuthed]);

  const saveNgServer = useCallback(async () => {
    if (!isAuthed) return;
    setNgSaving(true);
    setNgSavedHint(false);
    try {
      const ok = await putNgWords(ngServer);
      if (ok) {
        setNgSavedHint(true);
        setTimeout(() => setNgSavedHint(false), 2000);
      }
    } finally {
      setNgSaving(false);
    }
  }, [isAuthed, ngServer]);

  const handleSubmit = useCallback(() => {
    // 実検索に使う NG ワード:
    //   ログイン時: ngServer 内容をクエリには乗せず、サーバ側 user_ng_words を自動適用
    //              ただしユーザーが画面で編集した状態の方を使いたいので、未保存でも明示的に
    //              クエリに ngServer を送る (= サーバの永続値より「いま画面に映っているもの」を優先)
    //   未ログイン時: ngLocal を必ずクエリに乗せる (その検索だけ適用)
    const ngWords = isAuthed ? ngServer : ngLocal;
    const input: AdvancedSearchInput = {
      q: q.trim() || undefined,
      genres: chips.genres.length > 0 ? chips.genres : undefined,
      actresses: chips.actresses.length > 0 ? chips.actresses : undefined,
      series_list: chips.series_list.length > 0 ? chips.series_list : undefined,
      directors: chips.directors.length > 0 ? chips.directors : undefined,
      makers: chips.makers.length > 0 ? chips.makers : undefined,
      labels: chips.labels.length > 0 ? chips.labels : undefined,
      ng_words: ngWords.length > 0 ? ngWords : undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      sort: sort || undefined,
    };
    const params = buildAdvancedSearchParams(input);
    const url = `/search?${params.toString()}`;
    onSubmit(url);
  }, [q, chips, dateFrom, dateTo, sort, ngServer, ngLocal, isAuthed, onSubmit]);

  const resetAll = useCallback(() => {
    setQ("");
    setChips({
      genres: [], actresses: [], series_list: [],
      directors: [], makers: [], labels: [],
    });
    setDateFrom("");
    setDateTo("");
    setSort("");
  }, []);

  const ngList = isAuthed ? ngServer : ngLocal;

  return (
    <div className="adv-panel" aria-label="詳細検索">
      <div className="adv-row adv-row-keyword">
        <label className="adv-label">キーワード</label>
        <input
          type="search"
          className="adv-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="タイトル / 説明 / その他"
        />
      </div>

      {(Object.keys(FIELD_LABELS) as FieldKey[]).map((key) => (
        <FieldChipRow
          key={key}
          fieldKey={key}
          label={FIELD_LABELS[key]}
          values={chips[key]}
          onAdd={(v) => addChip(key, v)}
          onRemove={(v) => removeChip(key, v)}
        />
      ))}

      <div className="adv-row adv-row-date">
        <label className="adv-label">配信日</label>
        <div className="adv-date-wrap">
          <input
            type="date"
            className="adv-input adv-input-date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            aria-label="配信日 開始"
          />
          <span className="adv-date-sep">〜</span>
          <input
            type="date"
            className="adv-input adv-input-date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            aria-label="配信日 終了"
          />
        </div>
      </div>

      <div className="adv-row adv-row-sort">
        <label className="adv-label">並び替え</label>
        <select
          className="adv-input adv-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey | "")}
        >
          <option value="">指定なし</option>
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="adv-row adv-row-ng">
        <label className="adv-label">
          NG ワード
          <span className="adv-label-sub">
            {isAuthed ? "(アカウントに保存)" : "(この検索だけ・未ログイン)"}
          </span>
        </label>
        <div className="adv-ng-input-wrap">
          <input
            type="text"
            className="adv-input"
            value={ngInput}
            onChange={(e) => setNgInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addNg(); }
            }}
            placeholder="除外したいキーワード"
          />
          <button
            type="button"
            className="adv-chip-add-btn"
            onClick={addNg}
            disabled={!ngInput.trim()}
          >追加</button>
        </div>
        {ngList.length > 0 && (
          <div className="adv-chips">
            {ngList.map((w) => (
              <span key={w} className="adv-chip adv-chip-ng">
                {w}
                <button
                  type="button"
                  className="adv-chip-x"
                  aria-label={`${w} を削除`}
                  onClick={() => removeNg(w)}
                >×</button>
              </span>
            ))}
          </div>
        )}
        {isAuthed && (
          <div className="adv-ng-save-row">
            <button
              type="button"
              className="adv-ng-save-btn"
              onClick={saveNgServer}
              disabled={ngSaving}
            >
              {ngSaving ? "保存中…" : "NG ワードを保存"}
            </button>
            {ngSavedHint && <span className="adv-ng-saved-hint">保存しました</span>}
          </div>
        )}
      </div>

      <div className="adv-actions">
        <button type="button" className="adv-reset-btn" onClick={resetAll}>
          条件をクリア
        </button>
        <button type="button" className="adv-submit-btn" onClick={handleSubmit}>
          この条件で検索
        </button>
      </div>

      <style>{css}</style>
    </div>
  );
}

/**
 * 1 フィールド分の「入力 + サジェスト + チップ複数」UI。
 * フォーカス中で q が空でなければ /search/suggest を 250ms デバウンスで叩く。
 */
function FieldChipRow({
  fieldKey,
  label,
  values,
  onAdd,
  onRemove,
}: {
  fieldKey: FieldKey;
  label: string;
  values: string[];
  onAdd: (v: string) => void;
  onRemove: (v: string) => void;
}) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [focused, setFocused] = useState(false);
  const suggestField = useMemo(() => FIELD_TO_SUGGEST[fieldKey], [fieldKey]);
  const timerRef = useRef<number | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!focused) return;
    const trimmed = text.trim();
    if (!trimmed) { setSuggestions([]); return; }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const myId = ++reqIdRef.current;
      suggestFieldValues(suggestField, trimmed, 8).then((items) => {
        // レースで古いリクエストを捨てる
        if (myId !== reqIdRef.current) return;
        setSuggestions(items.filter((s) => !values.includes(s)));
      });
    }, 250);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [text, focused, suggestField, values]);

  const commit = (v: string) => {
    onAdd(v);
    setText("");
    setSuggestions([]);
  };

  return (
    <div className="adv-row adv-row-field">
      <label className="adv-label">{label}</label>
      <div className="adv-field-input-wrap">
        <input
          type="text"
          className="adv-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            // suggestion クリックを潰さないように少し遅延
            window.setTimeout(() => setFocused(false), 120);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(text);
            }
          }}
          placeholder="入力して候補から選択 / Enter で追加"
        />
        <button
          type="button"
          className="adv-chip-add-btn"
          onClick={() => commit(text)}
          disabled={!text.trim()}
        >追加</button>
        {focused && suggestions.length > 0 && (
          <div className="adv-suggest-list">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="adv-suggest-item"
                // onBlur より先にクリックを発火させたいので mousedown を使う
                onMouseDown={(e) => { e.preventDefault(); commit(s); }}
              >{s}</button>
            ))}
          </div>
        )}
      </div>
      {values.length > 0 && (
        <div className="adv-chips">
          {values.map((v) => (
            <span key={v} className="adv-chip">
              {v}
              <button
                type="button"
                className="adv-chip-x"
                aria-label={`${v} を削除`}
                onClick={() => onRemove(v)}
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const css = `
  .adv-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 4px 4px;
    color: #fff;
    font-size: 13px;
  }
  .adv-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .adv-label {
    font-size: 11px;
    color: rgba(255,255,255,0.7);
    letter-spacing: 0.02em;
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .adv-label-sub {
    font-size: 10px;
    color: rgba(255,255,255,0.45);
  }
  .adv-input {
    width: 100%;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    color: #fff;
    font-size: 13px;
    padding: 8px 10px;
    border-radius: 8px;
    outline: none;
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .adv-input:focus {
    border-color: var(--accent, #e91e63);
    background: rgba(255,255,255,0.09);
  }
  .adv-field-input-wrap {
    position: relative;
    display: flex;
    gap: 6px;
  }
  .adv-field-input-wrap .adv-input { flex: 1; }
  .adv-chip-add-btn {
    background: rgba(255,255,255,0.1);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    padding: 0 12px;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s ease, opacity 0.15s ease;
  }
  .adv-chip-add-btn:hover:not(:disabled) {
    background: rgba(255,255,255,0.16);
  }
  .adv-chip-add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .adv-suggest-list {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: #1a1a1a;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    overflow: hidden;
    z-index: 20;
    max-height: 220px;
    overflow-y: auto;
    box-shadow: 0 6px 20px rgba(0,0,0,0.5);
  }
  .adv-suggest-item {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    color: #fff;
    font-size: 13px;
    padding: 8px 12px;
    cursor: pointer;
  }
  .adv-suggest-item:hover {
    background: rgba(255,255,255,0.08);
  }
  .adv-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .adv-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(233, 30, 99, 0.18);
    color: #fff;
    border: 1px solid rgba(233, 30, 99, 0.4);
    border-radius: 999px;
    padding: 3px 6px 3px 10px;
    font-size: 12px;
  }
  .adv-chip-ng {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.2);
  }
  .adv-chip-x {
    background: rgba(0,0,0,0.3);
    color: #fff;
    border: none;
    border-radius: 50%;
    width: 18px;
    height: 18px;
    line-height: 1;
    font-size: 14px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .adv-chip-x:hover {
    background: rgba(0,0,0,0.55);
  }
  .adv-date-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .adv-input-date {
    flex: 1;
    min-width: 0;
    color-scheme: dark;
  }
  .adv-date-sep {
    color: rgba(255,255,255,0.5);
    font-size: 12px;
  }
  .adv-select {
    appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.6) 50%),
                      linear-gradient(135deg, rgba(255,255,255,0.6) 50%, transparent 50%);
    background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    padding-right: 28px;
  }
  .adv-ng-input-wrap {
    display: flex;
    gap: 6px;
  }
  .adv-ng-input-wrap .adv-input { flex: 1; }
  .adv-ng-save-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 2px;
  }
  .adv-ng-save-btn {
    background: rgba(255,255,255,0.1);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
  }
  .adv-ng-save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .adv-ng-saved-hint {
    font-size: 11px;
    color: rgba(120, 255, 160, 0.9);
  }
  .adv-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .adv-reset-btn {
    background: transparent;
    color: rgba(255,255,255,0.7);
    border: 1px solid rgba(255,255,255,0.18);
    border-radius: 8px;
    padding: 8px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .adv-submit-btn {
    flex: 1;
    background: var(--accent, #e91e63);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .adv-submit-btn:hover {
    background: #d81b60;
  }
`;

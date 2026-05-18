"use client";

/**
 * 詳細検索パネル (検索結果ページの右上「フィルター」アイコンから開くシートに配置)。
 *
 * 仕様 (修正5):
 * - キーワード入力欄は持たない (検索結果ページ側のサブヘッダーでキーワード表示)
 * - 「並び替え」「配信日」を最上部に固定
 * - 6 種フィールド (ジャンル / 女優 / シリーズ / 監督 / メーカー / レーベル) は
 *   選択済みチップを並べ、末尾の「＋」を押すと入力欄 + サジェストが展開する
 * - NG ワード: ログイン中はサーバ保存 (PUT /me/ng-words)、未ログインはローカル限定
 * - 「適用」を押すと URL クエリを組み立てて検索結果ページへ
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

/** 親が渡す初期値 (自動保存からの復元用)。空配列/空文字なら未指定扱い。 */
export type AdvancedFormInitial = {
  genres?: string[];
  actresses?: string[];
  series_list?: string[];
  directors?: string[];
  makers?: string[];
  labels?: string[];
  date_from?: string;
  date_to?: string;
  sort?: SortKey | "";
};

type Props = {
  /** ログイン中かどうか。サーバ NG ワード保存 UI の出し分けに使う。 */
  isAuthed: boolean;
  /** 検索結果ページから渡される現在の検索キーワード (URL クエリ q=)。表示しないが復元/構築用に保持。 */
  keyword?: string;
  /** 自動保存からの初期値 (チップ・日付・ソート)。 */
  initial?: AdvancedFormInitial;
  /** 検索実行時に呼ばれる (パネルを閉じる用)。url は新しい /search?... の絶対パス。 */
  onSubmit: (url: string, payload: AdvancedSubmitPayload) => void;
  /** 「キャンセル」ボタン押下時 (シート閉じる用)。 */
  onCancel: () => void;
};

/** onSubmit に渡すペイロード (親側で sessionStorage / サーバ保存に使う)。 */
export type AdvancedSubmitPayload = {
  genres: string[];
  actresses: string[];
  series_list: string[];
  directors: string[];
  makers: string[];
  labels: string[];
  date_from: string;
  date_to: string;
  sort: SortKey | "";
};

type FieldKey = "genres" | "actresses" | "series_list" | "directors" | "makers" | "labels";

const FIELD_LABELS: Record<FieldKey, string> = {
  genres: "ジャンル",
  actresses: "女優",
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

const FIELD_KEYS: FieldKey[] = [
  "genres",
  "actresses",
  "series_list",
  "directors",
  "makers",
  "labels",
];

export default function AdvancedSearchPanel({
  isAuthed,
  keyword,
  initial,
  onSubmit,
  onCancel,
}: Props) {
  const [chips, setChips] = useState<Record<FieldKey, string[]>>(() => ({
    genres: initial?.genres ?? [],
    actresses: initial?.actresses ?? [],
    series_list: initial?.series_list ?? [],
    directors: initial?.directors ?? [],
    makers: initial?.makers ?? [],
    labels: initial?.labels ?? [],
  }));
  const [dateFrom, setDateFrom] = useState(initial?.date_from ?? "");
  const [dateTo, setDateTo] = useState(initial?.date_to ?? "");
  const [sort, setSort] = useState<SortKey | "">(initial?.sort ?? "");

  // NG ワード: サーバ保存 (ログイン時) は別 state、ローカルのみは ngLocal
  const [ngServer, setNgServer] = useState<string[]>([]);
  const [ngLocal, setNgLocal] = useState<string[]>([]);
  const [ngEditing, setNgEditing] = useState(false);
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
    //   ログイン時: ngServer (画面上の最新状態) をクエリにも乗せる
    //              ※ サーバの永続値より「いま画面に映っている」方を優先したいため明示送信
    //   未ログイン時: ngLocal を必ずクエリに乗せる
    const ngWords = isAuthed ? ngServer : ngLocal;
    const input: AdvancedSearchInput = {
      q: keyword?.trim() || undefined,
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
    const payload: AdvancedSubmitPayload = {
      genres: chips.genres,
      actresses: chips.actresses,
      series_list: chips.series_list,
      directors: chips.directors,
      makers: chips.makers,
      labels: chips.labels,
      date_from: dateFrom,
      date_to: dateTo,
      sort,
    };
    onSubmit(url, payload);
  }, [keyword, chips, dateFrom, dateTo, sort, ngServer, ngLocal, isAuthed, onSubmit]);

  const resetAll = useCallback(() => {
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
      {/* 並び替え (最上部) */}
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

      {/* 配信日 (次に固定) */}
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

      {/* 各フィールド (チップ + 末尾の「＋」で入力欄が出るタイプ) */}
      {FIELD_KEYS.map((key) => (
        <FieldChipRow
          key={key}
          fieldKey={key}
          label={FIELD_LABELS[key]}
          values={chips[key]}
          onAdd={(v) => addChip(key, v)}
          onRemove={(v) => removeChip(key, v)}
        />
      ))}

      {/* NG ワード */}
      <div className="adv-row adv-row-ng">
        <label className="adv-label">
          NG ワード
          <span className="adv-label-sub">
            {isAuthed ? "(アカウントに保存)" : "(この検索だけ・未ログイン)"}
          </span>
        </label>
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
          {!ngEditing ? (
            <button
              type="button"
              className="adv-chip adv-chip-add"
              onClick={() => setNgEditing(true)}
              aria-label="NG ワードを追加"
            >
              <span className="adv-chip-add-plus" aria-hidden="true">＋</span>
            </button>
          ) : (
            <span className="adv-chip adv-chip-edit">
              <input
                type="text"
                autoFocus
                className="adv-chip-input"
                value={ngInput}
                onChange={(e) => setNgInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNg();
                  } else if (e.key === "Escape") {
                    setNgInput("");
                    setNgEditing(false);
                  }
                }}
                onBlur={() => {
                  // blur で確定 (空なら閉じるだけ)
                  if (ngInput.trim()) addNg();
                  setTimeout(() => setNgEditing(false), 120);
                }}
                placeholder="除外したい語"
              />
            </span>
          )}
        </div>
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
        <button type="button" className="adv-cancel-btn" onClick={onCancel}>
          閉じる
        </button>
        <button type="button" className="adv-submit-btn" onClick={handleSubmit}>
          適用
        </button>
      </div>

      <style>{css}</style>
    </div>
  );
}

/**
 * 1 フィールド分の「選択済みチップ列 + 末尾の＋ボタン」。
 * 「＋」を押すとインラインに入力欄が展開され、サジェストから選択 or Enter で確定。
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
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const suggestField = useMemo(() => FIELD_TO_SUGGEST[fieldKey], [fieldKey]);
  const timerRef = useRef<number | null>(null);
  const reqIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    const trimmed = text.trim();
    if (!trimmed) { setSuggestions([]); return; }
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const myId = ++reqIdRef.current;
      suggestFieldValues(suggestField, trimmed, 8).then((items) => {
        if (myId !== reqIdRef.current) return;
        setSuggestions(items.filter((s) => !values.includes(s)));
      });
    }, 250);
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [text, editing, suggestField, values]);

  const commit = (v: string) => {
    onAdd(v);
    setText("");
    setSuggestions([]);
    // 続けて追加できるよう editing は維持。フォーカスも維持。
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const finishEditing = () => {
    if (text.trim()) {
      onAdd(text);
    }
    setText("");
    setSuggestions([]);
    setEditing(false);
  };

  return (
    <div className="adv-row adv-row-field">
      <label className="adv-label">{label}</label>
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
        {!editing ? (
          <button
            type="button"
            className="adv-chip adv-chip-add"
            onClick={() => {
              setEditing(true);
              setTimeout(() => inputRef.current?.focus(), 0);
            }}
            aria-label={`${label} を追加`}
          >
            <span className="adv-chip-add-plus" aria-hidden="true">＋</span>
          </button>
        ) : (
          <span className="adv-chip adv-chip-edit">
            <input
              ref={inputRef}
              type="text"
              className="adv-chip-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (text.trim()) commit(text);
                } else if (e.key === "Escape") {
                  setText("");
                  setEditing(false);
                }
              }}
              onBlur={() => {
                // suggestion クリックを潰さないように少し遅延
                setTimeout(() => finishEditing(), 140);
              }}
              placeholder={`${label}を入力`}
            />
            {suggestions.length > 0 && (
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
          </span>
        )}
      </div>
    </div>
  );
}

const css = `
  .adv-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 16px;
    color: #fff;
    font-size: 13px;
  }
  .adv-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
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
  .adv-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  /* 選択済みチップ (ピンクの楕円) */
  .adv-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: rgba(233, 30, 99, 0.18);
    color: #fff;
    border: 1px solid rgba(233, 30, 99, 0.4);
    border-radius: 999px;
    padding: 4px 6px 4px 12px;
    font-size: 12px;
    line-height: 1;
    min-height: 28px;
  }
  .adv-chip-ng {
    background: rgba(255,255,255,0.08);
    border-color: rgba(255,255,255,0.2);
  }
  /* 「＋」追加ボタン (チップ風に揃える) */
  .adv-chip-add {
    background: transparent;
    border: 1px dashed rgba(233, 30, 99, 0.55);
    color: rgba(233, 30, 99, 1);
    cursor: pointer;
    padding: 4px 14px;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .adv-chip-add:hover {
    background: rgba(233, 30, 99, 0.12);
    border-color: rgba(233, 30, 99, 0.9);
  }
  .adv-chip-add-plus {
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
  }
  /* 入力モードのチップ (インライン入力欄を埋め込む) */
  .adv-chip-edit {
    position: relative;
    padding: 2px 8px 2px 10px;
    background: rgba(233, 30, 99, 0.12);
    border-color: rgba(233, 30, 99, 0.6);
  }
  .adv-chip-input {
    background: transparent;
    border: none;
    outline: none;
    color: #fff;
    font-size: 13px;
    min-width: 120px;
    width: 140px;
    padding: 2px 0;
  }
  .adv-chip-input::placeholder {
    color: rgba(255,255,255,0.4);
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
  .adv-suggest-list {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 180px;
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
  .adv-ng-save-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
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
    margin-top: 8px;
    padding-top: 12px;
    border-top: 1px solid rgba(255,255,255,0.08);
  }
  .adv-reset-btn,
  .adv-cancel-btn {
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

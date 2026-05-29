/**
 * React hydration mismatch (#418/#419/#421/#422/#423/#425) を「listener が
 * 走り始める前」に取り逃がす問題を解決するための、<head> 内同期インライン
 * スクリプト。
 *
 * - なぜ inline script なのか:
 *   `useEffect` 内で window.addEventListener('error', ...) を貼る方式は、
 *   listener が貼られるのが「React がそのコンポーネントを mount し終わった
 *   後」になる。ところが #418 はまさにハイドレーションの最中に投げられる
 *   ため、listener 設置のほうが間に合わない。`<head>` に <script> として
 *   直接同期実行する形にすると、ハイドレーションが始まる前に listener が
 *   貼れるので確実に補足できる。
 *
 * - 安全性:
 *   - DOM をいじらない / fetch しない。console 出力のみ。
 *   - ?vt=1 または NEXT_PUBLIC_HYDRATION_DEBUG=1 のときだけ実装が動く。
 *     通常ビルドでは即 return するので影響ゼロ。
 *   - 同じエラーで何度も鳴るのを防ぐため最大 3 回まで。
 */
export default function HydrationDebugEarlyScript() {
  const buildEnvEnabled =
    process.env.NEXT_PUBLIC_HYDRATION_DEBUG === "1" ||
    process.env.NEXT_PUBLIC_HYDRATION_DEBUG === "true";

  // build-time に既知の真偽を JS literal として埋め込む。実行時は ?vt=1 と OR。
  const script = `
(function(){
  try {
    var BUILD_ENABLED = ${buildEnvEnabled ? "true" : "false"};
    var search = (typeof location !== 'undefined' && location.search) || '';
    var queryEnabled = /[?&]vt=1(?:&|$)/.test(search);
    if (!BUILD_ENABLED && !queryEnabled) return;

    var HYDRATION_CODES = { 418: 1, 419: 1, 421: 1, 422: 1, 423: 1, 425: 1 };
    var fired = 0;
    var MAX_FIRES = 3;
    var dumping = false;

    function summarize(el, depth) {
      if (!el || depth < 0) return null;
      var attrs = {};
      var rawAttrs = el.attributes || [];
      for (var i = 0; i < rawAttrs.length; i++) {
        var a = rawAttrs[i];
        var name = a.name;
        if (
          name === 'id' ||
          name === 'class' ||
          name.indexOf('data-') === 0 ||
          name.indexOf('aria-') === 0
        ) {
          var v = a.value == null ? '' : String(a.value);
          if (v.length > 60) v = v.slice(0, 60) + '…';
          attrs[name] = v;
        }
      }
      var kids = [];
      var children = el.children || [];
      var max = Math.min(children.length, 8);
      for (var j = 0; j < max; j++) {
        kids.push(summarize(children[j], depth - 1));
      }
      return {
        tag: el.tagName ? el.tagName.toLowerCase() : '?',
        attrs: attrs,
        childCount: children.length,
        children: kids.length > 0 ? kids : undefined,
      };
    }

    function dumpHeadChildren() {
      var head = document.head;
      if (!head) return [];
      var out = [];
      var cs = head.children;
      var max = Math.min(cs.length, 30);
      for (var i = 0; i < max; i++) {
        var c = cs[i];
        out.push({
          tag: c.tagName ? c.tagName.toLowerCase() : '?',
          type: c.getAttribute && c.getAttribute('type') || undefined,
          src: c.getAttribute && c.getAttribute('src') || undefined,
          rel: c.getAttribute && c.getAttribute('rel') || undefined,
          id: c.id || undefined,
        });
      }
      return out;
    }

    function htmlAttrSnapshot() {
      var out = {};
      var root = document.documentElement;
      if (!root) return out;
      var attrs = root.attributes || [];
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        out[a.name] = a.value;
      }
      return out;
    }

    function bodyAttrSnapshot() {
      var out = {};
      var body = document.body;
      if (!body) return out;
      var attrs = body.attributes || [];
      for (var i = 0; i < attrs.length; i++) {
        var a = attrs[i];
        out[a.name] = a.value;
      }
      return out;
    }

    function suspects() {
      var body = document.body;
      var html = document.documentElement;
      var head = document.head;
      var result = {
        gramm: false,
        cz: false,
        translateGoogle: false,
        bodyExtensionAttrs: [],
        htmlExtensionAttrs: [],
        // Vercel Preview Toolbar / Comments (vercel.live/_next-live/feedback/...)
        // が <head> に注入する script は server SSR HTML には無く、edge HTML
        // transformer によって挿入されるため、React の RSC ペイロード期待値と
        // 実 DOM がずれて #418 を引き起こすことがある。preview だけで再現する
        // hydration mismatch の主犯候補なのでフラグ化して切り分けやすくする。
        vercelLive: false,
        vercelLiveScripts: [],
      };
      if (head) {
        var hcs = head.children;
        for (var hi = 0; hi < hcs.length; hi++) {
          var hc = hcs[hi];
          var hsrc = hc.getAttribute && hc.getAttribute('src');
          if (hsrc && hsrc.indexOf('vercel.live') !== -1) {
            result.vercelLive = true;
            result.vercelLiveScripts.push(hsrc);
          }
        }
      }
      if (body) {
        result.gramm =
          !!body.getAttribute('data-gramm') ||
          !!body.getAttribute('data-gramm_editor') ||
          !!body.getAttribute('data-new-gr-c-s-check-loaded');
        var ba = body.attributes || [];
        for (var i = 0; i < ba.length; i++) {
          var name = ba[i].name;
          if (
            name.indexOf('cz-') === 0 ||
            name.indexOf('data-darkreader') === 0 ||
            name.indexOf('data-lt-') === 0 ||
            name === 'data-new-gr-c-s-check-loaded' ||
            name === 'data-gr-ext-installed'
          ) {
            if (name.indexOf('cz-') === 0) result.cz = true;
            result.bodyExtensionAttrs.push(name);
          }
        }
      }
      if (html) {
        result.translateGoogle =
          html.classList.contains('translated-ltr') ||
          html.classList.contains('translated-rtl');
        var ha = html.attributes || [];
        for (var k = 0; k < ha.length; k++) {
          var hname = ha[k].name;
          if (
            hname.indexOf('data-darkreader') === 0 ||
            hname === 'data-lt-installed'
          ) {
            result.htmlExtensionAttrs.push(hname);
          }
        }
      }
      return result;
    }

    function onError(ev) {
      if (fired >= MAX_FIRES) return;
      if (dumping) return;
      var msg = (ev && ev.message) || (ev && ev.error && String(ev.error)) || '';
      var m = msg.match(/react\\.dev\\/errors\\/(\\d+)/);
      if (!m) return;
      var code = Number(m[1]);
      if (!HYDRATION_CODES[code]) return;
      fired += 1;
      try {
        dumping = true;
        var payload = {
          message: msg,
          url: location.href,
          ua: navigator.userAgent,
          readyState: document.readyState,
          htmlAttrs: htmlAttrSnapshot(),
          bodyAttrs: bodyAttrSnapshot(),
          headChildren: dumpHeadChildren(),
          bodyTree: summarize(document.body, 4),
          suspects: suspects(),
        };
        console.error('[hydration-debug-early] React error #' + code, payload);
        // DevTools は object を折りたたんで貼り付け時に {…} になりやすいので、
        // そのままコピーできる JSON 文字列も別行で出す。
        console.error('[hydration-debug-early-json] ' + JSON.stringify(payload));
      } catch (e) {
        try { console.error('[hydration-debug-early] dump failed', e); } catch (_) {}
      } finally {
        dumping = false;
      }
    }

    // capture: true で他の listener より前に走らせる。
    window.addEventListener('error', onError, true);

    // React は内部で console.error も呼ぶ (production minified でも
    // react.dev/errors/418 を含む文字列)。生 window error より早く出ることが
    // あるので console.error も hook して同じ判定をかける。
    try {
      var origErr = console.error;
      console.error = function(){
        try {
          if (fired < MAX_FIRES) {
            for (var i = 0; i < arguments.length; i++) {
              var a = arguments[i];
              var s = typeof a === 'string' ? a : (a && a.message) || '';
              var mm = s && s.match(/react\\.dev\\/errors\\/(\\d+)/);
              if (mm && HYDRATION_CODES[Number(mm[1])]) {
                onError({ message: s });
                break;
              }
            }
          }
        } catch (_) {}
        return origErr.apply(this, arguments);
      };
    } catch (_) {}

    // 起動マーカー: スクリプトが本当に走ったかを切り分けやすくする。
    try { console.info('[hydration-debug-early] armed', { build: BUILD_ENABLED, query: queryEnabled }); } catch (_) {}
  } catch (e) {
    try { console.error('[hydration-debug-early] init failed', e); } catch (_) {}
  }
})();
`;

  return (
    <script
      // 同期実行が必要。async/defer は付けない。
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}

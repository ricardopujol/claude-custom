// @ts-nocheck
'use strict';

/**
 * How a quota meter should be DRAWN, given how well it is known.
 *
 * Extracted from renderer.js for the reason app/usage-display.js and
 * app/career-display.js were: a decision living inside a browser script is a
 * decision nothing can test, and this project has already shipped a fix into
 * exactly that kind of region.
 *
 * The rule this whole file exists to keep: a meter at 0% says "you have used
 * nothing". That is a CLAIM, and a false one whenever the truth is "we could
 * not find out". So absence draws no bar at all, and an unknown percentage
 * draws an em dash rather than a number.
 *
 * The plan reports PERCENT ONLY -- `limit_dollars`, `used_dollars` and
 * `remaining_dollars` are null on a Max account. Nothing here converts a
 * percentage into tokens or dollars, and a test asserts that the tooltip never
 * mentions either.
 *
 * WRAPPED IN AN IIFE, and that is not style. The renderer loads these as plain
 * <script> tags, which share ONE global scope -- so a top-level `const UNKNOWN`
 * here collided with the identical one in app/usage-display.js and threw
 * "Identifier 'UNKNOWN' has already been declared", which killed this whole
 * file and left `quotaDisplay` undefined. No unit test can see that: each test
 * requires the module into its own scope, where there is nothing to collide
 * with. It was found by rendering the real header in a real window.
 */
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
(function (root) {
  if (stryMutAct_9fa48("1")) {
    {}
  } else {
    stryCov_9fa48("1");
    const UNKNOWN = stryMutAct_9fa48("2") ? "" : (stryCov_9fa48("2"), '—'); // em dash

    // STRICTLY a number. `Number(null)` is 0 and so is `Number('')`, so a
    // coercing check turns "no value" into a confident zero -- which is the one
    // claim this file exists to never make. This is the SECOND time that exact
    // coercion produced an absence-reported-as-zero bug in this app on the same
    // day (app/career-display.js has the twin), so it is a named helper here
    // rather than an inline check waiting to be got wrong a third time.
    const finiteOrNull = stryMutAct_9fa48("3") ? () => undefined : (stryCov_9fa48("3"), (() => {
      const finiteOrNull = v => (stryMutAct_9fa48("6") ? typeof v === 'number' || Number.isFinite(v) : stryMutAct_9fa48("5") ? false : stryMutAct_9fa48("4") ? true : (stryCov_9fa48("4", "5", "6"), (stryMutAct_9fa48("8") ? typeof v !== 'number' : stryMutAct_9fa48("7") ? true : (stryCov_9fa48("7", "8"), typeof v === (stryMutAct_9fa48("9") ? "" : (stryCov_9fa48("9"), 'number')))) && Number.isFinite(v))) ? v : null;
      return finiteOrNull;
    })());

    // A percentage the server could not possibly mean. Out of domain is UNKNOWN --
    // the module has that state -- not a number drawn confidently with a healthy
    // tone. (Over 100 IS drawn, clamped: a server reporting 140% is saying
    // something real about being over the limit.)
    const percentOrNull = v => {
      if (stryMutAct_9fa48("10")) {
        {}
      } else {
        stryCov_9fa48("10");
        const n = finiteOrNull(v);
        return (stryMutAct_9fa48("13") ? n === null && n < 0 : stryMutAct_9fa48("12") ? false : stryMutAct_9fa48("11") ? true : (stryCov_9fa48("11", "12", "13"), (stryMutAct_9fa48("15") ? n !== null : stryMutAct_9fa48("14") ? false : (stryCov_9fa48("14", "15"), n === null)) || (stryMutAct_9fa48("18") ? n >= 0 : stryMutAct_9fa48("17") ? n <= 0 : stryMutAct_9fa48("16") ? false : (stryCov_9fa48("16", "17", "18"), n < 0)))) ? null : n;
      }
    };

    // Colour thresholds for a window the API calls "normal". The account's own
    // `severity` outranks these whenever it is anything else: a scoped window can
    // be throttled at a percentage that looks harmless from here, and the server
    // knows things the client does not.
    const WARN_AT = 80;
    const CRITICAL_AT = 95;
    function formatPercent(pct) {
      if (stryMutAct_9fa48("19")) {
        {}
      } else {
        stryCov_9fa48("19");
        if (stryMutAct_9fa48("22") ? pct > 0 || pct < 1 : stryMutAct_9fa48("21") ? false : stryMutAct_9fa48("20") ? true : (stryCov_9fa48("20", "21", "22"), (stryMutAct_9fa48("25") ? pct <= 0 : stryMutAct_9fa48("24") ? pct >= 0 : stryMutAct_9fa48("23") ? true : (stryCov_9fa48("23", "24", "25"), pct > 0)) && (stryMutAct_9fa48("28") ? pct >= 1 : stryMutAct_9fa48("27") ? pct <= 1 : stryMutAct_9fa48("26") ? true : (stryCov_9fa48("26", "27", "28"), pct < 1)))) return stryMutAct_9fa48("29") ? "" : (stryCov_9fa48("29"), '<1%');
        if (stryMutAct_9fa48("32") ? pct > 99 || pct < 100 : stryMutAct_9fa48("31") ? false : stryMutAct_9fa48("30") ? true : (stryCov_9fa48("30", "31", "32"), (stryMutAct_9fa48("35") ? pct <= 99 : stryMutAct_9fa48("34") ? pct >= 99 : stryMutAct_9fa48("33") ? true : (stryCov_9fa48("33", "34", "35"), pct > 99)) && (stryMutAct_9fa48("38") ? pct >= 100 : stryMutAct_9fa48("37") ? pct <= 100 : stryMutAct_9fa48("36") ? true : (stryCov_9fa48("36", "37", "38"), pct < 100)))) return stryMutAct_9fa48("39") ? "" : (stryCov_9fa48("39"), '>99%');
        return stryMutAct_9fa48("40") ? `` : (stryCov_9fa48("40"), `${Math.round(pct)}%`);
      }
    }
    function toneFor(w) {
      if (stryMutAct_9fa48("41")) {
        {}
      } else {
        stryCov_9fa48("41");
        if (stryMutAct_9fa48("44") ? false : stryMutAct_9fa48("43") ? true : stryMutAct_9fa48("42") ? w : (stryCov_9fa48("42", "43", "44"), !w)) return stryMutAct_9fa48("45") ? "" : (stryCov_9fa48("45"), 'unknown');
        if (stryMutAct_9fa48("47") ? false : stryMutAct_9fa48("46") ? true : (stryCov_9fa48("46", "47"), w.lockedReason)) return stryMutAct_9fa48("48") ? "" : (stryCov_9fa48("48"), 'critical'); // it has already stopped working
        const sev = stryMutAct_9fa48("49") ? String(w.severity || 'normal').toUpperCase() : (stryCov_9fa48("49"), String(stryMutAct_9fa48("52") ? w.severity && 'normal' : stryMutAct_9fa48("51") ? false : stryMutAct_9fa48("50") ? true : (stryCov_9fa48("50", "51", "52"), w.severity || (stryMutAct_9fa48("53") ? "" : (stryCov_9fa48("53"), 'normal')))).toLowerCase());
        if (stryMutAct_9fa48("56") ? sev === 'critical' && sev === 'severe' : stryMutAct_9fa48("55") ? false : stryMutAct_9fa48("54") ? true : (stryCov_9fa48("54", "55", "56"), (stryMutAct_9fa48("58") ? sev !== 'critical' : stryMutAct_9fa48("57") ? false : (stryCov_9fa48("57", "58"), sev === (stryMutAct_9fa48("59") ? "" : (stryCov_9fa48("59"), 'critical')))) || (stryMutAct_9fa48("61") ? sev !== 'severe' : stryMutAct_9fa48("60") ? false : (stryCov_9fa48("60", "61"), sev === (stryMutAct_9fa48("62") ? "" : (stryCov_9fa48("62"), 'severe')))))) return stryMutAct_9fa48("63") ? "" : (stryCov_9fa48("63"), 'critical');
        if (stryMutAct_9fa48("66") ? sev === 'warning' && sev === 'warn' : stryMutAct_9fa48("65") ? false : stryMutAct_9fa48("64") ? true : (stryCov_9fa48("64", "65", "66"), (stryMutAct_9fa48("68") ? sev !== 'warning' : stryMutAct_9fa48("67") ? false : (stryCov_9fa48("67", "68"), sev === (stryMutAct_9fa48("69") ? "" : (stryCov_9fa48("69"), 'warning')))) || (stryMutAct_9fa48("71") ? sev !== 'warn' : stryMutAct_9fa48("70") ? false : (stryCov_9fa48("70", "71"), sev === (stryMutAct_9fa48("72") ? "" : (stryCov_9fa48("72"), 'warn')))))) return stryMutAct_9fa48("73") ? "" : (stryCov_9fa48("73"), 'warn');
        const pct = percentOrNull(w.percent);
        if (stryMutAct_9fa48("76") ? pct !== null : stryMutAct_9fa48("75") ? false : stryMutAct_9fa48("74") ? true : (stryCov_9fa48("74", "75", "76"), pct === null)) return stryMutAct_9fa48("77") ? "" : (stryCov_9fa48("77"), 'unknown');
        if (stryMutAct_9fa48("81") ? pct < CRITICAL_AT : stryMutAct_9fa48("80") ? pct > CRITICAL_AT : stryMutAct_9fa48("79") ? false : stryMutAct_9fa48("78") ? true : (stryCov_9fa48("78", "79", "80", "81"), pct >= CRITICAL_AT)) return stryMutAct_9fa48("82") ? "" : (stryCov_9fa48("82"), 'critical');
        if (stryMutAct_9fa48("86") ? pct < WARN_AT : stryMutAct_9fa48("85") ? pct > WARN_AT : stryMutAct_9fa48("84") ? false : stryMutAct_9fa48("83") ? true : (stryCov_9fa48("83", "84", "85", "86"), pct >= WARN_AT)) return stryMutAct_9fa48("87") ? "" : (stryCov_9fa48("87"), 'warn');
        return stryMutAct_9fa48("88") ? "" : (stryCov_9fa48("88"), 'normal');
      }
    }

    /**
     * Time remaining until a reset, as something you can read at a glance.
     *
     * A raw "resets 17:37Z" makes you do arithmetic while watching a bar fill up,
     * which is the moment you least want to. A reset already in the past reads as
     * `due` rather than as a negative number -- the window is rolling over and the
     * next read will show it.
     */
    function formatCountdown(resetsAt, now = Date.now()) {
      if (stryMutAct_9fa48("89")) {
        {}
      } else {
        stryCov_9fa48("89");
        const at = Date.parse(resetsAt);
        if (stryMutAct_9fa48("92") ? false : stryMutAct_9fa48("91") ? true : stryMutAct_9fa48("90") ? Number.isFinite(at) : (stryCov_9fa48("90", "91", "92"), !Number.isFinite(at))) return UNKNOWN;
        const ms = stryMutAct_9fa48("93") ? at + now : (stryCov_9fa48("93"), at - now);
        if (stryMutAct_9fa48("97") ? ms > 0 : stryMutAct_9fa48("96") ? ms < 0 : stryMutAct_9fa48("95") ? false : stryMutAct_9fa48("94") ? true : (stryCov_9fa48("94", "95", "96", "97"), ms <= 0)) return stryMutAct_9fa48("98") ? "" : (stryCov_9fa48("98"), 'due');
        const mins = Math.floor(stryMutAct_9fa48("99") ? ms * 60000 : (stryCov_9fa48("99"), ms / 60000));
        // "resets in 0m" is the same self-contradicting zero the sibling module
        // refuses for minutes worked.
        if (stryMutAct_9fa48("103") ? mins >= 1 : stryMutAct_9fa48("102") ? mins <= 1 : stryMutAct_9fa48("101") ? false : stryMutAct_9fa48("100") ? true : (stryCov_9fa48("100", "101", "102", "103"), mins < 1)) return stryMutAct_9fa48("104") ? "" : (stryCov_9fa48("104"), '<1m');
        if (stryMutAct_9fa48("108") ? mins >= 60 : stryMutAct_9fa48("107") ? mins <= 60 : stryMutAct_9fa48("106") ? false : stryMutAct_9fa48("105") ? true : (stryCov_9fa48("105", "106", "107", "108"), mins < 60)) return stryMutAct_9fa48("109") ? `` : (stryCov_9fa48("109"), `${mins}m`);
        const hours = Math.floor(stryMutAct_9fa48("110") ? mins * 60 : (stryCov_9fa48("110"), mins / 60));
        if (stryMutAct_9fa48("114") ? hours >= 24 : stryMutAct_9fa48("113") ? hours <= 24 : stryMutAct_9fa48("112") ? false : stryMutAct_9fa48("111") ? true : (stryCov_9fa48("111", "112", "113", "114"), hours < 24)) {
          if (stryMutAct_9fa48("115")) {
            {}
          } else {
            stryCov_9fa48("115");
            const m = stryMutAct_9fa48("116") ? mins * 60 : (stryCov_9fa48("116"), mins % 60);
            return m ? stryMutAct_9fa48("117") ? `` : (stryCov_9fa48("117"), `${hours}h${m}m`) : stryMutAct_9fa48("118") ? `` : (stryCov_9fa48("118"), `${hours}h`);
          }
        }
        const days = Math.floor(stryMutAct_9fa48("119") ? hours * 24 : (stryCov_9fa48("119"), hours / 24));
        const h = stryMutAct_9fa48("120") ? hours * 24 : (stryCov_9fa48("120"), hours % 24);
        return h ? stryMutAct_9fa48("121") ? `` : (stryCov_9fa48("121"), `${days}d${h}h`) : stryMutAct_9fa48("122") ? `` : (stryCov_9fa48("122"), `${days}d`);
      }
    }

    /**
     * @param quota the `{ ok, state, windows, error }` payload from host/quota.js
     * @param now   injected so the countdown is testable
     *
     * Returns `{ state, note, meters }` where `state` is:
     *
     *   reading  nothing has been read yet. A number here would be invented.
     *   absent   the read failed. We know NOTHING -- so no bars, and a note
     *            saying why rather than three bars sitting confidently at zero.
     *   ready    draw the meters.
     */
    function quotaDisplay(quota, now = Date.now()) {
      if (stryMutAct_9fa48("123")) {
        {}
      } else {
        stryCov_9fa48("123");
        if (stryMutAct_9fa48("126") ? false : stryMutAct_9fa48("125") ? true : stryMutAct_9fa48("124") ? quota : (stryCov_9fa48("124", "125", "126"), !quota)) {
          if (stryMutAct_9fa48("127")) {
            {}
          } else {
            stryCov_9fa48("127");
            return stryMutAct_9fa48("128") ? {} : (stryCov_9fa48("128"), {
              state: stryMutAct_9fa48("129") ? "" : (stryCov_9fa48("129"), 'reading'),
              note: stryMutAct_9fa48("130") ? "" : (stryCov_9fa48("130"), 'reading account limits…'),
              meters: stryMutAct_9fa48("131") ? ["Stryker was here"] : (stryCov_9fa48("131"), [])
            });
          }
        }
        if (stryMutAct_9fa48("134") ? (quota.ok === false || !Array.isArray(quota.windows)) && quota.windows.length === 0 : stryMutAct_9fa48("133") ? false : stryMutAct_9fa48("132") ? true : (stryCov_9fa48("132", "133", "134"), (stryMutAct_9fa48("136") ? quota.ok === false && !Array.isArray(quota.windows) : stryMutAct_9fa48("135") ? false : (stryCov_9fa48("135", "136"), (stryMutAct_9fa48("138") ? quota.ok !== false : stryMutAct_9fa48("137") ? false : (stryCov_9fa48("137", "138"), quota.ok === (stryMutAct_9fa48("139") ? true : (stryCov_9fa48("139"), false)))) || (stryMutAct_9fa48("140") ? Array.isArray(quota.windows) : (stryCov_9fa48("140"), !Array.isArray(quota.windows))))) || (stryMutAct_9fa48("142") ? quota.windows.length !== 0 : stryMutAct_9fa48("141") ? false : (stryCov_9fa48("141", "142"), quota.windows.length === 0)))) {
          if (stryMutAct_9fa48("143")) {
            {}
          } else {
            stryCov_9fa48("143");
            const why = quota.error ? String(quota.error) : stryMutAct_9fa48("144") ? "" : (stryCov_9fa48("144"), 'could not read account limits');
            return stryMutAct_9fa48("145") ? {} : (stryCov_9fa48("145"), {
              state: stryMutAct_9fa48("146") ? "" : (stryCov_9fa48("146"), 'absent'),
              note: why,
              meters: stryMutAct_9fa48("147") ? ["Stryker was here"] : (stryCov_9fa48("147"), [])
            });
          }
        }
        const meters = quota.windows.map(w => {
          if (stryMutAct_9fa48("148")) {
            {}
          } else {
            stryCov_9fa48("148");
            const pct = percentOrNull(w.percent);
            const countdown = formatCountdown(w.resetsAt, now);
            const parts = stryMutAct_9fa48("149") ? [] : (stryCov_9fa48("149"), [stryMutAct_9fa48("150") ? `` : (stryCov_9fa48("150"), `${w.label}: ${(stryMutAct_9fa48("153") ? pct !== null : stryMutAct_9fa48("152") ? false : stryMutAct_9fa48("151") ? true : (stryCov_9fa48("151", "152", "153"), pct === null)) ? stryMutAct_9fa48("154") ? "" : (stryCov_9fa48("154"), 'unknown') : formatPercent(pct) + (stryMutAct_9fa48("155") ? "" : (stryCov_9fa48("155"), ' used'))}`), (stryMutAct_9fa48("158") ? countdown !== UNKNOWN : stryMutAct_9fa48("157") ? false : stryMutAct_9fa48("156") ? true : (stryCov_9fa48("156", "157", "158"), countdown === UNKNOWN)) ? stryMutAct_9fa48("159") ? "" : (stryCov_9fa48("159"), 'reset time unknown') : (stryMutAct_9fa48("162") ? countdown !== 'due' : stryMutAct_9fa48("161") ? false : stryMutAct_9fa48("160") ? true : (stryCov_9fa48("160", "161", "162"), countdown === (stryMutAct_9fa48("163") ? "" : (stryCov_9fa48("163"), 'due')))) ? stryMutAct_9fa48("164") ? "" : (stryCov_9fa48("164"), 'resetting now') : stryMutAct_9fa48("165") ? `` : (stryCov_9fa48("165"), `resets in ${countdown}`)]);
            if (stryMutAct_9fa48("167") ? false : stryMutAct_9fa48("166") ? true : (stryCov_9fa48("166", "167"), w.isActive)) parts.push(stryMutAct_9fa48("169") ? "" : (stryCov_9fa48("169"), 'currently the binding limit'));
            if (stryMutAct_9fa48("171") ? false : stryMutAct_9fa48("170") ? true : (stryCov_9fa48("170", "171"), w.lockedReason)) parts.push(stryMutAct_9fa48("173") ? `` : (stryCov_9fa48("173"), `LOCKED: ${w.lockedReason}`));
            return stryMutAct_9fa48("174") ? {} : (stryCov_9fa48("174"), {
              key: w.key,
              label: w.label,
              percent: pct,
              // What goes in the bar's own text. An unknown percentage is an em dash,
              // never a zero.
              // `0%` claims "you have used nothing" and `100%` claims "you are out".
              // Rounding 0.4 and 99.6 into them makes the meter say the two things this
              // file exists to never say falsely. The twin module reached the same
              // answer for `<1m`, on the same day, for the same reason.
              text: (stryMutAct_9fa48("177") ? pct !== null : stryMutAct_9fa48("176") ? false : stryMutAct_9fa48("175") ? true : (stryCov_9fa48("175", "176", "177"), pct === null)) ? UNKNOWN : formatPercent(pct),
              // How full to draw the bar. Clamped, because a server that ever reports
              // over 100 should overflow the meaning, not the layout.
              fill: (stryMutAct_9fa48("180") ? pct !== null : stryMutAct_9fa48("179") ? false : stryMutAct_9fa48("178") ? true : (stryCov_9fa48("178", "179", "180"), pct === null)) ? 0 : stryMutAct_9fa48("181") ? Math.min(0, Math.min(100, pct)) : (stryCov_9fa48("181"), Math.max(0, stryMutAct_9fa48("182") ? Math.max(100, pct) : (stryCov_9fa48("182"), Math.min(100, pct)))),
              tone: toneFor(w),
              countdown,
              isActive: stryMutAct_9fa48("183") ? !w.isActive : (stryCov_9fa48("183"), !(stryMutAct_9fa48("184") ? w.isActive : (stryCov_9fa48("184"), !w.isActive))),
              title: parts.join(stryMutAct_9fa48("185") ? "" : (stryCov_9fa48("185"), ' · '))
            });
          }
        });
        return stryMutAct_9fa48("186") ? {} : (stryCov_9fa48("186"), {
          state: stryMutAct_9fa48("187") ? "" : (stryCov_9fa48("187"), 'ready'),
          note: null,
          meters
        });
      }
    }

    // Loaded two ways: require() from tests, and a plain <script> tag in the
    // renderer, which has no module system at all.
    if (stryMutAct_9fa48("190") ? typeof module !== 'undefined' || module.exports : stryMutAct_9fa48("189") ? false : stryMutAct_9fa48("188") ? true : (stryCov_9fa48("188", "189", "190"), (stryMutAct_9fa48("192") ? typeof module === 'undefined' : stryMutAct_9fa48("191") ? true : (stryCov_9fa48("191", "192"), typeof module !== (stryMutAct_9fa48("193") ? "" : (stryCov_9fa48("193"), 'undefined')))) && module.exports)) {
      if (stryMutAct_9fa48("194")) {
        {}
      } else {
        stryCov_9fa48("194");
        module.exports = stryMutAct_9fa48("195") ? {} : (stryCov_9fa48("195"), {
          quotaDisplay,
          formatCountdown,
          formatPercent,
          toneFor,
          UNKNOWN,
          WARN_AT,
          CRITICAL_AT
        });
      }
    } else {
      if (stryMutAct_9fa48("196")) {
        {}
      } else {
        stryCov_9fa48("196");
        root.quotaDisplay = quotaDisplay;
        // The warning flourish needs the countdown too, and a second implementation
        // of it in renderer.js is a second definition free to drift from this one.
        root.formatQuotaCountdown = formatCountdown;
      }
    }
  }
})((stryMutAct_9fa48("199") ? typeof window === 'undefined' : stryMutAct_9fa48("198") ? false : stryMutAct_9fa48("197") ? true : (stryCov_9fa48("197", "198", "199"), typeof window !== (stryMutAct_9fa48("200") ? "" : (stryCov_9fa48("200"), 'undefined')))) ? window : globalThis);
// @ts-nocheck
'use strict';

/**
 * Local secret store — passwords, keys, tokens.
 *
 * Lives in the MAIN process on purpose. The host owns the pty, so a secret that
 * never reaches the host cannot be written into the session by any accident of
 * wiring. That is structural rather than careful, which is the only kind of
 * guarantee worth having here.
 *
 * Encrypted at rest through Electron's safeStorage -- DPAPI on Windows, so the
 * file is bound to the logged-in user and useless on another machine. The
 * cipher is injected so this is testable without Electron.
 *
 * ONLY the secret is encrypted. Labels and notes stay readable: they have to be
 * listed and searched, and encrypting them would buy nothing while turning
 * every render into a decrypt storm.
 *
 * Deliberately NOT stored through store.js, which writes plain JSON.
 *
 * THE LIMIT THIS CANNOT ESCAPE: anything pasted into a session is written to
 * ~/.claude/projects/<project>/<session>.jsonl in plaintext, permanently. This
 * makes a secret easy to REACH; it cannot make pasting one into a session safe.
 * That is a property of the transcript, not of this file.
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
const fs = require('fs');
const path = require('path');
const crypto_ = require('crypto');
const {
  renameWithRetry
} = require('../host/atomic-write');

// Long enough to switch windows and paste; short enough that a key is not still
// sitting on the clipboard an hour later.
const CLIPBOARD_CLEAR_MS = 30000;
const FORMAT = 1;
function createVault({
  file,
  crypto,
  onWrite
} = {}) {
  if (stryMutAct_9fa48("201")) {
    {}
  } else {
    stryCov_9fa48("201");
    if (stryMutAct_9fa48("204") ? false : stryMutAct_9fa48("203") ? true : stryMutAct_9fa48("202") ? file : (stryCov_9fa48("202", "203", "204"), !file)) throw new Error(stryMutAct_9fa48("206") ? "" : (stryCov_9fa48("206"), 'createVault: file is required'));
    if (stryMutAct_9fa48("209") ? false : stryMutAct_9fa48("208") ? true : stryMutAct_9fa48("207") ? crypto : (stryCov_9fa48("207", "208", "209"), !crypto)) throw new Error(stryMutAct_9fa48("211") ? "" : (stryCov_9fa48("211"), 'createVault: crypto is required'));
    let state = load();
    function load() {
      if (stryMutAct_9fa48("212")) {
        {}
      } else {
        stryCov_9fa48("212");
        let raw;
        try {
          if (stryMutAct_9fa48("213")) {
            {}
          } else {
            stryCov_9fa48("213");
            raw = fs.readFileSync(file, stryMutAct_9fa48("214") ? "" : (stryCov_9fa48("214"), 'utf8'));
          }
        } catch {
          if (stryMutAct_9fa48("215")) {
            {}
          } else {
            stryCov_9fa48("215");
            return stryMutAct_9fa48("216") ? {} : (stryCov_9fa48("216"), {
              format: FORMAT,
              entries: stryMutAct_9fa48("217") ? ["Stryker was here"] : (stryCov_9fa48("217"), [])
            }); // a missing vault is an empty one
          }
        }
        try {
          if (stryMutAct_9fa48("218")) {
            {}
          } else {
            stryCov_9fa48("218");
            const parsed = JSON.parse(raw);
            if (stryMutAct_9fa48("221") ? !parsed && !Array.isArray(parsed.entries) : stryMutAct_9fa48("220") ? false : stryMutAct_9fa48("219") ? true : (stryCov_9fa48("219", "220", "221"), (stryMutAct_9fa48("222") ? parsed : (stryCov_9fa48("222"), !parsed)) || (stryMutAct_9fa48("223") ? Array.isArray(parsed.entries) : (stryCov_9fa48("223"), !Array.isArray(parsed.entries))))) throw new Error(stryMutAct_9fa48("225") ? "" : (stryCov_9fa48("225"), 'shape'));
            return parsed;
          }
        } catch (err) {
          if (stryMutAct_9fa48("226")) {
            {}
          } else {
            stryCov_9fa48("226");
            // Never overwrite what cannot be read: replacing it with an empty vault
            // would delete every secret in it to fix a display problem.
            throw new Error(stryMutAct_9fa48("228") ? `` : (stryCov_9fa48("228"), `secret vault at ${file} is unreadable, refusing to replace it: ${err.message}`));
          }
        }
      }
    }

    /**
     * Write a CANDIDATE state, and only let memory agree with disk once it lands.
     *
     * Dexter, logic review 2026-09-21, Finding 1. Every mutation used to update
     * `state` first and persist second, so a rename that never landed left the
     * two disagreeing: `add` threw and reported the failure, while `list`, `get`,
     * `reveal` and `copy` all went on serving a secret that was not on disk --
     * until a restart took it away. That is precisely the harm this module's
     * docstring names, the user believing it is safe to discard the original,
     * and the retry only made it rarer.
     *
     * Worse, the divergence persisted: the NEXT successful write flushed it, so
     * an operation the user had been told failed completed later, unannounced.
     *
     * Passing the candidate through means the failure path cannot leave anything
     * behind to be committed by accident -- there is no partial state to roll
     * back, because nothing was assigned in the first place.
     *
     * WHAT THIS STILL DOES NOT SOLVE, named here so it is not rediscovered as a
     * bug (Miguel): `commit` spreads the IN-MEMORY state, which may be stale if
     * a second app instance wrote the vault since `load()`. Last writer wins
     * across processes. Pre-existing and out of scope for the retry, but this is
     * the exact line someone would be looking at when they hit it.
     */
    function commit(nextEntries) {
      if (stryMutAct_9fa48("229")) {
        {}
      } else {
        stryCov_9fa48("229");
        const next = stryMutAct_9fa48("230") ? {} : (stryCov_9fa48("230"), {
          ...state,
          entries: nextEntries
        });
        if (stryMutAct_9fa48("231")) {
          ;
        } else {
          stryCov_9fa48("231");
          persist(next);
        }
        state = next;
      }
    }

    // `candidate` is REQUIRED, deliberately. Miguel: a default of `state` is the
    // dangerous one -- a future bare `persist()` would silently restore "write
    // whatever memory currently holds", which is the exact mental model F1
    // removed. A missing argument should crash here, loudly, in a test.
    function persist(candidate) {
      if (stryMutAct_9fa48("232")) {
        {}
      } else {
        stryCov_9fa48("232");
        if (stryMutAct_9fa48("235") ? false : stryMutAct_9fa48("234") ? true : stryMutAct_9fa48("233") ? candidate : (stryCov_9fa48("233", "234", "235"), !candidate)) throw new Error(stryMutAct_9fa48("237") ? "" : (stryCov_9fa48("237"), 'persist: a candidate state is required'));
        const dir = path.dirname(file);
        fs.mkdirSync(dir, stryMutAct_9fa48("239") ? {} : (stryCov_9fa48("239"), {
          recursive: stryMutAct_9fa48("240") ? false : (stryCov_9fa48("240"), true)
        }));
        // Write-and-rename: a crash mid-write leaves the old vault intact rather
        // than a truncated one, which would be every secret gone instead of none.
        const tmp = path.join(dir, stryMutAct_9fa48("241") ? `` : (stryCov_9fa48("241"), `.secrets-${process.pid}-${Date.now()}.tmp`));
        if (stryMutAct_9fa48("243") ? false : stryMutAct_9fa48("242") ? true : (stryCov_9fa48("242", "243"), onWrite)) if (stryMutAct_9fa48("244")) {
          ;
        } else {
          stryCov_9fa48("244");
          onWrite(tmp);
        }
        // The WRITE is inside the try as well as the rename. Miguel, review of the
        // fixed branch: wrapping only the rename left a writeFileSync failure --
        // ENOSPC, a quota, a transient EACCES -- abandoning a partially written
        // temp, which is the same leak Dexter's Finding 9 was about, through the
        // other door.
        try {
          if (stryMutAct_9fa48("245")) {
            {}
          } else {
            stryCov_9fa48("245");
            // 0o600 is near-inert on Windows -- Node honours only the read-only bit
            // there -- so it is right on POSIX and documents intent, and the threat
            // model must not lean on it on this machine (Miguel). DPAPI binding the
            // ciphertext to the logged-in user is what actually carries the weight.
            fs.writeFileSync(tmp, JSON.stringify(candidate), stryMutAct_9fa48("247") ? {} : (stryCov_9fa48("247"), {
              mode: 0o600
            }));
            // Retried: on Windows the rename fails with EPERM / EACCES / EBUSY while
            // anything holds a handle for a moment, and the antivirus scan of the
            // file just written routinely does. MEASURED against this very file on
            // 2026-09-18. It still THROWS if the rename never lands -- returning the
            // entry while the file was never replaced would tell the user a secret
            // is stored when it is not. See host/atomic-write.js.
            if (stryMutAct_9fa48("248")) {
              ;
            } else {
              stryCov_9fa48("248");
              renameWithRetry(tmp, file);
            }
          }
        } catch (err) {
          if (stryMutAct_9fa48("249")) {
            {}
          } else {
            stryCov_9fa48("249");
            // BEST EFFORT, and deliberately described as such. Each abandoned temp
            // holds the WHOLE vault, and only the `secret` field is encrypted, so
            // every one is a readable copy of every label and note -- with a
            // millisecond in its name, so they accumulate.
            //
            // But this cleanup is most likely to fail under exactly the condition
            // that triggers it: the rename failed because something holds a handle
            // on the temp, and unlinkSync on a held handle fails the same way. So
            // this reduces the leak, it does not close it, and claiming otherwise
            // would be the kind of comment that stops the next person looking.
            //
            // What IS guaranteed is that a failed cleanup never replaces the error
            // the caller needs to see.
            try {
              if (stryMutAct_9fa48("250")) {
                {}
              } else {
                stryCov_9fa48("250");
                if (stryMutAct_9fa48("251")) {
                  ;
                } else {
                  stryCov_9fa48("251");
                  fs.unlinkSync(tmp);
                }
              }
            } catch {/* nothing more we can do about it */}
            throw err;
          }
        }
        if (stryMutAct_9fa48("253") ? false : stryMutAct_9fa48("252") ? true : (stryCov_9fa48("252", "253"), onWrite)) if (stryMutAct_9fa48("254")) {
          ;
        } else {
          stryCov_9fa48("254");
          onWrite(file);
        }
      }
    }
    function available() {
      if (stryMutAct_9fa48("255")) {
        {}
      } else {
        stryCov_9fa48("255");
        try {
          if (stryMutAct_9fa48("256")) {
            {}
          } else {
            stryCov_9fa48("256");
            return stryMutAct_9fa48("257") ? !crypto.isEncryptionAvailable() : (stryCov_9fa48("257"), !(stryMutAct_9fa48("258") ? crypto.isEncryptionAvailable() : (stryCov_9fa48("258"), !crypto.isEncryptionAvailable())));
          }
        } catch {
          if (stryMutAct_9fa48("259")) {
            {}
          } else {
            stryCov_9fa48("259");
            return stryMutAct_9fa48("260") ? true : (stryCov_9fa48("260"), false);
          }
        }
      }
    }
    function add({
      label,
      secret,
      note
    } = {}) {
      if (stryMutAct_9fa48("261")) {
        {}
      } else {
        stryCov_9fa48("261");
        // Fail closed. Storing plaintext because the OS keyring is unavailable is
        // the one outcome that must never happen quietly: the user believes it is
        // encrypted, since that is the entire point of the feature.
        if (stryMutAct_9fa48("264") ? false : stryMutAct_9fa48("263") ? true : stryMutAct_9fa48("262") ? available() : (stryCov_9fa48("262", "263", "264"), !available())) {
          if (stryMutAct_9fa48("265")) {
            {}
          } else {
            stryCov_9fa48("265");
            throw new Error(stryMutAct_9fa48("267") ? "" : (stryCov_9fa48("267"), 'encryption is unavailable on this machine; refusing to store a secret in plaintext'));
          }
        }
        const cleanLabel = stryMutAct_9fa48("268") ? String(label == null ? '' : label) : (stryCov_9fa48("268"), String((stryMutAct_9fa48("271") ? label != null : stryMutAct_9fa48("270") ? false : stryMutAct_9fa48("269") ? true : (stryCov_9fa48("269", "270", "271"), label == null)) ? stryMutAct_9fa48("272") ? "Stryker was here!" : (stryCov_9fa48("272"), '') : label).trim());
        if (stryMutAct_9fa48("275") ? false : stryMutAct_9fa48("274") ? true : stryMutAct_9fa48("273") ? cleanLabel : (stryCov_9fa48("273", "274", "275"), !cleanLabel)) throw new Error(stryMutAct_9fa48("277") ? "" : (stryCov_9fa48("277"), 'a label is required: the list is all labels'));
        const value = String((stryMutAct_9fa48("280") ? secret != null : stryMutAct_9fa48("279") ? false : stryMutAct_9fa48("278") ? true : (stryCov_9fa48("278", "279", "280"), secret == null)) ? stryMutAct_9fa48("281") ? "Stryker was here!" : (stryCov_9fa48("281"), '') : secret);
        if (stryMutAct_9fa48("284") ? false : stryMutAct_9fa48("283") ? true : stryMutAct_9fa48("282") ? value : (stryCov_9fa48("282", "283", "284"), !value)) throw new Error(stryMutAct_9fa48("286") ? "" : (stryCov_9fa48("286"), 'a secret is required'));
        const entry = stryMutAct_9fa48("287") ? {} : (stryCov_9fa48("287"), {
          id: crypto_.randomUUID(),
          label: cleanLabel,
          note: stryMutAct_9fa48("288") ? String(note == null ? '' : note) : (stryCov_9fa48("288"), String((stryMutAct_9fa48("291") ? note != null : stryMutAct_9fa48("290") ? false : stryMutAct_9fa48("289") ? true : (stryCov_9fa48("289", "290", "291"), note == null)) ? stryMutAct_9fa48("292") ? "Stryker was here!" : (stryCov_9fa48("292"), '') : note).trim()),
          secret: Buffer.from(crypto.encryptString(value)).toString(stryMutAct_9fa48("293") ? "" : (stryCov_9fa48("293"), 'base64')),
          createdAt: Date.now()
        });
        commit(stryMutAct_9fa48("295") ? [] : (stryCov_9fa48("295"), [...state.entries, entry]));
        return stryMutAct_9fa48("296") ? {} : (stryCov_9fa48("296"), {
          id: entry.id,
          label: entry.label,
          note: entry.note,
          createdAt: entry.createdAt
        });
      }
    }

    // What the window renders. The secret is not in it, by construction.
    function list() {
      if (stryMutAct_9fa48("297")) {
        {}
      } else {
        stryCov_9fa48("297");
        return state.entries.map(stryMutAct_9fa48("298") ? () => undefined : (stryCov_9fa48("298"), e => stryMutAct_9fa48("299") ? {} : (stryCov_9fa48("299"), {
          id: e.id,
          label: e.label,
          note: stryMutAct_9fa48("302") ? e.note && '' : stryMutAct_9fa48("301") ? false : stryMutAct_9fa48("300") ? true : (stryCov_9fa48("300", "301", "302"), e.note || (stryMutAct_9fa48("303") ? "Stryker was here!" : (stryCov_9fa48("303"), ''))),
          createdAt: stryMutAct_9fa48("306") ? e.createdAt && 0 : stryMutAct_9fa48("305") ? false : stryMutAct_9fa48("304") ? true : (stryCov_9fa48("304", "305", "306"), e.createdAt || 0)
        })));
      }
    }
    function get(id) {
      if (stryMutAct_9fa48("307")) {
        {}
      } else {
        stryCov_9fa48("307");
        const entry = state.entries.find(stryMutAct_9fa48("308") ? () => undefined : (stryCov_9fa48("308"), e => stryMutAct_9fa48("311") ? e.id !== id : stryMutAct_9fa48("310") ? false : stryMutAct_9fa48("309") ? true : (stryCov_9fa48("309", "310", "311"), e.id === id)));
        if (stryMutAct_9fa48("314") ? false : stryMutAct_9fa48("313") ? true : stryMutAct_9fa48("312") ? entry : (stryCov_9fa48("312", "313", "314"), !entry)) return null;
        try {
          if (stryMutAct_9fa48("315")) {
            {}
          } else {
            stryCov_9fa48("315");
            return crypto.decryptString(Buffer.from(entry.secret, stryMutAct_9fa48("316") ? "" : (stryCov_9fa48("316"), 'base64')));
          }
        } catch {
          if (stryMutAct_9fa48("317")) {
            {}
          } else {
            stryCov_9fa48("317");
            // One unreadable entry must not take the others with it: partial loss
            // beats total loss, and the caller can tell the user which one broke.
            return null;
          }
        }
      }
    }
    function remove(id) {
      if (stryMutAct_9fa48("318")) {
        {}
      } else {
        stryCov_9fa48("318");
        const before = state.entries.length;
        const next = stryMutAct_9fa48("319") ? state.entries : (stryCov_9fa48("319"), state.entries.filter(stryMutAct_9fa48("320") ? () => undefined : (stryCov_9fa48("320"), e => stryMutAct_9fa48("323") ? e.id === id : stryMutAct_9fa48("322") ? false : stryMutAct_9fa48("321") ? true : (stryCov_9fa48("321", "322", "323"), e.id !== id))));
        if (stryMutAct_9fa48("326") ? next.length !== before : stryMutAct_9fa48("325") ? false : stryMutAct_9fa48("324") ? true : (stryCov_9fa48("324", "325", "326"), next.length === before)) return stryMutAct_9fa48("327") ? true : (stryCov_9fa48("327"), false);
        if (stryMutAct_9fa48("328")) {
          ;
        } else {
          stryCov_9fa48("328");
          commit(next);
        }
        return stryMutAct_9fa48("329") ? false : (stryCov_9fa48("329"), true);
      }
    }
    return stryMutAct_9fa48("330") ? {} : (stryCov_9fa48("330"), {
      add,
      list,
      get,
      remove,
      available,
      file
    });
  }
}
module.exports = stryMutAct_9fa48("331") ? {} : (stryCov_9fa48("331"), {
  createVault,
  CLIPBOARD_CLEAR_MS
});
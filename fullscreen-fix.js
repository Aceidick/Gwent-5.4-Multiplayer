"use strict";

// fullscreen-fix.js — Prevents openFullscreen() unhandled rejection during
// online rematch. The Fullscreen API requires a user gesture, but
// startMatch() is called from a WebSocket message handler, not a click.
// requestFullscreen() rejects and disrupts game initialization, causing
// a desync at the round:start-effects barrier.

(function() {
    // 1. Wrap Element.prototype.requestFullscreen to catch all rejections.
    var origRFS = Element.prototype.requestFullscreen;
    if (origRFS) {
        Element.prototype.requestFullscreen = function() {
            try {
                var result = origRFS.apply(this, arguments);
                if (result && typeof result.catch === "function") {
                    result.catch(function(e) {
                        console.warn("[Gwent] requestFullscreen rejected (non-fatal):", e.message || e);
                    });
                }
                return result;
            } catch (e) {
                console.warn("[Gwent] requestFullscreen failed (non-fatal):", e.message || e);
            }
        };
    }

    // 2. Wrap webkitRequestFullscreen (Safari/older browsers).
    var origWK = Element.prototype.webkitRequestFullscreen;
    if (origWK) {
        Element.prototype.webkitRequestFullscreen = function() {
            try {
                origWK.apply(this, arguments);
            } catch (e) {
                console.warn("[Gwent] webkitRequestFullscreen failed (non-fatal):", e.message || e);
            }
        };
    }

    // 3. Safety net: suppress unhandled rejections caused by fullscreen errors.
    window.addEventListener("unhandledrejection", function(e) {
        if (e && e.reason) {
            var msg = e.reason.message || String(e.reason);
            if (msg && (msg.indexOf("Fullscreen") >= 0 || msg.indexOf("fullscreen") >= 0)) {
                console.warn("[Gwent] Suppressed fullscreen rejection:", msg);
                e.preventDefault();
            }
        }
  
  });

    // 4. Override the global openFullscreen function if it exists.
    // Catch both synchronous throws AND async promise rejections so that
    // callers using "await openFullscreen()" never receive a rejection.
    var _origOpenFullscreen = window.openFullscreen;
    if (typeof _origOpenFullscreen === "function") {
        window.openFullscreen = function() {
            try {
                var result = _origOpenFullscreen.call(this);
                if (result && typeof result.then === "function") {
                    return result.catch(function(e) {
                        console.warn("[Gwent] openFullscreen promise rejected (non-fatal):", e.message || e);
                    });
                }
                return result;
            } catch (e) {
                console.warn("[Gwent] openFullscreen failed (non-fatal):", e.message || e);
            }
        };
    }
    
    // 5. Deferred re-wrap: if openFullscreen is defined later (e.g. by a
    // script that loads after this fix), re-wrap it on DOMContentLoaded.
    window.addEventListener("DOMContentLoaded", function() {
        var orig = window.openFullscreen;
        if (typeof orig === "function" && orig._gwentFsWrapped) return;
        if (typeof orig === "function") {
            window.openFullscreen = function() {
                try {
                    var result = orig.call(this);
                    if (result && typeof result.then === "function") {
                        return result.catch(function(e) {
                            console.warn("[Gwent] openFullscreen promise rejected (non-fatal):", e.message || e);
                        });
                    }
                    return result;
                } catch (e) {
                    console.warn("[Gwent] openFullscreen failed (non-fatal):", e.message || e);
                }
            };
            window.openFullscreen._gwentFsWrapped = true;
        }
    });
})();

"use strict";

// faction-carousel-fix.js — Relay faction-ability carousel choices over the
// network for online multiplayer.
//
// Problem: When a player uses an active faction ability (e.g. Ofir's "search
// deck for a weather card") that opens a ui.queueCarousel(), the carousel
// choice is resolved locally but never relayed to the remote peer. The remote
// peer's patchRuntime() wrapper on ui.queueCarousel generates a decision ID
// like "faction:ofir:use:carousel:0" and waits for a choice message that
// never arrives, causing a 30s timeout and desync.
//
// Root cause: patchRuntime() wraps card abilities with withDecisionOwner()
// (which sets up carousel relay) but wraps faction abilities with
// withOwnedEffects() (which only binds effect ownership) WITHOUT also calling
// withDecisionOwner(). The faction-ability carousel opens without a decision
// owner context, so the ui.queueCarousel relay wrapper does not intercept
// Carousel.select to send choice/choice-commit/choice-end messages.
//
// Fix: Wrap Player.prototype.useFactionAbility BEFORE patchRuntime() runs.
// When patchRuntime() wraps it again (saving our version as
// oldUseFactionAbility), the call chain becomes:
//   1. patchRuntime() wrapper sets effect context (withOwnedEffects)
//   2. our wrapper sets decision owner (withDecisionOwner)
//   3. original useFactionAbility runs the faction ability
// The ui.queueCarousel wrapper then sees both the effect context AND the
// decision owner, and correctly relays the carousel choice.

(function() {
    if (typeof Player === "undefined" || !Player.prototype) return;
    if (typeof GwentOnline === "undefined" || !GwentOnline) return;

    var origUseFactionAbility = Player.prototype.useFactionAbility;
    if (typeof origUseFactionAbility !== "function") {
        console.warn("[Gwent] faction-carousel-fix: useFactionAbility not found");
        return;
    }

    Player.prototype.useFactionAbility = async function() {
        // Only wrap during active online matches
        if (!GwentOnline.active) {
            return origUseFactionAbility.apply(this, arguments);
        }

        // Only wrap if withDecisionOwner is available (online.js loaded)
        if (typeof GwentOnline.withDecisionOwner !== "function") {
            return origUseFactionAbility.apply(this, arguments);
        }

        // Skip if a decision owner is already set (patchRuntime may have
        // already wrapped this call path in a newer build)
        if (GwentOnline._decisionOwner) {
            return origUseFactionAbility.apply(this, arguments);
        }

        var factionName = (this.deck && this.deck.faction) || "";
        var label = "faction:" + factionName + ":use";
        var self = this;
        var args = arguments;

        console.log("[Gwent] faction-carousel-fix: wrapping useFactionAbility with decision owner", label);
        
        return await GwentOnline.withDecisionOwner(this, async function() {
            return await origUseFactionAbility.apply(self, args);
        }, label);
    };

    console.log("[Gwent] faction-carousel-fix installed");
})();

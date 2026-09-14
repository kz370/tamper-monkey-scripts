// ==UserScript==
// @name         Media Toolbox
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @author       khaledzaki370
// @updateURL    https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/media-toolbox.user.js
// @downloadURL  https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/media-toolbox.user.js
// @description  Pro audio & playback controls for HTML5 video/audio: 400% boost, 5-band EQ, balance, mono, voice boost, noise reduction, normalizer, speed, transport, visualizer, seek bar thumbnails, shortcuts
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%235b8cff'/%3E%3Cstop offset='1' stop-color='%23a86bff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='16' fill='url(%23g)'/%3E%3Cpath d='M18 26h8l11-10v32L26 38h-8z' fill='white'/%3E%3Cpath d='M43 23a13 13 0 0 1 0 18M48 18a21 21 0 0 1 0 28' fill='none' stroke='white' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E
// @match        *://*/*
// @resource     hlsjs https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.light.min.js
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // =========================================================
    // CONFIG
    // =========================================================

    const AUTO_COLLAPSE_DELAY = 2500;
    const RATE_RESET_WINDOW = 2000; // ms after a new source loads in which site rate resets are overridden
    const HOST_ID = 'media-toolbox';
    const SHARE_KEY = 'shareAll';               // userscript store: "Use across all sites" switch
    const SITES_KEY = 'autoSites';              // userscript store: hosts where saved settings load
    const SESSION_KEY = 'media-toolbox:tab';    // sessionStorage: this tab's settings

    const EQ_BANDS = [
        { freq: 60, type: 'lowshelf', label: '60' },
        { freq: 230, type: 'peaking', label: '230' },
        { freq: 910, type: 'peaking', label: '910' },
        { freq: 3600, type: 'peaking', label: '3.6k' },
        { freq: 14000, type: 'highshelf', label: '14k' }
    ];

    const EQ_PRESETS = {
        flat: { label: 'Flat', gains: [0, 0, 0, 0, 0] },
        bass: { label: 'Bass', gains: [7, 4, 0, 0, 1] },
        treble: { label: 'Treble', gains: [0, 0, 0, 4, 7] },
        vocal: { label: 'Vocal', gains: [-3, -1, 3, 5, 2] },
        loud: { label: 'Loudness', gains: [5, 2, -1, 2, 5] },
        cinema: { label: 'Cinema', gains: [4, 1, 0, 2, 3] }
    };

    const VOLUME_PRESETS = [50, 100, 150, 200, 300, 400];
    const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];

    const DEFAULTS = {
        // Audio
        volume: 1,
        speed: 1,
        preservePitch: true,
        mono: false,
        balance: 0,
        eq: [0, 0, 0, 0, 0],
        voice: false,
        noise: false,
        compressor: false,
        // Player
        thumbs: false,
        seekArrow: 5,       // seconds per ←/→
        seekAlt: 10,        // seconds per Alt+←/→
        seekCtrl: 15,       // seconds per Ctrl+←/→
        // UI
        side: 'left',
        offset: 50,
        pinned: false,
        tab: 'sound'
    };

    const AUDIO_KEYS = ['volume', 'speed', 'preservePitch', 'mono', 'balance', 'eq', 'voice', 'noise', 'compressor'];
    const PLAYER_KEYS = ['thumbs', 'seekArrow', 'seekAlt', 'seekCtrl']; // saved like audio keys, but "Reset everything" leaves them alone
    const SEEK_KEYS = ['seekArrow', 'seekAlt', 'seekCtrl'];
    const UI_KEYS = ['side', 'offset', 'pinned', 'tab'];

    // =========================================================
    // STORAGE
    // =========================================================

    const store = {
        get(key, fallback) {
            try {
                if (typeof GM_getValue === 'function') {
                    const value = GM_getValue(key, fallback);
                    return value === undefined ? fallback : value;
                }
            } catch (error) { /* fall through to localStorage */ }

            try {
                const raw = localStorage.getItem('aat:' + key);
                return raw == null ? fallback : JSON.parse(raw);
            } catch (error) {
                return fallback;
            }
        },

        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                    return;
                }
            } catch (error) { /* fall through to localStorage */ }

            try {
                localStorage.setItem('aat:' + key, JSON.stringify(value));
            } catch (error) { /* storage unavailable */ }
        }
    };

    // Per-tab storage: sessionStorage is scoped to this tab and cleared when it closes.
    const session = {
        get() {
            try {
                const raw = sessionStorage.getItem(SESSION_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (error) {
                return null;
            }
        },

        set(value) {
            try {
                sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
            } catch (error) { /* storage unavailable */ }
        }
    };

    function pick(source, keys) {
        const out = {};
        keys.forEach(key => { out[key] = source[key]; });
        return out;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    // Persistence: by default settings live only in this tab (they survive a
    // reload, nothing outlives the tab). One saved profile exists in the
    // userscript store; it loads on every site with "Use across all sites" on,
    // otherwise only on the sites in the auto-on list.
    function isShared() {
        return store.get(SHARE_KEY, false) === true;
    }

    function getAutoSites() {
        const list = store.get(SITES_KEY, []);
        return Array.isArray(list) ? list.filter(host => typeof host === 'string' && host) : [];
    }

    function isAutoSite() {
        return getAutoSites().includes(location.hostname);
    }

    function loadSettings() {
        const shareAll = isShared();
        const siteAuto = isAutoSite();
        const saved = shareAll || siteAuto ? store.get('global', null) : session.get();
        const loaded = Object.assign({}, DEFAULTS, saved || {});

        loaded.eq = EQ_BANDS.map((_, i) => clamp(Number((loaded.eq || [])[i]) || 0, -12, 12));
        loaded.volume = clamp(Number(loaded.volume) || 1, 0, 4);
        loaded.speed = clamp(Number(loaded.speed) || 1, 0.25, 4);
        loaded.balance = clamp(Number(loaded.balance) || 0, -1, 1);
        loaded.offset = clamp(Number(loaded.offset) || 50, 5, 95);
        loaded.thumbs = loaded.thumbs === true;
        SEEK_KEYS.forEach(key => {
            loaded[key] = clamp(Math.round(Number(loaded[key])) || DEFAULTS[key], 1, 600);
        });
        loaded.muted = false; // never restore a muted state
        loaded.shareAll = shareAll;
        loaded.siteAuto = siteAuto;

        return loaded;
    }

    const settings = loadSettings();

    let saveTimer = null;

    function saveSettings() {
        clearTimeout(saveTimer);

        saveTimer = setTimeout(() => {
            const data = pick(settings, AUDIO_KEYS.concat(PLAYER_KEYS, UI_KEYS));

            // Another tab may have changed where settings are saved meanwhile.
            settings.shareAll = isShared();
            settings.siteAuto = isAutoSite();

            if (settings.shareAll || settings.siteAuto) {
                store.set('global', data);
            } else {
                session.set(data);
            }
        }, 250);
    }

    // With sharing off and no auto-on sites left, nothing stays saved.
    function afterPersistChange() {
        if (!isShared() && !getAutoSites().length) {
            store.set('global', null);
        }
        saveSettings();
    }

    function setShareAll(on) {
        settings.shareAll = on;
        store.set(SHARE_KEY, on);
        afterPersistChange();
    }

    function setAutoSites(list) {
        const unique = [...new Set(list.map(host => host.trim().toLowerCase()).filter(Boolean))];
        store.set(SITES_KEY, unique);
        settings.siteAuto = unique.includes(location.hostname);
        afterPersistChange();
    }

    function setSiteAuto(on) {
        const others = getAutoSites().filter(host => host !== location.hostname);
        setAutoSites(on ? others.concat(location.hostname) : others);
    }

    // =========================================================
    // AUDIO ENGINE
    // =========================================================
    //
    // source → channel (mono downmix) → 5-band EQ → voice filters
    //        → compressor → balance → master gain → limiter → analyser → out
    //
    // Media is routed through Web Audio only when an effect is actually
    // needed, because createMediaElementSource() is irreversible and
    // silences cross-origin media served without CORS headers.

    const mediaStates = new WeakMap();

    let audioContext = null;

    function getAudioContext() {
        if (audioContext) {
            return audioContext;
        }

        const Ctx = window.AudioContext || window.webkitAudioContext;

        if (!Ctx) {
            console.warn('[Media Toolbox] Web Audio API unavailable.');
            return null;
        }

        audioContext = new Ctx({ latencyHint: 'playback' });

        return audioContext;
    }

    function resumeAudio() {
        if (audioContext && audioContext.state === 'suspended') {
            audioContext.resume().catch(() => {});
        }
    }

    function hasUserActivation() {
        const activation = navigator.userActivation;
        return activation ? activation.hasBeenActive : true;
    }

    function needsGraph() {
        return settings.volume !== 1 ||
            settings.muted ||
            settings.mono ||
            settings.balance !== 0 ||
            settings.voice ||
            settings.noise ||
            settings.compressor ||
            settings.eq.some(gain => gain !== 0);
    }

    function isCorsBlocked(media) {
        if (media.srcObject || media.crossOrigin) {
            return false;
        }

        const src = media.currentSrc || media.src;

        if (!src || /^(blob|data|mediastream):/i.test(src)) {
            return false;
        }

        try {
            return new URL(src, location.href).origin !== location.origin;
        } catch (error) {
            return false;
        }
    }

    function hookMedia(media) {
        if (mediaStates.has(media)) {
            return mediaStates.get(media);
        }

        // Wait until the source is known so the CORS check is meaningful.
        if (!media.currentSrc && !media.srcObject) {
            return null;
        }

        if (isCorsBlocked(media)) {
            const blocked = { blocked: true };
            mediaStates.set(media, blocked);
            return blocked;
        }

        const ctx = getAudioContext();

        if (!ctx) {
            return null;
        }

        try {
            const source = ctx.createMediaElementSource(media);

            const channel = ctx.createGain();
            channel.channelCountMode = 'explicit';
            channel.channelInterpretation = 'speakers';
            channel.channelCount = 2;

            // Noise reduction: rumble high-pass, mains-hum cuts, hiss shelf.
            const nrRumble = ctx.createBiquadFilter();
            nrRumble.type = 'highpass';
            nrRumble.frequency.value = 10;
            nrRumble.Q.value = 0.7;

            const nrHum = [50, 60, 100, 120].map(freq => {
                const filter = ctx.createBiquadFilter();
                filter.type = 'peaking';
                filter.frequency.value = freq;
                filter.Q.value = 12;
                return filter;
            });

            const nrHiss = ctx.createBiquadFilter();
            nrHiss.type = 'highshelf';
            nrHiss.frequency.value = 7000;

            const eq = EQ_BANDS.map(band => {
                const filter = ctx.createBiquadFilter();
                filter.type = band.type;
                filter.frequency.value = band.freq;
                if (band.type === 'peaking') {
                    filter.Q.value = 1.1;
                }
                return filter;
            });

            const voiceCut = ctx.createBiquadFilter();
            voiceCut.type = 'highpass';
            voiceCut.frequency.value = 10;
            voiceCut.Q.value = 0.7;

            const presence = ctx.createBiquadFilter();
            presence.type = 'peaking';
            presence.frequency.value = 2500;
            presence.Q.value = 0.9;

            const compressor = ctx.createDynamicsCompressor();
            compressor.attack.value = 0.004;
            compressor.release.value = 0.22;

            const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;

            const master = ctx.createGain();

            const limiter = ctx.createDynamicsCompressor();
            limiter.attack.value = 0.002;
            limiter.release.value = 0.1;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;

            const chain = [source, channel, nrRumble, ...nrHum, nrHiss, ...eq, voiceCut, presence, compressor, panner, master, limiter, analyser]
                .filter(Boolean);

            chain.reduce((from, to) => {
                from.connect(to);
                return to;
            });

            analyser.connect(ctx.destination);

            const state = { ctx, channel, nrRumble, nrHum, nrHiss, eq, voiceCut, presence, compressor, panner, master, limiter, analyser };

            mediaStates.set(media, state);
            applyAudio(state);

            return state;

        } catch (error) {
            // Typically the page already owns a MediaElementSource for this element.
            console.warn('[Media Toolbox] Failed to process media:', error);

            const failed = { blocked: true, failed: true };
            mediaStates.set(media, failed);
            return failed;
        }
    }

    function applyAudio(state) {
        if (!state || state.blocked) {
            return;
        }

        const now = state.ctx.currentTime;
        const ramp = (param, value) => param.setTargetAtTime(value, now, 0.02);

        state.channel.channelCount = settings.mono ? 1 : 2;

        state.eq.forEach((filter, i) => ramp(filter.gain, settings.eq[i]));

        ramp(state.nrRumble.frequency, settings.noise ? 90 : 10);
        state.nrHum.forEach(filter => ramp(filter.gain, settings.noise ? -18 : 0));
        ramp(state.nrHiss.gain, settings.noise ? -10 : 0);

        ramp(state.voiceCut.frequency, settings.voice ? 130 : 10);
        ramp(state.presence.gain, settings.voice ? 6 : 0);

        // A ratio of 1 with a 0 dB threshold makes the compressor transparent.
        ramp(state.compressor.threshold, settings.compressor ? -30 : 0);
        ramp(state.compressor.ratio, settings.compressor ? 5 : 1);
        ramp(state.compressor.knee, settings.compressor ? 18 : 0);

        if (state.panner) {
            ramp(state.panner.pan, settings.balance);
        }

        ramp(state.master.gain, settings.muted ? 0 : settings.volume);

        // Catch clipping only while boosting.
        const boosting = settings.volume > 1 && !settings.muted;
        ramp(state.limiter.threshold, boosting ? -2 : 0);
        ramp(state.limiter.ratio, boosting ? 12 : 1);
        ramp(state.limiter.knee, boosting ? 3 : 0);
    }

    // =========================================================
    // MEDIA TRACKING & PLAYBACK
    // =========================================================

    const tracked = new Set();
    const loadTimes = new WeakMap();

    let lastActive = null;

    function getMediaList() {
        tracked.forEach(media => {
            if (!media.isConnected) {
                tracked.delete(media);
            }
        });

        return [...tracked];
    }

    function mediaArea(media) {
        const rect = media.getBoundingClientRect();
        return rect.width * rect.height;
    }

    function largest(list) {
        return list.reduce((best, media) => (mediaArea(media) > mediaArea(best) ? media : best), list[0]) || null;
    }

    function getActiveMedia() {
        const list = getMediaList();
        const playing = list.filter(media => !media.paused && !media.ended);

        if (lastActive && playing.includes(lastActive)) {
            return lastActive;
        }

        if (playing.length) {
            return largest(playing);
        }

        if (lastActive && list.includes(lastActive)) {
            return lastActive;
        }

        return largest(list);
    }

    function applyPlayback(media) {
        const keep = settings.preservePitch;

        if ('preservesPitch' in media) {
            media.preservesPitch = keep;
        } else if ('mozPreservesPitch' in media) {
            media.mozPreservesPitch = keep;
        } else if ('webkitPreservesPitch' in media) {
            media.webkitPreservesPitch = keep;
        }

        if (Math.abs(media.playbackRate - settings.speed) > 0.001) {
            try {
                media.playbackRate = settings.speed;
            } catch (error) { /* unsupported rate */ }
        }
    }

    function onRateChange(media) {
        const rate = media.playbackRate;

        if (Math.abs(rate - settings.speed) < 0.001) {
            return;
        }

        const loadedAt = loadTimes.get(media) || 0;

        if (Date.now() - loadedAt < RATE_RESET_WINDOW) {
            // Player reset the rate for a new source: keep ours.
            applyPlayback(media);
            return;
        }

        if (media === getActiveMedia()) {
            // User changed speed with the site's own controls: follow it.
            settings.speed = clamp(rate, 0.25, 4);
            saveSettings();
            scheduleRender();
        }
    }

    function syncMedia(media) {
        applyPlayback(media);

        let state = mediaStates.get(media);

        if (!state && needsGraph() && hasUserActivation()) {
            state = hookMedia(media);
        }

        if (state) {
            applyAudio(state);
        }
    }

    function syncAll() {
        getMediaList().forEach(syncMedia);

        if (needsGraph()) {
            resumeAudio();
        }

        saveSettings();
        scheduleRender();
    }

    function trackMedia(media) {
        if (tracked.has(media)) {
            return;
        }

        tracked.add(media);

        media.addEventListener('play', () => {
            lastActive = media;
            resumeAudio();
            syncMedia(media);
            scheduleRender();
        });

        media.addEventListener('pause', scheduleRender);
        media.addEventListener('ended', scheduleRender);
        media.addEventListener('loadstart', () => loadTimes.set(media, Date.now()));
        media.addEventListener('loadedmetadata', () => {
            syncMedia(media);
            scheduleRender();
        });
        media.addEventListener('ratechange', () => onRateChange(media));
        media.addEventListener('timeupdate', () => {
            if (panelOpen && media === getActiveMedia()) {
                renderTransport();
            }
        });

        syncMedia(media);
    }

    // Audio can only start after a user gesture: hook deferred media then.
    function onFirstGesture() {
        document.removeEventListener('pointerdown', onFirstGesture, true);
        document.removeEventListener('keydown', onFirstGesture, true);
        setTimeout(() => {
            getMediaList().forEach(syncMedia);
            if (needsGraph()) {
                resumeAudio();
            }
            scheduleRender();
        }, 0);
    }

    document.addEventListener('pointerdown', onFirstGesture, true);
    document.addEventListener('keydown', onFirstGesture, true);

    // =========================================================
    // SVG ICONS
    // =========================================================

    const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

    const ICON = {
        speaker: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
        speakerLow: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
        muted: svg('<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6"/><path d="M16 9l6 6"/>'),
        logo: svg('<path d="M4 10v4"/><path d="M8 6v12"/><path d="M12 3v18"/><path d="M16 7v10"/><path d="M20 10v4"/>'),
        pin: svg('<path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/>'),
        reset: svg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>'),
        close: svg('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
        play: svg('<path class="fill" d="M7 4.5v15l13-7.5z"/>'),
        pause: svg('<path class="fill" d="M6 4h4v16H6zM14 4h4v16h-4z"/>'),
        back: svg('<path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/>'),
        forward: svg('<path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/>'),
        loop: svg('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>'),
        pip: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect class="fill" x="12" y="12" width="7" height="5" rx="1"/>'),
        mono: svg('<circle cx="12" cy="12" r="4"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/>'),
        mic: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v5"/>'),
        noise: svg('<path d="M2 12h2l2-5 3 10 3-7 2 4h2"/><path d="M19 8l3 3"/><path d="M22 8l-3 3"/>'),
        gauge: svg('<path d="M3 12h3l3-7 6 14 3-7h3"/>'),
        pitch: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
        keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
        minus: svg('<path d="M5 12h14"/>'),
        plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
        thumbs: svg('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>')
    };

    // =========================================================
    // CSS (lives inside a shadow root, isolated from the page)
    // =========================================================

    const CSS = `
        :host {
            all: initial;
            --bg: rgba(14, 15, 20, .97);
            --surface: rgba(255, 255, 255, .075);
            --surface-hover: rgba(255, 255, 255, .1);
            --line: rgba(255, 255, 255, .09);
            --text: #f4f5f8;
            --muted: #c3c8d2;
            --accent: #5b8cff;
            --accent-2: #a86bff;
            --grad: linear-gradient(135deg, var(--accent), var(--accent-2));
            --radius: 16px;
            --ease: cubic-bezier(.2, .9, .3, 1.15);
        }

        /* Font lives on .root: the host's inline "all: initial" beats :host. */
        .root {
            font: 500 13px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
            color: var(--text);
            -webkit-font-smoothing: antialiased;
            text-align: left;
        }

        *, *::before, *::after { box-sizing: border-box; }
        [hidden] { display: none !important; }

        button {
            font: inherit;
            color: inherit;
            background: none;
            border: 0;
            margin: 0;
            padding: 0;
            cursor: pointer;
            -webkit-tap-highlight-color: transparent;
        }

        button:focus-visible, input:focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }

        svg {
            width: 16px;
            height: 16px;
            fill: none;
            stroke: currentColor;
            stroke-width: 2;
            stroke-linecap: round;
            stroke-linejoin: round;
            flex-shrink: 0;
            display: block;
        }

        svg .fill { fill: currentColor; stroke: none; }

        /* ------------------------------------------------ EDGE TAB */

        .tab {
            position: fixed;
            top: var(--offset, 50%);
            left: 0;
            transform: translateY(-50%);
            width: 10px;
            height: 76px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            overflow: hidden;
            border-radius: 0 12px 12px 0;
            background: var(--bg);
            border: 1px solid var(--line);
            border-left: 0;
            box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
            backdrop-filter: blur(16px) saturate(1.4);
            -webkit-backdrop-filter: blur(16px) saturate(1.4);
            pointer-events: auto;
            touch-action: none;
            transition: width .22s var(--ease), background .2s ease, opacity .2s ease;
        }

        .tab::before {
            content: "";
            position: absolute;
            inset: 0;
            background: var(--grad);
            opacity: 0;
            transition: opacity .2s ease;
        }

        .tab > * { position: relative; opacity: 0; transition: opacity .15s ease; }

        .tab:hover, .root.open .tab, .tab.dragging { width: 40px; }
        .tab:hover::before, .root.open .tab::before, .tab.dragging::before { opacity: 1; }
        .tab:hover > *, .root.open .tab > *, .tab.dragging > * { opacity: 1; }
        .tab svg { width: 18px; height: 18px; }
        .tab.dragging { cursor: grabbing; }

        .tab-badge {
            font-size: 10px;
            font-weight: 800;
            line-height: 1;
            letter-spacing: -.2px;
            font-variant-numeric: tabular-nums;
        }

        /* An empty badge would still take a flex slot + gap and push the icon off-center. */
        .tab-badge:empty { display: none; }
        [data-ref="tabIcon"] { display: grid; place-items: center; line-height: 0; }

        /* Glowing dot on the collapsed tab when effects are active */
        .tab::after {
            content: "";
            position: absolute;
            top: 50%;
            right: 1px;
            width: 3px;
            height: 22px;
            margin-top: -11px;
            border-radius: 3px;
            background: var(--grad);
            box-shadow: 0 0 8px var(--accent);
            opacity: 0;
            transition: opacity .2s ease;
        }

        .root:not(.open) .tab:not(:hover):not(.dragging)::after { opacity: .55; }
        .root.fx:not(.open) .tab:not(:hover):not(.dragging)::after { opacity: 1; }

        .root.right .tab {
            left: auto;
            right: 0;
            border-radius: 12px 0 0 12px;
            border-left: 1px solid var(--line);
            border-right: 0;
        }

        .root.right .tab::after { right: auto; left: 1px; }

        /* ------------------------------------------------ PANEL */

        .panel {
            position: fixed;
            left: 12px;
            top: 50%;
            width: 344px;
            max-width: calc(100vw - 24px);
            max-height: calc(100vh - 16px);
            overflow-y: auto;
            overscroll-behavior: contain;
            scrollbar-width: thin;
            padding: 14px;
            border-radius: var(--radius);
            background: var(--bg);
            border: 1px solid var(--line);
            box-shadow: 0 24px 60px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255, 255, 255, .06);
            backdrop-filter: blur(22px) saturate(1.5);
            -webkit-backdrop-filter: blur(22px) saturate(1.5);
            opacity: 0;
            visibility: hidden;
            transform: translateX(-16px) scale(.97);
            transform-origin: left center;
            pointer-events: none;
            transition: opacity .2s ease, transform .28s var(--ease), visibility 0s linear .28s;
        }

        .root.right .panel {
            left: auto;
            right: 12px;
            transform: translateX(16px) scale(.97);
            transform-origin: right center;
        }

        .root.open .panel {
            opacity: 1;
            visibility: visible;
            transform: none;
            pointer-events: auto;
            transition: opacity .2s ease, transform .28s var(--ease), visibility 0s;
        }

        .root.with-tab .panel { left: 50px; }
        .root.right.with-tab .panel { left: auto; right: 50px; }

        /* ------------------------------------------------ HEADER */

        .head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 12px;
        }

        .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }

        .logo {
            width: 32px;
            height: 32px;
            border-radius: 10px;
            display: grid;
            place-items: center;
            background: var(--grad);
            box-shadow: 0 4px 14px rgba(91, 140, 255, .4);
            flex-shrink: 0;
        }

        .brand-text { display: flex; flex-direction: column; min-width: 0; }
        .brand-text strong { font-size: 15px; font-weight: 700; letter-spacing: .1px; }

        .status {
            color: var(--muted);
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: flex;
            align-items: center;
            gap: 5px;
        }

        .status::before {
            content: "";
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: #5c616b;
            flex-shrink: 0;
        }

        .status.live::before { background: #34d399; box-shadow: 0 0 6px #34d399; }

        .head-actions { display: flex; gap: 2px; }

        .icon-btn {
            width: 30px;
            height: 30px;
            border-radius: 9px;
            display: grid;
            place-items: center;
            color: var(--muted);
            transition: background .15s ease, color .15s ease, transform .1s ease;
        }

        .icon-btn:hover { background: var(--surface-hover); color: var(--text); }
        .icon-btn:active { transform: scale(.92); }
        .icon-btn.on { color: var(--accent); background: rgba(91, 140, 255, .14); }
        .icon-btn:disabled { opacity: .35; pointer-events: none; }

        /* ------------------------------------------------ VISUALIZER */

        .viz-wrap {
            position: relative;
            height: 56px;
            border-radius: 12px;
            background: rgba(0, 0, 0, .28);
            border: 1px solid var(--line);
            overflow: hidden;
        }

        .viz { width: 100%; height: 100%; display: block; }

        .viz-note {
            position: absolute;
            inset: 0;
            display: grid;
            place-items: center;
            padding: 0 12px;
            text-align: center;
            color: var(--muted);
            font-size: 12px;
            pointer-events: none;
        }

        /* ------------------------------------------------ TRANSPORT */

        .transport { margin-top: 10px; }

        .seek-row {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--muted);
            font-size: 12px;
            font-variant-numeric: tabular-nums;
        }

        .seek-row span { min-width: 40px; }
        .seek-row span:last-child { text-align: right; }

        .tbar {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 4px;
            margin-top: 4px;
        }

        .tbar .spacer { flex: 1; }

        .play-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            display: grid;
            place-items: center;
            background: var(--text);
            color: #111;
            box-shadow: 0 4px 16px rgba(0, 0, 0, .35);
            transition: transform .15s var(--ease);
        }

        .play-btn:hover { transform: scale(1.06); }
        .play-btn:active { transform: scale(.94); }
        .play-btn svg { width: 16px; height: 16px; }
        .play-btn:disabled { opacity: .35; pointer-events: none; }

        /* ------------------------------------------------ SEGMENTED TABS */

        .tabs {
            position: relative;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            margin: 12px 0 12px;
            padding: 3px;
            border-radius: 11px;
            background: var(--surface);
        }

        .seg {
            position: relative;
            z-index: 1;
            height: 28px;
            border-radius: 8px;
            color: var(--muted);
            font-size: 13px;
            font-weight: 600;
            transition: color .15s ease;
        }

        .seg.on { color: var(--text); }

        .seg-ind {
            position: absolute;
            top: 3px;
            bottom: 3px;
            left: 3px;
            width: calc((100% - 6px) / 4);
            border-radius: 8px;
            background: rgba(255, 255, 255, .12);
            box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
            transition: transform .28s var(--ease);
        }

        .page { animation: fade .22s ease; }

        @keyframes fade {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: none; }
        }

        /* ------------------------------------------------ FIELDS */

        .field + .field { margin-top: 14px; }

        .field-head {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            margin-bottom: 6px;
        }

        .field-head label {
            color: var(--muted);
            font-size: 11.5px;
            font-weight: 700;
            letter-spacing: .6px;
            text-transform: uppercase;
        }

        output {
            font-size: 15px;
            font-weight: 700;
            font-variant-numeric: tabular-nums;
        }

        output.boost {
            background: var(--grad);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .slider-row { display: flex; align-items: center; gap: 6px; }
        .slider-row .range { flex: 1; }
        .mini { color: var(--muted); font-size: 12px; font-weight: 700; width: 12px; text-align: center; }

        /* ------------------------------------------------ RANGE */

        .range {
            --p: 50%;
            -webkit-appearance: none;
            appearance: none;
            width: 100%;
            height: 22px;
            margin: 0;
            background: transparent;
            cursor: pointer;
        }

        .range::-webkit-slider-runnable-track {
            height: 5px;
            border-radius: 5px;
            background: linear-gradient(90deg, var(--accent), var(--accent-2)) 0 / var(--p) 100% no-repeat, rgba(255, 255, 255, .12);
        }

        .range::-moz-range-track { height: 5px; border-radius: 5px; background: rgba(255, 255, 255, .12); }
        .range::-moz-range-progress { height: 5px; border-radius: 5px; background: var(--grad); }

        .range::-webkit-slider-thumb {
            -webkit-appearance: none;
            width: 15px;
            height: 15px;
            margin-top: -5px;
            border-radius: 50%;
            background: #fff;
            border: 0;
            box-shadow: 0 1px 6px rgba(0, 0, 0, .45);
            transition: transform .15s var(--ease);
        }

        .range::-moz-range-thumb {
            width: 15px;
            height: 15px;
            border-radius: 50%;
            background: #fff;
            border: 0;
            box-shadow: 0 1px 6px rgba(0, 0, 0, .45);
        }

        .range:hover::-webkit-slider-thumb, .range:active::-webkit-slider-thumb { transform: scale(1.2); }

        /* Center-anchored fill (balance, EQ) */
        .range.center::-webkit-slider-runnable-track {
            background:
                linear-gradient(90deg, transparent var(--lo), var(--accent) var(--lo), var(--accent-2) var(--hi), transparent var(--hi)),
                rgba(255, 255, 255, .12);
        }

        .range.center::-moz-range-progress { background: transparent; }

        .seek::-webkit-slider-runnable-track { height: 4px; }
        .seek::-webkit-slider-thumb { width: 12px; height: 12px; margin-top: -4px; }

        /* ------------------------------------------------ CHIPS */

        .chips {
            display: grid;
            grid-template-columns: repeat(var(--cols, 4), 1fr);
            gap: 5px;
            margin-top: 8px;
        }

        .chip {
            min-width: 0;
            height: 30px;
            padding: 0 4px;
            white-space: nowrap;
            border-radius: 999px;
            background: var(--surface);
            border: 1px solid transparent;
            color: var(--text);
            font-size: 12.5px;
            font-weight: 600;
            font-variant-numeric: tabular-nums;
            transition: background .15s ease, color .15s ease, border-color .15s ease, transform .1s ease;
        }

        .chip:hover { background: var(--surface-hover); color: var(--text); }
        .chip:active { transform: scale(.94); }

        .chip.on {
            color: #fff;
            background: var(--grad);
            box-shadow: 0 2px 10px rgba(91, 140, 255, .35);
        }

        /* ------------------------------------------------ TOGGLES */

        .toggles { display: grid; gap: 6px; margin-top: 14px; }

        .toggle {
            width: 100%;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 10px;
            border-radius: 12px;
            background: var(--surface);
            border: 1px solid transparent;
            text-align: left;
            transition: background .15s ease, border-color .15s ease;
        }

        .toggle:hover { background: var(--surface-hover); }

        .toggle .t-ico {
            width: 30px;
            height: 30px;
            border-radius: 9px;
            display: grid;
            place-items: center;
            background: rgba(255, 255, 255, .07);
            color: var(--muted);
            transition: background .2s ease, color .2s ease;
        }

        .toggle .t-text { flex: 1; display: flex; flex-direction: column; }
        .toggle b { font-weight: 650; font-size: 13.5px; }
        .toggle small { color: var(--muted); font-size: 12px; }

        .toggle .t-sw {
            width: 30px;
            height: 18px;
            border-radius: 18px;
            background: rgba(255, 255, 255, .16);
            position: relative;
            transition: background .2s ease;
            flex-shrink: 0;
        }

        .toggle .t-sw::after {
            content: "";
            position: absolute;
            top: 2px;
            left: 2px;
            width: 14px;
            height: 14px;
            border-radius: 50%;
            background: #fff;
            box-shadow: 0 1px 3px rgba(0, 0, 0, .4);
            transition: transform .22s var(--ease);
        }

        .toggle.on { border-color: rgba(91, 140, 255, .35); background: rgba(91, 140, 255, .1); }
        .toggle.on .t-ico { background: var(--grad); color: #fff; }
        .toggle.on .t-sw { background: var(--grad); }
        .toggle.on .t-sw::after { transform: translateX(12px); }
        .toggle:disabled { opacity: .4; pointer-events: none; }

        /* Compact 2-column toggles: state shown by the highlighted icon and tint */
        .toggles.compact { grid-template-columns: 1fr 1fr; }
        .toggles.compact .toggle { padding: 7px 8px; gap: 8px; }
        .toggles.compact .t-ico { width: 26px; height: 26px; border-radius: 8px; }
        .toggles.compact b { font-size: 12.5px; white-space: nowrap; }
        .toggles.compact small, .toggles.compact .t-sw { display: none; }

        /* ------------------------------------------------ SEEK STEPS */

        .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }

        .step {
            display: flex;
            flex-direction: column;
            gap: 5px;
            padding: 7px 8px;
            border-radius: 10px;
            background: var(--surface);
            cursor: text;
        }

        .step span { color: var(--muted); font-size: 11.5px; font-weight: 700; white-space: nowrap; }

        .step input {
            width: 100%;
            font: inherit;
            font-size: 14px;
            font-weight: 650;
            font-variant-numeric: tabular-nums;
            color: var(--text);
            background: rgba(0, 0, 0, .28);
            border: 1px solid var(--line);
            border-radius: 7px;
            padding: 4px 6px;
            margin: 0;
        }

        .step input:focus { outline: none; border-color: var(--accent); }

        /* ------------------------------------------------ EQ */

        .eq {
            display: grid;
            grid-template-columns: repeat(${EQ_BANDS.length}, 1fr);
            gap: 4px;
            margin-top: 12px;
            padding: 10px 4px 8px;
            border-radius: 12px;
            background: var(--surface);
        }

        .band { display: flex; flex-direction: column; align-items: center; gap: 4px; }
        .band output { font-size: 12px; min-height: 14px; color: var(--muted); }
        .band output.set { color: var(--text); }
        .band span { color: var(--muted); font-size: 11.5px; font-weight: 700; }

        .vwrap { width: 26px; height: 116px; position: relative; }

        .vwrap .range {
            position: absolute;
            top: 50%;
            left: 50%;
            width: 116px;
            transform: translate(-50%, -50%) rotate(-90deg);
        }

        .hint { color: var(--muted); font-size: 12px; margin: 8px 2px 0; text-align: center; }

        .warn {
            margin-top: 12px;
            padding: 8px 10px;
            border-radius: 10px;
            background: rgba(251, 191, 36, .1);
            border: 1px solid rgba(251, 191, 36, .25);
            color: #fcd34d;
            font-size: 12px;
        }

        /* ------------------------------------------------ FOOTER */

        .switch {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            color: var(--muted);
            font-size: 12.5px;
            cursor: pointer;
        }

        .switch input { position: absolute; opacity: 0; pointer-events: none; }

        .knob {
            width: 26px;
            height: 15px;
            border-radius: 15px;
            background: rgba(255, 255, 255, .16);
            position: relative;
            flex-shrink: 0;
            transition: background .2s ease;
        }

        .knob::after {
            content: "";
            position: absolute;
            top: 2px;
            left: 2px;
            width: 11px;
            height: 11px;
            border-radius: 50%;
            background: #fff;
            transition: transform .22s var(--ease);
        }

        .switch input:checked + .knob { background: var(--grad); }
        .switch input:checked + .knob::after { transform: translateX(11px); }
        .switch input:focus-visible + .knob { outline: 2px solid var(--accent); outline-offset: 2px; }
        .switch b { color: var(--text); font-weight: 600; }
        .switch .host-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .foot-switches { display: flex; flex-direction: column; gap: 7px; min-width: 0; }

        .keys {
            margin-top: 10px;
            padding: 10px;
            border-radius: 12px;
            background: var(--surface);
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 6px 10px;
            align-items: center;
            font-size: 12.5px;
            color: var(--muted);
        }

        kbd {
            font: 600 11.5px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
            color: var(--text);
            padding: 4px 6px;
            border-radius: 6px;
            background: rgba(255, 255, 255, .1);
            border-bottom: 2px solid rgba(255, 255, 255, .12);
            white-space: nowrap;
            justify-self: start;
        }

        /* ------------------------------------------------ TOAST */

        .toast {
            position: fixed;
            top: 12%;
            left: 50%;
            transform: translate(-50%, -10px);
            padding: 10px 16px;
            min-width: 140px;
            border-radius: 14px;
            background: var(--bg);
            border: 1px solid var(--line);
            box-shadow: 0 16px 40px rgba(0, 0, 0, .5);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 7px;
            opacity: 0;
            pointer-events: none;
            transition: opacity .18s ease, transform .25s var(--ease);
        }

        .toast.show { opacity: 1; transform: translate(-50%, 0); }
        .toast-text { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
        .toast-bar { width: 100%; height: 4px; border-radius: 4px; background: rgba(255, 255, 255, .12); overflow: hidden; }
        .toast-bar i { display: block; height: 100%; background: var(--grad); border-radius: 4px; transition: width .15s ease; }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { transition-duration: 0s !important; animation: none !important; }
        }
    `;

    // =========================================================
    // TEMPLATE
    // =========================================================

    // Sites like YouTube enforce Trusted Types, which rejects plain innerHTML.
    const htmlPolicy = (() => {
        try {
            if (window.trustedTypes && window.trustedTypes.createPolicy) {
                return window.trustedTypes.createPolicy('media-toolbox', { createHTML: s => s });
            }
        } catch (error) { /* policy name not allowed */ }
        return null;
    })();

    function toHTML(markup) {
        return htmlPolicy ? htmlPolicy.createHTML(markup) : markup;
    }

    function escapeHTML(text) {
        return String(text).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[c]);
    }

    function formatSpeed(speed) {
        return (Math.round(speed * 100) / 100) + '×';
    }

    function buildTemplate() {
        const chip = (attr, value, label) =>
            `<button class="chip" ${attr}="${value}">${label}</button>`;

        const toggle = (key, icon, title, desc) => `
            <button class="toggle" data-toggle="${key}" aria-pressed="false" title="${desc}">
                <span class="t-ico">${icon}</span>
                <span class="t-text"><b>${title}</b><small>${desc}</small></span>
                <span class="t-sw"></span>
            </button>`;

        const bands = EQ_BANDS.map((band, i) => `
            <div class="band">
                <output data-band-out="${i}">0</output>
                <div class="vwrap">
                    <input type="range" class="range center" data-band="${i}"
                        min="-12" max="12" step="0.5" value="0"
                        aria-label="${band.label} Hz" title="Double-click to reset">
                </div>
                <span>${band.label}</span>
            </div>`).join('');

        const key = (combo, action) => `<kbd>${combo}</kbd><span>${action}</span>`;

        return `
            <div class="root with-tab" hidden>

                <button class="tab" data-ref="tab" aria-label="Media Toolbox"
                    title="Media Toolbox (Alt+A) · drag to move">
                    <span data-ref="tabIcon">${ICON.speaker}</span>
                    <span class="tab-badge" data-ref="badge"></span>
                </button>

                <section class="panel" data-ref="panel" role="dialog" aria-label="Media Toolbox">

                    <header class="head">
                        <div class="brand">
                            <span class="logo">${ICON.logo}</span>
                            <div class="brand-text">
                                <strong>Media Toolbox</strong>
                                <span class="status" data-ref="status">No media</span>
                            </div>
                        </div>
                        <div class="head-actions">
                            <button class="icon-btn" data-act="pin" data-ref="pin" title="Keep open">${ICON.pin}</button>
                            <button class="icon-btn" data-act="reset" title="Reset everything (Alt+0)">${ICON.reset}</button>
                            <button class="icon-btn" data-act="close" title="Close (Esc)">${ICON.close}</button>
                        </div>
                    </header>

                    <div class="viz-wrap">
                        <canvas class="viz" data-ref="viz"></canvas>
                        <div class="viz-note" data-ref="vizNote"></div>
                    </div>

                    <div class="transport">
                        <div class="seek-row">
                            <span data-ref="cur">0:00</span>
                            <input type="range" class="range seek" data-ref="seek"
                                min="0" max="1000" step="1" value="0" aria-label="Seek">
                            <span data-ref="dur">0:00</span>
                        </div>
                        <div class="tbar">
                            <button class="icon-btn" data-act="loop" data-ref="loop" title="Loop">${ICON.loop}</button>
                            <span class="spacer"></span>
                            <button class="icon-btn" data-act="back" data-ref="back" title="Back 10 s">${ICON.back}</button>
                            <button class="play-btn" data-act="play" data-ref="play" title="Play / pause">${ICON.play}</button>
                            <button class="icon-btn" data-act="forward" data-ref="forward" title="Forward 10 s">${ICON.forward}</button>
                            <span class="spacer"></span>
                            <button class="icon-btn" data-act="pip" data-ref="pip" title="Picture-in-picture">${ICON.pip}</button>
                        </div>
                    </div>

                    <nav class="tabs" role="tablist">
                        <button class="seg" data-tab="sound" role="tab">Sound</button>
                        <button class="seg" data-tab="eq" role="tab">EQ</button>
                        <button class="seg" data-tab="speed" role="tab">Playback</button>
                        <button class="seg" data-tab="settings" role="tab">Settings</button>
                        <span class="seg-ind" data-ref="segInd"></span>
                    </nav>

                    <div class="page" data-page="sound">
                        <div class="field">
                            <div class="field-head">
                                <label>Volume</label>
                                <output data-ref="volOut">100%</output>
                            </div>
                            <div class="slider-row">
                                <button class="icon-btn" data-act="mute" data-ref="mute" title="Mute (Alt+M)">${ICON.speaker}</button>
                                <input type="range" class="range" data-ref="vol"
                                    min="0" max="400" step="5" value="100"
                                    aria-label="Volume" title="Scroll to adjust · double-click to reset">
                            </div>
                            <div class="chips" style="--cols: ${VOLUME_PRESETS.length}">
                                ${VOLUME_PRESETS.map(v => chip('data-vol', v, v + '%')).join('')}
                            </div>
                        </div>

                        <div class="field">
                            <div class="field-head">
                                <label>Balance</label>
                                <output data-ref="balOut">Center</output>
                            </div>
                            <div class="slider-row">
                                <span class="mini">L</span>
                                <input type="range" class="range center" data-ref="bal"
                                    min="-100" max="100" step="5" value="0"
                                    aria-label="Balance" title="Double-click to center">
                                <span class="mini">R</span>
                            </div>
                        </div>

                        <div class="toggles compact">
                            ${toggle('voice', ICON.mic, 'Voice boost', 'Clearer dialogue &amp; speech (Alt+V)')}
                            ${toggle('noise', ICON.noise, 'Noise cut', 'Cut hum, rumble &amp; hiss (Alt+N)')}
                            ${toggle('compressor', ICON.gauge, 'Normalize', 'Tame loud peaks, lift quiet parts')}
                            ${toggle('mono', ICON.mono, 'Mono', 'Mix both channels together')}
                        </div>
                    </div>

                    <div class="page" data-page="eq" hidden>
                        <div class="chips" style="--cols: 3">
                            ${Object.keys(EQ_PRESETS).map(id => chip('data-preset', id, EQ_PRESETS[id].label)).join('')}
                        </div>
                        <div class="eq">${bands}</div>
                        <p class="hint">Drag or scroll a band · double-click to reset</p>
                    </div>

                    <div class="page" data-page="speed" hidden>
                        <div class="field">
                            <div class="field-head">
                                <label>Playback speed</label>
                                <output data-ref="spdOut">1×</output>
                            </div>
                            <div class="slider-row">
                                <button class="icon-btn" data-act="slower" title="Slower (Alt+,)">${ICON.minus}</button>
                                <input type="range" class="range" data-ref="spd"
                                    min="0.25" max="4" step="0.05" value="1"
                                    aria-label="Playback speed" title="Scroll to adjust · double-click to reset">
                                <button class="icon-btn" data-act="faster" title="Faster (Alt+.)">${ICON.plus}</button>
                            </div>
                            <div class="chips" style="--cols: 4">
                                ${SPEED_PRESETS.map(v => chip('data-speed', v, formatSpeed(v))).join('')}
                            </div>
                        </div>
                        <div class="field">
                            <div class="field-head">
                                <label>Seek step (seconds)</label>
                            </div>
                            <div class="steps">
                                <label class="step"><span>← / →</span>
                                    <input type="number" min="1" max="600" step="1" data-seek="seekArrow" data-ref="seekArrow"></label>
                                <label class="step"><span>Alt + ← / →</span>
                                    <input type="number" min="1" max="600" step="1" data-seek="seekAlt" data-ref="seekAlt"></label>
                                <label class="step"><span>Ctrl + ← / →</span>
                                    <input type="number" min="1" max="600" step="1" data-seek="seekCtrl" data-ref="seekCtrl"></label>
                            </div>
                        </div>
                        <div class="toggles">
                            ${toggle('preservePitch', ICON.pitch, 'Keep pitch', 'No chipmunk voices when sped up')}
                            ${toggle('thumbs', ICON.thumbs, 'Seek bar thumbnails', 'Preview frames on the video timeline (Alt+P)')}
                        </div>
                    </div>

                    <div class="warn" data-ref="warn" hidden></div>

                    <div class="page" data-page="settings" hidden>
                        <div class="field">
                            <div class="field-head">
                                <label>Remember settings</label>
                            </div>
                            <div class="foot-switches">
                                <label class="switch" title="On: settings are saved and used on every site. Off: nothing is saved unless this site is set to always on; settings last only for this tab.">
                                    <input type="checkbox" data-ref="shareAll">
                                    <span class="knob"></span>
                                    <span class="host-name">Use across <b>all sites</b></span>
                                </label>
                                <label class="switch" title="Save settings and load them automatically every time you visit this site (edit the list from the Tampermonkey menu)">
                                    <input type="checkbox" data-ref="siteAuto">
                                    <span class="knob"></span>
                                    <span class="host-name">Always on for <b>${escapeHTML(location.hostname || 'this page')}</b></span>
                                </label>
                            </div>
                        </div>

                        <div class="field">
                            <div class="field-head">
                                <label>Keyboard shortcuts</label>
                            </div>
                            <div class="keys">
                        ${key('Alt + A', 'Open / close toolbox')}
                        ${key('Alt + ↑ / ↓', 'Volume ±10%')}
                        ${key('Alt + M', 'Mute')}
                        ${key('Alt + . / ,', 'Speed ±0.25×')}
                        ${key('← / →', 'Back / forward <span data-ref="keySeekArrow"></span> s')}
                        ${key('Alt + ← / →', 'Back / forward <span data-ref="keySeekAlt"></span> s')}
                        ${key('Ctrl + ← / →', 'Back / forward <span data-ref="keySeekCtrl"></span> s')}
                        ${key('Alt + V', 'Voice boost')}
                        ${key('Alt + N', 'Noise reduction')}
                        ${key('Alt + P', 'Seek bar thumbnails')}
                        ${key('Alt + hover', 'Preview anywhere on a video')}
                        ${key('Alt + 0', 'Reset everything')}
                        ${key('Esc', 'Close panel')}
                            </div>
                        </div>
                    </div>
                </section>

                <div class="toast" data-ref="toast" role="status" aria-live="polite">
                    <div class="toast-text" data-ref="toastText"></div>
                    <div class="toast-bar" data-ref="toastTrack"><i data-ref="toastBar"></i></div>
                </div>
            </div>`;
    }

    // =========================================================
    // UI
    // =========================================================

    const refs = {};

    let host = null;
    let shadow = null;
    let root = null;

    let panelOpen = false;
    let hovering = false;
    let seeking = false;
    let collapseTimer = null;
    let renderQueued = false;
    let toastTimer = null;

    function createUI() {
        if (host) {
            return;
        }

        host = document.createElement('div');
        host.id = HOST_ID;
        host.style.cssText = [
            'all: initial', 'position: fixed', 'top: 0', 'left: 0',
            'width: 0', 'height: 0', 'display: block', 'z-index: 2147483647'
        ].map(rule => rule + ' !important').join(';');

        shadow = host.attachShadow({ mode: 'closed' });

        const style = document.createElement('style');
        style.textContent = CSS;
        shadow.appendChild(style);

        const wrapper = document.createElement('div');
        wrapper.innerHTML = toHTML(buildTemplate());
        root = wrapper.firstElementChild;
        shadow.appendChild(root);

        shadow.querySelectorAll('[data-ref]').forEach(el => {
            refs[el.dataset.ref] = el;
        });

        setupEvents();
        applyLayout();
        mountHost();
        render();
    }

    // In fullscreen only the fullscreen element is painted, so move inside it.
    function mountHost() {
        if (!host) {
            return;
        }

        const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
        const parent = fullscreen && !(fullscreen instanceof HTMLMediaElement)
            ? fullscreen
            : document.documentElement;

        if (host.parentNode !== parent) {
            parent.appendChild(host);
        }
    }

    function setIcon(el, name) {
        if (el && el.dataset.icon !== name) {
            el.dataset.icon = name;
            el.innerHTML = toHTML(ICON[name]);
        }
    }

    function setFill(input) {
        const min = Number(input.min);
        const max = Number(input.max);
        const pos = (Number(input.value) - min) / (max - min) * 100;

        if (input.classList.contains('center')) {
            const mid = (0 - min) / (max - min) * 100;
            input.style.setProperty('--lo', Math.min(pos, mid) + '%');
            input.style.setProperty('--hi', Math.max(pos, mid) + '%');
        } else {
            input.style.setProperty('--p', pos + '%');
        }
    }

    function setValue(input, value) {
        // Never fight the user's thumb while they drag.
        if (shadow.activeElement !== input || !input.matches(':active')) {
            input.value = value;
        }
        setFill(input);
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) {
            return '0:00';
        }

        const s = Math.floor(seconds % 60);
        const m = Math.floor(seconds / 60) % 60;
        const h = Math.floor(seconds / 3600);
        const pad = n => String(n).padStart(2, '0');

        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    function scheduleRender() {
        if (renderQueued || !root) {
            return;
        }

        renderQueued = true;
        requestAnimationFrame(render);
    }

    function render() {
        renderQueued = false;

        if (!root) {
            return;
        }

        const list = getMediaList();
        const active = getActiveMedia();

        root.hidden = list.length === 0;

        if (root.hidden && panelOpen) {
            setPanel(false);
        }

        root.classList.toggle('fx', needsGraph() || settings.speed !== 1);

        // Edge tab
        setIcon(refs.tabIcon, settings.muted ? 'muted' : 'speaker');
        refs.badge.textContent = settings.muted ? 'MUTE'
            : settings.volume !== 1 ? Math.round(settings.volume * 100) + '%'
            : settings.speed !== 1 ? formatSpeed(settings.speed)
            : '';

        // Status line
        if (!active) {
            refs.status.textContent = 'No media found';
            refs.status.classList.remove('live');
        } else {
            const playing = !active.paused && !active.ended;
            const kind = active instanceof HTMLVideoElement ? 'Video' : 'Audio';
            const extra = list.length > 1 ? ` · ${list.length} sources` : '';
            refs.status.textContent = `${kind} · ${playing ? 'Playing' : 'Paused'}${extra}`;
            refs.status.classList.toggle('live', playing);
        }

        refs.pin.classList.toggle('on', settings.pinned);
        refs.pin.title = settings.pinned ? 'Unpin (auto-hide)' : 'Keep open';
        // Volume
        const volume = Math.round(settings.volume * 100);
        setValue(refs.vol, volume);
        refs.volOut.textContent = settings.muted ? 'Muted' : volume + '%';
        refs.volOut.classList.toggle('boost', volume > 100 && !settings.muted);
        setIcon(refs.mute, settings.muted ? 'muted' : volume <= 50 ? 'speakerLow' : 'speaker');
        refs.mute.classList.toggle('on', settings.muted);

        shadow.querySelectorAll('[data-vol]').forEach(chip => {
            chip.classList.toggle('on', !settings.muted && Number(chip.dataset.vol) === volume);
        });

        // Balance
        const balance = Math.round(settings.balance * 100);
        setValue(refs.bal, balance);
        refs.balOut.textContent = balance === 0 ? 'Center' : `${balance < 0 ? 'L' : 'R'} ${Math.abs(balance)}%`;

        // Toggles
        shadow.querySelectorAll('[data-toggle]').forEach(button => {
            const on = !!settings[button.dataset.toggle];
            button.classList.toggle('on', on);
            button.setAttribute('aria-pressed', String(on));
        });

        // Equalizer
        settings.eq.forEach((gain, i) => {
            setValue(shadow.querySelector(`[data-band="${i}"]`), gain);
            const out = shadow.querySelector(`[data-band-out="${i}"]`);
            out.textContent = (gain > 0 ? '+' : '') + gain;
            out.classList.toggle('set', gain !== 0);
        });

        shadow.querySelectorAll('[data-preset]').forEach(chip => {
            const gains = EQ_PRESETS[chip.dataset.preset].gains;
            chip.classList.toggle('on', gains.every((g, i) => g === settings.eq[i]));
        });

        // Speed
        setValue(refs.spd, settings.speed);
        refs.spdOut.textContent = formatSpeed(settings.speed);
        shadow.querySelectorAll('[data-speed]').forEach(chip => {
            chip.classList.toggle('on', Math.abs(Number(chip.dataset.speed) - settings.speed) < 0.001);
        });

        // Seek steps
        SEEK_KEYS.forEach(key => {
            if (shadow.activeElement !== refs[key]) {
                refs[key].value = settings[key];
            }
            refs['key' + key[0].toUpperCase() + key.slice(1)].textContent = settings[key];
        });
        refs.back.title = `Back ${settings.seekArrow} s (←)`;
        refs.forward.title = `Forward ${settings.seekArrow} s (→)`;

        // Tabs
        const tabs = ['sound', 'eq', 'speed', 'settings'];
        const tabIndex = Math.max(0, tabs.indexOf(settings.tab));
        shadow.querySelectorAll('[data-tab]').forEach(button => {
            const on = button.dataset.tab === tabs[tabIndex];
            button.classList.toggle('on', on);
            button.setAttribute('aria-selected', String(on));
        });
        shadow.querySelectorAll('[data-page]').forEach(page => {
            page.hidden = page.dataset.page !== tabs[tabIndex];
        });
        refs.segInd.style.transform = `translateX(${tabIndex * 100}%)`;

        // Footer
        refs.shareAll.checked = settings.shareAll;
        refs.siteAuto.checked = settings.siteAuto;

        // Warning when effects cannot reach the active media
        const state = active && mediaStates.get(active);
        const blocked = !!(state && state.blocked);
        refs.warn.hidden = !blocked;
        if (blocked) {
            refs.warn.textContent = state.failed
                ? 'This player already routes its own audio, so sound effects can’t be applied. Speed and transport still work.'
                : 'This media comes from another site without CORS access, so sound effects are disabled to avoid silencing it. Speed and transport still work.';
        }

        renderTransport();

        if (panelOpen) {
            startViz();
        }
    }

    function renderTransport() {
        if (!root) {
            return;
        }

        const media = getActiveMedia();

        ['play', 'back', 'forward', 'loop'].forEach(name => {
            refs[name].disabled = !media;
        });

        if (!media) {
            refs.cur.textContent = '0:00';
            refs.dur.textContent = '0:00';
            refs.seek.disabled = true;
            setValue(refs.seek, 0);
            refs.pip.hidden = true;
            return;
        }

        const duration = media.duration;
        const live = duration === Infinity;
        const playing = !media.paused && !media.ended;

        setIcon(refs.play, playing ? 'pause' : 'play');
        refs.play.title = playing ? 'Pause' : 'Play';

        refs.seek.disabled = live || !duration;

        if (!seeking) {
            setValue(refs.seek, live ? 1000 : duration ? (media.currentTime / duration) * 1000 : 0);
        }

        refs.cur.textContent = formatTime(media.currentTime);
        refs.dur.textContent = live ? 'LIVE' : formatTime(duration);

        refs.loop.classList.toggle('on', media.loop);

        refs.pip.hidden = !(media instanceof HTMLVideoElement && document.pictureInPictureEnabled);
        refs.pip.classList.toggle('on', !!document.pictureInPictureElement && document.pictureInPictureElement === media);
    }

    function applyLayout() {
        if (!root) {
            return;
        }

        root.classList.toggle('right', settings.side === 'right');
        root.style.setProperty('--offset', settings.offset + '%');

        if (panelOpen) {
            positionPanel();
        }
    }

    function positionPanel() {
        const viewport = window.innerHeight;
        const height = refs.panel.offsetHeight;
        const center = (settings.offset / 100) * viewport;
        const top = clamp(center - height / 2, 8, Math.max(8, viewport - height - 8));

        refs.panel.style.top = top + 'px';
    }

    function setPanel(open) {
        if (!root || panelOpen === open) {
            return;
        }

        panelOpen = open;
        root.classList.toggle('open', open);

        if (open) {
            // Opening is a user gesture: good moment to attach the analyser.
            const media = getActiveMedia();
            if (media && hasUserActivation()) {
                hookMedia(media);
                resumeAudio();
            }

            render();
            positionPanel();
            cancelAutoCollapse();

            if (!hovering) {
                // Opened by keyboard/menu: give more time to reach it.
                scheduleAutoCollapse(AUTO_COLLAPSE_DELAY * 2.5);
            }
        } else {
            cancelAutoCollapse();
            stopViz();
        }
    }

    function cancelAutoCollapse() {
        clearTimeout(collapseTimer);
        collapseTimer = null;
    }

    function scheduleAutoCollapse(delay = AUTO_COLLAPSE_DELAY) {
        cancelAutoCollapse();

        if (!panelOpen || settings.pinned) {
            return;
        }

        collapseTimer = setTimeout(() => {
            // Stay open while dragging a slider or navigating by keyboard.
            const focused = shadow.activeElement &&
                shadow.activeElement.matches('input:active, :focus-visible');

            if (hovering || focused || settings.pinned) {
                scheduleAutoCollapse(delay);
            } else {
                setPanel(false);
            }
        }, delay);
    }

    function showToast(iconName, text, fraction) {
        if (!root || root.hidden) {
            return;
        }

        refs.toastText.innerHTML = toHTML(`${ICON[iconName] || ''}<span>${escapeHTML(text)}</span>`);
        refs.toastTrack.hidden = fraction == null;

        if (fraction != null) {
            refs.toastBar.style.width = clamp(fraction, 0, 1) * 100 + '%';
        }

        refs.toast.classList.add('show');

        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 1200);
    }

    // =========================================================
    // VISUALIZER
    // =========================================================

    const VIZ_BARS = 40;

    let vizFrame = 0;
    let vizData = null;
    let vizNote = null;
    const vizPeaks = new Array(VIZ_BARS).fill(0);
    const vizLevels = new Array(VIZ_BARS).fill(0);

    function startViz() {
        if (!vizFrame && panelOpen) {
            vizFrame = requestAnimationFrame(drawViz);
        }
    }

    function stopViz() {
        cancelAnimationFrame(vizFrame);
        vizFrame = 0;
    }

    function setVizNote(text) {
        if (vizNote !== text) {
            vizNote = text;
            refs.vizNote.textContent = text;
        }
    }

    function drawViz() {
        vizFrame = 0;

        if (!panelOpen) {
            return;
        }

        const canvas = refs.viz;
        const dpr = window.devicePixelRatio || 1;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;

        if (!width || !height) {
            return;
        }

        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }

        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, width, height);

        const media = getActiveMedia();
        const state = media && mediaStates.get(media);
        const analyser = state && !state.blocked ? state.analyser : null;
        const live = !!(analyser && media && !media.paused);

        if (!media) {
            setVizNote('No media on this page');
        } else if (state && state.blocked) {
            setVizNote('Spectrum unavailable for this media');
        } else if (!analyser) {
            setVizNote('Press play to see the spectrum');
        } else {
            setVizNote('');
        }

        if (live) {
            if (!vizData || vizData.length !== analyser.frequencyBinCount) {
                vizData = new Uint8Array(analyser.frequencyBinCount);
            }

            analyser.getByteFrequencyData(vizData);

            // Log-spaced buckets so bass doesn't hog the display.
            const bins = vizData.length * 0.85;
            for (let i = 0; i < VIZ_BARS; i++) {
                const lo = Math.floor(Math.pow(bins, i / VIZ_BARS));
                const hi = Math.max(lo + 1, Math.floor(Math.pow(bins, (i + 1) / VIZ_BARS)));
                let peak = 0;
                for (let b = lo; b < hi; b++) {
                    peak = Math.max(peak, vizData[b] || 0);
                }
                vizLevels[i] = peak / 255;
            }
        } else {
            for (let i = 0; i < VIZ_BARS; i++) {
                vizLevels[i] *= 0.85;
            }
        }

        const gap = 2;
        const barWidth = (width - 12 - gap * (VIZ_BARS - 1)) / VIZ_BARS;
        const usable = height - 12;

        const gradient = g.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, '#5b8cff');
        gradient.addColorStop(1, '#c084fc');

        let active = live;

        for (let i = 0; i < VIZ_BARS; i++) {
            const level = vizLevels[i];
            const x = 6 + i * (barWidth + gap);
            const barHeight = Math.max(2, level * usable);
            const y = height - 6 - barHeight;

            vizPeaks[i] = Math.max(level, vizPeaks[i] - 0.012);

            if (vizPeaks[i] > 0.01 || level > 0.01) {
                active = true;
            }

            g.globalAlpha = level > 0.01 ? 0.95 : 0.25;
            g.fillStyle = gradient;

            if (g.roundRect) {
                g.beginPath();
                g.roundRect(x, y, barWidth, barHeight, Math.min(2, barWidth / 2));
                g.fill();
            } else {
                g.fillRect(x, y, barWidth, barHeight);
            }

            if (vizPeaks[i] > 0.02) {
                g.globalAlpha = 0.7;
                g.fillStyle = '#ffffff';
                g.fillRect(x, height - 6 - vizPeaks[i] * usable - 3, barWidth, 1.5);
            }
        }

        g.globalAlpha = 1;

        // Keep animating only while there is something moving.
        if (active && !document.hidden) {
            vizFrame = requestAnimationFrame(drawViz);
        }
    }

    // =========================================================
    // ACTIONS
    // =========================================================

    const round2 = value => Math.round(value * 100) / 100;

    function setVolume(volume, toast) {
        settings.volume = clamp(round2(volume), 0, 4);
        settings.muted = false;
        syncAll();

        if (toast) {
            const pct = Math.round(settings.volume * 100);
            showToast(pct === 0 ? 'muted' : pct <= 50 ? 'speakerLow' : 'speaker', `Volume ${pct}%`, settings.volume / 4);
        }
    }

    function toggleMute(toast) {
        settings.muted = !settings.muted;
        syncAll();

        if (toast) {
            showToast(settings.muted ? 'muted' : 'speaker', settings.muted ? 'Muted' : `Volume ${Math.round(settings.volume * 100)}%`);
        }
    }

    function setSpeed(speed, toast) {
        settings.speed = clamp(round2(speed), 0.25, 4);
        syncAll();

        if (toast) {
            showToast('forward', `Speed ${formatSpeed(settings.speed)}`, (settings.speed - 0.25) / 3.75);
        }
    }

    // Jump the active media by `delta` seconds, staying inside its seekable range.
    function seekBy(delta, toast) {
        const media = getActiveMedia();

        if (!media) {
            return;
        }

        const seekable = media.seekable;
        const start = seekable && seekable.length ? seekable.start(0) : 0;
        const end = seekable && seekable.length ? seekable.end(seekable.length - 1) : media.duration;

        if (!isFinite(end)) {
            return;
        }

        media.currentTime = clamp(media.currentTime + delta, start, end);
        renderTransport();

        if (toast) {
            const fraction = isFinite(media.duration) && media.duration > 0 ? media.currentTime / media.duration : null;
            showToast(delta < 0 ? 'back' : 'forward', `${delta < 0 ? '−' : '+'}${Math.abs(delta)} s · ${formatTime(media.currentTime)}`, fraction);
        }
    }

    function setBalance(balance) {
        settings.balance = clamp(round2(balance), -1, 1);
        syncAll();
    }

    function setBand(index, gain) {
        settings.eq[index] = clamp(gain, -12, 12);
        syncAll();
    }

    function applyPreset(id) {
        settings.eq = EQ_PRESETS[id].gains.slice();
        syncAll();
    }

    const TOGGLE_LABELS = {
        voice: ['mic', 'Voice boost'],
        noise: ['noise', 'Noise reduction'],
        compressor: ['gauge', 'Normalize'],
        mono: ['mono', 'Mono'],
        preservePitch: ['pitch', 'Keep pitch'],
        thumbs: ['thumbs', 'Seek bar thumbnails']
    };

    function toggleSetting(key, toast) {
        settings[key] = !settings[key];
        syncAll();

        if (key === 'thumbs' && !settings.thumbs) {
            trackThumbs.hide();
        }

        if (toast) {
            const [icon, label] = TOGGLE_LABELS[key];
            showToast(icon, `${label} ${settings[key] ? 'on' : 'off'}`);
        }
    }

    function resetAll(toast) {
        Object.assign(settings, pick(DEFAULTS, AUDIO_KEYS), { eq: DEFAULTS.eq.slice(), muted: false });
        syncAll();

        if (toast) {
            showToast('reset', 'All settings reset');
        }
    }

    function handleAction(action) {
        const media = getActiveMedia();

        switch (action) {
            case 'pin':
                settings.pinned = !settings.pinned;
                saveSettings();
                render();
                if (settings.pinned) {
                    cancelAutoCollapse();
                } else if (!hovering) {
                    scheduleAutoCollapse();
                }
                break;

            case 'reset':
                resetAll(false);
                break;

            case 'close':
                setPanel(false);
                break;

            case 'mute':
                toggleMute(false);
                break;

            case 'slower':
                setSpeed(settings.speed - 0.25);
                break;

            case 'faster':
                setSpeed(settings.speed + 0.25);
                break;

            case 'play':
                if (media) {
                    if (media.paused || media.ended) {
                        media.play().catch(() => {});
                    } else {
                        media.pause();
                    }
                }
                break;

            case 'back':
            case 'forward':
                seekBy(action === 'back' ? -settings.seekArrow : settings.seekArrow);
                break;

            case 'loop':
                if (media) {
                    media.loop = !media.loop;
                    renderTransport();
                }
                break;

            case 'pip':
                if (document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(() => {});
                } else if (media && media.requestPictureInPicture) {
                    media.disablePictureInPicture = false;
                    media.requestPictureInPicture().catch(() => {});
                }
                break;
        }
    }

    // =========================================================
    // EVENTS
    // =========================================================

    // Active media is visible (or fullscreen); off-screen audio counts only while playing.
    function mediaInView() {
        const media = getActiveMedia();

        if (!media) {
            return false;
        }

        if (document.fullscreenElement || document.webkitFullscreenElement) {
            return true;
        }

        const rect = media.getBoundingClientRect();

        if (rect.width && rect.height) {
            return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
        }

        return !media.paused;
    }

    function isEditable(el) {
        return !!el && (el.isContentEditable ||
            (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'range'));
    }

    function setupEvents() {
        const tab = refs.tab;

        // Hover keeps the panel open; leaving starts the auto-collapse timer.
        [tab, refs.panel].forEach(el => {
            el.addEventListener('pointerenter', () => {
                hovering = true;
                cancelAutoCollapse();
            });
            el.addEventListener('pointerleave', () => {
                hovering = false;
                scheduleAutoCollapse();
            });
        });

        // Edge tab: click toggles, drag moves it anywhere along either edge.
        let drag = null;

        tab.addEventListener('pointerdown', event => {
            if (event.button !== 0) {
                return;
            }
            drag = { x: event.clientX, y: event.clientY, moved: false };
            tab.setPointerCapture(event.pointerId);
        });

        tab.addEventListener('pointermove', event => {
            if (!drag) {
                return;
            }
            if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) {
                return;
            }
            drag.moved = true;
            tab.classList.add('dragging');
            settings.offset = clamp((event.clientY / window.innerHeight) * 100, 5, 95);
            settings.side = event.clientX > window.innerWidth / 2 ? 'right' : 'left';
            applyLayout();
        });

        tab.addEventListener('pointerup', () => {
            if (!drag) {
                return;
            }
            const moved = drag.moved;
            drag = null;
            tab.classList.remove('dragging');

            if (moved) {
                saveSettings();
            } else {
                setPanel(!panelOpen);
            }
        });

        tab.addEventListener('pointercancel', () => {
            drag = null;
            tab.classList.remove('dragging');
        });

        // Keyboard activation of the tab (Enter / Space).
        tab.addEventListener('click', event => {
            if (event.detail === 0) {
                setPanel(!panelOpen);
            }
        });

        // Buttons (delegated)
        shadow.addEventListener('click', event => {
            const button = event.target.closest('button');

            if (!button || button === tab) {
                return;
            }

            const data = button.dataset;

            if (data.act) {
                handleAction(data.act);
            } else if (data.vol) {
                setVolume(Number(data.vol) / 100);
            } else if (data.speed) {
                setSpeed(Number(data.speed));
            } else if (data.preset) {
                applyPreset(data.preset);
            } else if (data.toggle) {
                toggleSetting(data.toggle);
            } else if (data.tab) {
                settings.tab = data.tab;
                saveSettings();
                render();
                positionPanel();
            }
        });

        // Sliders
        shadow.addEventListener('input', event => {
            const input = event.target;

            if (input === refs.vol) {
                setVolume(Number(input.value) / 100);
            } else if (input === refs.bal) {
                setBalance(Number(input.value) / 100);
            } else if (input === refs.spd) {
                setSpeed(Number(input.value));
            } else if (input.dataset.band != null) {
                setBand(Number(input.dataset.band), Number(input.value));
            } else if (input === refs.seek) {
                seeking = true;
                const media = getActiveMedia();
                if (media && isFinite(media.duration)) {
                    refs.cur.textContent = formatTime((input.value / 1000) * media.duration);
                }
                setFill(input);
            }
        });

        shadow.addEventListener('change', event => {
            const input = event.target;

            if (input === refs.seek) {
                const media = getActiveMedia();
                if (media && isFinite(media.duration)) {
                    media.currentTime = (input.value / 1000) * media.duration;
                }
                seeking = false;
                renderTransport();
            } else if (input === refs.shareAll) {
                setShareAll(input.checked);
                showToast('pin', input.checked ? 'Settings saved for all sites' : 'Settings only for this tab');
            } else if (input === refs.siteAuto) {
                setSiteAuto(input.checked);
                showToast('pin', input.checked ? `Always on for ${location.hostname}` : `${location.hostname} removed`);
            } else if (input.dataset.seek) {
                const key = input.dataset.seek;
                settings[key] = clamp(Math.round(Number(input.value)) || DEFAULTS[key], 1, 600);
                saveSettings();
                render();
            }
        });

        // Keys typed into the step fields belong to the toolbox, not the page's shortcuts.
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            shadow.addEventListener(type, event => {
                if (event.target.matches && event.target.matches('input[type="number"]')) {
                    event.stopPropagation();
                }
            });
        });

        // Double-click a slider to reset it.
        shadow.addEventListener('dblclick', event => {
            const input = event.target.closest('input[type="range"]');

            if (input === refs.vol) {
                setVolume(1);
            } else if (input === refs.bal) {
                setBalance(0);
            } else if (input === refs.spd) {
                setSpeed(1);
            } else if (input && input.dataset.band != null) {
                setBand(Number(input.dataset.band), 0);
            }
        });

        // Scroll wheel: fine-tune sliders; over the tab it changes volume.
        shadow.addEventListener('wheel', event => {
            const up = event.deltaY < 0;

            if (event.target.closest('.tab')) {
                event.preventDefault();
                setVolume(settings.volume + (up ? 0.05 : -0.05), true);
                return;
            }

            const input = event.target.closest('input[type="range"]');

            if (!input || input === refs.seek) {
                return;
            }

            event.preventDefault();

            const step = Number(input.step) || 1;
            const next = clamp(Number(input.value) + (up ? step : -step), Number(input.min), Number(input.max));

            input.value = next;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, { passive: false });
    }

    function installGlobalListeners() {
        // Click outside closes the panel (unless pinned).
        document.addEventListener('pointerdown', event => {
            if (panelOpen && !settings.pinned && !event.composedPath().includes(host)) {
                setPanel(false);
            }
        }, true);

        document.addEventListener('keydown', event => {
            if (!root || root.hidden) {
                return;
            }

            if (event.key === 'Escape' && panelOpen) {
                setPanel(false);
                return;
            }

            // Seek: ←/→, Alt+←/→ and Ctrl+←/→ each jump by their own step (Playback tab).
            // Skipped while typing or using a slider/field, and inside the toolbox itself.
            // Plain arrows only seek while the media is on screen, so they still scroll
            // pages whose video is out of view.
            const arrow = event.code === 'ArrowLeft' ? -1 : event.code === 'ArrowRight' ? 1 : 0;
            if (arrow && !event.shiftKey && !event.metaKey && !(event.ctrlKey && event.altKey)) {
                const path = event.composedPath();
                const target = path[0];
                const busy = isEditable(target) || (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName));

                if (!busy && !path.includes(host) && (event.altKey || event.ctrlKey || mediaInView())) {
                    const step = event.ctrlKey ? settings.seekCtrl : event.altKey ? settings.seekAlt : settings.seekArrow;
                    seekBy(arrow * step, true);
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
            }

            if (!event.altKey || event.ctrlKey || event.metaKey || isEditable(event.composedPath()[0])) {
                return;
            }

            let handled = true;

            switch (event.code) {
                case 'KeyA': setPanel(!panelOpen); break;
                case 'ArrowUp': setVolume(settings.volume + 0.1, true); break;
                case 'ArrowDown': setVolume(settings.volume - 0.1, true); break;
                case 'KeyM': toggleMute(true); break;
                case 'Period': setSpeed(settings.speed + 0.25, true); break;
                case 'Comma': setSpeed(settings.speed - 0.25, true); break;
                case 'KeyV': toggleSetting('voice', true); break;
                case 'KeyN': toggleSetting('noise', true); break;
                case 'KeyP': toggleSetting('thumbs', true); break;
                case 'Digit0':
                case 'Numpad0': resetAll(true); break;
                default: handled = false;
            }

            if (handled) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);

        const onFullscreen = () => {
            mountHost();
            if (panelOpen) {
                positionPanel();
            }
        };

        document.addEventListener('fullscreenchange', onFullscreen);
        document.addEventListener('webkitfullscreenchange', onFullscreen);

        document.addEventListener('enterpictureinpicture', renderTransport, true);
        document.addEventListener('leavepictureinpicture', renderTransport, true);

        window.addEventListener('resize', () => {
            if (panelOpen) {
                positionPanel();
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                startViz();
            }
        });
    }

    // =========================================================
    // MEDIA DETECTION
    // =========================================================

    function scanMedia() {
        document.querySelectorAll('video, audio').forEach(trackMedia);
        scheduleRender();
    }

    function startObserver() {
        const observer = new MutationObserver(mutations => {
            let removed = false;

            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE || node === host) {
                        continue;
                    }

                    if (node instanceof HTMLMediaElement) {
                        trackMedia(node);
                    } else if (node.firstElementChild) {
                        node.querySelectorAll('video, audio').forEach(trackMedia);
                    }
                }

                if (mutation.removedNodes.length) {
                    removed = true;
                }
            }

            if (host && !host.isConnected) {
                mountHost();
            }

            if (removed && [...tracked].some(media => !media.isConnected)) {
                scheduleRender();
            }

            if (tracked.size && root && root.hidden) {
                scheduleRender();
            }
        });

        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    // =========================================================
    // SEEK BAR THUMBNAILS
    // =========================================================
    //
    // Hovering a video's seek bar shows a preview frame and the time there
    // (off by default; toggle in the Sound tab or with Alt+P). Frames come from:
    //  1. Live capture: whenever the real video reaches a new time bucket, its
    //     current frame is copied into a small canvas. Works for any source but DRM.
    //  2. Seeker: a hidden muted copy of the stream is seeked to the hovered time
    //     on demand, so unwatched parts get previews too. The stream is the video's
    //     own http src, or — for players that feed a blob: MediaSource URL — an
    //     .m3u8 playlist / video file sniffed from the page's network activity and
    //     played through hls.js.
    // Canvases are only displayed, never read back, so cross-origin video without
    // CORS still works (a tainted canvas can be drawn on screen).

    const trackThumbs = (() => {
        const THUMB_W = 160;
        const THUMB_H = 120;                // fixed 4:3 box on screen; frames are letterboxed into it
        const STORE_W = 128;
        const STORE_H = 96;                 // stored at lower resolution: cheaper to grab and keep
        const MAX_FRAMES = 120;             // thumbnails per video; fewer means fewer seeks to fill
        const MIN_INTERVAL = 1;             // seconds between thumbnail buckets, at minimum
        const LIVE_INTERVAL = 10;           // bucket size when duration is unknown (live / DVR)
        const SEEK_TIMEOUT = 10000;
        const OPEN_TIMEOUT = 12000;         // seeker must load metadata within this time
        const MAX_SEEK_FAILURES = 3;
        const MAX_SOURCE_ATTEMPTS = 6;      // candidate stream URLs tried per video
        const SNIFF_LIMIT = 40;             // remembered stream URLs per kind
        const TRACK_MAX_HEIGHT = 64;        // px; taller elements are not seek bars
        const TRACK_MIN_WIDTH_RATIO = 0.35; // seek bar must span this much of the video width
        const TRACK_HOVER_SLOP = 12;        // px of vertical tolerance once a track is locked
        const PATH_DEPTH = 12;              // ancestors inspected under the pointer
        const NATIVE_BAR_HEIGHT = 56;       // px band at the bottom of native controls
        const NATIVE_BAR_INSET = 12;
        const FRAME_WAIT = 150;             // ms to wait for a decoded frame after a seek
        const BLANK_RETRIES = 2;            // re-grab an all-black frame this many times
        const FILL_PACE_PLAYING = 1500;     // ms between background grabs while the video plays
        const TIP_GAP = 38;                 // px between seek bar and preview; leaves room for the player's own time bubble

        const TRACK_RE = /(progress|seek|scrub|timeline|time-?rail|time-?bar|slider|rail|track)/i;
        const LABEL_RE = /(seek|progress|timeline|scrub)/i;
        const HLS_RE = /\.m3u8(?:[?#]|$)/i;
        const FILE_RE = /\.(?:mp4|m4v|webm|mov|ogv|mkv)(?:[?#]|$)/i;
        const PARTIAL_RE = /[?&](?:range|bytes|byterange)=/i; // byte-range chunks, not whole files

        const TIP_CSS = `
            .vt-tip {
                position: fixed; left: 0; top: 0;
                display: flex; flex-direction: column; align-items: center; gap: 5px;
                pointer-events: none; will-change: transform;
            }
            .vt-frame {
                width: ${THUMB_W + 4}px; height: ${THUMB_H + 4}px;
                border-radius: 8px; overflow: hidden; background: #000;
                border: 2px solid rgba(255, 255, 255, .9);
                box-shadow: 0 6px 22px rgba(0, 0, 0, .55);
                line-height: 0;
            }
            .vt-frame canvas { display: block; width: ${THUMB_W}px; height: ${THUMB_H}px; }
            .vt-frame.approx canvas { filter: blur(1.5px) brightness(.75); }
            .vt-frame.loading { animation: vt-pulse 1s ease-in-out infinite alternate; }
            @keyframes vt-pulse { from { opacity: .55; } to { opacity: .9; } }
            /* Time sits above the thumbnail, away from the player's own time label near the bar */
            .vt-time {
                order: -1;
                font: 600 12px/1 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                color: #fff; background: rgba(0, 0, 0, .78);
                padding: 4px 7px; border-radius: 5px;
                text-shadow: 0 1px 1px rgba(0, 0, 0, .6);
                font-variant-numeric: tabular-nums;
                white-space: nowrap;
            }
        `;

        function isVideo(node) {
            return !!node && node.tagName === 'VIDEO';
        }

        // Seekable time range of a video, or null if it has no usable timeline.
        function getRange(video) {
            const duration = video.duration;
            if (isFinite(duration) && duration > 0) {
                return { start: 0, end: duration };
            }

            const seekable = video.seekable;
            if (seekable && seekable.length) {
                const start = seekable.start(0);
                const end = seekable.end(seekable.length - 1);
                if (end > start) {
                    return { start, end };
                }
            }
            return null;
        }

        // A candidate stream is only trusted if it is as long as the page video.
        function durationMatches(expected, actual) {
            if (!isFinite(expected) || expected <= 0) {
                return true; // live: nothing to compare
            }
            if (!isFinite(actual) || actual <= 0) {
                return false;
            }
            return Math.abs(expected - actual) <= Math.max(3, expected * 0.02);
        }

        // hls.js ships as a cached @resource and is only evaluated the first time an
        // HLS seeker is needed, so ordinary pages never pay for parsing it.
        let hlsLib;

        function getHls() {
            if (hlsLib !== undefined) {
                return hlsLib;
            }
            hlsLib = null;

            try {
                const code = typeof GM_getResourceText === 'function' ? GM_getResourceText('hlsjs') : '';
                if (code) {
                    // CommonJS shims make the UMD bundle hand back its export instead of touching globals.
                    const module = { exports: {} };
                    new Function('module', 'exports', code)(module, module.exports);
                    hlsLib = module.exports.default || module.exports;
                }
            } catch (error) {
                console.warn('[Media Toolbox] Could not load hls.js (HLS thumbnails disabled here):', error);
            }

            if (typeof hlsLib !== 'function') {
                hlsLib = typeof window.Hls === 'function' ? window.Hls : null;
            }
            return hlsLib;
        }

        // ------------------------------------------------ stream sniffer
        //
        // Resource timing lists every URL the page fetched (XHR and fetch included),
        // so the real playlist behind a blob: player shows up here.

        const sniffed = { hls: [], file: [] };
        let sniffVersion = 0;

        function noteResource(url) {
            if (typeof url !== 'string' || !/^https?:/i.test(url)) {
                return;
            }

            let kind = null;
            if (HLS_RE.test(url)) {
                kind = 'hls';
            } else if (FILE_RE.test(url) && !PARTIAL_RE.test(url)) {
                kind = 'file';
            }
            if (!kind || sniffed[kind].includes(url)) {
                return;
            }

            sniffed[kind].push(url);
            if (sniffed[kind].length > SNIFF_LIMIT) {
                sniffed[kind].shift();
            }
            sniffVersion++;
        }

        try {
            new PerformanceObserver(list => {
                list.getEntries().forEach(entry => noteResource(entry.name));
            }).observe({ type: 'resource', buffered: true });
        } catch (error) {
            try {
                performance.getEntriesByType('resource').forEach(entry => noteResource(entry.name));
            } catch (e) { /* ignore */ }
        }

        // ------------------------------------------------ seekers

        let parkRoot = null;

        // Hidden home for seeker videos; a closed shadow root keeps them invisible
        // to page scripts (and to this toolbox's own media tracking). Kept on screen
        // at near-zero opacity: browsers skip decoding frames of videos they
        // consider invisible, which yields black thumbnails.
        function park(video) {
            if (!parkRoot) {
                const parkHost = document.createElement('div');
                parkHost.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:.01;pointer-events:none;z-index:-2147483647;';
                parkRoot = parkHost.attachShadow({ mode: 'closed' });
                document.documentElement.appendChild(parkHost);
            }
            parkRoot.appendChild(video);
        }

        // Opens a hidden, muted video on a stream URL. Returns a handle the caller owns.
        function openSeeker(source, onFail) {
            const el = document.createElement('video');
            el.muted = true;
            el.playsInline = true;
            el.preload = 'metadata';

            const handle = { el, ready: false, hls: null };
            const HlsLib = getHls();
            const nativeHls = !!el.canPlayType('application/vnd.apple.mpegurl');

            el.addEventListener('error', () => onFail(false));

            if (source.kind === 'hls' && !nativeHls) {
                if (!HlsLib || !HlsLib.isSupported()) {
                    setTimeout(() => onFail(false), 0);
                    return handle;
                }

                const hls = new HlsLib({
                    enableWorker: false,        // blob workers are blocked by many CSPs
                    startLevel: 0,
                    capLevelToPlayerSize: false,
                    maxBufferLength: 4,         // only fetch around the hovered spot
                    maxMaxBufferLength: 8,
                    backBufferLength: 0,
                    xhrSetup: xhr => { xhr.withCredentials = !!source.creds; }
                });
                hls.on(HlsLib.Events.MANIFEST_PARSED, () => { hls.autoLevelCapping = 0; }); // lowest quality is plenty
                hls.on(HlsLib.Events.ERROR, (_, data) => {
                    if (data && data.fatal) {
                        onFail(data.type === HlsLib.ErrorTypes.NETWORK_ERROR);
                    }
                });
                hls.loadSource(source.url);
                hls.attachMedia(el);
                handle.hls = hls;
            } else {
                el.src = source.url;
            }

            park(el);
            return handle;
        }

        function closeSeeker(handle) {
            if (!handle) {
                return;
            }
            try {
                if (handle.hls) {
                    handle.hls.destroy();
                }
            } catch (error) { /* ignore */ }
            handle.el.removeAttribute('src');
            try { handle.el.load(); } catch (error) { /* ignore */ }
            handle.el.remove();
        }

        // ------------------------------------------------ frame cache (one per page video)

        // True when the drawn area is essentially all black. Cross-origin frames
        // can't be read back; those are trusted as-is.
        function isBlank(c, x, y, w, h) {
            try {
                const data = c.getImageData(x, y, w, h).data;
                const stride = 4 * 7; // sample every 7th pixel
                for (let i = 0; i < data.length; i += stride) {
                    if (data[i] > 12 || data[i + 1] > 12 || data[i + 2] > 12) {
                        return false;
                    }
                }
                return true;
            } catch (error) {
                return false;
            }
        }

        const thumbsMap = new WeakMap();

        function getThumbs(video) {
            let thumbs = thumbsMap.get(video);
            if (!thumbs) {
                thumbs = new Thumbs(video);
                thumbsMap.set(video, thumbs);
            }
            return thumbs;
        }

        class Thumbs {
            constructor(video) {
                this.video = video;
                this.src = null;
                this.interval = 0;
                this.generation = 0;
                this.frames = new Map();
                this.seeker = null;
                this.tried = new Set();
                this.failures = 0;
                this.busy = false;
                this.want = null;
                this.openTimer = null;
                this.blanks = new Map();    // bucket → times an all-black frame was rejected
                this.filling = false;       // background pre-fill started
                this.fillQueue = null;
                this.fillTimer = null;
                this.nextFillAt = 0;

                const capture = () => this.captureLive();
                video.addEventListener('timeupdate', capture);
                video.addEventListener('seeked', capture);
                video.addEventListener('loadeddata', capture);
                video.addEventListener('emptied', () => this.sync());
            }

            // Drop cached frames when the source or bucket size changes.
            sync() {
                const video = this.video;
                const src = video.currentSrc || video.src || '';
                const duration = video.duration;
                const interval = isFinite(duration) && duration > 0
                    ? Math.max(MIN_INTERVAL, duration / MAX_FRAMES)
                    : LIVE_INTERVAL;

                if (src === this.src && interval === this.interval) {
                    return;
                }

                // Same stream with a new duration: keep the working seeker.
                if (src !== this.src) {
                    this.killSeeker();
                    this.tried.clear();
                }
                this.src = src;
                this.interval = interval;
                this.generation++;
                this.frames.clear();
                this.blanks.clear();
                this.fillQueue = null;
                this.want = null;
                this.failures = 0;
            }

            bucket(time) {
                return Math.round(time / this.interval);
            }

            // Copy the current frame of `source`, letterboxed into the fixed 4:3 box.
            // Returns false when nothing usable was captured.
            storeFrame(bucket, source) {
                const vw = source.videoWidth;
                const vh = source.videoHeight;
                if (!vw || !vh) {
                    return false;
                }

                const canvas = document.createElement('canvas');
                canvas.width = STORE_W;
                canvas.height = STORE_H;

                const scale = Math.min(STORE_W / vw, STORE_H / vh);
                const dw = Math.max(1, Math.round(vw * scale));
                const dh = Math.max(1, Math.round(vh * scale));
                const dx = Math.round((STORE_W - dw) / 2);
                const dy = Math.round((STORE_H - dh) / 2);
                const c = canvas.getContext('2d');
                c.imageSmoothingQuality = 'low';

                try {
                    c.fillStyle = '#000';
                    c.fillRect(0, 0, STORE_W, STORE_H);
                    c.drawImage(source, dx, dy, dw, dh);
                } catch (error) {
                    return false;
                }

                // A frame grabbed before it was decoded comes out pure black; don't
                // cache it (a genuinely black scene is accepted after a few tries).
                const tries = this.blanks.get(bucket) || 0;
                if (tries < BLANK_RETRIES && isBlank(c, dx, dy, dw, dh)) {
                    this.blanks.set(bucket, tries + 1);
                    return false;
                }

                this.frames.delete(bucket);
                this.frames.set(bucket, canvas);
                if (this.frames.size > MAX_FRAMES + 8) {
                    this.frames.delete(this.frames.keys().next().value);
                }

                onFrame(this);
                return true;
            }

            captureLive() {
                if (!settings.thumbs) {
                    return;
                }

                const video = this.video;
                this.sync();

                // DRM output draws as black; skip it.
                if (video.mediaKeys || video.readyState < 2 || video.seeking || !video.videoWidth) {
                    return;
                }

                const bucket = this.bucket(video.currentTime);
                if (!this.frames.has(bucket)) {
                    this.storeFrame(bucket, video);
                }
            }

            // Best frame for a time: exact bucket, else a nearby stand-in while the exact one loads.
            lookup(time) {
                this.sync();
                const bucket = this.bucket(time);
                const exact = this.frames.get(bucket);
                if (exact) {
                    return { canvas: exact, exact: true };
                }

                this.request(bucket);

                // Closest cached frame stands in (blurred) until the exact one arrives.
                let near = null;
                let nearDistance = Infinity;
                this.frames.forEach((canvas, b) => {
                    const distance = Math.abs(b - bucket);
                    if (distance < nearDistance) {
                        near = canvas;
                        nearDistance = distance;
                    }
                });
                return { canvas: near, exact: false };
            }

            // Pointer is over the video: open the seeker and start pre-filling
            // thumbnails so they are ready by the time the seek bar is hovered.
            warm() {
                this.sync();
                if (this.filling) {
                    return;
                }
                this.filling = true;
                if (this.ensureSeeker()) {
                    this.pump();
                }
            }

            // Background order: coarse pass first (every 16th bucket), then finer,
            // so the whole timeline gets rough coverage quickly.
            nextFill() {
                if (!this.fillQueue) {
                    const duration = this.video.duration;
                    const last = isFinite(duration) && duration > 0 ? Math.floor(duration / this.interval) : -1;
                    const seen = new Set();
                    this.fillQueue = [];
                    for (let step = 16; step >= 1; step /= 2) {
                        for (let b = 0; b <= last; b += step) {
                            if (!seen.has(b)) {
                                seen.add(b);
                                this.fillQueue.push(b);
                            }
                        }
                    }
                }

                while (this.fillQueue.length && this.frames.has(this.fillQueue[0])) {
                    this.fillQueue.shift();
                }
                return this.fillQueue.length ? this.fillQueue[0] : null;
            }

            canSeek() {
                return !!this.seeker;
            }

            request(bucket) {
                this.want = bucket;
                if (this.ensureSeeker()) {
                    this.pump();
                }
            }

            // Stream URLs worth trying, best first: the video's own src, then sniffed
            // playlists and files, newest first.
            nextSource() {
                if (this.tried.size >= MAX_SOURCE_ATTEMPTS) {
                    return null;
                }

                const candidates = [];
                const own = this.video.currentSrc || '';
                if (/^(https?|data):/i.test(own)) {
                    candidates.push({ url: own, kind: HLS_RE.test(own) ? 'hls' : 'file' });
                }
                sniffed.hls.slice().reverse().forEach(url => candidates.push({ url, kind: 'hls' }));
                sniffed.file.slice().reverse().forEach(url => candidates.push({ url, kind: 'file' }));

                return candidates.find(source => !this.tried.has(source.url)) || null;
            }

            ensureSeeker(retry) {
                if (this.seeker) {
                    return true;
                }
                if (this.video.mediaKeys) {
                    return false;
                }

                const source = retry || this.nextSource();
                if (!source) {
                    return false;
                }
                this.tried.add(source.creds ? source.url + '#creds' : source.url);

                const fail = network => {
                    if (this.seeker !== handle) {
                        return;
                    }
                    // Cookie-protected playlists need credentials; retry once with them.
                    const again = network && source.kind === 'hls' && !source.creds && !this.tried.has(source.url + '#creds')
                        ? Object.assign({}, source, { creds: true })
                        : null;
                    this.nextSeeker(again);
                };

                const handle = openSeeker(source, fail);
                this.seeker = handle;
                this.failures = 0;

                clearTimeout(this.openTimer);
                this.openTimer = setTimeout(() => {
                    if (!handle.ready) {
                        fail(false);
                    }
                }, OPEN_TIMEOUT);

                handle.el.addEventListener('loadedmetadata', () => {
                    if (this.seeker !== handle) {
                        return;
                    }
                    if (!durationMatches(this.video.duration, handle.el.duration)) {
                        fail(false); // some other stream on the page (ad, preview, other player)
                        return;
                    }
                    clearTimeout(this.openTimer);
                    handle.ready = true;
                    this.pump();
                });

                return true;
            }

            // Current seeker is unusable: drop it and move on to the next candidate.
            nextSeeker(retry) {
                this.killSeeker();
                if (this.ensureSeeker(retry)) {
                    this.pump();
                } else {
                    onFrame(this); // nothing left: re-render without the loading frame
                }
            }

            killSeeker() {
                clearTimeout(this.openTimer);
                clearTimeout(this.fillTimer);
                this.fillTimer = null;
                const handle = this.seeker;
                this.seeker = null;
                this.busy = false;
                closeSeeker(handle);
            }

            // Seek the hidden copy one bucket at a time: the hovered bucket first,
            // otherwise the next background pre-fill bucket.
            pump() {
                const handle = this.seeker;
                if (!handle || !handle.ready || this.busy) {
                    return;
                }

                let bucket = this.want;
                this.want = null;
                if (bucket !== null && this.frames.has(bucket)) {
                    bucket = null;
                }

                const background = bucket === null;
                if (background) {
                    if (!this.filling || !settings.thumbs || document.hidden) {
                        return;
                    }
                    bucket = this.nextFill();
                    if (bucket === null) {
                        return;
                    }

                    // Go easy on bandwidth while the real video is playing.
                    const wait = this.nextFillAt - performance.now();
                    if (wait > 0) {
                        if (!this.fillTimer) {
                            this.fillTimer = setTimeout(() => {
                                this.fillTimer = null;
                                this.pump();
                            }, wait);
                        }
                        return;
                    }
                    this.fillQueue.shift();
                }

                const el = handle.el;
                const generation = this.generation;
                this.busy = true;
                let timer = null;

                const finish = () => {
                    this.busy = false;
                    if (background) {
                        this.nextFillAt = performance.now() + (this.video.paused ? 0 : FILL_PACE_PLAYING);
                    }
                    this.pump();
                };

                const grab = () => {
                    if (this.seeker !== handle) {
                        return;
                    }
                    if (generation === this.generation && !this.storeFrame(bucket, el) && !background) {
                        const tries = this.blanks.get(bucket) || 0;
                        if (tries > 0 && tries <= BLANK_RETRIES && this.want === null) {
                            this.want = bucket; // blank frame: retry at a slightly later time
                        }
                    }
                    finish();
                };

                const done = ok => {
                    clearTimeout(timer);
                    el.removeEventListener('seeked', onSeeked);
                    if (this.seeker !== handle) {
                        return; // replaced meanwhile
                    }

                    if (!ok) {
                        this.busy = false;
                        if (++this.failures >= MAX_SEEK_FAILURES) {
                            if (!background) {
                                this.want = bucket;
                            }
                            this.nextSeeker();
                            return;
                        }
                        this.pump();
                        return;
                    }

                    this.failures = 0;

                    // 'seeked' can fire before the new frame is decoded; wait for it
                    // to be presented (with a fallback when the callback never comes).
                    if (typeof el.requestVideoFrameCallback === 'function') {
                        let grabbed = false;
                        const once = () => {
                            if (!grabbed) {
                                grabbed = true;
                                grab();
                            }
                        };
                        el.requestVideoFrameCallback(once);
                        setTimeout(once, FRAME_WAIT);
                    } else {
                        setTimeout(grab, 80);
                    }
                };

                const onSeeked = () => done(true);

                timer = setTimeout(() => done(false), SEEK_TIMEOUT);
                el.addEventListener('seeked', onSeeked);

                // After a rejected black frame, nudge the time forward to get a different frame.
                const nudge = (this.blanks.get(bucket) || 0) * Math.min(1, this.interval / 3);
                const end = isFinite(el.duration) ? el.duration - 0.05 : Infinity;
                const start = el.seekable && el.seekable.length ? el.seekable.start(0) : 0;
                el.currentTime = clamp(bucket * this.interval + nudge, start, Math.max(start, end));
            }
        }

        // ------------------------------------------------ tooltip (inside the toolbox shadow root)

        let tip = null;
        let frame, view, ctx, label;
        let state = null;

        function mountTip() {
            if (tip) {
                return true;
            }
            if (!shadow) {
                return false;
            }

            const style = document.createElement('style');
            style.textContent = TIP_CSS;

            view = document.createElement('canvas');
            view.width = STORE_W;   // CSS scales it up to THUMB_W × THUMB_H
            view.height = STORE_H;
            ctx = view.getContext('2d');

            frame = document.createElement('div');
            frame.className = 'vt-frame';
            frame.append(view);

            label = document.createElement('div');
            label.className = 'vt-time';

            tip = document.createElement('div');
            tip.className = 'vt-tip';
            tip.hidden = true;
            tip.append(frame, label);

            // Sibling of .root, so it shows even while the toolbox tab is hidden.
            shadow.append(style, tip);
            return true;
        }

        function show(thumbs, time, x, anchor, bound) {
            if (!mountTip()) {
                return;
            }
            state = { thumbs, time, x, anchor, bound };
            renderTip();
        }

        function renderTip() {
            if (!state) {
                return;
            }

            const { thumbs, time, x, anchor, bound } = state;
            const { canvas, exact } = thumbs.lookup(time);

            if (canvas || thumbs.canSeek()) {
                if (canvas) {
                    ctx.drawImage(canvas, 0, 0);
                } else {
                    ctx.fillStyle = '#111';
                    ctx.fillRect(0, 0, STORE_W, STORE_H);
                }
                frame.hidden = false;
                frame.classList.toggle('approx', !!canvas && !exact);
                frame.classList.toggle('loading', !exact);
            } else {
                frame.hidden = true;
            }

            label.textContent = formatTime(time);
            tip.hidden = false;

            const tw = tip.offsetWidth;
            const th = tip.offsetHeight;
            const minX = Math.max(4, bound.left);
            const maxX = Math.min(window.innerWidth - 4, bound.right) - tw;
            const left = clamp(x - tw / 2, minX, Math.max(minX, maxX));
            let top = anchor.top - th - TIP_GAP;
            if (top < 4) {
                top = anchor.bottom + 10;
            }

            tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        }

        function hide() {
            state = null;
            lockedTrack = null;
            if (tip) {
                tip.hidden = true;
            }
        }

        function onFrame(thumbs) {
            if (state && state.thumbs === thumbs) {
                renderTip();
            }
        }

        // ------------------------------------------------ video discovery

        const shadowVideos = new Set();
        let videoCache = [];
        let lastScan = 0;
        let lastDeepScan = 0;

        function deepScan(rootNode) {
            rootNode.querySelectorAll('*').forEach(el => {
                if (!el.shadowRoot) {
                    return;
                }
                el.shadowRoot.querySelectorAll('video').forEach(video => shadowVideos.add(video));
                deepScan(el.shadowRoot);
            });
        }

        // Visible videos with their rects, including ones inside open shadow roots.
        function collectVideos(path) {
            const now = performance.now();

            for (const node of path) {
                if (isVideo(node) && !shadowVideos.has(node)) {
                    shadowVideos.add(node);
                    lastScan = 0;
                }
            }

            if (now - lastScan > 1000) {
                lastScan = now;
                if (now - lastDeepScan > 5000) {
                    lastDeepScan = now;
                    deepScan(document);
                }
                shadowVideos.forEach(video => {
                    if (!video.isConnected) {
                        shadowVideos.delete(video);
                    }
                });

                const all = new Set(document.querySelectorAll('video'));
                shadowVideos.forEach(video => all.add(video));
                videoCache = [...all];
                videoCache.forEach(getThumbs); // start live capture on videos found late
            }

            return videoCache
                .map(video => ({ video, rect: video.getBoundingClientRect() }))
                .filter(item => item.rect.width >= 120 && item.rect.height >= 60);
        }

        // ------------------------------------------------ seek bar detection

        function looksLikeTrack(el) {
            if (el.tagName === 'INPUT') {
                return el.type === 'range';
            }

            const role = el.getAttribute('role');
            if (role === 'slider' || role === 'progressbar') {
                return true;
            }

            const text = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '');
            if (LABEL_RE.test(text)) {
                return true;
            }

            const cls = typeof el.className === 'string' ? el.className : (el.getAttribute('class') || '');
            return TRACK_RE.test(cls) || TRACK_RE.test(el.id);
        }

        // Video this element is the seek bar of, judged by shape and position.
        function matchTrack(rect, videos) {
            if (rect.height <= 0 || rect.height > TRACK_MAX_HEIGHT) {
                return null;
            }

            let best = null;
            let bestScore = Infinity;
            const cy = rect.top + rect.height / 2;

            for (const { video, rect: vr } of videos) {
                if (rect.width < Math.max(60, vr.width * TRACK_MIN_WIDTH_RATIO)) continue;
                if (rect.left < vr.left - 40 || rect.right > vr.right + 40) continue;
                if (rect.top < vr.top + vr.height * 0.4 || rect.top > vr.bottom + 120) continue;

                const score = Math.abs(vr.bottom - cy);
                if (score < bestScore) {
                    best = { video, vr };
                    bestScore = score;
                }
            }
            return best;
        }

        let lockedTrack = null; // { el, video }

        function resolveHit(event, path) {
            const x = event.clientX;
            const y = event.clientY;

            // Seek bar found on an earlier move: keep it while the pointer stays near.
            if (lockedTrack && lockedTrack.el.isConnected) {
                const rect = lockedTrack.el.getBoundingClientRect();
                const dragging = (event.buttons & 1) === 1;
                const inside = x >= rect.left - 2 && x <= rect.right + 2 &&
                    y >= rect.top - TRACK_HOVER_SLOP && y <= rect.bottom + TRACK_HOVER_SLOP;
                if (rect.width && (inside || dragging)) {
                    return { video: lockedTrack.video, rect, vr: lockedTrack.video.getBoundingClientRect() };
                }
            }
            lockedTrack = null;

            if (host && path.includes(host)) {
                return null; // over the toolbox itself
            }

            const videos = collectVideos(path);
            if (!videos.length) {
                return null;
            }

            const under = videos
                .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom + 60)
                .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0];

            if (under) {
                getThumbs(under.video).warm();
            }

            // Alt + hover anywhere over a video: preview across its full width.
            if (event.altKey && under && y <= under.rect.bottom) {
                const r = under.rect;
                return {
                    video: under.video,
                    vr: r,
                    rect: { left: r.left, right: r.right, width: r.width, top: y - 8, bottom: y + 8 }
                };
            }

            // Custom controls: walk up from the element under the pointer. Pick the widest
            // match so a partly-filled "played" bar never wins over the full rail.
            let found = null;
            for (let i = 0, depth = 0; i < path.length && depth < PATH_DEPTH; i++) {
                const el = path[i];
                if (!el || el.nodeType !== 1) {
                    continue; // shadow roots, document, window
                }
                depth++;
                if (isVideo(el) || !looksLikeTrack(el)) {
                    continue;
                }

                const rect = el.getBoundingClientRect();
                const match = matchTrack(rect, videos);
                if (match && (!found || rect.width > found.rect.width + 1)) {
                    found = { el, video: match.video, vr: match.vr, rect };
                }
            }
            if (found) {
                lockedTrack = { el: found.el, video: found.video };
                return found;
            }

            // Native controls: the browser's timeline lives in a closed shadow root,
            // so approximate it as the bottom band of the video.
            if (isVideo(path[0]) && path[0].controls) {
                const item = videos.find(v => v.video === path[0]);
                const vr = item && item.rect;
                if (vr && y >= vr.bottom - NATIVE_BAR_HEIGHT && y <= vr.bottom) {
                    const left = vr.left + NATIVE_BAR_INSET;
                    const width = vr.width - NATIVE_BAR_INSET * 2;
                    return {
                        video: path[0],
                        vr,
                        rect: { left, right: left + width, width, top: vr.bottom - NATIVE_BAR_HEIGHT, bottom: vr.bottom }
                    };
                }
            }

            return null;
        }

        // ------------------------------------------------ pointer handling

        let pendingEvent = null;
        let pendingPath = [];
        let frameRequest = 0;

        function update() {
            frameRequest = 0;
            const event = pendingEvent;
            if (!event || !settings.thumbs) {
                return;
            }

            const hit = resolveHit(event, pendingPath);
            const range = hit && getRange(hit.video);
            if (!hit || !range || !hit.rect.width) {
                hide();
                return;
            }

            const fraction = clamp((event.clientX - hit.rect.left) / hit.rect.width, 0, 1);
            const time = range.start + fraction * (range.end - range.start);
            const bound = {
                left: Math.min(hit.vr.left, hit.rect.left),
                right: Math.max(hit.vr.right, hit.rect.right)
            };

            show(getThumbs(hit.video), time, event.clientX, hit.rect, bound);
        }

        document.addEventListener('pointermove', event => {
            if (!settings.thumbs) {
                return;
            }
            pendingEvent = event;
            pendingPath = event.composedPath(); // only available during dispatch
            if (!frameRequest) {
                frameRequest = requestAnimationFrame(update);
            }
        }, { capture: true, passive: true });

        document.addEventListener('mouseout', event => {
            if (!event.relatedTarget) {
                hide();
            }
        }, true);

        window.addEventListener('blur', hide);

        // Live capture for light-DOM videos starts as soon as they load or play (media
        // events do not bubble, but a capturing listener on document still sees them).
        // Playback also starts the background pre-fill, so thumbnails are ready early.
        ['loadeddata', 'timeupdate', 'play'].forEach(type => {
            document.addEventListener(type, event => {
                if (settings.thumbs && isVideo(event.target)) {
                    const thumbs = getThumbs(event.target);
                    if (type === 'play') {
                        thumbs.warm();
                    }
                }
            }, true);
        });

        // Streams found after a video gave up on seeking: let the open tooltip retry.
        let lastSniffVersion = 0;
        setInterval(() => {
            if (sniffVersion !== lastSniffVersion) {
                lastSniffVersion = sniffVersion;
                renderTip();
            }
        }, 1500);

        return { hide };
    })();

    // =========================================================
    // INITIALIZE
    // =========================================================

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== 'function') {
            return;
        }

        GM_registerMenuCommand('Open / close toolbox (Alt+A)', () => {
            if (root && !root.hidden) {
                setPanel(!panelOpen);
            }
        });

        GM_registerMenuCommand('Move tab to other side', () => {
            settings.side = settings.side === 'left' ? 'right' : 'left';
            saveSettings();
            applyLayout();
        });

        GM_registerMenuCommand('Toggle seek bar thumbnails (Alt+P)', () => toggleSetting('thumbs', true));

        GM_registerMenuCommand('Edit always-on sites…', () => {
            const answer = window.prompt(
                'Sites where saved settings load automatically (comma-separated hosts, e.g. www.youtube.com, twitch.tv):',
                getAutoSites().join(', ')
            );
            if (answer !== null) {
                setAutoSites(answer.split(','));
                scheduleRender();
            }
        });

        GM_registerMenuCommand('Reset all audio settings', () => resetAll(true));
    }

    function initialize() {
        createUI();
        installGlobalListeners();
        scanMedia();
        startObserver();
        registerMenu();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();

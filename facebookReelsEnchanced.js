// ==UserScript==
// @name         Facebook Reels Enhanced
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Enhanced Facebook Reels with persistent audio controls and custom styling
// @updateURL    https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/facebookReelsEnchanced.js
// @downloadURL  https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/facebookReelsEnchanced.js
// @author       khaledzaki370
// @match        *.facebook.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=facebook.com
// @grant        GM_addStyle
// @require      https://code.jquery.com/jquery-3.7.1.min.js
// ==/UserScript==
/* eslint-disable */

(function () {
    'use strict';

    // Custom CSS styling for overlay controls
    GM_addStyle(`
        div[id^="mount_0_0_"] > div > div:nth-child(1) > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.x1ey2m1c.x78zum5.xtijo5x.x1o0tod.x10l6tqk.x13vifvy > div > div > div > div > div.xtp0wl1.x1614rti > div > div > div > div.x1pq812k.x6s0dn4.xal61yo.xl56j7k.x1odjw0f.x1n2onr6.x1rohswg.xkcv6ua.x168l2et.xh8yej3.xfk6m8.x16ye13r > div:nth-child(1) > div > div > div.x78zum5.x5yr21d.xl56j7k.x1n2onr6.xh8yej3 > div.xi2lk0m.x11dcrhx.xrotz4w.x10l6tqk > div > div.xzt5al7 > div > div,
        #mount_0_0_Hh > div > div:nth-child(1) > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.x1ey2m1c.x78zum5.xtijo5x.x1o0tod.x10l6tqk.x13vifvy > div > div > div > div > div.xtp0wl1.x1614rti > div > div > div > div.x1pq812k.x6s0dn4.xal61yo.xl56j7k.x1odjw0f.x1n2onr6.x1rohswg.xkcv6ua.x168l2et.xh8yej3.xfk6m8.x16ye13r > div:nth-child(1) > div > div > div.x78zum5.x5yr21d.xl56j7k.x1n2onr6.xh8yej3 > div.xi2lk0m.x11dcrhx.xrotz4w.x10l6tqk > div > div.xzt5al7 > div > div {
            width: 97% !important;
            margin: 0 auto !important;
            margin-bottom: 2.8% !important;
            position: relative !important;
            z-index: 999 !important;
        }

        .fb-reels-volume-toast {
            position: absolute;
            top: 20%;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(0, 0, 0, 0.85);
            color: #fff;
            padding: 8px 18px;
            border-radius: 20px;
            font-size: 15px;
            font-weight: 600;
            z-index: 10000;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s ease-in-out;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
            letter-spacing: 0.5px;
        }
        .fb-reels-volume-toast.visible {
            opacity: 1;
        }
    `);

    // Default volume: every video starts at 20%
    const DEFAULT_VOLUME = 0.2;

    const volumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
    const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');

    const isReelPage = () => {
        const href = window.location.href;
        return href.includes('/reel') || href.includes('/reels') || href.includes('/share/r/');
    };

    const showToast = (video, text) => {
        try {
            const container = video.parentElement;
            if (!container) return;
            let toast = container.querySelector('.fb-reels-volume-toast');
            if (!toast) {
                toast = document.createElement('div');
                toast.className = 'fb-reels-volume-toast';
                container.appendChild(toast);
            }
            toast.textContent = text;
            toast.classList.add('visible');
            clearTimeout(toast._timer);
            toast._timer = setTimeout(() => {
                toast.classList.remove('visible');
            }, 1000);
        } catch (_) { }
    };

    let isInternalSetting = false;

    // Track page scrolling between reels
    let lastPageScrollTime = 0;
    window.addEventListener('scroll', () => {
        lastPageScrollTime = Date.now();
    }, { passive: true });

    const videoProcessed = new WeakSet();

    const addControls = (videoEl, shouldPause = false) => {
        const video = videoEl instanceof $ ? videoEl[0] : videoEl;
        if (!video || videoProcessed.has(video)) return;
        videoProcessed.add(video);

        video.controls = true;

        // Scoped to this video element: starts at 20% default
        let videoVolume = DEFAULT_VOLUME;
        let isSeeking = false;
        let lastSeekTime = 0;
        let lastMediaStartTime = Date.now();
        let isStartingReel = true;
        let isInitializing = true;

        const applyVolume = (val) => {
            isInternalSetting = true;
            try {
                if (mutedDesc && mutedDesc.set) {
                    mutedDesc.set.call(video, false);
                } else {
                    video.muted = false;
                }
                if (volumeDesc && volumeDesc.set) {
                    volumeDesc.set.call(video, val);
                } else {
                    video.volume = val;
                }
            } catch (_) { } finally {
                isInternalSetting = false;
            }
        };

        const resetToDefaultVolume = () => {
            videoVolume = DEFAULT_VOLUME;
            lastMediaStartTime = Date.now();
            isStartingReel = true;
            applyVolume(DEFAULT_VOLUME);
            setTimeout(() => applyVolume(DEFAULT_VOLUME), 50);
            setTimeout(() => applyVolume(DEFAULT_VOLUME), 150);
            setTimeout(() => applyVolume(DEFAULT_VOLUME), 300);
            setTimeout(() => { isStartingReel = false; }, 1500);
        };

        // Initial 20% volume setup for this video
        resetToDefaultVolume();

        setTimeout(() => {
            isInitializing = false;
        }, 1000);

        if (shouldPause) {
            video.pause();
        }

        // Viewport intersection: whenever scrolling to this reel, reset it fresh to 20%
        const intersectionObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    resetToDefaultVolume();
                }
            });
        }, { threshold: 0.1 });

        intersectionObserver.observe(video);

        // Timeline seek tracking: prevents seeking/scrubbing from resetting volume
        video.addEventListener('seeking', () => {
            isSeeking = true;
            lastSeekTime = Date.now();
        }, true);

        video.addEventListener('seeked', () => {
            isSeeking = false;
            lastSeekTime = Date.now();
            applyVolume(videoVolume);
            setTimeout(() => applyVolume(videoVolume), 50);
            setTimeout(() => applyVolume(videoVolume), 150);
            setTimeout(() => applyVolume(videoVolume), 300);
            setTimeout(() => applyVolume(videoVolume), 600);
        }, true);

        // Hook start and play transitions
        ['loadstart', 'loadedmetadata', 'play'].forEach(eventType => {
            video.addEventListener(eventType, () => {
                lastMediaStartTime = Date.now();
                applyVolume(videoVolume);
                setTimeout(() => applyVolume(videoVolume), 50);
                setTimeout(() => applyVolume(videoVolume), 150);
                setTimeout(() => applyVolume(videoVolume), 300);
            }, true);
        });

        // Override volume property on the video instance to block Facebook's automated overrides
        try {
            Object.defineProperty(video, 'volume', {
                configurable: true,
                get: function () {
                    return videoVolume;
                },
                set: function (val) {
                    if (isInternalSetting) {
                        if (volumeDesc && volumeDesc.set) {
                            volumeDesc.set.call(this, val);
                        } else {
                            this.volume = val;
                        }
                        return;
                    }

                    const isSeekActive = isSeeking || this.seeking || (Date.now() - lastSeekTime < 1000);
                    const isStarting = isInitializing || isStartingReel || (Date.now() - lastMediaStartTime < 1500);
                    const isScrollActive = (Date.now() - lastPageScrollTime < 1500);

                    // Block Facebook's volume resets during seek, initial mount, or when scrolling between reels
                    if (isSeekActive || isStarting || isScrollActive) {
                        if (volumeDesc && volumeDesc.set) {
                            volumeDesc.set.call(this, videoVolume);
                        }
                        return;
                    }

                    // Genuine user volume slider change on this video!
                    const num = parseFloat(val);
                    if (!isNaN(num) && num >= 0 && num <= 1) {
                        videoVolume = num;
                        if (volumeDesc && volumeDesc.set) {
                            volumeDesc.set.call(this, num);
                        }
                        showToast(this, `🔊 ${Math.round(videoVolume * 100)}%`);
                    }
                }
            });

            Object.defineProperty(video, 'muted', {
                configurable: true,
                get: function () {
                    return false;
                },
                set: function (val) {
                    if (isInternalSetting) {
                        if (mutedDesc && mutedDesc.set) {
                            mutedDesc.set.call(this, val);
                        }
                        return;
                    }
                    // Prevent Facebook from muting during seek or reel transitions
                    if (mutedDesc && mutedDesc.set) {
                        mutedDesc.set.call(this, false);
                    }
                }
            });
        } catch (_) { }

        // Native controls volume slider changes (both click & drag)
        video.addEventListener('volumechange', () => {
            if (isInternalSetting) return;

            const isSeekActive = isSeeking || video.seeking || (Date.now() - lastSeekTime < 1000);
            const isStarting = isInitializing || isStartingReel || (Date.now() - lastMediaStartTime < 1500);
            const isScrollActive = (Date.now() - lastPageScrollTime < 1500);

            // Block Facebook's volume resets during seek, video start, or page scroll
            if (isSeekActive || isStarting || isScrollActive) {
                applyVolume(videoVolume);
                return;
            }

            // User changed volume via native controls slider!
            const current = volumeDesc && volumeDesc.get ? volumeDesc.get.call(video) : video.volume;
            if (Math.abs(current - videoVolume) > 0.01) {
                videoVolume = current;
                showToast(video, `🔊 ${Math.round(videoVolume * 100)}%`);
            }
        }, true);

        // Mouse Wheel volume control: scroll near bottom controls or while holding Shift
        video.addEventListener('wheel', (e) => {
            const rect = video.getBoundingClientRect();
            const isNearBottom = e.clientY >= (rect.bottom - 80);
            if (e.shiftKey || isNearBottom) {
                e.preventDefault();
                e.stopPropagation();
                const step = e.deltaY < 0 ? 0.05 : -0.05;
                videoVolume = Math.min(1, Math.max(0, Math.round((videoVolume + step) * 100) / 100));
                applyVolume(videoVolume);
                showToast(video, `🔊 ${Math.round(videoVolume * 100)}%`);
            }
        }, { passive: false });

        // Watch for muted attribute being added via DOM mutation
        const attrObserver = new MutationObserver(() => {
            if (video.hasAttribute('muted')) {
                video.removeAttribute('muted');
            }
            if (video.muted) {
                applyVolume(videoVolume);
            }
        });
        attrObserver.observe(video, { attributes: true, attributeFilter: ['muted'] });

        // Keep controls visible & sound active as long as video is in DOM
        const intervalId = setInterval(() => {
            if (!document.contains(video)) {
                clearInterval(intervalId);
                intersectionObserver.disconnect();
                attrObserver.disconnect();
                return;
            }
            if (!video.controls) {
                video.controls = true;
            }
            const current = volumeDesc && volumeDesc.get ? volumeDesc.get.call(video) : video.volume;
            if (!isSeeking && !video.seeking && (Math.abs(current - videoVolume) > 0.02 || video.muted)) {
                applyVolume(videoVolume);
            }
        }, 1000);

        setTimeout(() => applyVolume(videoVolume), 100);
        setTimeout(() => applyVolume(videoVolume), 300);
    };

    // Scan DOM for videos and attach controls
    const scanAndEnhance = (shouldPause = false) => {
        if (!isReelPage()) return;
        const videos = document.querySelectorAll('video');
        videos.forEach(v => addControls(v, shouldPause));
    };

    // 1. Initial scan on script load
    scanAndEnhance(true);

    // 2. Real-time MutationObserver: detects newly added <video> elements instantly when React renders them
    const domObserver = new MutationObserver((mutations) => {
        if (!isReelPage()) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeName === 'VIDEO') {
                    addControls(node, false);
                } else if (node.querySelectorAll) {
                    const foundVideos = node.querySelectorAll('video');
                    foundVideos.forEach(v => addControls(v, false));
                }
            }
        }
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });

    // 3. SPA Navigation Detection: Handle same-page URL changes (pushState, replaceState, popstate)
    let lastUrl = window.location.href;
    const handleUrlChange = () => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastUrl) {
            lastUrl = currentUrl;
            if (isReelPage()) {
                scanAndEnhance(false);
                setTimeout(() => scanAndEnhance(false), 200);
                setTimeout(() => scanAndEnhance(false), 600);
                setTimeout(() => scanAndEnhance(false), 1200);
            }
        }
    };

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
        originalPushState(...args);
        handleUrlChange();
    };

    history.replaceState = function (...args) {
        originalReplaceState(...args);
        handleUrlChange();
    };

    window.addEventListener('popstate', handleUrlChange);

    // Polling fallback for edge cases
    setInterval(handleUrlChange, 500);

})();

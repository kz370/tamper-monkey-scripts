// ==UserScript==
// @name         Draggable Text Redirect
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  Open dragged text in a new tab based on a base URL
// @author       khaledzaki370
// @updateURL    https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/draggable.user.js
// @downloadURL  https://raw.githubusercontent.com/kz370/tamper-monkey-scripts/main/draggable.user.js
// @grant        GM_openInTab
// @match        *://*/*
// @icon         https://img.icons8.com/?size=100&id=Sm9xAvXfn1wF&format=png&color=000000
// @require      data:text/plain;base64,d2luZG93LnRydXN0ZWRUeXBlcy5jcmVhdGVQb2xpY3koJ2RlZmF1bHQnLCB7IGNyZWF0ZUhUTUw6IHN0ciA9PiBzdHIsIGNyZWF0ZVNjcmlwdFVSTDogc3RyPT4gc3RyLCBjcmVhdGVTY3JpcHQ6IHN0cj0+IHN0ciB9KTs=
// @require      https://code.jquery.com/jquery-3.6.0.min.js
// ==/UserScript==

/* eslint-disable */

(function ($) {
    'use strict';

    $.noConflict();

    // url:   %s is replaced with the dragged text
    // label: name shown next to the mouse
    // icon:  optional. Leave it out to use the site's own favicon,
    //        or set an emoji ('🔍') or an image URL ('https://.../icon.png')
    const sites = {
        google: {
            url: 'https://www.google.com/search?q=%s',
            label: 'Google',
            icon: '🔍',
        },
        youtube: {
            url: 'https://www.youtube.com/results?search_query=%s',
            label: 'YouTube',
            icon: '▶️',
        },
    };

    const corners = {
        topLeft: sites.youtube,
        topRight: sites.youtube,
        bottomLeft: sites.google,
        bottomRight: sites.google,
    };

    const arrows = {
        topLeft: '↖',
        topRight: '↗',
        bottomLeft: '↙',
        bottomRight: '↘',
    };

    // Drag must move at least this many pixels before a corner is picked
    const DEAD_ZONE = 30;

    let currentCorner = null;
    let isDragging = false;
    let selectedText = null;
    let startX = 0; // page coordinates of where the drag started
    let startY = 0;
    let isAltPressed = false;
    let isNearTabArea = false;
    let isOverEditable = false;

    // ==========================================
    // FLOATING ICON THAT FOLLOWS THE MOUSE
    // ==========================================

    let badge = null;

    function getBadge() {
        if (badge && document.documentElement.contains(badge)) {
            return badge;
        }

        badge = document.createElement('div');
        badgeKey = null;

        Object.assign(badge.style, {
            position: 'fixed',
            left: '0px',
            top: '0px',
            zIndex: '2147483647',
            pointerEvents: 'none',
            display: 'none',
            padding: '4px 8px',
            borderRadius: '8px',
            background: 'rgba(20, 20, 20, 0.85)',
            color: '#fff',
            font: '13px/1.4 system-ui, sans-serif',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
        });

        document.documentElement.appendChild(badge);

        return badge;
    }

    // Image URL for a site's icon, or null if the icon is an emoji / text
    function getIconUrl(site) {
        if (site.icon) {
            return /^(https?:|data:)/.test(site.icon) ? site.icon : null;
        }

        try {
            const host = new URL(site.url.replace('%s', 'x')).hostname;
            return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
        } catch (err) {
            return null;
        }
    }

    function makeIcon(site) {
        const iconUrl = getIconUrl(site);

        if (!iconUrl) {
            const span = document.createElement('span');
            span.textContent = site.icon || '';
            return span;
        }

        const img = document.createElement('img');

        img.src = iconUrl;
        Object.assign(img.style, {
            width: '16px',
            height: '16px',
            verticalAlign: 'middle',
            display: 'inline-block',
            margin: '0',
        });

        // Page blocks the image (CSP) or it doesn't exist: just drop it
        img.onerror = () => img.remove();

        return img;
    }

    let badgeKey = null; // what the badge currently shows, so we don't rebuild it on every dragover

    function showBadge(x, y, key, build) {
        const el = getBadge();

        if (badgeKey !== key) {
            badgeKey = key;
            el.textContent = '';
            build(el);
        }

        el.style.display = 'block';
        el.style.transform = `translate(${x + 16}px, ${y + 16}px)`;
    }

    function showSiteBadge(x, y, corner) {
        showBadge(x, y, corner, (el) => {
            const site = corners[corner];

            el.append(
                arrows[corner] + ' ',
                makeIcon(site),
                ' ' + (site.label || ''),
            );
        });
    }

    function showTextBadge(x, y, text) {
        showBadge(x, y, 'text:' + text, (el) => {
            el.textContent = text;
        });
    }

    function hideBadge() {
        if (badge) {
            badge.style.display = 'none';
        }
    }

    function isEditable(el) {
        return !!(
            el &&
            el.closest &&
            el.closest(
                'input, textarea, [contenteditable=""], [contenteditable="true"]',
            )
        );
    }

    // ==========================================
    // DRAG START
    // ==========================================

    $(document).on('dragstart', function (e) {
        if (e.altKey) {
            isAltPressed = true;
            return;
        }

        const selection = window.getSelection();

        if (selection.rangeCount > 0 && selection.toString().trim() !== '') {
            selectedText = selection.toString();

            // Measure direction from where the mouse grabbed the text,
            // not from the center of the selection box
            startX = e.originalEvent.clientX + window.scrollX;
            startY = e.originalEvent.clientY + window.scrollY;

            e.originalEvent.dataTransfer.setData('text/plain', selectedText);

            isDragging = true;
            currentCorner = null;

            // Hide normal drag preview
            const img = new Image();

            img.src =
                'data:image/gif;base64,' +
                'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

            e.originalEvent.dataTransfer.setDragImage(img, 0, 0);
        }
    });

    // ==========================================
    // DETERMINE WHICH CORNER WE ARE DRAGGING TO
    // ==========================================

    $(document).on('dragover', function (e) {
        if (!isDragging) {
            return;
        }

        const oe = e.originalEvent;
        const x = oe.clientX;
        const y = oe.clientY;

        isAltPressed = oe.altKey;

        // Dropping into a text box = normal text drop, don't open anything
        isOverEditable = isEditable(oe.target);

        if (isAltPressed || isOverEditable) {
            currentCorner = null;
            hideBadge();
            return;
        }

        e.preventDefault();

        // Don't open if dragged to browser tab area
        isNearTabArea = y <= 5;

        const dx = x + window.scrollX - startX;
        const dy = y + window.scrollY - startY;

        if (Math.hypot(dx, dy) < DEAD_ZONE) {
            currentCorner = null;
            showTextBadge(x, y, '✖ Move further');
            return;
        }

        if (dy < 0) {
            currentCorner = dx < 0 ? 'topLeft' : 'topRight';
        } else {
            currentCorner = dx < 0 ? 'bottomLeft' : 'bottomRight';
        }

        showSiteBadge(x, y, currentCorner);
    });

    // Stop the browser from doing its own thing with the dropped text
    $(document).on('drop', function (e) {
        if (isDragging && !isOverEditable && !isAltPressed) {
            e.preventDefault();
        }
    });

    // ==========================================
    // ESCAPE = CANCEL
    // ==========================================

    $(document).on('keydown', function (event) {
        if (event.key === 'Escape' || event.keyCode === 27) {
            currentCorner = null;
            hideBadge();

            console.log('Drag cancelled');
        }
    });

    // ==========================================
    // DRAG END
    // ==========================================

    $(document).on('dragend', function (event) {
        const dropEffect = event.originalEvent.dataTransfer.dropEffect;

        hideBadge();

        const corner = currentCorner ? corners[currentCorner] : null;
        const text = selectedText;

        const cancelled =
            !isDragging ||
            dropEffect === 'none' ||
            isAltPressed ||
            isNearTabArea ||
            isOverEditable;

        // Reset
        isDragging = false;
        currentCorner = null;
        selectedText = null;
        isAltPressed = false;
        isNearTabArea = false;
        isOverEditable = false;

        if (cancelled || !corner || !text) {
            return;
        }

        // ==========================================
        // OPEN SELECTED URL
        // ==========================================

        const finalUrl = corner.url.replace(
            '%s',
            encodeURIComponent(text.trim()),
        );

        console.log(`Opening: ${finalUrl}`);

        GM_openInTab(finalUrl, true);
    });
})(jQuery);
